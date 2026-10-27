"""
merge.py — deterministic wins, disagreement is recorded, never resolved.

The model may fill gaps. It may not overwrite something a rule read out of the
user's own words: a regex that matched "youtube" read a fact, while a model
answering "twitter" produced an opinion, and silently preferring the opinion is
how a plan stops matching the question.

So the merge has exactly three outcomes per field:

    rule had it, model agrees      -> keep, raise confidence slightly
    rule had it, model differs     -> keep the rule, record a Conflict
    rule had nothing               -> take the model's value, mark source=LLM

Conflicts are not errors and are not resolved here. They travel on the plan so
the policy gate can decide whether the difference is worth a clarifying
question. Resolving them inside the merge would throw away the one signal that
says "this question was read two ways".
"""

from __future__ import annotations

from typing import Dict, List

from . import deterministic
from .validator import _COMPATIBLE
from .models import (Ambiguity, Concept, ConceptStatus, Conflict, Filter,
                     FilterField, Intent, Location, LocationType, Shape, Source)

# Which LLM field maps onto which filter field.
_FILTER_FIELDS = {
    "sentiment": FilterField.SENTIMENT,
    "topics": FilterField.TOPIC,
    "targets": FilterField.TARGET,
}


def merge(rule: dict, llm: dict) -> dict:
    """Combine the rule extraction with the model's, recording disagreement."""
    conflicts: List[Conflict] = []
    filters: List[Filter] = list(rule["filters"])
    have = {f.field for f in filters}

    # -- scalar filter: sentiment ----------------------------------------- #
    if "sentiment" in llm:
        existing = next((f for f in filters if f.field == FilterField.SENTIMENT), None)
        if existing is None:
            filters.append(Filter(field=FilterField.SENTIMENT, value=llm["sentiment"],
                                  source=Source.LLM, confidence=0.6))
        elif str(existing.value) != llm["sentiment"]:
            conflicts.append(Conflict(field="sentiment", deterministic=existing.value,
                                      llm=llm["sentiment"]))
        else:
            existing.confidence = min(1.0, existing.confidence + 0.03)

    # -- list filters: topics, targets ------------------------------------ #
    for key in ("topics", "targets"):
        if key not in llm:
            continue
        field = _FILTER_FIELDS[key]
        known = {str(f.value) for f in filters if f.field == field}
        if known:
            extra = [v for v in llm[key] if v not in known]
            if extra:
                # The rules found some; the model found others. Not a
                # contradiction — an addition, at lower confidence.
                for value in extra:
                    filters.append(Filter(field=field, value=value,
                                          source=Source.LLM, confidence=0.55))
        else:
            for value in llm[key]:
                filters.append(Filter(field=field, value=value,
                                      source=Source.LLM, confidence=0.6))

    # -- intent and shape -------------------------------------------------- #
    intent: Intent = rule["intent"]
    shape: Shape = rule["shape"]
    intent_conf = rule["intent_confidence"]
    if "intent" in llm:
        llm_intent = Intent(llm["intent"])
        if llm_intent != intent:
            # A rule intent backed by an explicit signal outranks the model.
            if intent_conf >= 0.8:
                conflicts.append(Conflict(field="intent", deterministic=intent.value,
                                          llm=llm_intent.value))
            else:
                # Accepting the model's intent means accepting everything that
                # follows from it. Keeping the rule's shape produced plans that
                # contradicted themselves — intent=aggregation with
                # shape=unknown_concept — which the validator rejected, so a
                # correctly understood question was refused. A shape the model
                # supplied is honoured only if it can actually execute the
                # intent that was just accepted.
                intent = llm_intent
                intent_conf = 0.6
                shape = deterministic._shape_for(intent, rule["location"] is not None)
                if "shape" in llm:
                    try:
                        offered = Shape(llm["shape"])
                        if offered in (_COMPATIBLE.get(intent) or {offered}):
                            shape = offered
                    except ValueError:
                        pass
        else:
            intent_conf = min(1.0, intent_conf + 0.05)

    if "shape" in llm and rule["intent_confidence"] < 0.8:
        try:
            shape = Shape(llm["shape"])
        except ValueError:
            pass

    # A shape that cannot execute the intent is a plan that contradicts itself,
    # and the validator rejects it — so a question the layers understood
    # correctly came back refused. Whatever the branches above decided, the
    # shape is forced to one the accepted intent can actually run.
    if shape not in (_COMPATIBLE.get(intent) or {shape}):
        shape = deterministic._shape_for(intent, rule["location"] is not None)

    # -- location ---------------------------------------------------------- #
    location: Location = rule["location"]
    if llm.get("location"):
        if location is None:
            location = Location(text=llm["location"], type=LocationType.UNKNOWN,
                                resolved=False, source=Source.LLM, confidence=0.5)
        elif location.text.lower() != str(llm["location"]).lower():
            conflicts.append(Conflict(field="location", deterministic=location.text,
                                      llm=llm["location"]))

    # -- concepts ---------------------------------------------------------- #
    concepts: List[Concept] = list(rule["concepts"])
    seen = {c.text.lower() for c in concepts}
    for text in llm.get("concepts", []):
        if text.lower() not in seen:
            seen.add(text.lower())
            concepts.append(Concept(text=text, normalized=text.lower(),
                                    status=ConceptStatus.CANDIDATE,
                                    source=Source.LLM, confidence=0.5))

    # -- aggregation details ------------------------------------------------ #
    group_by: List[str] = list(rule["group_by"])
    if llm.get("group_by") and llm["group_by"] not in group_by:
        if group_by:
            conflicts.append(Conflict(field="group_by", deterministic=group_by,
                                      llm=llm["group_by"]))
        else:
            group_by.append(llm["group_by"])

    metric = rule["metric"] or llm.get("metric")

    # An aggregation must have something to count. When the model's intent is
    # accepted for a question the rules read as something else, no metric came
    # with it — and the validator rejects an aggregation with neither a metric
    # nor a grouping, so the question was refused. "How many complaints are
    # there" IS a count: saying so is derivation from the accepted intent, not
    # invention.
    if intent is Intent.AGGREGATION and not metric and not group_by:
        metric = "count"

    # -- ambiguities -------------------------------------------------------- #
    ambiguities: List[Ambiguity] = list(rule["ambiguities"])
    for item in llm.get("ambiguities", []):
        ambiguities.append(Ambiguity(field=item["field"], reason=item["reason"],
                                     confidence=0.5))
    # Every conflict is also something the officer might need to be asked about.
    for conflict in conflicts:
        ambiguities.append(Ambiguity(
            field=conflict.field,
            reason=f"rules read {conflict.deterministic!r}, the model read "
                   f"{conflict.llm!r}; the rule value was kept",
            candidates=[str(conflict.deterministic), str(conflict.llm)],
            confidence=0.4))

    return {
        **rule,
        "intent": intent,
        "intent_confidence": intent_conf,
        "shape": shape,
        "filters": filters,
        "location": location,
        "concepts": concepts,
        "group_by": group_by,
        "metric": metric,
        "ambiguities": ambiguities,
        "conflicts": conflicts,
    }


def field_confidences(merged: dict) -> Dict[str, float]:
    out: Dict[str, float] = {"intent": merged["intent_confidence"]}
    if merged["filters"]:
        out["filters"] = round(
            sum(f.confidence for f in merged["filters"]) / len(merged["filters"]), 3)
    if merged["location"]:
        out["location"] = merged["location"].confidence
    if merged["concepts"]:
        out["concepts"] = round(
            sum(c.confidence for c in merged["concepts"]) / len(merged["concepts"]), 3)
    out["time_range"] = merged["time_range"].confidence
    return out
