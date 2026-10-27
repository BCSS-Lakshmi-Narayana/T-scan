"""
Phases 2-5 — unit tests for each layer on its own.

End-to-end behaviour over a corpus is in test_v2_pipeline.py and the golden
set in test_v2_golden.py; this file pins each component's contract and, above
all, its refusals.
"""

import json
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

import v2fixture as fx
from enrichment import entities, location as loc, related, situation
from enrichment.plan import enrich_plan
from fakemongo import FakeDB
from lifecycle.concepts import ConceptRegistry, LifecycleError
from lifecycle.feedback import FeedbackError, FeedbackIn, FeedbackStore
from orchestrator import agent, compiler, respond, timeutil
from orchestrator.executor import Executor, PlanValidationError, validate_plan
from orchestrator.models import (AggregateArgs, Evidence, ExecutionMode,
                                 ExecutionPlan, ExecutionStep, LocationArgs,
                                 SearchArgs, SpecArgs, StepStatus,
                                 VerificationReport)
from orchestrator.tools import HANDLERS, ToolBackend, ToolScopeError
from orchestrator.verify import verify
from policy import PERM_AI_CHAT, Capability, RequestContext, evaluate
from query_understanding import understand
from query_understanding.models import (Filter, FilterField, Intent, Source,
                                        TimeKind, TimeRange)
from runtime import cache as cache_mod
from runtime.router import Breaker, Router, is_failure_marker

C = Capability
NOW = fx.NOW
ADMIN = RequestContext(tenant_id="tenant-alpha", user_id="a1", role="admin")
HYD = RequestContext(tenant_id="tenant-alpha", user_id="o1", role="level-1",
                     districts=["Hyderabad"], permissions=frozenset({PERM_AI_CHAT}))


def gated(question, ctx=ADMIN):
    plan, _ = enrich_plan(understand(question)[0])
    return plan, evaluate(plan, ctx)


# =========================================================================== #
# Phase 3 — location
# =========================================================================== #

class TestLocation:
    @pytest.mark.parametrize("text,name,conf", [
        ("Karimnagar", "Karimnagar", 1.0), ("karimnagr", "Karimnagar", 0.8),
        ("rangareddy", "Ranga Reddy", 1.0), ("Hyd", "Hyderabad", 1.0),
        ("Cyberabad", "Cyberabad", 1.0), ("హైదరాబాద్", "Hyderabad", 1.0),
        ("वारंगल", "Warangal", 1.0)])
    def test_resolves_names_aliases_scripts_and_one_typo(self, text, name, conf):
        r = loc.resolve(text)
        assert r.status == "resolved" and r.place.name == name and r.confidence == conf

    @pytest.mark.parametrize("text", ["xyzville", "", "Mars", "hyderabadd bazaar city"])
    def test_unknown_places_stay_unresolved(self, text):
        assert loc.resolve(text).status == "unresolved"

    def test_short_names_are_never_fuzzy_matched(self):
        # One edit turns a short real place into another; no guessing there.
        assert loc.resolve("medac").status == "unresolved"

    def test_commissionerate_covers_several_districts(self):
        r = loc.resolve("Cyberabad")
        assert set(r.districts) == {"Ranga Reddy", "Medchal-Malkajgiri", "Sangareddy"}

    def test_the_extractor_and_the_location_service_agree_on_indic_script(self):
        # This once asserted the opposite — that understand() could NOT see an
        # Indic-script place. Two components disagreeing about whether a
        # question named a district is not a quirk: the officer asked about
        # Karimnagar and was answered for the whole state.
        question = "కరీంనగర్‌లో ఏం జరుగుతోంది"
        assert [r.place.name for r in loc.find_all(question)] == ["Karimnagar"]
        plan = understand(question)[0]
        assert plan.location is not None and plan.location.text == "Karimnagar"

    def test_finds_every_place_in_order(self):
        assert [r.place.name for r in loc.find_all("compare Warangal and Hyderabad")] == \
            ["Warangal", "Hyderabad"]

    def test_district_spellings_match_through_aliases(self):
        assert loc.same_district("Rangareddy", "Ranga Reddy")
        assert not loc.same_district("Hyderabad", "Warangal")
        assert loc.intersect(["Ranga Reddy", "Sangareddy"], ["Rangareddy"]) == ["Rangareddy"]
        assert loc.intersect(["Warangal"], None) == ["Warangal"]


class TestPlanEnrichment:
    def test_telugu_place_reaches_the_gate_and_is_refused_out_of_scope(self):
        plan, policy = gated("కరీంనగర్‌లో ఏం జరుగుతోంది", HYD)
        assert plan.location.text == "Karimnagar" and plan.location.resolved
        assert policy.decision.value == "denied"

    def test_comparison_sides_become_gate_visible(self):
        plan, _ = enrich_plan(understand("Compare Hyderabad and Warangal.")[0])
        assert [s.text for s in plan.sub_questions] == ["Hyderabad", "Warangal"]
        assert all(any(f.field is FilterField.DISTRICT for f in s.filters)
                   for s in plan.sub_questions)

    def test_input_plan_is_not_modified(self):
        p = understand("alerts in Karimnagar")[0]
        before = p.model_dump(mode="json")
        enrich_plan(p)
        assert p.model_dump(mode="json") == before

    def test_enrichment_never_removes_a_user_filter(self):
        p = understand("negative high risk alerts in Karimnagar on facebook")[0]
        e, _ = enrich_plan(p)
        assert {(f.field, str(f.value)) for f in p.filters} <= {(f.field, str(f.value)) for f in e.filters}


class TestEntitiesRelatedSituation:
    def _recs(self):
        return [{"key": "a", "text": "bribe demanded at office", "meta": {"handle": "x1", "tagged": ["y"],
                 "districts": ["Warangal"], "published_at": NOW}},
                {"key": "b", "text": "bribe case filed at office", "meta": {"handle": "x1",
                 "districts": ["Warangal"], "published_at": NOW - timedelta(days=1)}},
                {"key": "c", "text": "cricket match result", "meta": {"handle": "z9",
                 "districts": ["Hyderabad"], "published_at": NOW - timedelta(days=40)}}]

    def test_entities_are_counted_from_structure_with_their_records(self):
        rec = entities.repeated(self._recs(), 2)
        acct = next(e for e in rec if e["type"] == "account" and e["text"] == "x1")
        assert acct["count"] == 2 and acct["record_keys"] == ["a", "b"]

    def test_free_text_names_are_not_promoted_to_entities(self):
        ents = entities.from_question("what did Ravi Kumar say about the SHO in Warangal?")
        assert {"person"} & {e["type"] for e in ents} == set()
        assert any(e["type"] == "police_unit" for e in ents)

    def test_related_needs_more_than_one_weak_signal(self):
        recs = self._recs()
        out = related.score([recs[0]], recs[1:], top_k=5)
        keys = [r["key"] for r in out]
        assert "b" in keys and "c" not in keys
        assert {"entity", "lexical"} <= set(out[0]["signals"])

    def test_situation_states_only_tool_numbers(self):
        s = situation.build("x", records=self._recs(), total=3,
                            breakdowns={"risk_level": [{"value": "high", "count": 2}]},
                            trend={"current": 3, "previous": 0, "change_pct": None},
                            related=[], window_days=7)
        text = " ".join(s["observations"])
        assert "3 matching record(s)" in text and "no percentage change" in text
        assert "2 record(s) are rated high risk" in text


# =========================================================================== #
# Phase 2 — compiler
# =========================================================================== #

class TestCompiler:
    def test_tools_come_from_allowed_capabilities_not_required_tools(self):
        plan, policy = gated("How many alerts yesterday?")
        tampered = plan.model_copy(update={"required_tools": ["deep_scan", "aggregate"]})
        ep = compiler.compile_plan(tampered, policy, now=NOW)
        assert [s.tool for s in ep.steps] == [C.AGGREGATE]

    def test_denied_policy_compiles_to_nothing(self):
        plan, policy = gated("alerts in Karimnagar", HYD)
        ep = compiler.compile_plan(plan, policy, now=NOW)
        assert ep.mode is ExecutionMode.NONE and ep.steps == []

    def test_place_narrows_scope_and_never_widens_it(self):
        plan, policy = gated("alerts in Hyderabad", HYD)
        ep = compiler.compile_plan(plan, policy, now=NOW)
        assert ep.execution_districts == ["Hyderabad"] and ep.place_districts == ["Hyderabad"]

    def test_commissionerate_partly_in_scope_is_narrowed_and_said(self):
        ctx = HYD.model_copy(update={"districts": ["Rangareddy"]})
        plan, policy = gated("alerts in Cyberabad", ctx)
        # The gate warns (unverifiable city/commissionerate); the compiler narrows.
        assert policy.decision.value in ("allowed", "degraded")
        ep = compiler.compile_plan(plan, policy, now=NOW)
        assert ep.execution_districts == ["Rangareddy"]
        assert any("extends beyond" in l for l in ep.limitations)

    def test_place_outside_restricted_scope_refuses(self):
        plan, _ = enrich_plan(understand("alerts in Cyberabad")[0])
        policy = evaluate(plan, HYD)
        assert policy.decision.value in ("allowed", "degraded")   # the gate cannot tell
        with pytest.raises(compiler.CompileRefusal):
            compiler.compile_plan(plan, policy, now=NOW)

    def test_relative_time_is_resolved_against_the_request_clock(self):
        plan, policy = gated("alerts from yesterday")
        a = compiler.compile_plan(plan, policy, now=NOW).steps[0].arguments.spec
        b = compiler.compile_plan(plan, policy, now=NOW).steps[0].arguments.spec
        assert a == b and a.since and a.until and a.since < a.until

    def test_multi_part_steps_are_prefixed_per_sub_question(self):
        plan, policy = gated("How many complaints are there, what are people saying, and "
                             "which areas are affected?")
        ep = compiler.compile_plan(plan, policy, now=NOW)
        assert {s.step_id.split(".")[0] for s in ep.steps} >= {"q0", "q1"}
        assert all(s.sub_question is not None for s in ep.steps)

    def test_comparison_without_sides_asks(self):
        plan, policy = gated("compare them")
        assert policy.decision.value in ("allowed", "degraded") and plan.intent is Intent.COMPARISON
        with pytest.raises(compiler.CompileRefusal):
            compiler.compile_plan(plan, policy, now=NOW)


# =========================================================================== #
# Phase 2 — executor safety
# =========================================================================== #

def _step(sid, tool=C.HYBRID_SEARCH, deps=(), args=None, essential=True):
    return ExecutionStep(step_id=sid, tool=tool, operation="x",
                         arguments=args or SearchArgs(spec=SpecArgs()), dependencies=list(deps),
                         purpose="t", essential=essential)


def _plan(steps, allowed=None, districts=None):
    return ExecutionPlan(request_id="r", mode=ExecutionMode.DETERMINISTIC, steps=steps,
                         allowed_capabilities=allowed or [C.HYBRID_SEARCH, C.AGGREGATE,
                                                          C.LOCATION_RESOLVE],
                         execution_districts=districts)


class TestExecutor:
    def test_rejects_cycles(self):
        p = _plan([_step("a", deps=["b"]), _step("b", deps=["a"])])
        assert "dependency cycle" in validate_plan(p)

    def test_rejects_missing_dependencies(self):
        assert any("missing dependency" in x for x in validate_plan(_plan([_step("a", deps=["z"])])))

    def test_rejects_capabilities_policy_did_not_allow(self):
        p = _plan([_step("a", tool=C.DEEP_SCAN)])
        assert any("not allowed by policy" in x for x in validate_plan(p))

    def test_rejects_mistyped_arguments(self):
        p = _plan([_step("a", tool=C.AGGREGATE, args=SearchArgs(spec=SpecArgs()))])
        assert any("arguments are SearchArgs" in x for x in validate_plan(p))

    def test_rejects_unimplemented_tools(self, planned):
        planned("location_resolve")
        p = _plan([_step("a", tool=C.LOCATION_RESOLVE, args=LocationArgs(text="x"))])
        assert any("not implemented" in x for x in validate_plan(p))

    def test_invalid_plans_run_nothing(self):
        called = []
        ex = Executor(ToolBackend(collections={"c": _Spy(called)}), "tenant-alpha", now=NOW)
        with pytest.raises(PlanValidationError):
            ex.run(_plan([_step("a", tool=C.DEEP_SCAN)]))
        assert called == []

    def test_steps_have_no_way_to_name_scope(self):
        for _, (_, args_model) in HANDLERS.items():
            fields = set(args_model.model_fields)
            assert not fields & {"tenant_id", "tenant", "districts_scope", "role", "permissions"}

    def test_failed_dependency_skips_dependents_and_optional_failure_degrades(self, monkeypatch):
        from orchestrator import tools as tm
        monkeypatch.setitem(tm.HANDLERS, C.HYBRID_SEARCH,
                            (lambda a, c: (_ for _ in ()).throw(ConnectionError("x")), SearchArgs))
        ex = Executor(ToolBackend(), "tenant-alpha", now=NOW)
        out = ex.run(_plan([_step("a", essential=False),
                            _step("b", tool=C.AGGREGATE, deps=["a"], essential=False,
                                  args=AggregateArgs(spec=SpecArgs()))]))
        assert out.results["a"].status is StepStatus.FAILED
        assert out.results["b"].status is StepStatus.SKIPPED
        assert out.degraded and not out.failed
        assert out.results["a"].error == "ConnectionError"     # structured, no raw message

    def test_timeout_does_not_hold_the_request(self, monkeypatch):
        from orchestrator import tools as tm

        def slow(a, ctx):
            ctx.cancel.wait(5)
            return {"records": []}
        monkeypatch.setitem(tm.HANDLERS, C.HYBRID_SEARCH, (slow, SearchArgs))
        monkeypatch.setitem(tm.TIMEOUTS, C.HYBRID_SEARCH, 0.2)
        t0 = time.perf_counter()
        out = Executor(ToolBackend(), "tenant-alpha", now=NOW).run(_plan([_step("a")]))
        assert time.perf_counter() - t0 < 2.0
        assert out.results["a"].status is StepStatus.TIMED_OUT and out.failed

    def test_scope_violation_stops_everything(self, monkeypatch):
        from orchestrator import tools as tm

        def outside(a, ctx):
            raise ToolScopeError("outside")
        monkeypatch.setitem(tm.HANDLERS, C.LOCATION_RESOLVE, (outside, LocationArgs))
        ex = Executor(ToolBackend(), "tenant-alpha", now=NOW)
        out = ex.run(_plan([_step("l", tool=C.LOCATION_RESOLVE, args=LocationArgs(text="x")),
                            _step("s", deps=["l"])]))
        assert out.scope_violation and out.results["s"].status in (StepStatus.SKIPPED,
                                                                   StepStatus.CANCELLED)

    def test_location_step_can_only_narrow(self, monkeypatch):
        from orchestrator import tools as tm
        seen = {}
        monkeypatch.setitem(tm.HANDLERS, C.LOCATION_RESOLVE,
                            (lambda a, c: {"districts": ["Hyderabad", "Mars"]}, LocationArgs))
        monkeypatch.setitem(tm.HANDLERS, C.HYBRID_SEARCH,
                            (lambda a, c: seen.setdefault("d", c.districts) and {"records": []}
                             or {"records": []}, SearchArgs))
        Executor(ToolBackend(), "tenant-alpha", now=NOW).run(
            _plan([_step("l", tool=C.LOCATION_RESOLVE, args=LocationArgs(text="x")),
                   _step("s", deps=["l"])], districts=["Hyderabad"]))
        assert seen["d"] == ["Hyderabad"]     # "Mars" was not in scope: no widening


class _Spy:
    def __init__(self, log):
        self.log = log

    def __getattr__(self, name):
        self.log.append(name)
        raise AssertionError("touched")


# =========================================================================== #
# evidence, verification, response
# =========================================================================== #

def _ev(i, **kw):
    base = dict(evidence_id=f"E{i}", source_type="record", tool=C.HYBRID_SEARCH, step_id="s",
                source_id=f"k{i}", provenance={"_tenant": "tenant-alpha"})
    base.update(kw)
    return Evidence(**base)


class TestVerification:
    def _run(self, evs, districts=None, place=None, filters=(), spec=None):
        ep = _plan([_step("s", args=SearchArgs(spec=spec or SpecArgs()))], districts=districts)
        ep.place_districts = place
        qp = understand("alerts")[0].model_copy(update={"filters": list(filters)})
        return verify(evs, ep, qp, "tenant-alpha")

    def test_foreign_tenant_record_is_removed(self):
        kept, rep = self._run([_ev(1, provenance={"_tenant": "tenant-beta"})])
        assert kept == [] and rep.evidence_removed == ["E1"]

    def test_out_of_scope_district_is_removed_untagged_is_kept(self):
        kept, _ = self._run([_ev(1, districts=["Warangal"]), _ev(2, districts=[])],
                            districts=["Hyderabad"])
        assert [e.evidence_id for e in kept] == ["E2"]

    def test_place_questions_require_a_tag(self):
        kept, _ = self._run([_ev(1, districts=[]), _ev(2, districts=["Hyderabad"])],
                            districts=["Hyderabad"], place=["Hyderabad"])
        assert [e.evidence_id for e in kept] == ["E2"]

    def test_record_contradicting_an_explicit_filter_is_removed(self):
        f = Filter(field=FilterField.SENTIMENT, value="negative", source=Source.EXPLICIT)
        kept, _ = self._run([_ev(1, facts={"sentiment": "positive"}),
                             _ev(2, facts={"sentiment": "negative"})], filters=[f])
        assert [e.evidence_id for e in kept] == ["E2"]

    def test_model_inferred_filter_is_not_enforced_as_hard(self):
        f = Filter(field=FilterField.SENTIMENT, value="negative", source=Source.LLM)
        kept, _ = self._run([_ev(1, facts={"sentiment": "positive"})], filters=[f])
        assert len(kept) == 1

    def test_out_of_period_record_is_removed(self):
        spec = SpecArgs(since=timeutil.iso(NOW - timedelta(days=1)), until=timeutil.iso(NOW))
        kept, _ = self._run([_ev(1, timestamp=timeutil.iso(NOW - timedelta(days=5))),
                             _ev(2, timestamp=timeutil.iso(NOW - timedelta(hours=2)))], spec=spec)
        assert [e.evidence_id for e in kept] == ["E2"]

    def test_duplicates_collapse(self):
        kept, _ = self._run([_ev(1, source_id="same"), _ev(2, source_id="same")])
        assert len(kept) == 1

    def test_bad_arithmetic_is_flagged_never_edited(self):
        agg = Evidence(evidence_id="E1", source_type="aggregate", tool=C.AGGREGATE, step_id="s",
                       facts={"total": 5})
        rows = Evidence(evidence_id="E2", source_type="aggregate", tool=C.AGGREGATE, step_id="s",
                        facts={"group_by": "platform", "rows": [{"value": "x", "count": 9}]})
        trend = Evidence(evidence_id="E3", source_type="trend", tool=C.TREND_ANALYSIS, step_id="t",
                         facts={"current": 3, "previous": 2, "change_pct": 99.0})
        kept, rep = self._run([agg, rows, trend])
        assert not rep.passed and kept[0].facts["total"] == 5 and kept[2].facts["change_pct"] == 99.0

    def test_empty_is_an_answer(self):
        agg = Evidence(evidence_id="E1", source_type="aggregate", tool=C.AGGREGATE, step_id="s",
                       facts={"total": 0})
        _, rep = self._run([agg])
        assert rep.sufficiency == "empty"


class TestClaims:
    EV = [Evidence(evidence_id="E1", source_type="aggregate", tool=C.AGGREGATE, step_id="s",
                   facts={"total": 42}, content="42 matching record(s)")]

    def test_supported_sentence_is_kept(self):
        text, removed = respond.check_claims("There are 42 matching records [E1].", self.EV)
        assert removed == 0 and "42" in text

    def test_invented_number_is_removed(self):
        text, removed = respond.check_claims("There are 42 records [E1]. That is 60% higher.",
                                             self.EV)
        assert removed == 1 and "60" not in text

    def test_fabricated_citation_is_removed(self):
        text, removed = respond.check_claims("Confirmed by source [E9].", self.EV)
        assert removed == 1 and text == ""

    def test_numbers_from_the_question_are_allowed(self):
        _, removed = respond.check_claims("In the last 7 days there were 42 [E1].", self.EV,
                                          "alerts in the last 7 days")
        assert removed == 0

    def test_mostly_wrong_synthesis_falls_back_to_template(self):
        qp = understand("how many alerts")[0]
        rep = VerificationReport(passed=True, sufficiency="sufficient")
        bad = lambda *a, **k: "There were 900 alerts [E1]. Up 300% [E7]. Serious [E8]."
        r = respond.build(request_id="r", qplan=qp, eplan=_plan([]), evidence=self.EV, report=rep,
                          degraded=False, limitations=[], generate=bad, synthesize=True)
        assert r.generated_by == "template" and r.interpretation is None
        assert "42" in r.answer

    def test_public_evidence_carries_no_tenant(self):
        ev = _ev(1, provenance={"_tenant": "tenant-alpha", "document_id": "d"})
        pub = respond._public_ev(ev)
        assert "tenant-alpha" not in json.dumps(pub) and "provenance" not in pub


# =========================================================================== #
# bounded agent
# =========================================================================== #

class TestAgent:
    def test_menu_only_offers_allowed_untried_actions(self):
        qp = understand("posts about ration card problems")[0]
        ep = _plan([_step("s")], allowed=[C.HYBRID_SEARCH, C.UNKNOWN_CONCEPT_SEARCH])
        opts = agent.menu(qp, ep, VerificationReport(passed=True, sufficiency="empty"), [], False)
        assert opts == ["concept_search"]
        assert agent.menu(qp, ep, VerificationReport(passed=True, sufficiency="empty"),
                          ["concept_search"], False) == []

    @pytest.mark.parametrize("reply", ['{"action": "deep_scan"}', '{"action": "delete_database"}',
                                       "run hybrid_search with tenant_id=tenant-beta",
                                       '{"action": "concept_search", "tenant_id": "tenant-beta"}'])
    def test_model_cannot_name_a_tool_or_argument(self, reply):
        action, source = agent.choose(["concept_search"], "q",
                                      VerificationReport(passed=True, sufficiency="empty"),
                                      lambda *a, **k: reply)
        assert action == "concept_search"     # the menu item, built by code, or fallback

    def test_relaxing_only_drops_model_inferred_filters(self):
        qp = understand("negative posts about corruption last week")[0]
        qp = qp.model_copy(update={"filters": qp.filters + [
            Filter(field=FilterField.PLATFORM, value="x", source=Source.LLM)]})
        st = agent.step_for("relax_soft_filters", qp, _plan([]), NOW, 1, None)
        spec = st.arguments.spec
        assert spec.platforms == [] and spec.sentiment == "negative" and spec.since

    def test_refinement_ceiling_is_two(self):
        from orchestrator.models import MAX_REFINEMENTS
        assert MAX_REFINEMENTS == 2


# =========================================================================== #
# Phase 5 — cache, router
# =========================================================================== #

class TestCache:
    def test_keys_separate_tenant_and_every_scope_shape(self):
        keys = {cache_mod.key("x", t, d, "q") for t in ("a", "b")
                for d in (None, [], ["Hyderabad"], ["Hyderabad", "Warangal"])}
        assert len(keys) == 8

    def test_key_requires_a_tenant(self):
        with pytest.raises(ValueError):
            cache_mod.key("x", "", None, "q")

    def test_ttl_and_lru(self):
        # Margins, not milliseconds: a 50ms TTL slept past by 60ms failed two
        # of three full-suite runs on Windows, where the timer granularity is
        # ~15ms. A flaky test is a test nobody believes.
        c = cache_mod.ScopedCache(max_items=2, ttl_s=0.3)
        c.set("a", 1); c.set("b", 2); c.set("c", 3)
        assert c.get("a") is None and c.get("c") == 3
        time.sleep(0.5)
        assert c.get("c") is None


class TestRouter:
    def test_failure_marker_is_a_failure(self):
        assert is_failure_marker("_(LLM generation failed after 3 attempts: x)_")
        assert is_failure_marker("") and not is_failure_marker("fine")
        r = Router(lambda *a, **k: "_(Error generating answer: LLM unreachable)_", retries=0)
        Router.breakers.clear()
        assert r.generate("synthesize")("p") is None

    def test_breaker_opens_after_repeated_failures(self):
        b = Breaker(threshold=2, cooldown_s=60)
        b.result(False); b.result(False)
        assert not b.allow()

    def test_timeout_returns_none(self):
        Router.breakers.clear()
        r = Router(lambda *a, **k: time.sleep(1) or "late", timeouts={"agent": 0.1}, retries=0)
        assert r.generate("agent")("p") is None

    def test_default_model_is_the_production_model(self, monkeypatch):
        from runtime.router import model_for
        monkeypatch.setenv("LLM_MODEL", "prod-model")
        monkeypatch.delenv("AI_MODEL_JUDGE", raising=False)
        assert model_for("judge") == "prod-model"


class TestStores:
    def test_mongo_conversation_store_is_per_tenant_database_with_indexes(self, monkeypatch):
        from runtime import stores
        monkeypatch.setenv("AI_CONVERSATION_STORE", "mongo")
        stores.reset()
        dbs = {}
        store = stores.conversation_store(lambda t: dbs.setdefault(t, FakeDB()))
        st = store.create("tenant-alpha", "u1")
        assert dbs["tenant-alpha"]["ai_conversations"].docs
        names = {kw["name"] for _, kw in dbs["tenant-alpha"]["ai_conversations"].indexes}
        assert {"owner_conversation", "ttl_expires_at"} <= names
        assert store.get("tenant-alpha", "u1", st.conversation_id).conversation_id == st.conversation_id
        stores.reset()

    def test_default_writes_nowhere(self, monkeypatch):
        from runtime import stores
        monkeypatch.delenv("AI_CONVERSATION_STORE", raising=False)
        monkeypatch.delenv("AI_AUDIT_SINK", raising=False)
        stores.reset()
        import conversation as conv
        assert isinstance(stores.conversation_store(), conv.InMemoryConversationStore)
        db = FakeDB()
        stores.AuditSink(lambda t: db).write("t", {"x": 1})
        assert "ai_audit" not in db
        stores.reset()


# =========================================================================== #
# Phase 4 — concept lifecycle and feedback
# =========================================================================== #

class TestConceptLifecycle:
    def reg(self):
        return ConceptRegistry(FakeDB(), "tenant-alpha")

    def test_asking_never_promotes(self):
        r = self.reg()
        for _ in range(10):
            r.record_ask("ration card problems")
        assert r.status("ration card problems") == "ephemeral"
        assert not r.is_trusted("ration card problems")

    def test_proposal_needs_usage_and_verdicts_and_stays_a_proposal(self):
        db = FakeDB()
        r = ConceptRegistry(db, "tenant-alpha")
        import concepts as cm
        for _ in range(3):
            r.record_ask("ration")
        for i in range(25):
            db["rag_verdicts"].insert_one({"_id": f"v{i}", "label": cm.cache_key("ration"),
                                           "match": i % 2 == 0})
        r.refresh_verdict_stats("ration")
        assert r.maybe_propose("ration") == "candidate"
        assert not r.is_trusted("ration")

    def test_promotion_needs_a_named_admin_and_measured_precision(self):
        r = self.reg()
        r.record_ask("x")
        r.col.update_one({"_id": r._id("x")}, {"$set": {"status": "candidate"}})
        with pytest.raises(LifecycleError):
            r.transition("x", "promoted", actor="system")
        with pytest.raises(LifecycleError):
            r.transition("x", "promoted", actor="u9", actor_role="level-1",
                         metrics={"precision": 0.99, "evaluated": 100})
        with pytest.raises(LifecycleError):
            r.transition("x", "promoted", actor="adm", actor_role="admin",
                         metrics={"precision": 0.80, "evaluated": 100})
        doc = r.transition("x", "promoted", actor="adm", actor_role="admin",
                           metrics={"precision": 0.9, "evaluated": 40})
        assert doc["status"] == "promoted" and doc["promotion"]["approved_by"] == "adm"
        assert doc["history"][-1]["to"] == "promoted"

    def test_illegal_transitions_are_refused(self):
        r = self.reg()
        r.record_ask("y")
        with pytest.raises(LifecycleError):
            r.transition("y", "promoted", actor="adm", actor_role="admin",
                         metrics={"precision": 1.0, "evaluated": 99})

    def test_registry_is_per_tenant(self):
        db = FakeDB()
        ConceptRegistry(db, "tenant-alpha").record_ask("z")
        assert ConceptRegistry(db, "tenant-beta").status("z") == "unknown"


class TestFeedback:
    def store(self):
        return FeedbackStore(FakeDB(), "tenant-alpha")

    def test_closed_kinds_only(self):
        with pytest.raises(FeedbackError):
            self.store().submit("u1", FeedbackIn(kind="drop_table", target={"type": "answer"}))

    def test_feedback_never_edits_facts_and_needs_triage(self):
        s = self.store()
        fid = s.submit("u1", FeedbackIn(kind="incorrect_classification",
                                        target={"type": "verdict", "record_key": "k1",
                                                "concept": "communal"},
                                        verdict="incorrect", reason="news report"))
        assert s.verdicts.docs == []                      # nothing applied on submit
        with pytest.raises(FeedbackError):
            s.move(fid, "applied", actor="u1", actor_role="level-1")
        s.move(fid, "triaged", actor="adm", actor_role="admin")
        s.move(fid, "applied", actor="adm", actor_role="admin")
        (v,) = s.verdicts.docs
        assert v["source"] == "human" and v["match"] is False and v["reviewer"] == "adm"

    def test_only_record_level_classification_can_be_applied(self):
        s = self.store()
        fid = s.submit("u1", FeedbackIn(kind="not_useful", target={"type": "answer"}))
        s.move(fid, "triaged", actor="adm", actor_role="admin")
        with pytest.raises(FeedbackError):
            s.move(fid, "applied", actor="adm", actor_role="admin")

    def test_unknown_target_fields_are_refused(self):
        with pytest.raises(Exception):
            FeedbackIn(kind="useful", target={"type": "answer", "tenant_id": "tenant-beta"})


class TestAppliedScope:
    """The period an answer covers is stated, because a count reads as the whole
    truth otherwise -- and the window is often one the question never named."""

    EV = [Evidence(evidence_id="E1", source_type="aggregate", tool=C.AGGREGATE, step_id="s",
                   facts={"total": 4241}, content="4241 matching record(s)")]
    REPORT = VerificationReport(passed=True, sufficiency="sufficient")

    def _answer(self, question):
        return respond.template(understand(question)[0], self.EV, self.REPORT)

    def test_all_time_is_stated_not_left_implicit(self):
        assert "all time" in self._answer("how many posts about corruption")

    def test_recent_is_shown_as_the_window_it_became(self):
        # The user typed "recent"; the answer must say what that resolved to.
        assert "the last 7 days" in self._answer("show me recent posts")

    @pytest.mark.parametrize("question,shown", [
        ("how many alerts today", "today"),
        ("how many alerts yesterday", "yesterday"),
        ("how many alerts this week", "this week"),
        ("how many alerts last week", "last week"),
        ("how many alerts this month", "this month"),
        ("how many alerts in the last 3 months", "the last 3 months"),
        ("how many alerts in the last 1 days", "the last 1 day"),
    ])
    def test_named_windows_are_shown_verbatim(self, question, shown):
        assert shown in self._answer(question)

    def test_the_count_itself_is_unchanged(self):
        # Presentation only: the number must not move.
        assert "4241" in self._answer("how many posts about corruption")

    def test_an_empty_answer_names_the_period_too(self):
        empty = [Evidence(evidence_id="E1", source_type="aggregate", tool=C.AGGREGATE,
                          step_id="s", facts={"total": 0})]
        rep = VerificationReport(passed=True, sufficiency="empty")
        text = respond.template(understand("how many alerts this week")[0], empty, rep)
        assert "this week" in text and "No matching records" in text

    def test_no_scope_is_invented_when_the_range_cannot_be_described(self):
        from query_understanding.models import TimeKind, TimeRange
        qp = understand("how many alerts")[0]
        qp = qp.model_copy(update={"time_range": TimeRange(kind=TimeKind.UNRESOLVED)})
        text = respond.template(qp, self.EV, self.REPORT)
        assert "—" not in text and "4241" in text


class TestSituationPathIsComplete:
    """The situation path must investigate, not just retrieve: it needs the
    analysis steps AND enough evidence to tell distinct issues apart."""

    def _compiled(self, question):
        import policy as policy_gate
        from query_understanding import understand
        ctx = policy_gate.RequestContext(
            tenant_id="t", user_id="u", role="admin", districts=None,
            permissions=policy_gate.permissions_from_rbac(
                {"/ai-assistant": {"enabled": True,
                                   "features": ["ai_chat", "ai_deep_scan"]}}))
        plan = understand(question, allow_llm=False)[0]
        pol = policy_gate.evaluate(plan, ctx)
        return compiler.compile_plan(plan, pol, now=timeutil.parse("2026-09-23T12:00:00+05:30"))

    @pytest.mark.parametrize("question", [
        "What is happening in Hyderabad?",
        "Hyderabad lo emaina serious issue nadustunda?",
        "Anything concerning in Hyderabad?",
    ])
    def test_every_analysis_step_is_compiled(self, question):
        tools = [s.tool.value for s in self._compiled(question).steps]
        for expected in ("hybrid_search", "aggregate", "trend_analysis",
                         "related_content_search", "situation_analysis"):
            assert expected in tools, (expected, tools)

    def test_related_content_runs_after_the_search_it_groups(self):
        steps = {s.step_id: s for s in self._compiled("What is happening in Hyderabad?").steps}
        assert "search" in steps["related"].dependencies

    def test_the_analysis_budget_is_wider_than_the_display_budget(self):
        """Not 'retrieve more and show more': the situation steps read more so
        distinct issues can be separated, while respond() still shows a
        bounded list."""
        plan = self._compiled("What is happening in Hyderabad?")
        search = next(s for s in plan.steps if s.tool is C.HYBRID_SEARCH)
        assert search.arguments.spec.limit == compiler.SITUATION_EVIDENCE
        assert compiler.SITUATION_EVIDENCE > 15

    def test_a_filtered_search_keeps_the_normal_budget(self):
        plan = self._compiled("Show me high risk posts in Hyderabad")
        search = next(s for s in plan.steps if s.tool is C.HYBRID_SEARCH)
        assert search.arguments.spec.limit == 15
        assert [s.tool.value for s in plan.steps].count("situation_analysis") == 0


class TestSynthesisReadsOnlyVerifiedEvidence:
    EV = [
        Evidence(evidence_id="E1", source_type="aggregate", tool=C.AGGREGATE, step_id="a",
                 facts={"total": 4241}, content="4241 matching record(s)"),
        Evidence(evidence_id="E9", source_type="situation", tool=C.SITUATION_ANALYSIS,
                 step_id="s", facts={"observations": ["21 records are rated high risk."]},
                 content="situation"),
    ] + [Evidence(evidence_id=f"E{i}", source_type="record", tool=C.HYBRID_SEARCH, step_id="r",
                  facts={"handle": f"h{i}"}, content=f"post {i}") for i in range(10, 50)]

    def test_analysis_evidence_survives_the_prompt_cap(self):
        """40 records must not push the aggregate and situation facts out of the
        prompt -- that would leave the model describing what it never saw."""
        prompt = respond._prompt("what is happening", self.EV)
        assert "[E1]" in prompt and "[E9]" in prompt

    def test_the_prompt_carries_only_the_evidence_given(self):
        prompt = respond._prompt("what is happening", self.EV[:2])
        assert "post 10" not in prompt
        assert "Ground every statement in the evidence below" in prompt

    @pytest.mark.parametrize("guard", [
        "counts POSTS",                       # a record count is not an incident count
        "proof that anything happened",       # high risk is a label, not an event
        "monitoring scope a post was captured under",   # district is not a crime scene
        "not a count of\n  distinct incidents",         # topics are not situations
        "Never call a place an issue",
        "Never manufacture situations",
    ])
    def test_the_prompt_blocks_the_inferences_that_mislead_an_officer(self, guard):
        assert guard in respond._prompt("q", self.EV[:1])

    def test_synthesis_is_used_when_it_is_grounded(self):
        qp = understand("what is happening in Hyderabad")[0]
        rep = VerificationReport(passed=True, sufficiency="sufficient")
        good = lambda *a, **k: "There are 4241 matching records [E1]. 21 are high risk [E9]."
        r = respond.build(request_id="r", qplan=qp, eplan=_plan([]), evidence=self.EV[:2],
                          report=rep, degraded=False, limitations=[], generate=good,
                          synthesize=True)
        assert r.generated_by == "llm" and r.interpretation is not None

    def test_an_ungrounded_draft_still_falls_back_to_the_template(self):
        qp = understand("what is happening in Hyderabad")[0]
        rep = VerificationReport(passed=True, sufficiency="sufficient")
        bad = lambda *a, **k: "Riots erupted [E77]. 900 arrests [E78]. Tension is high [E79]."
        r = respond.build(request_id="r", qplan=qp, eplan=_plan([]), evidence=self.EV[:2],
                          report=rep, degraded=False, limitations=[], generate=bad,
                          synthesize=True)
        assert r.generated_by == "template" and r.interpretation is None


class TestPopulationIsNotEvidence:
    def test_a_population_count_says_how_many_were_examined(self):
        ev = [Evidence(evidence_id="E1", source_type="aggregate", tool=C.AGGREGATE, step_id="a",
                       facts={"total": 4241}, content="4241 matching record(s)")]
        ev += [Evidence(evidence_id=f"E{i}", source_type="record", tool=C.HYBRID_SEARCH,
                        step_id="r", facts={"handle": f"h{i}"}, content=f"post {i}")
               for i in range(2, 11)]
        text = respond.template(understand("how many posts about corruption")[0], ev,
                                VerificationReport(passed=True, sufficiency="sufficient"))
        assert "4241" in text
        assert "9 of them examined" in text

    def test_nothing_is_claimed_when_everything_matched_was_examined(self):
        ev = [Evidence(evidence_id="E1", source_type="aggregate", tool=C.AGGREGATE, step_id="a",
                       facts={"total": 2}, content="2 matching record(s)")]
        ev += [Evidence(evidence_id=f"E{i}", source_type="record", tool=C.HYBRID_SEARCH,
                        step_id="r", facts={}, content=f"post {i}") for i in (2, 3)]
        text = respond.template(understand("how many posts about corruption")[0], ev,
                                VerificationReport(passed=True, sufficiency="sufficient"))
        assert "examined" not in text


def test_situation_names_what_the_records_are_about():
    """Topics are the closest thing to a list of distinct situations; a
    situation summary that omits them makes the officer open posts to find out
    what the volume is even about."""
    out = situation.build(
        subject="Hyderabad", window_days=7, total=3091,
        trend={"current": 3091, "previous": 1142, "change_pct": 170.7},
        breakdowns={"topics": [{"value": "murder", "count": 130},
                               {"value": "women_safety", "count": 103},
                               {"value": "land", "count": 62}],
                    "districts": [{"value": "Hyderabad", "count": 3091}]},
        records=[], related=[])
    line = next((o for o in out["observations"] if o.startswith("Main subjects")), None)
    assert line is not None, out["observations"]
    assert "murder (130)" in line and "women safety (103)" in line
    assert out["topics"][0]["value"] == "murder"


def test_a_period_comparison_keeps_the_place_it_named():
    """"compare this week with last week for Hyderabad" compared the two
    periods across every district, because the period sides carried no scope."""
    import policy as policy_gate
    from enrichment.plan import enrich_plan
    from query_understanding import understand
    ctx = policy_gate.RequestContext(
        tenant_id="t", user_id="u", role="admin", districts=None,
        permissions=policy_gate.permissions_from_rbac(
            {"/ai-assistant": {"enabled": True, "features": ["ai_chat"]}}))
    plan, _ = enrich_plan(understand("Compare this week with last week for Hyderabad.",
                                     allow_llm=False)[0])
    ep = compiler.compile_plan(plan, policy_gate.evaluate(plan, ctx),
                               now=timeutil.parse("2026-09-23T12:00:00+05:30"))
    sides = next(s.arguments.sides for s in ep.steps if s.tool is C.COMPARE_RESULTS)
    assert [s.label for s in sides] == ["this week", "last week"]
    assert all(s.districts == ["Hyderabad"] for s in sides), [s.districts for s in sides]
    assert sides[0].since != sides[1].since        # still two different periods


def test_a_place_comparison_still_scopes_each_side_to_its_own_place():
    import policy as policy_gate
    from enrichment.plan import enrich_plan
    from query_understanding import understand
    ctx = policy_gate.RequestContext(
        tenant_id="t", user_id="u", role="admin", districts=None,
        permissions=policy_gate.permissions_from_rbac(
            {"/ai-assistant": {"enabled": True, "features": ["ai_chat"]}}))
    plan, _ = enrich_plan(understand("Compare Hyderabad and Mulugu for high risk content.",
                                     allow_llm=False)[0])
    ep = compiler.compile_plan(plan, policy_gate.evaluate(plan, ctx),
                               now=timeutil.parse("2026-09-23T12:00:00+05:30"))
    sides = next(s.arguments.sides for s in ep.steps if s.tool is C.COMPARE_RESULTS)
    assert {s.label: s.districts for s in sides} == {"Hyderabad": ["Hyderabad"],
                                                    "Mulugu": ["Mulugu"]}


from types import SimpleNamespace


class TestMatchingPopulation:
    """Every answer shape reports the population its question asked about."""

    def _ev(self, source_type, facts):
        # The helper reads only these two attributes; building a full Evidence
        # would drag in a tool enum that has nothing to do with counting.
        return SimpleNamespace(source_type=source_type, facts=facts)

    def test_an_aggregate_total_is_used_when_there_is_one(self):
        from orchestrator.pipeline import _matching_population
        assert _matching_population([self._ev("aggregate", {"total": 4669})]) == 4669

    def test_a_comparison_reports_both_sides_together(self):
        from orchestrator.pipeline import _matching_population
        ev = self._ev("comparison", {"sides": [{"label": "Hyderabad", "count": 4241},
                                               {"label": "Mulugu", "count": 26}]})
        assert _matching_population([ev]) == 4267

    def test_a_trend_reports_both_windows_together(self):
        from orchestrator.pipeline import _matching_population
        ev = self._ev("trend", {"current": 2664, "previous": 1569})
        assert _matching_population([ev]) == 4233

    def test_no_count_established_reports_nothing_rather_than_a_guess(self):
        from orchestrator.pipeline import _matching_population
        assert _matching_population([]) is None
        assert _matching_population([self._ev("comparison", {"sides": []})]) is None
        assert _matching_population([self._ev("trend", {"current": None,
                                                        "previous": 3})]) is None


# =========================================================================== #
# the model's own sentences: every figure bound to the evidence it cites
# =========================================================================== #

class TestGroundedSynthesis:
    """Three sentences that passed the old check and were all false.

    Each is taken from a live answer to "how many negative posts are there
    against the telangana police and what are most repetitive items", asked
    through the UI the day before a deployment.
    """

    def _evidence(self):
        total = _ev(1, source_type="aggregate", tool=C.AGGREGATE,
                    content="716 matching records",
                    facts={"total": 716, "measure": "matching records"})
        table = _ev(3, source_type="aggregate", tool=C.AGGREGATE,
                    content="breakdown by topics",
                    facts={"group_by": "topics", "rows": [
                        {"value": "murder", "count": 86},
                        {"value": "women_safety", "count": 46},
                        {"value": "protest", "count": 39}]})
        return [total, table]

    def test_a_figure_from_one_fact_cannot_be_cited_against_another(self):
        """19 was a theme count. The answer was 716."""
        evs = self._evidence()
        text = "There are 19 negative posts against the Telangana police [E1]."
        cleaned, removed = respond.check_claims(text, evs)
        assert cleaned == "" and removed == 1

    def test_the_real_total_cited_against_its_own_fact_survives(self):
        evs = self._evidence()
        text = "The monitored scope contains 716 matching records [E1]."
        cleaned, removed = respond.check_claims(text, evs)
        assert removed == 0 and "716" in cleaned

    def test_a_window_the_plan_did_not_set_is_struck_out(self):
        """The worked example said "in the last 7 days"; the scope was all time."""
        evs = self._evidence()
        text = "The scope contains 716 matching records in the last 7 days [E1]."
        cleaned, removed = respond.check_claims(text, evs, scope="all time")
        assert cleaned == "" and removed == 1

    def test_the_plans_own_window_is_allowed(self):
        evs = self._evidence()
        text = "The scope contains 716 matching records in the last 7 days [E1]."
        cleaned, removed = respond.check_claims(text, evs, scope="the last 7 days")
        assert removed == 0 and cleaned

    def test_invented_breakdown_labels_are_struck_out(self):
        """Real rows: murder, women_safety, protest."""
        evs = self._evidence()
        text = ("The largest observed topic groups are complaints, criticism, "
                "and requests for accountability [E3].")
        cleaned, removed = respond.check_claims(text, evs)
        assert cleaned == "" and removed == 1

    def test_the_real_labels_are_kept_however_they_are_spelled(self):
        evs = self._evidence()
        text = ("The largest observed topic groups are murder, women safety "
                "and protest [E3].")
        cleaned, removed = respond.check_claims(text, evs)
        assert removed == 0 and "murder" in cleaned

    def test_breakdown_rows_reach_the_model(self):
        """The labels were stripped from the prompt while the template printed
        them, which is why the model had to invent a list it had never seen."""
        evs = self._evidence()
        prompt = respond._prompt("what are the repetitive items", evs, "all time")
        assert "murder=86" in prompt
        # Handed to the model in reading spelling, since it copies a label
        # exactly as given and the sentence goes in front of an officer.
        assert "women safety=46" in prompt
        assert "women_safety" not in prompt
        assert "SCOPE: this answer covers all time" in prompt

    def test_the_prompt_carries_no_borrowable_figures(self):
        """A worked example with real numbers in it gets filled in as a form."""
        import re as _re
        for literal in ("3,087", "3087", "in the last 7 days"):
            assert literal not in respond._SYNTHESIS_PROMPT
