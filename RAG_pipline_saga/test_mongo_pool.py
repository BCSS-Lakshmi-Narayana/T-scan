"""Connection lifecycle: one client per configuration, and isolation intact.

A MongoClient is a connection pool with its own monitoring threads and TLS
handshakes, not a connection. Building one per store cost 829 ms before the
first 27 ms query, and the seven stores one scope needs cost 3.7 s between them.

These tests cover the two things that make sharing safe: a caller can never be
handed a client configured for someone else, and a caller closing its own handle
can never close the client another caller is using mid-request.

MongoClient does not dial on construction, so none of this needs a server.
"""

import threading

import pytest

import mongo_pool

URI_A = "mongodb://localhost:27017"
URI_B = "mongodb://localhost:27018"


@pytest.fixture(autouse=True)
def clean_pool():
    mongo_pool.reset()
    yield
    mongo_pool.close_all()


# ------------------------------------------------------------------ reuse

def test_the_same_configuration_is_the_same_client():
    assert mongo_pool.client(URI_A) is mongo_pool.client(URI_A)


def test_a_different_uri_is_a_different_client():
    assert mongo_pool.client(URI_A) is not mongo_pool.client(URI_B)


def test_different_options_are_different_clients():
    # A caller that asked for a 30 s selection timeout must not be handed the
    # 5 s client: it would time out three times faster than it asked to.
    fast = mongo_pool.client(URI_A, serverSelectionTimeoutMS=5000)
    slow = mongo_pool.client(URI_A, serverSelectionTimeoutMS=30000)
    assert fast is not slow


def test_the_default_options_are_applied_and_still_shared():
    explicit = mongo_pool.client(URI_A, **mongo_pool.DEFAULT_OPTIONS)
    implicit = mongo_pool.client(URI_A)
    assert explicit is implicit, "the defaults must not create a second client"


def test_reuse_is_counted_so_a_leak_is_visible():
    before = mongo_pool.stats()
    mongo_pool.client(URI_A)
    mongo_pool.client(URI_A)
    mongo_pool.client(URI_A)
    after = mongo_pool.stats()
    assert after["created"] == before["created"] + 1
    assert after["reused"] >= before["reused"] + 2
    assert after["live"] == 1


def test_concurrent_callers_get_one_client_not_one_each():
    got = []
    barrier = threading.Barrier(8)

    def ask():
        barrier.wait()
        got.append(mongo_pool.client(URI_A))

    threads = [threading.Thread(target=ask) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(got) == 8
    assert len({id(c) for c in got}) == 1, "the pool raced and built several clients"


# --------------------------------------------------------------- isolation

def test_one_client_still_means_separate_databases():
    a = mongo_pool.database(URI_A, "police_tenant_alpha")
    b = mongo_pool.database(URI_A, "police_tenant_beta")
    assert a.client is b.client, "same cluster, one pool"
    assert a.name != b.name, "a shared client must not blur the database"
    assert a.name == "police_tenant_alpha" and b.name == "police_tenant_beta"


def test_the_pool_never_picks_a_database():
    # Tenant isolation is a database-name decision made upstream. A pool that
    # defaulted a name could quietly answer from the wrong tenant.
    with pytest.raises(ValueError):
        mongo_pool.database(URI_A, "")


def test_a_missing_uri_is_refused_rather_than_defaulted():
    with pytest.raises(ValueError):
        mongo_pool.client("")


@pytest.mark.parametrize("uri", ["mongodb://", "mongodb+srv://", "mongodb://,"])
def test_a_malformed_uri_still_fails_loudly(uri):
    # The pool must not swallow a misconfiguration: a cached broken client
    # would turn one bad environment variable into a mystery at every call site.
    with pytest.raises(Exception):
        mongo_pool.client(uri)
    assert mongo_pool.stats()["live"] == 0, "a client that could not be built is not pooled"


# ---------------------------------------------------------------- shutdown

def test_close_all_empties_the_pool_and_the_next_ask_rebuilds():
    first = mongo_pool.client(URI_A)
    mongo_pool.close_all()
    assert mongo_pool.stats()["live"] == 0
    second = mongo_pool.client(URI_A)
    assert second is not first


def test_reset_forgets_without_closing():
    first = mongo_pool.client(URI_A)
    mongo_pool.reset()
    # Not closed: still usable by whoever holds it. This is what makes a
    # caller's own close() safe.
    #
    # Read a property that needs NO server. `.address` looked like the obvious
    # check and is not: it performs server selection, so the test passed only
    # on a machine with a mongod on localhost and failed on the deployment
    # server with a connection refused -- reporting the pool as broken when
    # what was wrong was the test reaching for the network to answer a
    # question about an object's lifetime.
    assert first.options is not None
    assert first.topology_description is not None
    assert mongo_pool.stats()["live"] == 0


# ------------------------------------------------- the store's own lifecycle

def test_a_store_close_releases_its_handles_but_not_the_shared_client():
    from vector_store import VectorStore
    store = VectorStore(uri=URI_A, db_name="police_tenant_alpha",
                        collection_name="vector_embeddings_alerts")
    shared = mongo_pool.client(URI_A)
    store._client = shared
    store._collection = object()
    store._cache_loaded = True
    store._embeddings = "pretend vectors"

    store.close()
    assert store._collection is None and store._client is None
    assert store._embeddings is None and store._cache_loaded is False
    # The client the rest of the process is using is untouched.
    assert mongo_pool.client(URI_A) is shared


def test_index_initialisation_happens_once_per_collection():
    from vector_store import VectorStore
    calls = []

    class Counting(VectorStore):
        def _create_indexes(self):
            calls.append((self.db_name, self.collection_name))

    VectorStore._INDEXED.clear()
    try:
        for _ in range(4):
            s = Counting(uri=URI_A, db_name="db1", collection_name="c1")
            s._collection = object()
            s._ensure_indexes()
        other = Counting(uri=URI_A, db_name="db1", collection_name="c2")
        other._collection = object()
        other._ensure_indexes()
        # Same tenant database, second collection: its own indexes.
        per_tenant = Counting(uri=URI_A, db_name="db2", collection_name="c1")
        per_tenant._collection = object()
        per_tenant._ensure_indexes()
        assert calls == [("db1", "c1"), ("db1", "c2"), ("db2", "c1")]
    finally:
        VectorStore._INDEXED.clear()


def test_a_failed_index_creation_is_retried_not_remembered_as_done():
    from vector_store import VectorStore
    attempts = {"n": 0}

    class Flaky(VectorStore):
        def _create_indexes(self):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise RuntimeError("transient")

    VectorStore._INDEXED.clear()
    try:
        s = Flaky(uri=URI_A, db_name="db3", collection_name="c1")
        s._collection = object()
        with pytest.raises(RuntimeError):
            s._ensure_indexes()
        # A transient failure must not leave the collection permanently
        # unindexed, so the next connect tries again.
        s._ensure_indexes()
        assert attempts["n"] == 2
        s._ensure_indexes()
        assert attempts["n"] == 2, "and once it succeeded, it is not repeated"
    finally:
        VectorStore._INDEXED.clear()
