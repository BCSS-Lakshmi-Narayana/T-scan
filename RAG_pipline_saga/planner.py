"""
planner.py — turning a question into a QuerySpec.

Most of what officers ask is a filter wearing a sentence:

    "negative posts against police in the last month"
    "highest risk alerts"
    "grievances tagging @TelanganaDGP"
    "show me 20 communal posts on facebook"

Those resolve by rule: no tokens, no latency, no dependency on an LLM endpoint
that is intermittently busy behind the sentiment service. Rules also fail
honestly -- an unmatched phrase leaves a field unset, which means "no
constraint", rather than a confident wrong guess.

The LLM is the fallback for phrasing the rules do not cover, and it only ever
fills fields it is sure about. It never decides what the user may see: tenant
and district scope arrive from the proxy and are applied after this runs.

Two defaults matter and are deliberate:

  * No date in the question means ALL TIME. The previous pipeline defaulted to
    seven days, so "posts about corruption" silently excluded everything older
    than a week and looked like the data was missing.
  * The default limit is 15, not 4. "Show me posts" means a list worth reading.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from retriever import QuerySpec, keywords

logger = logging.getLogger(__name__)

DEFAULT_LIMIT = 15
MAX_LIMIT = 50


# --------------------------------------------------------------------------- #
# vocabulary
# --------------------------------------------------------------------------- #

SENTIMENT = [
    (r"\b(negative|angry|critical|abusive|hostile|adverse|bad)\b", "negative"),
    (r"\b(positive|supportive|appreciat\w*|praise\w*|good)\b", "positive"),
    (r"\bneutral\b", "neutral"),
]

# "high risk" is a level; "most serious" is an ordering. They are different
# questions and conflating them loses the top of the list.
RISK_LEVEL = [
    (r"\b(high[- ]?risk|critical|severe|serious)\b", ["high"]),
    (r"\bmedium[- ]?risk\b", ["medium"]),
    (r"\blow[- ]?risk\b", ["low"]),
]

# "posts", "tweets" and "content" are deliberately absent. Every alert and
# grievance IS a post, so officers use the word generically; mapping it to the
# contents collection made "communal posts" search nothing when only alerts
# and grievances were indexed.
KIND = [
    (r"\b(alerts?)\b", "alert"),
    (r"\b(grievances?|complaints?)\b", "grievance"),
]

PLATFORM = [
    (r"\b(x|twitter)\b", "x"),
    (r"\bfacebook|fb\b", "facebook"),
    (r"\binstagram|insta|ig\b", "instagram"),
    (r"\byoutube|yt\b", "youtube"),
    (r"\bwhatsapp\b", "whatsapp"),
]

# Ordering words. "top"/"highest" mean sort by risk, not filter to high.
SORT_RISK = re.compile(
    r"\b(top|highest|most (serious|severe|critical|dangerous)|worst|biggest)\b", re.I)
SORT_RECENT = re.compile(r"\b(latest|recent|newest|today|last \d+|past \d+)\b", re.I)

COUNT_QUESTION = re.compile(r"^\s*how many\b|\bcount of\b|\bnumber of\b", re.I)

# Questions that want an aggregate, not a list of records. Answering these from
# retrieved rows gives a confident wrong number: the model sees fifteen, says
# fifteen, and the true answer was four hundred.
BREAKDOWN_QUESTION = re.compile(
    r"\b(break(?:\s|-)?down|group(?:ed)? by|distribution|split by|by (?:platform|district|category|handle|topic)"
    r"|which (?:handles?|accounts?|profiles?|platforms?|districts?|topics?|categories)"
    r"|who (?:posts?|tweets?|is posting)|most active|top (?:handles?|accounts?|posters?|profiles?))\b", re.I)

# "compare" is matched on its own rather than as "compare to/with": the words
# in between are the subject ("compare THIS MONTH with last month"), so
# requiring adjacency missed the most natural phrasing of a trend question.
TREND_QUESTION = re.compile(
    r"\b(trend\w*|rising|falling|increas\w*|decreas\w*|growing|over time"
    r"|compare\w*|versus|vs\.?|than last (?:week|month|year))\b", re.I)

# What to group by, when the question names it.
_GROUP_HINTS = [
    (r"\b(handles?|accounts?|profiles?|posters?|users?)\b", "handle"),
    (r"\bplatforms?\b", "platform"),
    (r"\bdistricts?\b", "districts"),
    (r"\btopics?\b", "topics"),
    (r"\b(categor(?:y|ies))\b", "category"),
    (r"\bsentiments?\b", "sentiment"),
    (r"\brisk\b", "risk_level"),
    (r"\b(parties|party|targets?)\b", "targets"),
]

# Relative windows. Absent -> all time.
WINDOWS = [
    (re.compile(r"\b(today)\b", re.I), lambda m: timedelta(days=1)),
    (re.compile(r"\byesterday\b", re.I), lambda m: timedelta(days=2)),
    (re.compile(r"\b(?:last|past)\s+(\d+)\s*(hour|hr)s?\b", re.I),
     lambda m: timedelta(hours=int(m.group(1)))),
    (re.compile(r"\b(?:last|past)\s+(\d+)\s*days?\b", re.I),
     lambda m: timedelta(days=int(m.group(1)))),
    (re.compile(r"\b(?:last|past)\s+(\d+)\s*weeks?\b", re.I),
     lambda m: timedelta(weeks=int(m.group(1)))),
    (re.compile(r"\b(?:last|past)\s+(\d+)\s*months?\b", re.I),
     lambda m: timedelta(days=30 * int(m.group(1)))),
    (re.compile(r"\b(?:this|last|past)\s+week\b", re.I), lambda m: timedelta(weeks=1)),
    (re.compile(r"\b(?:this|last|past)\s+month\b", re.I), lambda m: timedelta(days=30)),
    (re.compile(r"\b(?:this|last|past)\s+year\b", re.I), lambda m: timedelta(days=365)),
]

LIMIT_RE = re.compile(r"\b(?:top|first|show(?: me)?|give(?: me)?|list)\s+(\d{1,3})\b", re.I)
AT_LEAST_RE = re.compile(r"\bat least\s+(\d{1,3})\b", re.I)

HANDLE_RE = re.compile(r"@([\w.]{2,30})")
# A bare "to" only counts before an explicit @handle: "related to rapes" is a
# topic, not a mention of an account called "rapes".
TAGGING_RE = re.compile(
    r"\b(?:(?:tagging|tagged|mention\w*|addressed to|directed at)\s+@?|to\s+@)([\w.]{2,30})", re.I)


def _window(question: str) -> Optional[datetime]:
    for pattern, delta in WINDOWS:
        m = pattern.search(question)
        if m:
            return datetime.now(timezone.utc) - delta(m)
    return None      # all time, on purpose


def _limit(question: str) -> int:
    for rx in (AT_LEAST_RE, LIMIT_RE):
        m = rx.search(question)
        if m:
            return max(1, min(int(m.group(1)), MAX_LIMIT))
    return DEFAULT_LIMIT


def _matches(question: str, table) -> List[str]:
    out = []
    for pattern, value in table:
        if re.search(pattern, question, re.I):
            out.append(value)
    return out


def plan(question: str, topic_map=None, target_map=None) -> QuerySpec:
    """Parse *question* into a QuerySpec.

    ``topic_map`` and ``target_map`` map officer vocabulary ("corruption",
    "bjp") onto the tags the views write. They are passed in rather than
    hard-coded so the lists can be edited without touching this logic; until
    they exist those constraints simply stay unset and the question falls
    through to lexical and semantic retrieval.
    """
    q = question or ""
    spec = QuerySpec(text=q)

    sentiments = _matches(q, SENTIMENT)
    if sentiments:
        spec.sentiment = sentiments[0]

    for pattern, levels in RISK_LEVEL:
        if re.search(pattern, q, re.I):
            spec.risk_levels = levels
            break

    spec.kinds = _matches(q, KIND)
    spec.platforms = _matches(q, PLATFORM)
    spec.since = _window(q)
    spec.limit = _limit(q)

    # Ordering. "top alerts" asks for the most severe, which is a sort; taking
    # it as a filter on risk_level=high would drop a 95 that was never labelled.
    if SORT_RISK.search(q):
        spec.sort = "risk"
    elif SORT_RECENT.search(q):
        spec.sort = "recent"

    # "tagging @X" is about who is mentioned; a bare @X is about the author.
    tagged = [m.group(1) for m in TAGGING_RE.finditer(q)]
    handles = [h for h in HANDLE_RE.findall(q) if h not in tagged]
    spec.tagged = [t.lstrip("@") for t in tagged]
    spec.handles = handles

    if topic_map:
        spec.topics = sorted({t for word, t in topic_map.items()
                              if re.search(rf"\b{re.escape(word)}\b", q, re.I)})
    if target_map:
        spec.targets = sorted({t for word, t in target_map.items()
                               if re.search(rf"\b{re.escape(word)}\b", q, re.I)})

    spec.terms = keywords(q)
    return spec


def is_count_question(question: str) -> bool:
    """Counts are answered from the database, not from retrieved rows."""
    return bool(COUNT_QUESTION.search(question or ""))


def wants_breakdown(question: str) -> Optional[str]:
    """The facet to group by, or None when the question wants records.

    "which handles post the most negative content" is a $group. Returning
    fifteen rows and letting the model tally them answers a different question.
    """
    q = question or ""
    if not BREAKDOWN_QUESTION.search(q):
        return None
    for pattern, facet in _GROUP_HINTS:
        if re.search(pattern, q, re.I):
            return facet
    # Asked for a breakdown without naming the axis: handle is the useful
    # default for "who is behind this".
    return "handle"


def wants_trend(question: str) -> bool:
    """True when the question asks whether something is moving, not what it is."""
    return bool(TREND_QUESTION.search(question or ""))


def describe(spec: QuerySpec) -> str:
    """One line naming the constraints actually applied.

    Shown with the answer: a filtered result read as an unfiltered one is how
    an officer concludes something does not exist when it was merely excluded.
    """
    bits = []
    if spec.sentiment:
        bits.append(spec.sentiment)
    if spec.risk_levels:
        bits.append("/".join(spec.risk_levels) + " risk")
    if spec.kinds:
        bits.append("/".join(spec.kinds) + "s")
    if spec.platforms:
        bits.append("on " + "/".join(spec.platforms))
    if spec.handles:
        bits.append("by @" + ", @".join(spec.handles))
    if spec.tagged:
        bits.append("tagging @" + ", @".join(spec.tagged))
    if spec.topics:
        bits.append("about " + ", ".join(spec.topics))
    if spec.targets:
        bits.append("against " + ", ".join(spec.targets))
    bits.append(f"since {spec.since:%d %b %Y}" if spec.since else "all time")
    return ", ".join(bits)
