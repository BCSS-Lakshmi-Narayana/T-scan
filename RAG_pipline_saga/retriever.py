"""
retriever.py — three ways of finding records, and one way of merging them.

The old path embedded the question, took the top 4 cosine hits per collection,
and asked the model to summarise them. That fails the questions this product
actually gets, in two different ways:

  "the highest risk alerts"        -> a filter with an exact answer (23 rows).
                                      Cosine returns 4 arbitrary ones and the
                                      model reports them as if they were all.
  "posts tagging @TelanganaDGP"    -> a string match. Embeddings are the wrong
                                      tool for an exact token; a handle that
                                      never appears will still return its four
                                      nearest neighbours.

So retrieval is three retrievers over one index:

  STRUCTURED  facets in MongoDB      exact, complete, ordered      the spine
  LEXICAL     MongoDB text index     exact tokens, rare words      precision
  SEMANTIC    cosine over vectors    paraphrase, unnamed topics    recall

They run against the same ``vector_embeddings_*`` collections, which already
hold the curated text, the facets and the embedding together, inside the
tenant's own database. One store, three ways in, no second copy to drift.

Results merge with Reciprocal Rank Fusion: the three score on scales that
cannot be compared (a count, a text score, a cosine), so only their RANKS are
used. Nothing here decides what the user is allowed to see -- tenant and
district filters arrive from the caller and are applied to every retriever.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)

# Standard RRF constant: damps the advantage of the very top positions so one
# retriever cannot dominate the merge.
RRF_K = int(os.getenv("RRF_K", "60"))

# How many each retriever returns before fusion. Generous, because fusion and
# the final limit do the narrowing, and a row the spine never returned cannot
# be recovered later.
STRUCTURED_POOL = int(os.getenv("RAG_STRUCTURED_POOL", "120"))
LEXICAL_POOL = int(os.getenv("RAG_LEXICAL_POOL", "60"))
SEMANTIC_POOL = int(os.getenv("RAG_SEMANTIC_POOL", "60"))


@dataclass
class QuerySpec:
    """What the user asked for, as something a database can answer.

    Every field is optional: an absent field means "no constraint", never a
    default guess. In particular ``since`` is None for "all time" -- the old
    pipeline defaulted to 7 days, so a question with no date silently excluded
    everything older than a week and looked simply wrong.
    """
    text: str = ""                                  # the question, for lexical + semantic
    terms: List[str] = field(default_factory=list)  # quoted phrases, rare words
    kinds: List[str] = field(default_factory=list)  # alert | grievance | content
    sentiment: Optional[str] = None
    risk_levels: List[str] = field(default_factory=list)
    min_risk_score: Optional[int] = None
    categories: List[str] = field(default_factory=list)
    stance: Optional[str] = None
    topics: List[str] = field(default_factory=list)   # populated once views tag them
    targets: List[str] = field(default_factory=list)  # who the post is about
    handles: List[str] = field(default_factory=list)  # author
    tagged: List[str] = field(default_factory=list)   # mentioned / tagged
    platforms: List[str] = field(default_factory=list)
    since: Optional[datetime] = None
    until: Optional[datetime] = None
    limit: int = 15
    sort: str = "relevance"                         # relevance | risk | recent

    def is_filtered(self) -> bool:
        """True when anything narrows the set beyond the tenant boundary."""
        return any((
            self.kinds, self.sentiment, self.risk_levels, self.categories,
            self.stance, self.topics, self.targets, self.handles, self.tagged,
            self.platforms, self.since, self.until,
            self.min_risk_score is not None,
        ))


# --------------------------------------------------------------------------- #
# structured
# --------------------------------------------------------------------------- #

def build_filter(spec: QuerySpec, tenant_id: str, districts: Optional[List[str]]) -> dict:
    """The Mongo filter for one spec, inside one tenant and district scope.

    The tenant clause is unconditional. The district clause follows the same
    convention as everywhere else: None is unrestricted (State Admin), [] is an
    officer with zero districts and must match nothing.
    """
    q: Dict[str, Any] = {"metadata.tenant_id": tenant_id}

    if districts is not None:
        if not districts:
            q["metadata.districts"] = {"$in": []}
        else:
            q.setdefault("$and", []).append({"$or": [
                {"metadata.districts": {"$in": districts}},
                {"metadata.districts": {"$exists": False}},
                {"metadata.districts": {"$size": 0}},
            ]})

    def any_of(path: str, values: Iterable[str], lower: bool = True):
        vals = [str(v).lower() if lower else str(v) for v in values if v]
        if vals:
            q[path] = {"$in": vals}

    any_of("metadata.kind", spec.kinds)
    any_of("metadata.risk_level", spec.risk_levels)
    any_of("metadata.platform", spec.platforms)
    any_of("metadata.category", spec.categories, lower=False)
    any_of("metadata.topics", spec.topics)
    any_of("metadata.targets", spec.targets)
    any_of("metadata.handle", [h.lstrip("@") for h in spec.handles])
    any_of("metadata.tagged", [h.lstrip("@") for h in spec.tagged])

    if spec.sentiment:
        q["metadata.sentiment"] = spec.sentiment.lower()
    if spec.stance:
        q["metadata.stance"] = spec.stance
    if spec.min_risk_score is not None:
        q["metadata.risk_score"] = {"$gte": spec.min_risk_score}

    if spec.since or spec.until:
        window: Dict[str, Any] = {}
        if spec.since:
            window["$gte"] = spec.since
        if spec.until:
            window["$lte"] = spec.until
        q["metadata.published_at"] = window

    return q


def _sort_key(spec: QuerySpec) -> List[tuple]:
    if spec.sort == "risk":
        return [("metadata.risk_score", -1), ("metadata.published_at", -1)]
    return [("metadata.published_at", -1)]


def structured(col, spec: QuerySpec, tenant_id: str,
               districts: Optional[List[str]]) -> List[dict]:
    """Exact matches for the filterable part of the question.

    This is the retriever that can answer "all 23 high-risk alerts" rather than
    four of them, and the only one whose result count means anything.
    """
    if not spec.is_filtered():
        return []
    q = build_filter(spec, tenant_id, districts)
    try:
        cur = (col.find(q, {"text": 1, "metadata": 1, "_id": 0})
                  .sort(_sort_key(spec))
                  .limit(STRUCTURED_POOL))
        return [{"text": d.get("text", ""), "metadata": d.get("metadata", {}),
                 "via": "structured"} for d in cur]
    except Exception as exc:
        logger.warning("structured retrieval failed: %s", exc)
        return []


def count(col, spec: QuerySpec, tenant_id: str,
          districts: Optional[List[str]]) -> int:
    """How many records match, ignoring the result limit.

    A count must come from the database. Counting retrieved rows answers a
    different question and reads as authoritative because it is a number.

    Counts distinct source documents, not chunk rows: one post split into
    three chunks is one record, and counting rows reports it as three.
    """
    rows = list(col.aggregate([
        {"$match": build_filter(spec, tenant_id, districts)},
        {"$group": {"_id": "$metadata.document_id"}},
        {"$count": "n"},
    ]))
    return rows[0]["n"] if rows else 0


# --------------------------------------------------------------------------- #
# lexical
# --------------------------------------------------------------------------- #

_STOP = {
    "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "is",
    "are", "was", "were", "be", "been", "what", "which", "who", "whom", "show",
    "me", "give", "list", "find", "any", "all", "posts", "post", "about",
    "there", "their", "with", "from", "that", "this", "these", "those", "have",
    "has", "how", "many", "much", "please", "can", "you",
}


def keywords(question: str) -> List[str]:
    """Content words worth matching exactly: quoted phrases, @handles, #tags,
    and anything else long enough not to be noise."""
    out: List[str] = []
    for phrase in re.findall(r'"([^"]{2,60})"', question):
        out.append(phrase.strip())
    for tok in re.findall(r"[@#][\w.]{2,30}", question):
        out.append(tok)
    for word in re.findall(r"[A-Za-z][\w'-]{2,}", question):
        if word.lower() not in _STOP:
            out.append(word)
    seen, uniq = set(), []
    for t in out:
        k = t.lower()
        if k not in seen:
            seen.add(k)
            uniq.append(t)
    return uniq[:12]


def lexical(col, spec: QuerySpec, tenant_id: str,
            districts: Optional[List[str]]) -> List[dict]:
    """Exact-token matching, for handles, names and rare words.

    Needs a text index on `text`; without one this returns nothing rather than
    falling back to a collection scan on every question.
    """
    terms = spec.terms or keywords(spec.text)
    if not terms:
        return []

    base = build_filter(QuerySpec(
        kinds=spec.kinds, platforms=spec.platforms,
        since=spec.since, until=spec.until,
    ), tenant_id, districts)
    base["$text"] = {"$search": " ".join(terms)}

    try:
        cur = (col.find(base, {"text": 1, "metadata": 1, "_id": 0,
                               "score": {"$meta": "textScore"}})
                  .sort([("score", {"$meta": "textScore"})])
                  .limit(LEXICAL_POOL))
        return [{"text": d.get("text", ""), "metadata": d.get("metadata", {}),
                 "via": "lexical"} for d in cur]
    except Exception as exc:
        # Missing text index is the usual cause, and it is recoverable: the
        # other two retrievers still answer.
        logger.info("lexical retrieval unavailable: %s", exc)
        return []


# --------------------------------------------------------------------------- #
# fusion
# --------------------------------------------------------------------------- #

def _identity(hit: dict) -> str:
    """What makes two hits the same record across retrievers."""
    meta = hit.get("metadata") or {}
    return str(meta.get("chunk_id") or meta.get("document_id") or hit.get("text", "")[:120])


def fuse(*lists: List[dict], limit: int = 15) -> List[dict]:
    """Reciprocal Rank Fusion.

    The retrievers score on scales that cannot be compared -- a text score, a
    cosine, a sort position -- so only rank is used:

        RRF(d) = sum over lists of 1 / (K + rank(d))

    A record found by more than one retriever rises, which is what we want:
    agreement between an exact filter and a semantic match is the strongest
    signal available here.
    """
    scores: Dict[str, float] = {}
    best: Dict[str, dict] = {}
    found_by: Dict[str, set] = {}

    for hits in lists:
        for rank, hit in enumerate(hits):
            key = _identity(hit)
            scores[key] = scores.get(key, 0.0) + 1.0 / (RRF_K + rank + 1)
            found_by.setdefault(key, set()).add(hit.get("via", "?"))
            if key not in best:
                best[key] = hit

    ordered = sorted(scores, key=lambda k: scores[k], reverse=True)
    out = []
    for key in ordered[:limit]:
        hit = dict(best[key])
        hit["score"] = round(scores[key], 6)
        hit["via"] = "+".join(sorted(found_by[key]))
        out.append(hit)
    return out


def evidence(hits: List[dict]) -> List[dict]:
    """Flatten hits into the rows an answer cites.

    Every row carries its link, because an answer in this product is something
    an officer may act on and the path from a claim to its record has to be one
    click.
    """
    rows = []
    for hit in hits:
        m = hit.get("metadata") or {}
        published = m.get("published_at")
        rows.append({
            "text": hit.get("text", ""),
            "kind": m.get("kind"),
            "handle": m.get("handle"),
            "platform": m.get("platform"),
            "url": m.get("url"),
            "published_at": published.isoformat() if isinstance(published, datetime) else published,
            "risk_level": m.get("risk_level"),
            "risk_score": m.get("risk_score"),
            "sentiment": m.get("sentiment"),
            "category": m.get("category"),
            "districts": m.get("districts") or [],
            "matched_by": hit.get("via"),
        })
    return rows
