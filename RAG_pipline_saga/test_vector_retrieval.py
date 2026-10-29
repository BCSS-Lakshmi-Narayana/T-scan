"""The retrieval production path: indexed ANN when available, degraded openly.

Semantic search silently meaning "local cosine over a sample of recent chunks"
is the failure these cover. It is not a crash, nothing is logged at error level,
and recall drops from 5/5 to 1/5 — measured against exhaustive cosine on this
corpus. So every path is named in telemetry, degradation is attributable to a
collection, and the index configuration the query relies on is verified rather
than assumed.

No server needed: the collection is a stub that records what it was asked.
"""

import pytest

import vector_store as vs
from vector_store import VectorStore

URI = "mongodb://localhost:27017"


class FakeCursor(list):
    pass


class FakeCollection:
    """Enough Collection surface for the search ladder, and a record of calls."""

    name = "vector_embeddings_alerts"

    def __init__(self, search_indexes=None, aggregate_result=None,
                 aggregate_error=None, docs=None):
        self._search_indexes = search_indexes if search_indexes is not None else []
        self._aggregate_result = aggregate_result or []
        self._aggregate_error = aggregate_error
        self._docs = docs or []
        self.pipelines = []
        self.probes = 0

    def list_search_indexes(self):
        self.probes += 1
        return list(self._search_indexes)

    def aggregate(self, pipeline, **kw):
        self.pipelines.append(pipeline)
        if self._aggregate_error:
            raise self._aggregate_error
        return FakeCursor(self._aggregate_result)

    def estimated_document_count(self):
        return len(self._docs)

    def find(self, *a, **kw):
        return self

    def sort(self, *a, **kw):
        return self

    def limit(self, *a, **kw):
        return FakeCursor(self._docs)

    def create_index(self, *a, **kw):
        return "idx"

    def list_indexes(self):
        return FakeCursor([{"name": "text_search_idx"}])


READY_INDEX = [{
    "name": "vector_index", "type": "vectorSearch", "status": "READY", "queryable": True,
    "latestDefinition": {"fields": [
        {"type": "vector", "path": "embedding", "numDimensions": 768,
         "similarity": "cosine"},
        {"type": "filter", "path": "metadata.tenant_id"},
        {"type": "filter", "path": "metadata.districts"},
        {"type": "filter", "path": "metadata.source_collection"},
    ]},
}]


def store_with(col, name="vector_embeddings_alerts"):
    s = VectorStore(uri=URI, db_name="police_tenant_alpha", collection_name=name)
    s._collection = col
    s._client = object()
    VectorStore._INDEXED.add((s.db_name, s.collection_name))
    return s


@pytest.fixture(autouse=True)
def clean_state():
    VectorStore.forget_index_probes()
    VectorStore._INDEXED.clear()
    VectorStore._FUNCTION_BLOCKED = False
    vs.reset_search_strategy_counts()
    yield
    VectorStore.forget_index_probes()
    VectorStore._INDEXED.clear()
    VectorStore._FUNCTION_BLOCKED = False
    vs.reset_search_strategy_counts()


# ================================================================ probing

def test_a_ready_index_is_used_and_probed_once():
    col = FakeCollection(search_indexes=READY_INDEX)
    s = store_with(col)
    assert s._vector_index_name == "vector_index"
    for _ in range(5):
        assert s._vector_index_name == "vector_index"
    assert col.probes == 1, "a positive answer is not re-probed on the hot path"


def test_an_index_still_building_is_not_used():
    building = [{"name": "vector_index", "type": "vectorSearch",
                 "status": "PENDING", "queryable": False, "latestDefinition": {}}]
    s = store_with(FakeCollection(search_indexes=building))
    assert s._vector_index_name is None, (
        "querying an index that is not queryable yet fails, so it must not be chosen")


def test_a_queryable_index_is_used_even_if_status_lags():
    lagging = [{"name": "vector_index", "type": "vectorSearch",
                "status": "BUILDING", "queryable": True, "latestDefinition": {}}]
    s = store_with(FakeCollection(search_indexes=lagging))
    assert s._vector_index_name == "vector_index"


def test_an_index_created_later_is_picked_up_without_a_restart(monkeypatch):
    # The defect this guards: "no index" was cached for the life of the process,
    # so building one took effect only after a restart while every query in
    # between degraded silently.
    col = FakeCollection(search_indexes=[])
    s = store_with(col)
    assert s._vector_index_name is None

    clock = {"t": 0.0}
    monkeypatch.setattr(vs.time, "monotonic", lambda: clock["t"])
    VectorStore.forget_index_probes()
    assert s._vector_index_name is None
    col._search_indexes = READY_INDEX

    clock["t"] = VectorStore.INDEX_PROBE_TTL_S / 2
    assert s._vector_index_name is None, "within the interval, the answer is kept"

    clock["t"] = VectorStore.INDEX_PROBE_TTL_S + 1
    assert s._vector_index_name == "vector_index", "after it, the index is found"


def test_a_probe_that_fails_does_not_raise_into_the_query():
    class Broken(FakeCollection):
        def list_search_indexes(self):
            raise RuntimeError("no permission to list indexes")

    s = store_with(Broken())
    assert s._vector_index_name is None


# ============================================================== the filters

def test_the_scope_is_pushed_into_the_index_query():
    col = FakeCollection(search_indexes=READY_INDEX, aggregate_result=[
        {"text": "a", "metadata": {"tenant_id": "t1"}, "score": 0.9}])
    s = store_with(col)
    s._atlas_vector_search(col, [0.1] * 768, 5, source_collection="alerts",
                           tenant_id="t1", districts=["Hyderabad"])
    stage = col.pipelines[-1][0]["$vectorSearch"]
    clauses = stage["filter"]["$and"]
    assert {"metadata.tenant_id": {"$eq": "t1"}} in clauses
    assert {"metadata.source_collection": {"$eq": "alerts"}} in clauses
    assert {"metadata.districts": {"$in": ["Hyderabad"]}} in clauses
    assert stage["index"] == "vector_index" and stage["path"] == "embedding"
    assert stage["numCandidates"] >= stage["limit"], "the filter needs candidates to survive on"


def test_an_officer_with_no_districts_matches_nothing_rather_than_everything():
    col = FakeCollection(search_indexes=READY_INDEX)
    s = store_with(col)
    s._atlas_vector_search(col, [0.1] * 768, 5, tenant_id="t1", districts=[])
    stage = col.pipelines[-1][0]["$vectorSearch"]
    flt = stage["filter"]
    clauses = flt.get("$and", [flt])
    assert {"metadata.districts": {"$in": []}} in clauses


def test_an_admin_without_district_restriction_is_not_filtered_by_district():
    col = FakeCollection(search_indexes=READY_INDEX)
    s = store_with(col)
    s._atlas_vector_search(col, [0.1] * 768, 5, tenant_id="t1", districts=None)
    stage = col.pipelines[-1][0]["$vectorSearch"]
    flt = stage["filter"]
    clauses = flt.get("$and", [flt])
    assert not any("metadata.districts" in c for c in clauses)


def test_the_tenant_filter_is_never_omitted_when_a_tenant_is_given():
    col = FakeCollection(search_indexes=READY_INDEX)
    s = store_with(col)
    s._atlas_vector_search(col, [0.1] * 768, 5, tenant_id="t1")
    stage = col.pipelines[-1][0]["$vectorSearch"]
    flt = stage["filter"]
    clauses = flt.get("$and", [flt])
    assert {"metadata.tenant_id": {"$eq": "t1"}} in clauses


# ============================================================== telemetry

def test_the_strategy_that_served_a_query_is_attributed_to_its_collection():
    col = FakeCollection(search_indexes=READY_INDEX, aggregate_result=[
        {"text": "a", "metadata": {}, "score": 0.9}])
    s = store_with(col)
    s.cosine_search([0.1] * 768, top_k=3, query_text="", tenant_id="t1")
    per = vs.search_strategy_by_collection()
    assert per["vector_embeddings_alerts"]["atlas_vector_search"] == 1
    assert vs.degraded_collections() == [], "the real path is not degradation"


def test_a_small_collection_with_no_index_is_not_degraded():
    """A local scan that read everything has the index's recall.

    Four of this deployment's seven vector collections hold 0-7 vectors and
    will never carry an index (the cluster tier allows three). Naming them
    degraded put permanent noise in the one field an operator checks to find
    the collection that IS losing results.
    """
    col = FakeCollection(search_indexes=[], docs=[
        {"text": "x", "embedding": [0.1] * 768, "metadata": {}}])
    s = store_with(col)
    s.cosine_search([0.1] * 768, top_k=3, query_text="", tenant_id="t1")
    assert vs.degraded_collections() == []
    counts = vs.search_strategy_by_collection()["vector_embeddings_alerts"]
    assert "brute_force_complete" in counts
    # Still off the index path, which is what the recall diagnostic reports.
    assert not any(name in vs.INDEX_STRATEGIES for name in counts)


def test_a_truncated_scan_is_named_as_degraded():
    """Hitting the fetch limit ranks the newest slice and drops the rest."""
    docs = [{"text": f"x{i}", "embedding": [0.1] * 768, "metadata": {}}
            for i in range(vs.VectorStore.BRUTE_FORCE_FETCH_LIMIT)]
    col = FakeCollection(search_indexes=[], docs=docs)
    s = store_with(col)
    s.cosine_search([0.1] * 768, top_k=3, query_text="", tenant_id="t1")
    assert "vector_embeddings_alerts" in vs.degraded_collections()
    counts = vs.search_strategy_by_collection()["vector_embeddings_alerts"]
    assert "brute_force_capped" in counts


def test_every_degraded_name_is_distinct_from_the_real_one():
    for name in ("atlas_unavailable", "atlas_error", "text_prefilter",
                 "sampled", "brute_force"):
        assert name not in vs.HEALTHY_STRATEGIES


def test_an_index_error_degrades_instead_of_failing_the_query():
    from pymongo.errors import OperationFailure
    col = FakeCollection(search_indexes=READY_INDEX,
                         aggregate_error=OperationFailure("index not found"),
                         docs=[{"text": "x", "embedding": [0.1] * 768, "metadata": {}}])
    s = store_with(col)
    out = s.cosine_search([0.1] * 768, top_k=3, query_text="", tenant_id="t1")
    assert isinstance(out, list)
    assert vs.search_strategy_report().get("atlas_unavailable") == 1


# ==================================================== capability probing

def test_a_tier_that_refuses_function_is_asked_once_not_per_query():
    from pymongo.errors import OperationFailure
    attempts = {"n": 0}

    class NoFunction(FakeCollection):
        def aggregate(self, pipeline, **kw):
            self.pipelines.append(pipeline)
            if any("$addFields" in stage for stage in pipeline):
                attempts["n"] += 1
                raise OperationFailure("$function not allowed in this atlas tier")
            return FakeCursor([])

    col = NoFunction(search_indexes=[], docs=[
        {"text": "x", "embedding": [0.1] * 768, "metadata": {}}])
    s = store_with(col)
    for _ in range(4):
        s.cosine_search([0.1] * 768, top_k=3, query_text="", tenant_id="t1")
    assert attempts["n"] == 1, (
        "36 refused round trips in one validation run, each logged as an error")
    assert VectorStore._FUNCTION_BLOCKED is True


# ============================================== index configuration check

def test_a_correctly_configured_index_verifies_clean():
    s = store_with(FakeCollection(search_indexes=READY_INDEX, docs=[{}] * 190))
    report = s.verify_index()
    assert report["ok"] is True and report["problems"] == []
    assert report["indexed"] is True and report["chunks"] == 190
    assert report["name"] == "vector_index"


def test_a_missing_index_is_reported_as_degraded_not_as_an_error():
    s = store_with(FakeCollection(search_indexes=[]))
    report = s.verify_index()
    assert report["indexed"] is False and report["ok"] is False
    assert any("no vectorSearch index" in p for p in report["problems"])


@pytest.mark.parametrize("break_it,expected", [
    ({"numDimensions": 1536}, "dimensions"),
    ({"similarity": "dotProduct"}, "similarity"),
    ({"path": "vector"}, "path"),
])
def test_a_vector_field_that_does_not_match_the_embedder_is_caught(break_it, expected):
    import copy
    idx = copy.deepcopy(READY_INDEX)
    idx[0]["latestDefinition"]["fields"][0].update(break_it)
    s = store_with(FakeCollection(search_indexes=idx))
    report = s.verify_index()
    assert report["ok"] is False
    assert any(expected in p for p in report["problems"]), report["problems"]


@pytest.mark.parametrize("missing", ["metadata.tenant_id", "metadata.districts",
                                     "metadata.source_collection"])
def test_a_filter_path_absent_from_the_index_is_caught(missing):
    import copy
    idx = copy.deepcopy(READY_INDEX)
    idx[0]["latestDefinition"]["fields"] = [
        f for f in idx[0]["latestDefinition"]["fields"] if f.get("path") != missing]
    s = store_with(FakeCollection(search_indexes=idx))
    report = s.verify_index()
    assert report["ok"] is False
    assert any(missing in p for p in report["problems"]), report["problems"]
    # This is the silent case: Atlas refuses the scoped query and the store
    # degrades, so nothing looks broken while recall quietly collapses.
    assert any("degrades" in p for p in report["problems"])


def test_an_index_that_is_not_queryable_yet_is_not_called_ok():
    import copy
    idx = copy.deepcopy(READY_INDEX)
    idx[0]["status"] = "PENDING"
    idx[0]["queryable"] = False
    s = store_with(FakeCollection(search_indexes=idx))
    report = s.verify_index()
    assert report["ok"] is False
    assert any("queryable" in p for p in report["problems"])


def test_verification_of_an_unreachable_collection_reports_rather_than_raises():
    class Dead(FakeCollection):
        def estimated_document_count(self):
            raise RuntimeError("connection refused")

    s = store_with(Dead())
    report = s.verify_index()
    assert report["ok"] is False
    assert any("could not read index configuration" in p for p in report["problems"])


# ====================================================== recall measurement

def test_recall_is_measured_against_exhaustive_cosine_not_asserted():
    # Ground truth is every chunk in scope, so a claim about retrieval quality
    # is a measurement. Identity is the chunk, never the score: Atlas normalises
    # cosine to (1 + cos) / 2 and the two scales are not comparable.
    docs = [{"text": f"doc{i}", "embedding": [0.0] * 767 + [1.0 - i * 0.1],
             "metadata": {"chunk_id": f"c{i}"}} for i in range(5)]
    col = FakeCollection(search_indexes=READY_INDEX, docs=docs, aggregate_result=[
        {"text": "doc0", "metadata": {"chunk_id": "c0"}, "score": 0.99},
        {"text": "doc1", "metadata": {"chunk_id": "c1"}, "score": 0.98},
    ])
    s = store_with(col)
    report = s.verify_recall([0.0] * 767 + [1.0], top_k=2, tenant_id="t1")
    assert report["of"] == 2 and report["found"] == 2
    assert report["recall"] == 1.0
    assert report["degraded"] is False
    assert "atlas_vector_search" in report["strategy"]


def test_recall_reports_the_degraded_path_as_degraded():
    docs = [{"text": f"doc{i}", "embedding": [0.0] * 767 + [1.0 - i * 0.1],
             "metadata": {"chunk_id": f"c{i}"}} for i in range(5)]
    col = FakeCollection(search_indexes=[], docs=docs)
    s = store_with(col)
    report = s.verify_recall([0.0] * 767 + [1.0], top_k=2, tenant_id="t1")
    assert report["degraded"] is True, "a fallback must never be reported as the real path"


def test_exhaustive_search_ranks_by_true_cosine():
    docs = [
        {"text": "far", "embedding": [1.0] + [0.0] * 767, "metadata": {"chunk_id": "far"}},
        {"text": "near", "embedding": [0.0] * 767 + [1.0], "metadata": {"chunk_id": "near"}},
    ]
    s = store_with(FakeCollection(docs=docs))
    out = s.exhaustive_search([0.0] * 767 + [1.0], top_k=2, tenant_id="t1")
    assert [r["metadata"]["chunk_id"] for r in out] == ["near", "far"]


def test_exhaustive_search_skips_chunks_with_no_usable_vector():
    docs = [
        {"text": "empty", "embedding": [], "metadata": {"chunk_id": "empty"}},
        {"text": "zero", "embedding": [0.0] * 768, "metadata": {"chunk_id": "zero"}},
        {"text": "real", "embedding": [0.0] * 767 + [1.0], "metadata": {"chunk_id": "real"}},
    ]
    s = store_with(FakeCollection(docs=docs))
    out = s.exhaustive_search([0.0] * 767 + [1.0], top_k=5, tenant_id="t1")
    assert [r["metadata"]["chunk_id"] for r in out] == ["real"]


def test_a_zero_query_vector_returns_nothing_rather_than_dividing_by_zero():
    s = store_with(FakeCollection(docs=[{"text": "x", "embedding": [1.0] * 768,
                                        "metadata": {}}]))
    assert s.exhaustive_search([0.0] * 768, top_k=3) == []


# ===================================================== embedder concurrency

@pytest.mark.reads_source
def test_the_embedder_serialises_inference():
    """The tokenizer is shared mutable state; the executor is multi-threaded.

    Observed live: four retrieval steps embedding in parallel produced
    "Already borrowed" from the Rust fast tokenizer. It did not crash — the
    embedding came back None, semantic search silently returned nothing,
    retrieval fell through to a brute-force scan, and the step hit its 90 s
    budget. The symptom was "the assistant is slow and finds nothing".
    """
    import threading
    from embedder import NomicLocalEmbedder

    # The lock must exist, be distinct from the load lock, and be held while
    # the model runs. A plain Lock is not reentrant, so sharing one would
    # deadlock the first call.
    assert hasattr(NomicLocalEmbedder, "_infer_lock")
    assert NomicLocalEmbedder._infer_lock is not NomicLocalEmbedder._lock

    import inspect
    body = inspect.getsource(NomicLocalEmbedder._encode)
    assert "with self._infer_lock:" in body, "inference is not serialised"
    tok = body.index("self._tokenizer(")
    lock = body.index("with self._infer_lock:")
    assert lock < tok, "the tokenizer is called outside the lock"


@pytest.mark.reads_source
def test_the_load_lock_is_not_held_during_inference():
    # Holding the load lock across encode would serialise every request behind
    # a model load for no reason.
    import inspect
    from embedder import NomicLocalEmbedder
    body = inspect.getsource(NomicLocalEmbedder._encode)
    assert "with self._lock:" not in body


def test_an_empty_index_result_is_an_answer_not_a_fallback_trigger():
    """Nothing matched the scope. That is the answer; do not re-ask slowly.

    A district the tenant has no content for returned 0 from the index in
    0.03s, which was read as "the index may be broken" and sent the same
    scoped query down the local-cosine path — 11 seconds to arrive at the
    same empty set, after which the collection was reported degraded.
    """
    col = FakeCollection(search_indexes=READY_INDEX, aggregate_result=[],
                         docs=[{"text": "x", "embedding": [0.1] * 768, "metadata": {}}])
    s = store_with(col)
    assert s.cosine_search([0.1] * 768, top_k=3, query_text="traffic",
                           tenant_id="t1", districts=["Warangal"]) == []
    counts = vs.search_strategy_by_collection()["vector_embeddings_alerts"]
    assert counts == {"atlas_vector_search_empty": 1}, \
        "an empty index result must not fall through to a slower path"
    assert vs.degraded_collections() == []


def test_the_scope_filter_reaches_the_index_rather_than_the_results():
    """The district clause must ride inside $vectorSearch, not filter after it."""
    col = FakeCollection(search_indexes=READY_INDEX, aggregate_result=[])
    s = store_with(col)
    s.cosine_search([0.1] * 768, top_k=3, query_text="x",
                    tenant_id="t1", districts=["Mulugu"])
    stage = col.pipelines[-1][0]["$vectorSearch"]
    clauses = stage["filter"]["$and"]
    assert {"metadata.tenant_id": {"$eq": "t1"}} in clauses
    assert {"metadata.districts": {"$in": ["Mulugu"]}} in clauses
