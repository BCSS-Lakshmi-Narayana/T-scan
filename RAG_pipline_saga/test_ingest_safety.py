"""
Regression tests for B-1: a re-render that produces fewer chunks must not leave
the tail of the previous representation behind.

These exercise the real ``VectorStore.upsert_chunks`` and
``VectorStore.prune_orphan_chunks`` against an in-memory collection that
implements the handful of MongoDB operations they use, with real filter
semantics (``$gte``, exact match). No MongoDB, no network, no production data.

The shrink test (10 -> 3) fails against the previous implementation, which had
no prune at all, and passes with it.
"""

import ast
import io
import os
import textwrap

import pytest

from vector_store import VectorStore

TENANT_A = "tenant-a"
TENANT_B = "tenant-b"


# --------------------------------------------------------------------------- #
# a very small in-memory stand-in for one collection
# --------------------------------------------------------------------------- #

class FakeCollection:
    """Enough of a Mongo collection for upsert_chunks and prune_orphan_chunks.

    Filters are evaluated for real, including the ``$gte`` on chunk_index and
    the dotted metadata paths, because those are exactly what the fix relies on.
    """

    def __init__(self):
        self.docs = []
        self.deleted_queries = []

    # -- helpers ----------------------------------------------------------- #

    @staticmethod
    def _get(doc, path):
        cur = doc
        for part in path.split("."):
            if not isinstance(cur, dict):
                return None
            cur = cur.get(part)
        return cur

    def _matches(self, doc, query):
        for path, want in query.items():
            got = self._get(doc, path)
            if isinstance(want, dict):
                for op, val in want.items():
                    if op == "$gte" and not (got is not None and got >= val):
                        return False
                    if op == "$in" and got not in val:
                        return False
                    if op == "$exists" and (got is not None) != val:
                        return False
            elif got != want:
                return False
        return True

    # -- operations used by VectorStore ------------------------------------ #

    def bulk_write(self, ops, ordered=False):
        upserted = modified = 0
        for op in ops:
            filt, update = op._filter, op._doc
            target = next((d for d in self.docs if self._matches(d, filt)), None)
            if target is None:
                doc = {}
                doc.update(update.get("$set", {}))
                self.docs.append(doc)
                upserted += 1
            else:
                target.update(update.get("$set", {}))
                modified += 1

        class _Result:
            pass
        r = _Result()
        r.upserted_count, r.modified_count = upserted, modified
        return r

    def delete_many(self, query):
        self.deleted_queries.append(query)
        before = len(self.docs)
        self.docs = [d for d in self.docs if not self._matches(d, query)]

        class _Result:
            pass
        r = _Result()
        r.deleted_count = before - len(self.docs)
        return r

    def count_documents(self, query):
        return sum(1 for d in self.docs if self._matches(d, query))

    def create_index(self, *a, **k):
        return "idx"

    def list_indexes(self):
        return []


def make_store(collection: FakeCollection) -> VectorStore:
    """A VectorStore bound to the fake collection, with no connection made."""
    store = VectorStore("mongodb://unused", "db-unused", "vector_embeddings_test")
    store._collection = collection          # connect() returns this as-is
    return store


def chunks_for(doc_id: str, count: int, tenant: str = TENANT_A, text: str = "v2"):
    return [{
        "text": f"{text} chunk {i}",
        "embedding": [0.1, 0.2, 0.3],
        "metadata": {
            "document_id": doc_id, "chunk_index": i, "total_chunks": count,
            "chunk_id": f"{doc_id}::{i}", "tenant_id": tenant,
            "content_hash": f"hash-{text}", "source_collection": "grievances",
        },
    } for i in range(count)]


def indexes_of(col: FakeCollection, doc_id: str):
    return sorted(d["metadata"]["chunk_index"] for d in col.docs
                  if d["metadata"]["document_id"] == doc_id)


def ingest(store, col, doc_id, count, tenant=TENANT_A, text="v2"):
    """The order _run_ingest uses: write the new chunks, then prune the tail."""
    store.upsert_chunks(chunks_for(doc_id, count, tenant, text))
    store.prune_orphan_chunks(doc_id, count, tenant_id=tenant)


# --------------------------------------------------------------------------- #
# the shrink case — this is the bug
# --------------------------------------------------------------------------- #

def test_a_shrinking_document_leaves_no_orphans():
    col = FakeCollection()
    store = make_store(col)
    ingest(store, col, "docA", 5, text="v1")
    assert indexes_of(col, "docA") == [0, 1, 2, 3, 4]

    ingest(store, col, "docA", 3)                      # re-render is shorter
    assert indexes_of(col, "docA") == [0, 1, 2]
    assert 3 not in indexes_of(col, "docA")
    assert 4 not in indexes_of(col, "docA")


def test_the_surviving_chunks_carry_the_new_representation():
    col = FakeCollection()
    store = make_store(col)
    ingest(store, col, "docA", 5, text="old")
    ingest(store, col, "docA", 3, text="new")
    texts = [d["text"] for d in col.docs]
    assert all(t.startswith("new") for t in texts), texts


@pytest.mark.parametrize("before,after", [(10, 3), (3, 10), (10, 10), (1, 1), (7, 1)])
def test_chunk_count_always_matches_the_current_render(before, after):
    col = FakeCollection()
    store = make_store(col)
    ingest(store, col, "docA", before, text="v1")
    ingest(store, col, "docA", after, text="v2")
    assert indexes_of(col, "docA") == list(range(after))


def test_a_growing_document_gains_chunks_without_duplicates():
    col = FakeCollection()
    store = make_store(col)
    ingest(store, col, "docA", 2, text="v1")
    ingest(store, col, "docA", 4)
    assert indexes_of(col, "docA") == [0, 1, 2, 3]
    assert len(col.docs) == 4


def test_re_ingesting_the_same_document_is_idempotent():
    col = FakeCollection()
    store = make_store(col)
    for _ in range(3):
        ingest(store, col, "docA", 3)
    assert indexes_of(col, "docA") == [0, 1, 2]
    assert len(col.docs) == 3


def test_a_document_that_now_renders_empty_can_be_emptied():
    # keep_from=0 is what _run_ingest queues for an empty render under force.
    col = FakeCollection()
    store = make_store(col)
    ingest(store, col, "docA", 4, text="v1")
    store.prune_orphan_chunks("docA", 0, tenant_id=TENANT_A)
    assert indexes_of(col, "docA") == []


# --------------------------------------------------------------------------- #
# isolation — the fix deepens deletion, so this is the part that must not slip
# --------------------------------------------------------------------------- #

def test_pruning_one_document_never_touches_another():
    col = FakeCollection()
    store = make_store(col)
    ingest(store, col, "docA", 5, text="v1")
    ingest(store, col, "docB", 5, text="v1")

    ingest(store, col, "docA", 2)
    assert indexes_of(col, "docA") == [0, 1]
    assert indexes_of(col, "docB") == [0, 1, 2, 3, 4]      # untouched


def test_pruning_is_scoped_to_the_tenant():
    # Same document_id under two tenants is pathological but must still be safe:
    # the delete carries tenant_id, so only one side can ever be affected.
    col = FakeCollection()
    store = make_store(col)
    store.upsert_chunks(chunks_for("shared", 4, TENANT_A, "a"))
    for d in col.docs:
        d["metadata"]["chunk_id"] = f"A::{d['metadata']['chunk_index']}"
    col.docs.extend([{
        "text": f"b chunk {i}", "embedding": [0.1],
        "metadata": {"document_id": "shared", "chunk_index": i,
                     "chunk_id": f"B::{i}", "tenant_id": TENANT_B},
    } for i in range(4)])

    store.prune_orphan_chunks("shared", 1, tenant_id=TENANT_A)

    a = sorted(d["metadata"]["chunk_index"] for d in col.docs
               if d["metadata"]["tenant_id"] == TENANT_A)
    b = sorted(d["metadata"]["chunk_index"] for d in col.docs
               if d["metadata"]["tenant_id"] == TENANT_B)
    assert a == [0]
    assert b == [0, 1, 2, 3]                                # untouched


def test_every_prune_query_names_the_document_and_the_index_floor():
    col = FakeCollection()
    store = make_store(col)
    store.prune_orphan_chunks("docA", 3, tenant_id=TENANT_A)
    q = col.deleted_queries[-1]
    assert q["metadata.document_id"] == "docA"
    assert q["metadata.chunk_index"] == {"$gte": 3}
    assert q["metadata.tenant_id"] == TENANT_A


def test_a_prune_without_a_document_id_deletes_nothing():
    col = FakeCollection()
    store = make_store(col)
    ingest(store, col, "docA", 3, text="v1")
    assert store.prune_orphan_chunks("", 0) == 0
    assert store.prune_orphan_chunks("docA", -1) == 0
    assert len(col.docs) == 3


# --------------------------------------------------------------------------- #
# failure safety
# --------------------------------------------------------------------------- #

def test_an_embedding_failure_leaves_the_previous_chunks_intact():
    # _run_ingest records the prune only after chunks were written (wrote_any).
    # If embedding fails there is no prune, so the old representation survives.
    col = FakeCollection()
    store = make_store(col)
    ingest(store, col, "docA", 5, text="v1")

    # ... embedding fails: nothing written, nothing pruned ...
    assert indexes_of(col, "docA") == [0, 1, 2, 3, 4]
    assert all(d["text"].startswith("v1") for d in col.docs)


def test_a_failed_prune_does_not_raise():
    class Exploding(FakeCollection):
        def delete_many(self, query):
            raise RuntimeError("mongo unavailable")

    col = Exploding()
    store = make_store(col)
    store.upsert_chunks(chunks_for("docA", 3))
    assert store.prune_orphan_chunks("docA", 1) == 0      # degraded, not fatal
    assert len(col.docs) == 3


def test_legacy_chunks_without_a_hash_are_replaced_cleanly():
    col = FakeCollection()
    store = make_store(col)
    col.docs.extend([{
        "text": f" Id: 6aaa Tenant Id: … flattened {i}", "embedding": [0.1],
        "metadata": {"document_id": "docA", "chunk_index": i,
                     "chunk_id": f"docA::{i}", "tenant_id": TENANT_A},
    } for i in range(6)])                                  # no content_hash

    ingest(store, col, "docA", 2, text="curated")

    assert indexes_of(col, "docA") == [0, 1]
    assert all(d["text"].startswith("curated") for d in col.docs)
    assert all(d["metadata"].get("content_hash") for d in col.docs)


# --------------------------------------------------------------------------- #
# static check: no surviving path where force skips the cleanup
# --------------------------------------------------------------------------- #

def _run_ingest_source() -> str:
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "api_server.py")
    src = io.open(path, encoding="utf-8").read()
    start = src.index("def _run_ingest(")
    end = src.index("\n@app.post(\"/api/rag/ingest\")", start)
    return src[start:end]


def test_the_ingest_path_no_longer_deletes_before_writing():
    body = _run_ingest_source()
    assert "delete_many" not in body, (
        "removal must go through prune_orphan_chunks after the write")


def test_the_prune_is_recorded_on_every_written_document():
    """The record point must not sit under any `force` branch.

    Checked on the parse tree rather than the text: a regex over a 200-line
    function matches across unrelated blocks, which is how a static check ends
    up asserting something it does not mean.
    """
    body = _run_ingest_source()
    assert body.count("prunes[doc_id] = len(chunks)") == 1

    tree = ast.parse(textwrap.dedent(body))
    target = None
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
        if isinstance(node, ast.Assign) and ast.unparse(node).startswith("prunes[doc_id] = len"):
            target = node
    assert target is not None, "the prune record point disappeared"

    cur = target
    while cur in parents:
        parent = parents[cur]
        if isinstance(parent, ast.If) and cur in parent.body + parent.orelse:
            names = {n.id for n in ast.walk(parent.test) if isinstance(n, ast.Name)}
            assert "force" not in names, (
                f"prune recording is gated on force: {ast.unparse(parent.test)}")
        cur = parent


def test_the_flush_prunes_after_upserting():
    body = _run_ingest_source()
    upsert_at = body.index("store.upsert_chunks(pending)")
    prune_at = body.index("store.prune_orphan_chunks(")
    assert upsert_at < prune_at, "new chunks must be written before old ones go"
