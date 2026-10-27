"""
Tests for the data-quality audit. No MongoDB: collections are faked.

The audit is the thing that decides whether the corpus is trustworthy, so its
own arithmetic has to be. In particular a field that EXISTS but is null or an
empty list must not count as coverage -- that is precisely the state the live
tenant is in (districts: [] on 1,184 documents), and counting it as present
would report the problem as solved.
"""

import data_quality as dq


class FakeCollection:
    """Answers count_documents by looking up which path the query asks about."""

    def __init__(self, total: int, present: dict, docs=None):
        self.total = total
        self.present = present          # logical path -> how many docs have it
        self.docs = docs or []
        self.queries = []

    def count_documents(self, q):
        self.queries.append(q)
        if "$or" in q:
            paths = [list(c.keys())[0] for c in q["$or"]]
            return max(self.present.get(p, 0) for p in paths)
        extra = {k: v for k, v in q.items() if k != "tenant_id"}
        if not extra:
            return self.total
        key = next(iter(extra))
        return self.present.get(key, 0)

    def aggregate(self, pipeline):
        return iter(self.docs)

    def find(self, *a, **k):
        return iter([])

    def find_one(self, *a, **k):
        return None

    def distinct(self, *a, **k):
        return []


class FakeDB(dict):
    def list_collection_names(self):
        return list(self.keys())


SPEC = dq.CollectionSpec("contents", "content_id", {
    "tenant_id": ["tenant_id"],
    "text": ["text", "scraped_content"],
    "districts": ["districts"],
})


# --------------------------------------------------------------------------- #
# arithmetic
# --------------------------------------------------------------------------- #

def test_an_empty_list_is_not_coverage():
    # The generated filter must exclude null, "" and [] as well as absent.
    clause = dq._present(["districts"])["$or"][0]["districts"]
    assert clause["$exists"] is True
    assert None in clause["$nin"] and [] in clause["$nin"] and "" in clause["$nin"]


def test_status_uses_the_documented_thresholds():
    assert dq._status(1.0, "published_at") == "ok"
    assert dq._status(0.95, "published_at") == "warning"     # below 0.98
    assert dq._status(0.80, "published_at") == "critical"    # below 0.90
    assert dq._status(0.0, "districts") == "critical"


def test_any_missing_tenant_id_is_critical():
    # tenant_id is the boundary; 99.9% coverage still means chunks nobody owns.
    assert dq._status(0.999, "tenant_id") == "critical"


def test_worst_status_wins():
    assert dq._worst(["ok", "warning", "ok"]) == "warning"
    assert dq._worst(["warning", "critical"]) == "critical"
    assert dq._worst(["ok", "ok"]) == "ok"


def test_ratio_of_nothing_is_zero_not_an_error():
    assert dq._ratio(0, 0) == 0.0


# --------------------------------------------------------------------------- #
# source audit
# --------------------------------------------------------------------------- #

def test_coverage_is_reported_per_field_with_counts():
    col = FakeCollection(100, {"tenant_id": 100, "text": 100, "districts": 24})
    db = FakeDB(contents=col)
    got = dq.audit_source(db, SPEC, "t1")

    assert got["total"] == 100
    assert got["coverage"]["districts"] == {
        "present": 24, "missing": 76, "ratio": 0.24, "status": "critical"}
    assert got["status"] == "critical"
    assert any("districts" in i for i in got["issues"])


def test_every_source_query_is_tenant_scoped():
    col = FakeCollection(10, {"tenant_id": 10, "text": 10, "districts": 10})
    dq.audit_source(FakeDB(contents=col), SPEC, "t1")
    assert col.queries
    for q in col.queries:
        assert q.get("tenant_id") == "t1"


def test_an_empty_collection_is_reported_not_divided_by_zero():
    got = dq.audit_source(FakeDB(contents=FakeCollection(0, {})), SPEC, "t1")
    assert got["status"] == "empty" and got["total"] == 0


def test_stranded_documents_are_counted_separately_from_failures():
    # analysis_status null is unclaimable: it never retries, so it needs its
    # own number rather than being folded into "not done".
    col = FakeCollection(100, {"tenant_id": 100, "text": 100, "districts": 100,
                               "$or": 0, "analysis_status": 40})
    got = dq.audit_source(FakeDB(contents=col), SPEC, "t1")
    assert "analysis_stranded" in got["counts"]


# --------------------------------------------------------------------------- #
# vector audit
# --------------------------------------------------------------------------- #

def test_a_missing_vector_collection_is_critical_and_explained():
    got = dq.audit_vectors(FakeDB(), SPEC, "t1", {"total": 1558})
    assert got["exists"] is False
    assert got["status"] == "critical"
    assert "invisible to semantic retrieval" in got["issues"][0]


def test_untagged_chunks_are_surfaced():
    col = FakeCollection(50, {"metadata.tenant_id": 50})
    # count_documents({"metadata.tenant_id": {"$exists": False}}) -> present key
    col.present["metadata.tenant_id"] = 50
    db = FakeDB(**{"vector_embeddings_contents": col})
    got = dq.audit_vectors(db, SPEC, "t1", {"total": 50})
    assert got["exists"] is True
    assert "untagged_chunks" in got


def test_render_does_not_crash_on_a_missing_collection():
    report = {
        "tenant_id": "t1", "database": "db", "generated_at": "now", "status": "critical",
        "sources": {"contents": {"total": 0, "coverage": {}, "status": "empty"}},
        "vectors": {"contents": {"exists": False, "total": 0, "facets": {}}},
        "issues": ["x"],
    }
    text = dq.render(report)
    assert "MISSING COLLECTION" in text and "ISSUES (1)" in text
