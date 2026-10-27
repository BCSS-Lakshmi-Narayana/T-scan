"""
telemetry.py — per-request traces and process-wide latency percentiles.

A Trace records one span per stage (understanding, conversation, enrichment,
policy, compile, each tool step, verification, agent, generation, response)
with its duration, outcome and counts. Traces are logged as one structured
line and folded into an in-process Metrics registry that keeps a bounded
reservoir per stage for p50/p95/p99.

Nothing identifying goes into a span: no tenant id, no user id, no question
text — only the hashed references the caller passes.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import defaultdict, deque
from contextlib import contextmanager
from typing import Any, Dict, List

logger = logging.getLogger("ai.telemetry")
RESERVOIR = 2000


class Trace:
    def __init__(self, request_id: str, **attrs):
        self.request_id = request_id
        self.attrs: Dict[str, Any] = dict(attrs)
        self.spans: List[dict] = []
        self.counters: Dict[str, float] = defaultdict(float)
        self._t0 = time.perf_counter()

    @contextmanager
    def span(self, stage: str, **attrs):
        t0 = time.perf_counter()
        rec = {"stage": stage, "ok": True, **attrs}
        try:
            yield rec
        except Exception as exc:
            rec["ok"] = False
            rec["error"] = type(exc).__name__
            raise
        finally:
            rec["ms"] = round((time.perf_counter() - t0) * 1000, 3)
            self.spans.append(rec)

    def add(self, stage: str, ms: float, **attrs) -> None:
        self.spans.append({"stage": stage, "ms": round(ms, 3), "ok": attrs.pop("ok", True), **attrs})

    def count(self, name: str, n: float = 1) -> None:
        self.counters[name] += n

    def total_ms(self) -> float:
        return round((time.perf_counter() - self._t0) * 1000, 3)

    def summary(self) -> dict:
        return {"request_id": self.request_id, **self.attrs, "total_ms": self.total_ms(),
                "spans": self.spans, "counters": dict(self.counters)}


class Metrics:
    def __init__(self):
        self._lock = threading.Lock()
        self._lat: Dict[str, deque] = defaultdict(lambda: deque(maxlen=RESERVOIR))
        self._count: Dict[str, int] = defaultdict(int)

    def record(self, trace: Trace) -> None:
        with self._lock:
            for s in trace.spans:
                self._lat[s["stage"]].append(s["ms"])
                self._count[f"{s['stage']}.{'ok' if s.get('ok', True) else 'failed'}"] += 1
            self._lat["request.total"].append(trace.total_ms())
            for k, v in trace.counters.items():
                self._count[k] += int(v)
        try:
            logger.info("ai-trace %s", json.dumps(trace.summary(), default=str)[:4000])
        except Exception:
            pass

    @staticmethod
    def _pct(values, p):
        if not values:
            return None
        s = sorted(values)
        return round(s[min(len(s) - 1, int(p * (len(s) - 1) + 0.5))], 3)

    def snapshot(self) -> dict:
        with self._lock:
            stages = {k: {"n": len(v), "p50": self._pct(v, .5), "p95": self._pct(v, .95),
                          "p99": self._pct(v, .99)} for k, v in self._lat.items()}
            return {"latency_ms": stages, "counters": dict(self._count)}

    def reset(self) -> None:
        with self._lock:
            self._lat.clear()
            self._count.clear()


METRICS = Metrics()
