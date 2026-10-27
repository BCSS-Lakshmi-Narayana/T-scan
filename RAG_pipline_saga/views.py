"""
views.py — what actually gets embedded, and what stays filterable.

The previous converter flattened a whole document into ``Field: Value`` lines.
An alert came out like this:

    Id: 6aaa6128e1f2a6c09f5f848a
    Tenant Id: e4b1ec57-ceff-4f3c-a33a-7b34e1fb71d2
    Content Id: 9cb84932-1282-4f70-9bf1-05bc7ebbb878
    Source Id: 8ae51b79-251d-4351-be5c-0ce1e75299ee
    ...
    Is Read: True
    Is Priority: False

Three things go wrong with that:

  * Roughly a quarter of the tokens are UUIDs, which carry no meaning but do
    carry position in the vector.
  * The field labels are identical on every document in a collection, so every
    alert shares most of its tokens with every other alert. The embeddings
    collapse into one tight cluster and cosine similarity stops discriminating
    -- a communal threat and a routine political update score alike.
  * The one sentence that matters is repeated three times, while the post's own
    text may be pushed past EMBED_MAX_LENGTH and truncated away entirely.

So a view emits only what a person would need to recognise the record, in prose,
once. Everything structured -- risk level, sentiment, platform, handle, dates --
moves to ``facets()``, where it is filtered exactly rather than approximately.
A number in a vector is a worse version of a number in an index.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import vocabulary

# Values that mean "nothing here".
_EMPTY = {None, "", "None", "null", "undefined", "N/A", "-"}

# Markup the analysis pipeline writes into descriptions for the UI.
_MD = re.compile(r"\*\*|__|^\s*[•\-*]\s*", re.M)
_WS = re.compile(r"[ \t]+")
_BLANKS = re.compile(r"\n{3,}")


def _clean(value: Any, limit: int = 0) -> str:
    """A trimmed string, or "" for anything that means nothing."""
    if value in _EMPTY:
        return ""
    text = _MD.sub(" ", str(value)).replace("\r", " ")
    text = _WS.sub(" ", text)
    text = _BLANKS.sub("\n\n", text).strip()
    if limit and len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0] + "…"
    return text


def _first(*values: Any, limit: int = 0) -> str:
    """The first of *values* that carries anything."""
    for v in values:
        got = _clean(v, limit)
        if got:
            return got
    return ""


def _line(label: str, value: str) -> str:
    """A labelled line, or nothing. Labels are kept sparse on purpose: each one
    is repeated across every document and so dilutes the vector."""
    return f"{label}: {value}" if value else ""


def _join(*parts: str) -> str:
    return "\n".join(p for p in parts if p)


def _dedupe(*texts: str) -> List[str]:
    """Drop repeats. The analysis writes its reasoning into `reasoning`,
    `explanation` and `description`, and embedding it three times tells the
    model that sentence is three times as important as it is."""
    seen: List[str] = []
    for t in texts:
        t = _clean(t)
        if not t:
            continue
        low = t.lower()
        if any(low == s.lower() or low in s.lower() for s in seen):
            continue
        seen = [s for s in seen if s.lower() not in low]
        seen.append(t)
    return seen


def _date(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _handle(*values: Any) -> str:
    """A bare handle, no leading @, lowercased for matching."""
    raw = _first(*values)
    return raw.lstrip("@").strip().lower()


def _districts(doc: Dict[str, Any]) -> List[str]:
    d = doc.get("districts")
    return [x for x in d if x] if isinstance(d, list) else []


# --------------------------------------------------------------------------- #
# per-collection views
#
# Each returns (text, facets). `text` is embedded and shown as evidence;
# `facets` is indexed and filtered.
# --------------------------------------------------------------------------- #

def _alert(doc: Dict[str, Any]) -> tuple:
    analysis = doc.get("llm_analysis") or {}
    threat = doc.get("threat_details") or {}

    # The alert's own title restates risk level and author, both of which are
    # facets; what it adds is the intent, so that is what is kept.
    intent = _first(threat.get("intent"), analysis.get("intent"))
    reasons = _dedupe(
        _first(analysis.get("summary")),
        _first(doc.get("classification_explanation"), analysis.get("reasoning")),
        *[str(r) for r in (threat.get("reasons") or [])],
    )
    # "Risk Score: 20%" is a facet that leaked into prose.
    reasons = [r for r in reasons if not re.fullmatch(r"Risk Score:\s*\d+%?", r.strip())]

    text = _join(
        _line("Alert", intent or "risk alert"),
        _line("Author", _first(doc.get("author"), doc.get("author_handle"))),
        _join(*reasons[:3]),
        _line("Category", _first(analysis.get("category"))),
    )

    facets = {
        "kind": "alert",
        "risk_level": _first(doc.get("risk_level")).lower() or None,
        # An alert carries no top-level sentiment; it lives on the analysis it
        # was raised from. Without this, "negative alerts" matches nothing.
        "sentiment": _first(analysis.get("sentiment")).lower() or None,
        "risk_score": threat.get("risk_score") or analysis.get("score"),
        "category": _first(analysis.get("category")) or None,
        "intent": intent or None,
        "platform": _first(doc.get("platform")).lower() or None,
        "handle": _handle(doc.get("author_handle"), doc.get("author")),
        "url": _first(doc.get("content_url")) or None,
        "published_at": _date(doc.get("content_published_at") or doc.get("created_at")),
        "districts": _districts(doc),
        "alert_type": _first(doc.get("alert_type")) or None,
    }
    return text, facets


def _grievance(doc: Dict[str, Any]) -> tuple:
    content = doc.get("content") or {}
    posted_by = doc.get("posted_by") or {}
    analysis = doc.get("analysis") or {}

    body = _first(content.get("full_text"), content.get("text"), limit=2000)
    context = doc.get("context") or {}

    # A grievance often only tags the police account; the complaint itself is in
    # the post it replies to, so that text belongs in the embedding.
    replying = _first(
        (context.get("in_reply_to") or {}).get("content", {}).get("full_text"),
        (context.get("in_reply_to") or {}).get("content", {}).get("text"),
        limit=700,
    )

    text = _join(
        _line("Complaint", body),
        _line("Replying to", replying),
        _line("Summary", _first(analysis.get("summary"))),
    )

    facets = {
        "kind": "grievance",
        "sentiment": _first(analysis.get("sentiment")).lower() or None,
        "risk_level": _first(analysis.get("risk_level")).lower() or None,
        "risk_score": analysis.get("risk_score"),
        "category": _first(analysis.get("category")) or None,
        "stance": _first(analysis.get("stance")) or None,
        "platform": _first(doc.get("platform")).lower() or None,
        "handle": _handle(posted_by.get("handle")),
        "tagged": _handle(doc.get("tagged_account")),
        "url": _first(doc.get("tweet_url")) or None,
        "published_at": _date(doc.get("post_date") or doc.get("created_at")),
        "districts": _districts(doc),
        "status": _first((doc.get("grievance_workflow") or {}).get("status")) or None,
    }
    return text, facets


def _content(doc: Dict[str, Any]) -> tuple:
    text = _join(
        _line("Post", _first(doc.get("text"), doc.get("scraped_content"), limit=2000)),
        _line("Author", _first(doc.get("author"), doc.get("author_handle"))),
    )

    facets = {
        "kind": "content",
        "sentiment": _first(doc.get("sentiment")).lower() or None,
        "risk_level": _first(doc.get("risk_level")).lower() or None,
        "risk_score": doc.get("risk_score"),
        "platform": _first(doc.get("platform")).lower() or None,
        "handle": _handle(doc.get("author_handle"), doc.get("author")),
        "url": _first(doc.get("content_url")) or None,
        "published_at": _date(doc.get("published_at") or doc.get("created_at")),
        "districts": _districts(doc),
        "engagement": (doc.get("engagement") or {}).get("likes"),
    }
    return text, facets


def _generic(doc: Dict[str, Any]) -> tuple:
    """Fallback for collections with no hand-written view.

    Still far narrower than flattening everything: only fields that plausibly
    hold prose, never ids, flags or timestamps.
    """
    PROSE = (
        "title", "name", "text", "full_text", "description", "summary", "content",
        "message", "reason", "remarks", "notes", "question", "answer", "caption",
        "complaint", "details", "address", "location",
    )
    parts: List[str] = []
    for key in PROSE:
        got = _clean(doc.get(key), 1200)
        if got and got not in parts:
            parts.append(got)

    facets = {
        "kind": _first(doc.get("collection")) or None,
        "platform": _first(doc.get("platform")).lower() or None,
        "handle": _handle(doc.get("handle"), doc.get("author_handle")),
        "url": _first(doc.get("url"), doc.get("content_url"), doc.get("link")) or None,
        "published_at": _date(doc.get("created_at") or doc.get("published_at")),
        "districts": _districts(doc),
    }
    return _join(*parts), facets


VIEWS = {
    "alerts": _alert,
    "grievances": _grievance,
    "contents": _content,
}


def render(collection: str, doc: Dict[str, Any]) -> tuple:
    """(text, facets) for one document.

    `text` is what gets embedded and shown as evidence. `facets` is what gets
    indexed and filtered; values that are None are dropped so a missing field
    never masquerades as a real one.
    """
    view = VIEWS.get(collection, _generic)
    text, facets = view(doc)
    text = _clean(text)

    # The two axes the record does not carry: what the post is about, and who
    # it is about. Tagged from the curated text rather than the raw document,
    # so field names and UUIDs cannot trigger a topic.
    facets.update(vocabulary.tag(text))

    facets = {k: v for k, v in facets.items() if v not in (None, "", [])}
    facets.setdefault("kind", collection)
    return text, facets
