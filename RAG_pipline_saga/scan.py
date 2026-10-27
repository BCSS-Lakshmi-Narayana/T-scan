"""
scan.py — answering a question about a concept nobody tagged.

"Show me communal content from the last 7 days." No post carries a communal
tag, and no tag list can anticipate every concept an officer names. So the
concept is judged on demand, through a funnel that spends each tool where it
is strongest:

    1. FILTER   the database narrows to the window, tenant and districts   exact, ~10ms
    2. RECALL   expanded terms + vector similarity rank the window          ~100ms
    3. RERANK   a cross-encoder reads question + post, keeps the best       ~1s
    4. JUDGE    the LLM decides match / no-match per record, with a reason  seconds, streamed
    5. REMEMBER verdicts are cached; the next ask is instant

It runs as a background job the frontend polls, so the first confirmed cards
appear while the rest are still being judged.

Two modes:
    concept  "communal content last 7 days"           one label, a ranked list
    group    "which are communal and which are
              international, national, local"         several labels, counts + lists

A deep scan skips the recall cut and judges every record in the window, for
when "the 60 most likely" is not good enough.

Nothing here widens scope: the window query carries the tenant and district
clauses from retriever.build_filter, and every later step only narrows it.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

import concepts
import expander
import judge as judge_mod
import planner
import reranker
import retriever
from retriever import QuerySpec

logger = logging.getLogger(__name__)

WINDOW_MAX = int(os.getenv("SCAN_WINDOW_MAX", "6000"))       # records read per window
RECALL_POOL = int(os.getenv("SCAN_RECALL_POOL", "200"))      # into the reranker
JUDGE_POOL = int(os.getenv("SCAN_JUDGE_POOL", "60"))         # into the LLM, normal scan
GROUP_PER_LABEL = int(os.getenv("SCAN_GROUP_PER_LABEL", "50"))
GROUP_POOL = int(os.getenv("SCAN_GROUP_POOL", "240"))
DEEP_MAX = int(os.getenv("SCAN_DEEP_MAX", "3000"))
MAX_CARDS = int(os.getenv("SCAN_MAX_CARDS", "300"))
JOB_TTL_S = int(os.getenv("SCAN_JOB_TTL_S", "1800"))
SUMMARY_ENABLED = os.getenv("SCAN_SUMMARY", "true").lower() in ("1", "true", "yes", "on")
RRF_K = 60


# --------------------------------------------------------------------------- #
# routing
# --------------------------------------------------------------------------- #

def route(question: str) -> Optional[dict]:
    """{"mode": ..., "labels": [...]} when the question needs judging, else None.

    Aggregates (counts, breakdowns, trends) stay with the engine: they are
    answered exactly by the database, and a scan would answer them from a
    sample.
    """
    labels = concepts.group_labels(question)
    if labels:
        return {"mode": "group", "labels": labels}
    if (planner.is_count_question(question) or planner.wants_breakdown(question)
            or planner.wants_trend(question)):
        return None
    c = concepts.concept(question)
    return {"mode": "concept", "labels": [c]} if c else None


def hard_spec(question: str) -> QuerySpec:
    """The exact filters in the question, without topic/target guesses.

    Topics and targets become the concept instead: filtering on keyword tags
    first would throw away exactly the posts that express the concept without
    using the keyword -- the ones the judge exists to find.
    """
    s = planner.plan(question)
    return QuerySpec(text=question, kinds=s.kinds, sentiment=s.sentiment,
                     risk_levels=s.risk_levels, platforms=s.platforms,
                     handles=s.handles, tagged=s.tagged, since=s.since,
                     until=s.until, min_risk_score=s.min_risk_score,
                     limit=s.limit, sort=s.sort)


# --------------------------------------------------------------------------- #
# the job
# --------------------------------------------------------------------------- #

class ScanJob:
    def __init__(self, question: str, tenant_id: str, scope_key: str,
                 mode: str, labels: List[str], deep: bool):
        self.id = uuid.uuid4().hex
        self.question = question
        self.tenant_id = tenant_id
        self.scope_key = scope_key
        self.mode = mode
        self.labels = labels
        self.deep = deep
        self.status = "running"
        self.stage = "planning"
        self.filters = ""
        self.window_total = 0
        self.pool = 0
        self.checked = 0
        self.matches: List[dict] = []
        self.counts: Dict[str, int] = {l: 0 for l in labels}
        self.note = ""
        self.summary = ""
        self.error = ""
        self.reranked = False
        self.verified = True
        self.started = time.time()
        self.finished: Optional[float] = None
        self.cancelled = False
        self.lock = threading.Lock()

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "job_id": self.id,
                "status": self.status,
                "stage": self.stage,
                "question": self.question,
                "mode": self.mode,
                "labels": self.labels,
                "deep": self.deep,
                "filters": self.filters,
                "window_total": self.window_total,
                "pool": self.pool,
                "checked": self.checked,
                "found": len(self.matches),
                "counts": dict(self.counts),
                "matches": self.matches[:MAX_CARDS],
                "reranked": self.reranked,
                "verified": self.verified,
                "note": self.note,
                "summary": self.summary,
                "error": self.error,
                "took_ms": int(((self.finished or time.time()) - self.started) * 1000),
            }


_jobs: Dict[str, ScanJob] = {}
_jobs_lock = threading.Lock()


def _purge():
    now = time.time()
    with _jobs_lock:
        for jid in [j for j, job in _jobs.items()
                    if job.finished and now - job.finished > JOB_TTL_S]:
            _jobs.pop(jid, None)


def get(job_id: str, tenant_id: str, scope_key: str) -> Optional[ScanJob]:
    """A job, only for the tenant AND district scope that started it.

    The id is unguessable, but a scan's results were filtered for one scope;
    handing them to another officer who obtained the id would leak across
    districts.
    """
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job or job.tenant_id != tenant_id or job.scope_key != scope_key:
        return None
    return job


def start(question: str, tenant_id: str, scope_key: str, deps_factory: Callable[[], dict],
          deep: bool = False, plan: Optional[dict] = None) -> ScanJob:
    """Create a job and run it in the background. *deps_factory* opens the
    per-job resources (collections, stores, db, embed, generate) inside the
    worker thread so nothing is shared with the request."""
    _purge()
    plan = plan or route(question) or {"mode": "concept", "labels": [question.strip()[:80]]}
    job = ScanJob(question, tenant_id, scope_key, plan["mode"], plan["labels"], deep)
    with _jobs_lock:
        _jobs[job.id] = job

    def _work():
        deps = None
        try:
            deps = deps_factory()
            run(job, **{k: v for k, v in deps.items() if k != "close"})
        except Exception as exc:
            logger.exception("scan %s failed", job.id)
            with job.lock:
                job.status = "error"
                job.error = str(exc)[:300]
        finally:
            with job.lock:
                if job.status == "running":
                    job.status = "cancelled" if job.cancelled else "done"
                job.stage = "done"
                job.finished = time.time()
            if deps and deps.get("close"):
                try:
                    deps["close"]()
                except Exception:
                    pass

    threading.Thread(target=_work, name=f"scan-{job.id[:8]}", daemon=True).start()
    return job


def cancel(job: ScanJob):
    with job.lock:
        job.cancelled = True


# --------------------------------------------------------------------------- #
# stages
# --------------------------------------------------------------------------- #

def _record(hit: dict, collection: str) -> dict:
    m = hit.get("metadata") or {}
    doc_id = str(m.get("document_id") or m.get("chunk_id") or "")
    digest = str(m.get("content_hash") or "")[:12]
    return {
        "key": f"{m.get('source_collection') or collection}:{doc_id}:{digest}",
        "document_id": doc_id,
        "chunk_id": m.get("chunk_id"),
        "collection": collection,
        "text": hit.get("text") or "",
        "meta": m,
    }


def window(collections: Dict[str, Any], spec: QuerySpec, tenant_id: str,
           districts: Optional[List[str]], cap: int) -> tuple:
    """(records, total): the window's records, most recent first, one per
    source document, and how many chunks the window holds in all."""
    q = retriever.build_filter(spec, tenant_id, districts)
    total = 0
    per_col = max(200, cap // max(1, len(collections)))
    records: List[dict] = []
    for name, col in collections.items():
        try:
            total += col.count_documents(q)
            cur = (col.find(q, {"text": 1, "metadata": 1, "_id": 0})
                      .sort([("metadata.published_at", -1)]).limit(per_col))
            records.extend(_record(d, name) for d in cur)
        except Exception as exc:
            logger.warning("scan window read failed on %s: %s", name, exc)

    seen, out = set(), []
    for r in records:
        if r["document_id"] in seen:
            continue
        seen.add(r["document_id"])
        out.append(r)
    out.sort(key=lambda r: _ts(r["meta"].get("published_at")), reverse=True)
    return out[:cap], total


def _ts(v) -> float:
    if isinstance(v, datetime):
        try:
            return v.timestamp()
        except Exception:
            return 0.0
    return 0.0


def _term_patterns(terms: List[str]) -> List[re.Pattern]:
    out = []
    for t in terms:
        t = t.strip()
        if not t:
            continue
        if re.fullmatch(r"[\x00-\x7f]+", t):
            out.append(re.compile(rf"(?<!\w){re.escape(t)}(?!\w)", re.I))
        else:
            # Indic scripts carry no ASCII word boundaries; match as substring.
            out.append(re.compile(re.escape(t)))
    return out


def lexical_scores(records: List[dict], terms: List[str]) -> Dict[str, int]:
    pats = _term_patterns(terms)
    out = {}
    for r in records:
        n = sum(1 for p in pats if p.search(r["text"]))
        if n:
            out[r["key"]] = n
    return out


def semantic_scores(records: List[dict], stores: Dict[str, Any], vector) -> Dict[str, float]:
    if not vector:
        return {}
    by_col: Dict[str, List[dict]] = {}
    for r in records:
        if r.get("chunk_id"):
            by_col.setdefault(r["collection"], []).append(r)
    out: Dict[str, float] = {}
    for name, recs in by_col.items():
        store = stores.get(name)
        if store is None or not hasattr(store, "similarity"):
            continue
        try:
            sims = store.similarity(vector, [r["chunk_id"] for r in recs])
            for r in recs:
                if r["chunk_id"] in sims:
                    out[r["key"]] = sims[r["chunk_id"]]
        except Exception as exc:
            logger.warning("scan similarity failed on %s: %s", name, exc)
    return out


def rrf(records: List[dict], *score_maps: Dict[str, float]) -> List[dict]:
    """Rank-fuse several scorings; records no scorer liked keep recency order
    at the back, so a pool is never short for lack of signal."""
    fused: Dict[str, float] = {}
    for scores in score_maps:
        ranked = sorted(scores, key=lambda k: scores[k], reverse=True)
        for rank, key in enumerate(ranked):
            fused[key] = fused.get(key, 0.0) + 1.0 / (RRF_K + rank + 1)
    liked = sorted((r for r in records if r["key"] in fused),
                   key=lambda r: fused[r["key"]], reverse=True)
    rest = [r for r in records if r["key"] not in fused]
    return liked + rest


def recall(records: List[dict], label: str, stores, embed, generate, db) -> List[dict]:
    terms = expander.expand(label, generate=generate, db=db)
    lex = lexical_scores(records, terms)
    vec = None
    if embed:
        try:
            vec = embed(f"{label}: " + ", ".join(terms[:10]))
        except Exception as exc:
            logger.warning("scan query embedding failed: %s", exc)
    sem = semantic_scores(records, stores, vec)
    return rrf(records, lex, sem)


def _card(r: dict, verdict: Optional[dict]) -> dict:
    m = r["meta"]
    pub = m.get("published_at")
    text = re.sub(r"\s+", " ", r["text"]).strip()
    return {
        "key": r["key"],
        "kind": m.get("kind") or r["collection"].replace("vector_embeddings_", ""),
        "handle": m.get("handle"),
        "platform": m.get("platform"),
        "url": m.get("url"),
        "published_at": pub.isoformat() if isinstance(pub, datetime) else pub,
        "risk_level": m.get("risk_level"),
        "risk_score": m.get("risk_score"),
        "sentiment": m.get("sentiment"),
        "districts": m.get("districts") or [],
        "text": text[:420] + ("…" if len(text) > 420 else ""),
        "labels": (verdict or {}).get("labels", []),
        "why": (verdict or {}).get("why", ""),
        "cached": bool((verdict or {}).get("cached")),
    }


def run(job: ScanJob, collections: Dict[str, Any], stores: Dict[str, Any],
        tenant_id: str, districts: Optional[List[str]], db=None,
        embed: Optional[Callable] = None, generate: Optional[Callable] = None,
        model: str = "", spec: Optional[QuerySpec] = None) -> None:
    def stage(name: str):
        with job.lock:
            job.stage = name

    # 1. filter --------------------------------------------------------------
    # A caller holding a resolved plan (the v2 orchestrator) passes its spec;
    # re-reading the raw question would drop filters a follow-up inherited.
    spec = spec or hard_spec(job.question)
    with job.lock:
        job.filters = planner.describe(spec)
    stage("filtering")
    cap = DEEP_MAX if job.deep else WINDOW_MAX
    records, total = window(collections, spec, tenant_id, districts, cap)
    with job.lock:
        job.window_total = total
    if not records or job.cancelled:
        return

    # 2-3. recall + rerank ---------------------------------------------------
    stage("recalling")
    if job.mode == "group":
        if job.deep:
            pool = records
        else:
            picked: Dict[str, dict] = {}
            for lab in job.labels:
                for r in recall(records, lab, stores, embed, generate, db)[:GROUP_PER_LABEL]:
                    picked.setdefault(r["key"], r)
            for r in records:                     # recent fill, so counts are
                if len(picked) >= GROUP_POOL:     # not only of likely matches
                    break
                picked.setdefault(r["key"], r)
            pool = list(picked.values())
    else:
        label = job.labels[0]
        ranked = recall(records, label, stores, embed, generate, db)
        pool = ranked if job.deep else ranked[:RECALL_POOL]
        if job.cancelled:
            return
        stage("reranking")
        scores = reranker.score(f"{label} — {job.question}", [r["text"][:1500] for r in pool])
        if scores is not None:
            order = sorted(range(len(pool)), key=lambda i: scores[i], reverse=True)
            pool = [pool[i] for i in order]
            with job.lock:
                job.reranked = True
        if not job.deep:
            pool = pool[:JUDGE_POOL]

    rank = {r["key"]: i for i, r in enumerate(pool)}
    by_key = {r["key"]: r for r in pool}
    with job.lock:
        job.pool = len(pool)

    # 4. judge ---------------------------------------------------------------
    stage("judging")

    def on_batch(verdicts: Dict[str, dict]):
        with job.lock:
            job.checked += len(verdicts)
            for key, v in verdicts.items():
                if not v.get("labels") or key not in by_key:
                    continue
                job.matches.append(_card(by_key[key], v))
                for lab in v["labels"]:
                    job.counts[lab] = job.counts.get(lab, 0) + 1
            job.matches.sort(key=lambda c: rank.get(c["key"], 1 << 30))

    verdicts = judge_mod.judge(pool, job.labels, job.question, generate, db=db,
                               model=model, on_batch=on_batch,
                               stop=lambda: job.cancelled)

    # Model unavailable: show the closest candidates, clearly marked as not
    # verified, rather than an empty answer that reads as "nothing found".
    if not verdicts and pool:
        with job.lock:
            job.verified = False
            job.matches = [_card(r, None) for r in pool[:15]]
            job.note = ("The AI judge is unavailable, so these are the closest matches "
                        "by search only and have not been verified.")
        return

    with job.lock:
        unjudged = len(pool) - len(verdicts)
        notes = []
        if not job.deep and job.window_total > len(pool):
            notes.append(f"Checked the {len(pool)} most likely of {job.window_total:,} "
                         f"records in range. Run a deep scan to check them all.")
        if job.deep and job.window_total > len(pool):
            notes.append(f"Deep scan covered the {len(pool):,} most recent of "
                         f"{job.window_total:,} records.")
        if unjudged > 0:
            notes.append(f"{unjudged} record(s) could not be judged and are not shown.")
        job.note = " ".join(notes)

    # 5. summary -------------------------------------------------------------
    if SUMMARY_ENABLED and generate and len(job.matches) >= 3 and not job.cancelled:
        stage("summarising")
        try:
            job_summary = summarise(job, generate)
            with job.lock:
                job.summary = job_summary
        except Exception as exc:
            logger.info("scan summary skipped: %s", exc)


def summarise(job: ScanJob, generate: Callable) -> str:
    """Two or three sentences on what the confirmed records have in common.

    Written from the judge's reasons, which are already short and grounded,
    so the model is summarising verdicts rather than re-reading posts.
    """
    with job.lock:
        rows = list(job.matches[:25])
        counts = dict(job.counts)
    lines = [f"- {'@' + c['handle'] if c.get('handle') else c['kind']}"
             f" ({(c.get('published_at') or '')[:10]}): {c.get('why') or c['text'][:120]}"
             for c in rows]
    count_line = ", ".join(f"{k}: {v}" for k, v in counts.items())
    prompt = (
        "You brief a police intelligence officer in Telangana, India.\n"
        f'They asked: "{job.question}"\n'
        f"Confirmed matches by label: {count_line}\n\n"
        "Reasons each record matched:\n" + "\n".join(lines) + "\n\n"
        "In 2-3 plain sentences, say what these records are mainly about: the recurring "
        "themes, places or accounts. Use only what is listed. No numbers except those "
        "given, no recommendations, no preamble."
    )
    out = generate(prompt, 180)
    return "" if (out or "").startswith("_(") else (out or "").strip()
