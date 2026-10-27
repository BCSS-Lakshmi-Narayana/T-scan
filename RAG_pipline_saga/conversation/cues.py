"""
cues.py — does this question lean on an earlier one, and on what?

Deterministic. No model is asked "what does 'that' refer to"; the answer is a
typed lookup against earlier turns, and the question here is only which TYPE
of thing each back-reference needs.

Phase 1A detects a few referents but types them loosely ("that district" is a
topic there) and was not built with memory in mind, so most follow-ups arrive
as ordinary plans: "And in Warangal?" is an unknown concept, "How many were
there?" carries a location referent that is really existential. The cues here
read those plans again, with a conversation in mind. The place list and the
grouping hints are Phase 1A's own (deterministic.TELANGANA_PLACES and
_GROUP_HINTS); nothing is restated, and no second gazetteer exists.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Set, Tuple

from query_understanding import deterministic as qu_det
from query_understanding import normalize as qu_normalize
from query_understanding.models import (Concept, FilterField, Intent, Location,
                                        QueryPlan, Source)

from .models import ReferentType

# -- noun -> referent type ---------------------------------------------------- #
_LOC_NOUNS = r"district|area|place|region|location|city|mandal|village|zone|town"
_CONCEPT_NOUNS = r"concept|topic|issue|subject|matter|theme|term"
_TIME_NOUNS = r"period|time|timeframe|window|day|week|month|year|date|range"
_RESULT_NOUNS = (r"alerts?|posts?|results?|records?|complaints?|grievances?|ones?|"
                 r"incidents?|cases?|items?|content|comments?|handles?|accounts?")

_TYPED = [
    (re.compile(rf"\b(?:that|this|the same|same)\s+(?:{_LOC_NOUNS})\b", re.I), ReferentType.LOCATION),
    (re.compile(rf"\b(?:that|this|the same|same)\s+(?:{_CONCEPT_NOUNS})\b", re.I), ReferentType.CONCEPT),
    # "this week" / "this month" name a calendar period; only "that period"
    # and "the same period" point back at an earlier one.
    (re.compile(rf"\b(?:that|the same|same)\s+(?:{_TIME_NOUNS})\b", re.I), ReferentType.TIME_RANGE),
    (re.compile(rf"\b(?:those|these|them|the above|such)\s+(?:{_RESULT_NOUNS})\b", re.I), ReferentType.RESULT_SET),
    (re.compile(r"\bthe above\b|\bearlier results?\b|\bthe previous (?:one|results?|query)\b", re.I),
     ReferentType.RESULT_SET),
    (re.compile(r"\b(?:only|just)\b.*\bones\b|\bones\b", re.I), ReferentType.RESULT_SET),
]
# "compare that with X": the other side of the comparison is the last subject.
# The pronoun must stand alone ("compare that with X", "compare it"), not
# determine a noun ("compare this month with last month").
_COMPARE_REF = re.compile(r"\bcompare\s+(?:that|it|this|them|those|these)"
                          r"(?:\s+(?:with|to|and|against|vs\.?|versus)\b|\s*[?.!]*\s*$)", re.I)
# A bare pronoun only counts when the question has no subject of its own;
# "how many alerts, and is it increasing?" refers inside its own sentence.
# "it"/"them" are always pronouns; "this/that/these/those" only when they
# stand alone ("break that down", "compare that with", "show me that"), not
# when they determine a noun ("this month", "those alerts").
_PRONOUN = re.compile(
    r"\b(?:it|them)\b|\b(?:that|this|these|those)\b(?=\s*(?:[?.!,]|$)|\s+(?:is|was|are|were|"
    r"with|by|to|and|for|in|on|about|down|up|again|please|one|ones)\b)", re.I)
# "there" is a place ("what about there?") unless it is existential
# ("how many were there?", "is there anything").
_THERE = re.compile(r"\bthere\b", re.I)
_EXISTENTIAL = re.compile(r"\b(?:is|are|was|were|be)\s+there\b|\bthere\s+(?:is|are|was|were|be)\b", re.I)

_CONTINUATION = re.compile(r"^\s*(?:and|also|plus|what about|how about|then|now|only|just|"
                           r"same|but|ok(?:ay)?|what of)\b", re.I)
_DISPLAY_VERB = re.compile(r"\b(?:show|list|display|give|see|fetch|open|get)\b", re.I)
_BREAKDOWN = re.compile(r"\bbreak\b.*\bdown\b|\bsplit\b.*\bby\b|\bgroup(?:ed)?\b.*\bby\b"
                        r"|\bbreakdown\b", re.I)

# -- explicit resets: "all" widens a field back to nothing -------------------- #
_RESET_TIME = re.compile(r"\ball[\s-]time\b|\bever\b|\bany ?time\b|\ball dates\b", re.I)
_RESET_LOCATION = re.compile(r"\b(?:all|any|every)\s+(?:districts?|areas?|places?|locations?|regions?)\b"
                             r"|\beverywhere\b|\banywhere\b", re.I)
_RESET_FIELDS = [
    (re.compile(r"\b(?:all|any|every)\s+platforms?\b", re.I), {FilterField.PLATFORM}),
    (re.compile(r"\b(?:all|any|every)\s+sentiments?\b", re.I), {FilterField.SENTIMENT}),
    (re.compile(r"\b(?:all|any|every)\s+(?:risk|risk levels?)\b", re.I),
     {FilterField.RISK_LEVEL, FilterField.RISK_SCORE}),
    (re.compile(r"\b(?:all|any|every)\s+categor(?:y|ies)\b", re.I), {FilterField.CATEGORY}),
]
# "all alerts": the kind is kept, every narrowing modifier is dropped.
_RESET_MODIFIERS = re.compile(rf"\b(?:all|every)\s+(?:the\s+)?(?:{_RESULT_NOUNS})\b", re.I)
MODIFIER_FIELDS = frozenset({FilterField.RISK_LEVEL, FilterField.RISK_SCORE, FilterField.SENTIMENT,
                             FilterField.PLATFORM, FilterField.CATEGORY, FilterField.STANCE,
                             FilterField.CONTENT_TYPE, FilterField.HANDLE, FilterField.TAGGED})
#: Fields that say what a question is ABOUT, as opposed to narrowing it.
#:
#: KIND belongs here: "how many grievances are there" names its own subject —
#: grievances — and is a whole question. Leaving KIND out meant that the moment
#: the planner successfully recognised "grievances" and turned it into a kind
#: filter, the question stopped counting as having a subject, the existential
#: "there" was read as pointing back at a previous result set, and a complete
#: question was refused as a follow-up with nothing to follow. Understanding
#: the noun was what broke it, so "how many profiles are there" worked only
#: because "profiles" is NOT a known kind.
#:
#: Modifiers stay out. "and the high risk ones?" narrows an inherited subject
#: rather than naming one, so risk, platform and sentiment must not make a
#: question look self-contained.
SUBJECT_FIELDS = frozenset({FilterField.TOPIC, FilterField.TARGET,
                            FilterField.KIND, FilterField.CATEGORY})

# Words that carry the reference itself, the question frame, or a filter the
# planner already captured. Left inside a concept they turn "what about the
# same period" into a search for the phrase "same period".
_NOISE = {
    "what", "about", "how", "many", "much", "were", "was", "is", "are", "there", "that",
    "those", "these", "this", "them", "it", "same", "previous", "earlier", "period",
    "place", "district", "area", "region", "location", "concept", "topic", "issue",
    "subject", "break", "down", "by", "category", "categories", "platform", "show", "only",
    "just", "ones", "one", "and", "also", "the", "compare", "with", "me", "give", "list",
    "all", "any", "again", "then", "now", "of", "in", "on", "for", "a", "an", "to", "ok",
    "okay", "please", "high", "low", "medium", "risk", "high-risk", "low-risk", "negative",
    "positive", "neutral", "alert", "alerts", "post", "posts", "content", "record",
    "records", "result", "results", "yesterday", "today", "week", "month", "year", "last",
    "this", "time", "above", "same", "happened", "happening", "tell", "see",
    # trend and count words: "is it increasing?" asks HOW, not WHAT
    "increasing", "increase", "increased", "rising", "rise", "risen", "decreasing",
    "decrease", "falling", "fall", "growing", "grow", "trend", "trending", "going", "up",
    "count", "number", "more", "less", "fewer", "change", "changed", "changing",
    # Interrogative frame. "Where is it getting more attention?" left the
    # concept "Where getting attention", which is the shape of the question
    # rather than its subject — and a question that appears to name a subject
    # never reaches the pronoun check, so the plainest follow-up signal there
    # is ("it") was never looked at.
    "where", "when", "which", "who", "whose", "why", "getting", "get", "gets", "got",
    "attention", "focus", "most", "least", "worst", "best", "getting more",
}
_PLACES = qu_det.TELANGANA_PLACES


@dataclass
class Cue:
    token: str
    target_type: ReferentType


@dataclass
class Cues:
    follow_up: bool = False
    reasons: List[str] = field(default_factory=list)
    referents: List[Cue] = field(default_factory=list)
    reset_time: bool = False
    reset_location: bool = False
    reset_fields: Set[FilterField] = field(default_factory=set)
    breakdown: List[str] = field(default_factory=list)
    display: bool = False
    compare: bool = False


def clean_concepts(concepts: List[Concept]) -> List[Concept]:
    """Strip reference words, filter words and place names out of concept
    phrases; drop what is left empty. "incidents Hyderabad" -> "incidents",
    "same period" -> (nothing)."""
    out: List[Concept] = []
    for c in concepts:
        kept = [w for w in re.split(r"\s+", c.text.strip())
                if w and w.strip("?.,!").lower() not in _NOISE
                and w.strip("?.,!").lower() not in _PLACES]
        if not kept:
            continue
        text = " ".join(kept)
        if text == c.text:
            out.append(c)
        else:
            out.append(c.model_copy(update={"text": text, "normalized": text.lower()}))
    return out


def places_named(plan: QueryPlan) -> List[Location]:
    """Every gazetteer place the question names, in order of appearance,
    starting from the one the planner chose. "Compare Hyderabad and
    Warangal" names two, and remembering only the first would make a later
    "there" silently mean Hyderabad."""
    found: List[Tuple[int, Location]] = []
    text = plan.normalized_query.lower()
    seen = set()
    if plan.location is not None:
        seen.add(plan.location.text.lower())
        m = re.search(rf"\b{re.escape(plan.location.text.lower())}\b", text)
        found.append((m.start() if m else -1, plan.location))
    for name, kind in _PLACES.items():
        if name in seen:
            continue
        m = re.search(rf"\b{re.escape(name)}\b", text)
        if m:
            seen.add(name)
            found.append((m.start(), Location(text=name.title(), type=kind, resolved=False,
                                              source=Source.EXPLICIT, confidence=0.8)))
    return [loc for _, loc in sorted(found, key=lambda x: x[0])]


def has_own_subject(plan: QueryPlan, concepts: List[Concept]) -> bool:
    """Does the question say what it is about, without the conversation?"""
    return bool(concepts) or any(f.field in SUBJECT_FIELDS for f in plan.filters)


def detect(plan: QueryPlan) -> Cues:
    text = plan.normalized_query
    cues = Cues()
    concepts = clean_concepts(plan.concepts)
    own_subject = has_own_subject(plan, concepts) or plan.location is not None
    seen: Set[str] = set()

    def add(token: str, kind: ReferentType, why: str):
        key = token.lower()
        if key in seen:
            return
        seen.add(key)
        cues.referents.append(Cue(token=token, target_type=kind))
        cues.reasons.append(why)

    for pattern, kind in _TYPED:
        for m in pattern.finditer(text):
            add(m.group(0), kind, f"typed:{kind.value}")
    if _COMPARE_REF.search(text):
        cues.compare = True
        add(_COMPARE_REF.search(text).group(0), ReferentType.COMPARISON_SUBJECT, "compare-ref")
    for m in _THERE.finditer(text):
        if _EXISTENTIAL.search(text):
            # "how many were there" points back at a previous result set, but
            # "how many high risk posts are there in Hyderabad" is a whole
            # question that merely contains the word. Only the first is a
            # follow-up; treating the second as one refuses to answer it.
            if own_subject:
                continue
            add("there", ReferentType.RESULT_SET, "existential-there")
        elif plan.location is None:
            add("there", ReferentType.LOCATION, "there")
    if not own_subject and not cues.referents:
        m = _PRONOUN.search(text)
        if m:
            add(m.group(0), ReferentType.PREVIOUS_QUERY, "pronoun")

    cues.display = bool(_DISPLAY_VERB.search(text))
    if _BREAKDOWN.search(text):
        cues.breakdown = [facet for pattern, facet in qu_det._GROUP_HINTS if pattern.search(text)]
    cues.reset_time = bool(_RESET_TIME.search(text))
    cues.reset_location = bool(_RESET_LOCATION.search(text))
    for pattern, fields in _RESET_FIELDS:
        if pattern.search(text):
            cues.reset_fields |= fields
    if _RESET_MODIFIERS.search(text):
        cues.reset_fields |= set(MODIFIER_FIELDS)

    continuation = bool(_CONTINUATION.search(text))
    # Elliptical: a short question that says how, but not what.
    # Script-independent: counting a Telugu question with \w+ returned one
    # "word" per consonant, so a three-word question never looked elliptical.
    words = qu_normalize.words(text)
    elliptical = (not own_subject and len(words) <= 7
                  and not any(f.field is FilterField.KIND for f in plan.filters)
                  and plan.intent is not Intent.CONVERSATIONAL)
    if continuation:
        cues.reasons.append("continuation")
    if elliptical:
        cues.reasons.append("elliptical")
    if plan.intent is Intent.FOLLOW_UP:
        cues.reasons.append("planner:follow_up")
    cues.follow_up = bool(cues.referents or continuation or elliptical
                          or plan.intent is Intent.FOLLOW_UP)
    if plan.intent in (Intent.CONVERSATIONAL, Intent.MULTI_PART):
        # Greetings build on nothing; multi-part questions are self-contained
        # by construction and are resolved as a whole in a later phase.
        cues.follow_up = False
    return cues

