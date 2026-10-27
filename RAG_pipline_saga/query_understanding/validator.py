"""
validator.py — nothing invalid reaches the orchestrator.

Pydantic already guarantees the plan's *shape*. This checks its *sense*: an
aggregation with nothing to count, a tool name nobody implements, a time range
that claims resolution it never did, a plan asserting authorisation. Those are
all structurally valid and operationally wrong.

Errors block execution. Warnings travel with the plan — a planned-but-missing
tool is a real limitation the orchestrator must see, not a reason to refuse a
question outright.
"""

from __future__ import annotations

from typing import List

from . import tools
from .models import (Intent, Need, QueryPlan, Shape, ValidationIssue,
                     ValidationResult)

# Intent/shape pairs that would send the orchestrator somewhere useless.
_COMPATIBLE: dict = {
    Intent.AGGREGATION: {Shape.ANALYTICAL, Shape.MULTI_PART, Shape.GROUND_LEVEL},
    Intent.TREND_ANALYSIS: {Shape.TREND, Shape.ANALYTICAL, Shape.MULTI_PART},
    Intent.COMPARISON: {Shape.COMPARISON, Shape.ANALYTICAL, Shape.MULTI_PART},
    Intent.SITUATION_ANALYSIS: {Shape.SITUATION, Shape.GROUND_LEVEL, Shape.MULTI_PART},
    Intent.UNKNOWN_CONCEPT: {Shape.UNKNOWN_CONCEPT, Shape.FILTERED, Shape.SITUATION},
    Intent.DEEP_SCAN: {Shape.DEEP_SCAN},
    Intent.CONVERSATIONAL: {Shape.CONVERSATIONAL},
    Intent.MULTI_PART: {Shape.MULTI_PART},
    Intent.FOLLOW_UP: {Shape.FOLLOW_UP, Shape.FILTERED, Shape.ANALYTICAL, Shape.TREND},
}


def validate(plan: QueryPlan) -> ValidationResult:
    issues: List[ValidationIssue] = []

    def error(field: str, message: str):
        issues.append(ValidationIssue(severity="error", field=field, message=message))

    def warn(field: str, message: str):
        issues.append(ValidationIssue(severity="warning", field=field, message=message))

    # -- the question itself ------------------------------------------------ #
    if not plan.raw_query.strip():
        error("raw_query", "a plan must carry the question it came from")

    # -- tools --------------------------------------------------------------- #
    unknown = tools.unknown_tools(plan.required_tools)
    if unknown:
        error("required_tools", f"not in the registry: {', '.join(unknown)}")
    for name in tools.planned_tools(plan.required_tools):
        warn("required_tools",
             f"'{name}' is registered but not implemented yet (status=planned); "
             f"the orchestrator must degrade rather than dispatch")

    # Needs and tools must agree, or the orchestrator is working from two
    # different plans.
    expected = set(tools.tools_for(plan.needs))
    named = set(plan.required_tools)
    for missing in sorted(expected - named):
        warn("required_tools", f"need present but tool '{missing}' not requested")
    for extra in sorted(named - expected):
        warn("required_tools", f"tool '{extra}' requested by no declared need")

    # -- intent / shape ------------------------------------------------------ #
    allowed = _COMPATIBLE.get(plan.intent)
    if allowed and plan.shape not in allowed:
        error("shape", f"shape '{plan.shape.value}' cannot execute intent "
                       f"'{plan.intent.value}'")

    # -- aggregation needs something to count -------------------------------- #
    if plan.intent is Intent.AGGREGATION and not plan.metric and not plan.group_by:
        error("metric", "aggregation requires a metric or a group_by")

    if plan.intent is Intent.COMPARISON and len(plan.sub_questions) < 2 \
            and not plan.group_by:
        warn("sub_questions",
             "comparison with neither sub-questions nor a group_by: what is being "
             "compared is not expressed in the plan")

    if plan.intent is Intent.MULTI_PART and len(plan.sub_questions) < 2:
        error("sub_questions", "multi_part requires at least two sub-questions")

    # -- time ---------------------------------------------------------------- #
    tr = plan.time_range
    if tr.resolved and not (tr.start or tr.end):
        error("time_range", "marked resolved but carries no timestamps")
    if tr.start and tr.end and tr.start > tr.end:
        error("time_range", "start is after end")

    # -- location ------------------------------------------------------------ #
    if plan.location:
        if plan.location.resolved and not plan.location.resolved_id:
            error("location", "marked resolved but has no resolved_id")
        if not plan.location.resolved and Need.LOCATION_RESOLUTION not in plan.needs:
            warn("location",
                 "an unresolved location is present but no location_resolution need "
                 "was declared; it will be treated as free text")

    # -- concepts ------------------------------------------------------------ #
    if plan.unresolved_concepts() and Need.CONCEPT_RESOLUTION not in plan.needs \
            and plan.intent not in (Intent.CONVERSATIONAL, Intent.AGGREGATION):
        warn("concepts",
             "unresolved concepts present without a concept_resolution need")

    # -- security ------------------------------------------------------------ #
    # A plan never carries authorisation. The model cannot put it there (the
    # schema forbids extra fields), and this asserts the invariant anyway.
    if plan.metadata.tenant_scope_required is not True:
        error("metadata", "a plan may never assert that tenant scoping is optional")

    # -- degraded ------------------------------------------------------------ #
    if plan.degraded and not plan.degraded_reason:
        warn("degraded_reason", "degraded plans should say why")

    # -- sub-questions -------------------------------------------------------- #
    for sub in plan.sub_questions:
        bad = tools.unknown_tools(sub.required_tools)
        if bad:
            error(f"sub_questions[{sub.index}]",
                  f"unknown tools: {', '.join(bad)}")
        if not sub.text.strip():
            error(f"sub_questions[{sub.index}]", "empty sub-question text")

    return ValidationResult(valid=not any(i.severity == "error" for i in issues),
                            issues=issues)
