"""The deep-analysis job: progress, scope, and what it is allowed to say."""

import time

import pytest
import orchestrator.analysis as A
import orchestrator.analysis_job as J
from retriever import QuerySpec


class FakeCol:
    def __init__(self, n): self.n = n
    def count_documents(self, q): return self.n
    def find(self, q, proj=None):
        docs = [{"text": f"post {i} about women safety in Hyderabad",
                 "metadata": {"document_id": f"d{i}", "content_hash": f"h{i}",
                              "source_collection": "alerts", "risk_level": "high",
                              "published_at": f"2026-09-{(i % 28) + 1:02d}",
                              "url": f"https://x.com/u/{i}", "districts": ["Hyderabad"]}}
                for i in range(self.n)]
        class C:
            def __init__(s, d): s.d = d
            def sort(s, _): return s
            def limit(s, k): return iter(s.d[:k])
        return C(docs)


def deps(n=40, generate=None):
    return lambda: {
        "collections": {"alerts": FakeCol(n)}, "stores": {},
        "spec": QuerySpec(text="women safety", risk_levels=["high"]),
        "tenant_id": "t1", "districts": ["Hyderabad"], "embed": None,
        "generate": generate or (lambda p, m: "\n".join(
            f"{i}|topic=women safety|where=Hyderabad|who=@a{i}|claim=alleges harassment nearby"
            for i in range(1, A.BATCH_SIZE + 1))),
        "db": None, "model": "m", "terms": ["women", "safety"], "close": lambda: None,
    }


def wait(job, timeout=10):
    end = time.time() + timeout
    while time.time() < end and job.status == "running":
        time.sleep(0.02)
    return job


# ------------------------------------------------------------------ scope

def test_a_job_is_only_readable_by_the_scope_that_started_it():
    job = wait(J.start("q", "filtered_search", "t1", "Hyderabad", deps(10)))
    assert J.get(job.id, "t1", "Hyderabad") is job
    assert J.get(job.id, "OTHER-TENANT", "Hyderabad") is None, "tenant must not cross"
    assert J.get(job.id, "t1", "Warangal") is None, "district scope must not cross"
    assert J.get("nonexistent", "t1", "Hyderabad") is None


# --------------------------------------------------------------- progress

def test_progress_reports_the_three_populations_separately():
    job = wait(J.start("q", "filtered_search", "t1", "H", deps(40), size=30,
                       matching=4669))
    snap = job.snapshot(with_findings=True)
    assert job.status == "done"
    assert snap["progress"]["population"] == 30
    assert snap["progress"]["analysed"] == 30
    assert len(job.evidence_keys) <= 20, "display stays small"
    # the three are genuinely different numbers
    assert job.matching > snap["progress"]["analysed"] > len(job.evidence_keys)


def test_the_window_this_job_read_is_never_reported_as_the_matching_count():
    # These are two different measurements. Reporting the window as `matching`
    # made one answer claim 6,526 matching and then, seconds later, 7,647.
    job = wait(J.start("q", "filtered_search", "t1", "H", deps(40), size=30,
                       matching=4669))
    assert job.matching == 4669, "matching is the request's own count"
    assert job.window_total == 40, "the window is kept, but kept separate"
    assert "window_total" not in str(job.snapshot()), "and is not shown as a population"


def test_a_job_started_without_a_matching_count_claims_none():
    job = wait(J.start("q", "filtered_search", "t1", "H", deps(10)))
    assert job.matching is None, "better no number than the wrong one"


def test_progress_distinguishes_reused_from_newly_read():
    job = wait(J.start("q", "filtered_search", "t1", "H", deps(20)))
    p = job.snapshot()["progress"]
    assert p["reused"] + p["fresh"] == p["analysed"]
    assert p["percent"] == 100


def test_a_job_with_nothing_to_read_finishes_rather_than_hanging():
    job = wait(J.start("q", "filtered_search", "t1", "H", deps(0)))
    assert job.status == "done" and job.snapshot()["progress"]["analysed"] == 0


def test_a_failing_model_ends_the_job_without_inventing_findings():
    def dead(p, m):
        raise RuntimeError("model down")
    job = wait(J.start("q", "filtered_search", "t1", "H", deps(30, generate=dead)))
    assert job.status == "done"
    assert job.snapshot()["progress"]["analysed"] == 0
    assert job.summary == "", "no findings means no summary, not a guessed one"


def test_a_broken_job_reports_an_error_instead_of_dying_silently():
    def boom():
        raise RuntimeError("could not open the database")
    job = wait(J.start("q", "filtered_search", "t1", "H", boom))
    assert job.status == "error" and "could not open" in job.error


# ------------------------------------------------- what the officer reads

INTERNALS = ("batch", "LLM", "Qwen", "vector", "RRF", "embedding", "prompt",
             "token", "cache", "top_k", "mongo")


def test_progress_never_names_the_machinery():
    job = wait(J.start("q", "filtered_search", "t1", "H", deps(20)))
    for stage, text in J.STAGE_TEXT.items():
        for word in INTERNALS:
            assert word.lower() not in text.lower(), f"{stage!r} leaks {word!r}"
    blob = str(job.snapshot(with_findings=True)).lower()
    for word in ("qwen", "rrf", "top_k", "vector search"):
        assert word not in blob


def test_stages_are_described_as_the_work_on_the_question():
    assert "monitored posts" in J.STAGE_TEXT["analysing"]
    assert J.STAGE_TEXT["preparing"] and J.STAGE_TEXT["summarising"]


# ----------------------------------------------------------- the evidence

def test_evidence_is_built_from_the_record_not_from_the_model_reading():
    job = wait(J.start("q", "filtered_search", "t1", "H", deps(30)))
    payload = J.evidence_payload(job)
    assert payload, "a finished job must offer representative evidence"
    first = payload[0]
    assert first["type"] == "record"
    assert first["url"].startswith("https://x.com/")
    assert first["content"], "the officer follows evidence to the original post"
    # the model's reading is carried alongside, clearly separated
    assert "observed_topic" in first["facts"]
    assert first["facts"].get("risk_level") == "high"


def test_evidence_is_capped_far_below_the_analysed_population():
    job = wait(J.start("q", "filtered_search", "t1", "H", deps(200), size=120))
    assert job.snapshot()["progress"]["analysed"] > 20
    assert len(J.evidence_payload(job)) <= 20


def test_a_cancelled_job_stops_and_says_so():
    job = J.start("q", "situation_analysis", "t1", "H", deps(400), size=400)
    J.cancel(job)
    wait(job)
    assert job.status in ("cancelled", "done")


# ------------------------------------------------- deployment safety

def test_more_than_one_worker_is_refused_at_boot():
    # Job state is process-local: a second worker means a poll can land
    # somewhere that never saw the job, and the officer is told their
    # analysis does not exist.
    J.assert_single_worker(1)
    for n in (2, 4, 16):
        with pytest.raises(RuntimeError, match="job state in process memory"):
            J.assert_single_worker(n)


def test_the_worker_count_is_read_from_the_environment(monkeypatch):
    for var in ("WEB_CONCURRENCY", "UVICORN_WORKERS", "GUNICORN_WORKERS"):
        monkeypatch.delenv(var, raising=False)
    J.assert_single_worker()                      # nothing set -> one worker
    monkeypatch.setenv("WEB_CONCURRENCY", "3")
    with pytest.raises(RuntimeError):
        J.assert_single_worker()
    monkeypatch.setenv("WEB_CONCURRENCY", "not-a-number")
    J.assert_single_worker()                      # unreadable -> assume one


@pytest.mark.reads_source
def test_the_requirement_is_stated_not_just_enforced():
    assert J.SINGLE_WORKER_REQUIRED is True
    assert "process" in (J.assert_single_worker.__doc__ or "").lower()


# -------------------------------------------------------------- profiling

def test_a_jobs_stage_costs_are_accumulated_and_reported():
    job = J.AnalysisJob("q", "situation_analysis", "t-scan", "scope")
    job.add_time("population_ms", 120.0)
    job.add_time("analysis_ms", 400.0)
    job.add_time("analysis_ms", 350.0)      # one call per population
    job.note_analysis({"batches": 3, "llm_calls": 3, "llm_ms": 700.0})
    job.note_analysis({"batches": 2, "llm_calls": 2, "llm_ms": 300.0})

    snap = job.snapshot()
    assert snap["timings"]["population_ms"] == 120.0
    assert snap["timings"]["analysis_ms"] == 750.0, "each side adds to the total"
    assert snap["analysis_stats"]["llm_calls"] == 5
    assert snap["analysis_stats"]["llm_ms"] == 1000.0


def test_profiling_numbers_are_a_copy_a_caller_cannot_corrupt():
    job = J.AnalysisJob("q", "situation_analysis", "t-scan", "scope")
    job.add_time("analysis_ms", 10.0)
    snap = job.snapshot()
    snap["timings"]["analysis_ms"] = 999
    assert job.snapshot()["timings"]["analysis_ms"] == 10.0


def test_a_job_that_did_nothing_yet_reports_no_invented_timings():
    job = J.AnalysisJob("q", "situation_analysis", "t-scan", "scope")
    snap = job.snapshot()
    assert snap["timings"] == {} and snap["analysis_stats"] == {}


# --------------------------------------------- deployment cannot scale out

def test_workers_on_the_command_line_are_seen_too():
    # `uvicorn app:api --workers 4` sets no environment variable, so reading
    # only the environment meant the most likely way of scaling out was the one
    # way the guard could not see it.
    assert J.configured_workers(["app:api", "--workers", "4"]) == 4
    assert J.configured_workers(["app:api", "--workers=4"]) == 4
    assert J.configured_workers(["app:api", "-w", "3"]) == 3
    assert J.configured_workers(["app:api", "-w=3"]) == 3
    assert J.configured_workers(["app:api", "--host", "0.0.0.0"]) == 1
    assert J.configured_workers([]) == 1


def test_a_nonsense_worker_count_is_not_read_as_many():
    assert J.configured_workers(["--workers", "not-a-number"]) == 1
    assert J.configured_workers(["--workers"]) == 1


def test_the_guard_refuses_a_command_line_that_would_break_polling():
    with pytest.raises(RuntimeError) as exc:
        J.assert_single_worker(argv=["app:api", "--workers", "4"])
    assert "process memory" in str(exc.value)


def test_the_guard_reads_the_environment_too(monkeypatch):
    monkeypatch.setenv("WEB_CONCURRENCY", "2")
    with pytest.raises(RuntimeError):
        J.assert_single_worker(argv=[])
    monkeypatch.setenv("WEB_CONCURRENCY", "1")
    J.assert_single_worker(argv=[])


def test_the_highest_configured_count_wins(monkeypatch):
    # Environment says one, command line says four: four workers will run.
    monkeypatch.setenv("WEB_CONCURRENCY", "1")
    assert J.configured_workers(["--workers", "4"]) == 4


def test_a_job_id_names_the_process_that_owns_it():
    job = J.AnalysisJob("q", "situation_analysis", "t", "scope")
    assert job.id.startswith(J.WORKER_TOKEN + "-")
    assert not J.belongs_to_another_worker(job.id)


def test_a_job_id_from_another_process_is_recognised_as_such():
    # The point: an officer whose poll lands on the wrong worker gets a
    # diagnosable misconfiguration, not "your analysis does not exist".
    foreign = "deadbeef-" + "0" * 32
    assert J.belongs_to_another_worker(foreign)
    assert J.get(foreign, "t", "scope") is None


def test_a_malformed_or_missing_id_is_not_blamed_on_another_worker():
    for bad in ("", None, "nonsense", "no-prefix-here"):
        assert J.belongs_to_another_worker(bad) is False
