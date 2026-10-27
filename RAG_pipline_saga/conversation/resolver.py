"""
resolver.py — current plan + conversation state -> ResolvedQuery.

    resolve_query(plan, state, ctx) -> ResolvedQuery

Deterministic: no model, no clock, no I/O. The same plan and state always
resolve the same way.

Precedence, highest first, per field:

    1. EXPLICIT    what the user typed in this turn
    2. REFERENT    what a back-reference in this turn points at
    3. INHERITED   the active context of the last contributing turn

Only follow-ups inherit. A self-contained question ("Show all alerts", "Show
Warangal alerts") starts clean, so a filter from three turns ago can never
leak into a question that did not ask for it.

Recency: a referent resolves against the NEWEST earlier turn holding a value
of its TYPE. A turn with one such value resolves it; a turn with several
makes it ambiguous, and older turns are not consulted, because skipping past
an ambiguity to an older unambiguous value is guessing with extra steps.

This layer never decides access. It may resolve "there" to Hyderabad for an
officer who can no longer see Hyderabad; the Policy Gate, run afterwards
against the caller as they are now, is what refuses it.
"""

from __future__ import annotations

from typing import List, Optional, Tuple

from query_understanding import deterministic as qu_det
from query_understanding import tools as qu_tools
from query_understanding.models import (Ambiguity, Concept, ConceptStatus, Filter,
                                        FilterField, Intent, Location, LocationType, Need,
                                        QueryPlan, Referent, Shape, Source,
                                        SubQuestion, TimeKind)

from . import cues as cues_mod
from .config import ConversationConfig
from .models import (ContextUse, ConversationState, ConversationTurn,
                     ReferentType, ResolutionMetadata, ResolutionStatus,
                     ResolvedQuery, TurnContext, TypedReferent,
                     UnresolvedReferent, Via, ref)


class ConversationAccessError(PermissionError):
    """The state handed to the resolver does not belong to this caller."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


# Intents a follow-up may carry forward. Deep scans and comparisons are not
# re-run implicitly: "what about yesterday?" after a deep scan asks about
# yesterday, it does not order another exhaustive LLM pass.
_INHERITABLE_INTENTS = {Intent.LOOKUP, Intent.FILTERED_SEARCH, Intent.AGGREGATION,
                        Intent.TREND_ANALYSIS, Intent.UNKNOWN_CONCEPT,
                        Intent.SITUATION_ANALYSIS, Intent.CLASSIFICATION}
_WEAK_INTENTS = {Intent.FOLLOW_UP, Intent.FILTERED_SEARCH, Intent.UNKNOWN_CONCEPT, Intent.LOOKUP}
_ANALYTIC = {Intent.AGGREGATION, Intent.TREND_ANALYSIS, Intent.COMPARISON}


# --------------------------------------------------------------------------- #
# context extraction — what a turn gives later turns to build on
# --------------------------------------------------------------------------- #

def extract_context(plan: QueryPlan, config: ConversationConfig,
                    locations: Optional[List[Location]] = None) -> Optional[TurnContext]:
    """The structured subject of a resolved plan, or None if it offers
    nothing to build on (a greeting, an unintelligible input)."""
    if plan.intent is Intent.CONVERSATIONAL or plan.coverage == 0.0:
        return None
    n = config.max_context_items
    locs = locations if locations is not None else cues_mod.places_named(plan)
    return TurnContext(
        intent=plan.intent, shape=plan.shape,
        locations=locs[:n],
        location_ambiguities=[a for a in plan.ambiguities if a.field == "location"][:n],
        time_range=plan.time_range,
        filters=plan.filters[:n],
        concepts=cues_mod.clean_concepts(plan.concepts)[:n],
        entities=plan.entities[:n],
        group_by=plan.group_by[:n],
        metric=plan.metric,
    )


def _contributing(state: Optional[ConversationState]) -> List[ConversationTurn]:
    """Earlier turns with context, newest first."""
    if state is None:
        return []
    return [t for t in reversed(state.recent_turns) if t.context is not None]


def _find(turns: List[ConversationTurn], kind: ReferentType):
    """(turn, values) for the newest turn holding `kind`, else (None, [])."""
    for turn in turns:
        c = turn.context
        if kind is ReferentType.LOCATION and c.locations:
            return turn, list(c.locations)
        if kind is ReferentType.CONCEPT and (c.concepts or _subject_filters(c.filters)):
            return turn, list(c.concepts) or _subject_filters(c.filters)
        if kind is ReferentType.TIME_RANGE and c.time_range.kind is not TimeKind.ALL_TIME:
            return turn, [c.time_range]
        if kind in (ReferentType.RESULT_SET, ReferentType.PREVIOUS_QUERY,
                    ReferentType.COMPARISON_SUBJECT):
            return turn, [c]
    return None, []


def _subject_filters(filters: List[Filter]) -> List[Filter]:
    return [f for f in filters if f.field in cues_mod.SUBJECT_FIELDS]


def _label(value) -> str:
    if isinstance(value, Location):
        return value.text
    if isinstance(value, TurnContext):
        return "previous query"
    for attr in ("text", "value"):
        if hasattr(value, attr) and getattr(value, attr) is not None:
            return str(getattr(value, attr))
    if hasattr(value, "kind"):
        return value.kind.value
    return str(value)


def _dump(value):
    return value.model_dump(mode="json") if hasattr(value, "model_dump") else value


def _confidence(state: ConversationState, turn: ConversationTurn) -> float:
    # One step back is near-certain; every further turn costs a little.
    distance = max(0, state.turn_count - turn.sequence)
    return round(max(0.5, 0.9 - 0.1 * distance), 2)


# --------------------------------------------------------------------------- #
# resolution
# --------------------------------------------------------------------------- #

def _rebuilt(plan: QueryPlan) -> QueryPlan:
    """model_copy(update=...) skips validation; every plan this layer emits is
    re-validated as a fresh object, so a bad merge fails here, loudly, rather
    than reaching the Policy Gate as a plausible plan."""
    return QueryPlan.model_validate(plan.model_dump())


def _clarification_plan(plan: QueryPlan, unresolved: List[UnresolvedReferent],
                        ambiguities: List[Ambiguity]) -> QueryPlan:
    """An unresolved follow-up, shaped so the Policy Gate refuses to run it
    (follow_up + unresolved referents -> CONTEXT_REQUIRED) even if a caller
    ignored this layer's status. The planner's own plan is left untouched."""
    needs = qu_det._needs_for(Intent.FOLLOW_UP, {})
    referents = list(plan.referents)
    have = {r.token.lower() for r in referents}
    for u in unresolved:
        if u.token.lower() not in have:
            referents.append(Referent(token=u.token, kind=u.target_type.value, resolved=False))
    return _rebuilt(plan.model_copy(deep=True, update={
        "intent": Intent.FOLLOW_UP, "shape": Shape.FOLLOW_UP,
        "needs": needs, "required_tools": qu_tools.tools_for(needs),
        "referents": referents, "sub_questions": [],
        "ambiguities": list(plan.ambiguities) + ambiguities,
    }))


def resolve_query(plan: QueryPlan, state: Optional[ConversationState], ctx=None, *,
                  config: Optional[ConversationConfig] = None) -> ResolvedQuery:
    """Resolve ``plan`` against ``state``. ``ctx`` (a policy RequestContext or
    anything with tenant_id / user_id) is used for ONE thing: confirming the
    state belongs to this caller. It never informs what the plan may do."""
    config = config or ConversationConfig()
    if state is not None and ctx is not None:
        if (state.tenant_id or "") != (getattr(ctx, "tenant_id", None) or ""):
            raise ConversationAccessError("TENANT_MISMATCH")
        if (state.user_id or "") != (getattr(ctx, "user_id", None) or ""):
            raise ConversationAccessError("USER_MISMATCH")

    cues = cues_mod.detect(plan)
    meta = ResolutionMetadata(
        conversation_ref=ref(state.conversation_id) if state else None,
        turn_sequence=(state.turn_count + 1) if state else 1,
        follow_up=cues.follow_up, cues=list(cues.reasons))

    # -- self-contained question: nothing inherited, nothing rewritten ------ #
    if not cues.follow_up:
        resolved = _rebuilt(plan)
        return ResolvedQuery(status=ResolutionStatus.RESOLVED, resolved_plan=resolved,
                             turn_context=extract_context(resolved, config), metadata=meta)

    turns = _contributing(state)
    prior: Optional[TurnContext] = turns[0].context if turns else None
    prior_turn: Optional[int] = turns[0].sequence if turns else None

    current_concepts = cues_mod.clean_concepts(plan.concepts)
    own_subject = cues_mod.has_own_subject(plan, current_concepts)
    resolved_refs: List[TypedReferent] = []
    unresolved: List[UnresolvedReferent] = []
    ambiguities: List[Ambiguity] = []
    used: List[ContextUse] = []
    resets: List[str] = []

    # -- 1. referents, typed, newest compatible turn first ------------------ #
    ref_location: Optional[Tuple[Location, int]] = None
    ref_time = None
    ref_concepts = None
    subject_turn: Optional[ConversationTurn] = None
    for cue in cues.referents:
        kind = cue.target_type
        # The current turn may itself satisfy the reference: "the same period
        # last month" names its own period, and what is typed wins.
        if kind is ReferentType.TIME_RANGE and plan.time_range.kind is not TimeKind.ALL_TIME:
            resolved_refs.append(TypedReferent(token=cue.token, target_type=kind,
                                               value=_dump(plan.time_range), confidence=1.0,
                                               source="explicit"))
            continue
        if kind is ReferentType.LOCATION and plan.location is not None:
            resolved_refs.append(TypedReferent(token=cue.token, target_type=kind,
                                               value=_dump(plan.location), confidence=1.0,
                                               source="explicit"))
            continue
        turn, values = _find(turns, kind)
        essential = True
        if kind in (ReferentType.RESULT_SET, ReferentType.PREVIOUS_QUERY) and own_subject:
            # "Which of these posts are communal" names its own subject; the
            # reference sharpens it but the question stands without it.
            essential = False
        if turn is None:
            unresolved.append(UnresolvedReferent(token=cue.token, target_type=kind,
                                                 reason="no_context", essential=essential))
            continue
        if len(values) > 1:
            names = [_label(v) for v in values]
            unresolved.append(UnresolvedReferent(token=cue.token, target_type=kind,
                                                 reason="ambiguous", essential=True,
                                                 candidates=names))
            ambiguities.append(Ambiguity(field=f"context.{kind.value}",
                                         reason=f"'{cue.token}' could refer to any of several "
                                                f"earlier {kind.value.replace('_', ' ')}s",
                                         candidates=names, confidence=0.5))
            continue
        value = values[0]
        resolved_refs.append(TypedReferent(token=cue.token, target_type=kind,
                                           source_turn=turn.sequence, value=_dump(value),
                                           confidence=_confidence(state, turn)))
        if kind is ReferentType.LOCATION:
            ref_location = (value, turn.sequence)
        elif kind is ReferentType.TIME_RANGE:
            ref_time = (value, turn.sequence)
        elif kind is ReferentType.CONCEPT:
            ref_concepts = (value, turn.sequence)
        else:
            subject_turn = turn

    # A subject reference ("those alerts", "how many were there") inherits a
    # whole subject. If that subject named several places and this turn names
    # none, which one is meant is unknown: ask, do not pick the first.
    subject_ctx = subject_turn.context if subject_turn else prior
    subject_seq = subject_turn.sequence if subject_turn else prior_turn
    location_open = any(u.target_type is ReferentType.LOCATION for u in unresolved)
    inherit_location = (plan.location is None and ref_location is None and not location_open
                        and not cues.reset_location and subject_ctx is not None)
    if inherit_location and len(subject_ctx.locations) > 1:
        names = [loc.text for loc in subject_ctx.locations]
        unresolved.append(UnresolvedReferent(token="(implied place)",
                                             target_type=ReferentType.LOCATION,
                                             reason="ambiguous", candidates=names))
        ambiguities.append(Ambiguity(field="context.location",
                                     reason="the earlier question named several places",
                                     candidates=names, confidence=0.5))

    explicit_only = all(r.source == "explicit" for r in resolved_refs)
    needs_context = (not explicit_only or "continuation" in cues.reasons
                     or "planner:follow_up" in cues.reasons
                     or any(c.target_type in (ReferentType.PREVIOUS_QUERY, ReferentType.RESULT_SET,
                                              ReferentType.COMPARISON_SUBJECT)
                            for c in cues.referents))
    if prior is None and not unresolved and not needs_context:
        # Nothing to follow and nothing that points back: the question
        # stands as asked ("compare this month with last month").
        resolved = _rebuilt(plan)
        meta.referents_resolved = len(resolved_refs)
        return ResolvedQuery(status=ResolutionStatus.RESOLVED, resolved_plan=resolved,
                             resolved_referents=resolved_refs,
                             turn_context=extract_context(resolved, config), metadata=meta)
    if prior is None and not unresolved:
        # A follow-up with no conversation to follow.
        unresolved.append(UnresolvedReferent(
            token=cues.referents[0].token if cues.referents else "(previous question)",
            target_type=cues.referents[0].target_type if cues.referents else ReferentType.PREVIOUS_QUERY,
            reason="no_context"))

    essential_open = [u for u in unresolved if u.essential]
    if essential_open:
        status = (ResolutionStatus.CONTEXT_AMBIGUOUS
                  if any(u.reason == "ambiguous" for u in essential_open)
                  else ResolutionStatus.CONTEXT_REQUIRED)
        meta.referents_resolved = len(resolved_refs)
        meta.referents_unresolved = len(unresolved)
        return ResolvedQuery(status=status,
                             resolved_plan=_clarification_plan(plan, unresolved, ambiguities),
                             resolved_referents=resolved_refs, unresolved_referents=unresolved,
                             metadata=meta)

    # -- 2. build the resolved plan, field by field ------------------------- #
    # location
    location = plan.location
    locations_for_context: Optional[List[Location]] = None
    location_amb = [a for a in plan.ambiguities if a.field == "location"]
    if location is not None:
        used.append(ContextUse(field="location", via=Via.EXPLICIT))
    elif ref_location is not None:
        location = ref_location[0].model_copy(update={"source": Source.CONTEXT})
        used.append(ContextUse(field="location", via=Via.REFERENT, source_turn=ref_location[1]))
        locations_for_context = [location]
    elif cues.reset_location:
        resets.append("location")
        used.append(ContextUse(field="location", via=Via.RESET))
    elif subject_ctx is not None and subject_ctx.locations:
        location = subject_ctx.locations[0].model_copy(update={"source": Source.CONTEXT})
        used.append(ContextUse(field="location", via=Via.INHERITED, source_turn=subject_seq))
        locations_for_context = [location]
    if location is not None and location.source is Source.CONTEXT and subject_ctx is not None:
        # The place keeps the ambiguity it was asked with, so the Policy Gate
        # sees exactly what it would have seen had the user typed it again.
        location_amb = location_amb or [a for a in subject_ctx.location_ambiguities
                                        if location.text.lower() in a.reason.lower()]

    # time
    time_range = plan.time_range
    if time_range.kind is not TimeKind.ALL_TIME:
        used.append(ContextUse(field="time_range", via=Via.EXPLICIT))
    elif ref_time is not None:
        time_range = ref_time[0]
        used.append(ContextUse(field="time_range", via=Via.REFERENT, source_turn=ref_time[1]))
    elif cues.reset_time:
        resets.append("time_range")
        used.append(ContextUse(field="time_range", via=Via.RESET))
    elif subject_ctx is not None and subject_ctx.time_range.kind is not TimeKind.ALL_TIME:
        time_range = subject_ctx.time_range
        used.append(ContextUse(field="time_range", via=Via.INHERITED, source_turn=subject_seq))

    # filters: current fields replace, resets drop, the rest carry forward
    current_fields = {f.field for f in plan.filters}
    filters = list(plan.filters)
    for f in plan.filters:
        used.append(ContextUse(field=f"filter.{f.field.value}", via=Via.EXPLICIT))
    for field in sorted(cues.reset_fields, key=lambda x: x.value):
        if subject_ctx and any(f.field is field for f in subject_ctx.filters) \
                and field not in current_fields:
            resets.append(f"filter.{field.value}")
            used.append(ContextUse(field=f"filter.{field.value}", via=Via.RESET))
    if subject_ctx is not None:
        new_subject = own_subject
        for f in subject_ctx.filters:
            if f.field in current_fields or f.field in cues.reset_fields:
                continue
            if f.field in cues_mod.SUBJECT_FIELDS and new_subject:
                continue            # a new subject replaces the old one whole
            filters.append(f.model_copy(update={"source": Source.CONTEXT}))
            used.append(ContextUse(field=f"filter.{f.field.value}", via=Via.INHERITED,
                                   source_turn=subject_seq))

    # concepts
    concepts = current_concepts
    if concepts:
        used.append(ContextUse(field="concepts", via=Via.EXPLICIT))
    elif ref_concepts is not None:
        value = ref_concepts[0]
        if isinstance(value, Concept):
            concepts = [value.model_copy(update={"source": Source.CONTEXT})]
        elif value.field not in {f.field for f in filters}:
            # The earlier subject was a known topic, i.e. a filter.
            filters.append(value.model_copy(update={"source": Source.CONTEXT}))
        used.append(ContextUse(field="concepts", via=Via.REFERENT, source_turn=ref_concepts[1]))
    elif not own_subject and subject_ctx is not None and subject_ctx.concepts:
        concepts = [c.model_copy(update={"source": Source.CONTEXT}) for c in subject_ctx.concepts]
        used.append(ContextUse(field="concepts", via=Via.INHERITED, source_turn=subject_seq))

    entities = list(plan.entities)
    if not entities and subject_ctx is not None and subject_ctx.entities and not own_subject:
        entities = [e.model_copy(update={"source": Source.CONTEXT}) for e in subject_ctx.entities]
        used.append(ContextUse(field="entities", via=Via.INHERITED, source_turn=subject_seq))

    # intent: a follow-up continues the earlier work unless it names its own
    intent = plan.intent
    group_by = list(plan.group_by)
    if cues.breakdown:
        intent, group_by = Intent.AGGREGATION, group_by or list(cues.breakdown)
        used.append(ContextUse(field="intent", via=Via.EXPLICIT))
    elif cues.compare:
        intent = Intent.COMPARISON
        used.append(ContextUse(field="intent", via=Via.EXPLICIT))
    elif intent in _WEAK_INTENTS and not (cues.display and intent is not Intent.FOLLOW_UP):
        if subject_ctx is not None and subject_ctx.intent in _INHERITABLE_INTENTS:
            intent = subject_ctx.intent
            if not group_by and intent is Intent.AGGREGATION:
                group_by = list(subject_ctx.group_by)
            used.append(ContextUse(field="intent", via=Via.INHERITED, source_turn=subject_seq))
        elif intent is Intent.FOLLOW_UP:
            intent = Intent.FILTERED_SEARCH
    if intent in (Intent.FILTERED_SEARCH, Intent.UNKNOWN_CONCEPT, Intent.FOLLOW_UP):
        # Recomputed the way the planner decides it, now that the subject is known.
        only_unknown = concepts and all(c.status is not ConceptStatus.KNOWN for c in concepts)
        intent = Intent.UNKNOWN_CONCEPT if (only_unknown and not filters) else Intent.FILTERED_SEARCH
    metric = plan.metric or ("count" if intent in _ANALYTIC else None)

    # comparison: both sides typed, and each side visible to the Policy Gate
    comparison_subjects: List[Location] = []
    sub_questions = list(plan.sub_questions)
    if intent is Intent.COMPARISON and subject_ctx is not None:
        earlier = subject_ctx.locations[:1]
        comparison_subjects = earlier + ([plan.location] if plan.location else [])
        if location is None and earlier:
            location = earlier[0].model_copy(update={"source": Source.CONTEXT})
        sub_questions = []
        for i, side in enumerate(comparison_subjects):
            # A district-typed side becomes a district filter, which the gate
            # checks exactly as it checks the plan's own location.
            side_filters = ([Filter(field=FilterField.DISTRICT, value=side.text,
                                    source=Source.CONTEXT if side.source is Source.CONTEXT
                                    else Source.EXPLICIT, raw=side.text)]
                            if side.type is LocationType.DISTRICT else [])
            sub_questions.append(SubQuestion(index=i, text=side.text, intent=Intent.COMPARISON,
                                             shape=Shape.COMPARISON, filters=side_filters))

    unresolved_location = bool(location and not location.resolved)
    unresolved_concept = any(c.status is not ConceptStatus.KNOWN for c in concepts)
    needs = qu_det._needs_for(intent, {"unresolved_location": unresolved_location,
                                       "unresolved_concept": unresolved_concept})

    # the planner's referents, marked resolved where this layer resolved them
    open_tokens = {u.token.lower() for u in unresolved}
    summary = ", ".join(sorted({_label(r.value) if not isinstance(r.value, dict)
                                else (r.value.get("text") or r.value.get("kind") or r.target_type.value)
                                for r in resolved_refs})) or "previous question"
    referents = []
    for r in plan.referents:
        still_open = any(r.token.lower() in t or t in r.token.lower() for t in open_tokens)
        referents.append(r if still_open else r.model_copy(update={
            "resolved": True, "resolved_value": summary[:120]}))

    ambiguities_out = [a for a in plan.ambiguities if a.field != "location"] + location_amb + ambiguities
    resolved = _rebuilt(plan.model_copy(deep=True, update={
        "intent": intent,
        "shape": qu_det._shape_for(intent, location is not None),
        "filters": filters, "location": location, "time_range": time_range,
        "concepts": concepts, "entities": entities, "group_by": group_by, "metric": metric,
        "sub_questions": sub_questions, "needs": needs,
        "required_tools": qu_tools.tools_for(needs),
        "referents": referents, "ambiguities": ambiguities_out,
    }))

    status = ResolutionStatus.PARTIALLY_RESOLVED if unresolved else ResolutionStatus.RESOLVED
    meta.context_items_used = sum(1 for u in used if u.via in (Via.INHERITED, Via.REFERENT))
    meta.referents_resolved = len(resolved_refs)
    meta.referents_unresolved = len(unresolved)
    return ResolvedQuery(
        status=status, resolved_plan=resolved, resolved_referents=resolved_refs,
        unresolved_referents=unresolved, context_used=used, resets=resets,
        comparison_subjects=comparison_subjects,
        turn_context=extract_context(resolved, config, locations_for_context),
        metadata=meta)
