"""
router.py — which model does which job, behind one guarded call.

Tasks, and who serves them by default:

    plan        query-plan fallback (small JSON)            LLM_MODEL
    judge       concept / classification verdicts           LLM_MODEL
    expand      concept term expansion                      LLM_MODEL
    synthesize  answer wording over verified evidence       LLM_MODEL
    agent       picking a refinement from a fixed menu      LLM_MODEL

Every task defaults to the model production already runs. A task moves to
another model only by explicit configuration (AI_MODEL_<TASK>), and the
Phase 0 note stands: the 14B/7B benchmark was stopped before a result, so no
routing change is made here on speed alone.

The guarded call adds what the raw client does not: a per-task timeout, one
retry on a transient failure, a circuit breaker that stops calling a model
that keeps failing, and token/latency accounting into the request trace. A
model failure returns None — callers degrade (template response, cached
verdicts only), they never crash and never fabricate.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Callable, Dict, Optional

logger = logging.getLogger("ai.router")

TASKS = ("plan", "judge", "expand", "synthesize", "agent")
_DEFAULT_TIMEOUT = {"plan": 20.0, "judge": 120.0, "expand": 60.0, "synthesize": 60.0,
                    "agent": 15.0}

#: How many calls may be in the model at once. Deliberately small and NOT raised
#: to hide latency: one Ollama instance on one shared GPU serves these, and
#: oversubscribing it makes every caller slower rather than any caller faster.
CONCURRENCY = max(1, int(os.getenv("AI_LLM_CONCURRENCY", "2")))

#: How many calls may WAIT. Unbounded queueing is what turned one slow synthesis
#: into a cascade: each waiting call burned its whole timeout in the queue, was
#: recorded as a model failure, and after three of them the breaker opened
#: against a model that was healthy the entire time. Past this depth a caller is
#: refused at once and degrades honestly instead of waiting to be told the same
#: thing twenty seconds later.
MAX_QUEUE = max(1, int(os.getenv("AI_LLM_MAX_QUEUE", "8")))

_POOL = ThreadPoolExecutor(max_workers=CONCURRENCY, thread_name_prefix="v2-llm")

_LOAD_LOCK = threading.Lock()
_LOAD = {"queued": 0, "running": 0, "queue_full": 0, "queued_out": 0,
         "abandoned": 0, "completed": 0, "failed": 0}


def _load_change(**deltas: int) -> None:
    with _LOAD_LOCK:
        for key, delta in deltas.items():
            _LOAD[key] = _LOAD.get(key, 0) + delta


def pool_stats() -> Dict[str, int]:
    """What the model pool is doing, for the metrics endpoint.

    `queued_out` and `queue_full` rising while `failed` stays flat means the
    model is fine and this process is asking it for more than it can serve —
    a capacity fact, not a model fault, and the two used to be indistinguishable.
    """
    with _LOAD_LOCK:
        return {**_LOAD, "concurrency": CONCURRENCY, "max_queue": MAX_QUEUE}


def reset_pool_stats() -> None:
    with _LOAD_LOCK:
        for key in list(_LOAD):
            _LOAD[key] = 0


def is_failure_marker(text) -> bool:
    t = (text or "").strip()
    return not t or (t.startswith("_(") and t.endswith(")_"))


def model_for(task: str) -> str:
    default = os.getenv("LLM_MODEL", "qwen3-14b")
    return os.getenv(f"AI_MODEL_{task.upper()}", default)


class Breaker:
    def __init__(self, threshold: int = 3, cooldown_s: float = 60.0):
        self.threshold, self.cooldown_s = threshold, cooldown_s
        self.failures, self.opened_at = 0, 0.0
        self._lock = threading.Lock()

    def allow(self) -> bool:
        with self._lock:
            if self.failures < self.threshold:
                return True
            if time.monotonic() - self.opened_at > self.cooldown_s:
                self.failures = self.threshold - 1        # half-open: one try
                return True
            return False

    def result(self, ok: bool) -> None:
        with self._lock:
            if ok:
                self.failures = 0
            else:
                self.failures += 1
                if self.failures >= self.threshold:
                    self.opened_at = time.monotonic()


class Router:
    """`generate(task)` returns a callable (prompt, max_tokens, temperature) ->
    str|None bound to that task's model, timeout and breaker."""

    def __init__(self, raw_generate: Optional[Callable], trace=None,
                 timeouts: Optional[Dict[str, float]] = None, retries: int = 1):
        self.raw = raw_generate
        self.trace = trace
        self.timeouts = {**_DEFAULT_TIMEOUT, **(timeouts or {})}
        self.retries = retries

    breakers: Dict[str, Breaker] = {}

    def _breaker(self, model: str) -> Breaker:
        return Router.breakers.setdefault(model, Breaker())

    def generate(self, task: str) -> Optional[Callable]:
        if self.raw is None:
            return None
        model = model_for(task)

        def call(prompt: str, max_tokens: int = 256, temperature: float = 0.0, **kw) -> Optional[str]:
            br = self._breaker(model)
            if not br.allow():
                if self.trace:
                    self.trace.count(f"llm.{task}.breaker_open")
                return None
            for attempt in range(self.retries + 1):
                with _LOAD_LOCK:
                    waiting = _LOAD["queued"]
                if waiting >= MAX_QUEUE:
                    # Refused at once rather than after a full timeout in the
                    # queue. The model is not at fault, so the breaker is not
                    # told anything.
                    _load_change(queue_full=1)
                    if self.trace:
                        self.trace.count(f"llm.{task}.queue_full")
                    return None

                # `started` separates waiting from working. Without it a call
                # that spent 19 of its 20 seconds in the queue was recorded as
                # a model timeout, and three of those opened the breaker
                # against a model that had not failed once.
                started = threading.Event()
                timings: Dict[str, float] = {}

                def work(_prompt=prompt, _max=max_tokens, _temp=temperature):
                    timings["started_at"] = time.perf_counter()
                    started.set()
                    _load_change(queued=-1, running=1)
                    try:
                        return self.raw(_prompt, max_tokens=_max, temperature=_temp,
                                        model=model)
                    finally:
                        _load_change(running=-1)

                t0 = time.perf_counter()
                _load_change(queued=1)
                try:
                    fut = _POOL.submit(work)
                except RuntimeError:
                    # The pool is shut down — process is going away.
                    _load_change(queued=-1)
                    return None

                try:
                    out = fut.result(timeout=self.timeouts.get(task, 60.0))
                    if is_failure_marker(out):
                        # llm_client reports terminal failure as a "_(...)_"
                        # string instead of raising; that is an error, not text.
                        raise RuntimeError("llm failure marker")
                    br.result(True)
                    _load_change(completed=1)
                    if self.trace:
                        total_ms = (time.perf_counter() - t0) * 1000
                        queue_ms = max(0.0, (timings.get("started_at", t0) - t0) * 1000)
                        self.trace.add(f"llm.{task}", total_ms, model=model,
                                       queue_ms=round(queue_ms, 3),
                                       model_ms=round(total_ms - queue_ms, 3))
                        self.trace.count("llm.calls")
                        self.trace.count("llm.queue_ms", int(queue_ms))
                        self.trace.count("llm.prompt_chars", len(prompt))
                        self.trace.count("llm.completion_chars", len(out or ""))
                    return out
                except FutureTimeout:
                    if not started.is_set() and fut.cancel():
                        # Never reached the model: a capacity problem, and
                        # counting it as a model failure is what opened the
                        # breaker during load.
                        _load_change(queued=-1, queued_out=1)
                        if self.trace:
                            self.trace.add(f"llm.{task}", (time.perf_counter() - t0) * 1000,
                                           ok=False, error="queued_out", attempt=attempt)
                            self.trace.count(f"llm.{task}.queued_out")
                        return None
                    # It did start, so the model really is too slow for this
                    # task's budget. The work keeps running and keeps its slot;
                    # that is worth counting, because it is why the next caller
                    # waits.
                    fut.cancel()
                    _load_change(abandoned=1)
                    err = "timeout"
                except Exception as exc:
                    if not started.is_set():
                        _load_change(queued=-1)
                    err = type(exc).__name__
                br.result(False)
                _load_change(failed=1)
                if self.trace:
                    self.trace.add(f"llm.{task}", (time.perf_counter() - t0) * 1000, ok=False,
                                   error=err, attempt=attempt)
            return None
        return call
