"""
evaluator.py — QueryPlan + RequestContext -> PolicyResult.

Deterministic and side-effect free: no model, no database, no network, no
clock in the result. The same plan, context and config always produce the
same decision, byte for byte.

Order of evaluation, and why it is this order:

  1. tenant        a request with no valid tenant is refused before anything
                   about it is examined
  2. role          an unknown role holds nothing
  3. district mode None vs [] settled once, before any capability looks at it
  4. plan          an invalid plan is refused, not repaired; the gate re-runs
                   the validator rather than trusting a caller's verdict
  5. capabilities  derived from the plan's needs; a tool name no need
                   justifies is refused, so the model cannot add one
  6. scope         the districts execution may touch; named places outside
                   scope are refused, never substituted
  7. time / risk   bounds for the expensive capabilities
  8. context       follow-ups and referents the gate cannot resolve

The decision is the worst severity among the reasons. Nothing else sets it,
so every decision can be explained by pointing at its reasons.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from pydantic import ValidationError

from query_understanding import tools as qu_tools
from query_understanding.models import (Intent, Need, QueryPlan, Source,
                                        TimeKind)
from query_understanding.validator import validate as validate_plan

from . import scope as scope_mod
from .config import PolicyConfig
from .models import (Capability, Constraints, DistrictMode, PolicyAudit,
                     PolicyDecision, PolicyReason, PolicyResult, ReasonCode,
                     RequestContext, RuleTrace, Severity, SubDecision, ref)
from .registry import CAPABILITIES, ESSENTIAL, lookup

_RANK = {Severity.ERROR: 4, Severity.CLARIFY: 3, Severity.DEGRADE: 2,
         Severity.WARNING: 1, Severity.INFO: 0}
_DECISION = {4: PolicyDecision.DENIED, 3: PolicyDecision.CLARIFICATION_REQUIRED,
             2: PolicyDecision.DEGRADED, 1: PolicyDecision.ALLOWED, 0: PolicyDecision.ALLOWED}
_ANALYTIC = (Intent.AGGREGATION, Intent.TREND_ANALYSIS, Intent.COMPARISON)
_SCAN_CAPS = (Capability.UNKNOWN_CONCEPT_SEARCH, Capability.CLASSIFY_RECORDS,
              Capability.DEEP_SCAN)


def decide(reasons: List[PolicyReason]) -> PolicyDecision:
    return _DECISION[max((_RANK[r.severity] for r in reasons), default=0)]


@dataclass
class _Unit:
    """One evaluable piece: the whole plan, or one sub-question of it."""
    index: Optional[int]
    intent: Intent
    needs: List[Need]
    tools: List[str]
    metric: Optional[str]
    group_by: List[str]
    capabilities: List[Capability] = field(default_factory=list)


@dataclass
class _Run:
    reasons: List[PolicyReason] = field(default_factory=list)
    trace: List[RuleTrace] = field(default_factory=list)
    requested: List[Capability] = field(default_factory=list)
    blocked: List[Capability] = field(default_factory=list)

    def add(self, code: ReasonCode, severity: Severity, **kw) -> None:
        reason = PolicyReason(code=code, severity=severity, **kw)
        if reason not in self.reasons:
            self.reasons.append(reason)

    def rule(self, name: str, outcome: str) -> None:
        self.trace.append(RuleTrace(rule=name, outcome=outcome))

    def request(self, cap: Capability) -> None:
        if cap not in self.requested:
            self.requested.append(cap)

    def block(self, cap: Capability) -> None:
        if cap not in self.blocked:
            self.blocked.append(cap)


def _has_permission(cap: Capability, ctx: RequestContext, config: PolicyConfig) -> bool:
    # Admin roles bypass feature checks, exactly as rbacMiddleware does.
    if scope_mod.is_admin(ctx, config):
        return True
    needed = config.capability_permissions.get(cap)
    # A capability with no mapped permission is unreachable, not free.
    return bool(needed) and needed in ctx.permissions


def _units(plan: QueryPlan) -> List[_Unit]:
    if plan.intent is not Intent.MULTI_PART or not plan.sub_questions:
        return [_Unit(None, plan.intent, list(plan.needs), list(plan.required_tools),
                      plan.metric, list(plan.group_by))]
    units = [_Unit(s.index, s.intent, list(s.needs), list(s.required_tools),
                   s.metric, list(s.group_by)) for s in plan.sub_questions]
    # What the whole plan asks for beyond its parts (search over the whole
    # question, location or concept resolution) is evaluated once, as
    # supporting work: it has no essential capability of its own.
    covered = {t for u in units for t in qu_tools.tools_for(u.needs) + u.tools}
    residual_needs = [n for n in plan.needs
                      if any(t not in covered for t in qu_tools.tools_for([n]))]
    residual_tools = [t for t in plan.required_tools if t not in covered]
    units.append(_Unit(None, Intent.MULTI_PART, residual_needs, residual_tools,
                       plan.metric, list(plan.group_by)))
    return units


def _check_unit(unit: _Unit, ctx: RequestContext, config: PolicyConfig, run: _Run) -> None:
    derived = qu_tools.tools_for(unit.needs)
    where = {"sub_question": unit.index}

    # -- tool names: only needs may introduce one ---------------------------- #
    for name in unit.tools:
        cap = lookup(name)
        if cap is None:
            run.add(ReasonCode.UNKNOWN_TOOL, Severity.ERROR, source="plan",
                    field="required_tools", detail=name[:64], **where)
        elif name not in derived:
            run.add(ReasonCode.UNSAFE_PLAN, Severity.ERROR, source="plan",
                    capability=cap, field="required_tools", **where)
            run.request(cap)
            run.block(cap)

    caps = [c for c in (lookup(n) for n in derived) if c is not None]
    unit.capabilities = caps

    essential = ESSENTIAL.get(unit.intent, frozenset())
    # An empty unit is PLAN_EMPTY's business (a clarification), not a
    # malformed plan.
    missing = essential - set(caps) if caps else set()
    for cap in sorted(missing, key=lambda c: c.value):
        # The intent's defining capability is not in the plan: its needs do
        # not describe its intent, so it cannot be executed as asked.
        run.add(ReasonCode.INVALID_PLAN, Severity.ERROR, source="plan",
                capability=cap, field="needs", **where)

    for cap in caps:
        run.request(cap)
        spec = CAPABILITIES[cap]
        code = None
        if unit.intent not in spec.allowed_intents:
            code = ReasonCode.CAPABILITY_NOT_ALLOWED
        elif cap in config.disabled_capabilities:
            code = ReasonCode.CAPABILITY_DISABLED
        elif not spec.available:
            code = ReasonCode.CAPABILITY_UNAVAILABLE
        elif not _has_permission(cap, ctx, config):
            code = ReasonCode.PERMISSION_REQUIRED
        if code is None:
            continue
        # Incompatibility is plan tampering, never a degradation. Otherwise an
        # essential capability voids the request and a supporting one only
        # thins it.
        severe = code is ReasonCode.CAPABILITY_NOT_ALLOWED or cap in essential
        run.add(code, Severity.ERROR if severe else Severity.DEGRADE,
                capability=cap, **where)
        run.block(cap)

    # -- analytics the backend can actually compute ------------------------- #
    if unit.intent in _ANALYTIC and unit.metric and unit.metric not in config.supported_metrics:
        run.add(ReasonCode.UNSUPPORTED_METRIC, Severity.ERROR, source="plan",
                field="metric", detail=unit.metric[:32], **where)
    for g in unit.group_by:
        if g not in config.supported_group_by:
            run.add(ReasonCode.UNSUPPORTED_GROUPING, Severity.ERROR, source="plan",
                    field="group_by", detail=str(g)[:32], **where)


def _finish(run: _Run, ctx: RequestContext, config: PolicyConfig, *,
            plan: Optional[QueryPlan], mode: Optional[DistrictMode],
            effective: Optional[List[str]], scope_summary: str,
            constraints: Optional[Constraints] = None,
            sub_units: Optional[List[_Unit]] = None) -> PolicyResult:
    decision = decide(run.reasons)
    runnable = decision in (PolicyDecision.ALLOWED, PolicyDecision.DEGRADED)
    allowed = [c for c in run.requested if c not in run.blocked] if runnable else []
    if decision is PolicyDecision.DENIED:
        # A refused request touches nothing: no scope, no constraints.
        effective, constraints = [], None

    subs: List[SubDecision] = []
    for u in sub_units or []:
        own = [r for r in run.reasons if r.sub_question == u.index]
        subs.append(SubDecision(index=u.index, decision=decide(own),
                                capabilities=u.capabilities,
                                reason_codes=[r.code for r in own]))

    fingerprint = config.fingerprint()
    audit = PolicyAudit(
        policy_version=config.version, config_fingerprint=fingerprint,
        request_id=plan.metadata.request_id if plan else None,
        tenant_ref=ref(ctx.tenant_id), user_ref=ref(ctx.user_id), role=ctx.role,
        district_mode=mode, decision=decision,
        requested_capabilities=list(run.requested), allowed_capabilities=allowed,
        blocked_capabilities=list(run.blocked), scope_decision=scope_summary,
        reason_codes=[r.code for r in run.reasons])
    return PolicyResult(
        decision=decision, requested_capabilities=list(run.requested),
        allowed_capabilities=allowed, blocked_capabilities=list(run.blocked),
        effective_districts=effective, constraints=constraints,
        reasons=list(run.reasons), sub_decisions=subs,
        policy_version=config.version, config_fingerprint=fingerprint,
        trace=list(run.trace), audit=audit)


def evaluate(plan: QueryPlan, ctx: RequestContext, *,
             config: Optional[PolicyConfig] = None,
             requested_districts: Optional[List[str]] = None,
             requested_tenant_id: Optional[str] = None) -> PolicyResult:
    """Decide what ``plan`` may do for ``ctx``. Never raises on a well-typed
    plan; never executes, reads or writes anything.

    ``requested_districts`` is the caller's own selection (a UI filter),
    which may be narrowed. Districts named inside the question are never
    narrowed — they are either in scope or refused.
    ``requested_tenant_id`` is any second statement of the tenant the request
    carries (a header, a job's owner); it must match the context exactly.
    """
    config = config or PolicyConfig.from_env()
    run = _Run()

    def stop(summary: str) -> PolicyResult:
        return _finish(run, ctx, config, plan=plan, mode=None, effective=[],
                       scope_summary=summary)

    # 1. tenant --------------------------------------------------------------
    code = scope_mod.check_tenant(ctx, requested_tenant_id)
    if code:
        run.add(code, Severity.ERROR, source="context")
        run.rule("tenant", "fail")
        return stop("tenant-denied")
    run.rule("tenant", "pass")

    # 2. role ----------------------------------------------------------------
    if (ctx.role or "") not in config.known_roles:
        run.add(ReasonCode.ROLE_NOT_PERMITTED, Severity.ERROR, source="context")
        run.rule("role", "fail")
        return stop("role-denied")
    run.rule("role", "pass")

    # 3. district mode -------------------------------------------------------
    mode, code = scope_mod.district_mode(ctx, config)
    if code:
        run.add(code, Severity.ERROR, source="context")
        run.rule("district_mode", "fail")
        return stop("district-denied")
    run.rule("district_mode", mode.value)

    # 4. plan validity -------------------------------------------------------
    validation = validate_plan(plan)
    if not validation.valid:
        for issue in validation.errors:
            run.add(ReasonCode.INVALID_PLAN, Severity.ERROR, source="plan", field=issue.field)
        run.rule("plan_valid", "fail")
        return stop("plan-denied")
    run.rule("plan_valid", "pass")

    # 5. capabilities --------------------------------------------------------
    units = _units(plan)
    for unit in units:
        _check_unit(unit, ctx, config, run)
    run.rule("capabilities", "fail" if run.blocked else "pass")

    touches_data = bool(run.requested)
    if plan.intent is not Intent.CONVERSATIONAL and not touches_data:
        # Nothing to run and not a conversation: the question was not
        # understood well enough to act on, and inventing work would be worse.
        run.add(ReasonCode.PLAN_EMPTY, Severity.CLARIFY, source="plan")

    # 6. scope ---------------------------------------------------------------
    effective: Optional[List[str]] = None if mode is DistrictMode.UNRESTRICTED else list(ctx.districts or [])
    scope_summary = "no-data-access"
    if touches_data:
        if mode is DistrictMode.NONE:
            run.add(ReasonCode.DISTRICT_SCOPE_EMPTY, Severity.ERROR, source="context")
            effective, scope_summary = [], "no-districts"
        else:
            outcome = scope_mod.resolve_scope(plan, ctx, mode, requested_districts)
            effective, scope_summary = outcome.effective, outcome.summary
            severity = {ReasonCode.DISTRICT_OUTSIDE_SCOPE: Severity.ERROR,
                        ReasonCode.SCOPE_NARROWED: Severity.DEGRADE,
                        ReasonCode.LOCATION_SCOPE_UNVERIFIED: Severity.WARNING}
            for f in outcome.findings:
                run.add(f.code, severity[f.code], source="scope", field="districts",
                        detail=(f.detail or "")[:64] or None, sub_question=f.sub_question)
        if any(a.field == "location" for a in plan.ambiguities):
            run.add(ReasonCode.LOCATION_AMBIGUOUS, Severity.WARNING, source="plan",
                    field="location")
    run.rule("scope", scope_summary)

    # 7. time and high-risk bounds -------------------------------------------
    tr = plan.time_range
    days = scope_mod.window_days(tr)
    usable = [c for c in run.requested if c not in run.blocked]
    constraints = Constraints(district_mode=mode, time_range=tr, time_window_days_max=days)

    if touches_data and tr.kind is TimeKind.UNRESOLVED:
        run.add(ReasonCode.TIME_RANGE_UNRESOLVED, Severity.CLARIFY, source="plan",
                field="time_range")
    if touches_data and config.max_range_days:
        if days is not None and days > config.max_range_days:
            run.add(ReasonCode.TIME_RANGE_EXCEEDS_LIMIT, Severity.CLARIFY,
                    field="time_range", detail=str(days))
        elif days is None:
            constraints.time_window_days_max = config.max_range_days
            run.add(ReasonCode.TIME_RANGE_DEFAULTED, Severity.WARNING, field="time_range")

    if Capability.DEEP_SCAN in usable:
        constraints.deep_scan_max_records = config.scan_deep_max
        constraints.deep_scan_max_days = config.deep_scan_max_days
        if days is None:
            run.add(ReasonCode.TIME_RANGE_REQUIRED, Severity.CLARIFY,
                    capability=Capability.DEEP_SCAN, field="time_range")
        elif days > config.deep_scan_max_days:
            run.add(ReasonCode.TIME_RANGE_EXCEEDS_LIMIT, Severity.CLARIFY,
                    capability=Capability.DEEP_SCAN, field="time_range", detail=str(days))
    if any(c in usable for c in _SCAN_CAPS):
        # The scan's own caps, stated so the orchestrator cannot forget them:
        # an unknown concept is searched within a window, never the database.
        constraints.max_window_records = config.scan_window_max
        constraints.recall_pool = config.scan_recall_pool
        constraints.judge_pool = config.scan_judge_pool
        if days is None:
            run.add(ReasonCode.BOUNDED_BY_RECORD_CAP, Severity.INFO,
                    capability=Capability.UNKNOWN_CONCEPT_SEARCH
                    if Capability.UNKNOWN_CONCEPT_SEARCH in usable else None)
    if Capability.TREND_ANALYSIS in usable and tr.kind is TimeKind.ALL_TIME:
        constraints.trend_default_window_days = config.trend_default_window_days
        run.add(ReasonCode.TIME_RANGE_DEFAULTED, Severity.INFO,
                capability=Capability.TREND_ANALYSIS, field="time_range")
    if plan.location is not None and Capability.LOCATION_RESOLVE not in usable:
        constraints.location_as_free_text = True
    constraints.soft_filters = sorted({f.field.value for f in plan.filters
                                       if f.source is Source.LLM})
    run.rule("bounds", "apply")

    # 8. context the gate cannot supply --------------------------------------
    unresolved = [r for r in plan.referents if not r.resolved]
    if plan.intent is Intent.FOLLOW_UP and unresolved:
        # Conversation state (Phase 1C) resolves these. Until it exists a
        # follow-up has no subject, and guessing one is query rewriting.
        run.add(ReasonCode.CONTEXT_REQUIRED, Severity.CLARIFY, source="plan",
                field="referents")
    elif unresolved:
        run.add(ReasonCode.REFERENT_UNRESOLVED, Severity.WARNING, source="plan",
                field="referents")
    for c in plan.conflicts:
        run.add(ReasonCode.PLANNER_CONFLICT, Severity.WARNING, source="plan", field=c.field)
    run.rule("context", "clarify" if unresolved and plan.intent is Intent.FOLLOW_UP else "pass")

    subs = [u for u in units if u.index is not None]
    return _finish(run, ctx, config, plan=plan, mode=mode, effective=effective,
                   scope_summary=scope_summary, constraints=constraints, sub_units=subs)


def evaluate_raw(plan_data, ctx: RequestContext, **kw) -> PolicyResult:
    """For a plan arriving as data (a dev endpoint, a replay). A plan that
    does not parse — an unknown key such as ``tenant_id``, a bad enum — is
    refused as a policy decision rather than raised, so the refusal is
    auditable like any other."""
    if isinstance(plan_data, QueryPlan):
        return evaluate(plan_data, ctx, **kw)
    try:
        plan = QueryPlan.model_validate(plan_data)
    except ValidationError as exc:
        config = kw.get("config") or PolicyConfig.from_env()
        run = _Run()
        code = scope_mod.check_tenant(ctx, kw.get("requested_tenant_id"))
        if code:
            run.add(code, Severity.ERROR, source="context")
        fields = sorted({".".join(str(p) for p in e.get("loc", ())) or "plan"
                         for e in exc.errors()})
        for f in fields[:10]:
            run.add(ReasonCode.INVALID_PLAN, Severity.ERROR, source="plan", field=f[:64])
        run.rule("plan_parse", "fail")
        return _finish(run, ctx, config, plan=None, mode=None, effective=[],
                       scope_summary="plan-denied")
    return evaluate(plan, ctx, **kw)
