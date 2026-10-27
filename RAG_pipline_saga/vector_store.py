"""
vector_store.py — STAGE 5
  Store embeddings in MongoDB and perform cosine-similarity search.
  Uses a local numpy cache for fast search — avoids pulling 73K+ vectors
  over the network every query.
"""

import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional, Tuple

import numpy as np
from pymongo import MongoClient, UpdateOne, ASCENDING
from pymongo.collection import Collection
from pymongo.errors import OperationFailure

import mongo_pool

logger = logging.getLogger(__name__)

CACHE_ROOT = os.path.join(os.path.dirname(__file__), ".vector_cache")

# Retained so existing imports keep working; anything tenant-aware should use
# VectorStore.cache_dir, which namespaces by database.
CACHE_DIR = CACHE_ROOT

# A database name is already Mongo-sanitised, but it becomes a directory here,
# so strip anything a path should not carry.
_UNSAFE_DIR = re.compile(r"[^A-Za-z0-9._-]")


def _safe_dir(name: str) -> str:
    return _UNSAFE_DIR.sub("_", str(name or "_shared"))[:80] or "_shared"


# Which retrieval strategy actually served the last searches, per process.
# Exposed because "semantic search" silently meaning "local cosine over recent
# chunks" is exactly the kind of degradation that should never be invisible.
SEARCH_STRATEGY_COUNTS: Dict[str, int] = {}

#: The same counts per collection. The total says retrieval is degrading; only
#: this says WHICH collection has no index, which is the thing an operator can
#: act on.
SEARCH_STRATEGY_BY_COLLECTION: Dict[str, Dict[str, int]] = {}

#: Strategies that are the real thing. Anything else is degraded operation.
#
# `brute_force_complete` is healthy: a local cosine that read EVERY vector in
# the collection has the same recall as the index, just slower. Only
# `brute_force_capped` — where the fetch limit cut the scan short — actually
# loses results, and that is the one an operator needs to see.
HEALTHY_STRATEGIES = frozenset({"atlas_vector_search", "atlas_vector_search_empty",
                                "brute_force_complete"})

#: The index path proper. Narrower than HEALTHY_STRATEGIES on purpose: these
#: two answer different questions. "Are results being lost?" is the operational
#: alarm (HEALTHY_STRATEGIES). "Did this run on the index?" is a diagnostic —
#: a complete local scan loses nothing today but will the moment the collection
#: outgrows the fetch limit, so verify_recall still reports it as off-path.
INDEX_STRATEGIES = frozenset({"atlas_vector_search", "atlas_vector_search_empty"})

_STRATEGY_LOCK = threading.Lock()


def _note_strategy(name: str, collection: Optional[str] = None) -> None:
    with _STRATEGY_LOCK:
        SEARCH_STRATEGY_COUNTS[name] = SEARCH_STRATEGY_COUNTS.get(name, 0) + 1
        if collection:
            per = SEARCH_STRATEGY_BY_COLLECTION.setdefault(collection, {})
            per[name] = per.get(name, 0) + 1


def search_strategy_report() -> Dict[str, int]:
    """A copy of the counts, for the metrics endpoint and for tests."""
    with _STRATEGY_LOCK:
        return dict(SEARCH_STRATEGY_COUNTS)


def search_strategy_by_collection() -> Dict[str, Dict[str, int]]:
    """Per collection, so a degraded one can be named rather than guessed at."""
    with _STRATEGY_LOCK:
        return {col: dict(counts)
                for col, counts in SEARCH_STRATEGY_BY_COLLECTION.items()}


def degraded_collections() -> List[str]:
    """Collections that have served a search by anything but the real path."""
    return sorted(col for col, counts in search_strategy_by_collection().items()
                  if any(name not in HEALTHY_STRATEGIES for name in counts))


def reset_search_strategy_counts() -> None:
    with _STRATEGY_LOCK:
        SEARCH_STRATEGY_COUNTS.clear()
        SEARCH_STRATEGY_BY_COLLECTION.clear()


class VectorStore:
    """Read/write 768-dim vectors in a MongoDB collection and search by cosine similarity."""

    @property
    def cache_dir(self) -> str:
        """Cache directory for THIS store.

        Vectors live inside the tenant's own database, so the database name is
        the tenant boundary on disk too. Without this split every tenant writes
        to the same file and the first to warm a collection serves its vectors
        to all the others.
        """
        return os.path.join(CACHE_ROOT, _safe_dir(self.db_name))

    def __init__(self, uri: str, db_name: str, collection_name: str = "vector_embeddings"):
        self.uri = uri
        self.db_name = db_name
        self.collection_name = collection_name
        self._client: Optional[MongoClient] = None
        self._collection: Optional[Collection] = None
        # In-memory cache
        self._cache_loaded = False
        self._embeddings: Optional[np.ndarray] = None  # (N, 768) normalized
        self._texts: List[str] = []
        self._metas: List[Dict] = []

    # -- connection ----------------------------------------------------------

    def connect(self) -> Collection:
        if self._collection is not None:
            return self._collection
        # The process's client, not this store's own. A MongoClient is a pool
        # with its own monitoring threads and TLS handshakes; building one per
        # store cost 829 ms before the first 27 ms query, and the seven stores
        # one scope needs cost 3.7 s between them.
        self._client = mongo_pool.client(self.uri)
        db = self._client[self.db_name]
        self._collection = db[self.collection_name]
        self._ensure_indexes()
        return self._collection

    def close(self):
        """Release this store's handles and its warm vectors.

        It does NOT close the client: the client is shared with every other
        store in the process, and closing it here would break a request that is
        still running. Process shutdown calls mongo_pool.close_all().
        """
        self._client = None
        self._collection = None
        self._cache_loaded = False
        self._embeddings = None
        self._texts = []
        self._metas = []

    #: (database, collection) pairs whose indexes this process has already
    #: ensured. create_index is idempotent but not free: two round trips on
    #: every reconnect, and a store is reconnected every time the warm-store
    #: cache evicts it.
    _INDEXED: set = set()
    _INDEX_LOCK = threading.Lock()

    def _ensure_indexes(self):
        """Create indexes for upsert deduplication and text search."""
        key = (self.db_name, self.collection_name)
        with VectorStore._INDEX_LOCK:
            if key in VectorStore._INDEXED:
                return
            VectorStore._INDEXED.add(key)
        try:
            self._create_indexes()
        except Exception:
            # Not marked as done, so the next connect tries again: a transient
            # failure must not leave the collection permanently unindexed.
            with VectorStore._INDEX_LOCK:
                VectorStore._INDEXED.discard(key)
            raise

    def _create_indexes(self):
        col = self._collection
        col.create_index(
            [("metadata.document_id", 1), ("metadata.chunk_index", 1)],
            unique=True,
            name="upsert_dedup_idx",
            background=True,
        )
        # Text index on the chunk text field — enables the fast text pre-filter
        # search path in cosine_search (avoids the unreliable $function JS fallback).
        existing = {idx["name"] for idx in col.list_indexes()}
        if "text_search_idx" not in existing:
            try:
                col.create_index(
                    [("text", "text")],
                    name="text_search_idx",
                    background=True,
                )
                logger.info("Created text index on '%s.text'.", self.collection_name)
            except Exception as exc:
                logger.warning("Could not create text index (may already exist): %s", exc)

        # Facet indexes for structured retrieval. Every query starts from the
        # tenant, so it leads each one; a scan here is a scan of the whole
        # corpus on every question.
        #
        # MongoDB allows at most ONE array field per compound index, so
        # topics, targets and districts each get their own rather than being
        # combined -- a compound index over two of them is rejected outright.
        facet_indexes = [
            ([("metadata.tenant_id", 1), ("metadata.published_at", -1)], "facet_recency_idx"),
            ([("metadata.tenant_id", 1), ("metadata.risk_score", -1)], "facet_risk_idx"),
            ([("metadata.tenant_id", 1), ("metadata.sentiment", 1),
              ("metadata.published_at", -1)], "facet_sentiment_idx"),
            ([("metadata.tenant_id", 1), ("metadata.risk_level", 1),
              ("metadata.published_at", -1)], "facet_risk_level_idx"),
            ([("metadata.tenant_id", 1), ("metadata.topics", 1),
              ("metadata.published_at", -1)], "facet_topics_idx"),
            ([("metadata.tenant_id", 1), ("metadata.targets", 1),
              ("metadata.published_at", -1)], "facet_targets_idx"),
            ([("metadata.tenant_id", 1), ("metadata.districts", 1)], "facet_districts_idx"),
            ([("metadata.tenant_id", 1), ("metadata.handle", 1),
              ("metadata.published_at", -1)], "facet_handle_idx"),
            ([("metadata.tenant_id", 1), ("metadata.tagged", 1),
              ("metadata.published_at", -1)], "facet_tagged_idx"),
            # On-demand scans score a selected window by chunk id.
            ([("metadata.chunk_id", 1)], "chunk_id_idx"),
        ]
        for keys, name in facet_indexes:
            if name in existing:
                continue
            try:
                col.create_index(keys, name=name, background=True)
            except Exception as exc:
                logger.warning("Could not create %s: %s", name, exc)

        logger.debug("Ensured dedup, text and facet indexes on '%s'.", self.collection_name)

    # -- write ---------------------------------------------------------------

    def upsert_chunks(self, chunks: List[Dict[str, Any]]) -> int:
        """Bulk upsert a list of chunk dicts.

        Each dict must contain: ``text``, ``embedding``, ``metadata``
        (with ``document_id`` and ``chunk_index``).

        Returns the number of upserted/modified documents.
        """
        col = self.connect()
        ops = []
        now = datetime.now(timezone.utc)

        for chunk in chunks:
            meta = chunk["metadata"]
            filt = {
                "metadata.document_id": meta["document_id"],
                "metadata.chunk_index": meta["chunk_index"],
            }
            update = {
                "$set": {
                    "text": chunk["text"],
                    "embedding": chunk["embedding"],
                    "metadata": {
                        **meta,
                        "created_at": now,
                        "source_created_at": meta.get("source_created_at"),
                    },
                }
            }
            ops.append(UpdateOne(filt, update, upsert=True))

        if not ops:
            return 0

        result = col.bulk_write(ops, ordered=False)
        written = result.upserted_count + result.modified_count
        logger.debug("Upserted %d chunks.", written)
        return written

    def prune_orphan_chunks(self, document_id: str, keep_from: int,
                            tenant_id: Optional[str] = None) -> int:
        """Delete this document's chunks at index *keep_from* and above.

        A re-render that produces fewer chunks than last time leaves the tail
        behind: ``upsert_chunks`` writes by ``(document_id, chunk_index)``, so
        it replaces 0..n-1 and never touches n..old_max. Those survivors keep
        their old text and their old (or missing) facets, and retrieval has no
        way to tell them from current ones.

        Called AFTER the new chunks are written, never before. If embedding or
        the write fails, nothing is pruned and the previous representation
        survives intact -- a stale document is recoverable, a document with no
        vectors at all is invisible until someone notices.

        ``keep_from=0`` removes every chunk, which is what a document that now
        renders to nothing should leave behind.

        The store is already bound to one tenant's database, so cross-tenant
        deletion is not expressible here; *tenant_id* is still applied when
        given, because a delete is the one operation where belt and braces cost
        nothing.
        """
        if not document_id or keep_from < 0:
            return 0
        query: Dict[str, Any] = {
            "metadata.document_id": document_id,
            "metadata.chunk_index": {"$gte": keep_from},
        }
        if tenant_id:
            query["metadata.tenant_id"] = tenant_id
        try:
            result = self.connect().delete_many(query)
            removed = result.deleted_count or 0
            if removed:
                logger.info("Pruned %d orphan chunk(s) from %s for document %s",
                            removed, self.collection_name, document_id)
            return removed
        except Exception as exc:
            logger.warning("Could not prune orphan chunks for %s: %s", document_id, exc)
            return 0

    # -- read / search -------------------------------------------------------

    def total_chunks(self) -> int:
        col = self.connect()
        return col.estimated_document_count()

    def get_embedded_doc_ids(self) -> set:
        """Return the set of document_id strings already stored."""
        col = self.connect()
        ids = col.distinct("metadata.document_id")
        return set(ids)

    def get_last_ingested_time(self) -> Optional[datetime]:
        """Return the latest created_at timestamp from stored chunks.
        Used for incremental ingestion — only process docs newer than this.
        """
        col = self.connect()
        result = col.find_one(
            {},
            {"metadata.source_created_at": 1},
            sort=[("metadata.source_created_at", -1)],
        )
        if result and result.get("metadata", {}).get("source_created_at"):
            return result["metadata"]["source_created_at"]
        return None

    def cosine_search(
        self,
        query_vector: List[float],
        top_k: int = 5,
        batch_size: int = 5000,
        query_text: str = "",
        source_collection: Optional[str] = None,
        tenant_id: Optional[str] = None,
        districts: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Cosine similarity search.

        If ``source_collection`` is provided, results are restricted to chunks
        whose ``metadata.source_collection`` matches it (so a query against
        "users" never returns tweet chunks, etc.).

        If ``tenant_id`` is provided, results are restricted to chunks whose
        ``metadata.tenant_id`` matches it — a HARD multi-tenant boundary, so one
        tenant's question can never surface another tenant's chunks. Chunks
        ingested before tenant-tagging carry no tenant_id and are excluded.

        If ``districts`` is provided (a District Officer's own assigned
        districts, never set for a State Admin), a chunk is returned only when
        its ``metadata.districts`` is empty/absent (tenant-wide data, always
        visible) or overlaps the caller's districts. This is the second-level
        boundary on top of tenant_id.

        ``districts=None`` and ``districts=[]`` are NOT the same: None means no
        district scoping was requested (admin), while an empty list means an
        officer with zero districts assigned and must fail CLOSED. Conflating
        them would let a districtless officer read the whole tenant.

        Uses local numpy cache if available, otherwise falls back to
        server-side MongoDB text pre-filter + local cosine re-rank.
        """
        # Fast path: use numpy cache if already loaded or on disk
        if self._cache_loaded or self._cache_exists_on_disk():
            return self._search_with_cache(
                query_vector, top_k, source_collection=source_collection,
                tenant_id=tenant_id, districts=districts,
            )

        # Slow path: text pre-filter + local cosine (fast) or sampled search (fallback)
        logger.info("No local cache — running server-side search...")
        return self._search_server_side(
            query_vector, top_k, query_text=query_text, source_collection=source_collection,
            tenant_id=tenant_id, districts=districts,
        )

    def similarity(self, query_vector: List[float], chunk_ids: List[str],
                   fetch_limit: int = 5000) -> Dict[str, float]:
        """Cosine of *query_vector* against exactly these chunks.

        For scoring a window the database already selected ("last 7 days"),
        where a global top-k would mostly return chunks outside it. The ids
        come from a tenant- and district-filtered query, so this adds no
        boundary of its own and needs none.

        Uses the warm numpy cache when present; otherwise reads just these
        chunks' embeddings, bounded by *fetch_limit*.
        """
        if not chunk_ids:
            return {}
        q = np.array(query_vector, dtype=np.float32)
        qn = np.linalg.norm(q)
        if qn == 0:
            return {}
        q = q / qn
        wanted = set(chunk_ids)

        if self._cache_loaded or self._cache_exists_on_disk():
            try:
                self._ensure_cache()
                if self._embeddings is not None and len(self._metas):
                    idx = [i for i, m in enumerate(self._metas) if m.get("chunk_id") in wanted]
                    if idx:
                        scores = self._embeddings[idx] @ q
                        out = {self._metas[i]["chunk_id"]: float(s) for i, s in zip(idx, scores)}
                        # Chunks newer than the cache are scored from Mongo below.
                        wanted -= set(out)
                        if not wanted:
                            return out
                    else:
                        out = {}
                else:
                    out = {}
            except Exception as exc:
                logger.debug("cache similarity failed, reading from Mongo: %s", exc)
                out = {}
        else:
            out = {}

        ids = list(wanted)[:fetch_limit]
        col = self.connect()
        for i in range(0, len(ids), 500):
            for d in col.find({"metadata.chunk_id": {"$in": ids[i:i + 500]}},
                              {"embedding": 1, "metadata.chunk_id": 1, "_id": 0}):
                emb = d.get("embedding")
                if not emb:
                    continue
                v = np.array(emb, dtype=np.float32)
                n = np.linalg.norm(v)
                if n:
                    out[d["metadata"]["chunk_id"]] = float((v / n) @ q)
        return out

    @staticmethod
    def _district_mongo_filter(districts: Optional[List[str]]) -> Dict[str, Any]:
        """Mongo fragment for the district boundary. A chunk with no
        ``metadata.districts`` is tenant-wide and always visible; one WITH
        districts matches only on overlap.

        None = no restriction. [] = an officer with zero districts, which fails
        closed. Composed under ``$and`` so it never clobbers a caller's own
        ``$or`` (the text pre-filter path builds one).
        """
        if districts is None:
            return {}
        if not districts:
            return {"metadata.districts": {"$in": []}}
        return {"$and": [{
            "$or": [
                {"metadata.districts": {"$in": districts}},
                {"metadata.districts": {"$exists": False}},
                {"metadata.districts": {"$size": 0}},
            ]
        }]}

    def _cache_exists_on_disk(self) -> bool:
        emb_path = os.path.join(self.cache_dir, f"{self.collection_name}_embeddings.npy")
        meta_path = os.path.join(self.cache_dir, f"{self.collection_name}_meta.json")
        return os.path.exists(emb_path) and os.path.exists(meta_path)

    def _search_with_cache(
        self,
        query_vector: List[float],
        top_k: int,
        source_collection: Optional[str] = None,
        tenant_id: Optional[str] = None,
        districts: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Search using the local numpy cache."""
        self._ensure_cache()

        if self._embeddings is None or len(self._texts) == 0:
            logger.warning("Vector cache is empty — no chunks to search.")
            return []

        q = np.array(query_vector, dtype=np.float32)
        q_norm = np.linalg.norm(q)
        if q_norm == 0:
            return []
        q = q / q_norm

        scores = self._embeddings @ q

        if source_collection:
            mask = np.array(
                [m.get("source_collection") == source_collection for m in self._metas],
                dtype=bool,
            )
            if not mask.any():
                logger.warning("Cache has no chunks for source_collection=%s", source_collection)
                return []
            scores = np.where(mask, scores, -np.inf)

        if tenant_id:
            # HARD tenant boundary: drop every chunk not tagged with this tenant.
            tmask = np.array([m.get("tenant_id") == tenant_id for m in self._metas], dtype=bool)
            if not tmask.any():
                logger.warning("Cache has no chunks for tenant_id=%s", tenant_id)
                return []
            scores = np.where(tmask, scores, -np.inf)

        if districts is not None:
            # [] is an officer with zero districts: fail closed, see cosine_search.
            if not districts:
                dmask = np.zeros(len(self._metas), dtype=bool)
            else:
                dmask = np.array([
                    (not m.get("districts")) or any(d in districts for d in (m.get("districts") or []))
                    for m in self._metas
                ], dtype=bool)
            scores = np.where(dmask, scores, -np.inf)

        top_indices = np.argsort(scores)[::-1][:top_k]

        results = []
        for idx in top_indices:
            if not np.isfinite(scores[idx]):
                break
            results.append({
                "text": self._texts[idx],
                "metadata": self._metas[idx],
                "score": float(scores[idx]),
            })
        return results

    def _search_server_side(
        self,
        query_vector: List[float],
        top_k: int,
        query_text: str = "",
        source_collection: Optional[str] = None,
        tenant_id: Optional[str] = None,
        districts: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Search using server-side computation.

        Strategy 1 (fast ~2-5s): MongoDB text index pre-filter → local cosine re-rank.
        Strategy 2 (fallback ~5-10s): $sample random subset → $function JS dot product.
        Strategy 3 (reliable fallback): Fetch recent chunks from MongoDB → local cosine.
        """
        col = self.connect()

        # Normalize query vector
        q = np.array(query_vector, dtype=np.float32)
        q_norm = np.linalg.norm(q)
        if q_norm == 0:
            return []
        q_normalized = q / q_norm

        # Strategy 0: the real thing — Atlas Vector Search, server-side ANN.
        #
        # This was never reached before: no vector index existed on any
        # collection, so every semantic query silently fell through to a
        # local cosine over recently-fetched chunks and called that "semantic
        # search". The index is the production path; everything below it is
        # degraded operation and now says so in telemetry.
        if self._vector_index_name:
            try:
                results = self._atlas_vector_search(
                    col, q_normalized.tolist(), top_k, source_collection=source_collection,
                    tenant_id=tenant_id, districts=districts,
                )
                if results:
                    _note_strategy("atlas_vector_search", col.name)
                    return results
                # Empty from a READY, queryable index is an ANSWER, not a
                # failure: nothing in this collection matches the scope. The
                # fallbacks below re-ran the same scoped search by slower
                # means and necessarily found the same nothing — an 11-second
                # round trip to confirm a 0.03-second result, which then
                # reported the collection as degraded when it was working
                # perfectly. Trust the index.
                _note_strategy("atlas_vector_search_empty", col.name)
                return []
            except OperationFailure as exc:
                # An absent or still-building index is not an error worth
                # failing the query over; it is a reason to degrade.
                logger.info("vector search unavailable on %s (%s) — degrading",
                            col.name, str(exc)[:120])
                _note_strategy("atlas_unavailable", col.name)
            except Exception as exc:
                logger.warning("vector search failed on %s: %s", col.name, exc)
                _note_strategy("atlas_error", col.name)

        # Strategy 1: text pre-filter (if query text available and text index exists)
        if query_text.strip():
            try:
                results = self._text_prefilter_search(
                    col, q_normalized, top_k, query_text, source_collection=source_collection,
                    tenant_id=tenant_id, districts=districts,
                )
                if results:
                    _note_strategy("text_prefilter", col.name)
                    return results
            except Exception as exc:
                logger.warning("Text pre-filter search failed: %s — falling back to sampled", exc)

        # Strategy 2: $sample + $function.
        #
        # This tier refuses $function outright, so on this deployment every
        # call here is a round trip that can only fail — 36 of them in one
        # validation run, each logged as an error. Once the server has said so,
        # stop asking and degrade straight to the path that works.
        if not VectorStore._FUNCTION_BLOCKED:
            logger.info("Using sampled search (2K random chunks)...")
            results = self._sampled_search(
                col, q_normalized.tolist(), top_k, source_collection=source_collection,
                tenant_id=tenant_id, districts=districts,
            )
            if results:
                _note_strategy("sampled", col.name)
                return results

        # Strategy 3: brute-force fetch + local cosine (reliable fallback)
        logger.info("Sampled search returned nothing — fetching chunks for local cosine...")
        # The strategy is noted INSIDE the scan, which is the only place that
        # knows whether the fetch limit truncated it.
        return self._brute_force_search(
            col, q_normalized, top_k, source_collection=source_collection,
            tenant_id=tenant_id, districts=districts,
        )

    #: The Atlas Vector Search index this store may use, or None when the
    #: collection has none: {key: (name, probed_at)}. Cached because a per-query
    #: probe is a round trip on the hot path.
    _INDEX_PROBE_CACHE: Dict[str, Tuple[Optional[str], float]] = {}
    _PROBE_LOCK = threading.Lock()

    #: How long a probe answer is trusted. A POSITIVE answer barely changes, but
    #: a NEGATIVE one does the moment someone builds the index — and caching
    #: "no index" for the life of the process meant a new index only took effect
    #: after a restart, while every query in between degraded silently. Short
    #: enough to pick the index up on its own, long enough to stay off the hot
    #: path: one probe per collection per interval.
    INDEX_PROBE_TTL_S = float(os.getenv("AI_VECTOR_INDEX_PROBE_TTL_S", "300"))

    #: Set once the cluster has refused $function. It is a property of the
    #: tier, not of one query, so asking again only buys another round trip.
    _FUNCTION_BLOCKED: bool = False

    #: How many vectors a local cosine scan will pull before it gives up on
    #: reading the whole collection. A scan that reaches this number ranked
    #: only the newest slice, so it is reported as capped rather than complete.
    BRUTE_FORCE_FETCH_LIMIT: int = int(os.getenv("AI_VECTOR_SCAN_LIMIT", "2000"))

    def _probe_index_name(self, col: Collection) -> Optional[str]:
        """Name of a READY vectorSearch index on *col*, or None."""
        try:
            for idx in col.list_search_indexes():
                if idx.get("type") != "vectorSearch":
                    continue
                # `queryable` is the field that says a search will actually
                # work; an index can be READY while still building its first
                # copy, and querying it then fails.
                ready = idx.get("status") == "READY" or idx.get("queryable") is True
                if ready:
                    return idx.get("name")
        except Exception as exc:                                  # noqa: BLE001
            logger.debug("search index probe failed on %s.%s: %s",
                         self.db_name, self.collection_name, exc)
        return None

    @property
    def _vector_index_name(self) -> Optional[str]:
        key = f"{self.db_name}.{self.collection_name}"
        now = time.monotonic()
        with VectorStore._PROBE_LOCK:
            cached = VectorStore._INDEX_PROBE_CACHE.get(key)
            if cached is not None:
                name, probed_at = cached
                # A positive answer is kept; only "no index" is re-checked, so
                # the hot path never pays for a collection that has one.
                if name is not None or now - probed_at < VectorStore.INDEX_PROBE_TTL_S:
                    return name
        name = self._probe_index_name(self.connect())
        with VectorStore._PROBE_LOCK:
            previous = VectorStore._INDEX_PROBE_CACHE.get(key)
            VectorStore._INDEX_PROBE_CACHE[key] = (name, now)
        if previous is None or previous[0] != name:
            logger.info("vector index for %s: %s", key,
                        name or "none — semantic search on this collection is degraded")
        return name

    @classmethod
    def forget_index_probes(cls) -> None:
        """Drop cached probe answers. For tests, and after creating an index."""
        with cls._PROBE_LOCK:
            cls._INDEX_PROBE_CACHE.clear()

    # -- index configuration, verified rather than assumed -------------------

    #: What the search code relies on. A filter path missing from the index
    #: definition does not fail loudly — Atlas refuses the query, the store
    #: degrades, and retrieval quietly gets worse. Verified explicitly instead.
    REQUIRED_FILTER_PATHS = ("metadata.tenant_id", "metadata.districts",
                             "metadata.source_collection")
    EXPECTED_DIMENSIONS = 768
    EXPECTED_SIMILARITY = "cosine"

    def verify_index(self) -> Dict[str, Any]:
        """Is this collection's vector index configured the way we query it?

        Returns a report rather than raising: a collection with no index is a
        normal, degraded state, and the caller decides whether that is a
        problem. `ok` is True only when indexed ANN retrieval will actually run
        with the scope filters pushed into it.
        """
        report: Dict[str, Any] = {
            "collection": self.collection_name, "database": self.db_name,
            "indexed": False, "ok": False, "name": None, "status": None,
            "chunks": 0, "problems": [],
        }
        try:
            col = self.connect()
            report["chunks"] = col.estimated_document_count()
            definition = None
            for idx in col.list_search_indexes():
                if idx.get("type") == "vectorSearch":
                    report["indexed"] = True
                    report["name"] = idx.get("name")
                    report["status"] = idx.get("status")
                    report["queryable"] = bool(idx.get("queryable"))
                    definition = idx.get("latestDefinition") or {}
                    break
        except Exception as exc:                                  # noqa: BLE001
            report["problems"].append(f"could not read index configuration: {exc}")
            return report

        if not report["indexed"]:
            report["problems"].append(
                "no vectorSearch index: semantic search on this collection "
                "falls back to local cosine over a subset, which is slower and "
                "recalls less")
            return report

        fields = (definition or {}).get("fields") or []
        vector = next((f for f in fields if f.get("type") == "vector"), None)
        if vector is None:
            report["problems"].append("index defines no vector field")
        else:
            if vector.get("path") != "embedding":
                report["problems"].append(
                    f"vector path is {vector.get('path')!r}, queries use 'embedding'")
            if vector.get("numDimensions") != self.EXPECTED_DIMENSIONS:
                report["problems"].append(
                    f"index is {vector.get('numDimensions')} dimensions, the "
                    f"embedder produces {self.EXPECTED_DIMENSIONS}")
            if vector.get("similarity") != self.EXPECTED_SIMILARITY:
                report["problems"].append(
                    f"similarity is {vector.get('similarity')!r}, scores are "
                    f"interpreted as {self.EXPECTED_SIMILARITY}")

        filters = {f.get("path") for f in fields if f.get("type") == "filter"}
        for path in self.REQUIRED_FILTER_PATHS:
            if path not in filters:
                report["problems"].append(
                    f"{path} is not a filter field, so a scoped query is refused "
                    f"and retrieval degrades")
        if not report.get("queryable") and report["status"] != "READY":
            report["problems"].append(
                f"index status is {report['status']!r}, not queryable yet")
        report["ok"] = not report["problems"]
        return report

    def _atlas_vector_search(
        self,
        col: Collection,
        query_vector: List[float],
        top_k: int,
        source_collection: Optional[str] = None,
        tenant_id: Optional[str] = None,
        districts: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Server-side approximate nearest neighbour, scoped before it searches.

        The scope filter is pushed INTO the index query rather than applied
        afterwards, so a tenant's vectors are never ranked against another's
        and the k records returned are k records this caller may actually see.
        """
        clauses: List[Dict[str, Any]] = []
        if tenant_id:
            clauses.append({"metadata.tenant_id": {"$eq": tenant_id}})
        if source_collection:
            clauses.append({"metadata.source_collection": {"$eq": source_collection}})
        # districts=None means unrestricted (admin); [] means an officer with
        # no scope at all, which must match nothing. Same convention as
        # retriever.build_filter and _district_mongo_filter.
        if districts is not None:
            clauses.append({"metadata.districts": {"$in": list(districts)}})

        stage: Dict[str, Any] = {
            "index": self._vector_index_name,
            "path": "embedding",
            "queryVector": query_vector,
            # Atlas guidance: oversample the candidate pool so the filter has
            # something to survive on.
            "numCandidates": max(top_k * 20, 150),
            "limit": top_k,
        }
        if clauses:
            stage["filter"] = clauses[0] if len(clauses) == 1 else {"$and": clauses}

        cursor = col.aggregate([
            {"$vectorSearch": stage},
            {"$project": {"text": 1, "metadata": 1, "_id": 0,
                          "score": {"$meta": "vectorSearchScore"}}},
        ])
        return [{"text": d.get("text", ""), "metadata": d.get("metadata", {}),
                 "score": float(d.get("score", 0.0))} for d in cursor]

    def _text_prefilter_search(
        self,
        col: Collection,
        q_normalized: np.ndarray,
        top_k: int,
        query_text: str,
        source_collection: Optional[str] = None,
        tenant_id: Optional[str] = None,
        districts: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Use MongoDB text index to find candidate chunks, then re-rank by cosine.

        ~2-5s: text search returns 500 candidates, then local numpy cosine on 500 vectors.
        """
        CANDIDATE_LIMIT = 500

        mongo_filter: Dict[str, Any] = {"$text": {"$search": query_text}}
        if source_collection:
            mongo_filter["metadata.source_collection"] = source_collection
        if tenant_id:
            mongo_filter["metadata.tenant_id"] = tenant_id
        mongo_filter.update(self._district_mongo_filter(districts))

        candidates = list(
            col.find(
                mongo_filter,
                {"text": 1, "embedding": 1, "metadata": 1, "score": {"$meta": "textScore"}},
            )
            .sort([("score", {"$meta": "textScore"})])
            .limit(CANDIDATE_LIMIT)
        )

        if not candidates:
            logger.info("Text search returned 0 candidates for: %s", query_text[:100])
            return []

        logger.info("Text pre-filter found %d candidates — computing cosine locally", len(candidates))

        # Local cosine re-rank on just the candidates
        embeds = np.array([c["embedding"] for c in candidates], dtype=np.float32)
        norms = np.linalg.norm(embeds, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        embeds = embeds / norms

        scores = embeds @ q_normalized
        top_indices = np.argsort(scores)[::-1][:top_k]

        results = []
        for idx in top_indices:
            results.append({
                "text": candidates[idx].get("text", ""),
                "metadata": candidates[idx].get("metadata", {}),
                "score": float(scores[idx]),
            })
        return results

    def _sampled_search(
        self,
        col: Collection,
        q_list: List[float],
        top_k: int,
        source_collection: Optional[str] = None,
        tenant_id: Optional[str] = None,
        districts: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """$sample random docs from MongoDB, compute cosine similarity via $function."""
        SAMPLE_SIZE = 2000

        js_body = (
            "function(emb, qv) {"
            "  let dot = 0, norm = 0;"
            "  for (let i = 0; i < emb.length; i++) {"
            "    dot += emb[i] * qv[i];"
            "    norm += emb[i] * emb[i];"
            "  }"
            "  return norm > 0 ? dot / Math.sqrt(norm) : 0;"
            "}"
        )

        # The boundary must be applied BEFORE $sample, or the sample is drawn
        # from every tenant's chunks and merely filtered afterwards.
        pipeline: List[Dict[str, Any]] = []
        match_stage: Dict[str, Any] = {}
        if source_collection:
            match_stage["metadata.source_collection"] = source_collection
        if tenant_id:
            match_stage["metadata.tenant_id"] = tenant_id
        match_stage.update(self._district_mongo_filter(districts))
        if match_stage:
            pipeline.append({"$match": match_stage})
        pipeline.extend([
            {"$sample": {"size": SAMPLE_SIZE}},
            {
                "$addFields": {
                    "score": {
                        "$function": {
                            "body": js_body,
                            "args": ["$embedding", q_list],
                            "lang": "js",
                        }
                    }
                }
            },
            {"$sort": {"score": -1}},
            {"$limit": top_k},
            {"$project": {"text": 1, "metadata": 1, "score": 1, "_id": 0}},
        ])

        results = []
        try:
            for doc in col.aggregate(pipeline, allowDiskUse=True, maxTimeMS=120000):
                results.append({
                    "text": doc.get("text", ""),
                    "metadata": doc.get("metadata", {}),
                    "score": doc.get("score", 0.0),
                })
        except Exception as exc:
            if "$function not allowed" in str(exc):
                # A capability of the cluster, not a fault of this query.
                VectorStore._FUNCTION_BLOCKED = True
                logger.info("$function is not available on this cluster — "
                            "sampled search disabled for this process")
            else:
                logger.error("Sampled search failed: %s", exc)
        return results

    def exhaustive_search(
        self,
        query_vector: List[float],
        top_k: int = 5,
        source_collection: Optional[str] = None,
        tenant_id: Optional[str] = None,
        districts: Optional[List[str]] = None,
        limit: int = 20000,
    ) -> List[Dict[str, Any]]:
        """Ground truth: cosine over EVERY chunk in scope, no sampling.

        Slow by design and never on the request path. It exists so a claim about
        retrieval quality can be measured rather than asserted — an approximate
        index that recalls two of five is worse than the path it replaced, and
        nothing short of the exact answer can tell you which you have.
        """
        col = self.connect()
        q = np.array(query_vector, dtype=np.float32)
        norm = np.linalg.norm(q)
        if norm == 0:
            return []
        q = q / norm

        mongo_filter: Dict[str, Any] = {}
        if source_collection:
            mongo_filter["metadata.source_collection"] = source_collection
        if tenant_id:
            mongo_filter["metadata.tenant_id"] = tenant_id
        mongo_filter.update(self._district_mongo_filter(districts))

        scored: List[Tuple[float, Dict[str, Any]]] = []
        cursor = col.find(mongo_filter, {"text": 1, "embedding": 1, "metadata": 1}).limit(limit)
        for doc in cursor:
            vec = doc.get("embedding")
            if not vec:
                continue
            v = np.array(vec, dtype=np.float32)
            vn = np.linalg.norm(v)
            if vn == 0:
                continue
            scored.append((float(q @ (v / vn)), doc))
        scored.sort(key=lambda pair: -pair[0])
        return [{"text": d.get("text", ""), "metadata": d.get("metadata", {}), "score": sc}
                for sc, d in scored[:top_k]]

    def verify_recall(
        self,
        query_vector: List[float],
        top_k: int = 5,
        source_collection: Optional[str] = None,
        tenant_id: Optional[str] = None,
        districts: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """recall@k of the live search path against exhaustive cosine.

        Identity is the chunk's own id where it has one, falling back to the
        text: comparing scores would compare two different scales, because
        Atlas normalises cosine to (1 + cos) / 2.
        """
        def ids(rows):
            out = []
            for r in rows:
                md = r.get("metadata") or {}
                out.append(str(md.get("chunk_id") or md.get("url")
                               or (r.get("text") or "")[:120]))
            return out

        truth = ids(self.exhaustive_search(
            query_vector, top_k=top_k, source_collection=source_collection,
            tenant_id=tenant_id, districts=districts))
        before = search_strategy_report()
        live = ids(self.cosine_search(
            query_vector, top_k=top_k, query_text="", source_collection=source_collection,
            tenant_id=tenant_id, districts=districts))
        after = search_strategy_report()
        used = [name for name, count in after.items() if count > before.get(name, 0)]
        hits = len(set(truth) & set(live))
        return {
            "collection": self.collection_name,
            "top_k": top_k,
            "found": hits,
            "of": len(truth),
            "recall": round(hits / len(truth), 3) if truth else None,
            "strategy": used,
            "degraded": any(name not in INDEX_STRATEGIES for name in used),
        }

    def _brute_force_search(
        self,
        col: Collection,
        q_normalized: np.ndarray,
        top_k: int,
        source_collection: Optional[str] = None,
        tenant_id: Optional[str] = None,
        districts: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch chunks from MongoDB and compute cosine similarity locally.

        This is the most reliable fallback — no text index or $function JS needed.
        Fetches up to 2000 recent chunks, computes cosine in numpy.
        """
        FETCH_LIMIT = self.BRUTE_FORCE_FETCH_LIMIT
        mongo_filter: Dict[str, Any] = {}
        if source_collection:
            mongo_filter["metadata.source_collection"] = source_collection
        if tenant_id:
            mongo_filter["metadata.tenant_id"] = tenant_id
        mongo_filter.update(self._district_mongo_filter(districts))

        try:
            candidates = list(
                col.find(mongo_filter, {"text": 1, "embedding": 1, "metadata": 1})
                .sort("_id", -1)
                .limit(FETCH_LIMIT)
            )
        except Exception as exc:
            logger.error("Brute-force fetch failed: %s", exc)
            return []

        if not candidates:
            logger.info("No chunks found in collection for brute-force search.")
            _note_strategy("brute_force_complete", col.name)
            return []

        # A scan that read everything has the index's recall. A scan that hit
        # the limit ranked the NEWEST 2000 vectors and silently dropped the
        # rest, so a better match outside that window was never considered.
        # Those are different enough that calling both "brute_force" hid the
        # only case worth acting on.
        capped = len(candidates) >= FETCH_LIMIT
        _note_strategy("brute_force_capped" if capped else "brute_force_complete", col.name)
        if capped:
            logger.warning("Brute-force on %s hit the %d-chunk limit — recall is capped. "
                           "Build a vectorSearch index on this collection.",
                           col.name, FETCH_LIMIT)
        logger.info("Brute-force: fetched %d chunks — computing cosine locally", len(candidates))

        embeds = np.array([c["embedding"] for c in candidates], dtype=np.float32)
        norms = np.linalg.norm(embeds, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        embeds = embeds / norms

        scores = embeds @ q_normalized
        top_indices = np.argsort(scores)[::-1][:top_k]

        results = []
        for idx in top_indices:
            results.append({
                "text": candidates[idx].get("text", ""),
                "metadata": candidates[idx].get("metadata", {}),
                "score": float(scores[idx]),
            })
        return results

    # -- cache management ----------------------------------------------------

    def _ensure_cache(self):
        """Load the local cache into memory, building it from MongoDB if needed."""
        if self._cache_loaded:
            return

        os.makedirs(self.cache_dir, exist_ok=True)
        emb_path = os.path.join(self.cache_dir, f"{self.collection_name}_embeddings.npy")
        meta_path = os.path.join(self.cache_dir, f"{self.collection_name}_meta.json")

        if os.path.exists(emb_path) and os.path.exists(meta_path):
            logger.info("Loading vector cache from disk...")
            self._embeddings = np.load(emb_path)
            with open(meta_path, "r") as f:
                data = json.load(f)
            self._texts = data["texts"]
            self._metas = data["metas"]
            self._cache_loaded = True
            logger.info("Cache loaded — %d vectors ready.", len(self._texts))
            return

        # Build cache from MongoDB
        logger.info("Building vector cache from MongoDB (one-time download)...")
        self._build_cache(emb_path, meta_path)

    def _build_cache(self, emb_path: str, meta_path: str):
        """Download all vectors from MongoDB in small paginated batches and save to disk."""
        col = self.connect()
        total = col.estimated_document_count()
        logger.info("Downloading %d chunks from MongoDB (paginated)...", total)

        texts = []
        embeds = []
        metas = []

        # Use _id cursor pagination to avoid long-lived cursors timing out
        PAGE_SIZE = 500
        last_id = None
        count = 0

        while True:
            query = {"_id": {"$gt": last_id}} if last_id else {}
            batch = list(
                col.find(query, {"text": 1, "embedding": 1, "metadata": 1})
                .sort("_id", 1)
                .limit(PAGE_SIZE)
            )
            if not batch:
                break

            for doc in batch:
                texts.append(doc.get("text", ""))
                embeds.append(doc["embedding"])
                metas.append(doc.get("metadata", {}))

            last_id = batch[-1]["_id"]
            count += len(batch)
            if count % 5000 == 0 or count == len(batch):
                logger.info("  Downloaded %d / %d chunks...", count, total)

        logger.info("Download complete — %d chunks.", count)

        if not embeds:
            logger.warning("No embeddings found in MongoDB.")
            self._cache_loaded = True
            return

        # Normalize and save
        mat = np.array(embeds, dtype=np.float32)
        norms = np.linalg.norm(mat, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        mat = mat / norms

        np.save(emb_path, mat)
        with open(meta_path, "w") as f:
            json.dump({"texts": texts, "metas": metas}, f)

        self._embeddings = mat
        self._texts = texts
        self._metas = metas
        self._cache_loaded = True
        logger.info("Cache built and saved — %d vectors (%s).", len(texts), emb_path)

    def invalidate_cache(self):
        """Delete the local cache so it gets rebuilt on next search."""
        self._cache_loaded = False
        self._embeddings = None
        self._texts = []
        self._metas = []
        for f in os.listdir(self.cache_dir) if os.path.exists(self.cache_dir) else []:
            if f.startswith(self.collection_name):
                os.remove(os.path.join(self.cache_dir, f))
                logger.info("Deleted cache file: %s", f)

    def refresh_cache(self):
        """Force rebuild the cache from MongoDB."""
        self.invalidate_cache()
        self._ensure_cache()


# ---------------------------------------------------------------------------
# OPTIONAL — Atlas Vector Search index creation (run once in Atlas UI or shell)
# ---------------------------------------------------------------------------
#
# If you are using MongoDB Atlas and want hardware-accelerated ANN search
# instead of the brute-force numpy approach above, create a Search index on
# the ``vector_embeddings`` collection:
#
#   {
#     "mappings": {
#       "dynamic": true,
#       "fields": {
#         "embedding": {
#           "type": "knnVector",
#           "dimensions": 768,
#           "similarity": "cosine"
#         }
#       }
#     }
#   }
#
# Then replace ``cosine_search`` with an aggregation pipeline:
#
#   pipeline = [
#       {
#           "$vectorSearch": {
#               "index": "vector_index",
#               "path": "embedding",
#               "queryVector": query_vector,
#               "numCandidates": 100,
#               "limit": top_k,
#           }
#       },
#       {
#           "$project": {
#               "text": 1,
#               "metadata": 1,
#               "score": {"$meta": "vectorSearchScore"},
#           }
#       },
#   ]
#   results = list(collection.aggregate(pipeline))
# ---------------------------------------------------------------------------
