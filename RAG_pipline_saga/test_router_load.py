"""Saturation is a capacity fact, not a model failure.

The defect these cover, measured in a live end-to-end run: the model pool has two
slots and the plan task a 20 s budget. Under load a call spent 19 of its 20
seconds waiting in the queue, timed out, and was recorded as a model failure.
Three of those opened the circuit breaker — against a model that was healthy the
whole time and answered every request it actually received. Two later questions
then ran with no model at all, and one of them produced a nonsense answer.

So: waiting is measured separately from working, a call that never reached the
model never counts against the breaker, and a queue past its depth is refused at
once instead of waiting to be told the same thing twenty seconds later.
"""

import threading
import time

import pytest

from runtime import router as R
from runtime.router import Breaker, Router, is_failure_marker
from runtime.telemetry import Trace


@pytest.fixture(autouse=True)
def clean():
    Router.breakers.clear()
    R.reset_pool_stats()
    yield
    Router.breakers.clear()
    R.reset_pool_stats()


def trace():
    return Trace("req-test")


# ================================================== queue vs model execution

def test_a_healthy_call_records_queue_and_model_time_separately():
    t = trace()
    r = Router(lambda *a, **k: "answer", trace=t, retries=0)
    assert r.generate("plan")("prompt") == "answer"
    span = next(s for s in t.spans if s["stage"] == "llm.plan")
    assert "queue_ms" in span and "model_ms" in span
    assert span["queue_ms"] >= 0 and span["model_ms"] >= 0
    assert span["queue_ms"] + span["model_ms"] == pytest.approx(span["ms"], abs=1.0)


def test_a_call_that_never_reached_the_model_does_not_open_the_breaker():
    # Every slot is busy, so the call under test only ever waits.
    release = threading.Event()
    hogging = Router(lambda *a, **k: release.wait(30) or "late", retries=0)
    hogs = [threading.Thread(target=hogging.generate("judge"), args=("p",))
            for _ in range(R.CONCURRENCY)]
    for h in hogs:
        h.start()
    # Let the hogs take the slots.
    deadline = time.monotonic() + 5
    while R.pool_stats()["running"] < R.CONCURRENCY and time.monotonic() < deadline:
        time.sleep(0.01)

    try:
        t = trace()
        waiting = Router(lambda *a, **k: "never called", trace=t,
                         timeouts={"plan": 0.2}, retries=0)
        assert waiting.generate("plan")("p") is None
        stats = R.pool_stats()
        assert stats["queued_out"] == 1, "the call timed out in the queue"
        assert stats["failed"] == 0, "and that is not a model failure"
        breaker = Router.breakers.get(R.model_for("plan"))
        assert breaker is None or breaker.failures == 0, (
            "a queue timeout must not count against the model")
        assert any(s.get("error") == "queued_out" for s in t.spans)
    finally:
        release.set()
        for h in hogs:
            h.join(timeout=10)


def test_a_model_that_is_genuinely_too_slow_does_count():
    t = trace()
    r = Router(lambda *a, **k: time.sleep(2) or "late", trace=t,
               timeouts={"agent": 0.2}, retries=0)
    assert r.generate("agent")("p") is None
    stats = R.pool_stats()
    assert stats["failed"] == 1 and stats["queued_out"] == 0
    assert stats["abandoned"] == 1, "the work kept its slot, which is why the next caller waits"
    assert Router.breakers[R.model_for("agent")].failures == 1


def test_a_failure_marker_is_a_failure_not_an_answer():
    r = Router(lambda *a, **k: "_(LLM generation failed after 3 attempts)_", retries=0)
    assert r.generate("synthesize")("p") is None
    assert Router.breakers[R.model_for("synthesize")].failures == 1
    assert is_failure_marker("") and not is_failure_marker("fine")


# ============================================================ admission

def test_a_queue_past_its_depth_is_refused_at_once():
    release = threading.Event()
    slow = Router(lambda *a, **k: release.wait(30) or "late", retries=0)
    threads = []
    try:
        # Fill every slot and the whole queue.
        for _ in range(R.CONCURRENCY + R.MAX_QUEUE):
            th = threading.Thread(target=slow.generate("judge"), args=("p",))
            th.start()
            threads.append(th)
        deadline = time.monotonic() + 5
        while R.pool_stats()["queued"] < R.MAX_QUEUE and time.monotonic() < deadline:
            time.sleep(0.01)

        t = trace()
        refused = Router(lambda *a, **k: "never called", trace=t, retries=0)
        started = time.perf_counter()
        assert refused.generate("plan")("p") is None
        waited_ms = (time.perf_counter() - started) * 1000
        assert waited_ms < 500, (
            f"refusal took {waited_ms:.0f} ms; the point is not to wait out a "
            f"20 s timeout to be told the queue is full")
        assert R.pool_stats()["queue_full"] >= 1
        assert R.pool_stats()["failed"] == 0, "a full queue is not a model failure"
    finally:
        release.set()
        for th in threads:
            th.join(timeout=10)


def test_the_pool_reports_its_own_configuration():
    stats = R.pool_stats()
    assert stats["concurrency"] == R.CONCURRENCY
    assert stats["max_queue"] == R.MAX_QUEUE
    assert stats["concurrency"] >= 1 and stats["max_queue"] >= 1


def test_counters_return_to_rest_after_a_successful_call():
    r = Router(lambda *a, **k: "ok", retries=0)
    assert r.generate("plan")("p") == "ok"
    stats = R.pool_stats()
    assert stats["queued"] == 0 and stats["running"] == 0
    assert stats["completed"] == 1


def test_counters_return_to_rest_after_a_failure():
    def boom(*a, **k):
        raise RuntimeError("model exploded")

    r = Router(boom, retries=0)
    assert r.generate("plan")("p") is None
    stats = R.pool_stats()
    assert stats["queued"] == 0 and stats["running"] == 0
    assert stats["failed"] == 1


# ============================================================== breaker

def test_the_breaker_opens_only_after_repeated_real_failures():
    b = Breaker(threshold=3, cooldown_s=60)
    b.result(False)
    b.result(False)
    assert b.allow(), "two failures is not an outage"
    b.result(False)
    assert not b.allow()


def test_one_success_clears_the_count():
    b = Breaker(threshold=3, cooldown_s=60)
    b.result(False)
    b.result(False)
    b.result(True)
    b.result(False)
    b.result(False)
    assert b.allow(), "a success in between means the model is answering"


def test_a_cooled_breaker_lets_exactly_one_call_through():
    b = Breaker(threshold=2, cooldown_s=0.05)
    b.result(False)
    b.result(False)
    assert not b.allow()
    time.sleep(0.08)
    assert b.allow(), "half-open: one try"
    b.result(False)
    assert not b.allow(), "and it closes again on failure"


def test_an_open_breaker_is_visible_in_the_trace():
    t = trace()
    r = Router(lambda *a, **k: "_(failed)_", trace=t, retries=0)
    for _ in range(3):
        r.generate("plan")("p")
    assert r.generate("plan")("p") is None
    assert t.counters.get("llm.plan.breaker_open", 0) >= 1


def test_the_breaker_is_shared_per_model_and_that_is_deliberate():
    # A model that is down is down for every caller. What must NOT open it is
    # one caller's queue wait, which is what the tests above pin.
    a = Router(lambda *a, **k: "_(failed)_", retries=0)
    for _ in range(3):
        a.generate("plan")("p")
    b = Router(lambda *a, **k: "would have worked", retries=0)
    assert b.generate("plan")("p") is None
    assert R.pool_stats()["completed"] == 0


# ================================================= concurrent independence

def test_concurrent_callers_do_not_contaminate_each_other():
    # Each caller's own trace records its own call, and a slow caller does not
    # make a fast one's span look slow.
    results = {}

    def ask(i):
        t = trace()
        r = Router(lambda *a, **k: f"answer-{i}", trace=t, retries=0)
        out = r.generate("plan")(f"prompt-{i}")
        results[i] = (out, [s["stage"] for s in t.spans])

    threads = [threading.Thread(target=ask, args=(i,)) for i in range(6)]
    for th in threads:
        th.start()
    for th in threads:
        th.join(timeout=30)

    assert len(results) == 6
    for i, (out, stages) in results.items():
        assert out == f"answer-{i}", "a caller received another caller's answer"
        assert stages.count("llm.plan") == 1, "a caller's trace recorded another's call"


# ====================================== the counters must never drift

def test_the_queue_counter_returns_to_zero_under_mixed_outcomes():
    """A leaked `queued` count would make the queue look permanently full.

    Every later caller would then be refused at once, with the model idle — a
    worse outage than the one the admission limit exists to prevent. So the
    counter is driven through every path that can decrement it.
    """
    import random

    def flaky(prompt, max_tokens=256, temperature=0.0, model=None, **kw):
        roll = len(prompt) % 4
        if roll == 0:
            return "fine"
        if roll == 1:
            raise RuntimeError("model exploded")
        if roll == 2:
            return "_(LLM generation failed)_"
        time.sleep(0.4)          # outlives the tight timeout below
        return "late"

    r = Router(flaky, timeouts={"plan": 0.15}, retries=0)
    call = r.generate("plan")
    for i in range(40):
        Router.breakers.clear()          # keep the breaker out of the way
        call("p" * (i + 1))

    stats = R.pool_stats()
    assert stats["queued"] == 0, f"queue counter drifted to {stats['queued']}"
    assert stats["running"] == 0, f"running counter drifted to {stats['running']}"
    # And the pool still works afterwards.
    Router.breakers.clear()
    assert Router(lambda *a, **k: "ok", retries=0).generate("plan")("p") == "ok"


def test_counters_survive_concurrent_mixed_outcomes():
    def flaky(prompt, max_tokens=256, temperature=0.0, model=None, **kw):
        if "boom" in prompt:
            raise RuntimeError("model exploded")
        return "fine"

    def ask(i):
        Router.breakers.clear()
        Router(flaky, retries=0).generate("judge")("boom" if i % 3 == 0 else "fine")

    threads = [threading.Thread(target=ask, args=(i,)) for i in range(24)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    stats = R.pool_stats()
    assert stats["queued"] == 0 and stats["running"] == 0, stats
    assert stats["completed"] + stats["failed"] >= 24
