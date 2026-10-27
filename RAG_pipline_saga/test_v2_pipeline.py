"""
Phases 2-5 — the pipeline as a whole: properties the golden set does not
cover case by case.
"""

import json
import threading

import pytest

import conversation as conv
import v2fixture as fx
from fakemongo import FakeDB
from orchestrator import pipeline
from policy import PERM_AI_CHAT, RequestContext
from runtime import cache as cache_mod
from runtime import stores
from runtime.telemetry import METRICS

CORPUS = fx.build()
ALPHA = RequestContext(tenant_id="tenant-alpha", user_id="a1", role="admin")
BETA = RequestContext(tenant_id="tenant-beta", user_id="b1", role="admin")
HYD = RequestContext(tenant_id="tenant-alpha", user_id="o1", role="level-1",
                     districts=["Hyderabad"], permissions=frozenset({PERM_AI_CHAT}))


def deps(**kw):
    base = dict(store=conv.InMemoryConversationStore(),
                backend_factory=fx.backend_factory(CORPUS), raw_generate=fx.scripted_llm(),
                cache=False)
    base.update(kw)
    return pipeline.Deps(**base)


def ask(q, ctx=ALPHA, d=None, cid=None, **kw):
    return pipeline.run(q, ctx, d or deps(), conversation_id=cid, now=fx.NOW, **kw)


class TestNoWrites:
    def test_answering_never_writes_to_tenant_data(self):
        before = {t: {n: c.writes for n, c in db.items()} for t, db in CORPUS["dbs"].items()}
        for q in ("negative posts about corruption last week", "break down alerts by platform",
                  "posts about ration card problems", "Compare Hyderabad and Warangal.",
                  "What is happening around traffic in Hyderabad?"):
            ask(q)
        after = {t: {n: c.writes for n, c in db.items()} for t, db in CORPUS["dbs"].items()}
        assert before == after


class TestIsolationEndToEnd:
    QUESTIONS = ["alerts in Hyderabad", "negative posts", "break down alerts by handle",
                 "posts about ration card problems", "What is happening around traffic in Hyderabad?"]

    @pytest.mark.parametrize("q", QUESTIONS)
    def test_a_tenant_never_sees_the_other_tenants_records(self, q):
        for ctx in (ALPHA, BETA):
            r = ask(q, ctx)
            for e in r.internal.get("evidence", []):
                if e["source_type"] in ("record", "verdict") and e["source_id"]:
                    doc = fx.doc_for_key(CORPUS, e["source_id"])
                    assert doc["metadata"]["tenant_id"] == ctx.tenant_id

    @pytest.mark.parametrize("q", QUESTIONS)
    def test_an_officer_never_sees_another_district(self, q):
        r = ask(q, HYD)
        for e in r.internal.get("evidence", []):
            if e["source_type"] in ("record", "verdict") and e["source_id"]:
                ds = fx.doc_for_key(CORPUS, e["source_id"])["metadata"].get("districts") or []
                assert not ds or ds == ["Hyderabad"]

    def test_cached_results_do_not_cross_tenant_or_scope(self):
        cache_mod.RETRIEVAL.clear()
        cache_mod.PLANS.clear()
        d = deps(cache=True)
        a = ask("alerts in Hyderabad", ALPHA, d)
        b = ask("alerts in Hyderabad", BETA, d)
        o = ask("alerts in Hyderabad", HYD, d)
        ids = lambda r: {e["source_id"] for e in r.internal.get("evidence", []) if e.get("source_id")}
        assert ids(a) and ids(b) and not ids(a) & ids(b)
        assert all(fx.doc_for_key(CORPUS, k)["metadata"]["tenant_id"] == "tenant-beta" for k in ids(b))
        again = ask("alerts in Hyderabad", ALPHA, d)
        assert ids(again) == ids(a)
        assert cache_mod.RETRIEVAL.stats()["hits"] >= 1


class TestConversationThroughThePipeline:
    def test_follow_up_resolves_and_is_regated_for_the_current_caller(self):
        d = deps()
        knr = HYD.model_copy(update={"districts": ["Karimnagar"]})
        r1 = ask("alerts in Karimnagar", knr, d)
        assert r1.response.status in ("answered", "empty")
        r2 = ask("What about yesterday?", HYD, d, cid=r1.conversation_id)
        assert r2.response.status == "denied"

    def test_foreign_conversation_is_not_found(self):
        d = deps()
        r1 = ask("alerts in Karimnagar", ALPHA, d)
        with pytest.raises(conv.ConversationNotFound):
            ask("What about yesterday?", ALPHA.model_copy(update={"user_id": "someone"}), d,
                cid=r1.conversation_id)

    def test_mongo_conversation_store_end_to_end(self, monkeypatch):
        monkeypatch.setenv("AI_CONVERSATION_STORE", "mongo")
        stores.reset()
        dbs = {}
        store = stores.conversation_store(lambda t: dbs.setdefault(t, FakeDB()))
        d = deps(store=store)
        r1 = ask("negative posts about corruption last week", ALPHA, d)
        r2 = ask("and on facebook?", ALPHA, d, cid=r1.conversation_id)
        assert r2.turn == 2
        doc = dbs["tenant-alpha"]["ai_conversations"].docs[0]
        assert doc["turn_count"] == 2 and doc["tenant_id"] == "tenant-alpha"
        assert "tenant-beta" not in dbs
        stores.reset()

    def test_concurrent_turns_cannot_both_commit(self):
        d = deps()
        r1 = ask("alerts in Karimnagar", ALPHA, d)
        results, errors = [], []

        def turn(q):
            try:
                results.append(ask(q, ALPHA, d, cid=r1.conversation_id))
            except conv.ConversationConflict as exc:
                errors.append(exc)
        ts = [threading.Thread(target=turn, args=(q,)) for q in ("What about yesterday?",
                                                                 "What about last week?")]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        state = d.store.get("tenant-alpha", "a1", r1.conversation_id)
        assert state.turn_count == 1 + len(results) and len(results) + len(errors) == 2


class TestAuditAndTelemetry:
    def test_audit_records_identifiers_not_source_text(self):
        db = FakeDB()

        class Sink(stores.AuditSink):
            def __init__(self):
                self.mode, self.db_for_tenant, self.rows = "mongo", (lambda t: db), []
        sink = Sink()
        r = ask("negative posts about corruption last week", ALPHA, deps(audit=sink))
        (row,) = db["ai_audit"].docs
        assert row["request_id"] == r.response.request_id and row["tools"]
        blob = json.dumps(row, default=str)
        assert "revenue office staff" not in blob          # no source record content
        assert row["answer_digest"] and row["decision"] == "allowed"

    def test_trace_has_every_stage_and_no_identifiers(self):
        METRICS.reset()
        r = ask("break down alerts by platform")
        stages = [s["stage"] for s in r.trace["spans"]]
        for s in ("understanding", "conversation.resolve", "enrichment.location", "policy",
                  "compile", "execute", "verify", "respond", "conversation.commit"):
            assert s in stages
        blob = json.dumps(r.trace)
        assert "tenant-alpha" not in blob and "a1" not in r.trace.get("user_ref", "")
        assert METRICS.snapshot()["latency_ms"]["request.total"]["n"] >= 1


class TestDeterminism:
    def test_same_question_same_answer(self):
        a = ask("break down alerts by platform").response
        b = ask("break down alerts by platform").response
        assert a.answer == b.answer and a.facts == b.facts


# =========================================================================== #
# API
# =========================================================================== #

@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient
    import api_server
    monkeypatch.setattr(api_server, "_v2_backend", fx.backend_factory(CORPUS))
    monkeypatch.setattr(api_server, "_v2_raw_generate", fx.scripted_llm())
    monkeypatch.setattr(api_server, "_v2_db_for_tenant", lambda t: FakeDB())
    monkeypatch.delenv("AI_CONVERSATION_STORE", raising=False)
    monkeypatch.delenv("AI_AUDIT_SINK", raising=False)
    stores.reset()
    yield TestClient(api_server.app)
    stores.reset()


BODY = {"tenant_id": "tenant-alpha", "user_id": "o1", "role": "level-1",
        "districts": ["Hyderabad"],
        "permissions": {"/ai-assistant": {"enabled": True, "features": ["ai_chat"]}}}


class TestApi:
    def test_off_by_default(self, client, monkeypatch):
        monkeypatch.delenv("AI_ASSISTANT_ARCHITECTURE_V2", raising=False)
        assert client.get("/api/rag/v2/status").json() == {"enabled": False}
        assert client.post("/api/rag/v2/query", json={**BODY, "question": "hi"}).status_code == 404
        assert client.post("/api/rag/v2/feedback", json={**BODY, "kind": "useful",
                                                         "target": {"type": "answer"}}).status_code == 404

    @pytest.fixture
    def on(self, monkeypatch):
        monkeypatch.setenv("AI_ASSISTANT_ARCHITECTURE_V2", "true")

    def test_query_and_follow_up(self, client, on):
        r1 = client.post("/api/rag/v2/query", json={**BODY, "question": "high risk alerts"}).json()
        assert r1["response"]["status"] in ("answered", "empty")
        r2 = client.post("/api/rag/v2/query", json={**BODY, "conversation_id": r1["conversation_id"],
                                                    "question": "What about yesterday?"}).json()
        assert r2["turn"] == 2

    def test_response_leaks_no_tenant_or_internal_provenance(self, client, on):
        r = client.post("/api/rag/v2/query", json={**BODY, "question": "high risk alerts"}).json()
        blob = json.dumps(r)
        assert "tenant-alpha" not in blob and "_tenant" not in blob and "provenance" not in blob

    def test_denial_is_a_response_not_an_error(self, client, on):
        r = client.post("/api/rag/v2/query", json={**BODY, "question": "alerts in Warangal"}).json()
        assert r["response"]["status"] == "denied"

    @pytest.mark.parametrize("missing", ["tenant_id", "user_id"])
    def test_identity_required(self, client, on, missing):
        body = {**BODY, "question": "x"}
        body.pop(missing)
        assert client.post("/api/rag/v2/query", json=body).status_code == 400

    def test_foreign_conversation_404(self, client, on):
        r1 = client.post("/api/rag/v2/query", json={**BODY, "question": "high risk alerts"}).json()
        r = client.post("/api/rag/v2/query", json={**BODY, "user_id": "o2",
                                                   "conversation_id": r1["conversation_id"],
                                                   "question": "and yesterday?"})
        assert r.status_code == 404

    def test_header_tenant_mismatch_denied(self, client, on):
        r = client.post("/api/rag/v2/query", json={**BODY, "question": "high risk alerts"},
                        headers={"X-Tenant-Id": "tenant-beta"}).json()
        assert r["response"]["status"] == "denied"

    def test_feedback_validated(self, client, on):
        ok = client.post("/api/rag/v2/feedback", json={**BODY, "kind": "useful",
                                                       "target": {"type": "answer", "request_id": "r1"}})
        assert ok.status_code == 200 and ok.json()["state"] == "new"
        bad = client.post("/api/rag/v2/feedback", json={**BODY, "kind": "drop_table",
                                                        "target": {"type": "answer"}})
        assert bad.status_code == 400

    def test_metrics_have_no_identifiers(self, client, on):
        client.post("/api/rag/v2/query", json={**BODY, "question": "high risk alerts"})
        m = client.get("/api/rag/v2/metrics").json()
        assert "latency_ms" in m and "tenant-alpha" not in json.dumps(m)

    def test_existing_query_route_is_untouched(self, client, on):
        import api_server
        paths = {r.path for r in api_server.app.routes}
        assert "/api/rag/query" in paths and "/api/rag/v2/query" in paths


class TestRelatedContentTool:
    """The handler end to end over the fixture. (Phase 1A never requests this
    capability yet, so the golden set cannot reach it; see the report.)"""

    def test_related_records_share_signals_and_stay_in_scope(self):
        from orchestrator.models import RelatedArgs, SpecArgs
        from orchestrator.tools import ToolContext, hybrid_search, related_content_search
        from orchestrator.models import SearchArgs
        backend, _ = fx.backend_factory(CORPUS)("tenant-alpha")
        ctx = ToolContext(tenant_id="tenant-alpha", districts=["Hyderabad"], backend=backend,
                          now=fx.NOW)
        seeds = hybrid_search(SearchArgs(spec=SpecArgs(text="bribe corruption", topics=["corruption"])), ctx)
        ctx2 = ToolContext(tenant_id="tenant-alpha", districts=["Hyderabad"], backend=backend,
                           now=fx.NOW, inputs={"s": seeds})
        out = related_content_search(RelatedArgs(spec=SpecArgs(), top_k=10), ctx2)
        assert out["records"], "expected related records"
        seed_keys = set(out["seeds"])
        for r in out["records"]:
            assert r["key"] not in seed_keys
            assert len(r["signals"]) >= 2 or {"entity", "lexical", "semantic"} & set(r["signals"])
            doc = fx.doc_for_key(CORPUS, r["key"])
            assert doc["metadata"]["tenant_id"] == "tenant-alpha"
            assert (doc["metadata"].get("districts") or ["Hyderabad"]) == ["Hyderabad"]
