"""
engine.py — one question in, a grounded list of records out.

    plan -> retrieve (3 in parallel) -> fuse -> assemble -> write

What this replaces: embed the question, take the top 4 cosine hits per
collection, ask the model to summarise. That could not answer "the highest risk
alerts" (it saw 4 of 23 and reported them as all of them) and could not answer
"at least 10 posts" at all.

Division of labour, kept strict:

  the DATABASE decides WHICH records      - filters and counts are exact
  the MODEL decides HOW TO SAY IT         - over rows it is handed, never
                                            retrieving, never counting

A count therefore comes from count_documents, not from len(retrieved). An
answer says "23 alerts" because there are 23, not because 23 chunks came back.

Nothing here decides what a caller may see. tenant_id and districts arrive
from the proxy and are applied inside every retriever.
"""

from __future__ import annotations

import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional

import analytics
import llm_planner
import planner
import retriever
import vocabulary
from retriever import QuerySpec

logger = logging.getLogger(__name__)

# Rows handed to the model. Enough to answer "at least 10" with room to spare,
# bounded so the prompt stays inside the context window.
MAX_EVIDENCE = int(os.getenv("RAG_MAX_EVIDENCE", "25"))

# Per-row text budget. Whole posts are rarely needed to judge relevance, and
# 25 untrimmed posts will not fit.
ROW_CHARS = int(os.getenv("RAG_ROW_CHARS", "600"))

_TOPIC_MAP = vocabulary.query_topic_map()
_TARGET_MAP = vocabulary.query_target_map()


class Engine:
    """Retrieval for one tenant and district scope.

    Built per request: the scope is part of every query, so an Engine is not
    shareable between callers.
    """

    def __init__(self, stores: Dict[str, Any], tenant_id: str,
                 districts: Optional[List[str]] = None):
        # collection name -> pymongo Collection of its vector chunks
        self.stores = stores
        self.tenant_id = tenant_id
        self.districts = districts

    # -- retrieval ---------------------------------------------------------- #

    def _across_stores(self, fn: Callable, spec: QuerySpec) -> List[dict]:
        """Run one retriever over every collection, concurrently.

        These are IO-bound Mongo round trips, so they overlap; with a dozen
        collections that is the difference between 40ms and half a second.
        """
        if not self.stores:
            return []
        with ThreadPoolExecutor(max_workers=min(8, len(self.stores))) as pool:
            futures = [pool.submit(fn, col, spec, self.tenant_id, self.districts)
                       for col in self.stores.values()]
            out: List[dict] = []
            for f in futures:
                try:
                    out.extend(f.result())
                except Exception as exc:
                    logger.warning("retriever failed on one collection: %s", exc)
        return out

    def _semantic(self, spec: QuerySpec, embed: Callable) -> List[dict]:
        """Cosine hits, for phrasing no field captures.

        Skipped when the question is fully expressed as filters: for "high risk
        alerts on facebook" the structured result is already exact, and semantic
        hits can only add near-misses.
        """
        if not embed or not spec.text.strip():
            return []
        try:
            vector = embed(spec.text)
        except Exception as exc:
            logger.warning("query embedding failed: %s", exc)
            return []
        if not vector:
            return []

        hits: List[dict] = []
        for store in self.stores.values():
            try:
                found = store.cosine_search(
                    query_vector=vector,
                    top_k=max(4, spec.limit // 2),
                    query_text=spec.text,
                    tenant_id=self.tenant_id,
                    districts=self.districts,
                ) if hasattr(store, "cosine_search") else []
                for h in found:
                    h["via"] = "semantic"
                hits.extend(found)
            except Exception as exc:
                logger.warning("semantic retrieval failed: %s", exc)
        hits.sort(key=lambda h: h.get("score", 0.0), reverse=True)
        return hits[:retriever.SEMANTIC_POOL]

    # -- the whole path ----------------------------------------------------- #

    def _aggregate(self, fn, *args, **kwargs) -> List[dict]:
        """Run an aggregation across every collection and merge the buckets.

        Each collection aggregates separately, so the same handle appearing in
        alerts and in contents arrives as two rows; they are summed here, or the
        top-N would be computed per collection and be wrong.
        """
        merged: Dict[Any, int] = {}
        for col in self.stores.values():
            try:
                for row in fn(col, *args, **kwargs):
                    key = row.get("value", row.get("bucket"))
                    merged[key] = merged.get(key, 0) + row["count"]
            except Exception as exc:
                logger.warning("aggregation failed on one collection: %s", exc)
        key_name = "bucket" if fn is analytics.over_time else "value"
        rows = [{key_name: k, "count": v} for k, v in merged.items()]
        rows.sort(key=lambda r: (r["count"], str(r[key_name])),
                  reverse=key_name == "value")
        return rows

    def answer(self, question: str, embed: Callable = None,
               vector_stores: Dict[str, Any] = None,
               generate: Callable = None) -> dict:
        """Plan, retrieve, and return the evidence an answer will be written from.

        Three shapes of question, routed differently because they have different
        correct answers:

          records    -> retrieve and rank
          breakdown  -> $group; "which handles post the most" is not a list
          trend      -> two counts and a difference, not a vibe from 15 rows

        Returns the rows plus what was applied to find them, so the caller can
        say which constraints produced the result. A filtered answer read as an
        unfiltered one is how an officer concludes something does not exist when
        it was merely excluded.
        """
        t0 = time.time()
        # Rules first (0ms); the model only sees questions they underconstrain.
        spec = llm_planner.plan(question, generate=generate,
                                topic_map=_TOPIC_MAP, target_map=_TARGET_MAP)

        # Counts are answered by the database. Counting retrieved rows answers a
        # different question, and reads as authoritative because it is a number.
        total: Optional[int] = None
        if planner.is_count_question(question) and spec.is_filtered():
            total = 0
            for col in self.stores.values():
                try:
                    total += retriever.count(col, spec, self.tenant_id, self.districts)
                except Exception as exc:
                    logger.warning("count failed on one collection: %s", exc)

        structured_hits = self._across_stores(retriever.structured, spec)
        lexical_hits = self._across_stores(retriever.lexical, spec)

        semantic_hits: List[dict] = []
        if vector_stores is not None:
            self_stores_backup = self.stores
            self.stores = vector_stores
            semantic_hits = self._semantic(spec, embed)
            self.stores = self_stores_backup
        elif embed:
            semantic_hits = self._semantic(spec, embed)

        fused = retriever.fuse(
            structured_hits, lexical_hits, semantic_hits,
            limit=min(max(spec.limit, 10), MAX_EVIDENCE),
        )
        rows = retriever.evidence(fused)
        for row in rows:
            if row.get("text") and len(row["text"]) > ROW_CHARS:
                row["text"] = row["text"][:ROW_CHARS].rsplit(" ", 1)[0] + "…"

        # ── analysis, alongside the records ──────────────────────────────────
        # These are computed from the database, never from `rows`. A model
        # handed fifteen records will report fifteen when the answer is four
        # hundred, and it will sound certain doing it.
        breakdown_by = planner.wants_breakdown(question)
        breakdown_rows = (self._aggregate(analytics.breakdown, spec, self.tenant_id,
                                          self.districts, breakdown_by)
                          if breakdown_by else [])

        trend = None
        if planner.wants_trend(question):
            trend = {"current": 0, "previous": 0, "change_pct": None, "direction": "flat", "days": 30}
            for col in self.stores.values():
                try:
                    got = analytics.compare_windows(col, spec, self.tenant_id, self.districts)
                    trend["current"] += got["current"]
                    trend["previous"] += got["previous"]
                except Exception as exc:
                    logger.warning("trend failed on one collection: %s", exc)
            prev = trend["previous"]
            trend["change_pct"] = (round((trend["current"] - prev) / prev * 100, 1)
                                   if prev else None)
            trend["direction"] = ("up" if trend["current"] > prev else
                                  "down" if trend["current"] < prev else "flat")

        return {
            "spec": spec,
            "rows": rows,
            "total": total,
            "breakdown": breakdown_rows,
            "breakdown_by": breakdown_by,
            "trend": trend,
            "applied": planner.describe(spec),
            "counts": {
                "structured": len(structured_hits),
                "lexical": len(lexical_hits),
                "semantic": len(semantic_hits),
                "returned": len(rows),
            },
            "took_ms": int((time.time() - t0) * 1000),
        }


# --------------------------------------------------------------------------- #
# prompting
# --------------------------------------------------------------------------- #

SYSTEM = """\
You are the AI Assistant, an intelligence assistant for the Telangana Police.

You are given RECORDS retrieved from the force's own database. Answer ONLY from
them.

HOW TO ANSWER
  1. One line stating what was found, with the number.
  2. Then the records, numbered, most important first. For each:
       - the handle, the platform and the date
       - one sentence on what it says
       - its link, as [View Post](url)
  3. Nothing else. No preamble, no methodology, no closing summary.

RULES
  - Every handle, link, number and claim must come from the RECORDS. Never
    invent one, never complete a partial URL, never guess a handle.
  - Use the count given in FOUND when one is present; it is the true total.
    Do not recount the records shown or describe them as all of them.
  - If the records are empty, say so in one line and stop. Do not substitute
    general knowledge, do not speculate about what the data might hold, and do
    not pad the answer to look fuller. A short true answer is correct.
  - Do not claim a pattern across fewer than three records.
  - Do not assess whether something is lawful, and do not recommend action
    against a named person.
"""


def _analysis_block(result: dict) -> str:
    """Figures computed by the database, for the model to report verbatim.

    Given separately from the records so there is no temptation to derive them:
    every number here is exact, and none of them can be recovered by counting
    the fifteen rows shown.
    """
    parts = []

    rows = result.get("breakdown") or []
    if rows:
        top = ", ".join(f"{r['value']} ({r['count']})" for r in rows[:10])
        parts.append(f"BREAKDOWN by {result.get('breakdown_by')}: {top}")

    trend = result.get("trend")
    if trend:
        prev, cur = trend["previous"], trend["current"]
        pct = f", {trend['change_pct']:+}%" if trend.get("change_pct") is not None else ""
        parts.append(
            f"TREND (last {trend['days']}d vs the {trend['days']}d before): "
            f"{cur} vs {prev}{pct} — {trend['direction']}")

    return "\n".join(parts)


def build_prompt(question: str, result: dict) -> str:
    """The model sees the rows, the computed figures and the applied filters."""
    rows = result["rows"]
    analysis = _analysis_block(result)

    if not rows and not analysis:
        return (f"{SYSTEM}\nRECORDS: none\n\nFILTERS: {result['applied']}\n\n"
                f"QUESTION: {question}\n\nANSWER:")

    # A breakdown or a trend IS the answer; the records are only illustration.
    if analysis and not rows:
        return (f"{SYSTEM}\n{analysis}\n\nFILTERS APPLIED: {result['applied']}\n\n"
                f"QUESTION: {question}\n\nANSWER:")

    lines = []
    for i, r in enumerate(rows, 1):
        head = " · ".join(str(x) for x in (
            f"@{r['handle']}" if r.get("handle") else None,
            r.get("platform"),
            (r.get("published_at") or "")[:10] or None,
            f"risk {r['risk_score']}" if r.get("risk_score") is not None else None,
            r.get("sentiment"),
        ) if x)
        lines.append(f"[{i}] {head}\n{r.get('text', '')}\nURL: {r.get('url') or 'none'}")

    found = (f"FOUND: {result['total']} matching records in the database"
             if result.get("total") is not None
             else f"FOUND: {len(rows)} records retrieved")

    head = f"{SYSTEM}\n{found}\n"
    if analysis:
        head += analysis + "\n"

    return (f"{head}FILTERS APPLIED: {result['applied']}\n\n"
            f"RECORDS\n" + "\n\n".join(lines) +
            f"\n\nQUESTION: {question}\n\nANSWER:")
