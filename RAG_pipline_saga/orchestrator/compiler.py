"""
compiler.py — (resolved QueryPlan, PolicyResult) -> ExecutionPlan.

Deterministic. The same plan, policy result and `now` always compile to the
same steps. Tool choice comes from intent + the capabilities the Policy Gate
ALLOWED — never from the plan's `required_tools` list, which may have been
shaped by a model. A capability the gate did not allow cannot appear here,
even if the intent would like it; the step is left out and the omission is
stated as a limitation.

Scope: the plan's resolved place can only NARROW the effective districts
(effective ∩ place). If a restricted caller's scope and the place do not
meet, compilation refuses — the answer is never quietly about somewhere else.
"""

from __future__ import annotations

import os

import uuid
from datetime import datetime
from typing import List, Optional, Tuple

import concepts as concept_mod
from enrichment import location as loc
from policy.models import Capability, PolicyDecision, PolicyResult, ReasonCode
from query_understanding.models import (ConceptStatus, FilterField, Intent,
                                        LocationType, QueryPlan, SubQuestion,
                                        TimeKind, TimeRange)

from . import timeutil
from .models import (AggregateArgs, ClassifyArgs, CompareArgs, CompareSide,
                     ConceptArgs, ExecutionMode, ExecutionPlan, ExecutionStep,
                     LocationArgs, LookupArgs, RelatedArgs, SearchArgs,
                     SituationArgs, SpecArgs, TrendArgs)

C = Capability

# How many records the situation path reads in order to tell distinct issues
# apart. It is an ANALYSIS budget, not a display one: respond() still shows a
# bounded list, and aggregate/trend keep counting the whole population in the
# database. Raising it makes the assistant see more; it does not make it print
# more.
SITUATION_EVIDENCE = 60


class CompileRefusal(Exception):
    """Compilation found a reason the request must not run."""

    def __init__(self, code: ReasonCode, detail: str):
        super().__init__(detail)
        self.code, self.detail = code, detail


def spec_from_plan(plan: QueryPlan, now: datetime, filters=None,
                   text: Optional[str] = None) -> SpecArgs:
    f = {}
    for flt in (plan.filters if filters is None else filters):
        vals = flt.value if isinstance(flt.value, list) else [flt.value]
        f.setdefault(flt.field, []).extend(str(v) for v in vals if v is not None)
    since, until = timeutil.resolve(plan.time_range, now)
    concept_text = " ".join(c.text for c in plan.concepts)
    min_score = None
    if f.get(FilterField.RISK_SCORE):
        try:
            min_score = int(float(f[FilterField.RISK_SCORE][0]))
        except ValueError:
            min_score = None
    return SpecArgs(
        text=(text if text is not None else (concept_text or plan.normalized_query))[:500],
        kinds=f.get(FilterField.KIND, []),
        sentiment=(f.get(FilterField.SENTIMENT) or [None])[0],
        risk_levels=f.get(FilterField.RISK_LEVEL, []),
        min_risk_score=min_score,
        categories=f.get(FilterField.CATEGORY, []),
        stance=(f.get(FilterField.STANCE) or [None])[0],
        topics=f.get(FilterField.TOPIC, []),
        targets=f.get(FilterField.TARGET, []),
        handles=f.get(FilterField.HANDLE, []),
        tagged=f.get(FilterField.TAGGED, []),
        platforms=f.get(FilterField.PLATFORM, []),
        since=timeutil.iso(since), until=timeutil.iso(until),
        limit=min(max(plan.limit or 15, 1), 100),
        sort={"risk": "risk", "recent": "recent"}.get(plan.sort or "", "relevance"),
    )


def execution_districts(plan: QueryPlan, effective: Optional[List[str]]):
    """Districts execution may read: effective scope, narrowed by the place
    and district filters the question named. (districts, notes).

    A comparison is the exception: its SIDES carry their own places, each
    intersected with scope when counted, so narrowing the whole plan to the
    first place named would make the other side unreachable."""
    notes: List[str] = []
    out = None if effective is None else list(effective)
    if plan.intent is Intent.COMPARISON and len(plan.sub_questions) >= 2:
        return out, notes, None
    place = None

    def narrow(place_districts: List[str], label: str):
        nonlocal out, place
        within = loc.intersect(place_districts, out)
        if out is not None and not within:
            raise CompileRefusal(ReasonCode.DISTRICT_OUTSIDE_SCOPE,
                                 f"'{label}' is outside the districts assigned to you")
        if out is not None and len(within) < len(place_districts):
            notes.append(f"'{label}' extends beyond your assigned districts; only "
                         f"{', '.join(within)} is included.")
        out = within
        place = list(within)

    lc = plan.location
    if lc is not None and lc.resolved and lc.hierarchy and \
            lc.type not in (LocationType.STATE, LocationType.COUNTRY):
        narrow(list(lc.hierarchy), lc.text)
    elif lc is not None and not lc.resolved:
        notes.append(f"'{lc.text}' could not be matched to a known place; it is searched as "
                     f"text only.")
    named = [str(v) for flt in plan.filters if flt.field is FilterField.DISTRICT
             for v in (flt.value if isinstance(flt.value, list) else [flt.value])]
    if named:
        narrow(named, ", ".join(named))
    return out, notes, place


def _labels(plan: QueryPlan) -> List[str]:
    return concept_mod.group_labels(plan.raw_query) or \
        [c.text for c in plan.concepts][:4] or [plan.normalized_query[:80]]


_COMMAND_WORDS = {"deep", "scan", "scanning", "classify", "find", "search", "show", "list",
                  "all", "posts", "post", "content", "records", "for", "me", "the", "every", "any"}


def _clean_label(text: str) -> str:
    words = [w for w in text.split() if w.lower().strip(".,?!") not in _COMMAND_WORDS]
    return " ".join(words) or text


def _concept_label(plan: QueryPlan) -> str:
    unknown = [c.text for c in plan.concepts if c.status is not ConceptStatus.KNOWN]
    raw = (unknown or [c.text for c in plan.concepts] or
           [concept_mod.concept(plan.raw_query) or plan.normalized_query])[0]
    return _clean_label(raw)[:80]


class _Builder:
    def __init__(self, allowed: List[Capability], prefix: str = "", sub: Optional[int] = None,
                 blocked: Optional[List[Capability]] = None):
        self.allowed = set(allowed)
        self.blocked = set(blocked or [])
        self.steps: List[ExecutionStep] = []
        self.limitations: List[str] = []
        self.prefix, self.sub = prefix, sub

    def add(self, sid: str, tool: C, op: str, args, purpose: str, deps=(), essential=True,
            output="records") -> Optional[str]:
        if tool not in self.allowed:
            if essential:
                raise CompileRefusal(ReasonCode.CAPABILITY_NOT_ALLOWED,
                                     f"{tool.value} is required but was not allowed")
            # Supporting work the question never asked for is simply not done;
            # only a capability the gate BLOCKED is a limitation to report.
            if tool in self.blocked:
                self.limitations.append(f"{tool.value.replace('_', ' ')} was not available for "
                                        f"this request.")
            return None
        step_id = f"{self.prefix}{sid}"
        deps = [d for d in deps if d]
        self.steps.append(ExecutionStep(step_id=step_id, tool=tool, operation=op, arguments=args,
                                        dependencies=list(deps), purpose=purpose,
                                        input_sources=list(deps), output_schema=output,
                                        essential=essential, sub_question=self.sub,
                                        provenance={"compiled_from": "intent"}))
        return step_id


#: Default period for "what is happening" when the question names none.
#: Only a default: a stated period wins, and the answer always says which
#: period it used.
SITUATION_WINDOW_DAYS = max(1, min(90, int(os.getenv("AI_SITUATION_WINDOW_DAYS", "7"))))


def _window_days(plan: QueryPlan, default: int) -> int:
    from policy.scope import window_days
    d = window_days(plan.time_range)
    return max(1, min(d or default, 366))


def _compile_one(plan: QueryPlan, b: _Builder, now: datetime, intent: Intent,
                 group_by: List[str], sub: Optional[SubQuestion] = None,
                 trend_default: int = 30) -> None:
    filters = sub.filters + [f for f in plan.filters if f.field not in {x.field for x in sub.filters}] \
        if sub else None
    spec = spec_from_plan(plan, now, filters=filters, text=(sub.text if sub else None))
    loc_step = None
    if plan.location is not None and not plan.location.resolved:
        loc_step = b.add("loc", C.LOCATION_RESOLVE, "resolve", LocationArgs(text=plan.location.text[:120]),
                         "Match the place named in the question", essential=False,
                         output="location")
    deps = [loc_step] if loc_step else []

    if intent is Intent.LOOKUP:
        b.add("lookup", C.LOOKUP_RECORDS, "structured", LookupArgs(spec=spec),
              "Fetch the exact records the filters select", deps)
    elif intent in (Intent.FILTERED_SEARCH, Intent.FOLLOW_UP):
        b.add("search", C.HYBRID_SEARCH, "hybrid", SearchArgs(spec=spec),
              "Find records matching the question", deps)
    elif intent is Intent.AGGREGATION:
        b.add("agg", C.AGGREGATE, "breakdown", AggregateArgs(spec=spec, group_by=group_by[:4]),
              "Count matching records" + (f" by {', '.join(group_by)}" if group_by else ""),
              deps, output="aggregate")
    elif intent is Intent.TREND_ANALYSIS:
        window = _window_days(plan, trend_default) if plan.time_range.kind is not TimeKind.ALL_TIME \
            else trend_default
        tspec = spec.model_copy(update={"since": None, "until": None})
        b.add("trend", C.TREND_ANALYSIS, "compare_windows", TrendArgs(spec=tspec, window_days=window),
              f"Compare the last {window} day(s) with the {window} before", deps, output="trend")
    elif intent is Intent.COMPARISON:
        sides = _comparison_sides(plan, now)
        if any(s.since for s in sides):
            spec = spec.model_copy(update={"since": None, "until": None})
        if len(sides) < 2:
            raise CompileRefusal(ReasonCode.PLAN_EMPTY,
                                 "what is being compared could not be determined")
        b.add("compare", C.COMPARE_RESULTS, "counts", CompareArgs(spec=spec, sides=sides),
              "Count each side of the comparison", deps, output="comparison")
        if plan.time_range.kind in (TimeKind.THIS_MONTH, TimeKind.THIS_WEEK):
            b.limitations.append("The current period is not over yet; it is compared as it "
                                 "stands against the whole previous period.")
    elif intent is Intent.CLASSIFICATION:
        s = b.add("search", C.HYBRID_SEARCH, "hybrid", SearchArgs(spec=spec),
                  "Records in scope, for context", deps, essential=False)
        b.add("classify", C.CLASSIFY_RECORDS, "judge",
              ClassifyArgs(spec=spec, labels=_labels(plan), question=plan.raw_query[:500]),
              "Label records in the window against the requested groups", deps,
              output="verdicts")
    elif intent is Intent.UNKNOWN_CONCEPT:
        b.add("concept", C.UNKNOWN_CONCEPT_SEARCH, "scan",
              ConceptArgs(spec=spec, label=_concept_label(plan), question=plan.raw_query[:500]),
              "Find records expressing a concept nothing is tagged with", deps, output="verdicts")
        b.add("search", C.HYBRID_SEARCH, "hybrid", SearchArgs(spec=spec),
              "Closest records by search, shown if the judge is unavailable", deps,
              essential=False)
    elif intent is Intent.DEEP_SCAN:
        b.add("deep", C.DEEP_SCAN, "scan_deep",
              ClassifyArgs(spec=spec, labels=[_concept_label(plan)], question=plan.raw_query[:500],
                           deep=True),
              "Judge every record in the bounded window", deps, output="verdicts")
    elif intent is Intent.SITUATION_ANALYSIS:
        # When the officer named no period, the window is OURS, not theirs, and
        # 7 days is only the right default while ingestion is current. On a
        # corpus whose newest record was four weeks old, every "what is
        # happening" question answered "0 matching records in the last 7 days" —
        # true, and indistinguishable from a broken assistant. Deployments whose
        # feed lags set AI_SITUATION_WINDOW_DAYS to cover it; a period the
        # officer DID state is always honoured exactly.
        window = (_window_days(plan, SITUATION_WINDOW_DAYS)
                  if plan.time_range.kind is not TimeKind.ALL_TIME
                  else SITUATION_WINDOW_DAYS)
        if plan.time_range.kind is TimeKind.ALL_TIME:
            # A situation is "what is happening NOW": its volume and breakdowns
            # are counted over the same window the trend compares, never over
            # all time while the answer says "in the last 7 days".
            from datetime import timedelta
            spec = spec.model_copy(update={"since": timeutil.iso(now - timedelta(days=window)),
                                           "until": timeutil.iso(now)})
        # Three different budgets, deliberately not one number:
        #   population - what matched, counted in the database by aggregate and
        #                trend; unchanged, and never a function of this limit.
        #   analysis   - what the situation and related-content steps actually
        #                read. Distinct issues cannot be told apart from the
        #                fifteen nearest records, so these steps get a wider set.
        #   display    - what the officer is shown, still bounded by respond().
        spec = spec.model_copy(update={"limit": SITUATION_EVIDENCE})
        s1 = b.add("search", C.HYBRID_SEARCH, "hybrid", SearchArgs(spec=spec),
                   "Records about the subject", deps)
        s2 = b.add("agg", C.AGGREGATE, "breakdown",
                   AggregateArgs(spec=spec, group_by=["districts", "handle", "risk_level", "topics"]),
                   "Where, who and how risky", deps, essential=False, output="aggregate")
        tspec = spec.model_copy(update={"since": None, "until": None})
        s3 = b.add("trend", C.TREND_ANALYSIS, "compare_windows",
                   TrendArgs(spec=tspec, window_days=window), "What changed recently", deps,
                   essential=False, output="trend")
        s4 = b.add("related", C.RELATED_CONTENT_SEARCH, "related",
                   RelatedArgs(spec=spec, top_k=10),
                   "Records connected to the matches", [s1], essential=False)
        b.add("situation", C.SITUATION_ANALYSIS, "compose",
              SituationArgs(spec=spec, subject=(plan.location.text + ": " if plan.location else "")
                            + (" ".join(c.text for c in plan.concepts) or plan.normalized_query)[:150],
                            window_days=window),
              "Assemble the situation from the results above", [x for x in (s1, s2, s3, s4) if x],
              essential=False, output="situation")
    else:
        raise CompileRefusal(ReasonCode.PLAN_EMPTY, f"nothing to execute for {intent.value}")


def _comparison_sides(plan: QueryPlan, now: datetime) -> List[CompareSide]:
    sides: List[CompareSide] = []
    for sub in plan.sub_questions:
        ds = [str(v) for f in sub.filters if f.field is FilterField.DISTRICT
              for v in (f.value if isinstance(f.value, list) else [f.value])]
        if ds:
            sides.append(CompareSide(label=sub.text[:80], districts=ds))
    if len(sides) >= 2:
        return sides
    # Period over period. "this month with last month" is the calendar month
    # before, not "the same number of days earlier"; other windows compare
    # with the equal span immediately before them.
    since, until = timeutil.resolve(plan.time_range, now)
    if since and until:
        prev_kind = {TimeKind.THIS_MONTH: TimeKind.LAST_MONTH,
                     TimeKind.THIS_WEEK: TimeKind.LAST_WEEK}.get(plan.time_range.kind)
        names = {TimeKind.THIS_MONTH: ("this month", "last month"),
                 TimeKind.THIS_WEEK: ("this week", "last week")}
        if prev_kind:
            ps, pu = timeutil.resolve(TimeRange(kind=prev_kind), now)
            a, b = names[plan.time_range.kind]
        else:
            span = until - since
            ps, pu, a, b = since - span, since, "this period", "previous period"
        # Each side carries its own scope, so a place named once applies to
        # both: "compare this week with last week FOR HYDERABAD" is two
        # Hyderabad counts, not two counts over every district.
        lc = plan.location
        where = (list(lc.hierarchy) if lc is not None and lc.resolved and lc.hierarchy
                 and lc.type not in (LocationType.STATE, LocationType.COUNTRY) else None)
        return [CompareSide(label=a, districts=where,
                            since=timeutil.iso(since), until=timeutil.iso(until)),
                CompareSide(label=b, districts=where,
                            since=timeutil.iso(ps), until=timeutil.iso(pu))]
    return sides


def compile_plan(plan: QueryPlan, policy: PolicyResult, *, now: datetime,
                 request_id: Optional[str] = None) -> ExecutionPlan:
    request_id = request_id or uuid.uuid4().hex[:12]
    base = dict(request_id=request_id, effective_districts=policy.effective_districts,
                allowed_capabilities=list(policy.allowed_capabilities),
                constraints=(policy.constraints.model_dump(mode="json") if policy.constraints else {}))
    if policy.decision not in (PolicyDecision.ALLOWED, PolicyDecision.DEGRADED) \
            or plan.intent is Intent.CONVERSATIONAL:
        return ExecutionPlan(mode=ExecutionMode.NONE, **base)

    exec_districts, notes, place = execution_districts(plan, policy.effective_districts)
    trend_default = (policy.constraints.trend_default_window_days
                     if policy.constraints and policy.constraints.trend_default_window_days else 30)
    steps, limitations = [], list(notes)
    if plan.intent is Intent.MULTI_PART:
        for sub in plan.sub_questions:
            b = _Builder(policy.allowed_capabilities, prefix=f"q{sub.index}.", sub=sub.index,
                         blocked=policy.blocked_capabilities)
            _compile_one(plan, b, now, sub.intent, list(sub.group_by), sub=sub,
                         trend_default=trend_default)
            steps += b.steps
            limitations += b.limitations
    else:
        b = _Builder(policy.allowed_capabilities, blocked=policy.blocked_capabilities)
        _compile_one(plan, b, now, plan.intent, list(plan.group_by), trend_default=trend_default)
        steps, limitations = b.steps, limitations + b.limitations

    degraded = policy.decision is PolicyDecision.DEGRADED or bool(limitations and
                                                                  any("not available" in l for l in limitations))
    return ExecutionPlan(
        mode=ExecutionMode.DEGRADED if degraded else ExecutionMode.DETERMINISTIC,
        steps=steps, execution_districts=exec_districts, place_districts=place,
        expected_outputs=sorted({s.output_schema for s in steps}),
        coverage=plan.coverage, degraded=degraded, limitations=limitations,
        metadata={"intent": plan.intent.value, "compiled_at": timeutil.iso(now),
                  "time_kind": plan.time_range.kind.value,
                  "window_aligned": plan.intent is Intent.SITUATION_ANALYSIS},
        **base)
