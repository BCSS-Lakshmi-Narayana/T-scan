"""
plan.py — enrich a QueryPlan with resolved places, BEFORE the Policy Gate.

Why before: the gate can only check what the plan states. Phase 1A's place
list is Latin-script only, so "కరీంనగర్‌లో ఏం జరుగుతోంది" reached the gate with
no location and was allowed for an officer who cannot see Karimnagar (1B
known limitation #1). Resolving here lets the gate see the district and
refuse it, exactly as for the English question.

This reads a static gazetteer and nothing else — no tenant data, no model —
so running it ahead of authorisation exposes nothing. It only ever ADDS what
the question named; it never removes a constraint and never widens scope.
The returned plan is new and re-validated; the input is not modified.
"""

from __future__ import annotations

import re
from typing import List, Tuple

from query_understanding import deterministic as qu_det
from query_understanding import tools as qu_tools
from query_understanding.models import (Ambiguity, ConceptStatus, Filter,
                                        FilterField, FilterOp, Intent,
                                        Location, LocationType, QueryPlan,
                                        Shape, Source, SubQuestion)

from . import location as loc

_TYPE = {"district": LocationType.DISTRICT, "commissionerate": LocationType.COMMISSIONERATE,
         "city": LocationType.CITY, "neighbourhood": LocationType.NEIGHBOURHOOD,
         "state": LocationType.STATE, "country": LocationType.COUNTRY}


def _as_location(r: loc.LocationResolution, source: Source) -> Location:
    p = r.place
    return Location(text=p.name, type=_TYPE.get(p.type, LocationType.UNKNOWN), resolved=True,
                    resolved_id=p.id, hierarchy=list(p.districts), source=source,
                    confidence=r.confidence)


def _debris(text: str) -> bool:
    """Phase 1A's tokeniser splits Indic combining marks, so a Telugu phrase
    arrives as fragments. Mostly one- and two-letter non-Latin fragments are
    not a concept anyone asked about."""
    toks = text.split()
    non_latin = [t for t in toks if not re.fullmatch(r"[A-Za-z0-9'-]+", t)]
    return bool(non_latin) and sum(1 for t in non_latin if len(t) <= 2) * 2 >= len(non_latin)


def _strip_places(plan: QueryPlan):
    """Concepts that are only place names ("Warangal", "Compare Hyderabad")
    would otherwise be searched as subjects."""
    out = []
    for c in plan.concepts:
        if _debris(c.text):
            continue
        words = [w for w in c.text.split()
                 if not loc._alias_index().get(loc.fold(w)) and loc.fold(w) not in ("compare",)]
        if words:
            text = " ".join(words)
            out.append(c if text == c.text else c.model_copy(update={"text": text,
                                                                       "normalized": text.lower()}))
    return out


def enrich_plan(plan: QueryPlan) -> Tuple[QueryPlan, List[str]]:
    """(enriched plan, notes). Notes are human-readable statements of what
    was resolved or assumed, carried into the response's limitations."""
    notes: List[str] = []
    mentions = [m for m in loc.find_all(plan.raw_query) if m.status == "resolved"]
    location = plan.location
    ambiguities = list(plan.ambiguities)

    if location is not None and not location.resolved:
        r = loc.resolve(location.text, context=plan.raw_query)
        if r.status == "resolved":
            location = _as_location(r, location.source)
            if r.assumption:
                notes.append(r.assumption)
        elif r.status == "ambiguous":
            ambiguities.append(Ambiguity(field="location",
                                         reason=f"'{location.text}' matches several places",
                                         candidates=[c.name for c in r.candidates]))
    elif location is None and mentions:
        # Named, but not seen by the Latin-only planner (Telugu, Hindi, …).
        location = _as_location(mentions[0], Source.DETERMINISTIC)
        notes.append(f"Recognised the place '{location.text}' in the question.")

    sub_questions = list(plan.sub_questions)
    filters = list(plan.filters)
    if plan.intent is Intent.COMPARISON and len(mentions) >= 2 and not sub_questions:
        # Each side of a comparison becomes a sub-question carrying its
        # districts, so the gate checks every side, not just the first.
        for i, m in enumerate(mentions[:4]):
            side_filters = ([Filter(field=FilterField.DISTRICT, operator=FilterOp.IN,
                                    value=list(m.place.districts), source=Source.DETERMINISTIC,
                                    raw=m.place.name)]
                            if m.place.districts else [])
            sub_questions.append(SubQuestion(index=i, text=m.place.name, intent=Intent.COMPARISON,
                                             shape=Shape.COMPARISON, filters=side_filters))

    concepts = _strip_places(plan) if (mentions or location) else list(plan.concepts)
    intent = plan.intent
    if plan.concepts and not concepts and intent is Intent.UNKNOWN_CONCEPT:
        # Nothing left to look for but the place: search it, and say the rest
        # of the wording was not understood rather than scanning for debris.
        intent = Intent.FILTERED_SEARCH
        notes.append("Only the place in this question could be interpreted; showing records "
                     "for it.")
    unresolved_location = bool(location and not location.resolved)
    unresolved_concept = any(c.status is not ConceptStatus.KNOWN for c in concepts)
    needs = plan.needs
    changed = (location != plan.location or concepts != list(plan.concepts)
               or intent is not plan.intent)
    # Needs are re-derived only when enrichment changed what they depend on;
    # a plan that understood nothing (needs=[none]) stays a plan that
    # understood nothing, rather than becoming a lookup of everything.
    if changed and intent is not Intent.MULTI_PART:
        needs = qu_det._needs_for(intent, {"unresolved_location": unresolved_location,
                                           "unresolved_concept": unresolved_concept})
    shape = plan.shape
    if intent is not plan.intent or intent is Intent.SITUATION_ANALYSIS:
        shape = qu_det._shape_for(intent, location is not None)

    enriched = plan.model_copy(deep=True, update={
        "location": location, "sub_questions": sub_questions, "filters": filters,
        "concepts": concepts, "needs": needs, "required_tools": qu_tools.tools_for(needs),
        "ambiguities": ambiguities, "shape": shape, "intent": intent,
    })
    return QueryPlan.model_validate(enriched.model_dump()), notes
