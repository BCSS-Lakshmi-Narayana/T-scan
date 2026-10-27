"""
service.py — one question in, one validated QueryPlan out.

    normalize -> deterministic extraction -> (LLM only if needed)
              -> merge -> assemble -> validate

The LLM is the exception, not the step. It is called when the rules left
something material unsettled — an unclassifiable intent, a subject with no
filter and no known concept, an aggregation with nothing to group by — and
skipped otherwise, which is most officer traffic and costs zero tokens.

Nothing here executes anything. There is no retrieval, no database read, no
answer. The plan is the output.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from typing import Callable, Optional

from . import deterministic, llm as llm_planner, merge as merge_mod, tools
from .models import (Ambiguity, Concept, ConceptStatus, Confidence,
                     FilterField, Intent, Need, PlanMetadata, QueryPlan, Shape,
                     SubQuestion, TimeKind, ValidationResult)
from .normalize import is_nonsense, normalize
from .validator import validate

logger = logging.getLogger("query_understanding")

# Default OFF. The production assistant keeps its existing path until this is
# deliberately switched on.
FEATURE_FLAG = "AI_ASSISTANT_ARCHITECTURE_V2"


def v2_enabled() -> bool:
    return os.getenv(FEATURE_FLAG, "false").strip().lower() in ("1", "true", "yes", "on")


#: Filter fields that say what a question is ABOUT. Mirrors the conversation
#: layer's SUBJECT_FIELDS: a question naming its own kind or topic is
#: self-describing, whatever else it leaves out.
_SUBJECT_FILTERS = (FilterField.TOPIC, FilterField.TARGET,
                    FilterField.KIND, FilterField.CATEGORY)


def _needs_llm(rule: dict) -> tuple:
    """(should_call, why). Rules that already read the question win."""
    if rule["intent"] is Intent.CONVERSATIONAL:
        return False, "conversational"
    if rule["intent_confidence"] < 0.8:
        return True, "low intent confidence"
    if rule["intent"] is Intent.AGGREGATION and not rule["group_by"]:
        # A plain count whose subject is known is already fully understood:
        # "how many grievances are there" needs no interpreting, and it is the
        # commonest question there is. Only an aggregation naming neither a
        # grouping nor a subject is genuinely ambiguous.
        if not any(f.field in _SUBJECT_FILTERS for f in rule["filters"]):
            return True, "aggregation with neither a grouping nor a subject"
    if not rule["filters"] and not rule["concepts"]:
        return True, "no filters and no concept"
    # The SUBJECT is what retrieval needs. A sentiment or platform filter says
    # nothing about what a post is ABOUT, so an unresolved subject still goes
    # to the model even when other filters were found: "angry posts about the
    # checkpost queue" has a sentiment and no idea what it concerns.
    subject_known = any(f.field in _SUBJECT_FILTERS for f in rule["filters"])
    if not subject_known and any(c.status != ConceptStatus.KNOWN
                                 for c in rule["concepts"]):
        return True, "subject unresolved"
    return False, "rules sufficient"


def _rule_summary(rule: dict) -> str:
    bits = [f"intent={rule['intent'].value}"]
    if rule["filters"]:
        bits.append("filters=" + ", ".join(
            f"{f.field.value}={f.value}" for f in rule["filters"][:6]))
    if rule["time_range"].kind is not TimeKind.ALL_TIME:
        bits.append(f"time={rule['time_range'].kind.value}")
    if rule["location"]:
        bits.append(f"location={rule['location'].text}")
    if rule["concepts"]:
        bits.append("concepts=" + ", ".join(c.text for c in rule["concepts"][:4]))
    return "; ".join(bits) or "nothing established"


def _sub_questions(parts: list, generate: Optional[Callable] = None) -> list:
    """One plan per genuinely separate request in the question.

    Each part goes through the SAME gate the whole question does. A part is a
    fragment — "where are they concentrated" — and reading it with rules alone
    hit exactly the frame-as-subject problem the semantic layer exists to fix:
    both second halves came back as unknown_concept, so the officer's second
    question was planned as a search for the words they used to ask it.

    The gate keeps this bounded: a part whose rules are already confident
    costs nothing, and there are never more than MAX_PARTS parts.
    """
    out = []
    for i, text in enumerate(parts[:deterministic.MAX_PARTS]):
        part_rule = deterministic.extract(text, text)
        should_call, _ = _needs_llm(part_rule)
        if should_call and generate:
            llm_fields, _ = llm_planner.plan(text, _rule_summary(part_rule), generate)
            if llm_fields:
                part_rule = merge_mod.merge(part_rule, llm_fields)
        needs = deterministic._needs_for(part_rule["intent"], {})
        out.append(SubQuestion(
            index=i, text=text, intent=part_rule["intent"], shape=part_rule["shape"],
            needs=needs, required_tools=tools.tools_for(needs),
            filters=part_rule["filters"], metric=part_rule["metric"],
            group_by=part_rule["group_by"]))
    return out


def understand(query: str, *, generate: Optional[Callable] = None,
               request_id: Optional[str] = None,
               allow_llm: bool = True) -> tuple:
    """Return (QueryPlan, ValidationResult). Never raises on bad input.

    ``generate`` is injected — a callable (prompt, max_tokens, temperature) ->
    str — so this module needs no knowledge of the LLM endpoint and stays
    testable without one.
    """
    started = time.perf_counter()
    raw = query or ""
    normalized = normalize(raw)
    request_id = request_id or uuid.uuid4().hex[:12]

    # -- nonsense: plan nothing, invent nothing ---------------------------- #
    if is_nonsense(normalized):
        plan = QueryPlan(
            raw_query=raw, normalized_query=normalized,
            intent=Intent.LOOKUP, shape=Shape.SIMPLE_LOOKUP,
            needs=[Need.NONE], required_tools=[],
            confidence=Confidence(overall=0.0, fields={}),
            degraded=True,
            degraded_reason="the input carries no interpretable content",
            coverage=0.0,
            ambiguities=[Ambiguity(field="query", reason="unintelligible input",
                                   confidence=0.0)],
            metadata=PlanMetadata(request_id=request_id,
                                  total_ms=round((time.perf_counter() - started) * 1000, 2)))
        return plan, validate(plan)

    # -- deterministic ------------------------------------------------------ #
    det_started = time.perf_counter()
    rule = deterministic.extract(raw, normalized)
    det_ms = round((time.perf_counter() - det_started) * 1000, 2)

    # -- model, only where rules fell short --------------------------------- #
    should_call, why = _needs_llm(rule)
    telemetry = {"llm_used": False, "llm_ms": 0.0, "attempts": 0,
                 "prompt_version": None, "error": None, "dropped": []}
    llm_fields: dict = {}
    if should_call and allow_llm and generate:
        llm_fields, telemetry = llm_planner.plan(normalized, _rule_summary(rule), generate)

    merged = merge_mod.merge(rule, llm_fields) if llm_fields else {
        **rule, "conflicts": []}

    # -- assemble ------------------------------------------------------------ #
    unresolved_location = bool(merged["location"] and not merged["location"].resolved)
    unresolved_concept = any(c.status != ConceptStatus.KNOWN for c in merged["concepts"])
    needs = deterministic._needs_for(merged["intent"], {
        "unresolved_location": unresolved_location,
        "unresolved_concept": unresolved_concept,
    })
    # Each part has its own gate, so it gets the model whenever one is
    # available: a question whose WHOLE reading was confident can still
    # have a fragment that is not.
    sub_questions = (_sub_questions(merged["parts"], generate if allow_llm else None)
                     if merged["intent"] is Intent.MULTI_PART else [])
    if sub_questions:
        # The parts decide what a multi-part question needs; the whole is the
        # union, in first-appearance order, so the orchestrator sees every
        # capability the question actually requires.
        for sub in sub_questions:
            for need in sub.needs:
                if need not in needs and need is not Need.NONE:
                    needs.append(need)

    degraded = bool(should_call and not llm_fields and telemetry.get("error"))
    coverage = 1.0
    if degraded:
        coverage = 0.6
    elif unresolved_concept or unresolved_location:
        coverage = 0.85

    field_conf = merge_mod.field_confidences(merged)
    overall = round(sum(field_conf.values()) / max(len(field_conf), 1), 3)
    if degraded:
        overall = min(overall, 0.5)

    plan = QueryPlan(
        raw_query=raw,
        normalized_query=normalized,
        intent=merged["intent"],
        shape=merged["shape"],
        filters=merged["filters"],
        location=merged["location"],
        time_range=merged["time_range"],
        concepts=merged["concepts"],
        entities=merged["entities"],
        group_by=merged["group_by"],
        metric=merged["metric"],
        limit=merged.get("limit"),
        sort=merged.get("sort"),
        sub_questions=sub_questions,
        needs=needs,
        required_tools=tools.tools_for(needs),
        confidence=Confidence(overall=overall, fields=field_conf),
        ambiguities=merged["ambiguities"],
        conflicts=merged["conflicts"],
        referents=merged["referents"],
        degraded=degraded,
        degraded_reason=("the planner model was unreachable or unparseable; "
                         "only rule-based understanding was applied") if degraded else None,
        coverage=coverage,
        metadata=PlanMetadata(
            understanding_mode="hybrid" if telemetry.get("llm_used") else "deterministic",
            semantic_confidence=llm_fields.get("confidence"),
            operation=llm_fields.get("operation"),
            analysis_depth=llm_fields.get("depth"),
            request_id=request_id,
            deterministic_ms=det_ms,
            llm_ms=telemetry.get("llm_ms", 0.0),
            total_ms=round((time.perf_counter() - started) * 1000, 2),
            llm_used=telemetry.get("llm_used", False),
            llm_attempts=telemetry.get("attempts", 0),
            prompt_version=telemetry.get("prompt_version"),
        ),
    )

    result = validate(plan)
    logger.info(
        "query-plan %s intent=%s shape=%s needs=%d tools=%d llm=%s(%sms) "
        "det=%sms total=%sms valid=%s ambiguities=%d conflicts=%d dropped=%s why=%r",
        request_id, plan.intent.value, plan.shape.value, len(plan.needs),
        len(plan.required_tools), plan.metadata.llm_used, plan.metadata.llm_ms,
        det_ms, plan.metadata.total_ms, result.valid, len(plan.ambiguities),
        len(plan.conflicts), len(telemetry.get("dropped", [])), why,
    )
    return plan, result
