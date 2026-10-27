"""
executor.py — run an ExecutionPlan, safely.

Before anything runs, the whole plan is validated:

    ids unique · dependencies exist · no cycles · step count bounded
    every tool is a Capability the POLICY ALLOWED for this request
    every tool is implemented (registry status) and has a handler
    every step's arguments are the exact typed model its handler takes

A plan that fails validation runs nothing. Then, level by level in
dependency order (ties broken by step id, so ordering is deterministic):

    independent steps run concurrently, bounded by `max_workers`
    each step has a time budget; on expiry its cancel event is set and the
    step is recorded TIMED_OUT (a scan stops at its next checkpoint)
    a failed step SKIPS everything that depends on it
    a failed ESSENTIAL step fails the plan; a failed optional one degrades it
    a ToolScopeError stops the whole plan — scope is never degraded around

Scope for each step is the plan's execution_districts, narrowed further only
by a location step it depends on. Nothing here can widen it.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional

from policy.models import Capability
from policy.registry import CAPABILITIES

from . import tools as tool_mod
from .models import (MAX_STEPS, ExecutionPlan, ExecutionStep, StepResult,
                     StepStatus)

logger = logging.getLogger("orchestrator.executor")


class PlanValidationError(ValueError):
    def __init__(self, problems: List[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


def validate_plan(plan: ExecutionPlan) -> List[str]:
    problems: List[str] = []
    ids = [s.step_id for s in plan.steps]
    if len(ids) != len(set(ids)):
        problems.append("duplicate step ids")
    if len(plan.steps) > MAX_STEPS:
        problems.append(f"more than {MAX_STEPS} steps")
    allowed = set(plan.allowed_capabilities)
    known = set(ids)
    for s in plan.steps:
        if not isinstance(s.tool, Capability):
            problems.append(f"{s.step_id}: unknown tool")
            continue
        if s.tool not in allowed:
            problems.append(f"{s.step_id}: {s.tool.value} was not allowed by policy")
        if not CAPABILITIES[s.tool].available:
            problems.append(f"{s.step_id}: {s.tool.value} is not implemented")
        handler = tool_mod.HANDLERS.get(s.tool)
        if handler is None:
            problems.append(f"{s.step_id}: no handler for {s.tool.value}")
        elif type(s.arguments) is not handler[1]:
            problems.append(f"{s.step_id}: arguments are {type(s.arguments).__name__}, "
                            f"expected {handler[1].__name__}")
        for d in s.dependencies:
            if d not in known:
                problems.append(f"{s.step_id}: missing dependency {d}")
            if d == s.step_id:
                problems.append(f"{s.step_id}: depends on itself")
    if not problems and _levels(plan.steps) is None:
        problems.append("dependency cycle")
    return problems


def _levels(steps: List[ExecutionStep]) -> Optional[List[List[ExecutionStep]]]:
    remaining = {s.step_id: s for s in steps}
    done: set = set()
    levels = []
    while remaining:
        ready = sorted((s for s in remaining.values() if set(s.dependencies) <= done),
                       key=lambda s: s.step_id)
        if not ready:
            return None
        levels.append(ready)
        for s in ready:
            done.add(s.step_id)
            del remaining[s.step_id]
    return levels


@dataclass
class ExecutionOutcome:
    results: Dict[str, StepResult] = field(default_factory=dict)
    failed: bool = False
    degraded: bool = False
    scope_violation: Optional[str] = None
    cancelled: bool = False
    took_ms: float = 0.0

    def outputs(self) -> Dict[str, dict]:
        return {k: r.output for k, r in self.results.items() if r.status in (StepStatus.OK,
                                                                            StepStatus.EMPTY)}


def _count(output: dict) -> int:
    for key in ("records", "matches", "sides"):
        if isinstance(output.get(key), list):
            return len(output[key])
    if output.get("total") is not None:
        return int(output["total"])
    return 1 if output else 0


class Executor:
    def __init__(self, backend: tool_mod.ToolBackend, tenant_id: str, *, now: datetime,
                 max_workers: int = 4, deadline_s: float = 300.0, scope_key: str = "",
                 on_step=None):
        self.backend = backend
        self.tenant_id = tenant_id
        self.now = now
        self.max_workers = max(1, max_workers)
        self.deadline_s = deadline_s
        self.scope_key = scope_key
        self.cancel = threading.Event()
        self.on_step = on_step
        self._step_events: List[threading.Event] = []
        # Optional runtime.cache.ScopedCache for deterministic database tools.
        self.cache = None

    def cancel_all(self) -> None:
        """Stop the plan: every running step sees its own event set."""
        self.cancel.set()
        for ev in list(self._step_events):
            ev.set()

    def run(self, plan: ExecutionPlan, prior: Optional[Dict[str, StepResult]] = None) -> ExecutionOutcome:
        problems = validate_plan(plan)
        if problems:
            raise PlanValidationError(problems)
        started = time.perf_counter()
        outcome = ExecutionOutcome(results=dict(prior or {}))
        levels = _levels([s for s in plan.steps if s.step_id not in outcome.results]) or []
        by_id = {s.step_id: s for s in plan.steps}

        # Not a `with` block: its exit waits for every future, which would make a
        # timed-out step hold the response hostage. A timed-out step keeps its
        # thread until its handler returns (a scan stops at its next checkpoint).
        pool = ThreadPoolExecutor(max_workers=self.max_workers,
                                  thread_name_prefix="v2-step")
        try:
            for level in levels:
                if self.cancel.is_set() or outcome.scope_violation:
                    for s in level:
                        outcome.results[s.step_id] = StepResult(step_id=s.step_id, tool=s.tool,
                                                                status=StepStatus.CANCELLED)
                    continue
                runnable, futures = [], {}
                for s in level:
                    bad = [d for d in s.dependencies
                           if outcome.results.get(d) is None or
                           outcome.results[d].status not in (StepStatus.OK, StepStatus.EMPTY)]
                    if bad:
                        outcome.results[s.step_id] = StepResult(
                            step_id=s.step_id, tool=s.tool, status=StepStatus.SKIPPED,
                            error=f"dependency did not complete: {', '.join(bad)}")
                        continue
                    ctx = self._context(plan, s, outcome, by_id)
                    futures[s.step_id] = (s, ctx, pool.submit(self._cached_call, s, ctx))
                    runnable.append(s)
                for sid, (s, ctx, fut) in futures.items():
                    remaining = self.deadline_s - (time.perf_counter() - started)
                    budget = max(0.1, min(tool_mod.TIMEOUTS.get(s.tool, tool_mod.DEFAULT_TIMEOUT),
                                          remaining))
                    t0 = time.perf_counter()
                    try:
                        output = fut.result(timeout=budget)
                        output["_schema"] = s.output_schema
                        n = _count(output)
                        status = StepStatus.OK if n else StepStatus.EMPTY
                        res = StepResult(step_id=sid, tool=s.tool, status=status, output=output,
                                         result_count=n)
                    except FutureTimeout:
                        ctx.cancel.set()
                        res = StepResult(step_id=sid, tool=s.tool, status=StepStatus.TIMED_OUT,
                                         error=f"exceeded {budget:.1f}s")
                    except tool_mod.ToolScopeError as exc:
                        outcome.scope_violation = str(exc)
                        self.cancel_all()
                        res = StepResult(step_id=sid, tool=s.tool, status=StepStatus.FAILED,
                                         error="DISTRICT_OUTSIDE_SCOPE")
                    except Exception as exc:   # structured, never raw to the user
                        logger.warning("step %s (%s) failed: %s", sid, s.tool.value, exc)
                        res = StepResult(step_id=sid, tool=s.tool, status=StepStatus.FAILED,
                                         error=type(exc).__name__)
                    res.took_ms = round((time.perf_counter() - t0) * 1000, 2)
                    outcome.results[sid] = res
                    if self.on_step:
                        self.on_step(s, res)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)

        for s in plan.steps:
            r = outcome.results.get(s.step_id)
            if r is None or r.status in (StepStatus.OK, StepStatus.EMPTY):
                continue
            if s.essential:
                outcome.failed = True
            else:
                outcome.degraded = True
        outcome.cancelled = self.cancel.is_set() and not outcome.scope_violation
        outcome.took_ms = round((time.perf_counter() - started) * 1000, 2)
        return outcome

    def _context(self, plan: ExecutionPlan, step: ExecutionStep, outcome: ExecutionOutcome,
                 by_id) -> tool_mod.ToolContext:
        districts = plan.execution_districts
        inputs = {}
        for d in step.dependencies:
            out = outcome.results[d].output
            inputs[d] = out
            # A location step may narrow scope for what depends on it — only
            # ever to a subset of what the plan already allowed.
            if by_id[d].tool is Capability.LOCATION_RESOLVE and out.get("districts") is not None:
                narrowed = out["districts"]
                if districts is None or set(narrowed) <= set(districts):
                    districts = narrowed
        place = plan.place_districts
        if place is not None and districts is not None:
            place = [d for d in place if d in districts] or place
        ctx = tool_mod.ToolContext(tenant_id=self.tenant_id,
                                   districts=None if districts is None else list(districts),
                                   backend=self.backend, now=self.now, inputs=inputs,
                                   scope_key=self.scope_key, place_districts=place)
        if self.cancel.is_set():
            ctx.cancel.set()
        self._step_events.append(ctx.cancel)
        return ctx

    @staticmethod
    def _call(step: ExecutionStep, ctx: tool_mod.ToolContext) -> dict:
        handler, _ = tool_mod.HANDLERS[step.tool]
        return handler(step.arguments, ctx)

    def _cached_call(self, step: ExecutionStep, ctx: tool_mod.ToolContext) -> dict:
        """Deterministic database reads only. The key carries the tenant and
        the step's OWN execution districts, so no entry is readable from
        another tenant or a differently scoped caller."""
        if self.cache is None or step.tool not in CACHEABLE:
            return self._call(step, ctx)
        from runtime import cache as cache_mod
        k = cache_mod.key("tool", ctx.tenant_id, ctx.districts, step.tool.value,
                          step.arguments.model_dump(mode="json"),
                          sorted((d, str(o.get("records", o))[:2000]) for d, o in ctx.inputs.items()))
        hit = self.cache.get(k)
        if hit is not None:
            return {**hit, "_cache": "hit"}
        out = self._call(step, ctx)
        self.cache.set(k, dict(out))
        return out


CACHEABLE = {Capability.LOOKUP_RECORDS, Capability.HYBRID_SEARCH, Capability.AGGREGATE,
             Capability.TREND_ANALYSIS, Capability.COMPARE_RESULTS, Capability.LOCATION_RESOLVE}
