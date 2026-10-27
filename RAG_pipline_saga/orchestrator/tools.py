"""
tools.py — the executable side of each capability.

Every handler wraps an implementation that already exists and is already in
production use; nothing here retrieves, counts or judges in a new way:

    lookup_records          retriever.structured + retriever.count
    hybrid_search           retriever.structured/lexical + VectorStore.cosine_search, fused by retriever.fuse
    aggregate               retriever.count + analytics.breakdown/over_time via Engine._aggregate
    trend_analysis          retriever.count over two windows (compare_windows' arithmetic, against the request clock)
    classify_records        scan.run (group mode) -> judge.judge, verdicts cached in rag_verdicts
    unknown_concept_search  scan.run (concept mode): expand -> recall -> rerank -> judge
    deep_scan               scan.run(deep=True)
    location_resolve        enrichment.location (gazetteer)
    related_content_search  scan.window + enrichment.related (multi-signal RRF)
    compare_results         retriever.count per side
    situation_analysis      enrichment.situation over the outputs of the steps it depends on

SCOPE IS NOT AN ARGUMENT. `tenant_id` and `districts` come from the
ToolContext the executor builds from the PolicyResult; a handler has no way to
ask for another tenant or a wider district list. The handler registry is a
closed dict keyed by Capability — there is no registration API.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import logging
import os
from typing import Any, Callable, Dict, List, Optional

import analytics
import engine as rag_engine
import retriever
import vector_store
import scan as scan_mod
from enrichment import location as loc
from enrichment import related as related_mod
from enrichment import situation as situation_mod
from policy.models import Capability
from retriever import QuerySpec

from . import timeutil
from .models import (AggregateArgs, ClassifyArgs, CompareArgs, ConceptArgs,
                     LocationArgs, LookupArgs, RelatedArgs, SearchArgs,
                     SituationArgs, SpecArgs, TrendArgs)

C = Capability


class ToolScopeError(Exception):
    """The step would have to read outside the caller's scope. Never retried,
    never degraded around: the request stops."""


@dataclass
class ToolBackend:
    """Per-request data handles. Opened by the caller for ONE tenant."""
    collections: Dict[str, Any] = field(default_factory=dict)   # name -> Collection
    stores: Dict[str, Any] = field(default_factory=dict)        # name -> VectorStore
    embed: Optional[Callable[[str], List[float]]] = None
    generate: Optional[Callable] = None                         # judge / expander model
    db: Any = None                                              # tenant db (verdict cache)
    model: str = ""


@dataclass
class ToolContext:
    tenant_id: str
    districts: Optional[List[str]]           # execution scope; None = unrestricted
    backend: ToolBackend
    now: datetime
    cancel: threading.Event = field(default_factory=threading.Event)
    inputs: Dict[str, dict] = field(default_factory=dict)       # dependency outputs
    scope_key: str = ""
    place_districts: Optional[List[str]] = None                 # strict "about this place"

    def __post_init__(self):
        if self.place_districts:
            self.backend = ToolBackend(
                collections={n: PlaceScoped(c, self.place_districts)
                             for n, c in self.backend.collections.items()},
                stores=self.backend.stores, embed=self.backend.embed,
                generate=self.backend.generate, db=self.backend.db, model=self.backend.model)


class PlaceScoped:
    """A collection whose every query also requires the record to be TAGGED
    to one of `districts`. Added on top of — never instead of — the tenant and
    visibility clauses retriever.build_filter already applies."""

    def __init__(self, col, districts: List[str]):
        self._col = col
        self._clause = {"metadata.districts": {"$in": list(districts)}}

    def _q(self, q):
        return {"$and": [q or {}, self._clause]}

    def find(self, q=None, *a, **k):
        return self._col.find(self._q(q), *a, **k)

    def count_documents(self, q, *a, **k):
        return self._col.count_documents(self._q(q), *a, **k)

    def aggregate(self, pipeline, *a, **k):
        pipeline = list(pipeline)
        if pipeline and "$match" in pipeline[0]:
            pipeline[0] = {"$match": self._q(pipeline[0]["$match"])}
        else:
            pipeline.insert(0, {"$match": self._clause})
        return self._col.aggregate(pipeline, *a, **k)

    def __getattr__(self, name):
        return getattr(self._col, name)


logger = logging.getLogger(__name__)

def to_spec(a: SpecArgs) -> QuerySpec:
    return QuerySpec(text=a.text, kinds=list(a.kinds), sentiment=a.sentiment,
                     risk_levels=list(a.risk_levels), min_risk_score=a.min_risk_score,
                     categories=list(a.categories), stance=a.stance, topics=list(a.topics),
                     targets=list(a.targets), handles=list(a.handles), tagged=list(a.tagged),
                     platforms=list(a.platforms), since=timeutil.parse(a.since),
                     until=timeutil.parse(a.until), limit=a.limit, sort=a.sort)


def _record(hit: dict, collection: str) -> dict:
    r = scan_mod._record(hit, collection)
    r["via"] = hit.get("via")
    r["score"] = hit.get("score")
    return r


def _each(ctx: ToolContext, fn, spec: QuerySpec) -> List[dict]:
    out = []
    for name, col in ctx.backend.collections.items():
        if ctx.cancel.is_set():
            break
        for hit in fn(col, spec, ctx.tenant_id, ctx.districts):
            hit = dict(hit)
            hit["collection"] = name
            out.append(hit)
    return out


#: Smallest previous-window count a percentage may be computed from.
MIN_COMPARABLE_BASE = max(1, int(os.getenv("AI_MIN_TREND_BASE", "30")))

#: Beyond this many times the previous window, a percentage stops describing
#: activity and starts describing the corpus. 7,161 against 30 is "+23770%" —
#: the base cleared the count floor and the number is still meaningless.
#: An order of magnitude is the line: past it, the two counts are the finding.
MAX_COMPARABLE_RATIO = max(2.0, float(os.getenv("AI_MAX_TREND_RATIO", "10")))


def _count(ctx: ToolContext, spec: QuerySpec, districts="__ctx__") -> int:
    ds = ctx.districts if districts == "__ctx__" else districts
    return sum(retriever.count(col, spec, ctx.tenant_id, ds)
               for col in ctx.backend.collections.values())


def latest_in_scope(ctx: ToolContext, spec: QuerySpec) -> Optional[str]:
    """The newest record this caller could see if the period were removed.

    A windowed question over a corpus that stopped updating answers "0 matching
    records in the last 7 days", which is true and reads as a broken assistant.
    Knowing the newest record is from four weeks ago turns the same answer into
    one the officer can act on — the data is stale, not the question wrong.

    Returns an ISO date string, or None when the scope is genuinely empty.
    """
    undated = QuerySpec(**{**spec.__dict__, "since": None, "until": None})
    newest = None
    for col in ctx.backend.collections.values():
        try:
            doc = col.find_one(
                retriever.build_filter(undated, ctx.tenant_id, ctx.districts),
                projection={"metadata.published_at": 1, "_id": 0},
                sort=[("metadata.published_at", -1)])
        except Exception as exc:                                  # noqa: BLE001
            logger.debug("latest-in-scope probe failed on %s: %s",
                         getattr(col, "name", "?"), exc)
            continue
        found = ((doc or {}).get("metadata") or {}).get("published_at")
        if found and (newest is None or found > newest):
            newest = found
    if newest is None:
        return None
    return newest.isoformat() if hasattr(newest, "isoformat") else str(newest)


def _fused_records(hits: List[dict], limit: int) -> List[dict]:
    fused = retriever.fuse(hits, limit=limit) if hits else []
    return [_record(h, h.get("collection", "")) for h in fused]


# --------------------------------------------------------------------------- #
# handlers
# --------------------------------------------------------------------------- #

def lookup_records(a: LookupArgs, ctx: ToolContext) -> dict:
    spec = to_spec(a.spec)
    if not spec.is_filtered():
        # An unfiltered "lookup" is a search, not a list of everything.
        return {"records": [], "total": None, "note": "no filters to look up by"}
    hits = _each(ctx, retriever.structured, spec)
    records = _fused_records(hits, spec.limit)
    return {"records": records, "total": _count(ctx, spec)}


def hybrid_search(a: SearchArgs, ctx: ToolContext) -> dict:
    # Sub-stage timings ride back on the result. Without them a 35-second
    # search was one opaque number and every explanation for it was a guess.
    timing: Dict[str, float] = {}
    spec = to_spec(a.spec)
    _t = time.perf_counter()
    structured = _each(ctx, retriever.structured, spec)
    timing["structured_ms"] = round((time.perf_counter() - _t) * 1000, 1)
    _t = time.perf_counter()
    lexical = _each(ctx, retriever.lexical, spec)
    timing["lexical_ms"] = round((time.perf_counter() - _t) * 1000, 1)
    semantic: List[dict] = []
    _t = time.perf_counter()
    b = ctx.backend
    if a.semantic and b.embed and b.stores and spec.text.strip() and not ctx.cancel.is_set():
        try:
            vec = b.embed(spec.text)
        except Exception:
            vec = None
        for name, store in (b.stores.items() if vec else []):
            try:
                for h in store.cosine_search(query_vector=vec, top_k=max(4, spec.limit // 2),
                                             query_text=spec.text, tenant_id=ctx.tenant_id,
                                             districts=ctx.districts):
                    h = dict(h)
                    h["via"], h["collection"] = "semantic", name
                    semantic.append(h)
            except Exception:
                continue
        semantic.sort(key=lambda h: h.get("score", 0.0), reverse=True)
        semantic = semantic[:retriever.SEMANTIC_POOL]
    timing["vector_ms"] = round((time.perf_counter() - _t) * 1000, 1)
    _t = time.perf_counter()
    fused = retriever.fuse(structured, lexical, semantic,
                           limit=min(max(spec.limit, 10), rag_engine.MAX_EVIDENCE))
    records = [_record(h, h.get("collection", "")) for h in fused]
    timing["fusion_ms"] = round((time.perf_counter() - _t) * 1000, 1)
    _t = time.perf_counter()
    total = _count(ctx, spec) if spec.is_filtered() else None
    timing["count_ms"] = round((time.perf_counter() - _t) * 1000, 1)
    out_latest = (latest_in_scope(ctx, spec)
                  if total == 0 and (spec.since or spec.until) else None)
    return {"records": records, "total": total, "latest_available": out_latest,
            "counts": {"structured": len(structured), "lexical": len(lexical),
                       "semantic": len(semantic), **timing,
                       # Which retrieval strategy actually served this: the
                       # index, or a degraded local scan.
                       "vector_strategy": vector_store.search_strategy_report()}}


def aggregate(a: AggregateArgs, ctx: ToolContext) -> dict:
    spec = to_spec(a.spec)
    eng = rag_engine.Engine(ctx.backend.collections, ctx.tenant_id, ctx.districts)
    breakdowns: Dict[str, List[dict]] = {}
    for by in a.group_by:
        if by == "published_at":
            breakdowns[by] = eng._aggregate(analytics.over_time, spec, ctx.tenant_id,
                                            ctx.districts, "day")
        elif by in analytics.GROUPABLE:
            breakdowns[by] = eng._aggregate(analytics.breakdown, spec, ctx.tenant_id,
                                            ctx.districts, by)
    total = _count(ctx, spec) if a.total else None
    out = {"total": total, "breakdowns": breakdowns, "group_by": list(a.group_by)}
    # Nothing in the period, but the scope is not empty: name the newest record
    # so "0 matching records" is read as stale data rather than a broken answer.
    if total == 0 and (spec.since or spec.until):
        out["latest_available"] = latest_in_scope(ctx, spec)
    return out


def trend_analysis(a: TrendArgs, ctx: ToolContext) -> dict:
    spec = to_spec(a.spec)
    w = timedelta(days=a.window_days)
    now = ctx.now

    def window(since, until):
        return _count(ctx, QuerySpec(**{**spec.__dict__, "since": since, "until": until}))
    current, previous = window(now - w, now), window(now - 2 * w, now - w)
    # A change from zero is undefined, not +100% (analytics.compare_windows' rule).
    change = round((current - previous) / previous * 100, 1) if previous else None
    series_spec = QuerySpec(**{**spec.__dict__, "since": now - 2 * w, "until": now})
    eng = rag_engine.Engine(ctx.backend.collections, ctx.tenant_id, ctx.districts)
    series = eng._aggregate(analytics.over_time, series_spec, ctx.tenant_id, ctx.districts,
                            a.bucket)
    out_latest = (latest_in_scope(ctx, spec)
                  if current == 0 and previous == 0 else None)
    # A percentage needs a base worth dividing by. 6,522 against 24 is
    # "+27075%", which is arithmetically correct and reads as a broken gauge —
    # and on a corpus that started mid-window it says nothing about activity.
    # Below the floor the counts are reported and the percentage withheld.
    comparable = (previous >= MIN_COMPARABLE_BASE
                  and current <= previous * MAX_COMPARABLE_RATIO)
    return {"current": current, "previous": previous, "change_pct": change,
            "comparable": comparable, "latest_available": out_latest,
            "direction": "up" if current > previous else "down" if current < previous else "flat",
            "days": a.window_days, "series": series,
            "current_window": [timeutil.iso(now - w), timeutil.iso(now)],
            "previous_window": [timeutil.iso(now - 2 * w), timeutil.iso(now - w)]}


class _LinkedJob(scan_mod.ScanJob):
    """A ScanJob whose `cancelled` flag IS the step's cancel event, so a
    timeout or a plan-wide stop reaches the scan's own checkpoints without a
    watcher thread per job."""

    def __init__(self, event: threading.Event, *args):
        self._event = event
        super().__init__(*args)

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    @cancelled.setter
    def cancelled(self, value: bool) -> None:
        if value:
            self._event.set()


def _scan(ctx: ToolContext, spec: SpecArgs, labels: List[str], question: str,
          mode: str, deep: bool) -> dict:
    b = ctx.backend
    job = _LinkedJob(ctx.cancel, question, ctx.tenant_id, ctx.scope_key, mode, labels, deep)
    scan_mod.run(job, collections=b.collections, stores=b.stores, tenant_id=ctx.tenant_id,
                 districts=ctx.districts, db=b.db, embed=b.embed, generate=b.generate,
                 model=b.model, spec=to_spec(spec))
    snap = job.snapshot()
    return {"matches": snap.get("matches", []), "counts": snap.get("counts", {}),
            "window_total": snap.get("window_total", 0), "checked": snap.get("checked", 0),
            "pool": snap.get("pool", 0), "verified": snap.get("verified", True),
            "note": snap.get("note", ""), "labels": labels, "deep": deep,
            "reranked": snap.get("reranked", False), "mode": mode}


def classify_records(a: ClassifyArgs, ctx: ToolContext) -> dict:
    return _scan(ctx, a.spec, list(a.labels), a.question, "group", a.deep)


def unknown_concept_search(a: ConceptArgs, ctx: ToolContext) -> dict:
    return _scan(ctx, a.spec, [a.label], a.question, "concept", False)


def deep_scan(a: ClassifyArgs, ctx: ToolContext) -> dict:
    return _scan(ctx, a.spec, list(a.labels), a.question, "concept", True)


def location_resolve(a: LocationArgs, ctx: ToolContext) -> dict:
    r = loc.resolve(a.text)
    out = {"status": r.status, "query": a.text, "confidence": r.confidence,
           "method": r.method, "assumption": r.assumption,
           "place": r.place.model_dump() if r.place else None,
           "candidates": [c.name for c in r.candidates],
           "gazetteer_version": r.gazetteer_version}
    if r.status == "resolved" and r.place.districts and r.place.type not in ("state", "country"):
        within = loc.intersect(list(r.place.districts), ctx.districts)
        if ctx.districts is not None and not within:
            raise ToolScopeError(f"'{r.place.name}' is outside the caller's districts")
        out["districts"] = within
    return out


def related_content_search(a: RelatedArgs, ctx: ToolContext) -> dict:
    seeds = [r for out in ctx.inputs.values() for r in out.get("records", [])][:10]
    if not seeds:
        return {"records": [], "note": "no seed records"}
    spec = to_spec(a.spec)
    window_spec = QuerySpec(**{**spec.__dict__, "text": "", "topics": [], "targets": []})
    candidates, _ = scan_mod.window(ctx.backend.collections, window_spec, ctx.tenant_id,
                                    ctx.districts, 500)
    ranked = related_mod.score(seeds, candidates, embed=ctx.backend.embed,
                               stores=ctx.backend.stores, top_k=a.top_k)
    return {"records": ranked, "seeds": [s["key"] for s in seeds]}


def compare_results(a: CompareArgs, ctx: ToolContext) -> dict:
    spec = to_spec(a.spec)
    sides = []
    for side in a.sides:
        cols = ctx.backend.collections
        ds = None
        if side.districts is not None:
            ds = loc.intersect(list(side.districts), ctx.districts)
            if ctx.districts is not None and not ds:
                raise ToolScopeError(f"'{side.label}' is outside the caller's districts")
            # A side is ITS place: tenant-wide (untagged) records belong to no
            # side, or both sides would count them.
            cols = {n: PlaceScoped(c, ds) for n, c in cols.items()}
        s = QuerySpec(**{**spec.__dict__,
                         "since": timeutil.parse(side.since) or spec.since,
                         "until": timeutil.parse(side.until) or spec.until})
        n = sum(retriever.count(c, s, ctx.tenant_id, ctx.districts) for c in cols.values())
        sides.append({"label": side.label, "count": n, "districts": ds,
                      "since": side.since, "until": side.until})
    a0, a1 = sides[0]["count"], sides[1]["count"]
    return {"sides": sides, "difference": a0 - a1,
            "change_pct": round((a0 - a1) / a1 * 100, 1) if a1 else None}


def situation_analysis(a: SituationArgs, ctx: ToolContext) -> dict:
    by_schema: Dict[str, dict] = {}
    for sid, out in ctx.inputs.items():
        by_schema[out.get("_schema", sid)] = out
    search = by_schema.get("records", {})
    agg = by_schema.get("aggregate", {})
    trend = by_schema.get("trend")
    related = by_schema.get("related", {}).get("records", [])
    return situation_mod.build(a.subject, records=search.get("records", []),
                               total=agg.get("total", search.get("total")),
                               breakdowns=agg.get("breakdowns", {}), trend=trend,
                               related=related, window_days=a.window_days,
                               latest_available=(agg.get("latest_available")
                                                 or (trend or {}).get("latest_available")))


HANDLERS: Dict[Capability, tuple] = {
    C.LOOKUP_RECORDS: (lookup_records, LookupArgs),
    C.HYBRID_SEARCH: (hybrid_search, SearchArgs),
    C.AGGREGATE: (aggregate, AggregateArgs),
    C.TREND_ANALYSIS: (trend_analysis, TrendArgs),
    C.CLASSIFY_RECORDS: (classify_records, ClassifyArgs),
    C.UNKNOWN_CONCEPT_SEARCH: (unknown_concept_search, ConceptArgs),
    C.DEEP_SCAN: (deep_scan, ClassifyArgs),
    C.LOCATION_RESOLVE: (location_resolve, LocationArgs),
    C.RELATED_CONTENT_SEARCH: (related_content_search, RelatedArgs),
    C.COMPARE_RESULTS: (compare_results, CompareArgs),
    C.SITUATION_ANALYSIS: (situation_analysis, SituationArgs),
}

# Per-tool time budgets (seconds). Scans judge with the LLM; everything else
# is database work and should be quick.
#
# Semantic search is the exception: without Atlas Vector Search (and with
# $function rejected by this tier) it falls back to pulling candidate vectors
# and scoring them locally, which costs ~9s warm and more on the first query of
# a process, while the embedder warms. 30s made a cold first query fail.
TIMEOUTS: Dict[Capability, float] = {
    C.HYBRID_SEARCH: 90.0,
    C.CLASSIFY_RECORDS: 180.0, C.UNKNOWN_CONCEPT_SEARCH: 180.0, C.DEEP_SCAN: 900.0,
}
DEFAULT_TIMEOUT = 30.0
