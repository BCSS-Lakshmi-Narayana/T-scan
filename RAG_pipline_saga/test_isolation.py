"""
test_isolation.py — the multi-tenant and district boundary.

These are the tests that must never go red. A regression here does not degrade
an answer, it hands one tenant's data to another, or one district's alerts to
an officer who has no jurisdiction over them.

The cache path is exercised directly: it is the path every live query takes
once ``.vector_cache`` is warm, and it needs no MongoDB.

    python -m pytest test_isolation.py -q
"""

from __future__ import annotations

import numpy as np
import pytest

from vector_store import VectorStore


# --------------------------------------------------------------------------- #
# a hand-built cache: 1 chunk per (tenant, district) combination we care about
# --------------------------------------------------------------------------- #

CHUNKS = [
    # text,            tenant,  districts
    ("t1 hyderabad",   "t1",    ["Hyderabad"]),
    ("t1 mulugu",      "t1",    ["Mulugu"]),
    ("t1 tenant wide", "t1",    []),            # no districts -> tenant-wide
    ("t1 no district", "t1",    None),          # field absent  -> tenant-wide
    ("t2 hyderabad",   "t2",    ["Hyderabad"]),
    ("t2 tenant wide", "t2",    []),
    ("untagged",       None,    None),          # ingested before tenant-tagging
]


def _store() -> VectorStore:
    """A VectorStore with its numpy cache populated in memory (no Mongo, no disk)."""
    vs = VectorStore(uri="mongodb://unused", db_name="unused", collection_name="test")
    # Every vector identical, so ranking cannot mask a filtering bug: whatever
    # comes back came back because the boundary let it through.
    vs._embeddings = np.ones((len(CHUNKS), 4), dtype=np.float32) / 2.0
    vs._texts = [c[0] for c in CHUNKS]
    vs._metas = []
    for _text, tenant, districts in CHUNKS:
        meta = {"source_collection": "alerts"}
        if tenant is not None:
            meta["tenant_id"] = tenant
        if districts is not None:
            meta["districts"] = districts
        vs._metas.append(meta)
    vs._cache_loaded = True
    return vs


def _search(tenant_id=None, districts=None, top_k=10):
    q = [1.0, 1.0, 1.0, 1.0]
    hits = _store()._search_with_cache(q, top_k, tenant_id=tenant_id, districts=districts)
    return {h["text"] for h in hits}


# --------------------------------------------------------------------------- #
# tenant boundary
# --------------------------------------------------------------------------- #

def test_tenant_sees_only_its_own_chunks():
    got = _search(tenant_id="t1")
    assert got == {"t1 hyderabad", "t1 mulugu", "t1 tenant wide", "t1 no district"}
    assert not any(t.startswith("t2") for t in got)


def test_other_tenant_is_never_reachable():
    assert _search(tenant_id="t2") == {"t2 hyderabad", "t2 tenant wide"}


def test_untagged_chunks_are_excluded_from_every_tenant():
    # A chunk ingested before tenant-tagging belongs to nobody. It must not
    # leak into the first tenant that happens to ask.
    for tenant in ("t1", "t2"):
        assert "untagged" not in _search(tenant_id=tenant)


def test_unknown_tenant_gets_nothing():
    assert _search(tenant_id="does-not-exist") == set()


# --------------------------------------------------------------------------- #
# district boundary, on top of the tenant boundary
# --------------------------------------------------------------------------- #

def test_officer_sees_own_district_plus_tenant_wide():
    got = _search(tenant_id="t1", districts=["Hyderabad"])
    assert got == {"t1 hyderabad", "t1 tenant wide", "t1 no district"}
    assert "t1 mulugu" not in got, "an officer must not read another district"


def test_officer_with_several_districts_sees_each_of_them():
    got = _search(tenant_id="t1", districts=["Hyderabad", "Mulugu"])
    assert {"t1 hyderabad", "t1 mulugu"} <= got


def test_districts_none_means_state_admin_not_zero_districts():
    # None = no district scoping requested. This is the distinction that, if
    # collapsed, silently hands a districtless officer the whole tenant.
    assert "t1 mulugu" in _search(tenant_id="t1", districts=None)


def test_officer_with_zero_districts_fails_closed():
    # [] = an officer with no districts assigned. Not the same as None.
    assert _search(tenant_id="t1", districts=[]) == set()


def test_district_filter_cannot_cross_the_tenant_boundary():
    # t2 also has a Hyderabad chunk; asking as t1 for Hyderabad must not reach it.
    got = _search(tenant_id="t1", districts=["Hyderabad"])
    assert "t2 hyderabad" not in got


def test_district_unknown_to_the_tenant_returns_only_tenant_wide():
    got = _search(tenant_id="t1", districts=["Nizamabad"])
    assert got == {"t1 tenant wide", "t1 no district"}


# --------------------------------------------------------------------------- #
# the Mongo-side fragment used by the three server-side strategies
# --------------------------------------------------------------------------- #

def test_mongo_district_fragment_none_is_unrestricted():
    assert VectorStore._district_mongo_filter(None) == {}


def test_mongo_district_fragment_empty_matches_nothing():
    assert VectorStore._district_mongo_filter([]) == {"metadata.districts": {"$in": []}}


def test_mongo_district_fragment_uses_and_so_it_cannot_clobber_a_text_search():
    # The text pre-filter path builds its own query; composing under $and keeps
    # both clauses alive. A bare top-level $or would overwrite or be overwritten.
    frag = VectorStore._district_mongo_filter(["Hyderabad"])
    assert "$and" in frag and "$or" not in frag
    q = {"$text": {"$search": "riot"}}
    q.update(frag)
    assert "$text" in q and "$and" in q



# --------------------------------------------------------------------------- #
# API layer: the same boundary, enforced before Mongo is touched
# --------------------------------------------------------------------------- #

import api_server as api  # noqa: E402  (imported late: it loads the FastAPI app)


def test_data_endpoint_rejects_a_request_with_no_tenant():
    # This app binds 0.0.0.0. Without this guard a direct call that skips the
    # Node proxy falls through to an empty filter and reads every tenant.
    for missing in (None, "", "   "):
        with pytest.raises(Exception) as exc:
            api._require_tenant(missing)
        assert "tenant_id is required" in str(getattr(exc.value, "detail", exc.value))


def test_require_tenant_returns_the_trimmed_id():
    assert api._require_tenant("  t1  ") == "t1"


def test_tenant_filter_scopes_and_is_empty_without_a_tenant():
    assert api._tenant_filter("t1") == {"tenant_id": "t1"}
    assert api._tenant_filter(None) == {}


def test_api_district_scope_admin_is_unrestricted():
    assert api._with_district_scope({"tenant_id": "t1"}, None) == {"tenant_id": "t1"}


def test_api_district_scope_zero_districts_fails_closed():
    q = api._with_district_scope({"tenant_id": "t1"}, [])
    assert q["districts"] == {"$in": []}


def test_api_district_scope_composes_under_and():
    # A caller may already have its own $or (handle search). Both must survive.
    q = {"tenant_id": "t1", "$or": [{"author": "x"}]}
    api._with_district_scope(q, ["Hyderabad"])
    assert q["$or"] == [{"author": "x"}], "the caller's own $or was clobbered"
    assert len(q["$and"]) == 1


def test_cache_keys_never_mix_admin_with_a_districtless_officer():
    # Sharing one cache entry across these two scopes serves a whole-tenant
    # briefing to an officer entitled to nothing.
    assert api._district_scope_key(None) != api._district_scope_key([])


def test_cache_keys_are_order_independent_but_scope_specific():
    assert api._district_scope_key(["B", "A"]) == api._district_scope_key(["A", "B"])
    assert api._district_scope_key(["A"]) != api._district_scope_key(["A", "B"])

if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
