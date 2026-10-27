"""
test_tenant_db.py — per-tenant database routing.

Vectors live inside each tenant's own database. Two things must hold, and both
fail silently rather than loudly if they break:

  1. the database name this service resolves matches the one the Node backend
     writes to (config/tenantConnections.dbNameFor) -- if they drift, this
     service indexes a database nothing reads and every answer is empty;
  2. nothing keyed only by collection name is shared between tenants, or one
     tenant is served another's warm cache.

    python -m pytest test_tenant_db.py -q
"""

from __future__ import annotations

import os

import pytest

import tenants
from vector_store import VectorStore, CACHE_ROOT


# --------------------------------------------------------------------------- #
# database naming, mirroring the Node backend
# --------------------------------------------------------------------------- #

def test_slug_is_prefixed_like_the_backend(monkeypatch):
    monkeypatch.setattr(tenants, "TENANT_DB_PREFIX", "police_tenant_")
    assert tenants.db_name_for(slug="t-scan") == "police_tenant_t-scan"


def test_explicit_db_name_wins_so_a_tenant_can_be_moved():
    # The backend honours tenant.db_name over the derived name; a tenant that
    # has been moved must not be re-derived back to its old database.
    assert tenants.db_name_for(slug="t-scan", db_name="police_archive_2024") == "police_archive_2024"


def test_unsafe_characters_are_replaced_not_dropped():
    # Mongo rejects / \ . " $ * < > : | ? in a database name. Dropping them
    # instead of replacing could collapse two tenants onto one database.
    assert tenants.db_name_for(slug='a/b.c$d') == tenants.TENANT_DB_PREFIX + "a_b_c_d"
    assert tenants.db_name_for(slug="a.b") != tenants.db_name_for(slug="ab")


def test_database_names_are_capped_at_mongos_limit():
    assert len(tenants.db_name_for(slug="x" * 200)) <= 63


def test_a_tenant_without_a_slug_resolves_to_nothing():
    # Better to fail than to fall back to a shared default database.
    assert tenants.db_name_for(slug="") == ""


def test_two_tenants_never_share_a_database():
    a = tenants.db_name_for(slug="t-scan")
    b = tenants.db_name_for(slug="t-scan-2")
    assert a and b and a != b


# --------------------------------------------------------------------------- #
# registry resolution
# --------------------------------------------------------------------------- #

def test_resolve_rejects_an_empty_tenant_id():
    with pytest.raises(tenants.TenantNotFound):
        tenants.resolve("   ")


def test_a_suspended_tenant_is_not_resolvable(monkeypatch):
    monkeypatch.setattr(tenants, "_control_db", lambda: {
        "tenants": type("C", (), {
            "find_one": staticmethod(lambda *a, **k: {
                "id": "t1", "slug": "t-scan", "db_name": "", "status": "suspended",
            })
        })()
    })
    tenants.invalidate()
    with pytest.raises(tenants.TenantNotFound):
        tenants.resolve("t1")


def test_an_unknown_tenant_raises_rather_than_defaulting(monkeypatch):
    monkeypatch.setattr(tenants, "_control_db", lambda: {
        "tenants": type("C", (), {"find_one": staticmethod(lambda *a, **k: None)})()
    })
    tenants.invalidate()
    with pytest.raises(tenants.TenantNotFound):
        tenants.resolve("nope")


def test_resolution_is_cached_then_released_by_invalidate(monkeypatch):
    calls = {"n": 0}

    def _db():
        calls["n"] += 1
        return {"tenants": type("C", (), {
            "find_one": staticmethod(lambda *a, **k: {
                "id": "t1", "slug": "t-scan", "db_name": "", "status": "active",
            })
        })()}

    monkeypatch.setattr(tenants, "_control_db", _db)
    tenants.invalidate()

    assert tenants.resolve("t1").db_name == tenants.db_name_for(slug="t-scan")
    tenants.resolve("t1")
    assert calls["n"] == 1, "a cached tenant must not re-read the registry"

    tenants.invalidate("t1")
    tenants.resolve("t1")
    assert calls["n"] == 2, "invalidate must force a fresh read"


# --------------------------------------------------------------------------- #
# on-disk cache separation
# --------------------------------------------------------------------------- #

def _store(db_name):
    return VectorStore(uri="mongodb://unused", db_name=db_name, collection_name="vector_embeddings_alerts")


def test_each_database_gets_its_own_cache_directory():
    a = _store("police_tenant_a").cache_dir
    b = _store("police_tenant_b").cache_dir
    assert a != b, "two tenants would share one numpy cache file"
    assert os.path.basename(a) == "police_tenant_a"


def test_cache_directories_stay_under_the_cache_root():
    d = _store("police_tenant_a").cache_dir
    assert os.path.commonpath([os.path.abspath(CACHE_ROOT), os.path.abspath(d)]) == os.path.abspath(CACHE_ROOT)


def test_a_database_name_cannot_escape_the_cache_root():
    # Defence in depth: the name comes from the registry, but it becomes a
    # path here, so traversal must not be possible.
    d = _store("../../etc").cache_dir
    assert os.path.commonpath([os.path.abspath(CACHE_ROOT), os.path.abspath(d)]) == os.path.abspath(CACHE_ROOT)


def test_the_same_collection_in_two_tenants_resolves_to_different_files():
    a, b = _store("police_tenant_a"), _store("police_tenant_b")
    assert a._cache_exists_on_disk.__self__ is a  # sanity: bound per instance
    assert a.cache_dir != b.cache_dir


# --------------------------------------------------------------------------- #
# the control plane is shared between sagas
# --------------------------------------------------------------------------- #

def _registry(docs):
    """A stand-in control DB that honours the filter it is given."""
    class _Col:
        @staticmethod
        def find_one(q, *a, **k):
            return next((d for d in docs if all(d.get(kk) == vv for kk, vv in q.items()
                                                if not isinstance(vv, dict))), None)

        @staticmethod
        def find(q, *a, **k):
            want = q.get("type")
            return [d for d in docs if want is None or d.get("type") == want]
    return {"tenants": _Col()}


REGISTRY = [
    {"id": "p1", "slug": "t-scan", "db_name": "police_tenant_t-scan", "status": "active", "type": "police"},
    {"id": "s1", "slug": "bjp", "db_name": "state_tenant_bjp", "status": "active", "type": "state"},
    {"id": "s2", "slug": "ysrcp", "db_name": "state_tenant_ysrcp", "status": "active", "type": "state"},
]


def test_another_sagas_tenant_is_not_resolvable(monkeypatch):
    # The registry is shared with the political-state saga. Resolving one of
    # its tenants here would point this service at another product's database.
    monkeypatch.setattr(tenants, "_control_db", lambda: _registry(REGISTRY))
    monkeypatch.setattr(tenants, "TENANT_TYPE", "police")
    tenants.invalidate()

    assert tenants.resolve("p1").db_name == "police_tenant_t-scan"
    for foreign in ("s1", "s2"):
        with pytest.raises(tenants.TenantNotFound):
            tenants.resolve(foreign)


def test_the_scheduler_only_ingests_its_own_saga(monkeypatch):
    monkeypatch.setattr(tenants, "_control_db", lambda: _registry(REGISTRY))
    monkeypatch.setattr(tenants, "TENANT_TYPE", "police")
    tenants.invalidate()

    got = tenants.active_tenants()
    assert [t.slug for t in got] == ["t-scan"]
    assert all(not t.db_name.startswith("state_tenant_") for t in got)
