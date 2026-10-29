"""
Phase 1B — Policy / Capability Gate.

Security invariants are asserted as properties over the whole golden set where
they can be, not just on one hand-picked example: a gate that holds on the
case someone thought of and fails on the one they did not is not a gate.

Nothing here touches a database, a model or the network. The invariant tests
make sure of that by booby-trapping every client the gate could reach for.
"""

import ast
import inspect
import json
import os
import re
import statistics
import time

import pytest
from pydantic import ValidationError

import policy
from policy import (CAPABILITIES, ESSENTIAL, PERM_AI_CHAT, PERM_AI_DEEP_SCAN,
                    Capability, PolicyConfig, PolicyDecision, ReasonCode,
                    RequestContext, Severity, evaluate, evaluate_raw,
                    permissions_from_rbac)
from policy import scope as scope_mod
from query_understanding import understand
from query_understanding import deterministic
from query_understanding import tools as qu_tools
from query_understanding.models import (Filter, FilterField, Intent, Location,
                                        LocationType, Need, QueryPlan, Shape,
                                        Source, SubQuestion, TimeKind, TimeRange)

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "query_understanding", "golden_queries.json"), encoding="utf-8") as fh:
    GOLDEN = json.load(fh)
GOLDEN_QUERIES = [c["query"] for c in GOLDEN["queries"]]

CFG = PolicyConfig()     # defaults, independent of the test machine's env
T = "tenant-alpha"

ADMIN = RequestContext(tenant_id=T, user_id="u-admin", role="admin")
SUPERADMIN = RequestContext(tenant_id=T, user_id="u-sa", role="superadmin")
OFFICER = RequestContext(tenant_id=T, user_id="u-hyd", role="level-1",
                         districts=["Hyderabad"], permissions=frozenset({PERM_AI_CHAT}))
OFFICER_TWO = RequestContext(tenant_id=T, user_id="u-2", role="level-1",
                             districts=["Hyderabad", "Warangal"],
                             permissions=frozenset({PERM_AI_CHAT}))
OFFICER_NO_PERM = RequestContext(tenant_id=T, user_id="u-np", role="level-1",
                                 districts=["Hyderabad"])
OFFICER_EMPTY = RequestContext(tenant_id=T, user_id="u-e", role="level-1",
                               districts=[], permissions=frozenset({PERM_AI_CHAT}))


def plan_of(q):
    return understand(q)[0]


def ev(q_or_plan, ctx, **kw):
    plan = plan_of(q_or_plan) if isinstance(q_or_plan, str) else q_or_plan
    return evaluate(plan, ctx, config=kw.pop("config", CFG), **kw)


def codes(result):
    return {r.code for r in result.reasons}


def search_plan(**over):
    """A minimal, valid filtered-search plan to mutate."""
    base = dict(raw_query="negative posts", normalized_query="negative posts",
                intent=Intent.FILTERED_SEARCH, shape=Shape.FILTERED,
                filters=[Filter(field=FilterField.SENTIMENT, value="negative")],
                needs=[Need.SEARCH, Need.EVIDENCE], required_tools=["hybrid_search"])
    base.update(over)
    return QueryPlan(**base)


# =========================================================================== #
# tenant
# =========================================================================== #

class TestTenant:
    def test_missing_tenant_is_denied(self):
        r = ev("negative posts", RequestContext(role="admin"))
        assert r.decision is PolicyDecision.DENIED
        assert codes(r) == {ReasonCode.TENANT_REQUIRED}
        assert r.allowed_capabilities == [] and r.effective_districts == []

    @pytest.mark.parametrize("tid", ["", "   ", None])
    def test_blank_tenant_is_denied(self, tid):
        assert ev("negative posts", RequestContext(tenant_id=tid, role="admin")).decision \
            is PolicyDecision.DENIED

    @pytest.mark.parametrize("tid", ["*", "all", "ALL", "any", "null", "None",
                                     "undefined", "a.b", "$ne", "t1/../t2", "x y"])
    def test_wildcards_never_mean_every_tenant(self, tid):
        r = ev("negative posts", RequestContext(tenant_id=tid, role="admin"))
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.TENANT_INVALID in codes(r)

    def test_tenant_present_and_valid_is_allowed(self):
        assert ev("negative posts", ADMIN).decision is PolicyDecision.ALLOWED

    def test_cross_tenant_is_denied_even_for_admin(self):
        r = ev("negative posts", ADMIN, requested_tenant_id="tenant-beta")
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.TENANT_MISMATCH in codes(r)
        assert ev("negative posts", ADMIN, requested_tenant_id=T).decision \
            is PolicyDecision.ALLOWED

    def test_query_plan_has_no_tenant_field(self):
        with pytest.raises(ValidationError):
            QueryPlan(raw_query="x", normalized_query="x", tenant_id="tenant-beta")
        assert "tenant_id" not in QueryPlan.model_fields

    @pytest.mark.parametrize("smuggle", [
        {"tenant_id": "tenant-beta"},
        {"tenant": "*"},
        {"districts": None},
        {"authorized": True},
        {"role": "admin"},
        {"allowed_districts": ["Warangal"]},
    ])
    def test_plan_data_carrying_authority_is_refused(self, smuggle):
        data = search_plan().model_dump(mode="json")
        data.update(smuggle)
        r = evaluate_raw(data, OFFICER, config=CFG)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.INVALID_PLAN in codes(r)
        assert r.allowed_capabilities == []

    def test_plan_asserting_tenant_scope_optional_is_refused(self):
        data = search_plan().model_dump(mode="json")
        data["metadata"]["tenant_scope_required"] = False
        r = evaluate_raw(data, ADMIN, config=CFG)
        assert r.decision is PolicyDecision.DENIED

    def test_unparseable_plan_still_reports_the_tenant_failure(self):
        r = evaluate_raw({"garbage": 1}, RequestContext(role="admin"), config=CFG)
        assert {ReasonCode.TENANT_REQUIRED, ReasonCode.INVALID_PLAN} <= codes(r)


# =========================================================================== #
# district
# =========================================================================== #

class TestDistrict:
    def test_named_district_in_scope_is_allowed(self):
        ctx = OFFICER.model_copy(update={"districts": ["Karimnagar"]})
        r = ev("negative posts about corruption in Karimnagar", ctx)
        assert r.decision in (PolicyDecision.ALLOWED, PolicyDecision.DEGRADED)
        assert r.effective_districts == ["Karimnagar"]

    def test_named_district_outside_scope_is_refused_not_substituted(self):
        r = ev("alerts in Karimnagar", OFFICER)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.DISTRICT_OUTSIDE_SCOPE in codes(r)
        # Never quietly answered about the officer's own district instead.
        assert r.effective_districts == []
        assert r.allowed_capabilities == []

    def test_district_filter_outside_scope_is_refused_whatever_its_source(self):
        for source in (Source.EXPLICIT, Source.LLM, Source.DETERMINISTIC):
            plan = search_plan(filters=[Filter(field=FilterField.DISTRICT,
                                               value="Warangal", source=source)])
            r = ev(plan, OFFICER)
            assert r.decision is PolicyDecision.DENIED, source
            assert ReasonCode.DISTRICT_OUTSIDE_SCOPE in codes(r)

    def test_district_filter_list_with_one_outsider_is_refused(self):
        plan = search_plan(filters=[Filter(field=FilterField.DISTRICT, operator="in",
                                           value=["Hyderabad", "Warangal"])])
        assert ev(plan, OFFICER).decision is PolicyDecision.DENIED
        assert ev(plan, OFFICER_TWO).decision is PolicyDecision.ALLOWED

    def test_district_match_is_case_and_space_insensitive(self):
        ctx = OFFICER.model_copy(update={"districts": ["  RANGA   Reddy "]})
        plan = search_plan(filters=[Filter(field=FilterField.DISTRICT, value="ranga reddy")])
        r = ev(plan, ctx)
        assert r.decision is PolicyDecision.ALLOWED

    def test_empty_districts_match_nothing(self):
        r = ev("negative posts", OFFICER_EMPTY)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.DISTRICT_SCOPE_EMPTY in codes(r)
        assert r.effective_districts == []

    def test_empty_districts_do_not_block_a_conversation(self):
        r = ev("hi", OFFICER_EMPTY)
        assert r.decision is PolicyDecision.ALLOWED
        assert r.allowed_capabilities == []

    def test_blank_district_entries_collapse_to_nothing_not_everything(self):
        ctx = RequestContext(tenant_id=T, role="level-1", districts=[" ", ""],
                             permissions=frozenset({PERM_AI_CHAT}))
        assert ctx.districts == []
        assert ev("negative posts", ctx).decision is PolicyDecision.DENIED

    def test_none_districts_are_unrestricted_only_for_admin(self):
        r = ev("negative posts", ADMIN)
        assert r.decision is PolicyDecision.ALLOWED and r.effective_districts is None

    @pytest.mark.parametrize("ctx", [
        RequestContext(tenant_id=T, role="level-1", permissions=frozenset({PERM_AI_CHAT})),
        # districtsFor() never sends null for a superadmin; neither does this.
        SUPERADMIN,
    ])
    def test_none_districts_without_authority_is_denied(self, ctx):
        r = ev("negative posts", ctx)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.DISTRICT_SCOPE_REQUIRED in codes(r)

    @pytest.mark.parametrize("bad", [["*"], ["Hyderabad", "__none__"], ["ALL"]])
    def test_wildcard_districts_are_invalid(self, bad):
        ctx = OFFICER.model_copy(update={"districts": bad})
        r = ev("negative posts", ctx)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.DISTRICT_SCOPE_INVALID in codes(r)

    def test_caller_selection_is_narrowed_and_flagged(self):
        r = ev("negative posts", OFFICER_TWO, requested_districts=["Hyderabad", "Karimnagar"])
        assert r.decision is PolicyDecision.DEGRADED
        assert ReasonCode.SCOPE_NARROWED in codes(r)
        assert r.effective_districts == ["Hyderabad"]

    def test_caller_selection_entirely_outside_scope_is_refused(self):
        r = ev("negative posts", OFFICER, requested_districts=["Karimnagar"])
        assert r.decision is PolicyDecision.DENIED
        assert r.effective_districts == []

    def test_admin_selection_narrows_admin_scope(self):
        r = ev("negative posts", ADMIN, requested_districts=["Karimnagar"])
        assert r.decision is PolicyDecision.ALLOWED
        assert r.effective_districts == ["Karimnagar"]

    def test_statewide_question_is_narrowed_not_refused(self):
        r = ev("alerts in Telangana", OFFICER)
        assert r.decision is PolicyDecision.DEGRADED
        assert ReasonCode.SCOPE_NARROWED in codes(r)
        assert r.effective_districts == ["Hyderabad"]

    def test_unverifiable_place_is_flagged_and_still_confined(self):
        r = ev("negative posts in Banjara Hills", OFFICER)
        assert ReasonCode.LOCATION_SCOPE_UNVERIFIED in codes(r)
        assert r.decision is not PolicyDecision.DENIED
        assert r.effective_districts == ["Hyderabad"]

    def test_admin_may_name_any_district(self, planned):
        planned("location_resolve")
        r = ev("alerts in Karimnagar", ADMIN)
        assert r.decision is PolicyDecision.DEGRADED     # location_resolve not built
        assert r.effective_districts is None

    @pytest.mark.parametrize("ctx", [OFFICER, OFFICER_TWO])
    @pytest.mark.parametrize("requested", [None, ["Hyderabad"], ["Warangal", "Karimnagar"], []])
    def test_no_question_can_expand_district_scope(self, ctx, requested):
        """Property over the whole golden set: effective districts are always
        a subset of the caller's own."""
        own = set(ctx.districts)
        for q in GOLDEN_QUERIES:
            r = ev(q, ctx, requested_districts=requested)
            assert r.effective_districts is not None, q
            assert set(r.effective_districts) <= own, q


# =========================================================================== #
# role / permission
# =========================================================================== #

class TestPermissions:
    def test_missing_permission_is_denied(self):
        r = ev("negative posts", OFFICER_NO_PERM)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.PERMISSION_REQUIRED in codes(r)

    def test_granted_permission_is_allowed(self):
        assert ev("negative posts", OFFICER).decision is PolicyDecision.ALLOWED

    def test_admin_roles_bypass_feature_checks_like_rbac_middleware(self):
        sa = SUPERADMIN.model_copy(update={"districts": ["Hyderabad"]})
        for ctx in (ADMIN, sa):
            assert ctx.permissions == frozenset()
            assert ev("negative posts", ctx).decision is PolicyDecision.ALLOWED

    @pytest.mark.parametrize("role", [None, "", "sho", "SI", "ADMIN", "commissioner", "root"])
    def test_unknown_role_holds_nothing(self, role):
        ctx = RequestContext(tenant_id=T, role=role, districts=["Hyderabad"],
                             permissions=frozenset({PERM_AI_CHAT, PERM_AI_DEEP_SCAN}))
        r = ev("negative posts", ctx)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.ROLE_NOT_PERMITTED in codes(r)

    def test_admin_cannot_be_claimed_separately_from_role(self):
        with pytest.raises(ValidationError):
            RequestContext(tenant_id=T, role="level-1", is_admin=True)

    def test_rbac_flattening_mirrors_has_feature_access(self):
        perms = permissions_from_rbac({
            "/ai-assistant": {"enabled": True, "features": ["ai_chat"]},
            "/alerts": {"enabled": False, "features": ["active"]},
            "reports/": {"enabled": True, "features": ["x"]},
            "/junk": "not-a-dict",
        })
        assert perms == frozenset({"/ai-assistant:ai_chat", "/reports:x"})

    def test_disabled_page_grants_nothing(self):
        perms = permissions_from_rbac({"/ai-assistant": {"enabled": False,
                                                         "features": ["ai_chat"]}})
        ctx = OFFICER.model_copy(update={"permissions": perms})
        assert ev("negative posts", ctx).decision is PolicyDecision.DENIED

    def test_permissions_are_configuration_not_code(self):
        tight = CFG.with_(capability_permissions={
            **CFG.capability_permissions,
            Capability.UNKNOWN_CONCEPT_SEARCH: "/ai-assistant:ai_concepts"})
        r = ev("posts about ration card problems", OFFICER, config=tight)
        assert Capability.UNKNOWN_CONCEPT_SEARCH in r.blocked_capabilities


# =========================================================================== #
# capabilities
# =========================================================================== #

class TestCapabilities:
    def test_registry_matches_phase_1a_tools_exactly(self):
        assert {c.value for c in Capability} == set(qu_tools.TOOL_NAMES)
        assert set(CAPABILITIES) == set(Capability)
        for cap, spec in CAPABILITIES.items():
            assert spec.available == (qu_tools.REGISTRY[cap.value].status == "available")

    def test_every_capability_has_a_permission(self):
        assert set(CFG.capability_permissions) == set(Capability)
        assert all(CFG.capability_permissions.values())

    @pytest.mark.parametrize("intent", list(Intent))
    @pytest.mark.parametrize("loc", [False, True])
    @pytest.mark.parametrize("concept", [False, True])
    def test_gate_accepts_every_capability_the_planner_can_emit(self, intent, loc, concept):
        """Parity with deterministic._needs_for: a correct plan is never
        refused for a registry mapping error."""
        needs = deterministic._needs_for(intent, {"unresolved_location": loc,
                                                  "unresolved_concept": concept})
        for name in qu_tools.tools_for(needs):
            assert intent in CAPABILITIES[Capability(name)].allowed_intents, (intent, name)
        essential = ESSENTIAL[intent]
        assert essential <= {Capability(n) for n in qu_tools.tools_for(needs)}, intent

    def test_gate_raises_no_structural_objection_to_any_golden_plan(self):
        structural = {ReasonCode.INVALID_PLAN, ReasonCode.UNSAFE_PLAN,
                      ReasonCode.UNKNOWN_TOOL, ReasonCode.CAPABILITY_NOT_ALLOWED}
        for q in GOLDEN_QUERIES:
            assert not codes(ev(q, ADMIN)) & structural, q

    def test_unknown_tool_is_denied(self):
        plan = search_plan(required_tools=["hybrid_search", "delete_database"])
        r = ev(plan, ADMIN)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.UNKNOWN_TOOL in codes(r) or ReasonCode.INVALID_PLAN in codes(r)
        assert r.allowed_capabilities == []

    def test_unknown_tool_is_denied_by_the_gate_itself(self):
        """Even if the validator were bypassed, the gate refuses on its own."""
        from policy import evaluator
        unit = evaluator._Unit(None, Intent.FILTERED_SEARCH, [Need.SEARCH],
                               ["hybrid_search", "delete_database"], None, [])
        run = evaluator._Run()
        evaluator._check_unit(unit, ADMIN, CFG, run)
        assert ReasonCode.UNKNOWN_TOOL in {r.code for r in run.reasons}

    def test_tool_not_justified_by_needs_is_unsafe(self):
        # The model cannot add deep_scan to a search by naming it.
        plan = search_plan(required_tools=["hybrid_search", "deep_scan"])
        r = ev(plan, ADMIN)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.UNSAFE_PLAN in codes(r)
        assert Capability.DEEP_SCAN not in r.allowed_capabilities

    def test_need_incompatible_with_intent_is_not_allowed(self):
        plan = search_plan(needs=[Need.SEARCH, Need.DEEP_SCAN, Need.EVIDENCE],
                           required_tools=["hybrid_search", "deep_scan"])
        r = ev(plan, ADMIN)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.CAPABILITY_NOT_ALLOWED in codes(r)

    def test_related_content_cannot_be_smuggled_in(self):
        plan = search_plan(required_tools=["hybrid_search", "related_content_search"])
        r = ev(plan, ADMIN)
        assert r.decision is PolicyDecision.DENIED
        assert Capability.RELATED_CONTENT_SEARCH in r.blocked_capabilities

    def test_disabled_essential_capability_is_denied(self):
        cfg = CFG.with_(disabled_capabilities=frozenset({Capability.HYBRID_SEARCH}))
        r = ev("negative posts", ADMIN, config=cfg)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.CAPABILITY_DISABLED in codes(r)

    def test_disabled_optional_capability_degrades(self):
        cfg = CFG.with_(disabled_capabilities=frozenset({Capability.UNKNOWN_CONCEPT_SEARCH}))
        r = ev("Show me posts about traffic police.", ADMIN, config=cfg)
        assert r.decision is PolicyDecision.DEGRADED
        assert Capability.HYBRID_SEARCH in r.allowed_capabilities
        assert Capability.UNKNOWN_CONCEPT_SEARCH in r.blocked_capabilities

    def test_disabled_capabilities_read_from_env(self, monkeypatch):
        monkeypatch.setenv("AI_POLICY_DISABLED_CAPABILITIES", "deep_scan, not_a_tool ,aggregate")
        cfg = PolicyConfig.from_env()
        assert cfg.disabled_capabilities == {Capability.DEEP_SCAN, Capability.AGGREGATE}
        assert cfg.fingerprint() != CFG.fingerprint()

    def test_unavailable_essential_capability_is_denied(self, planned):
        planned("compare_results", "location_resolve")
        r = ev("Compare Hyderabad and Cyberabad.", ADMIN)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.CAPABILITY_UNAVAILABLE in codes(r)
        assert Capability.COMPARE_RESULTS in r.blocked_capabilities


# =========================================================================== #
# plan validity
# =========================================================================== #

class TestPlanValidity:
    def test_aggregation_with_nothing_to_count_is_denied(self):
        plan = search_plan(intent=Intent.AGGREGATION, shape=Shape.ANALYTICAL,
                           needs=[Need.AGGREGATION], required_tools=["aggregate"])
        r = ev(plan, ADMIN)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.INVALID_PLAN in codes(r)

    def test_unsupported_metric_is_denied(self):
        plan = search_plan(intent=Intent.AGGREGATION, shape=Shape.ANALYTICAL,
                           metric="average", needs=[Need.AGGREGATION],
                           required_tools=["aggregate"])
        r = ev(plan, ADMIN)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.UNSUPPORTED_METRIC in codes(r)

    def test_unsupported_grouping_is_denied(self):
        plan = search_plan(intent=Intent.AGGREGATION, shape=Shape.ANALYTICAL,
                           metric="count", group_by=["author_email"],
                           needs=[Need.AGGREGATION], required_tools=["aggregate"])
        r = ev(plan, ADMIN)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.UNSUPPORTED_GROUPING in codes(r)

    def test_intent_without_its_defining_capability_is_invalid(self):
        plan = search_plan(intent=Intent.AGGREGATION, shape=Shape.ANALYTICAL,
                           metric="count")      # needs say search, intent says count
        r = ev(plan, ADMIN)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.INVALID_PLAN in codes(r)

    def _trend(self, **over):
        base = dict(intent=Intent.TREND_ANALYSIS, shape=Shape.TREND, metric="count",
                    needs=[Need.TREND_ANALYSIS, Need.AGGREGATION, Need.EVIDENCE],
                    required_tools=["trend_analysis", "aggregate"])
        base.update(over)
        return search_plan(**base)

    def test_trend_with_unsupported_metric_is_denied(self):
        assert ev(self._trend(metric="share"), ADMIN).decision is PolicyDecision.DENIED

    def test_trend_with_unresolved_time_needs_clarification(self):
        r = ev(self._trend(time_range=TimeRange(kind=TimeKind.UNRESOLVED, raw="around diwali")),
               ADMIN)
        assert r.decision is PolicyDecision.CLARIFICATION_REQUIRED
        assert ReasonCode.TIME_RANGE_UNRESOLVED in codes(r)

    def test_trend_without_a_range_uses_the_analytics_default(self):
        r = ev(self._trend(), ADMIN)
        assert r.decision is PolicyDecision.ALLOWED
        assert r.constraints.trend_default_window_days == 30
        assert ReasonCode.TIME_RANGE_DEFAULTED in codes(r)

    def test_multi_part_with_one_part_is_invalid(self):
        sub = SubQuestion(index=0, text="x", intent=Intent.AGGREGATION, shape=Shape.ANALYTICAL,
                          needs=[Need.AGGREGATION], required_tools=["aggregate"], metric="count")
        plan = search_plan(intent=Intent.MULTI_PART, shape=Shape.MULTI_PART, sub_questions=[sub])
        assert ev(plan, ADMIN).decision is PolicyDecision.DENIED

    def test_general_range_cap_is_off_unless_configured(self):
        plan = search_plan(time_range=TimeRange(kind=TimeKind.LAST_N_DAYS, n=365))
        assert ev(plan, ADMIN).decision is PolicyDecision.ALLOWED
        capped = CFG.with_(max_range_days=90)
        r = ev(plan, ADMIN, config=capped)
        assert r.decision is PolicyDecision.CLARIFICATION_REQUIRED
        assert ReasonCode.TIME_RANGE_EXCEEDS_LIMIT in codes(r)


# =========================================================================== #
# time is classified, never resolved
# =========================================================================== #

class TestTime:
    @pytest.mark.parametrize("tr,days", [
        (TimeRange(kind=TimeKind.TODAY), 1),
        (TimeRange(kind=TimeKind.LAST_N_HOURS, n=24), 1),
        (TimeRange(kind=TimeKind.LAST_N_HOURS, n=25), 2),
        (TimeRange(kind=TimeKind.LAST_N_DAYS, n=7), 7),
        (TimeRange(kind=TimeKind.LAST_N_WEEKS, n=2), 14),
        (TimeRange(kind=TimeKind.LAST_N_MONTHS, n=1), 31),
        (TimeRange(kind=TimeKind.LAST_MONTH), 31),
        (TimeRange(kind=TimeKind.ALL_TIME), None),
        (TimeRange(kind=TimeKind.UNRESOLVED), None),
    ])
    def test_window_size(self, tr, days):
        assert scope_mod.window_days(tr) == days

    def test_relative_time_passes_through_unresolved(self):
        r = ev("negative posts from yesterday", ADMIN)
        tr = r.constraints.time_range
        assert tr.kind is TimeKind.YESTERDAY
        assert tr.start is None and tr.end is None and tr.resolved is False


# =========================================================================== #
# high-risk capabilities
# =========================================================================== #

class TestHighRisk:
    DEEP_7 = "deep scan posts from last 7 days for communal content"

    def test_deep_scan_without_permission_is_denied(self):
        r = ev(self.DEEP_7, OFFICER)             # has ai_chat, not ai_deep_scan
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.PERMISSION_REQUIRED in codes(r)

    def test_deep_scan_with_explicit_permission_is_allowed(self):
        ctx = OFFICER.model_copy(update={"permissions": frozenset({PERM_AI_CHAT, PERM_AI_DEEP_SCAN})})
        r = ev(self.DEEP_7, ctx)
        assert r.decision is PolicyDecision.ALLOWED
        assert r.constraints.deep_scan_max_records == CFG.scan_deep_max
        assert r.constraints.deep_scan_max_days == 31

    def test_deep_scan_needs_a_bounded_range(self):
        r = ev("deep scan all posts for communal content", ADMIN)
        assert r.decision is PolicyDecision.CLARIFICATION_REQUIRED
        assert ReasonCode.TIME_RANGE_REQUIRED in codes(r)
        assert r.allowed_capabilities == []

    def test_deep_scan_range_is_capped(self):
        r = ev("deep scan posts from last 90 days for communal content", ADMIN)
        assert r.decision is PolicyDecision.CLARIFICATION_REQUIRED
        assert ReasonCode.TIME_RANGE_EXCEEDS_LIMIT in codes(r)

    def test_unknown_concept_without_permission_is_denied(self):
        r = ev("posts about ration card problems", OFFICER_NO_PERM)
        assert r.decision is PolicyDecision.DENIED
        assert Capability.UNKNOWN_CONCEPT_SEARCH in r.blocked_capabilities

    def test_unknown_concept_is_always_bounded(self):
        r = ev("posts about ration card problems", ADMIN)
        assert r.decision is PolicyDecision.ALLOWED
        assert r.constraints.max_window_records == CFG.scan_window_max
        assert r.constraints.judge_pool == CFG.scan_judge_pool
        assert ReasonCode.BOUNDED_BY_RECORD_CAP in codes(r)

    def test_high_risk_set(self):
        assert set(policy.registry.high_risk()) == {
            Capability.DEEP_SCAN, Capability.UNKNOWN_CONCEPT_SEARCH,
            Capability.TREND_ANALYSIS, Capability.RELATED_CONTENT_SEARCH}

    def test_limits_are_reused_not_restated(self):
        """The gate's defaults are the executing modules' defaults."""
        import analytics
        import scan
        assert CFG.scan_window_max == scan.WINDOW_MAX
        assert CFG.scan_recall_pool == scan.RECALL_POOL
        assert CFG.scan_judge_pool == scan.JUDGE_POOL
        assert CFG.scan_deep_max == scan.DEEP_MAX
        days = inspect.signature(analytics.compare_windows).parameters["days"].default
        assert CFG.trend_default_window_days == days
        assert set(analytics.GROUPABLE) <= CFG.supported_group_by


# =========================================================================== #
# degraded / clarification
# =========================================================================== #

class TestDegradedAndClarification:
    def test_optional_capability_unavailable_degrades(self, planned):
        planned("situation_analysis")
        r = ev("what is happening with traffic?", ADMIN)
        assert r.decision is PolicyDecision.DEGRADED
        assert Capability.SITUATION_ANALYSIS in r.blocked_capabilities
        assert Capability.HYBRID_SEARCH in r.allowed_capabilities

    def test_location_falls_back_to_free_text(self, planned):
        planned("location_resolve")
        r = ev("alerts in Hyderabad", ADMIN)
        assert r.decision is PolicyDecision.DEGRADED
        assert r.constraints.location_as_free_text is True
        assert ReasonCode.LOCATION_AMBIGUOUS in codes(r)

    def test_follow_up_without_context_asks(self):
        r = ev("What about the previous week?", ADMIN)
        assert r.decision is PolicyDecision.CLARIFICATION_REQUIRED
        assert ReasonCode.CONTEXT_REQUIRED in codes(r)

    def test_uninterpretable_input_asks(self):
        r = ev("xyzabc123", ADMIN)
        assert r.decision is PolicyDecision.CLARIFICATION_REQUIRED
        assert ReasonCode.PLAN_EMPTY in codes(r)

    def test_conversation_is_allowed_with_nothing_to_run(self):
        r = ev("hi", OFFICER)
        assert r.decision is PolicyDecision.ALLOWED and r.allowed_capabilities == []

    @pytest.mark.parametrize("ctx", [ADMIN, OFFICER, OFFICER_NO_PERM, OFFICER_EMPTY])
    def test_only_runnable_decisions_carry_capabilities(self, ctx):
        for q in GOLDEN_QUERIES:
            r = ev(q, ctx)
            if r.allowed_capabilities:
                assert r.decision in (PolicyDecision.ALLOWED, PolicyDecision.DEGRADED), q
            if r.decision is PolicyDecision.DENIED:
                assert r.allowed_capabilities == [] and r.constraints is None, q
            # Blocked and allowed never overlap.
            assert not set(r.allowed_capabilities) & set(r.blocked_capabilities), q

    def test_decision_is_exactly_the_worst_reason(self):
        for q in GOLDEN_QUERIES:
            for ctx in (ADMIN, OFFICER, OFFICER_NO_PERM):
                r = ev(q, ctx)
                assert r.decision is policy.decide(r.reasons), q


# =========================================================================== #
# multi-part
# =========================================================================== #

class TestMultiPart:
    def test_each_part_is_evaluated(self):
        r = ev("How many complaints are there, what are people saying, and "
               "which areas are affected?", OFFICER)
        assert len(r.sub_decisions) >= 2
        assert all(s.capabilities for s in r.sub_decisions)
        assert r.constraints.partial_execution is False

    def _mixed(self):
        ok = SubQuestion(index=0, text="how many alerts", intent=Intent.AGGREGATION,
                         shape=Shape.ANALYTICAL, needs=[Need.AGGREGATION],
                         required_tools=["aggregate"], metric="count")
        bad = SubQuestion(index=1, text="alerts in Warangal", intent=Intent.FILTERED_SEARCH,
                          shape=Shape.FILTERED, needs=[Need.SEARCH],
                          required_tools=["hybrid_search"],
                          filters=[Filter(field=FilterField.DISTRICT, value="Warangal")])
        ok2 = ok.model_copy(update={"index": 2, "text": "how many posts"})
        return search_plan(intent=Intent.MULTI_PART, shape=Shape.MULTI_PART,
                           needs=[Need.AGGREGATION, Need.SEARCH, Need.EVIDENCE],
                           required_tools=["aggregate", "hybrid_search"],
                           sub_questions=[ok, bad, ok2])

    def test_one_denied_part_denies_the_whole_plan(self):
        r = ev(self._mixed(), OFFICER)
        assert r.decision is PolicyDecision.DENIED
        by_index = {s.index: s.decision for s in r.sub_decisions}
        assert by_index == {0: PolicyDecision.ALLOWED, 1: PolicyDecision.DENIED,
                            2: PolicyDecision.ALLOWED}
        # No partial execution: nothing is runnable.
        assert r.allowed_capabilities == [] and r.effective_districts == []

    def test_the_same_plan_is_allowed_where_every_part_is(self):
        assert ev(self._mixed(), OFFICER_TWO).decision is PolicyDecision.ALLOWED

    def test_a_tampered_part_denies_the_plan(self):
        plan = self._mixed()
        subs = list(plan.sub_questions)
        subs[0] = subs[0].model_copy(update={"required_tools": ["aggregate", "deep_scan"]})
        r = ev(plan.model_copy(update={"sub_questions": subs}), ADMIN)
        assert r.decision is PolicyDecision.DENIED
        assert ReasonCode.UNSAFE_PLAN in codes(r)


# =========================================================================== #
# multilingual: the gate reads structure, never language
# =========================================================================== #

class TestMultilingual:
    TEXTS = ["కరీంనగర్‌లో ఏం జరుగుతోంది", "हैदराबाद में क्या हो रहा है",
             "Karimnagar lo em jarugutondi", "negative posts about corruption"]

    @pytest.mark.parametrize("q", ["alerts in Karimnagar", "negative posts about corruption",
                                   "Are complaints increasing?", "deep scan all posts for communal content"])
    @pytest.mark.parametrize("ctx", [ADMIN, OFFICER])
    def test_same_plan_in_any_language_gets_the_same_decision(self, q, ctx):
        plan = plan_of(q)
        base = ev(plan, ctx).model_dump(mode="json")
        for text in self.TEXTS:
            other = plan.model_copy(update={"raw_query": text, "normalized_query": text})
            assert ev(other, ctx).model_dump(mode="json") == base

    def test_multilingual_golden_queries_never_widen_scope(self):
        for case in GOLDEN["queries"]:
            if not case["id"].startswith("ml-"):
                continue
            r = ev(case["query"], OFFICER)
            assert r.effective_districts is not None
            assert set(r.effective_districts) <= {"Hyderabad"}
            assert not codes(r) & {ReasonCode.INVALID_PLAN, ReasonCode.UNSAFE_PLAN}


# =========================================================================== #
# invariants: no execution, no data, no answer, no model, deterministic
# =========================================================================== #

FORBIDDEN_IMPORTS = {"pymongo", "requests", "httpx", "llm_client", "retriever", "scan",
                     "engine", "analytics", "vector_store", "embedder", "reranker",
                     "judge", "expander", "tenants", "api_server", "motor", "openai"}


class TestInvariants:
    def test_policy_package_imports_no_execution_or_data_module(self):
        pkg = os.path.join(HERE, "policy")
        for name in os.listdir(pkg):
            if not name.endswith(".py"):
                continue
            tree = ast.parse(open(os.path.join(pkg, name), encoding="utf-8").read())
            for node in ast.walk(tree):
                mods = []
                if isinstance(node, ast.Import):
                    mods = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0:
                    mods = [node.module or ""]
                for m in mods:
                    assert m.split(".")[0] not in FORBIDDEN_IMPORTS, (name, m)

    def test_gate_runs_with_every_client_booby_trapped(self, monkeypatch):
        import llm_client
        import pymongo
        import requests

        def boom(*a, **k):
            raise AssertionError("the policy gate reached for I/O")
        monkeypatch.setattr(pymongo, "MongoClient", boom)
        monkeypatch.setattr(requests, "post", boom)
        monkeypatch.setattr(requests, "get", boom)
        monkeypatch.setattr(requests, "request", boom)
        monkeypatch.setattr(llm_client, "generate", boom)
        plans = [plan_of(q) for q in GOLDEN_QUERIES]
        for plan in plans:
            for ctx in (ADMIN, OFFICER, OFFICER_EMPTY):
                evaluate(plan, ctx, config=CFG)

    def test_result_has_no_answer(self):
        fields = set(policy.PolicyResult.model_fields)
        assert not fields & {"answer", "results", "records", "evidence", "rows", "summary"}

    def test_llm_cannot_authorise_a_capability(self):
        """A plan the model shaped gets exactly the capabilities its needs
        derive — llm_used and LLM-sourced values add nothing."""
        plan = search_plan(filters=[Filter(field=FilterField.SENTIMENT, value="negative",
                                           source=Source.LLM, confidence=0.6)])
        plan.metadata.llm_used = True
        r = ev(plan, OFFICER)
        assert set(r.requested_capabilities) == {Capability(t) for t in qu_tools.tools_for(plan.needs)}
        assert r.constraints.soft_filters == ["sentiment"]

    def test_decision_is_deterministic(self):
        for q in GOLDEN_QUERIES:
            plan = plan_of(q)
            a = evaluate(plan, OFFICER, config=PolicyConfig()).model_dump_json()
            b = evaluate(plan, OFFICER, config=PolicyConfig()).model_dump_json()
            assert a == b, q

    def test_public_view_leaks_no_identifiers(self):
        secret = "tenant-9f3a-internal"
        ctx = OFFICER.model_copy(update={"tenant_id": secret})
        for q in ("alerts in Karimnagar", "negative posts", "deep scan all posts"):
            r = ev(q, ctx)
            pub = json.dumps(r.public())
            assert secret not in pub and "/ai-assistant" not in pub
            assert r.config_fingerprint not in pub
            # The internal result also carries only a hash of the tenant.
            assert secret not in r.model_dump_json()
            assert r.audit.tenant_ref and r.audit.tenant_ref != secret

    def test_every_reason_code_has_a_public_message(self):
        assert set(policy.PUBLIC_MESSAGES) == set(ReasonCode)

    def test_audit_mirrors_the_decision(self):
        r = ev("what is happening with traffic?", OFFICER)
        a = r.audit
        assert a.decision is r.decision
        assert a.allowed_capabilities == r.allowed_capabilities
        assert a.blocked_capabilities == r.blocked_capabilities
        assert a.reason_codes == r.reason_codes()
        assert a.policy_version == "policy-v1" and a.scope_decision.startswith("restricted")

    def test_trace_records_every_stage(self):
        r = ev("negative posts", OFFICER)
        assert [t.rule for t in r.trace] == ["tenant", "role", "district_mode", "plan_valid",
                                             "capabilities", "scope", "bounds", "context"]


# =========================================================================== #
# performance
# =========================================================================== #

def test_policy_evaluation_latency():
    plans = [plan_of(q) for q in GOLDEN_QUERIES]
    samples = []
    for _ in range(20):
        for plan in plans:
            t0 = time.perf_counter()
            evaluate(plan, OFFICER, config=CFG)
            samples.append((time.perf_counter() - t0) * 1000)
    samples.sort()
    p50 = statistics.median(samples)
    p95 = samples[int(len(samples) * 0.95)]
    assert p50 < 5, p50
    assert p95 < 15, p95


# =========================================================================== #
# development endpoint
# =========================================================================== #

@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient
    import api_server
    # No `with`: startup hooks (schedulers, DB) never run.
    return TestClient(api_server.app)


OFFICER_BODY = {"tenant_id": T, "role": "level-1", "districts": ["Hyderabad"],
                "permissions": {"/ai-assistant": {"enabled": True, "features": ["ai_chat"]}}}


class TestEndpoint:
    def test_off_by_default(self, client, monkeypatch):
        monkeypatch.delenv("AI_ASSISTANT_ARCHITECTURE_V2", raising=False)
        r = client.post("/api/rag/policy-check", json={**OFFICER_BODY, "question": "hi"})
        assert r.status_code == 404
        # The Phase 1A route keeps its own behaviour.
        assert client.post("/api/rag/query-plan",
                           json={"question": "hi", "tenant_id": T}).status_code == 404

    def test_policy_flag_switches_the_gate_route_off_alone(self, client, monkeypatch):
        monkeypatch.setenv("AI_ASSISTANT_ARCHITECTURE_V2", "true")
        monkeypatch.setenv("AI_POLICY_ENABLED", "false")
        r = client.post("/api/rag/policy-check", json={**OFFICER_BODY, "question": "hi"})
        assert r.status_code == 404

    @pytest.fixture
    def on(self, monkeypatch):
        monkeypatch.setenv("AI_ASSISTANT_ARCHITECTURE_V2", "true")
        monkeypatch.delenv("AI_POLICY_ENABLED", raising=False)
        monkeypatch.delenv("AI_POLICY_DISABLED_CAPABILITIES", raising=False)

    def test_tenant_required(self, client, on):
        body = {**OFFICER_BODY, "question": "negative posts"}
        body.pop("tenant_id")
        assert client.post("/api/rag/policy-check", json=body).status_code == 400

    @pytest.mark.parametrize("extra", [{}, {"question": "x", "query_plan": {}}])
    def test_exactly_one_subject(self, client, on, extra):
        r = client.post("/api/rag/policy-check", json={**OFFICER_BODY, **extra})
        assert r.status_code == 400

    def test_question_is_planned_then_gated(self, client, on):
        r = client.post("/api/rag/policy-check",
                        json={**OFFICER_BODY, "question": "alerts in Karimnagar"})
        assert r.status_code == 200
        body = r.json()
        assert body["policy"]["decision"] == "denied"
        assert body["public"]["decision"] == "denied"
        assert "DISTRICT_OUTSIDE_SCOPE" in [x["code"] for x in body["public"]["reasons"]]
        assert body["query_plan"]["intent"]
        assert "answer" not in body and "latency" in body

    def test_allowed_path(self, client, on):
        r = client.post("/api/rag/policy-check",
                        json={**OFFICER_BODY, "question": "negative posts about corruption"})
        assert r.json()["policy"]["decision"] == "allowed"
        assert r.json()["policy"]["effective_districts"] == ["Hyderabad"]

    def test_plan_smuggling_a_tenant_is_refused(self, client, on):
        data = search_plan().model_dump(mode="json")
        data["tenant_id"] = "tenant-beta"
        r = client.post("/api/rag/policy-check", json={**OFFICER_BODY, "query_plan": data})
        assert r.status_code == 200
        assert r.json()["policy"]["decision"] == "denied"

    def test_header_tenant_mismatch_is_refused(self, client, on):
        r = client.post("/api/rag/policy-check",
                        json={**OFFICER_BODY, "question": "negative posts"},
                        headers={"X-Tenant-Id": "tenant-beta"})
        assert r.json()["policy"]["decision"] == "denied"
        assert "TENANT_MISMATCH" in r.json()["policy"]["audit"]["reason_codes"]

    def test_null_districts_for_an_officer_are_not_unrestricted(self, client, on):
        body = {**OFFICER_BODY, "districts": None, "question": "negative posts"}
        r = client.post("/api/rag/policy-check", json=body)
        assert r.json()["policy"]["decision"] == "denied"


class TestPermissionShape:
    """The shape a harness reaches for by hand grants nothing, silently.

    A validation run reported every officer request as denied and nearly went
    out as a security failure. The cause was the harness: `{"/page": ["feature"]}`
    flattens to an empty grant, so the caller had no permissions at all.
    """

    def test_the_documented_shape_grants_what_it_lists(self):
        perms = permissions_from_rbac(
            {"/ai-assistant": {"enabled": True, "features": ["ai_chat", "ai_deep_scan"]}})
        assert perms == frozenset({"/ai-assistant:ai_chat", "/ai-assistant:ai_deep_scan"})

    def test_a_list_of_features_grants_nothing_and_says_so(self, caplog):
        import logging
        with caplog.at_level(logging.WARNING):
            perms = permissions_from_rbac({"/ai-assistant": ["ai_chat"]})
        assert perms == frozenset()
        assert any("grants nothing" in r.message or "grants nothing" in r.getMessage()
                   for r in caplog.records), "the misconfiguration was silent"

    def test_a_disabled_page_grants_nothing_however_it_is_written(self):
        assert permissions_from_rbac(
            {"/ai-assistant": {"enabled": False, "features": ["ai_chat"]}}) == frozenset()

    def test_no_permissions_at_all_is_not_an_error(self):
        assert permissions_from_rbac(None) == frozenset()
        assert permissions_from_rbac({}) == frozenset()

    def test_every_harness_in_this_repo_uses_the_working_shape(self):
        # The guard that would have caught it: a list-shaped grant anywhere in
        # the repo's own harnesses means that harness's results are wrong.
        import glob
        import os
        import re
        offenders = []
        # A PAGE mapped straight to a list: {"/page": [...]}. The inner
        # "features": [...] of the working shape must not trip this.
        pattern = re.compile(r'permissions_from_rbac\(\s*\{\s*"[^"]+"\s*:\s*\[', re.S)
        here = os.path.dirname(os.path.abspath(__file__))
        for path in glob.glob(os.path.join(here, "*.py")):
            with open(path, encoding="utf-8") as fh:
                body = fh.read()
            if pattern.search(body) and os.path.basename(path) != os.path.basename(__file__):
                offenders.append(os.path.basename(path))
        assert offenders == [], f"list-shaped rbac grants in {offenders}"


class TestNodeMirror:
    """The Python gate mirrors the Node middleware. Drift is authorization drift.

    Both sides decide who bypasses feature checks. If Node adds a full-access
    role and Python does not, an authorised officer is refused — annoying. If
    Python adds one and Node does not, an unauthorised caller is admitted —
    which is the direction that matters.
    """

    NODE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend",
                        "src", "middleware", "rbacMiddleware.js")

    def _node_source(self):
        if not os.path.exists(self.NODE):
            pytest.skip("the Node backend is not present in this checkout")
        with open(self.NODE, encoding="utf-8") as fh:
            return fh.read()

    def test_the_full_access_roles_are_the_same_on_both_sides(self):
        source = self._node_source()
        # The roles Node lets past its feature check, however the comparison is
        # written: req.user.role === 'x'.
        node_roles = set(re.findall(r"req\.user\.role\s*===\s*['\"]([a-z-]+)['\"]", source))
        bypass = {r for r in node_roles if r in {"admin", "superadmin"}}
        assert bypass, "could not read the bypass roles out of rbacMiddleware.js"
        assert bypass == set(CFG.admin_roles), (
            f"Node bypasses {sorted(bypass)}, policy bypasses "
            f"{sorted(CFG.admin_roles)}")

    def test_python_never_grants_a_role_node_would_refuse(self):
        source = self._node_source()
        node_roles = set(re.findall(r"req\.user\.role\s*===\s*['\"]([a-z-]+)['\"]", source))
        extra = set(CFG.admin_roles) - node_roles
        assert not extra, (
            f"policy treats {sorted(extra)} as full access and the Node layer "
            f"does not: a caller Node would refuse reaches the data")


class TestCollectionAllowList:
    """One list, so a harness searches what the server searches.

    The copies had drifted: one said `telegram_messages`, the other
    `telegrammessages`, and one carried reporting collections the other did not.
    A harness searching a different set validates something else.
    """

    def test_the_server_reads_the_shared_list(self):
        import api_server
        import query_collections
        assert api_server.ALLOWED_QUERY_COLLECTIONS == query_collections.allowed_collections()

    @pytest.mark.reads_source
    def test_the_live_validator_reads_the_shared_list(self):
        source = os.path.join(HERE, "validate_live.py")
        with open(source, encoding="utf-8") as fh:
            body = fh.read()
        assert "query_collections.allowed_collections()" in body
        assert 'COLLECTIONS = ["alerts"' not in body, "the copy came back"

    def test_the_environment_overrides_the_list(self, monkeypatch):
        import query_collections
        monkeypatch.setenv("ALLOWED_QUERY_COLLECTIONS", "alerts, grievances ,")
        assert query_collections.allowed_collections() == ["alerts", "grievances"]
        monkeypatch.setenv("ALLOWED_QUERY_COLLECTIONS", "   ")
        assert query_collections.allowed_collections() == list(
            query_collections.DEFAULT_COLLECTIONS), "a blank override is not an empty list"

    def test_only_collections_a_database_has_are_searched(self):
        import query_collections

        class FakeDB:
            def list_collection_names(self):
                return ["vector_embeddings_alerts", "vector_embeddings_grievances",
                        "unrelated", "alerts"]

        got = query_collections.existing_vector_collections(FakeDB())
        assert got == ["vector_embeddings_alerts", "vector_embeddings_grievances"]

    def test_the_order_is_stable(self):
        import query_collections

        class FakeDB:
            def __init__(self, names):
                self.names = names

            def list_collection_names(self):
                return self.names

        a = query_collections.existing_vector_collections(
            FakeDB(["vector_embeddings_pois", "vector_embeddings_alerts"]))
        b = query_collections.existing_vector_collections(
            FakeDB(["vector_embeddings_alerts", "vector_embeddings_pois"]))
        assert a == b, "a result set must not depend on dictionary ordering"


class TestNeverSearchable:
    """Accounts, configuration and the audit trail are never searchable.

    A deployment's .env listed 44 collections for BOTH searching and embedding,
    including `users`, `settings`, `auditlogs`, `pagepermissions` and
    `policymappings`. The code default for the ingest scheduler was
    "contents,users". Nothing had leaked, because the scheduler happened to be
    switched off — the only thing between an officer and the account table was
    one environment variable.

    An allow-list is the wrong place to be careful: it is edited by whoever adds
    a collection, and it fails open. This is the floor.
    """

    def test_identity_and_audit_collections_are_on_the_floor(self):
        import query_collections as qc
        for name in ("users", "settings", "auditlogs", "pagepermissions",
                     "policymappings", "search_history"):
            assert name in qc.NEVER_SEARCHABLE, name

    def test_configuration_cannot_widen_the_search_list(self, monkeypatch):
        import query_collections as qc
        monkeypatch.setenv("ALLOWED_QUERY_COLLECTIONS",
                           "alerts,users,auditlogs,settings,grievances")
        got = qc.allowed_collections()
        assert got == ["alerts", "grievances"], got

    def test_configuration_cannot_widen_the_embed_list(self, monkeypatch):
        import importlib
        import query_collections as qc
        monkeypatch.setenv("EMBED_COLLECTIONS", "contents,users,auditlogs")
        import regenerate_embeddings
        importlib.reload(regenerate_embeddings)
        try:
            assert regenerate_embeddings.DEFAULT_COLLECTIONS == ["contents"], \
                regenerate_embeddings.DEFAULT_COLLECTIONS
            assert not [c for c in regenerate_embeddings.DEFAULT_COLLECTIONS
                        if c.lower() in qc.NEVER_SEARCHABLE]
        finally:
            monkeypatch.delenv("EMBED_COLLECTIONS", raising=False)
            importlib.reload(regenerate_embeddings)

    def test_the_scheduler_never_embeds_a_denied_collection(self):
        import api_server
        import query_collections as qc
        assert "users" not in api_server.INGEST_COLLECTIONS
        assert not [c for c in api_server.INGEST_COLLECTIONS
                    if c.lower() in qc.NEVER_SEARCHABLE]

    def test_the_refusal_is_announced_rather_than_silent(self, monkeypatch, caplog):
        import logging
        import query_collections as qc
        monkeypatch.setenv("ALLOWED_QUERY_COLLECTIONS", "alerts,users")
        with caplog.at_level(logging.WARNING):
            qc.allowed_collections()
        assert any("users" in r.getMessage() for r in caplog.records), \
            "a refused collection must be named in the log"

    def test_a_denied_name_is_matched_case_insensitively(self, monkeypatch):
        import query_collections as qc
        monkeypatch.setenv("ALLOWED_QUERY_COLLECTIONS", "Users,AUDITLOGS,alerts")
        assert qc.allowed_collections() == ["alerts"]

    def test_the_vector_name_of_a_denied_collection_is_never_built(self, monkeypatch):
        import query_collections as qc
        monkeypatch.setenv("ALLOWED_QUERY_COLLECTIONS", "alerts,users")
        assert qc.vector_collections() == ["vector_embeddings_alerts"]

    def test_an_existing_denied_vector_collection_is_still_not_searched(self, monkeypatch):
        # Even if someone embedded it before this floor existed, it is skipped.
        import query_collections as qc
        monkeypatch.setenv("ALLOWED_QUERY_COLLECTIONS", "alerts,users")

        class FakeDB:
            def list_collection_names(self):
                return ["vector_embeddings_alerts", "vector_embeddings_users"]

        assert qc.existing_vector_collections(FakeDB()) == ["vector_embeddings_alerts"]
