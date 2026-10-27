"""
concepts.py — what the officer is looking for, once the filters are removed.

"Show me communal content from the last 7 days" is two things:

    a FILTER    last 7 days                    -> the database, exact
    a CONCEPT   communal                       -> needs judgement

The posts carry no "communal" tag, and no tag list can anticipate every
concept an officer will name. So the concept is judged on demand (scan.py):
this module only separates it from the filter words.

It also recognises the grouping form:

    "which are communal and which are international, national, local"
        -> labels ["communal", "international", "national", "local"]

An empty concept means the question is fully a filter ("high risk alerts
today") and goes to the ordinary engine, with no judging at all.
"""

from __future__ import annotations

import re
from typing import List, Optional

import planner
import regex as _regex

# Definitions handed to the judge for labels whose meaning depends on where
# the data comes from. "local" is meaningless without knowing local to what.
LABEL_HINTS = {
    "international": "about events, people or countries outside India",
    "national": "about India as a whole or central/national matters, not specific to Telangana",
    "state": "about Telangana (or Andhra Pradesh) at the state level: state government, statewide issues",
    "local": "about a specific district, city, town, village or locality",
    "communal": "religious or caste tension, hostility between communities, or content inciting it",
    "political": "about political parties, leaders, elections or government politics",
    "fake news": "false or misleading claims presented as fact",
    "misinformation": "false or misleading claims presented as fact",
}

# Words that carry no concept on their own: request phrasing, record nouns,
# and the filter words the rule planner already turned into constraints.
_FILLER = {
    "show", "me", "give", "tell", "list", "find", "get", "fetch", "search", "display",
    "what", "which", "who", "are", "is", "was", "were", "the", "a", "an", "all", "any",
    "some", "every", "of", "in", "on", "for", "from", "to", "with", "by", "at", "and",
    "or", "that", "those", "these", "this", "there", "their", "it", "its", "i", "we",
    "need", "want", "please", "can", "could", "you", "would", "should", "do", "does",
    "related", "relating", "regarding", "about", "concerning", "around", "like",
    "posts", "post", "content", "contents", "tweets", "tweet", "alerts", "alert",
    "grievances", "grievance", "complaints", "complaint", "records", "record",
    "items", "data", "details", "detail", "links", "link", "urls", "url", "info",
    "information", "ones", "one", "things", "stuff", "etc", "that's", "such",
    "latest", "recent", "newest", "top", "most", "highest", "last", "past", "days",
    "day", "weeks", "week", "months", "month", "year", "years", "hours", "hour",
    "today", "yesterday", "least", "atleast", "first", "only", "also", "just",
    "negative", "positive", "neutral", "high", "medium", "low", "risk", "critical",
    "severe", "serious", "x", "twitter", "facebook", "fb", "instagram", "insta", "ig",
    "youtube", "yt", "whatsapp", "anything", "everything", "happening", "happened",
    "going", "new", "update", "updates", "summary", "overview", "status", "report",
    "situation", "being", "been", "has", "have", "had", "being", "made", "shared",
    "posted", "platform", "platforms", "social", "media", "news", "analysis",
    "analyse", "analyze", "analysed", "analyzed", "check", "look", "see",
}

_NUMBER = re.compile(r"\b\d+\b")
_HANDLE = re.compile(r"[@#][\w.]+")
_WORD = re.compile(r"[^\W\d_][\w'-]*", re.U)

# "which are A and which are B", "which ones are A, which B"
_WHICH_SPLIT = re.compile(r"\bwhich(?:\s+ones?)?(?:\s+(?:are|is|of them are|of these are))?\b", re.I)
# "classify / categorise / group / segregate / split them into A, B and C"
_INTO = re.compile(
    r"\b(?:classify|categori[sz]e|group|segregate|split|sort|separate|divide|bucket)\w*"
    r"\b.*?\b(?:into|as|by)\b(.+)$", re.I)
_LIST_SEP = re.compile(r"\s*(?:,|/|\bor\b|\band\b|\bvs\.?\b|\bversus\b|;)\s*", re.I)
_TOKENS = _regex.compile(r"\p{L}\p{M}*(?:[\p{L}\p{M}\p{Nd}]|['’-])*|,|/|;")
_LEAD_IN = re.compile(
    r"^(?:(?:the\s+)?(?:posts?|content|alerts?|grievances?|ones?)\s+)?"
    r"(?:(?:that|which)\s+(?:are|is)\s+)?(?:related\s+to|about|regarding|on)?\s*", re.I)
_TAIL = re.compile(r"\s*(?:like that|etc\.?|and so on|posts?|content|ones?|news|issues?|related)\s*$", re.I)


def _strip_syntax(question: str) -> str:
    """Remove the parts the rule planner already consumed as filters."""
    q = question or ""
    for pattern, _ in planner.WINDOWS:
        q = pattern.sub(" ", q)
    q = planner.LIMIT_RE.sub(" ", q)
    q = planner.AT_LEAST_RE.sub(" ", q)
    q = _HANDLE.sub(" ", q)
    q = _NUMBER.sub(" ", q)
    return q


def _content_words(text: str) -> List[str]:
    return [w for w in _WORD.findall(text or "") if w.lower() not in _FILLER]


def concept(question: str) -> str:
    """The concept phrase, or "" when the question is only filters.

    Kept in the officer's word order ("against police", "communal") because it
    is shown back to them and handed to the judge verbatim.
    """
    # List separators survive as commas, so "rapes, robbery or corruption"
    # stays a list rather than collapsing into one phrase.
    out: List[str] = []
    pending_sep = False
    # Indic marks are not \w, so the old pattern split every Telugu word at
    # its virama and handed the judge a row of consonants.
    for tok in _TOKENS.findall(_strip_syntax(question)):
        low = tok.lower()
        if low in (",", "/", ";", "or", "and"):
            pending_sep = bool(out)
            continue
        if low in _FILLER:
            continue
        if pending_sep:
            out.append(",")
            pending_sep = False
        out.append(tok)
        if sum(1 for w in out if w != ",") >= 12:
            break
    return " ".join(out).replace(" ,", ",").strip()


def _clean_label(raw: str) -> str:
    s = _LEAD_IN.sub("", raw.strip(" .?!:-"))
    for _ in range(2):
        s = _TAIL.sub("", s)
    return " ".join(_content_words(s)[:5]) or ""


def _explode(label: str) -> List[str]:
    """ "international national local" -> three labels, when every word is a
    known label; otherwise the phrase stays whole ("hate against women")."""
    parts = label.split()
    if len(parts) > 1 and all(p.lower() in LABEL_HINTS for p in parts):
        return parts
    return [label]


def group_labels(question: str) -> List[str]:
    """The labels of a "which are A and which are B" question, or [].

    Two or more labels are required: "which are communal" is a single concept
    and is served better as a list than as a one-bucket breakdown.
    """
    q = _strip_syntax(question)
    segments: List[str] = []

    m = _INTO.search(q)
    if m:
        segments = [m.group(1)]
    else:
        parts = _WHICH_SPLIT.split(q)
        if len(parts) >= 3:          # at least two "which" clauses
            segments = parts[1:]

    labels: List[str] = []
    for seg in segments:
        for piece in _LIST_SEP.split(seg):
            cleaned = _clean_label(piece)
            if not cleaned:
                continue
            for lab in _explode(cleaned):
                key = lab.lower()
                if key not in [l.lower() for l in labels]:
                    labels.append(lab)
    return labels[:8] if len(labels) >= 2 else []


def cache_key(label: str) -> str:
    """Stable key for a concept: case, order and filler do not matter, so
    "communal content" and "Communal" share their verdicts."""
    words = sorted({w.lower() for w in _content_words(label)})
    return " ".join(words)


def hint(label: str) -> Optional[str]:
    return LABEL_HINTS.get(label.lower().strip())
