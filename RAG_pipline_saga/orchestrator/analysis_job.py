"""Deep analysis, run in the background and reported as it goes.

Reading hundreds of posts takes minutes on a cold cache. Blocking the officer
for that is not an option, and shrinking the population until it fits inside a
request is exactly the mistake this whole change exists to undo. So the query
answers immediately from the deterministic figures and the retrieved evidence,
and the deep reading follows behind as a job the page watches.

Three populations are reported separately at every moment, because they are
three different facts about the answer and collapsing them is what made a
search box look like an analyst:

    matching    what the filters select          thousands
    analysed    what the model has actually read  grows while the job runs
    displayed   what is on screen                 ~20

While the job runs the evidence on screen is what retrieval found, and it is
labelled as such. Only when the analysis finishes is it replaced by records
chosen because of what the analysis found.

Nothing here widens scope: the job inherits the tenant and districts the
request was made under, and a job can only be read back by the same tenant and
the same district scope that started it.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
import uuid
from typing import Callable, Dict, List, Optional

from . import analysis as A

logger = logging.getLogger(__name__)

JOB_TTL_S = 1800

# What the officer is told at each point. Deliberately about their question,
# never about the machinery doing it.
STAGE_TEXT = {
    "preparing": "Selecting the most relevant monitored posts…",
    "analysing": "Analysing relevant monitored posts…",
    "summarising": "Building the summary…",
    "comparing": "Comparing what each location shows…",
    "done": "Analysis complete",
    "error": "Analysis could not be completed",
    "cancelled": "Analysis stopped",
}


class Side:
    """One scope of a comparison, read on its own.

    Pooling both scopes into one population made "Hyderabad vs Mulugu" a
    single reading of 300 records dominated by whichever place posts more,
    and then described the result as if it belonged to one of them. Each side
    gets its own matching count, its own ranked population and its own
    findings; only then is there anything honest to compare.
    """

    def __init__(self, label: str, spec, districts=None, since=None, until=None,
                 matching: Optional[int] = None):
        self.label = label
        self.spec = spec
        self.districts = districts
        self.since = since
        self.until = until
        self.matching = matching
        self.window_total: Optional[int] = None
        self.population = 0
        self.analysed = 0
        self.reused = 0
        self.fresh = 0
        self.findings: Dict[str, A.Finding] = {}
        self.records: Dict[str, dict] = {}
        self.order: List[str] = []
        self.aggregate: dict = {}
        self.evidence_keys: List[str] = []

    def progress(self) -> dict:
        pct = int(self.analysed / self.population * 100) if self.population else 0
        return {"label": self.label, "matching": self.matching,
                "population": self.population, "analysed": self.analysed,
                "percent": min(100, pct), "reused": self.reused, "fresh": self.fresh}

    def findings_view(self) -> dict:
        return {"label": self.label, "matching": self.matching,
                "analysed": self.analysed,
                "themes": self.aggregate.get("themes", []),
                "locations": self.aggregate.get("locations", []),
                "accounts": self.aggregate.get("people", []),
                "clusters": self.aggregate.get("clusters", []),
                "evidence": len(self.evidence_keys)}


class AnalysisJob:
    def __init__(self, question: str, intent: str, tenant_id: str, scope_key: str):
        # The owning process is part of the id, so a poll that lands elsewhere
        # is distinguishable from a job that never existed.
        self.id = f"{WORKER_TOKEN}-{uuid.uuid4().hex}"
        self.question = question
        self.intent = intent
        self.tenant_id = tenant_id
        self.scope_key = scope_key

        self.status = "running"          # running | done | error | cancelled
        self.stage = "preparing"
        # What the request's own deterministic count said. The window this job
        # reads is a DIFFERENT measurement, and reporting one as the other made
        # the same answer claim 6,526 matching and then 7,647.
        self.matching: Optional[int] = None
        self.window_total: Optional[int] = None
        self.population = 0              # how many we intend to read
        self.analysed = 0                # how many have been read so far
        self.reused = 0                  # served from previous analysis
        self.fresh = 0                   # read for the first time just now
        self.findings: Dict[str, A.Finding] = {}
        self.records: Dict[str, dict] = {}
        self.order: List[str] = []
        self.aggregate: dict = {}
        self.evidence_keys: List[str] = []
        self.summary = ""
        self.error = ""
        #: Populated for a comparison: one entry per scope, never pooled.
        self.sides: List[Side] = []
        #: Which scope is being read right now, for the progress line.
        self.current_side: Optional[str] = None

        self.started = time.time()
        self.finished: Optional[float] = None
        self.cancelled = False
        self.lock = threading.Lock()
        #: Where this job's wall-clock actually went, and what the model cost.
        #: Without it a 40s analysis is one number, and reading the population,
        #: the batches and the synthesis are indistinguishable.
        self.timings: Dict[str, float] = {}
        self.analysis_stats: Dict[str, float] = {}

    # -- profiling ---------------------------------------------------------
    def add_time(self, key: str, ms: float) -> None:
        """Accumulate one stage's cost. Never called holding `lock`."""
        with self.lock:
            self.timings[key] = round(self.timings.get(key, 0.0) + ms, 1)

    def note_analysis(self, stats: dict) -> None:
        """Sum one population's model cost into the job's total."""
        with self.lock:
            # Bound first: iterating (x or {}).items() directly crashes the Cython compiler.
            stats = stats or {}
            for key, value in stats.items():
                if isinstance(value, (int, float)):
                    self.analysis_stats[key] = round(
                        self.analysis_stats.get(key, 0) + value, 1)

    # -- progress, in the officer's terms ---------------------------------
    def snapshot(self, with_findings: bool = False) -> dict:
        with self.lock:
            pct = int(self.analysed / self.population * 100) if self.population else 0
            out = {
                "job_id": self.id,
                "status": self.status,
                "stage": self.stage,
                "stage_text": STAGE_TEXT.get(self.stage, ""),
                "progress": {
                    "analysed": self.analysed,
                    "population": self.population,
                    "percent": min(100, pct),
                    "reused": self.reused,
                    "fresh": self.fresh,
                },
                "elapsed_ms": int(((self.finished or time.time()) - self.started) * 1000),
                "error": self.error,
                # Profiling, not officer-facing: the UI ignores these.
                "timings": dict(self.timings),
                "analysis_stats": dict(self.analysis_stats),
            }
            if self.sides:
                # Per scope, never pooled: "300 analysed" across two places
                # says nothing about either of them.
                out["sides"] = [s.progress() for s in self.sides]
                out["current_side"] = self.current_side
            if with_findings and self.status == "done" and self.sides:
                out["comparison"] = {
                    "sides": [s.findings_view() for s in self.sides],
                    "summary": self.summary,
                }
            if with_findings and self.status == "done":
                out["themes"] = self.aggregate.get("themes", [])
                out["locations"] = self.aggregate.get("locations", [])
                out["accounts"] = self.aggregate.get("people", [])
                out["clusters"] = self.aggregate.get("clusters", [])
                out["repeated_claims"] = self.aggregate.get("repeated_claims", [])
                out["summary"] = self.summary
            return out


#: Progressive analysis keeps its jobs in THIS process's memory. With more
#: than one worker a poll lands on a worker that never saw the job and the
#: officer is told their analysis does not exist — a failure that looks like
#: data loss and is invisible in tests, because a test process is always one
#: worker. Until the registry is shared, one worker is a correctness
#: requirement, not a preference.
SINGLE_WORKER_REQUIRED = True


#: Identifies THIS process in every job id it hands out. A poll that arrives at
#: a different process can then say so, instead of reporting a job that exists
#: as missing. Cheap, and needs no shared registry.
WORKER_TOKEN = uuid.uuid4().hex[:8]


def _workers_from_env() -> Optional[int]:
    for name in ("WEB_CONCURRENCY", "UVICORN_WORKERS", "GUNICORN_WORKERS"):
        raw = os.getenv(name)
        if raw and str(raw).strip():
            try:
                return int(str(raw).strip())
            except ValueError:
                continue
    return None


def _workers_from_argv(argv: Optional[List[str]] = None) -> Optional[int]:
    """`uvicorn app:api --workers 4` sets no environment variable.

    Reading only the environment meant the most likely way of scaling out was
    also the one way the guard could not see.
    """
    args = list(argv if argv is not None else sys.argv[1:])
    for i, arg in enumerate(args):
        if arg in ("--workers", "-w") and i + 1 < len(args):
            try:
                return int(args[i + 1])
            except ValueError:
                continue
        for prefix in ("--workers=", "-w="):
            if arg.startswith(prefix):
                try:
                    return int(arg[len(prefix):])
                except ValueError:
                    continue
    return None


def configured_workers(argv: Optional[List[str]] = None) -> int:
    """How many workers this deployment is asking for, from any source."""
    counts = [n for n in (_workers_from_env(), _workers_from_argv(argv)) if n is not None]
    return max(counts) if counts else 1


def assert_single_worker(workers: Optional[int] = None,
                         argv: Optional[List[str]] = None) -> None:
    """Refuse to start under a configuration that silently breaks polling.

    Job state lives in this process's memory, so a second worker can serve a
    poll for a job it never saw. Called at import of the API surface, reading
    both the environment and the command line, so a deployment that scales out
    is caught at boot rather than by an officer whose analysis vanishes.
    """
    if workers is None:
        workers = configured_workers(argv)
    if workers > 1:
        raise RuntimeError(
            f"{workers} workers configured, but progressive analysis keeps job "
            "state in process memory: a poll would land on a worker that never "
            "saw the job. Run one worker, or move the job registry to shared "
            "storage before scaling out.")


_jobs: Dict[str, AnalysisJob] = {}
_lock = threading.Lock()


def _purge():
    now = time.time()
    with _lock:
        for jid in [j for j, job in _jobs.items()
                    if job.finished and now - job.finished > JOB_TTL_S]:
            _jobs.pop(jid, None)


def belongs_to_another_worker(job_id: str) -> bool:
    """Was this id minted by a different process?

    A well-formed id for a job this process has never heard of means the
    deployment is running more than one worker. Saying that is the difference
    between a diagnosable misconfiguration and an officer being told their
    analysis does not exist.
    """
    prefix, _, rest = (job_id or "").partition("-")
    if not rest or len(prefix) != len(WORKER_TOKEN):
        return False
    return prefix != WORKER_TOKEN


def get(job_id: str, tenant_id: str, scope_key: str) -> Optional[AnalysisJob]:
    """A job, only for the tenant AND district scope that started it.

    The id is unguessable, but a job's findings were produced under one scope;
    handing them to another officer who obtained the id would leak across
    districts.
    """
    with _lock:
        job = _jobs.get(job_id)
    if job is None and belongs_to_another_worker(job_id):
        logger.error(
            "analysis job %s was created by another process: this deployment is "
            "running more than one worker and progressive analysis cannot work. "
            "Run a single worker.", job_id)
    if not job or job.tenant_id != tenant_id or job.scope_key != scope_key:
        return None
    return job


def cancel(job: AnalysisJob):
    with job.lock:
        job.cancelled = True


def start(question: str, intent: str, tenant_id: str, scope_key: str,
          deps_factory: Callable[[], dict], size: Optional[int] = None,
          matching: Optional[int] = None, sides: Optional[List[Side]] = None) -> AnalysisJob:
    """Create the job and run it off the request thread.

    `deps_factory` opens the per-job resources (collections, stores, db, embed,
    generate, spec, districts) INSIDE the worker, so the request's connections
    are never shared with a thread that outlives it.
    """
    _purge()
    job = AnalysisJob(question, intent, tenant_id, scope_key)
    job.matching = matching
    with _lock:
        _jobs[job.id] = job

    want = A.pool_size(intent) if size is None else size

    def _work():
        deps = None
        try:
            deps = deps_factory()
            _run(job, want, sides=sides,
                 **{k: v for k, v in deps.items() if k != "close"})
        except Exception as exc:
            logger.exception("analysis job %s failed", job.id)
            with job.lock:
                job.status, job.error = "error", str(exc)[:300]
        finally:
            with job.lock:
                if job.status == "running":
                    job.status = "cancelled" if job.cancelled else "done"
                job.stage = {"done": "done", "error": "error",
                             "cancelled": "cancelled"}.get(job.status, "done")
                job.finished = time.time()
            if deps and deps.get("close"):
                try:
                    deps["close"]()
                except Exception:
                    pass

    threading.Thread(target=_work, name=f"analysis-{job.id[:8]}", daemon=True).start()
    return job


def _read_population(job: AnalysisJob, side: Side, want: int, *, collections, stores,
                     tenant_id, embed, generate, db, model, terms, on_progress):
    """Build one scope's population, read it, and aggregate what it says."""
    t0 = time.perf_counter()
    records, window_total = A.build_population(
        collections or {}, stores or {}, side.spec, tenant_id, side.districts,
        size=want, embed=embed, terms=terms)
    job.add_time("population_ms", (time.perf_counter() - t0) * 1000)
    with job.lock:
        side.window_total = window_total
        side.population = len(records)
        side.records = {r["key"]: r for r in records}
        side.order = [r["key"] for r in records]
    on_progress()
    if not records:
        return

    def on_batch(got: Dict[str, A.Finding]):
        with job.lock:
            side.findings.update(got)
            side.analysed = len(side.findings)
            side.reused = sum(1 for f in side.findings.values() if f.cached)
            side.fresh = side.analysed - side.reused
        on_progress()

    stats: Dict[str, float] = {}
    t0 = time.perf_counter()
    A.analyse(records, job.question, generate, db=db, model=model,
              on_batch=on_batch, stop=lambda: job.cancelled, stats=stats)
    job.add_time("analysis_ms", (time.perf_counter() - t0) * 1000)
    job.note_analysis(stats)
    if job.cancelled:
        return
    with job.lock:
        findings, order, recs = dict(side.findings), list(side.order), dict(side.records)
    t0 = time.perf_counter()
    agg = A.aggregate(findings, recs)
    keys = A.representative(findings, order, agg, count=20)
    job.add_time("aggregate_ms", (time.perf_counter() - t0) * 1000)
    with job.lock:
        side.aggregate = agg
        side.evidence_keys = keys


def _run(job: AnalysisJob, want: int, collections=None, stores=None, spec=None,
         tenant_id: str = "", districts=None, embed=None, generate=None,
         db=None, model: str = "", terms=None, sides=None):
    common = dict(collections=collections, stores=stores, tenant_id=tenant_id,
                  embed=embed, generate=generate, db=db, model=model, terms=terms)

    # A comparison is several populations, never one pooled read ----------
    if sides:
        with job.lock:
            job.sides = list(sides)
            job.stage = "analysing"

        def roll_up():
            with job.lock:
                job.population = sum(s.population for s in job.sides)
                job.analysed = sum(s.analysed for s in job.sides)
                job.reused = sum(s.reused for s in job.sides)
                job.fresh = sum(s.fresh for s in job.sides)

        for side in job.sides:
            if job.cancelled:
                return
            with job.lock:
                job.stage = "analysing"
                job.current_side = side.label
            _read_population(job, side, want, on_progress=roll_up, **common)
        if job.cancelled:
            return

        with job.lock:
            job.stage = "comparing"
            job.current_side = None
            job.records = {k: v for s in job.sides for k, v in s.records.items()}
            job.findings = {k: v for s in job.sides for k, v in s.findings.items()}
            # Evidence spans the sides evenly, so neither is represented by
            # the other's records.
            per = max(1, 20 // max(1, len(job.sides)))
            job.evidence_keys = [k for s in job.sides for k in s.evidence_keys[:per]]
            job.aggregate = {"analysed": job.analysed,
                             "sides": [s.findings_view() for s in job.sides]}
        t0 = time.perf_counter()
        job.summary = A.compare_sides(job.question,
                                      [(s.label, s.matching, s.aggregate) for s in job.sides],
                                      generate)
        job.add_time("synthesis_ms", (time.perf_counter() - t0) * 1000)
        return

    # A single population ---------------------------------------------------
    side = Side(label="", spec=spec, districts=districts, matching=job.matching)
    with job.lock:
        job.stage = "analysing"

    def mirror():
        with job.lock:
            job.window_total = side.window_total
            job.population = side.population
            job.records = side.records
            job.order = side.order
            job.findings = side.findings
            job.analysed = side.analysed
            job.reused = side.reused
            job.fresh = side.fresh

    _read_population(job, side, want, on_progress=mirror, **common)
    mirror()
    if job.cancelled or not side.population:
        return

    with job.lock:
        job.stage = "summarising"
        job.aggregate = side.aggregate
        job.evidence_keys = side.evidence_keys
        agg = side.aggregate
    # The request's own matching count, never this job's window measurement.
    t0 = time.perf_counter()
    summary = A.summarise(job.question, agg, job.matching, generate)
    job.add_time("synthesis_ms", (time.perf_counter() - t0) * 1000)
    with job.lock:
        job.summary = summary


def evidence_payload(job: AnalysisJob) -> List[dict]:
    """The representative records, in the shape the page already renders.

    Built from the record itself, never from the model's reading of it: the
    officer follows evidence to the original post, and that link must not
    depend on what any summary said about it.
    """
    from .evidence import _FACT_FIELDS, _iso
    out = []
    with job.lock:
        findings = dict(job.findings)
        if job.sides:
            # Walked per side, never reverse-mapped from a pooled key index:
            # a record can legitimately belong to both scopes, and a map keyed
            # by record silently gave it to whichever side was built last.
            # Each side's evidence is drawn from that side's own records.
            per = max(1, 20 // max(1, len(job.sides)))
            picked = [(k, s.label, s.records)
                      for s in job.sides for k in s.evidence_keys[:per]]
        else:
            picked = [(k, None, job.records) for k in job.evidence_keys]

    for i, (key, side, recs) in enumerate(picked, 1):
        rec = recs.get(key)
        if not rec:
            continue
        m = rec.get("meta") or {}
        facts = {k: _iso(m.get(k)) for k in _FACT_FIELDS if m.get(k) not in (None, "", [])}
        f = findings.get(key)
        if f is not None:
            # What the analysis observed, kept separate from the record's own
            # stored facts so the two are never confused.
            facts["observed_topic"] = f.topic
            facts["observed_claim"] = f.claim
        if side:
            # Which scope this record belongs to, so a comparison's evidence
            # is never read as belonging to the wrong place.
            facts["side"] = side
        out.append({
            "id": f"A{i}",
            "type": "record",
            "content": (rec.get("text") or "")[:600],
            "url": m.get("url"),
            "timestamp": _iso(m.get("published_at")),
            "districts": list(m.get("districts") or []),
            "facts": facts,
        })
    return out
