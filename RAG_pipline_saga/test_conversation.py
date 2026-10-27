"""
Phase 1C — Conversation Context.

The golden set (test_conversation_golden.py) pins resolution behaviour. This
file pins the properties that make memory safe to have at all: it is owned,
bounded, versioned, structured, and it never becomes authority.
"""

import ast
import json
import os
import statistics
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

import conversation as conv
from conversation import (ConversationAccessError, ConversationConfig,
                          ConversationConflict, ConversationNotFound,
                          InMemoryConversationStore, InvalidConversationId,
                          MongoConversationStore, ResolutionStatus, build_turn,
                          resolve_query)
from conversation.models import ConversationState, ConversationTurn
from policy import (PERM_AI_CHAT, PolicyConfig, PolicyDecision, ReasonCode,
                    RequestContext, evaluate)
from query_understanding import understand
from query_understanding.models import FilterField

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "query_understanding", "golden_queries.json"), encoding="utf-8") as fh:
    GOLDEN = json.load(fh)

T, U = "tenant-alpha", "officer-1"
ADMIN = RequestContext(tenant_id=T, user_id=U, role="admin")
HYD = RequestContext(tenant_id=T, user_id=U, role="level-1", districts=["Hyderabad"],
                     permissions=frozenset({PERM_AI_CHAT}))
KNR = HYD.model_copy(update={"districts": ["Karimnagar"]})
T0 = datetime(2026, 9, 22, 10, 0, tzinfo=timezone.utc)


def plan_of(q):
    return understand(q)[0]


def run(questions, ctx=ADMIN, store=None, at=T0):
    """Ask `questions` in one conversation; return (store, state, [resolved])."""
    store = store or InMemoryConversationStore()
    state = store.create(ctx.tenant_id, ctx.user_id, at=at)
    out = []
    for q in questions:
        plan = plan_of(q)
        rq = resolve_query(plan, state, ctx, config=store.config)
        state = store.append(state, build_turn(state.turn_count + 1, q, rq, store.config,
                                               at=at, query_plan=plan),
                             expected_sequence=state.turn_count, at=at)
        out.append(rq)
    return store, state, out


# =========================================================================== #
# identity and isolation
# =========================================================================== #

class TestIsolation:
    def test_owner_can_read(self):
        store, state, _ = run(["Show alerts in Karimnagar."])
        assert store.get(T, U, state.conversation_id, at=T0).turn_count == 1

    @pytest.mark.parametrize("tenant,user", [("tenant-beta", U), (T, "officer-2"),
                                             ("tenant-beta", "officer-2")])
    def test_foreign_reads_look_exactly_like_unknown_ids(self, tenant, user):
        store, state, _ = run(["Show alerts in Karimnagar."])
        with pytest.raises(ConversationNotFound) as foreign:
            store.get(tenant, user, state.conversation_id, at=T0)
        with pytest.raises(ConversationNotFound) as unknown:
            store.get(T, U, "f" * 32, at=T0)
        # Same type, same public code; only the audit reason differs.
        assert type(foreign.value) is type(unknown.value)
        assert foreign.value.code == unknown.value.code

    @pytest.mark.parametrize("cid", ["*", "all", "", "   ", "$ne", "../etc", "a" * 8,
                                     "a" * 65, "{'$gt': ''}", None])
    def test_wildcard_and_malformed_ids_are_refused(self, cid):
        store, _, _ = run(["hi"])
        with pytest.raises((InvalidConversationId, ConversationNotFound)):
            store.get(T, U, cid, at=T0)

    @pytest.mark.parametrize("tenant,user", [("", U), (T, ""), (None, U), (T, None)])
    def test_no_anonymous_conversations(self, tenant, user):
        with pytest.raises(ConversationNotFound):
            InMemoryConversationStore().create(tenant, user)

    def test_resolver_refuses_state_that_is_not_the_callers(self):
        _, state, _ = run(["Show alerts in Karimnagar."])
        plan = plan_of("What about yesterday?")
        with pytest.raises(ConversationAccessError) as e:
            resolve_query(plan, state, ADMIN.model_copy(update={"tenant_id": "tenant-beta"}))
        assert e.value.code == "TENANT_MISMATCH"
        with pytest.raises(ConversationAccessError) as e:
            resolve_query(plan, state, ADMIN.model_copy(update={"user_id": "officer-2"}))
        assert e.value.code == "USER_MISMATCH"

    def test_foreign_delete_is_a_no_op(self):
        store, state, _ = run(["Show alerts in Karimnagar."])
        assert store.delete("tenant-beta", U, state.conversation_id) is False
        assert store.delete(T, "officer-2", state.conversation_id) is False
        assert store.delete(T, U, state.conversation_id) is True
        with pytest.raises(ConversationNotFound):
            store.get(T, U, state.conversation_id, at=T0)

    def test_ids_are_server_issued_and_unguessable(self):
        store = InMemoryConversationStore()
        ids = {store.create(T, U).conversation_id for _ in range(200)}
        assert len(ids) == 200 and all(len(i) == 32 for i in ids)


# =========================================================================== #
# memory is context, not authority
# =========================================================================== #

class TestNoAuthorityInMemory:
    AUTHORITY = {"role", "permissions", "districts", "effective_districts", "decision",
                 "policy", "allowed_capabilities", "is_admin", "authorized"}

    def test_state_and_turn_schemas_hold_no_authority(self):
        for model in (ConversationState, ConversationTurn, conv.TurnContext):
            assert not set(model.model_fields) & self.AUTHORITY, model.__name__

    def test_a_stored_conversation_contains_no_authority(self):
        _, state, _ = run(["Show high-risk alerts in Hyderabad.", "What about yesterday?"], ctx=HYD)
        blob = state.model_dump(mode="json")

        def keys(o):
            if isinstance(o, dict):
                for k, v in o.items():
                    yield k
                    yield from keys(v)
            elif isinstance(o, list):
                for v in o:
                    yield from keys(v)
        assert not set(keys(blob)) & self.AUTHORITY
        assert PERM_AI_CHAT not in json.dumps(blob)

    def test_assistant_prose_is_never_stored(self):
        fields = set(ConversationTurn.model_fields)
        assert not fields & {"answer", "response", "assistant", "assistant_response", "summary"}

    def test_resolution_does_not_depend_on_authority(self):
        """Admin and a one-district officer (same tenant, same user id) get the
        SAME resolved plan; only the gate's verdict differs."""
        _, state, _ = run(["Show alerts in Karimnagar."])
        plan = plan_of("What about there?")
        a = resolve_query(plan, state, ADMIN).model_dump(mode="json")
        b = resolve_query(plan, state, HYD).model_dump(mode="json")
        assert a == b

    def test_revoked_scope_is_refused_on_the_next_turn(self):
        store, state, _ = run(["Show alerts in Karimnagar."], ctx=KNR)
        plan = plan_of("What about yesterday?")
        rq = resolve_query(plan, state, HYD)
        assert rq.resolved_plan.location.text == "Karimnagar"    # remembered, not rewritten
        verdict = evaluate(rq.resolved_plan, HYD, config=PolicyConfig())
        assert verdict.decision is PolicyDecision.DENIED
        assert ReasonCode.DISTRICT_OUTSIDE_SCOPE in verdict.reason_codes()
        # The same turn for the officer who still holds Karimnagar is fine.
        assert evaluate(rq.resolved_plan, KNR, config=PolicyConfig()).decision \
            is not PolicyDecision.DENIED

    def test_revoked_permission_is_refused_on_the_next_turn(self):
        _, state, _ = run(["Show alerts in Karimnagar."], ctx=KNR)
        rq = resolve_query(plan_of("What about yesterday?"), state, KNR)
        revoked = KNR.model_copy(update={"permissions": frozenset()})
        assert evaluate(rq.resolved_plan, revoked, config=PolicyConfig()).decision \
            is PolicyDecision.DENIED


# =========================================================================== #
# resolved plans: new, valid, gate-ready
# =========================================================================== #

def _all_golden_conversations():
    for case in GOLDEN["conversation_cases"]:
        if case["category"] != "isolation":
            yield case["id"], case["turns"]


class TestResolvedPlans:
    def test_the_planners_plan_is_never_modified(self):
        _, state, _ = run(["Show high-risk alerts in Hyderabad."])
        plan = plan_of("What about yesterday?")
        before = plan.model_dump(mode="json")
        rq = resolve_query(plan, state, ADMIN)
        assert plan.model_dump(mode="json") == before
        assert rq.resolved_plan is not plan

    @pytest.mark.parametrize("cid,turns", list(_all_golden_conversations()))
    def test_every_resolved_plan_is_valid_and_structurally_acceptable_to_the_gate(self, cid, turns):
        from query_understanding.validator import validate
        _, _, results = run(turns)
        structural = {ReasonCode.INVALID_PLAN, ReasonCode.UNSAFE_PLAN, ReasonCode.UNKNOWN_TOOL,
                      ReasonCode.CAPABILITY_NOT_ALLOWED}
        for rq in results:
            assert validate(rq.resolved_plan).valid, cid
            verdict = evaluate(rq.resolved_plan, ADMIN, config=PolicyConfig())
            assert not set(verdict.reason_codes()) & structural, (cid, verdict.reason_codes())

    @pytest.mark.parametrize("cid,turns", list(_all_golden_conversations()))
    def test_an_unresolved_follow_up_can_never_run(self, cid, turns):
        """Defence in depth: even a caller that ignores the status cannot
        execute an unresolved follow-up, because the gate refuses it too."""
        _, _, results = run(turns)
        for rq in results:
            if rq.status in (ResolutionStatus.CONTEXT_REQUIRED, ResolutionStatus.CONTEXT_AMBIGUOUS):
                verdict = evaluate(rq.resolved_plan, ADMIN, config=PolicyConfig())
                assert verdict.decision is PolicyDecision.CLARIFICATION_REQUIRED, cid
                assert verdict.allowed_capabilities == []

    @pytest.mark.parametrize("cid,turns", list(_all_golden_conversations()))
    def test_conversation_never_widens_district_scope(self, cid, turns):
        _, _, results = run(turns, ctx=HYD)
        for rq in results:
            verdict = evaluate(rq.resolved_plan, HYD, config=PolicyConfig())
            assert verdict.effective_districts is not None
            assert set(verdict.effective_districts) <= {"Hyderabad"}, cid

    def test_resolution_is_deterministic(self):
        _, state, _ = run(["Show high-risk alerts in Hyderabad.", "posts about corruption"])
        plan = plan_of("What about there?")
        a = resolve_query(plan, state, ADMIN).model_dump_json()
        b = resolve_query(plan, state, ADMIN).model_dump_json()
        assert a == b

    def test_inherited_values_carry_context_provenance(self):
        _, _, (_, rq) = run(["Show high-risk alerts in Hyderabad.", "What about yesterday?"])
        p = rq.resolved_plan
        assert p.location.source.value == "context"
        assert {f.source.value for f in p.filters} == {"context"}
        assert p.time_range.source.value != "context"     # typed this turn

    def test_explicit_beats_referent_beats_inherited(self):
        _, state, _ = run(["Show alerts in Warangal last week.", "posts about corruption in Karimnagar"])
        # explicit: typed now
        rq = resolve_query(plan_of("what about Nizamabad?"), state, ADMIN)
        assert rq.resolved_plan.location.text == "Nizamabad"
        # referent: 'there' -> newest turn with a place
        rq = resolve_query(plan_of("What about there?"), state, ADMIN)
        assert rq.resolved_plan.location.text == "Karimnagar"
        uses = {(u.field, u.via.value) for u in rq.context_used}
        assert ("location", "referent") in uses
        # inherited: nothing named, nothing referred to
        rq = resolve_query(plan_of("What about yesterday?"), state, ADMIN)
        assert ("location", "inherited") in {(u.field, u.via.value) for u in rq.context_used}

    def test_referent_confidence_decays_with_distance(self):
        _, state, _ = run(["Show alerts in Warangal.", "posts about corruption",
                           "negative posts on facebook"])
        rq = resolve_query(plan_of("What about there?"), state, ADMIN)
        (loc,) = [r for r in rq.resolved_referents if r.target_type.value == "location"]
        assert loc.source_turn == 1 and loc.confidence < 0.9

    def test_clarification_turns_do_not_become_context(self):
        _, state, (first, second) = run(["Compare Hyderabad and Warangal.", "What about there?"])
        assert second.status is ResolutionStatus.CONTEXT_AMBIGUOUS
        assert state.recent_turns[-1].context is None
        assert state.active_turn == 1

    def test_greetings_do_not_become_context(self):
        _, state, _ = run(["Show alerts in Karimnagar.", "hi"])
        assert state.active_turn == 1
        rq = resolve_query(plan_of("What about yesterday?"), state, ADMIN)
        assert rq.resolved_plan.location.text == "Karimnagar"


# =========================================================================== #
# bounds, TTL, versioning, atomicity
# =========================================================================== #

class TestBounds:
    def test_history_is_bounded(self):
        cfg = ConversationConfig(max_turns=3)
        store = InMemoryConversationStore(cfg)
        _, state, _ = run([f"negative posts about corruption on facebook {i}" for i in range(7)],
                          store=store)
        assert state.turn_count == 7
        assert [t.sequence for t in state.recent_turns] == [5, 6, 7]

    def test_context_items_are_bounded(self):
        cfg = ConversationConfig(max_context_items=2)
        plan = plan_of("negative high risk alerts on facebook about corruption tagging @a @b @c")
        ctx = conv.extract_context(plan, cfg)
        for field in ("filters", "concepts", "entities", "locations"):
            assert len(getattr(ctx, field)) <= 2

    def test_stored_question_text_is_bounded(self):
        store, state, _ = run(["corruption " * 200])
        assert len(state.recent_turns[0].user_query) <= store.config.max_query_chars

    def test_env_config_is_clamped(self, monkeypatch):
        monkeypatch.setenv("AI_CONVERSATION_MAX_TURNS", "1000000")
        monkeypatch.setenv("AI_CONVERSATION_TTL", "5")
        monkeypatch.setenv("AI_CONVERSATION_MAX_CONTEXT_ITEMS", "nonsense")
        cfg = ConversationConfig.from_env()
        assert cfg.max_turns == 50 and cfg.ttl_seconds == 60 and cfg.max_context_items == 20

    def test_idle_conversations_expire(self):
        store, state, _ = run(["Show alerts in Karimnagar."])
        later = T0 + timedelta(seconds=store.config.ttl_seconds + 1)
        with pytest.raises(ConversationNotFound) as e:
            store.get(T, U, state.conversation_id, at=later)
        assert e.value.reason == "expired"
        # And it is gone, not merely hidden.
        with pytest.raises(ConversationNotFound) as e:
            store.get(T, U, state.conversation_id, at=T0)
        assert e.value.reason == "not_found"

    def test_each_turn_extends_the_ttl(self):
        store, state, _ = run(["Show alerts in Karimnagar."])
        mid = T0 + timedelta(seconds=store.config.ttl_seconds - 10)
        plan = plan_of("What about yesterday?")
        rq = resolve_query(plan, state, ADMIN)
        store.append(state, build_turn(2, "q", rq, store.config, at=mid), 1, at=mid)
        still = mid + timedelta(seconds=store.config.ttl_seconds - 10)
        assert store.get(T, U, state.conversation_id, at=still).turn_count == 2

    def test_other_schema_versions_are_never_reinterpreted(self):
        store, state, _ = run(["Show alerts in Karimnagar."])
        store._data[state.conversation_id] = store._data[state.conversation_id].model_copy(
            update={"schema_version": "conv-0"})
        with pytest.raises(ConversationNotFound) as e:
            store.get(T, U, state.conversation_id, at=T0)
        assert e.value.reason == "schema_incompatible"

    def test_stale_append_is_refused(self):
        store, state, _ = run(["Show alerts in Karimnagar."])
        plan = plan_of("What about yesterday?")
        rq = resolve_query(plan, state, ADMIN)
        store.append(state, build_turn(2, "a", rq, store.config, at=T0), 1, at=T0)
        with pytest.raises(ConversationConflict):
            store.append(state, build_turn(2, "b", rq, store.config, at=T0), 1, at=T0)

    def test_out_of_order_sequence_is_refused(self):
        store, state, _ = run(["Show alerts in Karimnagar."])
        rq = resolve_query(plan_of("What about yesterday?"), state, ADMIN)
        with pytest.raises(ConversationConflict):
            store.append(state, build_turn(5, "x", rq, store.config, at=T0), 1, at=T0)

    def test_concurrent_writers_produce_exactly_one_next_turn(self):
        store, state, _ = run(["Show alerts in Karimnagar."])
        rq = resolve_query(plan_of("What about yesterday?"), state, ADMIN)
        wins, conflicts = [], []

        def write(i):
            try:
                store.append(state, build_turn(2, f"w{i}", rq, store.config, at=T0), 1, at=T0)
                wins.append(i)
            except ConversationConflict:
                conflicts.append(i)
        threads = [threading.Thread(target=write, args=(i,)) for i in range(16)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert len(wins) == 1 and len(conflicts) == 15
        assert store.get(T, U, state.conversation_id, at=T0).turn_count == 2

    def test_in_memory_store_is_capacity_bounded(self):
        store = InMemoryConversationStore(max_conversations=5)
        for _ in range(12):
            store.create(T, U)
        assert len(store._data) <= 5


# =========================================================================== #
# MongoDB store, against a fake collection
# =========================================================================== #

class _Result:
    def __init__(self, n):
        self.deleted_count = n


class FakeCollection:
    """Equality filters only — exactly what the store uses. Dates are stored
    naive, as BSON returns them."""

    def __init__(self):
        self.docs, self.indexes = [], []

    @staticmethod
    def _naive(doc):
        out = dict(doc)
        for k in ("created_at", "updated_at", "expires_at"):
            if isinstance(out.get(k), datetime):
                out[k] = out[k].astimezone(timezone.utc).replace(tzinfo=None)
        return out

    def _match(self, doc, flt):
        return all(doc.get(k) == v for k, v in flt.items())

    def create_index(self, keys, **kw):
        self.indexes.append((keys, kw))

    def insert_one(self, doc):
        self.docs.append(self._naive(json.loads(json.dumps(doc, default=str)) | {
            k: doc[k] for k in ("created_at", "updated_at", "expires_at")}))

    def find_one(self, flt):
        return next((dict(d) for d in self.docs if self._match(d, flt)), None)

    def find_one_and_update(self, flt, update):
        for i, d in enumerate(self.docs):
            if self._match(d, flt):
                new = dict(d)
                new.update(update["$set"])
                self.docs[i] = self._naive(new)
                return dict(d)
        return None

    def delete_one(self, flt):
        for i, d in enumerate(self.docs):
            if self._match(d, flt):
                del self.docs[i]
                return _Result(1)
        return _Result(0)


class TestMongoStore:
    def _store(self):
        cols = {}
        store = MongoConversationStore(lambda tenant: cols.setdefault(tenant, FakeCollection()))
        return store, cols

    def test_round_trip_in_the_tenants_own_collection(self):
        store, cols = self._store()
        state = store.create(T, U, at=T0)
        rq = resolve_query(plan_of("Show alerts in Karimnagar."), state, ADMIN)
        store.append(state, build_turn(1, "q", rq, store.config, at=T0), 0, at=T0)
        got = store.get(T, U, state.conversation_id, at=T0)
        assert got.turn_count == 1 and got.active.locations[0].text == "Karimnagar"
        assert got.expires_at.tzinfo is not None
        assert list(cols) == [T]          # written only to that tenant's database

    def test_foreign_owner_finds_nothing(self):
        store, cols = self._store()
        state = store.create(T, U, at=T0)
        for tenant, user in (("tenant-beta", U), (T, "officer-2")):
            with pytest.raises(ConversationNotFound):
                store.get(tenant, user, state.conversation_id, at=T0)
        assert len(cols[T].docs) == 1 and not cols.get("tenant-beta", FakeCollection()).docs

    def test_append_is_compare_and_set(self):
        store, _ = self._store()
        state = store.create(T, U, at=T0)
        rq = resolve_query(plan_of("Show alerts in Karimnagar."), state, ADMIN)
        store.append(state, build_turn(1, "q", rq, store.config, at=T0), 0, at=T0)
        with pytest.raises(ConversationConflict):
            store.append(state, build_turn(1, "q", rq, store.config, at=T0), 0, at=T0)

    def test_schema_version_is_checked(self):
        store, cols = self._store()
        state = store.create(T, U, at=T0)
        cols[T].docs[0]["schema_version"] = "conv-0"
        with pytest.raises(ConversationNotFound):
            store.get(T, U, state.conversation_id, at=T0)

    def test_indexes_enforce_ownership_uniqueness_and_ttl(self):
        col = FakeCollection()
        MongoConversationStore.ensure_indexes(col)
        by_name = {kw["name"]: (keys, kw) for keys, kw in col.indexes}
        assert by_name["owner_conversation"][1]["unique"] is True
        assert by_name["ttl_expires_at"][1]["expireAfterSeconds"] == 0

    def test_foreign_delete_removes_nothing(self):
        store, cols = self._store()
        state = store.create(T, U, at=T0)
        assert store.delete(T, "officer-2", state.conversation_id) is False
        assert len(cols[T].docs) == 1


# =========================================================================== #
# the layer's boundaries
# =========================================================================== #

FORBIDDEN = {"pymongo", "motor", "requests", "httpx", "llm_client", "retriever", "scan",
             "engine", "analytics", "vector_store", "embedder", "reranker", "judge", "expander",
             "tenants", "api_server", "openai",
             # The context layer must not make policy decisions — it may not
             # even import the gate.
             "policy"}


class TestBoundaries:
    def test_package_imports_no_io_model_or_policy_module(self):
        pkg = os.path.join(HERE, "conversation")
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
                    assert m.split(".")[0] not in FORBIDDEN, (name, m)

    def test_resolution_runs_with_every_client_booby_trapped(self, monkeypatch):
        import llm_client
        import pymongo
        import requests

        def boom(*a, **k):
            raise AssertionError("the context layer reached for I/O or a model")
        for mod, attr in ((pymongo, "MongoClient"), (requests, "post"), (requests, "get"),
                          (llm_client, "generate")):
            monkeypatch.setattr(mod, attr, boom)
        for _, turns in _all_golden_conversations():
            run(turns)


# =========================================================================== #
# performance
# =========================================================================== #

def test_resolution_latency():
    _, state, _ = run(["Show high-risk alerts in Hyderabad.", "posts about corruption",
                       "Show alerts in Karimnagar last week"])
    plans = [plan_of(q) for q in ("What about yesterday?", "What about there?",
                                  "Show me those alerts.", "and on facebook?",
                                  "Break that down by category.", "Show all alerts.")]
    samples = []
    for _ in range(100):
        for plan in plans:
            t0 = time.perf_counter()
            resolve_query(plan, state, ADMIN)
            samples.append((time.perf_counter() - t0) * 1000)
    samples.sort()
    assert statistics.median(samples) < 5
    assert samples[int(len(samples) * 0.95)] < 15


# =========================================================================== #
# development endpoint
# =========================================================================== #

@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    import api_server
    api_server._conversation_store = None        # a fresh store per test
    return TestClient(api_server.app)


@pytest.fixture
def on(monkeypatch):
    monkeypatch.setenv("AI_ASSISTANT_ARCHITECTURE_V2", "true")
    monkeypatch.delenv("AI_CONVERSATION_ENABLED", raising=False)
    monkeypatch.delenv("AI_POLICY_DISABLED_CAPABILITIES", raising=False)


BODY = {"tenant_id": T, "user_id": U, "role": "level-1", "districts": ["Karimnagar"],
        "permissions": {"/ai-assistant": {"enabled": True, "features": ["ai_chat"]}}}
URL = "/api/rag/conversation/resolve"


class TestEndpoint:
    def test_off_by_default(self, client, monkeypatch):
        monkeypatch.delenv("AI_ASSISTANT_ARCHITECTURE_V2", raising=False)
        assert client.post(URL, json={**BODY, "question": "hi"}).status_code == 404

    def test_own_flag_switches_it_off(self, client, monkeypatch):
        monkeypatch.setenv("AI_ASSISTANT_ARCHITECTURE_V2", "true")
        monkeypatch.setenv("AI_CONVERSATION_ENABLED", "false")
        assert client.post(URL, json={**BODY, "question": "hi"}).status_code == 404

    def test_tenant_and_user_are_required(self, client, on):
        for missing in ("tenant_id", "user_id"):
            body = {**BODY, "question": "hi"}
            body.pop(missing)
            assert client.post(URL, json=body).status_code == 400

    def test_a_conversation_end_to_end(self, client, on):
        r1 = client.post(URL, json={**BODY, "question": "Show high-risk alerts in Karimnagar."}).json()
        assert r1["turn"] == 1 and r1["status"] == "RESOLVED"
        r2 = client.post(URL, json={**BODY, "conversation_id": r1["conversation_id"],
                                    "question": "What about yesterday?"}).json()
        assert r2["turn"] == 2 and r2["status"] == "RESOLVED"
        plan = r2["resolved_plan"]
        assert plan["location"]["text"] == "Karimnagar"
        assert plan["time_range"]["kind"] == "yesterday"
        assert {"risk_level", "kind"} <= {f["field"] for f in plan["filters"]}
        assert r2["policy"]["effective_districts"] == ["Karimnagar"]
        assert "answer" not in r2

    @pytest.mark.parametrize("who", [{"tenant_id": "tenant-beta"}, {"user_id": "officer-2"}])
    def test_someone_elses_conversation_is_not_found(self, client, on, who):
        r1 = client.post(URL, json={**BODY, "question": "Show alerts in Karimnagar."}).json()
        r = client.post(URL, json={**BODY, **who, "conversation_id": r1["conversation_id"],
                                   "question": "What about there?"})
        assert r.status_code == 404 and r.json()["detail"] == "conversation not found"

    @pytest.mark.parametrize("cid", ["*", "all", "$ne", "0" * 32])
    def test_wildcard_or_unknown_id_is_not_found(self, client, on, cid):
        r = client.post(URL, json={**BODY, "conversation_id": cid, "question": "What about there?"})
        assert r.status_code == 404 and r.json()["detail"] == "conversation not found"

    def test_scope_change_between_turns_is_enforced(self, client, on):
        r1 = client.post(URL, json={**BODY, "question": "Show alerts in Karimnagar."}).json()
        moved = {**BODY, "districts": ["Hyderabad"]}
        r2 = client.post(URL, json={**moved, "conversation_id": r1["conversation_id"],
                                    "question": "What about there?"}).json()
        assert r2["resolved_plan"]["location"]["text"] == "Karimnagar"
        assert r2["policy"]["decision"] == "denied"
        assert "DISTRICT_OUTSIDE_SCOPE" in r2["policy"]["reason_codes"]

    def test_dry_run_does_not_advance_the_conversation(self, client, on):
        r1 = client.post(URL, json={**BODY, "question": "Show alerts in Karimnagar."}).json()
        cid = r1["conversation_id"]
        r2 = client.post(URL, json={**BODY, "conversation_id": cid, "commit": False,
                                    "question": "What about yesterday?"}).json()
        assert r2["turn"] == 1
        r3 = client.post(URL, json={**BODY, "conversation_id": cid,
                                    "question": "What about yesterday?"}).json()
        assert r3["turn"] == 2

    def test_concurrent_turn_is_a_conflict(self, client, on, monkeypatch):
        import api_server
        r1 = client.post(URL, json={**BODY, "question": "Show alerts in Karimnagar."}).json()
        store = api_server._conversations()

        def stale(*a, **k):
            raise ConversationConflict("moved on")
        monkeypatch.setattr(store, "append", stale)
        r = client.post(URL, json={**BODY, "conversation_id": r1["conversation_id"],
                                   "question": "What about yesterday?"})
        assert r.status_code == 409

    def test_header_tenant_mismatch_still_reaches_the_gate(self, client, on):
        r = client.post(URL, json={**BODY, "question": "Show alerts in Karimnagar."},
                        headers={"X-Tenant-Id": "tenant-beta"}).json()
        assert r["policy"]["decision"] == "denied"
        assert "TENANT_MISMATCH" in r["policy"]["reason_codes"]
