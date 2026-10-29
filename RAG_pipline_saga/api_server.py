"""
api_server.py — FastAPI bridge for the RAG pipeline.

Exposes REST endpoints so the Node.js backend (or any client) can:
  - GET  /api/rag/health          → MongoDB + vLLM embedding + vLLM LLM health
  - GET  /api/rag/collections     → list all MongoDB collections
  - POST /api/rag/query           → synchronous question (blocks until answer)
  - POST /api/rag/query/async     → enqueue question, returns {job_id} immediately
  - GET  /api/rag/jobs/{job_id}   → poll status/result of an async job
  - GET  /api/rag/jobs            → list recent jobs (optionally by collection)
  - POST /api/rag/ingest          → trigger ingestion for a collection
  - GET  /api/rag/stats           → vector store stats

Run:
    uvicorn api_server:app --host 0.0.0.0 --port 8100 --reload
"""

import hashlib
import logging
import os
import re
import textwrap
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from datetime import datetime, timezone, timedelta, time as dtime
from collections import OrderedDict
from typing import Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
import _compiled_compat  # noqa: F401  (before any pydantic model; see the module)
from pydantic import BaseModel
from pymongo import MongoClient, DESCENDING
from starlette.middleware.wsgi import WSGIMiddleware

from assistant import Assistant, SYSTEM_PROMPT, CONTEXT_SEPARATOR, _smalltalk_response
from embedder import get_embedder
from llm_client import generate as llm_generate, LLM_BASE_URL, LLM_MODEL
import llm_client
import intent as intent_router
try:
    from osint_portal.app import app as osint_portal_app
except ModuleNotFoundError:          # sub-app not vendored in this repo
    osint_portal_app = None
from processor import MongoStreamProcessor, DocumentConverter
from chunker import TokenAwareChunker
import mongo_pool
import query_collections
from vector_store import VectorStore
import tenants
import views
import engine as rag_engine
import scan as scan_mod
import query_understanding as qu
from query_understanding import normalize as qu_normalize
import policy as policy_gate
import conversation as conv

load_dotenv()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("DB_NAME", "test")
VECTOR_COLLECTION = os.getenv("VECTOR_COLLECTION", "vector_embeddings")
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "100"))
CHUNK_MIN = int(os.getenv("CHUNK_MIN_TOKENS", "300"))
CHUNK_MAX = int(os.getenv("CHUNK_MAX_TOKENS", "800"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP_TOKENS", "50"))
TOP_K = int(os.getenv("TOP_K_RESULTS", "5"))

# --- Scheduler ---
INGEST_INTERVAL_HOURS = float(os.getenv("INGEST_INTERVAL_HOURS", "6"))
# Embedding a collection copies its text into a vector store the assistant
# searches, so the ingest list is filtered by the same floor as the query list.
# Both the code default ("contents,users") and this deployment's .env named
# `users`; the scheduler was only off by configuration, and turning it on would
# have embedded the account table. A deny-list in code cannot be turned on by
# accident.
INGEST_COLLECTIONS = [
    c for c in (x.strip() for x in
                os.getenv("INGEST_COLLECTIONS", "contents").split(","))
    if c and c.lower() not in query_collections.NEVER_SEARCHABLE
]
_INGEST_REFUSED = sorted({x.strip() for x in
                          os.getenv("INGEST_COLLECTIONS", "contents").split(",")
                          if x.strip() and x.strip().lower()
                          in query_collections.NEVER_SEARCHABLE})
SCHEDULER_ENABLED = os.getenv("INGEST_SCHEDULER_ENABLED", "true").lower() in ("1", "true", "yes")
INGEST_RUNS_COLLECTION = "rag_ingest_runs"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
)
logger = logging.getLogger("rag_api")

if _INGEST_REFUSED:
    logger.warning(
        "NOT embedding %d configured collection(s) that hold accounts, "
        "configuration or the audit trail: %s. Embedding them would copy their "
        "contents into a vector store the assistant searches.",
        len(_INGEST_REFUSED), ", ".join(_INGEST_REFUSED))

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="RAG Pipeline API", version="1.0.0")
# The caller is trusted to say who it is acting for (tenant, role, districts),
# so the caller must prove it is the backend. See service_auth.py.
from service_auth import install_service_auth  # noqa: E402
install_service_auth(app, "RAG_SERVICE_API_KEY", exempt=("/api/rag/health",), logger=logger)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Browser test console (static/index.html) — served from the API itself so it
# shares an origin and needs no separate web server.
_STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
if os.path.isdir(_STATIC_DIR):
    app.mount("/ui", StaticFiles(directory=_STATIC_DIR, html=True), name="ui")

    @app.get("/", include_in_schema=False)
    def _root_redirect():
        return RedirectResponse(url="/ui/")

if osint_portal_app is not None:
    app.mount("/osint", WSGIMiddleware(osint_portal_app))
else:
    logger.warning("osint_portal not installed — /osint not mounted.")

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class QueryRequest(BaseModel):
    question: str
    collection: str | None = None
    # The Node proxy always injects these; it 403s a caller without a tenant.
    tenant_id: str | None = None
    # SECOND-level isolation on top of tenant_id. Set to the caller's own
    # assigned districts for a District Officer, omitted (None) for a State
    # Admin - never both. When set, every Mongo read and vector search below
    # additionally excludes any other district's data.
    districts: List[str] | None = None
    top_k: int = 12
    # If set, restrict retrieval to source-doc ids whose timestamp falls within
    # the last N days. Default 7. Set to 0 / None to disable the window.
    time_window_days: int | None = 7
    # When False, skip MongoDB + vector retrieval entirely and answer the
    # question as a pure conversational LLM (general knowledge, casual chat).
    # The frontend toggles this with a "Use database" checkbox.
    use_db: bool = True


class IngestRequest(BaseModel):
    collection: str
    tenant_id: str | None = None
    # Re-embed and re-tag docs already embedded. Used to backfill
    # metadata.tenant_id / metadata.districts onto chunks ingested before
    # tagging existed. Default False keeps the cheap incremental behaviour.
    force: bool = False


# --------------------------------------------------------------------------- #
# multi-tenant + district boundary
#
# Ported from the pipeline this one supersedes. Two levels:
#   1. tenant_id  - a hard boundary; one tenant can never read another's data.
#   2. districts  - within a tenant, a District Officer sees only their own
#                   districts plus tenant-wide data.
#
# The distinction between districts=None and districts=[] is load-bearing and
# appears in every helper below. None means no district scoping was requested
# (State Admin). [] means a District Officer with ZERO districts assigned and
# must fail CLOSED. Both are falsy in Python, which is exactly how this gets
# broken; collapsing them hands a districtless officer the whole tenant.
# --------------------------------------------------------------------------- #

def _tenant_db(tenant_id: Optional[str]) -> str:
    """The database this request reads and writes.

    TENANT_DB_MODE is per-tenant: each tenant owns a database, and its vectors
    are written back into that same database. Resolution is authoritative --
    an unknown tenant raises rather than falling back to DB_NAME, because a
    fallback here is a cross-tenant read.
    """
    try:
        return tenants.resolve_db_name(_require_tenant(tenant_id))
    except tenants.TenantNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


def _tenant_client_db(tenant_id: Optional[str]):
    """(client, db) for the caller's tenant. The caller closes the client."""
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    return client, client[_tenant_db(tenant_id)]


def _tenant_filter(tenant_id: Optional[str]) -> dict:
    """Mongo fragment scoping a query to one tenant. Empty dict when there is
    no tenant_id, which should only ever happen on non-data/admin paths."""
    return {"tenant_id": tenant_id} if tenant_id else {}


def _with_district_scope(query: dict, districts: Optional[List[str]]) -> dict:
    """Merge a district clause into *query* (mutates and returns it) for
    collections carrying their OWN ``districts`` array - grievances, contents,
    pois, keywords, sources, templates, policymappings. A doc with no districts
    is tenant-wide and always visible; one WITH districts matches only on
    overlap.

    Merged under ``$and`` rather than a top-level ``$or`` key so it composes
    safely with a caller's existing ``$or`` (a handle or keyword search) instead
    of one clobbering the other.
    """
    if districts is None:
        return query
    if not districts:
        query["districts"] = {"$in": []}   # zero districts assigned - match nothing
        return query
    query.setdefault("$and", []).append({
        "$or": [
            {"districts": {"$in": districts}},
            {"districts": {"$exists": False}},
            {"districts": {"$size": 0}},
        ]
    })
    return query


def _require_tenant(tenant_id: Optional[str]) -> str:
    """Fail-closed tenant guard for data endpoints.

    The Node proxy always injects tenant_id, but this FastAPI binds 0.0.0.0, so
    a direct call could otherwise reach a data endpoint with no tenant and fall
    back to an empty filter - reading every tenant at once. Reject instead.
    """
    tid = (tenant_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="tenant_id is required (multi-tenant boundary)")
    return tid


def _scoped_source_ids(tenant_id: Optional[str], districts: Optional[List[str]]) -> Optional[List[str]]:
    """Source ``id``s visible to this scope, for collections (Alert) that link
    to a monitored profile by ``source_id`` but carry no districts of their own.

    Returns None when unrestricted (districts is None) - callers treat None as
    "do not filter". Returns [] for an officer with zero districts, which
    callers merge as ``{"$in": []}``: matching nothing rather than everything.
    """
    if districts is None:
        return None
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client[_tenant_db(tenant_id)]
        q = _with_district_scope(_tenant_filter(tenant_id), districts)
        ids = [d.get("id") for d in db["sources"].find(q, {"id": 1}) if d.get("id")]
        client.close()
        return ids
    except Exception as e:
        logger.warning("scoped source id resolution failed: %s", e)
        return []


def _scoped_grievance_ids(tenant_id: Optional[str], districts: Optional[List[str]]) -> Optional[List[str]]:
    """Grievance ``id``s visible to this scope, for the report collections that
    link by ``grievance_id`` and carry no districts of their own. Same None vs
    [] contract as _scoped_source_ids."""
    if districts is None:
        return None
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client[_tenant_db(tenant_id)]
        q = _with_district_scope(_tenant_filter(tenant_id), districts)
        ids = [d.get("id") for d in db["grievances"].find(q, {"id": 1}) if d.get("id")]
        client.close()
        return ids
    except Exception as e:
        logger.warning("scoped grievance id resolution failed: %s", e)
        return []


def _district_scope_key(districts: Optional[List[str]]) -> str:
    """Stable signature for a district scope, for shared cache keys. Without it
    a State Admin's whole-tenant cached run is served back to a District Officer
    asking for the cached version, or the reverse.

    None (admin) and [] (officer with zero districts) get deliberately distinct
    keys: they are different scopes and must never share an entry.
    """
    if districts is None:
        return "admin"
    return ",".join(sorted(districts)) if districts else "__none__"


# Collections with no districts of their own, which inherit them from a parent.
_INGEST_LINK_FIELDS = {
    "alerts": ("source_id", "sources"),
    "criticismreports": ("grievance_id", "grievances"),
    "suggestionreports": ("grievance_id", "grievances"),
    "grievanceworkflowreports": ("grievance_id", "grievances"),
    "queryreports": ("grievance_id", "grievances"),
}


def _resolve_ingest_link_districts(collection: str, tenant_id: Optional[str]):
    """Bulk-fetch {parent_id: districts} once for a linked collection.
    Returns (link_field, id_to_districts) or (None, None) when the collection
    carries its own districts, or none at all (tenant-wide by design)."""
    entry = _INGEST_LINK_FIELDS.get(collection)
    if not entry:
        return None, None
    link_field, parent_collection = entry
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client[_tenant_db(tenant_id)]
        q = {"tenant_id": tenant_id} if tenant_id else {}
        id_map = {
            d.get("id"): d.get("districts", [])
            for d in db[parent_collection].find(q, {"id": 1, "districts": 1})
            if d.get("id")
        }
        client.close()
        logger.info(
            "Ingest link-districts resolved: %s -> %s via %s (%d parents mapped)",
            collection, parent_collection, link_field, len(id_map),
        )
        return link_field, id_map
    except Exception as e:
        logger.warning("Ingest link-districts resolution failed for %s: %s", collection, e)
        return link_field, {}


# Common timestamp field names found across the BluraSaga collections.
TIMESTAMP_FIELDS = (
    "createdAt", "created_at", "publishedAt", "published_at",
    "timestamp", "ts", "date", "scrapedAt", "fetchedAt", "postedAt",
)


def _allow_ids_within_window(collection: str, days: int, tenant_id: Optional[str] = None) -> Optional[set]:
    """Return a set of stringified _id values whose timestamp is within the
    last *days* days. Returns None if no timestamp field can be detected
    (caller should treat None as "no filter")."""
    if not days or days <= 0:
        return None
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client[_tenant_db(tenant_id)]
        if collection not in db.list_collection_names():
            client.close()
            return set()
        col = db[collection]
        sample = col.find_one({}, sort=[("_id", DESCENDING)]) or {}
        ts_field = next((f for f in TIMESTAMP_FIELDS if f in sample), None)
        if not ts_field:
            client.close()
            return None  # cannot filter — fall back to no-window
        cur = col.find({ts_field: {"$gte": cutoff}}, {"_id": 1}).limit(50000)
        ids = {str(d["_id"]) for d in cur}
        client.close()
        return ids
    except Exception as e:
        logger.warning("time-window filter failed for '%s': %s", collection, e)
        return None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/rag/health")
def health():
    """Check MongoDB, the embedding host and the LLM endpoint."""
    status = {"mongodb": False, "embedding": False, "llm": False}
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        client.admin.command("ping")
        status["mongodb"] = True
        client.close()
    except Exception as e:
        logger.error("MongoDB health check failed: %s", e)

    embedding = get_embedder().probe()
    status["embedding"] = embedding["healthy"]

    import llm_client
    status["llm"] = llm_client.check_health()

    overall = all(status.values())
    return {
        "healthy": overall,
        "services": status,
        # Explicit model + dimension so a mismatch is visible, not inferred.
        "embedding": {
            "status": "HEALTHY" if embedding["healthy"] else "UNHEALTHY",
            "warmup": _EMBED_WARMUP.get("ok"),
            "warmup_error": _EMBED_WARMUP.get("error"),
            "downloaded_on_start": _EMBED_WARMUP.get("downloaded"),
            "cache_path": _EMBED_WARMUP.get("cache_path"),
            "device": embedding.get("device"),
            "model": embedding["model"],
            "dimension": embedding["dimension"],
            "expected_dimension": embedding["expected_dimension"],
            "endpoint": embedding["endpoint"],
            "error": embedding["error"],
        },
        "llm": {
            "status": "HEALTHY" if status["llm"] else "UNHEALTHY",
            "model": llm_client.LLM_MODEL,
            "endpoint": llm_client.LLM_BASE_URL,
        },
    }


@app.get("/api/rag/collections")
def list_collections(tenant_id: Optional[str] = None):
    """Return all collection names in the configured database."""
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client[_tenant_db(tenant_id)]
        names = db.list_collection_names()
        client.close()
        # Filter out system and vector collections
        skip = {"system.profile", "system.js", VECTOR_COLLECTION}
        collections = sorted([n for n in names if n not in skip])
        return {"database": _tenant_db(tenant_id), "collections": collections}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Filled in by the startup warm-up thread; surfaced via /api/rag/health.
_EMBED_WARMUP: dict = {"ok": None, "error": None}

# (database, vector collection) -> warm VectorStore, least-recently-used first.
_GLOBAL_STORES: "OrderedDict[tuple, VectorStore]" = OrderedDict()
_GLOBAL_STORES_LOCK = threading.Lock()


# How many warm stores to keep across all tenants. Each holds a numpy array of
# its collection's vectors, so this is the memory ceiling for retrieval.
MAX_WARM_STORES = max(4, int(os.getenv("RAG_MAX_WARM_STORES", "24")))


def _get_store(vec_col: str, db_name: str) -> VectorStore:
    """A VectorStore for one collection inside ONE tenant's database.

    Keyed by (database, collection): keying on the collection alone would hand
    tenant B the store -- and the warm cache -- that tenant A populated.

    Least-recently-used stores are evicted so a deployment with many tenants
    does not hold every tenant's vectors in memory at once.
    """
    key = (db_name, vec_col)
    with _GLOBAL_STORES_LOCK:
        s = _GLOBAL_STORES.get(key)
        if s is not None:
            _GLOBAL_STORES.move_to_end(key)
            return s

        s = VectorStore(uri=MONGODB_URI, db_name=db_name, collection_name=vec_col)
        _GLOBAL_STORES[key] = s

        while len(_GLOBAL_STORES) > MAX_WARM_STORES:
            _, evicted = _GLOBAL_STORES.popitem(last=False)
            try:
                evicted.close()
            except Exception:
                pass
        return s


#: Which vector collections each tenant database has, briefly remembered.
#: Short, because a newly ingested collection should become searchable without
#: a restart; long enough that it is not a round trip per request.
_VECTOR_COLLECTIONS_CACHE: Dict[str, tuple] = {}
_VECTOR_COLLECTIONS_TTL_S = float(os.getenv("AI_VECTOR_COLLECTIONS_TTL_S", "60"))


def _list_vector_collections(db_name: str) -> list:
    """Return all vector collections the chatbot is permitted to search.

    Officers ask about every module in the portal — events, alerts, grievances,
    Dial 100 calls, POIs, monitored profiles, keywords, contents, daily
    programmes, telegram messages, and the reporting collections — so the
    allow-list is intentionally broad. Override via ALLOWED_QUERY_COLLECTIONS.
    """
    allowed = {f"{VECTOR_COLLECTION}_{c}" for c in ALLOWED_QUERY_COLLECTIONS}
    cached = _VECTOR_COLLECTIONS_CACHE.get(db_name)
    if cached is not None and time.monotonic() - cached[1] < _VECTOR_COLLECTIONS_TTL_S:
        return list(cached[0])
    # Was a fresh MongoClient per call, opened and closed on the request path:
    # ~800 ms of handshake for an answer that changes when someone adds a
    # collection. Pooled, and remembered for a short interval.
    existing = set(mongo_pool.database(MONGODB_URI, db_name).list_collection_names())
    names = [c for c in sorted(allowed) if c in existing]
    _VECTOR_COLLECTIONS_CACHE[db_name] = (names, time.monotonic())
    return list(names)


_COUNT_KEYWORDS = {
    "alerts":                      ["alert", "alerts"],
    "grievances":                  ["grievance", "grievances", "greivance", "greivances",
                                    "complaint", "complaints"],
    "events":                      ["event", "events", "festival", "festivals", "rally", "rallies",
                                    "protest", "protests", "procession", "processions"],
    "dial100incidents":            ["dial 100", "dial-100", "dial100", "100 call", "100 calls",
                                    "emergency call", "emergency calls", "incident", "incidents"],
    "pois":                        ["poi", "pois", "person of interest", "persons of interest",
                                    "suspect", "suspects", "history sheeter", "history-sheeter",
                                    "history sheeters", "accused"],
    "keywords":                    ["keyword", "keywords", "watch word", "watch words",
                                    "watchword", "watchwords", "monitored word", "monitored words",
                                    "top keyword", "top keywords"],
    "sources":                     ["source", "sources", "monitored profile", "monitored profiles",
                                    "monitored account", "monitored accounts",
                                    "tracked account", "tracked accounts", "tracked profile",
                                    "tracked profiles"],
    "contents":                    ["content", "contents", "post", "posts", "tweet", "tweets",
                                    "reel", "reels", "story", "stories", "video", "videos"],
    "dailyprogrammes":             ["programme", "programmes", "program", "programs",
                                    "daily programme", "daily programmes", "schedule", "schedules"],
    "telegrammessages":            ["telegram", "telegram message", "telegram messages",
                                    "tg message", "tg messages", "telegram group", "telegram channel"],
    "criticism_reports":           ["criticism", "critique", "critisism", "critisisum",
                                    "criticsm", "critisim", "criticisim", "criticisms",
                                    "criticism report", "criticism reports"],
    "grievance_workflow_reports":  ["workflow report", "grievance workflow"],
    "query_reports":               ["query report", "query reports"],
    "suggestion_reports":          ["suggestion report", "suggestion reports"],
}

_COUNT_TIME_PATTERNS = [
    (re.compile(r"past\s+(\d+)\s*(hour|hr|h)s?", re.I),  lambda m: timedelta(hours=int(m.group(1)))),
    (re.compile(r"last\s+(\d+)\s*(hour|hr|h)s?", re.I),  lambda m: timedelta(hours=int(m.group(1)))),
    (re.compile(r"past\s+(\d+)\s*(day|d)s?", re.I),      lambda m: timedelta(days=int(m.group(1)))),
    (re.compile(r"last\s+(\d+)\s*(day|d)s?", re.I),      lambda m: timedelta(days=int(m.group(1)))),
    (re.compile(r"past\s+(\d+)\s*(week|wk)s?", re.I),    lambda m: timedelta(weeks=int(m.group(1)))),
    (re.compile(r"last\s+(\d+)\s*(week|wk)s?", re.I),    lambda m: timedelta(weeks=int(m.group(1)))),
    (re.compile(r"yesterday", re.I),                     lambda m: timedelta(days=1)),
    (re.compile(r"today", re.I),                         lambda m: timedelta(hours=24)),
    (re.compile(r"this\s+week", re.I),                   lambda m: timedelta(days=7)),
]


# Qualifiers a count question can carry ("how many HIGH alerts", "how many
# ESCALATED grievances"). Without these the count ignored every adjective in
# the question and reported the collection total instead, so "how many high
# alerts" answered 130,356 when the real figure was 17,857.
#
# Each entry is (pattern, mongo clause, label shown to the user). Order
# matters: the most specific phrasing has to be tried first, which is why
# "high priority" precedes the bare "high".
#
# `priority` and `risk_level` are DIFFERENT fields here and they disagree:
# 13,039 docs are priority=LOW but risk_level=high, and no document with a
# "HIGH Risk" title has priority=HIGH. Alert titles are generated from
# risk_level, so that is what an officer reading the portal means by "high
# alert". "High priority" is matched separately and the two are never merged.
_COUNT_FILTERS: dict = {
    "alerts": [
        (r"\bhigh\s+priorit(y|ies)\b|\bpriority\s*[:=]?\s*high\b",
         {"priority": "HIGH"}, "priority=HIGH"),
        (r"\bmedium\s+priorit(y|ies)\b|\bpriority\s*[:=]?\s*medium\b",
         {"priority": "MEDIUM"}, "priority=MEDIUM"),
        (r"\blow\s+priorit(y|ies)\b|\bpriority\s*[:=]?\s*low\b",
         {"priority": "LOW"}, "priority=LOW"),
        (r"\b(high|critical|severe)(\s+(risk|severity|level))?\b",
         {"risk_level": "high"}, "risk_level=high"),
        (r"\bmedium(\s+(risk|severity|level))?\b|\bmoderate\b",
         {"risk_level": "medium"}, "risk_level=medium"),
        (r"\blow(\s+(risk|severity|level))?\b",
         {"risk_level": "low"}, "risk_level=low"),
        (r"\bunread\b", {"is_read": False}, "is_read=false"),
        (r"\backnowledged\b", {"status": "acknowledged"}, "status=acknowledged"),
        (r"\bescalated\b", {"status": "escalated"}, "status=escalated"),
        (r"\bfalse\s+positives?\b", {"status": "false_positive"},
         "status=false_positive"),
        (r"\bactive\b|\bopen\b|\bunresolved\b", {"status": "active"},
         "status=active"),
        (r"\bunder\s+investigation\b|\binvestigations?\b",
         {"is_investigation": True}, "is_investigation=true"),
        (r"\b(twitter|x\.com)\b", {"platform": "x"}, "platform=x"),
        (r"\binstagram\b|\binsta\b", {"platform": "instagram"},
         "platform=instagram"),
        (r"\byoutube\b", {"platform": "youtube"}, "platform=youtube"),
        (r"\bfacebook\b|\bfb\b", {"platform": "facebook"}, "platform=facebook"),
        (r"\bai\s*[-_]?\s*risk\b", {"alert_type": "ai_risk"},
         "alert_type=ai_risk"),
        (r"\bvelocity\b", {"alert_type": "velocity"}, "alert_type=velocity"),
        (r"\bkeyword\s*[-_]?\s*risk\b", {"alert_type": "keyword_risk"},
         "alert_type=keyword_risk"),
    ],
}

# Words that carry no filtering meaning, so their presence must not trigger
# the "could not interpret" caveat below.
_COUNT_FILLER = frozenset("""
a an the how many much count number total there is are was were do does did
of in on at for from by with to and or not no me us i you we show tell give
list please currently right now over during within between all any each
some whats what which who whose why when where have has had been being
post posts posting record records row rows entry entries item items
doc docs document documents thing things data database db collection
collections so far up till until as per about regarding across overall
altogether alert alerts
""".split())


def _extract_count_filters(q: str, target_col: str, consumed: str) -> tuple:
    """Turn the qualifiers in a count question into a Mongo filter.

    Returns (clauses, labels, unknown_terms). *consumed* is the text already
    accounted for -- the matched collection keyword and the time phrase -- and
    is removed before scanning for leftovers, so only genuinely uninterpreted
    words land in unknown_terms.
    """
    clauses: dict = {}
    labels: list = []
    remaining = " %s " % q
    for token in consumed.lower().split():
        remaining = remaining.replace(token, " ")
    # Every way of naming this collection is part of the question's subject,
    # not a qualifier: "how many dial 100 incidents" matched on "incidents",
    # which would otherwise leave "dial" looking uninterpreted.
    for kw in sorted(_COUNT_KEYWORDS.get(target_col, []), key=len, reverse=True):
        remaining = re.sub(r"\b%s\b" % re.escape(kw), " ", remaining, flags=re.I)
    for pattern, clause, label in _COUNT_FILTERS.get(target_col, []):
        # A field already pinned by a more specific phrase wins: "high
        # priority" must not then also be read as risk_level=high.
        if any(k in clauses for k in clause):
            continue
        m = re.search(pattern, remaining, re.I)
        if not m:
            continue
        clauses.update(clause)
        labels.append(label)
        remaining = remaining[:m.start()] + " " + remaining[m.end():]
    # Removing whole phrases can still leave a fragment of the collection's
    # own name ("dial 100 calls" matches "100 calls", leaving "dial"), so any
    # word used in any of its keywords counts as subject, not qualifier.
    subject = {t for kw in _COUNT_KEYWORDS.get(target_col, [])
               for t in kw.lower().split()}
    unknown = [w for w in re.findall(r"[a-z][a-z0-9_'-]{2,}", remaining.lower())
               if w not in _COUNT_FILLER and w not in subject]
    return clauses, labels, unknown


def _count_noun(kw: str, n: int) -> str:
    """Agree the matched keyword with the number in front of it.

    The keyword is whatever the question happened to use, so "how many high
    alert posts" matched the singular and read as "17,857 alert". Only simple
    one-word keywords are touched; multi-word ones like "dial 100" are left
    exactly as matched.
    """
    if n == 1 or " " in kw or kw.endswith("s"):
        return kw
    return kw + ("ies" if kw.endswith("y") and kw[-2:-1] not in "aeiou" else "s")


def _count_fast_path(question: str, default_window_days: Optional[int],
                     tenant_id: Optional[str] = None,
                     districts: Optional[List[str]] = None) -> Optional[dict]:
    """Detect 'how many <thing> in last N days/hours' and answer with a real Mongo count.
    Returns None if the question doesn't fit the count template."""
    q = question.lower().strip()
    if not re.search(r"\bhow\s+many\b|\bcount\b|\bnumber\s+of\b|\btotal\s+(number\s+of\s+)?\b", q):
        return None
    target_col = None
    matched_kw = None
    for col, kws in _COUNT_KEYWORDS.items():
        for kw in sorted(kws, key=len, reverse=True):
            if re.search(rf"\b{re.escape(kw)}\b", q):
                target_col = col; matched_kw = kw; break
        if target_col: break
    if not target_col:
        return None

    delta = None
    matched_phrase = None
    for pat, mk in _COUNT_TIME_PATTERNS:
        m = pat.search(q)
        if m:
            delta = mk(m); matched_phrase = m.group(0); break
    if delta is None and default_window_days and default_window_days > 0:
        delta = timedelta(days=default_window_days)
        matched_phrase = f"last {default_window_days} day(s)"

    filters, labels, unknown = _extract_count_filters(
        q, target_col, "%s %s" % (matched_kw, matched_phrase or ""))

    # Scope the count. Alerts carry no districts of their own and inherit them
    # from the monitored profile; the report kinds inherit from their
    # grievance; everything else carries its own districts array.
    filters.update(_tenant_filter(tenant_id))
    if target_col == "alerts":
        ids = _scoped_source_ids(tenant_id, districts)
        if ids is not None:
            filters["source_id"] = {"$in": ids}
    elif target_col in ("criticismreports", "suggestionreports",
                        "grievanceworkflowreports", "queryreports"):
        ids = _scoped_grievance_ids(tenant_id, districts)
        if ids is not None:
            filters["grievance_id"] = {"$in": ids}
    else:
        _with_district_scope(filters, districts)
    # An exact count that silently drops a qualifier reads as an answer to a
    # question it did not answer, so say plainly what was not applied.
    caveat = ""
    if unknown:
        caveat = ("\n\n_Not applied to this count: %s — no matching field is "
                  "known for it, so the figure above ignores that part of the "
                  "question._" % ", ".join("`%s`" % w for w in unknown[:6]))
    described = (" matching %s" % ", ".join("`%s`" % l for l in labels)) if labels else ""

    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client[_tenant_db(tenant_id)]
        if target_col not in db.list_collection_names():
            client.close()
            return {"answer": f"The `{target_col}` collection isn't present in the database.",
                    "sources": [], "question": question, "scope": "count"}
        col = db[target_col]
        if delta is None:
            # estimated_document_count() ignores a filter, so it is only valid
            # for the unfiltered total.
            total = (col.count_documents(filters) if filters
                     else col.estimated_document_count())
            client.close()
            return {
                "answer": (f"**{total:,}** {_count_noun(matched_kw, total)}{described} in total "
                           f"(all time) in `{target_col}`.{caveat}"),
                "sources": [], "question": question, "scope": "count",
                "count": total, "collection": target_col,
                "filters": filters or None,
            }
        cutoff = datetime.now(timezone.utc) - delta
        sample = col.find_one({}, sort=[("_id", DESCENDING)]) or {}
        ts_field = next((f for f in TIMESTAMP_FIELDS if f in sample), None)
        if not ts_field:
            client.close()
            return None  # fall back to vector search
        query = dict(filters)
        query[ts_field] = {"$gte": cutoff}
        n = col.count_documents(query)
        client.close()
        nice_window = matched_phrase
        return {
            "answer": (
                f"**Bottom line:** {n:,} {_count_noun(matched_kw, n)}{described} in `{target_col}` "
                f"over the {nice_window}.\n\n"
                f"_(Counted via field `{ts_field}`, cutoff {cutoff.isoformat(timespec='minutes')} UTC.)_"
                f"{caveat}"
            ),
            "sources": [], "question": question, "scope": "count",
            "count": n, "collection": target_col, "window": nice_window,
            "filters": filters or None,
        }
    except Exception as e:
        logger.warning("count fast-path failed: %s", e)
        return None


def _shrink_prompt(prompt: str, target_ctx: int) -> str:
    """Trim the middle of an oversized prompt so it fits a smaller context."""
    approx_chars = max(2000, target_ctx * 3)  # ~3 chars per token, conservative
    if len(prompt) <= approx_chars:
        return prompt
    head = prompt[: approx_chars // 2]
    tail = prompt[-approx_chars // 2:]
    return head + "\n\n[…context truncated for retry…]\n\n" + tail


def _llm_answer(prompt: str) -> str:
    """Generate an answer on the configured LLM endpoint (see llm_client.py).

    Retries, context fitting and error formatting live in llm_client; on
    terminal failure this returns a marked "_(...)_" string so callers can
    still surface the retrieved MongoDB evidence to the user.
    """
    return llm_generate(prompt, temperature=0.2, top_p=0.9, max_tokens=2048)


_URL_RE = re.compile(r"https?://[^\s)\]]+")


CHAT_ONLY_SYSTEM_PROMPT = textwrap.dedent("""\
    You are the AI Assistant, friendly and highly capable — versatile like
    Claude or ChatGPT. In this mode you are NOT querying any internal database.
    Answer the user from general knowledge, help with casual conversation,
    explain concepts, draft text, do reasoning, write code, summarise topics,
    and provide opinions when asked.

    Style guide:
      • Be warm and natural for casual chat ("hi", "thanks", "how are you").
      • Be detailed and well-structured for substantive questions — use
        headings, bullets, code blocks, and examples where they help.
      • Use Markdown formatting. Bold key terms. Code-format `commands`.
      • If the user asks something that would clearly benefit from the live
        Telangana Police database (specific alerts, grievances, POIs, recent
        events, monitored handles, Dial-100 calls), gently note:
        _"Tip: enable 'Use database' to query the live data."_
      • Never claim to have looked up live data in this mode — you haven't.
      • Knowledge cutoff applies; flag uncertainty rather than inventing facts.
      • Aim for thorough answers (10+ lines) on real questions; keep small-talk
        replies short and friendly.
""")


def _chat_only_answer(question: str) -> dict:
    """Pure LLM call — no DB, no vector search. For casual / general questions."""
    verdict = intent_router.classify(question)
    if verdict.intent is intent_router.Intent.GREETING:
        return {"answer": intent_router.greeting_answer(question), "sources": [],
                "question": question, "smalltalk": True, "scope": "chat_only",
                "intent": verdict.intent.value, "rag_used": False}
    if verdict.intent is intent_router.Intent.CAPABILITY:
        return {"answer": intent_router.CAPABILITY_ANSWER, "sources": [],
                "question": question, "scope": "chat_only",
                "intent": verdict.intent.value, "rag_used": False}
    prompt = (
        f"{CHAT_ONLY_SYSTEM_PROMPT}\n\n"
        f"User: {question}\n\n"
        f"Assistant:"
    )
    answer = _llm_answer(prompt)
    return {"answer": answer, "sources": [], "question": question,
            "scope": "chat_only", "use_db": False}


def _ensure_minimum_answer(answer: str, snippets: list, question: str) -> str:
    """Guarantee the user always sees ≥10 lines of useful content with links.

    If the LLM returned a short answer, an error message, or omitted links,
    append a deterministic 'Evidence' section built from the retrieved
    snippets so officers always have the URLs to act on.
    """
    answer = (answer or "").strip()
    # Only rescue a genuinely failed generation. Padding short answers used to
    # force a 10-line briefing even when the context did not support one, which
    # is exactly the hallucination pressure the intent router removes.
    needs_evidence = (
        not answer
        or answer.startswith("_(LLM generation failed")
        or answer.startswith("_(Error generating answer")
        or "Error generating answer" in answer
    )
    if not needs_evidence or not snippets:
        return answer

    evidence_lines = ["", "---", "", "### Evidence from live database"]
    for s in snippets[:12]:
        # Pull the first URL from the snippet, if any
        m = _URL_RE.search(s)
        url = m.group(0) if m else ""
        # Take just the header line (before the first newline) for the bullet
        head = s.split("\n", 1)[0].strip()
        if url:
            evidence_lines.append(f"- {head} — [Open]({url})")
        else:
            evidence_lines.append(f"- {head}")
    evidence_lines.append("")
    evidence_lines.append(
        "_Tip: try a more specific question (handle, date range, district) "
        "for a sharper briefing._"
    )
    return answer + "\n" + "\n".join(evidence_lines)


# ---------------------------------------------------------------------------
# Universal DB context builder
#
# For EVERY non-count question we pull a rich context directly from Mongo
# (alerts + grievances), apply the time window, then optionally enrich with
# vector-search results if embeddings exist.  This means the bot always has
# real data regardless of whether ingestion has caught up.
# ---------------------------------------------------------------------------

ALERT_FIELDS = {
    "_id": 1, "id": 1, "title": 1, "platform": 1, "author": 1, "author_handle": 1,
    "content_url": 1, "risk_level": 1, "priority": 1, "alert_type": 1,
    "source_category": 1, "legal_sections": 1, "violated_policies": 1,
    "matched_keywords_normalized": 1, "classification_explanation": 1,
    "velocity_data": 1, "llm_analysis": 1, "threat_details": 1,
    "content_id": 1, "created_at": 1,
}
GRIEVANCE_FIELDS = {
    "_id": 1, "complaint_code": 1, "platform": 1, "posted_by": 1,
    "content": 1, "context": 1, "tagged_account": 1, "status": 1,
    "priority": 1, "created_at": 1,
}


def _safe_join(items) -> str:
    """Join a list that may contain strings or dicts (extract meaningful text)."""
    if not items:
        return "—"
    parts = []
    for it in items:
        if isinstance(it, str):
            parts.append(it)
        elif isinstance(it, dict):
            # common keys: 'section', 'name', 'description', 'policy', 'value'
            val = it.get("section") or it.get("name") or it.get("policy") or it.get("description") or str(it)
            parts.append(str(val))
        else:
            parts.append(str(it))
    return ", ".join(parts) if parts else "—"


def _fmt_alert(d: dict, idx: int) -> str:
    """Format an alert document into a rich text snippet for the LLM."""
    ts = d.get("created_at")
    ts_s = ts.strftime("%d-%b %H:%M IST") if isinstance(ts, datetime) else "?"
    handle = (d.get("author_handle") or d.get("author") or "?").lstrip("@")
    vdata = d.get("velocity_data") or {}
    llm = d.get("llm_analysis") or {}
    threat = d.get("threat_details") or {}
    legal = _safe_join(d.get("legal_sections"))
    policies = _safe_join(d.get("violated_policies"))
    kw = _safe_join(d.get("matched_keywords_normalized"))
    # Use the real AI reasoning if available
    reasoning = (d.get("classification_explanation") or llm.get("reasoning") or "").strip()
    if "Primary AI analysis unavailable" in reasoning:
        reasoning = ""
    risk_score = threat.get("risk_score") or llm.get("score") or "?"
    velocity_info = (
        f"Viral: {vdata.get('metric','?')} velocity={vdata.get('velocity','?')} "
        f"(threshold={vdata.get('threshold_triggered','?')}, window={vdata.get('time_window_minutes','?')}min)"
        if vdata else ""
    )
    return (
        f"[ALERT {idx} | {d.get('priority','?')}-risk | cat={d.get('source_category','?')} | "
        f"type={d.get('alert_type','?')} | {ts_s}]\n"
        f"  Author: @{handle} on {d.get('platform','?')}\n"
        f"  URL: {d.get('content_url','—')}\n"
        f"  Risk Score: {risk_score}% | Sentiment: {llm.get('sentiment','?')} | "
        f"Intent: {llm.get('intent') or llm.get('category','?')}\n"
        + (f"  {velocity_info}\n" if velocity_info else "")
        + (f"  Analysis: {reasoning[:300]}\n" if reasoning else "")
        + f"  Keywords: {kw} | Policies: {policies} | Legal sections: {legal}"
    )


def _fmt_grievance(d: dict, idx: int) -> str:
    """Format a grievance document — includes the actual tweet text."""
    ts = d.get("created_at")
    ts_s = ts.strftime("%d-%b %H:%M IST") if isinstance(ts, datetime) else "?"
    pb = d.get("posted_by") or {}
    handle = pb.get("handle") or "?"
    followers = pb.get("follower_count", "?")
    tweet_text = (d.get("content") or {}).get("text") or "—"
    # Original tweet this is replying to
    parent = ((d.get("context") or {}).get("in_reply_to") or {})
    parent_handle = (parent.get("posted_by") or {}).get("handle") or ""
    parent_text = (parent.get("content") or {}).get("text") or ""
    return (
        f"[GRIEVANCE {idx} | code={d.get('complaint_code','?')} | "
        f"status={d.get('status','?')} | {ts_s}]\n"
        f"  Filed by: @{handle} (followers={followers}) on {d.get('platform','?')}\n"
        f"  Tagged: {d.get('tagged_account','—')}\n"
        f"  Tweet: \"{tweet_text[:250]}\"\n"
        + (f"  Replying to @{parent_handle}: \"{parent_text[:200]}\"\n" if parent_text else "")
    )

# Keyword → Mongo field:value filters for smarter retrieval
_CATEGORY_HINTS = [
    (re.compile(r"\bcommunal\b", re.I),          {"source_category": "communal"}),
    (re.compile(r"\bhate.speech\b", re.I),        {"alert_type": {"$regex": "hate", "$options": "i"}}),
    (re.compile(r"\bviral\b", re.I),              {"risk_level": "high"}),
    (re.compile(r"\bviolence\b", re.I),           {"source_category": {"$regex": "violen", "$options": "i"}}),
    (re.compile(r"\bfake.news|misinform\b", re.I),{"alert_type": {"$regex": "fake|misinfo", "$options": "i"}}),
    (re.compile(r"\bfir\b|\blegal\b|\bbnS\b", re.I), {"legal_sections": {"$ne": []}}),
    (re.compile(r"\bopen|pending\b", re.I),       {"status": {"$in": ["open", "pending"]}}),
    (re.compile(r"\bhigh.?risk|urgent|critical\b", re.I), {"priority": "HIGH"}),
    (re.compile(r"\bmedium\b", re.I),             {"priority": "MEDIUM"}),
]

# ---------------------------------------------------------------------------
# Relevance filtering for the DB-recency pull
#
# _CATEGORY_HINTS above only covers ~9 fixed phrasings. Every other question
# ("potholes", "political rally", "telegram messages", ...) fell through to
# an unfiltered "most recent HIGH/MEDIUM alerts" query, so the SAME handful of
# recent alerts appeared as context/sources regardless of what was asked —
# they then tied with genuine vector hits in the RRF fusion below and rode
# along into the answer. _extract_relevance_terms + _relevance_or_clause keep
# that recency pull on-topic by requiring the question's own content words to
# appear somewhere in the candidate record; the unfiltered pull remains as a
# fallback only when nothing on-topic exists, so a broad or truly generic
# question still gets real data instead of an empty context block.
# ---------------------------------------------------------------------------
_RELEVANCE_STOPWORDS = _COUNT_FILLER | frozenset(
    "recent latest current please related relating".split()
)


def _extract_relevance_terms(question: str) -> list:
    """Meaningful content words from the question (order-preserved, deduped)."""
    seen: list = []
    for w in re.findall(r"[a-zA-Z][a-zA-Z0-9_'-]{2,}", question.lower()):
        if w in _RELEVANCE_STOPWORDS or w in seen:
            continue
        seen.append(w)
    return seen


ALERT_RELEVANCE_FIELDS = [
    "title", "source_category", "alert_type", "classification_explanation",
    "matched_keywords_normalized", "author_handle", "author",
]
GRIEVANCE_RELEVANCE_FIELDS = [
    "content.text", "context.in_reply_to.content.text", "tagged_account",
    "posted_by.handle", "complaint_code",
]


def _relevance_or_clause(terms: list, fields: list) -> Optional[dict]:
    """`$or` regex clause matching any *fields* against any *terms*, or None."""
    if not terms:
        return None
    term_re = "|".join(re.escape(t) for t in terms[:12])  # cap — very long questions
    return {"$or": [{f: {"$regex": term_re, "$options": "i"}} for f in fields]}


# ---------------------------------------------------------------------------
# Field projections & formatters for ALL additional modules
# ---------------------------------------------------------------------------

CONTENT_FIELDS = {
    "_id": 1, "platform": 1, "content_type": 1, "content_url": 1,
    "text": 1, "author": 1, "author_handle": 1, "risk_score": 1,
    "risk_level": 1, "sentiment": 1, "engagement": 1, "published_at": 1,
    "threat_intent": 1, "threat_reasons": 1, "event_ids": 1,
}
DIAL100_FIELDS = {
    "_id": 1, "date": 1, "category": 1, "incidentDetails": 1,
    "incidentCategory": 1, "location": 1, "psJurisdiction": 1,
    "zoneJurisdiction": 1, "callerName": 1, "status": 1, "priority": 1,
    "remarks": 1, "pcRemarks": 1, "shoRemarks": 1, "createdAt": 1,
}
EVENT_FIELDS = {
    "_id": 1, "name": 1, "description": 1, "start_date": 1, "end_date": 1,
    "location": 1, "keywords": 1, "platforms": 1, "status": 1, "created_at": 1,
}
POI_FIELDS = {
    "_id": 1, "name": 1, "realName": 1, "aliasNames": 1,
    "mobileNumbers": 1, "currentAddress": 1,
    "psLimits": 1, "districtCommisionerate": 1, "firDetails": 1,
    "linkedIncidents": 1, "created_at": 1,
}
KEYWORD_FIELDS = {
    "_id": 1, "keyword": 1, "category": 1, "language": 1,
    "is_active": 1, "weight": 1, "created_at": 1,
}
SOURCE_FIELDS = {
    "_id": 1, "platform": 1, "identifier": 1, "display_name": 1,
    "category": 1, "is_active": 1, "risk_level": 1, "created_at": 1,
    "follower_count": 1, "profile_image_url": 1, "is_verified": 1,
    "platform_user_id": 1,
}


def _build_profile_url(platform: str, identifier: str, platform_user_id: str = "") -> str:
    """Build a public profile URL from a monitored source's platform + handle."""
    if not identifier:
        return ""
    handle = str(identifier).lstrip("@").strip()
    if not handle:
        return ""
    p = (platform or "").lower()
    if p == "x" or p == "twitter":
        return f"https://x.com/{handle}"
    if p == "instagram":
        return f"https://www.instagram.com/{handle}/"
    if p == "facebook":
        return f"https://www.facebook.com/{handle}"
    if p == "youtube":
        # YouTube channels can be addressed via @handle (newer) or channel ID
        if platform_user_id and platform_user_id.startswith("UC"):
            return f"https://www.youtube.com/channel/{platform_user_id}"
        return f"https://www.youtube.com/@{handle}"
    return ""
DAILY_PROGRAMME_FIELDS = {
    "_id": 1, "date": 1, "category": 1, "categoryLabel": 1,
    "programName": 1, "location": 1, "organizer": 1,
    "expectedMembers": 1, "zone": 1,
}
TELEGRAM_FIELDS = {
    "_id": 1, "text": 1, "sender_name": 1, "sender_username": 1,
    "date": 1, "group_id": 1, "links": 1,
}
CRITICISM_REPORT_FIELDS = {
    "_id": 1, "unique_code": 1, "platform": 1, "post_link": 1,
    "post_description": 1, "post_date": 1, "posted_by": 1,
    "category": 1, "remarks": 1, "status": 1, "createdAt": 1,
}
SUGGESTION_REPORT_FIELDS = {
    "_id": 1, "unique_code": 1, "platform": 1, "post_link": 1,
    "post_description": 1, "post_date": 1, "posted_by": 1,
    "category": 1, "remarks": 1, "status": 1, "createdAt": 1,
}


def _fmt_content(d: dict, idx: int) -> str:
    ts = d.get("published_at") or d.get("created_at")
    ts_s = ts.strftime("%d-%b %H:%M IST") if isinstance(ts, datetime) else "?"
    eng = d.get("engagement") or {}
    text = (d.get("text") or "")[:250]
    return (
        f"[CONTENT {idx} | {d.get('platform','?')} | type={d.get('content_type','?')} | "
        f"risk={d.get('risk_level','?')} | {ts_s}]\n"
        f"  Author: @{d.get('author_handle','?')} | URL: {d.get('content_url','—')}\n"
        f"  Text: \"{text}\"\n"
        f"  Engagement: views={eng.get('views',0)} likes={eng.get('likes',0)} "
        f"comments={eng.get('comments',0)} retweets={eng.get('retweets',0)} | "
        f"Sentiment: {d.get('sentiment','?')} | Risk Score: {d.get('risk_score',0)}%"
    )


def _fmt_dial100(d: dict, idx: int) -> str:
    ts = d.get("date") or d.get("createdAt")
    ts_s = ts.strftime("%d-%b %H:%M IST") if isinstance(ts, datetime) else "?"
    return (
        f"[DIAL-100 CALL {idx} | cat={d.get('category','?')} | "
        f"incident={d.get('incidentCategory','?')} | status={d.get('status','?')} | {ts_s}]\n"
        f"  Location: {d.get('location','?')} | PS: {d.get('psJurisdiction','?')} "
        f"| Zone: {d.get('zoneJurisdiction','?')}\n"
        f"  Details: {(d.get('incidentDetails') or '')[:250]}\n"
        f"  Priority: {d.get('priority','?')} | Caller: {d.get('callerName','?')}"
        + (f"\n  Remarks: {d.get('remarks','')[:200]}" if d.get('remarks') else "")
    )


def _fmt_event(d: dict, idx: int) -> str:
    start = d.get("start_date")
    end = d.get("end_date")
    start_s = start.strftime("%d-%b %Y") if isinstance(start, datetime) else "?"
    end_s = end.strftime("%d-%b %Y") if isinstance(end, datetime) else "?"
    kws = ", ".join(k.get("keyword", "") for k in (d.get("keywords") or [])[:5])
    return (
        f"[EVENT {idx} | status={d.get('status','?')} | {start_s} to {end_s}]\n"
        f"  Name: {d.get('name','?')}\n"
        f"  Location: {d.get('location','?')} | Platforms: {', '.join(d.get('platforms',[]))}\n"
        f"  Keywords: {kws or '—'}\n"
        f"  Description: {(d.get('description') or '')[:200]}"
    )


def _fmt_poi(d: dict, idx: int) -> str:
    firs = "; ".join(
        f"FIR {f.get('firNo','?')} at {f.get('psLimits','?')}"
        for f in (d.get("firDetails") or [])[:3]
    )
    aliases = ", ".join(d.get("aliasNames") or [])
    return (
        f"[PERSON OF INTEREST {idx}]\n"
        f"  Name: {d.get('name','?')} | Real Name: {d.get('realName','?')}\n"
        f"  Aliases: {aliases or '—'}\n"
        f"  Address: {d.get('currentAddress','?')} | PS: {d.get('psLimits','?')} "
        f"| District: {d.get('districtCommisionerate','?')}\n"
        f"  FIRs: {firs or '—'}\n"
        f"  Linked Incidents: {(d.get('linkedIncidents') or '')[:200]}"
    )


def _fmt_keyword(d: dict, idx: int) -> str:
    return (
        f"[KEYWORD {idx}] \"{d.get('keyword','?')}\" | category={d.get('category','?')} "
        f"| lang={d.get('language','?')} | weight={d.get('weight',0)} "
        f"| active={'yes' if d.get('is_active') else 'no'}"
    )


def _fmt_source(d: dict, idx: int) -> str:
    platform = d.get("platform", "?")
    identifier = d.get("identifier", "?")
    profile_url = _build_profile_url(platform, identifier, d.get("platform_user_id", ""))
    return (
        f"[MONITORED PROFILE {idx}] @{identifier} "
        f"({d.get('display_name','?')}) | platform={platform} "
        f"| category={d.get('category','?')} | risk={d.get('risk_level','?')} "
        f"| followers={d.get('follower_count') or '?'} "
        f"| verified={'yes' if d.get('is_verified') else 'no'}\n"
        f"  Profile URL: {profile_url or 'N/A'}"
    )


def _fmt_daily_programme(d: dict, idx: int) -> str:
    dt = d.get("date")
    dt_s = dt.strftime("%d-%b %Y") if isinstance(dt, datetime) else "?"
    return (
        f"[DAILY PROGRAMME {idx} | {dt_s}]\n"
        f"  Programme: {d.get('programName','?')} | Category: {d.get('categoryLabel') or d.get('category','?')}\n"
        f"  Location: {d.get('location','?')} | Zone: {d.get('zone','?')}\n"
        f"  Organizer: {d.get('organizer','?')} | Expected: {d.get('expectedMembers',0)} members"
    )


def _fmt_telegram(d: dict, idx: int) -> str:
    ts = d.get("date")
    ts_s = ts.strftime("%d-%b %H:%M IST") if isinstance(ts, datetime) else "?"
    return (
        f"[TELEGRAM MSG {idx} | group={d.get('group_id','?')} | {ts_s}]\n"
        f"  Sender: {d.get('sender_name','?')} (@{d.get('sender_username','?')})\n"
        f"  Text: \"{(d.get('text') or '')[:250]}\""
        + (f"\n  Links: {', '.join(d.get('links',[])[:3])}" if d.get('links') else "")
    )


def _fmt_criticism_report(d: dict, idx: int) -> str:
    ts = d.get("post_date") or d.get("createdAt")
    ts_s = ts.strftime("%d-%b %H:%M IST") if isinstance(ts, datetime) else "?"
    pb = d.get("posted_by") or {}
    return (
        f"[CRITICISM REPORT {idx} | code={d.get('unique_code','?')} | "
        f"status={d.get('status','?')} | {ts_s}]\n"
        f"  By: @{pb.get('handle','?')} on {d.get('platform','?')} | "
        f"Link: {d.get('post_link','—')}\n"
        f"  Category: {d.get('category','?')}\n"
        f"  Description: {(d.get('post_description') or '')[:200]}"
        + (f"\n  Remarks: {d.get('remarks','')[:150]}" if d.get('remarks') else "")
    )


def _fmt_suggestion_report(d: dict, idx: int) -> str:
    ts = d.get("post_date") or d.get("createdAt")
    ts_s = ts.strftime("%d-%b %H:%M IST") if isinstance(ts, datetime) else "?"
    pb = d.get("posted_by") or {}
    return (
        f"[SUGGESTION REPORT {idx} | code={d.get('unique_code','?')} | "
        f"status={d.get('status','?')} | {ts_s}]\n"
        f"  By: @{pb.get('handle','?')} on {d.get('platform','?')} | "
        f"Link: {d.get('post_link','—')}\n"
        f"  Category: {d.get('category','?')}\n"
        f"  Description: {(d.get('post_description') or '')[:200]}"
        + (f"\n  Remarks: {d.get('remarks','')[:150]}" if d.get('remarks') else "")
    )


# ---------------------------------------------------------------------------
# Question-aware collection routing
#
# For every question we ALWAYS query alerts + grievances.  On top of that,
# we detect which extra modules are relevant based on keywords in the question.
# For general questions with no specific module hints we include a broad set.
# ---------------------------------------------------------------------------
_COLLECTION_ROUTING = [
    (re.compile(r"\bdial[\s-]?100\b|\bemergency\s*calls?\b|\b100\s*calls?\b|\bincidents?\b", re.I),
     ["dial100incidents"]),
    (re.compile(r"\bevents?\b|\bfestivals?\b|\brall(y|ies)\b|\bprotests?\b|\bprocessions?\b|\bgatherings?\b|\bhartaals?\b|\bbandhs?\b", re.I),
     ["events"]),
    (re.compile(r"\bpois?\b|\bpersons?\s*of\s*interest\b|\bsuspects?\b|\baccused\b|\bhistory[\s-]?sheeters?\b|\bcriminals?\b", re.I),
     ["pois"]),
    # "profile/profiles" is ambiguous in the portal — it can mean a Person of
    # Interest record OR a monitored social-media account (sources). Pull both.
    (re.compile(r"\bprofiles?\b", re.I),
     ["pois", "sources"]),
    (re.compile(r"\bkeywords?\b|\bmonitored\s*words?\b|\bwatch[\s-]?words?\b|\btracking\s*terms?\b|\btop\s*keywords?\b", re.I),
     ["keywords"]),
    (re.compile(r"\bsources?\b|\bmonitored\s*(accounts?|profiles?)\b|\btracked\s*(accounts?|profiles?)\b", re.I),
     ["sources"]),
    (re.compile(r"\bprogrammes?\b|\bprograms?\b|\bschedules?\b|\bdaily\s*programmes?\b|\bannouncements?\b", re.I),
     ["dailyprogrammes"]),
    (re.compile(r"\btelegram\b|\btg\s*messages?\b|\btg\s*groups?\b|\bchannel\s*messages?\b", re.I),
     ["telegrammessages"]),
    (re.compile(r"\bcontents?\b|\bposts?\b|\btweets?\b|\breels?\b|\bstor(y|ies)\b|\bvideos?\b|\bsocial\s*media\b", re.I),
     ["contents"]),
    (re.compile(r"\bcriticisms?\b|\bcritiques?\b|\bcritisisms?\b", re.I),
     ["criticismreports"]),
    (re.compile(r"\bsuggestions?\b", re.I),
     ["suggestionreports"]),
    (re.compile(r"\bquery\s*reports?\b", re.I),
     ["queryreports"]),
    (re.compile(r"\bworkflow\b|\bgrievance\s*workflow\b", re.I),
     ["grievanceworkflowreports"]),
]

# Registry: collection_name → (fields, formatter, ts_field, default_limit)
_EXTRA_COLLECTION_REGISTRY = {
    "contents":              (CONTENT_FIELDS,            _fmt_content,            "published_at", 8),
    "dial100incidents":      (DIAL100_FIELDS,            _fmt_dial100,            "date",         8),
    "events":                (EVENT_FIELDS,              _fmt_event,              "start_date",   6),
    "pois":                  (POI_FIELDS,                _fmt_poi,                None,           6),
    "keywords":              (KEYWORD_FIELDS,            _fmt_keyword,            None,          10),
    "sources":               (SOURCE_FIELDS,             _fmt_source,             None,           8),
    "dailyprogrammes":       (DAILY_PROGRAMME_FIELDS,    _fmt_daily_programme,    "date",         6),
    "telegrammessages":      (TELEGRAM_FIELDS,           _fmt_telegram,           "date",         8),
    "criticismreports":      (CRITICISM_REPORT_FIELDS,   _fmt_criticism_report,   "post_date",    6),
    "suggestionreports":     (SUGGESTION_REPORT_FIELDS,  _fmt_suggestion_report,  "post_date",    6),
}


_BROAD_QUESTION_RE = re.compile(
    r"\b(all|every|everything|overall|summary|summari[sz]e|brief(ing)?|overview|"
    r"status|situation|report|round[\s-]?up|digest|dashboard|across\s+modules?)\b",
    re.I,
)

# Modules pulled by default for any question that doesn't specifically target
# one — covers the operational data officers care about most.
_DEFAULT_EXTRA_COLLECTIONS = [
    "contents", "dial100incidents", "events", "dailyprogrammes",
    "pois", "keywords", "sources",
]

# Every supported extra collection — used when the question is broad
# ("all modules", "overall summary", "everything", etc.).
_ALL_EXTRA_COLLECTIONS = [
    "contents", "dial100incidents", "events", "pois", "keywords", "sources",
    "dailyprogrammes", "telegrammessages",
    "criticismreports", "suggestionreports",
]


def _detect_extra_collections(question: str) -> list:
    """Return list of extra collection names (beyond alerts/grievances) to query."""
    extra = set()
    for pat, cols in _COLLECTION_ROUTING:
        if pat.search(question):
            extra.update(cols)

    # Broad / "everything" style questions → pull from every module.
    if _BROAD_QUESTION_RE.search(question):
        extra.update(_ALL_EXTRA_COLLECTIONS)
        return list(extra)

    # No specific module hint → pull the most operationally relevant modules.
    if not extra:
        extra.update(_DEFAULT_EXTRA_COLLECTIONS)
    return list(extra)


def _build_db_context(question: str, window_days: Optional[int], limit_per: int = 15,
                      tenant_id: Optional[str] = None,
                      districts: Optional[List[str]] = None) -> tuple:
    """
    Pull data from ALL relevant modules in Mongo.
    Returns (snippets_list, total_docs_pulled).
    Always returns data — this is the backbone of every non-count answer.
    """
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client[_tenant_db(tenant_id)]

        # Every query below derives from base_q, so seeding the tenant here is
        # what keeps alerts, grievances and the extra modules inside the
        # boundary. Removing it does not fail a query, it widens it.
        base_q: dict = dict(_tenant_filter(tenant_id))
        if window_days and window_days > 0:
            cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)
            base_q["created_at"] = {"$gte": cutoff}

        # Alerts carry no districts of their own; they inherit from the
        # monitored profile they came from. None means unrestricted (admin);
        # [] means an officer with zero districts and must match nothing.
        scoped_source_ids = _scoped_source_ids(tenant_id, districts)

        # Keyword/category hint filter
        extra_q: dict = {}
        for pat, filt in _CATEGORY_HINTS:
            if pat.search(question):
                extra_q.update(filt)
                break

        alert_q = {**base_q, **extra_q}
        if scoped_source_ids is not None:
            alert_q["source_id"] = {"$in": scoped_source_ids}

        # Extract named handles/keywords from question for targeted search
        handle_match = re.findall(r"@([\w]+)", question)
        if handle_match:
            handle_re = "|".join(re.escape(h) for h in handle_match)
            alert_q["$or"] = [
                {"author_handle": {"$regex": handle_re, "$options": "i"}},
                {"author": {"$regex": handle_re, "$options": "i"}},
            ]

        # Detect trending/viral questions — sort by velocity instead of recency
        q_lower = question.lower()
        is_trending = any(w in q_lower for w in ["trending", "viral", "hot topic", "hyped", "most popular", "most talked", "top post"])

        def _fetch_alerts(q: dict) -> list:
            if is_trending:
                # Pull HIGH+MEDIUM together sorted by velocity (most viral first)
                fetched = list(db.alerts.find(
                    {**q, "priority": {"$in": ["HIGH", "MEDIUM"]},
                     "velocity_data.velocity": {"$gt": 0}},
                    ALERT_FIELDS
                ).sort("velocity_data.velocity", DESCENDING).limit(limit_per))
                # If not enough velocity data, fall back to recent high-risk
                if len(fetched) < 5:
                    fetched = list(db.alerts.find(
                        {**q, "priority": {"$in": ["HIGH", "MEDIUM"]}}, ALERT_FIELDS
                    ).sort("created_at", DESCENDING).limit(limit_per))
                return fetched
            # Normal: HIGH first, then MEDIUM — weighted 2:1
            high_lim = max(8, limit_per * 2 // 3)
            med_lim = max(4, limit_per // 3)
            alerts_high = list(db.alerts.find(
                {**q, "priority": "HIGH"}, ALERT_FIELDS
            ).sort("created_at", DESCENDING).limit(high_lim))
            alerts_med = list(db.alerts.find(
                {**q, "priority": "MEDIUM"}, ALERT_FIELDS
            ).sort("created_at", DESCENDING).limit(med_lim))
            return alerts_high + alerts_med

        # Relevance-scope the recency pull to the question's own content words
        # — skipped for handle lookups (already precise) and for broad/summary
        # questions ("overall status", "everything") that intentionally want
        # the wide recent-alerts view.
        relevance_terms = [] if (handle_match or _BROAD_QUESTION_RE.search(question)) \
            else _extract_relevance_terms(question)
        alert_relevance_clause = _relevance_or_clause(relevance_terms, ALERT_RELEVANCE_FIELDS)

        scoped_alert_q = {**alert_q, **alert_relevance_clause} if alert_relevance_clause else alert_q
        all_alerts = _fetch_alerts(scoped_alert_q)
        if alert_relevance_clause and not all_alerts:
            # Nothing on-topic in this window — fall back to the unfiltered
            # recency pull so the answer still has real data; the vector layer
            # (RRF-fused in _global_query) is what actually supplies on-topic
            # context in this case.
            all_alerts = _fetch_alerts(alert_q)

        # Grievances — keyword match on content text; same relevance scoping
        # Grievances carry their own districts array, so they scope directly.
        grievance_q = _with_district_scope({**base_q}, districts)
        grievance_relevance_clause = None
        if handle_match:
            handle_re = "|".join(re.escape(h) for h in handle_match)
            grievance_q["$or"] = [
                {"posted_by.handle": {"$regex": handle_re, "$options": "i"}},
                {"content.text": {"$regex": handle_re, "$options": "i"}},
                {"tagged_account": {"$regex": handle_re, "$options": "i"}},
            ]
        else:
            grievance_relevance_clause = _relevance_or_clause(relevance_terms, GRIEVANCE_RELEVANCE_FIELDS)

        scoped_grievance_q = ({**grievance_q, **grievance_relevance_clause}
                              if grievance_relevance_clause else grievance_q)
        grievances = list(db.grievances.find(
            scoped_grievance_q, GRIEVANCE_FIELDS
        ).sort("created_at", DESCENDING).limit(max(6, limit_per // 2)))
        if grievance_relevance_clause and not grievances:
            grievances = list(db.grievances.find(
                grievance_q, GRIEVANCE_FIELDS
            ).sort("created_at", DESCENDING).limit(max(6, limit_per // 2)))

        snippets = []
        for i, d in enumerate(all_alerts, 1):
            snippets.append(_fmt_alert(d, i))
        for j, d in enumerate(grievances, 1):
            snippets.append(_fmt_grievance(d, j))

        total = len(all_alerts) + len(grievances)

        # ── Extra modules (beyond alerts + grievances) ────────────────────────
        extra_cols = _detect_extra_collections(question)
        existing_cols = set(db.list_collection_names())

        for col_name in extra_cols:
            if col_name not in existing_cols:
                continue
            reg = _EXTRA_COLLECTION_REGISTRY.get(col_name)
            if not reg:
                continue
            fields, formatter, ts_field, default_limit = reg

            # Build a time-windowed query for this collection
            col_q: dict = dict(_tenant_filter(tenant_id))
            # These modules (contents, pois, keywords, sources, templates,
            # policymappings) carry their own districts; a doc without any is
            # tenant-wide and stays visible.
            _with_district_scope(col_q, districts)
            if window_days and window_days > 0 and ts_field:
                cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)
                col_q[ts_field] = {"$gte": cutoff}

            # For text-searchable collections, apply keyword filter if present
            if handle_match and col_name == "contents":
                handle_re = "|".join(re.escape(h) for h in handle_match)
                col_q["$or"] = [
                    {"author_handle": {"$regex": handle_re, "$options": "i"}},
                    {"text": {"$regex": handle_re, "$options": "i"}},
                ]
            elif handle_match and col_name == "pois":
                handle_re = "|".join(re.escape(h) for h in handle_match)
                col_q["$or"] = [
                    {"name": {"$regex": handle_re, "$options": "i"}},
                    {"realName": {"$regex": handle_re, "$options": "i"}},
                    {"aliasNames": {"$regex": handle_re, "$options": "i"}},
                ]

            sort_field = ts_field or "created_at" if ts_field else "_id"
            try:
                docs = list(db[col_name].find(
                    col_q, fields
                ).sort(sort_field, DESCENDING).limit(default_limit))
            except Exception:
                # Fallback: sort might fail if field doesn't exist; try without sort
                try:
                    docs = list(db[col_name].find(col_q, fields).limit(default_limit))
                except Exception:
                    docs = []

            for k, d in enumerate(docs, 1):
                snippets.append(formatter(d, k))
            total += len(docs)

        client.close()
        return snippets, total
    except Exception as e:
        logger.warning("_build_db_context failed: %s", e)
        return [], 0


def _vector_candidates(question: str, tenant_id: Optional[str] = None,
                       districts: Optional[List[str]] = None) -> list:
    """Semantic hits for *question*, or [] when no embedding host is reachable.

    Unchanged retrieval mechanics — same embedder, same VectorStore, same
    cosine search over the same collections.
    """
    try:
        embedder = get_embedder()
        q_vec = embedder.embed_text(question)
        if q_vec is None:
            return []
        hits: list = []
        db_name = _tenant_db(tenant_id)
        for vc in _list_vector_collections(db_name):
            try:
                store = _get_store(vc, db_name)
                hits.extend(store.cosine_search(
                    query_vector=q_vec, top_k=4, query_text=question,
                    tenant_id=tenant_id, districts=districts))
            except Exception:
                pass
        hits.sort(key=lambda r: r.get("score", 0.0), reverse=True)
        return hits
    except Exception as exc:
        logger.debug("vector enrichment skipped: %s", exc)
        return []


# Completion size for a grounded RAG answer. Smaller than the old 2048: the
# answer should be as long as the evidence warrants, and a smaller completion
# leaves more of the (currently tight) server context for actual evidence.
_RAG_COMPLETION_TOKENS = 1600


def _run_engine(question: str, tenant_id: str, districts, db_name: str,
                time_window_days=None) -> dict:
    """Plan and retrieve for one question, inside one tenant and district scope.

    Both handle sets are built here: pymongo Collections for the structured and
    lexical retrievers, and VectorStores for the semantic one. They address the
    same vector collections, which hold the curated text, the facets and the
    embedding together -- one index, three ways in.
    """
    vec_names = _list_vector_collections(db_name)
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    db = client[db_name]
    try:
        collections = {name: db[name] for name in vec_names}
        stores = {name: _get_store(name, db_name) for name in vec_names}

        eng = rag_engine.Engine(collections, tenant_id, districts)

        def _embed(text: str):
            return get_embedder().embed_query(text)

        def _plan_with_llm(prompt: str, max_tokens: int) -> str:
            """Generation for the planner only.

            Deterministic (temperature 0) and tightly capped: the reply is a
            small JSON object, and on a bandwidth-bound box every extra token
            is latency an officer waits through. Called only when the rule
            planner left the question underconstrained.
            """
            return llm_generate(prompt, temperature=0.0, top_p=1.0,
                                max_tokens=max_tokens)

        result = eng.answer(question, embed=_embed, vector_stores=stores,
                            generate=_plan_with_llm)
    finally:
        client.close()

    # A window the caller forced (the UI's time filter) overrides the planner,
    # which only infers one when the question names a date.
    if time_window_days:
        result["applied"] += f" (caller window: last {time_window_days}d)"
    return result


def _global_query(question: str, top_k: int, time_window_days: Optional[int],
                  tenant_id: Optional[str] = None, districts: Optional[List[str]] = None,
                  allow_scan: bool = False) -> dict:
    """Route by intent, then retrieve only what that intent actually needs.

    Previously every question — "hi" included — pulled alerts + grievances from
    Mongo, appended vector hits, and asked for a 10+ line briefing. Now:

      greeting / capability / unsupported -> answered without touching Mongo
      general knowledge                   -> LLM only, no database context
      data query                          -> retrieve, rank, budget, ground

    Retrieval itself is unchanged; what changed is whether it runs and how much
    of its output reaches the prompt.
    """
    started = time.time()
    verdict = intent_router.classify(question)

    log = {"intent": verdict.intent.value, "rag_used": False, "candidates": 0,
           "contexts": 0, "context_tokens": 0, "prompt_tokens": 0,
           "model": llm_client.LLM_MODEL, "llm_status": None}

    def _finish(payload: dict) -> dict:
        payload.setdefault("intent", verdict.intent.value)
        payload.setdefault("rag_used", log["rag_used"])
        payload.setdefault("context_count", log["contexts"])
        payload.setdefault("context_tokens", log["context_tokens"])
        payload.setdefault("prompt_tokens", log["prompt_tokens"])
        if verdict.unsupported:
            payload.setdefault("unsupported", [k for k, _ in verdict.unsupported])
        logger.info(
            "RAG q=%r intent=%s rag=%s candidates=%d (db=%s vec=%s) contexts=%d "
            "ctx_tok=%d prompt_tok=%s model=%s llm=%s %.1fs",
            question[:80], log["intent"], log["rag_used"], log["candidates"],
            log.get("db_candidates", 0), log.get("vector_candidates", 0),
            log["contexts"], log["context_tokens"], log["prompt_tokens"],
            log["model"], log["llm_status"], time.time() - started,
        )
        return payload

    # ── routes that need no retrieval ────────────────────────────────────────
    if verdict.intent is intent_router.Intent.GREETING:
        return _finish({"answer": intent_router.greeting_answer(question),
                        "sources": [], "question": question,
                        "scope": "greeting", "smalltalk": True})

    if verdict.intent is intent_router.Intent.CAPABILITY:
        return _finish({"answer": intent_router.CAPABILITY_ANSWER, "sources": [],
                        "question": question, "scope": "capability"})

    if verdict.intent is intent_router.Intent.UNSUPPORTED:
        return _finish({"answer": intent_router.limitation_notice(
                            verdict.unsupported, data_follows=False),
                        "sources": [], "question": question,
                        "scope": "unsupported"})

    if verdict.intent is intent_router.Intent.GENERAL:
        meta: dict = {}
        answer = llm_generate(
            f"{CHAT_ONLY_SYSTEM_PROMPT}\n\nUser: {question}\n\nAssistant:",
            temperature=0.3, max_tokens=800, meta=meta)
        log["llm_status"] = meta.get("status")
        log["prompt_tokens"] = meta.get("prompt_tokens") or 0
        return _finish({"answer": answer, "sources": [], "question": question,
                        "scope": "general"})

    # ── counts answer exactly, without an LLM ────────────────────────────────
    fast = _count_fast_path(question, time_window_days,
                            tenant_id=tenant_id, districts=districts)
    if fast is not None:
        log["rag_used"] = True
        return _finish(fast)

    # ── concepts nobody tagged: judged on demand ─────────────────────────
    # "communal content last 7 days" has no tag to filter on. It becomes a
    # background scan (filter -> recall -> rerank -> LLM judge) that the
    # frontend polls, so confirmed cards arrive while the rest are judged.
    if allow_scan:
        plan = scan_mod.route(question)
        if plan:
            log["rag_used"] = True
            job = _start_scan(question, tenant_id, districts, plan=plan)
            return _finish({"answer": "", "sources": [], "question": question,
                            "scope": "scan", "scan": job.snapshot()})

    # ── retrieve ───────────────────────────────────────────────────────
    # The engine plans the question into a filter, runs the structured, lexical
    # and semantic retrievers against this tenant's own index, and fuses them.
    # The database decides WHICH records; the model only decides how to say it.
    log["rag_used"] = True
    db_name = _tenant_db(tenant_id)

    if time_window_days:
        # An explicit window from the caller still wins; absent, the planner
        # reads the question and leaves it unbounded when it names no date.
        pass

    result = _run_engine(question, tenant_id, districts, db_name,
                         time_window_days=time_window_days)
    rows = result["rows"]
    log["db_candidates"] = result["counts"]["structured"]
    log["vector_candidates"] = result["counts"]["semantic"]
    log["candidates"] = sum(result["counts"][k] for k in
                            ("structured", "lexical", "semantic"))
    log["contexts"] = len(rows)

    prompt = rag_engine.build_prompt(question, result)
    log["context_tokens"] = intent_router.count_tokens(prompt)
    log["prompt_tokens"] = log["context_tokens"]

    meta = {}
    answer = llm_generate(prompt, temperature=0.2, top_p=0.9,
                          max_tokens=_RAG_COMPLETION_TOKENS, meta=meta)
    log["llm_status"] = meta.get("status")
    if meta.get("prompt_tokens"):
        log["prompt_tokens"] = meta["prompt_tokens"]

    # Stated in code, not left to the model: it cannot talk its way into
    # claiming it emailed or exported anything.
    if verdict.unsupported:
        answer = (intent_router.limitation_notice(verdict.unsupported,
                                                  data_follows=True)
                  + "\n\n" + answer)

    sources = [{
        "collection": r.get("kind") or "record",
        "document_id": r.get("url") or f"row-{i + 1}",
        "url": r.get("url"),
        "handle": r.get("handle"),
        "platform": r.get("platform"),
        "published_at": r.get("published_at"),
        "risk_level": r.get("risk_level"),
        "risk_score": r.get("risk_score"),
        "sentiment": r.get("sentiment"),
        "matched_by": r.get("matched_by"),
        "score": r.get("score"),
        "preview": (r.get("text") or "")[:200],
    } for i, r in enumerate(rows)]

    return _finish({
        "answer": answer, "sources": sources, "question": question,
        "scope": "engine",
        "window_doc_count": result.get("total") if result.get("total") is not None else len(rows),
        "total_matching": result.get("total"),
        "time_window_days": time_window_days,
        "filters_applied": result["applied"],
        # Exact figures from the database. Surfaced separately from the answer
        # text so the frontend can chart them, and so nothing has to be parsed
        # back out of prose the model wrote.
        "breakdown": result.get("breakdown") or [],
        "breakdown_by": result.get("breakdown_by"),
        "trend": result.get("trend"),
        "retrieval": result["counts"],
        "retrieval_ms": result["took_ms"],
    })


@app.post("/api/rag/query")
def query(req: QueryRequest):
    """Ask a question. If `collection` is omitted (or 'all'), searches across
    every indexed collection — chat-bot style — instead of one specific source.

    When ``use_db`` is False the DB + vector layers are bypassed entirely and
    the question is sent to the LLM as pure conversational chat.
    """
    # No retrieval happens here, so this branch needs no tenant.
    if not req.use_db:
        return _chat_only_answer(req.question)

    # Fail closed before anything touches Mongo or the vector store. The Node
    # proxy always injects tenant_id, but this app binds 0.0.0.0 and a direct
    # call would otherwise fall through to an unscoped read of every tenant.
    tenant_id = _require_tenant(req.tenant_id)
    districts = req.districts

    # Greetings, capability questions and pure unsupported-action requests are
    # answered the same way whatever collection is selected — and must never
    # trigger retrieval. _global_query owns those branches.
    if not intent_router.classify(req.question).needs_rag:
        out = _global_query(req.question, req.top_k, req.time_window_days,
                            tenant_id=tenant_id, districts=districts)
        out["time_window_days"] = req.time_window_days
        return out

    raw_col = (req.collection or "").strip().lower()
    if raw_col in ("", "all", "*", "global", "everything"):
        out = _global_query(req.question, req.top_k, req.time_window_days,
                            tenant_id=tenant_id, districts=districts,
                            allow_scan=True)
        out["time_window_days"] = req.time_window_days
        return out
    collection = req.collection

    try:
        vec_col, use_source_filter, data_exists = _auto_ingest_if_needed(collection)
        if not data_exists:
            return {
                "answer": f"The collection '{collection}' does not exist in the database.",
                "sources": [],
                "question": req.question,
                "collection": collection,
                "vector_collection": vec_col,
                "ingested": False,
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB error: {e}")

    bot = Assistant(
        llm_model=LLM_MODEL,
        mongo_uri=MONGODB_URI,
        db_name=_tenant_db(tenant_id),
        vector_collection=vec_col,
        top_k=req.top_k,
        source_collection=collection if use_source_filter else None,
    )

    allow_ids = _allow_ids_within_window(collection, req.time_window_days or 0, tenant_id=tenant_id)
    result = bot.ask(req.question, doc_id_filter=allow_ids,
                     tenant_id=tenant_id, districts=districts)
    bot.close()
    # Backstop: enforce the 10-line / always-include-links contract even when
    # the per-collection path is used.
    snippet_previews = [s.get("preview", "") for s in result.get("sources", []) if s.get("preview")]
    if snippet_previews:
        result["answer"] = _ensure_minimum_answer(
            result.get("answer", ""), snippet_previews, req.question
        )
    result["collection"] = collection
    result["vector_collection"] = vec_col
    result["scoped_via_metadata"] = use_source_filter
    result["time_window_days"] = req.time_window_days
    if allow_ids is not None:
        result["window_doc_count"] = len(allow_ids)
    return result


# ---------------------------------------------------------------------------
# Query Understanding (architecture v2) — development endpoint
#
# Returns a plan, never an answer. Behind AI_ASSISTANT_ARCHITECTURE_V2, which
# defaults to false: production traffic keeps the existing /api/rag/query path
# until the orchestrator that consumes these plans exists. Tenant is still
# required, because a dev endpoint that skips the boundary is how a dev
# endpoint ends up in production with no boundary.
# ---------------------------------------------------------------------------

class QueryPlanRequest(BaseModel):
    question: str
    tenant_id: str | None = None
    districts: List[str] | None = None
    # Rules-only, for comparing the deterministic path against the LLM-assisted
    # one without restarting anything.
    allow_llm: bool = True


@app.post("/api/rag/query-plan")
def query_plan(req: QueryPlanRequest):
    """Parse a question into a validated QueryPlan. Executes nothing."""
    if not qu.v2_enabled():
        raise HTTPException(
            status_code=404,
            detail=f"query understanding v2 is disabled; set {qu.FEATURE_FLAG}=true "
                   f"to enable the development endpoint")
    # The plan carries no authorisation, but the endpoint is still scoped: the
    # caller must be a real tenant, exactly as every other route requires.
    _require_tenant(req.tenant_id)
    if not (req.question or "").strip():
        raise HTTPException(status_code=400, detail="question is required")

    def _plan_generate(prompt: str, max_tokens: int, temperature: float = 0.0) -> str:
        return llm_generate(prompt, temperature=temperature, top_p=1.0,
                            max_tokens=max_tokens, repetition_penalty=1.0)

    plan, validation = qu.understand(
        req.question,
        generate=_plan_generate if req.allow_llm else None,
        allow_llm=req.allow_llm,
    )
    return {
        "query_plan": plan.model_dump(mode="json"),
        "validation": validation.model_dump(mode="json"),
        "latency": {
            "deterministic_ms": plan.metadata.deterministic_ms,
            "llm_ms": plan.metadata.llm_ms,
            "total_ms": plan.metadata.total_ms,
            "llm_used": plan.metadata.llm_used,
        },
    }


# ---------------------------------------------------------------------------
# Phase 1B - Policy / Capability Gate (development only)
#
# Decides what a plan may do for a caller; executes nothing. Same flag as the
# query-plan route, plus AI_POLICY_ENABLED (default true) to switch the gate
# route off on its own. Not exposed through Node.
#
# The caller context arrives in the body because that is how every route here
# receives it today: Node injects tenant_id and districts. Role and RBAC
# permissions are passed the same way for evaluation; this route is a policy
# test harness, not an authorisation boundary for real traffic.
# ---------------------------------------------------------------------------

class PolicyCheckRequest(BaseModel):
    tenant_id: str | None = None
    user_id: str | None = None
    role: str | None = None
    # None = unrestricted (honoured only for an unrestricted role), [] = none.
    districts: List[str] | None = None
    # req.rbac.permissions as Node resolves it: {"/page": {enabled, features}}.
    permissions: dict | None = None
    # The caller's own district selection; may be narrowed, never widened.
    requested_districts: List[str] | None = None
    # Exactly one of these.
    question: str | None = None
    query_plan: dict | None = None
    allow_llm: bool = False


@app.post("/api/rag/policy-check")
def policy_check(req: PolicyCheckRequest,
                 x_tenant_id: str | None = Header(default=None)):
    """Evaluate a QueryPlan against a caller context. Returns a decision,
    never an answer."""
    if not (qu.v2_enabled() and policy_gate.policy_enabled()):
        raise HTTPException(
            status_code=404,
            detail=f"policy gate is disabled; set {qu.FEATURE_FLAG}=true (and "
                   f"{policy_gate.ENABLED_FLAG} not false) to enable the development endpoint")
    _require_tenant(req.tenant_id)
    if bool((req.question or "").strip()) == (req.query_plan is not None):
        raise HTTPException(status_code=400,
                            detail="provide exactly one of question or query_plan")

    ctx = policy_gate.RequestContext(
        tenant_id=req.tenant_id, user_id=req.user_id, role=req.role,
        districts=req.districts,
        permissions=policy_gate.permissions_from_rbac(req.permissions))

    plan_out = None
    if req.query_plan is not None:
        subject = req.query_plan
    else:
        def _plan_generate(prompt: str, max_tokens: int, temperature: float = 0.0) -> str:
            return llm_generate(prompt, temperature=temperature, top_p=1.0,
                                max_tokens=max_tokens, repetition_penalty=1.0)
        subject, _ = qu.understand(req.question,
                                   generate=_plan_generate if req.allow_llm else None,
                                   allow_llm=req.allow_llm)
        plan_out = subject.model_dump(mode="json")

    started = time.perf_counter()
    # A second statement of the tenant (Node's X-Tenant-Id header) must agree
    # with the body; a mismatch is refused rather than one of them believed.
    result = policy_gate.evaluate_raw(subject, ctx,
                                      requested_districts=req.requested_districts,
                                      requested_tenant_id=x_tenant_id)
    policy_ms = round((time.perf_counter() - started) * 1000, 3)
    logger.info("policy-check decision=%s reasons=%s caps=%s ms=%s",
                result.decision.value, [r.value for r in result.reason_codes()],
                [c.value for c in result.allowed_capabilities], policy_ms)
    return {
        "policy": result.model_dump(mode="json"),
        "public": result.public(),
        "query_plan": plan_out,
        "latency": {"policy_ms": policy_ms},
    }


# ---------------------------------------------------------------------------
# Phase 1C - Conversation Context (development only)
#
# question -> QueryPlan (1A) -> resolved against this user's conversation (1C)
#          -> Policy Gate against the caller AS THEY ARE NOW (1B) -> turn stored
#
# Memory is context, not authority: no decision is stored, so a district taken
# away between turns is refused on the next turn even if the conversation
# still remembers it. The store is process-local memory - this harness writes
# nothing to any database. Not exposed through Node.
# ---------------------------------------------------------------------------

_conversation_store = None
_conversation_store_lock = threading.Lock()


def _conversations():
    global _conversation_store
    with _conversation_store_lock:
        if _conversation_store is None:
            _conversation_store = conv.InMemoryConversationStore(conv.ConversationConfig.from_env())
        return _conversation_store


class ConversationResolveRequest(BaseModel):
    tenant_id: str | None = None
    user_id: str | None = None
    role: str | None = None
    districts: List[str] | None = None
    permissions: dict | None = None
    requested_districts: List[str] | None = None
    # Omit to start a new conversation; ids are only ever issued by the server.
    conversation_id: str | None = None
    question: str | None = None
    query_plan: dict | None = None
    # False resolves without recording the turn (a dry run).
    commit: bool = True
    allow_llm: bool = False


@app.post("/api/rag/conversation/resolve")
def conversation_resolve(req: ConversationResolveRequest,
                         x_tenant_id: str | None = Header(default=None)):
    """Resolve a follow-up against the caller's own conversation, then gate
    it. Returns the resolved plan and the decision - never an answer."""
    if not (qu.v2_enabled() and conv.conversation_enabled()):
        raise HTTPException(
            status_code=404,
            detail=f"conversation context is disabled; set {qu.FEATURE_FLAG}=true (and "
                   f"{conv.ENABLED_FLAG} not false) to enable the development endpoint")
    tenant_id = _require_tenant(req.tenant_id)
    if not (req.user_id or "").strip():
        raise HTTPException(status_code=400, detail="user_id is required (conversations are per user)")
    if bool((req.question or "").strip()) == (req.query_plan is not None):
        raise HTTPException(status_code=400, detail="provide exactly one of question or query_plan")

    store = _conversations()
    started = time.perf_counter()
    try:
        state = (store.get(tenant_id, req.user_id, req.conversation_id)
                 if req.conversation_id else store.create(tenant_id, req.user_id))
    except (conv.ConversationNotFound, conv.InvalidConversationId) as exc:
        # One answer for unknown, expired, foreign and malformed: nothing
        # here confirms that somebody else's conversation exists.
        logger.info("conversation lookup refused: %s", getattr(exc, "reason", exc.code))
        raise HTTPException(status_code=404, detail="conversation not found")
    store_ms = round((time.perf_counter() - started) * 1000, 3)

    if req.query_plan is not None:
        try:
            plan = qu.QueryPlan.model_validate(req.query_plan)
        except Exception:
            raise HTTPException(status_code=400, detail="query_plan is not a valid QueryPlan")
        question = plan.raw_query
    else:
        def _plan_generate(prompt: str, max_tokens: int, temperature: float = 0.0) -> str:
            return llm_generate(prompt, temperature=temperature, top_p=1.0,
                                max_tokens=max_tokens, repetition_penalty=1.0)
        plan, _ = qu.understand(req.question, generate=_plan_generate if req.allow_llm else None,
                                allow_llm=req.allow_llm)
        question = req.question

    ctx = policy_gate.RequestContext(
        tenant_id=tenant_id, user_id=req.user_id, role=req.role, districts=req.districts,
        permissions=policy_gate.permissions_from_rbac(req.permissions))

    started = time.perf_counter()
    resolved = conv.resolve_query(plan, state, ctx, config=store.config)
    context_ms = round((time.perf_counter() - started) * 1000, 3)

    # Every resolved plan goes through the gate, against current authority.
    started = time.perf_counter()
    decision = policy_gate.evaluate(resolved.resolved_plan, ctx,
                                    requested_districts=req.requested_districts,
                                    requested_tenant_id=x_tenant_id)
    policy_ms = round((time.perf_counter() - started) * 1000, 3)

    turn_sequence = state.turn_count
    if req.commit:
        turn = conv.build_turn(state.turn_count + 1, question, resolved, store.config,
                               query_plan=plan)
        try:
            turn_sequence = store.append(state, turn, expected_sequence=state.turn_count).turn_count
        except conv.ConversationConflict:
            raise HTTPException(status_code=409,
                                detail="the conversation moved on; resolve again against the latest turn")
        except conv.ConversationNotFound:
            raise HTTPException(status_code=404, detail="conversation not found")

    logger.info("conversation-resolve conv=%s turn=%s status=%s used=%d refs=%d/%d decision=%s ms=%s",
                resolved.metadata.conversation_ref, turn_sequence, resolved.status.value,
                resolved.metadata.context_items_used, resolved.metadata.referents_resolved,
                resolved.metadata.referents_unresolved, decision.decision.value, context_ms)
    return {
        "conversation_id": state.conversation_id,
        "turn": turn_sequence,
        "status": resolved.status.value,
        "resolved_plan": resolved.resolved_plan.model_dump(mode="json"),
        "referents": [r.model_dump(mode="json") for r in resolved.resolved_referents],
        "unresolved": [u.model_dump(mode="json") for u in resolved.unresolved_referents],
        "context_used": [u.model_dump(mode="json") for u in resolved.context_used],
        "resets": resolved.resets,
        "policy": {"decision": decision.decision.value,
                   "reason_codes": [c.value for c in decision.reason_codes()],
                   "effective_districts": decision.effective_districts,
                   "public": decision.public()},
        "latency": {"store_ms": store_ms, "context_ms": context_ms, "policy_ms": policy_ms},
    }


# ---------------------------------------------------------------------------
# Phases 2-5 - the v2 assistant pipeline (feature-flagged)
#
#   understand -> conversation -> enrich places -> POLICY -> compile -> execute
#   -> evidence -> verify -> bounded agent (<=2) -> respond
#
# Everything is 404 unless AI_ASSISTANT_ARCHITECTURE_V2=true. The existing
# /api/rag/query is not touched and does not route here. Node forwards the
# authenticated caller (tenant, user id, role, districts, RBAC permissions)
# to /v2/query; nothing about the caller is taken from the question.
# ---------------------------------------------------------------------------

import orchestrator.pipeline as v2_pipeline  # noqa: E402
from runtime import stores as v2_stores  # noqa: E402
from runtime.telemetry import METRICS as V2_METRICS  # noqa: E402
from runtime import cache as v2_cache  # noqa: E402
from orchestrator.tools import ToolBackend  # noqa: E402

_v2_mongo = None
_v2_mongo_lock = threading.Lock()


def _v2_client():
    """The process's Mongo client, from the shared pool.

    Was a second module-level client alongside the stores' own. One pool per
    process is what PyMongo asks for; several mean several sets of monitoring
    threads and handshakes to the same cluster.
    """
    return mongo_pool.client(MONGODB_URI)


def _v2_db_for_tenant(tenant_id: str):
    return _v2_client()[_tenant_db(tenant_id)]


def _v2_backend(tenant_id: str):
    """(ToolBackend, close) for ONE tenant: its own database, its vector
    collections, the shared embedder. The judge model is attached by the
    pipeline through the router."""
    db_name = _tenant_db(tenant_id)
    db = _v2_client()[db_name]
    names = _list_vector_collections(db_name)
    backend = ToolBackend(collections={n: db[n] for n in names},
                          stores={n: _get_store(n, db_name) for n in names},
                          embed=lambda text: get_embedder().embed_query(text),
                          db=db, model=llm_client.LLM_MODEL)
    return backend, (lambda: None)


def _v2_raw_generate(prompt: str, max_tokens: int = 256, temperature: float = 0.0,
                     model: Optional[str] = None, **kw) -> str:
    return llm_generate(prompt, temperature=temperature, top_p=1.0, max_tokens=max_tokens,
                        repetition_penalty=1.0, model=model)


def _start_deep_analysis(question: str, intent: str, ctx, plan, eplan,
                         matching=None, side_counts=None):
    """Kick off the deep reading for one question, under THIS caller's scope.

    The job inherits the tenant and the districts the request was made under
    and can only be read back by the same pair, so a job id alone never
    reaches another officer's scope.
    """
    from orchestrator import analysis_job

    from orchestrator.tools import to_spec

    spec = None
    for step in (eplan.steps or []):
        cand = getattr(getattr(step, "arguments", None), "spec", None)
        if cand is not None:
            spec = to_spec(cand)
            break
    # No step carried a record filter (a pure count or trend), so there is no
    # population to read. The deterministic answer already stands on its own.
    if spec is None:
        return None

    districts = list(ctx.districts) if ctx.districts else None
    tenant_id = ctx.tenant_id

    # A comparison is several populations. Reading them pooled produced one
    # analysis dominated by whichever scope posts more, then described it as
    # though it belonged to one side.
    sides = None
    for step in (eplan.steps or []):
        cmp_sides = getattr(getattr(step, "arguments", None), "sides", None)
        if cmp_sides:
            from orchestrator.analysis_job import Side
            # Each side carries ITS OWN matching count. Without them the
            # cross-side briefing had no headline figures and reached for the
            # per-side location tallies instead, producing "Hyderabad has more
            # posts (78) compared to Mulugu (134)".
            counts = side_counts or {}
            sides = [Side(label=str(cs.label), spec=spec,
                          districts=list(cs.districts) if cs.districts else districts,
                          since=cs.since, until=cs.until,
                          matching=counts.get(str(cs.label)))
                     for cs in cmp_sides][:3]
            break
    # ASCII-only extraction returned NOTHING for a Telugu question, so the
    # analysis population was ranked with no lexical signal at all.
    terms = [t for t in qu_normalize.words(question or "") if len(t) > 2][:12]

    def deps_factory():
        backend, close = _v2_backend(tenant_id)
        return {
            "collections": backend.collections,
            "stores": backend.stores,
            "spec": spec,
            "tenant_id": tenant_id,
            "districts": districts,
            "embed": backend.embed,
            "generate": _v2_raw_generate,
            "db": backend.db,
            "model": llm_client.LLM_MODEL,
            "terms": terms,
            "close": close,
        }

    return analysis_job.start(question, intent, tenant_id,
                              _district_scope_key(districts), deps_factory,
                              matching=matching, sides=sides)


def _v2_deps() -> "v2_pipeline.Deps":
    flag = v2_pipeline._flag
    return v2_pipeline.Deps(
        store=v2_stores.conversation_store(_v2_db_for_tenant),
        backend_factory=_v2_backend,
        raw_generate=_v2_raw_generate if flag("AI_V2_LLM", "true") else None,
        db_for_tenant=_v2_db_for_tenant,
        audit=v2_stores.AuditSink(_v2_db_for_tenant),
        # Measured: with this off, 16 of 28 natural officer questions were
        # understood; with it on, 27. It is a flag so it can be turned off,
        # not because off is a sensible default.
        planner_llm=flag("AI_V2_PLANNER_LLM", "true"),
        synthesize=flag("AI_V2_SYNTHESIS", "false"),
        concept_tracking=flag("AI_CONCEPT_TRACKING", "false"),
        cache=flag("AI_V2_CACHE", "true"),
        start_analysis=(_start_deep_analysis
                        if flag("AI_V2_DEEP_ANALYSIS", "true") else None))


# Progressive analysis and scans both keep job state in this process. Catch a
# multi-worker deployment at boot rather than when an officer's analysis
# "disappears" because the poll reached a different worker.
try:
    from orchestrator.analysis_job import assert_single_worker as _assert_single_worker
    _assert_single_worker()
except ImportError:
    pass


def _require_v2():
    if not qu.v2_enabled():
        raise HTTPException(status_code=404,
                            detail=f"the v2 assistant is disabled; set {qu.FEATURE_FLAG}=true")


class V2QueryRequest(BaseModel):
    tenant_id: str | None = None
    user_id: str | None = None
    role: str | None = None
    districts: List[str] | None = None
    permissions: dict | None = None
    requested_districts: List[str] | None = None
    conversation_id: str | None = None
    question: str


@app.get("/api/rag/v2/status")
def v2_status():
    """Tells the UI whether to use the v2 path. Reveals nothing else."""
    return {"enabled": qu.v2_enabled()}


@app.post("/api/rag/v2/query")
def v2_query(req: V2QueryRequest, x_tenant_id: str | None = Header(default=None)):
    _require_v2()
    tenant_id = _require_tenant(req.tenant_id)
    if not (req.user_id or "").strip():
        raise HTTPException(status_code=400, detail="user_id is required")
    question = (req.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    if len(question) > 2000:
        raise HTTPException(status_code=400, detail="question is too long")
    ctx = policy_gate.RequestContext(
        tenant_id=tenant_id, user_id=req.user_id, role=req.role, districts=req.districts,
        permissions=policy_gate.permissions_from_rbac(req.permissions))
    try:
        result = v2_pipeline.run(question, ctx, _v2_deps(), conversation_id=req.conversation_id,
                                 requested_districts=req.requested_districts,
                                 requested_tenant_id=x_tenant_id)
    except (conv.ConversationNotFound, conv.InvalidConversationId):
        raise HTTPException(status_code=404, detail="conversation not found")
    except conv.ConversationConflict:
        raise HTTPException(status_code=409, detail="the conversation moved on; ask again")
    # How this turn was READ, so a wrong answer can be reported precisely. An
    # officer saying "it kept answering about the previous question" is not
    # actionable without knowing whether the turn was taken as a follow-up and
    # which dimensions it inherited. No records, no identifiers — just the
    # decision.
    plan = (result.internal or {}).get("query_plan") or {}
    meta = plan.get("metadata") or {}
    conv_info = (result.internal or {}).get("conversation") or {}
    context = {
        "intent": plan.get("intent"),
        "follow_up": conv_info.get("follow_up"),
        "resolution": conv_info.get("status"),
        "understanding_mode": meta.get("understanding_mode"),
        "inherited": conv_info.get("inherited") or [],
        "location": (plan.get("location") or {}).get("text") if plan.get("location") else None,
        "filters": [f"{f.get('field')}={f.get('value')}" for f in (plan.get("filters") or [])],
    }
    return {"conversation_id": result.conversation_id, "turn": result.turn,
            "response": result.response.model_dump(mode="json"),
            "context": context,
            "latency_ms": result.trace.get("total_ms")}


class V2FeedbackRequest(BaseModel):
    tenant_id: str | None = None
    user_id: str | None = None
    kind: str
    target: dict
    verdict: str | None = None
    correct_labels: List[str] = []
    reason: str = ""


@app.post("/api/rag/v2/feedback")
def v2_feedback(req: V2FeedbackRequest):
    _require_v2()
    from lifecycle.feedback import FeedbackError, FeedbackIn, FeedbackStore
    tenant_id = _require_tenant(req.tenant_id)
    if not (req.user_id or "").strip():
        raise HTTPException(status_code=400, detail="user_id is required")
    try:
        item = FeedbackIn(kind=req.kind, target=req.target, verdict=req.verdict,
                          correct_labels=req.correct_labels, reason=req.reason)
        fid = FeedbackStore(_v2_db_for_tenant(tenant_id), tenant_id).submit(req.user_id, item)
    except (FeedbackError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)[:200])
    return {"feedback_id": fid, "state": "new"}


def _analysis_model_load() -> dict:
    from orchestrator import analysis as _analysis
    return _analysis.model_load()


def _router_pool_stats() -> dict:
    from runtime import router as _router
    return _router.pool_stats()


@app.get("/api/rag/v2/metrics")
def v2_metrics():
    """Latency percentiles and counters for this process. No identifiers."""
    _require_v2()
    import vector_store as _vs
    return {**V2_METRICS.snapshot(),
            "cache": {"plans": v2_cache.PLANS.stats(),
                      "retrieval": v2_cache.RETRIEVAL.stats()},
            # Which semantic-search strategy actually served queries. If this
            # is dominated by anything other than atlas_vector_search, the
            # index is missing or unhealthy and retrieval is degraded.
            "search_strategy": _vs.search_strategy_report(),
            # Per collection, because the total says retrieval is degrading and
            # only this says which collection to build an index on.
            "search_strategy_by_collection": _vs.search_strategy_by_collection(),
            "degraded_collections": _vs.degraded_collections(),
            # One client per process is the intent. `created` climbing with
            # request count means something is still building its own.
            "mongo_pool": mongo_pool.stats(),
            # queued_out/queue_full rising while failed stays flat means the
            # model is healthy and this process is asking for more than it can
            # serve. The two used to be indistinguishable, and saturation was
            # reported as a model outage.
            "llm_pool": _router_pool_stats(),
            # Deep analysis calls the model directly, outside the router's pool.
            # This plus llm_pool.running is the real concurrent pressure on one
            # Ollama instance; neither number alone shows it.
            "analysis_model": _analysis_model_load()}


# ---------------------------------------------------------------------------
# On-demand concept scans (scan.py)
#
# A scan runs in a background thread and is polled. Jobs live in this process's
# memory: run the API as a single worker (the default), or a poll can land on
# a worker that never saw the job.
# ---------------------------------------------------------------------------

class ScanRequest(BaseModel):
    question: str
    tenant_id: str | None = None
    districts: List[str] | None = None
    # Judge every record in the window instead of the most likely ones.
    deep: bool = False


def _districts_param(raw: Optional[str]) -> Optional[List[str]]:
    """GET encoding from the Node proxy: absent = admin, "__none__" = an
    officer with zero districts (fail closed), else a comma list."""
    if raw is None or raw == "":
        return None
    if raw == "__none__":
        return []
    return [d.strip() for d in raw.split(",") if d.strip()]


def _judge_generate(prompt: str, max_tokens: int) -> str:
    """Deterministic and short: a verdict list, not prose."""
    return llm_generate(prompt, temperature=0.0, top_p=1.0, max_tokens=max_tokens,
                        repetition_penalty=1.0, timeout=int(os.getenv("JUDGE_TIMEOUT", "120")))


def _scan_deps(tenant_id: str, districts: Optional[List[str]]) -> dict:
    """Per-job resources, opened inside the worker thread."""
    db_name = _tenant_db(tenant_id)
    vec_names = _list_vector_collections(db_name)
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    db = client[db_name]
    return {
        "collections": {n: db[n] for n in vec_names},
        "stores": {n: _get_store(n, db_name) for n in vec_names},
        "tenant_id": tenant_id,
        "districts": districts,
        "db": db,
        "embed": lambda text: get_embedder().embed_query(text),
        "generate": _judge_generate,
        "model": llm_client.LLM_MODEL,
        "close": client.close,
    }


def _start_scan(question: str, tenant_id: str, districts: Optional[List[str]],
                deep: bool = False, plan: Optional[dict] = None):
    return scan_mod.start(
        question, tenant_id, _district_scope_key(districts),
        lambda: _scan_deps(tenant_id, districts), deep=deep, plan=plan)


@app.post("/api/rag/scan")
def scan_start(req: ScanRequest):
    """Start a scan explicitly -- the frontend's "deep scan" button."""
    tenant_id = _require_tenant(req.tenant_id)
    if not (req.question or "").strip():
        raise HTTPException(status_code=400, detail="question is required")
    job = _start_scan(req.question.strip(), tenant_id, req.districts, deep=req.deep)
    return job.snapshot()


@app.get("/api/rag/scan/{job_id}")
def scan_status(job_id: str, tenant_id: Optional[str] = None,
                districts: Optional[str] = None):
    tenant_id = _require_tenant(tenant_id)
    job = scan_mod.get(job_id, tenant_id, _district_scope_key(_districts_param(districts)))
    if job is None:
        raise HTTPException(status_code=404, detail="scan not found or expired")
    return job.snapshot()


@app.delete("/api/rag/scan/{job_id}")
def scan_cancel(job_id: str, tenant_id: Optional[str] = None,
                districts: Optional[str] = None):
    tenant_id = _require_tenant(tenant_id)
    job = scan_mod.get(job_id, tenant_id, _district_scope_key(_districts_param(districts)))
    if job is None:
        raise HTTPException(status_code=404, detail="scan not found or expired")
    scan_mod.cancel(job)
    return {"job_id": job_id, "cancelled": True}


# ---------------------------------------------------------------------------
# Async / background queries
#
# Every async query is persisted to the `rag_jobs` collection so:
#   • the UI can poll for completion later (even after refresh / tab close)
#   • answers stay visible across browser sessions and devices
#   • multiple users see the same history per collection
# ---------------------------------------------------------------------------

JOBS_COLLECTION = os.getenv("RAG_JOBS_COLLECTION", "rag_jobs")
_jobs_client_lock = threading.Lock()
_jobs_client: Optional[MongoClient] = None


# Databases whose job indexes have been ensured this process.
_jobs_indexed: set = set()


def _jobs_col(tenant_id: Optional[str] = None):
    """Handle to a tenant's rag_jobs collection.

    Jobs carry the question and the answer, so they are tenant data and live in
    the tenant's own database with everything else.
    """
    global _jobs_client
    db_name = _tenant_db(tenant_id)
    with _jobs_client_lock:
        if _jobs_client is None:
            _jobs_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        # Indexes are per database, so they are ensured the first time each
        # tenant's collection is touched, not once per process.
        if db_name not in _jobs_indexed:
            db = _jobs_client[db_name]
            db[JOBS_COLLECTION].create_index([("created_at", DESCENDING)])
            db[JOBS_COLLECTION].create_index([("collection", 1), ("created_at", DESCENDING)])
            db[JOBS_COLLECTION].create_index("job_id", unique=True)
            _jobs_indexed.add(db_name)
        return _jobs_client[db_name][JOBS_COLLECTION]


# Max source docs to auto-ingest inline (blocks the query until done).
# Collections larger than this are ingested in the background so the query
# doesn't hang for minutes while the embedding server processes thousands of docs.
AUTO_INGEST_INLINE_LIMIT = int(os.getenv("AUTO_INGEST_INLINE_LIMIT", "500"))

# Track background ingestion so we don't launch duplicates
_bg_ingest_lock = threading.Lock()
_bg_ingest_running: set = set()  # collection names currently being ingested


def _bg_ingest_worker(collection: str):
    """Background thread that ingests a large collection without blocking queries."""
    try:
        _run_ingest(collection)
        logger.info("Background ingest: '%s' complete.", collection)
    except Exception as exc:
        logger.error("Background ingest failed for '%s': %s", collection, exc)
    finally:
        with _bg_ingest_lock:
            _bg_ingest_running.discard(collection)


def _auto_ingest_if_needed(collection: str, tenant_id: Optional[str] = None) -> tuple:
    """Check if embeddings exist for *collection*; if not, ingest automatically.

    - Small collections (≤ AUTO_INGEST_INLINE_LIMIT docs): ingest inline and block.
    - Large collections: kick off background ingestion so the query can still proceed
      with whatever partial data exists (or return a helpful message).

    Returns (vec_col, use_source_filter, data_exists).
    """
    per_col_vec = f"{VECTOR_COLLECTION}_{collection}"

    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    db = client[_tenant_db(tenant_id)]
    existing = set(db.list_collection_names())

    # Source collection must exist in the database
    if collection not in existing:
        client.close()
        return per_col_vec, False, False  # vec_col, use_source_filter, data_exists

    # Already has a per-collection vector index with data — no ingestion needed
    if per_col_vec in existing and db[per_col_vec].estimated_document_count() > 0:
        client.close()
        return per_col_vec, False, True

    # Global vector collection has chunks for this collection
    if VECTOR_COLLECTION in existing:
        count = db[VECTOR_COLLECTION].count_documents(
            {"metadata.source_collection": collection}, limit=1
        )
        if count > 0:
            client.close()
            return VECTOR_COLLECTION, True, True

    # No embeddings — decide whether to ingest inline or in background
    source_doc_count = db[collection].estimated_document_count()
    client.close()

    if source_doc_count <= AUTO_INGEST_INLINE_LIMIT:
        # Small collection — ingest inline (fast, a few seconds)
        logger.info(
            "Auto-ingest inline: '%s' (%d docs) — ingesting before query...",
            collection, source_doc_count,
        )
        try:
            _run_ingest(collection)
            logger.info("Auto-ingest inline: '%s' complete.", collection)
        except Exception as exc:
            logger.error("Auto-ingest inline failed for '%s': %s", collection, exc)
        return per_col_vec, False, True
    else:
        # Large collection — ingest in background, don't block query
        with _bg_ingest_lock:
            already_running = collection in _bg_ingest_running
            if not already_running:
                _bg_ingest_running.add(collection)
        if not already_running:
            logger.info(
                "Auto-ingest background: '%s' (%d docs) — too large for inline, "
                "spawning background thread.",
                collection, source_doc_count,
            )
            t = threading.Thread(
                target=_bg_ingest_worker,
                args=(collection,),
                name=f"auto-ingest-{collection}",
                daemon=True,
            )
            t.start()
        else:
            logger.info("Auto-ingest background: '%s' already in progress.", collection)

        return per_col_vec, False, True


def _process_job(job_id: str, question: str, collection: str, top_k: int,
                 vec_col: str, use_source_filter: bool, time_window_days: Optional[int] = 7,
                 tenant_id: Optional[str] = None, districts: Optional[List[str]] = None):
    """Background worker: runs the RAG query and stores the result.

    The scope is captured at enqueue time and travels with the job. A worker
    that resolved it later could answer with a scope the caller never had.
    """
    col = _jobs_col(tenant_id)
    started = datetime.now(timezone.utc)
    col.update_one(
        {"job_id": job_id},
        {"$set": {"status": "running", "started_at": started}},
    )
    try:
        # Auto-ingest if this collection has no embeddings yet
        vec_col, use_source_filter, data_exists = _auto_ingest_if_needed(collection, tenant_id=tenant_id)

        if not data_exists:
            finished = datetime.now(timezone.utc)
            col.update_one(
                {"job_id": job_id},
                {"$set": {
                    "status": "completed",
                    "answer": f"The collection '{collection}' does not exist in the database.",
                    "sources": [],
                    "finished_at": finished,
                    "duration_ms": int((finished - started).total_seconds() * 1000),
                }},
            )
            return

        # Check if the vector collection actually has data after auto-ingest.
        # If not (large collection still ingesting in background), tell the user.
        try:
            _client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
            _db = _client[_tenant_db(tenant_id)]
            vec_count = _db[vec_col].estimated_document_count() if vec_col in _db.list_collection_names() else 0
            _client.close()
        except Exception:
            vec_count = 0

        if vec_count == 0:
            # Background ingestion in progress — no data yet to search
            with _bg_ingest_lock:
                still_running = collection in _bg_ingest_running
            if still_running:
                answer = (
                    f"This is the first time the **{collection}** collection is being queried. "
                    f"I'm currently indexing the data in the background — this may take a few minutes "
                    f"for large collections.\n\n"
                    f"**Please try again shortly.** Your question will be answered once indexing completes."
                )
            else:
                answer = (
                    f"No indexed data found for the **{collection}** collection. "
                    f"Indexing may have failed. Please check the RAG server logs."
                )
            finished = datetime.now(timezone.utc)
            col.update_one(
                {"job_id": job_id},
                {"$set": {
                    "status": "completed",
                    "answer": answer,
                    "sources": [],
                    "finished_at": finished,
                    "duration_ms": int((finished - started).total_seconds() * 1000),
                }},
            )
            return

        bot = Assistant(
                llm_model=LLM_MODEL,
                mongo_uri=MONGODB_URI,
            db_name=_tenant_db(tenant_id),
            vector_collection=vec_col,
            top_k=top_k,
            source_collection=collection if use_source_filter else None,
        )
        allow_ids = _allow_ids_within_window(collection, time_window_days or 0, tenant_id=tenant_id)
        result = bot.ask(question, doc_id_filter=allow_ids,
                         tenant_id=tenant_id, districts=districts)
        bot.close()

        finished = datetime.now(timezone.utc)
        col.update_one(
            {"job_id": job_id},
            {"$set": {
                "status": "completed",
                "answer": result.get("answer", ""),
                "sources": result.get("sources", []),
                "vector_collection": vec_col,
                "scoped_via_metadata": use_source_filter,
                "finished_at": finished,
                "duration_ms": int((finished - started).total_seconds() * 1000),
            }},
        )
        logger.info("Job %s completed in %ss", job_id, (finished - started).total_seconds())
    except Exception as exc:
        logger.exception("Job %s failed", job_id)
        col.update_one(
            {"job_id": job_id},
            {"$set": {
                "status": "failed",
                "error": str(exc),
                "finished_at": datetime.now(timezone.utc),
            }},
        )


@app.post("/api/rag/query/async")
def query_async(req: QueryRequest):
    """Enqueue a question for background processing. Returns immediately with a job_id.

    If no embeddings exist for the requested collection, the background worker
    will auto-ingest before answering — no manual ingestion required.
    """
    tenant_id = _require_tenant(req.tenant_id)
    districts = req.districts
    collection = req.collection or os.getenv("COLLECTION_NAME", "contents")

    # Verify the source collection actually exists in this tenant's database
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client[_tenant_db(tenant_id)]
        existing = set(db.list_collection_names())
        client.close()

        if collection not in existing:
            raise HTTPException(
                status_code=400,
                detail=f"Collection '{collection}' does not exist in the database.",
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB error: {e}")

    # Determine initial vec_col (the background worker will re-check and auto-ingest if needed)
    per_col_vec = f"{VECTOR_COLLECTION}_{collection}"
    vec_col = per_col_vec if per_col_vec in existing else VECTOR_COLLECTION
    use_source_filter = vec_col == VECTOR_COLLECTION

    job_id = uuid.uuid4().hex
    now = datetime.now(timezone.utc)
    _jobs_col(tenant_id).insert_one({
        "job_id": job_id,
        "status": "queued",
        # Stored so list/get/delete can scope, and so the worker answers with
        # exactly the scope the caller had when they asked.
        "tenant_id": tenant_id,
        "districts": districts,
        "question": req.question,
        "collection": collection,
        "vector_collection": vec_col,
        "scoped_via_metadata": use_source_filter,
        "top_k": req.top_k,
        "created_at": now,
        "answer": None,
        "sources": [],
    })

    t = threading.Thread(
        target=_process_job,
        args=(job_id, req.question, collection, req.top_k, vec_col, use_source_filter,
              req.time_window_days, tenant_id, districts),
        daemon=True,
    )
    t.start()

    return {
        "job_id": job_id,
        "status": "queued",
        "question": req.question,
        "collection": collection,
        "created_at": now.isoformat(),
    }


def _serialize_job(doc: dict) -> dict:
    """Convert a stored job document into a JSON-friendly dict."""
    out = {k: v for k, v in doc.items() if k != "_id"}
    for ts_key in ("created_at", "started_at", "finished_at"):
        ts = out.get(ts_key)
        if isinstance(ts, datetime):
            out[ts_key] = ts.isoformat()
    return out


@app.get("/api/rag/jobs/{job_id}")
def get_job(job_id: str, tenant_id: Optional[str] = None):
    """Return the current status / result of a job."""
    doc = _jobs_col(tenant_id).find_one({"job_id": job_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Job not found")
    return _serialize_job(doc)


@app.get("/api/rag/jobs")
def list_jobs(collection: Optional[str] = None, limit: int = 50, status: Optional[str] = None,
              tenant_id: Optional[str] = None):
    """Return recent jobs, newest first. Optionally filter by collection / status."""
    q: dict = {}
    if collection:
        q["collection"] = collection
    if status:
        q["status"] = status
    limit = max(1, min(limit, 200))
    docs = list(
        _jobs_col(tenant_id).find(q).sort("created_at", DESCENDING).limit(limit)
    )
    return {"jobs": [_serialize_job(d) for d in docs], "count": len(docs)}


@app.delete("/api/rag/jobs/{job_id}")
def delete_job(job_id: str, tenant_id: Optional[str] = None):
    """Remove a job from history."""
    res = _jobs_col(tenant_id).delete_one({"job_id": job_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"deleted": True, "job_id": job_id}


# ---------------------------------------------------------------------------
# Ingestion + Scheduler
# ---------------------------------------------------------------------------

_scheduler_state = {
    "running": False,
    "thread": None,
    "stop": threading.Event(),
    "current_collection": None,
    "in_progress": False,
    "last_run_started_at": None,
    "last_run_finished_at": None,
    "next_run_at": None,
    "last_results": [],
}
_scheduler_lock = threading.Lock()


def _ingest_runs_col():
    """Scheduler run history.

    This is operations metadata about the SERVICE, not about one tenant: a
    cycle now spans every active tenant, so a record naming them all cannot sit
    in any one tenant's database. It lives in the control plane, which is also
    where the tenant registry is, and is not exposed through the tenant-facing
    proxy.
    """
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    return client[tenants.CONTROL_DB_NAME][INGEST_RUNS_COLLECTION]


def _record_run(doc: dict):
    try:
        col = _ingest_runs_col()
        col.insert_one(doc)
        col.database.client.close()
    except Exception as e:
        logger.warning("Could not persist ingest run record: %s", e)


def _content_hash(text: str) -> str:
    """Stable fingerprint of a document's retrievable text."""
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()


def _embedded_state(store) -> dict:
    """Map document_id -> content hash recorded when it was embedded.

    Skipping purely on "have I seen this _id" leaves an edited document stuck
    on its original vector forever. Storing the hash lets the sync tell a
    genuinely new document apart from a changed one.
    """
    col = store.connect()
    state = {}
    for row in col.find({}, {"metadata.document_id": 1,
                             "metadata.content_hash": 1}):
        meta = row.get("metadata") or {}
        did = meta.get("document_id")
        if did is not None:
            state[did] = meta.get("content_hash")
    return state


def _run_ingest(collection: str, tenant_id: Optional[str] = None, force: bool = False) -> dict:
    """Incrementally sync one source collection into its vector store.

    Three outcomes per source document:
      * unseen _id            -> embed it
      * seen, hash unchanged  -> skip (no embedding call)
      * seen, hash changed    -> re-embed and replace only that document's chunks

    Safe to call repeatedly on a schedule: unchanged data never reaches the
    embedding model.

    Scoped to *tenant_id*: only that tenant's source documents are read, and
    every chunk written is tagged with ``metadata.tenant_id`` and
    ``metadata.districts`` so retrieval can enforce the boundary. A chunk that
    is not tagged is reachable by nobody, which is the safe direction.

    With *force*, the hash/skip shortcut is bypassed so existing chunks are
    re-embedded and re-tagged. That is how chunks written before tagging
    existed get their tenant and districts backfilled.

    Either way the document ends up with exactly the chunks its current view
    produces. The upsert replaces indexes 0..n-1; anything above that is a
    leftover from a longer previous representation and is pruned in _flush,
    after the new chunks are safely written.
    """
    vec_col = f"{VECTOR_COLLECTION}_{collection}"
    logger.info("Sync start: '%s' -> '%s'", collection, vec_col)

    chunker = TokenAwareChunker(min_tokens=CHUNK_MIN, max_tokens=CHUNK_MAX,
                                overlap=CHUNK_OVERLAP)
    embedder = get_embedder()
    # Vectors are written into the tenant's own database, beside the source
    # collections they were built from. Nothing about one tenant's corpus is
    # stored anywhere another tenant can reach.
    store = VectorStore(MONGODB_URI, _tenant_db(tenant_id), vec_col)

    if not embedder.check_health():
        store.close()
        raise RuntimeError("local embedding model not available")

    known = _embedded_state(store)

    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    src = client[_tenant_db(tenant_id)][collection]
    # Only this tenant's documents are read. Without this the corpus is built
    # from every tenant at once and the tag below would be a lie.
    tenant_q = _tenant_filter(tenant_id)
    total_docs = src.count_documents(tenant_q) if tenant_q else src.estimated_document_count()

    # Collections with no districts of their own (alerts, the report kinds)
    # inherit them from a parent, resolved once for the whole run.
    link_field, link_districts_map = _resolve_ingest_link_districts(collection, tenant_id)

    docs_new = docs_changed = docs_skipped = docs_legacy = docs_empty = 0
    chunks_stored = chunks_pruned = embed_failures = 0
    failed_docs: list = []
    pending: list = []

    # document_id -> how many chunks its current representation produces.
    # Applied after the write, so a document can never be left with nothing:
    # see VectorStore.prune_orphan_chunks.
    prunes: dict = {}

    def _flush():
        nonlocal pending, chunks_stored, chunks_pruned, prunes
        if pending:
            chunks_stored += store.upsert_chunks(pending)
            pending = []
        # Order matters. The new chunks are already stored, so removing the
        # tail of the previous representation cannot leave a gap.
        for pruned_id, keep_from in prunes.items():
            chunks_pruned += store.prune_orphan_chunks(
                pruned_id, keep_from, tenant_id=tenant_id)
        prunes = {}

    for doc in src.find(tenant_q):
        doc_id = str(doc.get("_id", ""))
        try:
            # Curated view: prose a person would recognise, with the structured
            # fields split out as facets. Flattening the whole document put a
            # quarter of the vector into UUIDs and pushed the real text past the
            # truncation limit -- see views.py.
            text, facets = views.render(collection, doc)
            if not text.strip():
                # Nothing retrievable now. On a deliberate rebuild that IS the
                # current representation, so any previous chunks are stale; on
                # an incremental sync an empty render is left alone rather than
                # deleting data on the strength of one odd document.
                docs_empty += 1
                if force and doc_id in known:
                    prunes[doc_id] = 0
                continue

            digest = _content_hash(text)
            if doc_id in known and not force:
                recorded = known[doc_id]
                if recorded is None:
                    # Legacy vector written before hash tracking existed. Absence
                    # of a hash is NOT evidence the source changed, so treating it
                    # as "changed" would delete and re-embed the entire existing
                    # corpus on the first scheduled cycle. Migrating those is a
                    # deliberate rebuild (regenerate_embeddings.py), not something
                    # a sync should do on a timer.
                    docs_legacy += 1
                    continue
                if recorded == digest:
                    docs_skipped += 1
                    continue
                # Content changed. The stale chunks are removed AFTER the new
                # ones are written (see _flush): deleting first meant an
                # embedding failure here left the document with no vectors at
                # all, which is worse than briefly stale ones.
                docs_changed += 1
            else:
                docs_new += 1

            chunks = chunker.chunk_document(text, collection, doc_id)
            if not chunks:
                docs_empty += 1
                if force and doc_id in known:
                    prunes[doc_id] = 0
                continue

            # Document side must carry the document prefix. Using the query
            # prefix here would put the corpus in a different region of the
            # space from the questions asked against it.
            vectors = embedder.embed_documents([c.text for c in chunks])

            wrote_any = False
            for chunk, vec in zip(chunks, vectors):
                if vec is None:
                    embed_failures += 1
                    continue
                wrote_any = True
                pending.append({
                    "text": chunk.text,
                    "embedding": vec,
                    "metadata": {
                        "source_collection": chunk.metadata.source_collection,
                        "document_id": chunk.metadata.document_id,
                        "chunk_index": chunk.metadata.chunk_index,
                        "total_chunks": chunk.metadata.total_chunks,
                        "chunk_id": f"{doc_id}::{chunk.metadata.chunk_index}",
                        "content_hash": digest,
                        "embed_model": getattr(embedder, "model_name", None),
                        "embed_dim": len(vec),
                        "source_created_at": doc.get("created_at"),
                        # Hard tenant boundary: cosine_search filters on this.
                        # Prefer the document's own tenant_id over the requested
                        # one so a mis-scoped read can never mislabel a chunk.
                        # Structured fields live here, not in the embedded
                        # text: a number in a vector is a worse version of a
                        # number in an index.
                        **facets,
                        "tenant_id": doc.get("tenant_id", tenant_id),
                        # Second-level district boundary. A collection with no
                        # districts of its own inherits them from its parent
                        # (alerts via source_id, the report kinds via
                        # grievance_id). An empty list means tenant-wide, which
                        # every district can see -- the same convention the Node
                        # backend uses in scopedDistrictQuery.
                        "districts": (
                            link_districts_map.get(doc.get(link_field), [])
                            if link_field else doc.get("districts", [])
                        ),
                    },
                })
            if wrote_any:
                # Exactly the chunks this render produced survive: indexes
                # 0..n-1 are overwritten by the upsert, n and above are pruned
                # in _flush once that write has landed.
                prunes[doc_id] = len(chunks)
            else:
                failed_docs.append(doc_id)

            if len(pending) >= BATCH_SIZE:
                _flush()

        except Exception as exc:
            # One bad document must not take the worker down; record it so the
            # next cycle retries it (its hash was never stored).
            embed_failures += 1
            failed_docs.append(doc_id)
            logger.warning("Sync: document %s in %s failed: %s",
                           doc_id, collection, str(exc)[:160])

    _flush()
    client.close()

    docs_processed = docs_new + docs_changed
    if docs_processed:
        store.invalidate_cache()
        logger.info("Invalidated vector cache for '%s' after %d changes.",
                    vec_col, docs_processed)
    store.close()

    logger.info("Sync done: %s — new=%d changed=%d unchanged=%d legacy=%d "
                "empty=%d chunks=%d pruned=%d failures=%d", collection, docs_new,
                docs_changed, docs_skipped, docs_legacy, docs_empty,
                chunks_stored, chunks_pruned, embed_failures)
    if docs_legacy:
        logger.info("  %s: %d document(s) hold pre-hash vectors and were left "
                    "alone. Rebuild them with regenerate_embeddings.py when you "
                    "choose to migrate.", collection, docs_legacy)

    result = {
        "collection": collection,
        "vector_collection": vec_col,
        "total_source_docs": total_docs,
        "docs_processed": docs_processed,
        "docs_new": docs_new,
        "docs_changed": docs_changed,
        "docs_skipped": docs_skipped,
        "docs_legacy": docs_legacy,
        "failed_document_ids": failed_docs[:50],
        "chunks_stored": chunks_stored,
        "chunks_pruned": chunks_pruned,
        "docs_empty": docs_empty,
        "embed_failures": embed_failures,
        "skipped_already_done": docs_skipped,
    }
    return result


@app.post("/api/rag/ingest")
def ingest(req: IngestRequest):
    """Trigger incremental ingestion for a specific collection (runs synchronously)."""
    tenant_id = _require_tenant(req.tenant_id)
    try:
        return _run_ingest(req.collection, tenant_id=tenant_id, force=req.force)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


def _run_scheduled_cycle() -> list:
    """Incrementally ingest every configured collection, for every active tenant.

    Each tenant is ingested into its OWN database, so this is a loop over
    (tenant, collection). A tenant added in Super Admin is picked up on the next
    cycle without a restart, because the registry is read here rather than
    captured at boot.

    Failures are caught per pair: one unreachable tenant or one bad collection
    must not stop the rest of the cycle.
    """
    cycle_results = []
    started = datetime.now(timezone.utc)
    _scheduler_state["in_progress"] = True
    _scheduler_state["last_run_started_at"] = started.isoformat()

    try:
        tenant_list = tenants.active_tenants()
    except Exception as e:
        logger.exception("Scheduled ingestion could not read the tenant registry")
        _scheduler_state["in_progress"] = False
        return [{"status": "error", "error": f"tenant registry unavailable: {e}"}]

    logger.info(
        "Scheduled ingestion starting: %d tenant(s) x %d collection(s)",
        len(tenant_list), len(INGEST_COLLECTIONS),
    )

    for tenant in tenant_list:
        if _scheduler_state["stop"].is_set():
            break
        for col in INGEST_COLLECTIONS:
            if _scheduler_state["stop"].is_set():
                break
            _scheduler_state["current_collection"] = f"{tenant.slug}/{col}"
            col_started = datetime.now(timezone.utc)
            try:
                res = _run_ingest(col, tenant_id=tenant.id)
                res["status"] = "ok"
            except Exception as e:
                logger.exception("Scheduled ingestion failed for %s/%s", tenant.slug, col)
                res = {"collection": col, "status": "error", "error": str(e)}
            col_finished = datetime.now(timezone.utc)
            res["tenant"] = tenant.slug
            res["tenant_id"] = tenant.id
            res["database"] = tenant.db_name
            res["started_at"] = col_started.isoformat()
            res["finished_at"] = col_finished.isoformat()
            res["duration_s"] = (col_finished - col_started).total_seconds()
            cycle_results.append(res)

    _scheduler_state["current_collection"] = None
    _scheduler_state["in_progress"] = False
    finished = datetime.now(timezone.utc)
    _scheduler_state["last_run_finished_at"] = finished.isoformat()
    _scheduler_state["last_results"] = cycle_results

    _record_run({
        "started_at": started,
        "finished_at": finished,
        "duration_s": (finished - started).total_seconds(),
        "trigger": _scheduler_state.pop("_trigger", "scheduled"),
        "results": cycle_results,
    })
    logger.info(
        "Scheduled ingestion cycle complete in %.1fs",
        (finished - started).total_seconds(),
    )
    return cycle_results


def _scheduler_loop():
    """Background loop: every INGEST_INTERVAL_HOURS, run a full ingestion cycle.

    First cycle runs ~30 seconds after startup so the API is responsive immediately.
    """
    interval_s = max(60.0, INGEST_INTERVAL_HOURS * 3600.0)
    # Initial delay so we don't hammer Mongo/vLLM on a cold boot
    initial_delay = 30.0
    _scheduler_state["next_run_at"] = (
        datetime.now(timezone.utc).timestamp() + initial_delay
    )
    if _scheduler_state["stop"].wait(initial_delay):
        return

    while not _scheduler_state["stop"].is_set():
        try:
            _run_scheduled_cycle()
        except Exception:
            logger.exception("Scheduler cycle crashed; will retry next interval")
        _scheduler_state["next_run_at"] = (
            datetime.now(timezone.utc).timestamp() + interval_s
        )
        if _scheduler_state["stop"].wait(interval_s):
            break


def _start_scheduler():
    with _scheduler_lock:
        if _scheduler_state["running"]:
            return
        if not SCHEDULER_ENABLED:
            logger.info("Ingestion scheduler disabled via INGEST_SCHEDULER_ENABLED=false")
            return
        if not INGEST_COLLECTIONS:
            logger.warning("INGEST_COLLECTIONS is empty — scheduler will not run")
            return
        _scheduler_state["stop"].clear()
        t = threading.Thread(target=_scheduler_loop, name="rag-ingest-scheduler", daemon=True)
        t.start()
        _scheduler_state["thread"] = t
        _scheduler_state["running"] = True
        logger.info(
            "Ingestion scheduler started — every %.2fh for collections: %s",
            INGEST_INTERVAL_HOURS, ", ".join(INGEST_COLLECTIONS),
        )


@app.on_event("startup")
def _on_startup_embedder():
    """Download (if missing) and load the embedding model at boot.

    Runs on a background thread so the API starts serving immediately: on a
    fresh deploy the first load is a ~520 MB download, and blocking startup on
    it would make the service look dead. Until it finishes, embedding-backed
    routes degrade rather than hang, and /api/rag/health reports the state.
    """
    if os.getenv("EMBED_WARMUP", "true").lower() not in ("1", "true", "yes", "on"):
        logger.info("Embedding warm-up disabled via EMBED_WARMUP.")
        return

    def _warm():
        import embedder as _embedder
        _EMBED_WARMUP.update(_embedder.warmup())

    threading.Thread(target=_warm, name="embed-warmup", daemon=True).start()
    logger.info("Embedding model warm-up started in the background.")


@app.on_event("startup")
def _on_startup_scheduler():
    _start_scheduler()


@app.on_event("shutdown")
def _on_shutdown_scheduler():
    _scheduler_state["stop"].set()


@app.on_event("startup")
def _prewarm_embedder():
    """Load the embedding model before the first officer needs it.

    Measured: 4,858 ms on first use, 12 ms warm. Paid by whoever asked first,
    which on a fresh process was one officer waiting five seconds for a model
    load that had nothing to do with their question. In a background thread, so
    a slow load delays no request and a failed load takes nothing down.
    """
    if os.getenv("AI_PREWARM_EMBEDDER", "true").strip().lower() in ("0", "false", "no", "off"):
        return

    def warm():
        try:
            t0 = time.perf_counter()
            get_embedder().embed_query("warmup")
            logger.info("embedder warm in %.0f ms", (time.perf_counter() - t0) * 1000)
        except Exception as exc:
            logger.warning("embedder pre-warm failed, first query will pay for it: %s", exc)
        # And the model. Measured over the real HTTP surface: the first question
        # after a restart took 72 s, nearly all of it Ollama loading 7B of
        # weights. The officer who asks first should not pay for the deployment.
        try:
            t0 = time.perf_counter()
            llm_generate("Reply with the single word: ready", temperature=0.0,
                         top_p=1.0, max_tokens=8, repetition_penalty=1.0)
            logger.info("llm warm in %.0f ms", (time.perf_counter() - t0) * 1000)
        except Exception as exc:
            logger.warning("llm pre-warm failed, first query will pay for it: %s", exc)

    threading.Thread(target=warm, name="assistant-prewarm", daemon=True).start()


@app.on_event("shutdown")
def _on_shutdown_mongo():
    """Close the pooled clients. Nothing else may close them: they are shared."""
    try:
        mongo_pool.close_all()
    except Exception as exc:
        logger.debug("closing the mongo pool failed: %s", exc)


@app.get("/api/rag/scheduler/status")
def scheduler_status():
    """Show scheduler config + current/last run details."""
    next_ts = _scheduler_state.get("next_run_at")
    return {
        "enabled": SCHEDULER_ENABLED,
        "running": _scheduler_state["running"],
        "interval_hours": INGEST_INTERVAL_HOURS,
        "collections": INGEST_COLLECTIONS,
        "in_progress": _scheduler_state["in_progress"],
        "current_collection": _scheduler_state["current_collection"],
        "last_run_started_at": _scheduler_state["last_run_started_at"],
        "last_run_finished_at": _scheduler_state["last_run_finished_at"],
        "next_run_at": (
            datetime.fromtimestamp(next_ts, tz=timezone.utc).isoformat() if next_ts else None
        ),
        "last_results": _scheduler_state["last_results"],
    }


@app.post("/api/rag/scheduler/run-now")
def scheduler_run_now():
    """Trigger an immediate ingestion cycle in the background (non-blocking)."""
    if _scheduler_state["in_progress"]:
        return {"queued": False, "message": "A cycle is already in progress"}
    _scheduler_state["_trigger"] = "manual"
    threading.Thread(target=_run_scheduled_cycle, name="rag-ingest-manual", daemon=True).start()
    return {"queued": True, "collections": INGEST_COLLECTIONS}


@app.get("/api/rag/scheduler/runs")
def scheduler_runs(limit: int = 20):
    """List recent scheduled ingestion cycles persisted in MongoDB."""
    try:
        col = _ingest_runs_col()
        cur = col.find({}, {"_id": 0}).sort("started_at", DESCENDING).limit(min(limit, 100))
        runs = []
        for r in cur:
            for k in ("started_at", "finished_at"):
                if isinstance(r.get(k), datetime):
                    r[k] = r[k].isoformat()
            runs.append(r)
        col.database.client.close()
        return {"runs": runs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/rag/stats")
def stats(tenant_id: Optional[str] = None):
    """Return ingestion stats across all vector collections."""
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client[_tenant_db(tenant_id)]
        all_cols = db.list_collection_names()
        vec_cols = [c for c in all_cols if c.startswith(VECTOR_COLLECTION)]

        result = {}
        for vc in vec_cols:
            col = db[vc]
            count = col.estimated_document_count()
            unique = 0
            if count > 0:
                # Aggregation avoids the 16MB cap that `distinct` hits on large collections.
                try:
                    agg = list(col.aggregate([
                        {"$group": {"_id": "$metadata.document_id"}},
                        {"$count": "n"},
                    ], allowDiskUse=True))
                    unique = agg[0]["n"] if agg else 0
                except Exception as e:
                    logger.warning("unique-doc count failed for %s: %s", vc, e)
            result[vc] = {"chunks": count, "unique_documents": unique}

        client.close()
        return {"database": _tenant_db(tenant_id), "vector_collections": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Daily Status Report (DSR)
#
# Generates a morning summary of the previous 24h of activity across the
# platform's main collections. Cached per UTC date in `rag_dsr` so repeated
# requests on the same day are cheap. Re-generated automatically every
# morning at DSR_HOUR_UTC (default 02:00 UTC ≈ 7:30 AM IST).
# ---------------------------------------------------------------------------

DSR_COLLECTION = os.getenv("DSR_COLLECTION", "rag_dsr")
DSR_HOUR_UTC = int(os.getenv("DSR_HOUR_UTC", "2"))  # 02:00 UTC ≈ 07:30 IST

# Restricts which collections the chatbot is allowed to search via the vector
# store enrichment step. We expose ALL operational modules (events, alerts,
# grievances, Dial 100 calls, POIs, profiles/sources, keywords, contents,
# daily programmes, telegram messages, and the reporting collections) so the
# assistant can answer questions across the entire OSINT portal — not just
# alerts/grievances. Override via the ALLOWED_QUERY_COLLECTIONS env var.
# Defined in query_collections so the validation harnesses search the same set
# the server does. The copies had already drifted.
ALLOWED_QUERY_COLLECTIONS = query_collections.allowed_collections()


def _yesterday_window():
    now = datetime.now(timezone.utc)
    end = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start = end - timedelta(days=1)
    return start, end


def _collect_dsr_data(tenant_id: Optional[str] = None) -> dict:
    """Pull yesterday's alerts + grievances from Mongo for the DSR."""
    start, end = _yesterday_window()
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    db = client[_tenant_db(tenant_id)]
    aq = {"created_at": {"$gte": start, "$lt": end}}

    # ── Alert counts by category and priority ────────────────────────────────
    total_alerts = db.alerts.count_documents(aq)
    high_alerts  = db.alerts.count_documents({**aq, "priority": "HIGH"})
    med_alerts   = db.alerts.count_documents({**aq, "priority": "MEDIUM"})

    cat_pipeline = [
        {"$match": aq},
        {"$group": {"_id": "$source_category", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    categories = {r["_id"] or "unknown": r["count"]
                  for r in db.alerts.aggregate(cat_pipeline)}

    # ── Platform breakdown ───────────────────────────────────────────────────
    plat_pipeline = [
        {"$match": aq},
        {"$group": {"_id": "$platform", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}}, {"$limit": 8},
    ]
    platforms = {r["_id"] or "unknown": r["count"]
                 for r in db.alerts.aggregate(plat_pipeline)}

    # ── Top HIGH-risk alerts (full fields for formatter) ─────────────────────
    top_alerts = list(db.alerts.find(
        {**aq, "priority": "HIGH"}, ALERT_FIELDS
    ).sort("created_at", DESCENDING).limit(20))

    # Also grab MEDIUM for breadth
    med_sample = list(db.alerts.find(
        {**aq, "priority": "MEDIUM"}, ALERT_FIELDS
    ).sort("created_at", DESCENDING).limit(8))

    # News-category alerts
    news_alerts = list(db.alerts.find(
        {**aq, "source_category": "news"}, ALERT_FIELDS
    ).sort("created_at", DESCENDING).limit(8))

    # ── Grievances (full fields with tweet text) ──────────────────────────────
    total_grievances = db.grievances.count_documents(aq)
    top_grievances = list(db.grievances.find(
        aq, GRIEVANCE_FIELDS
    ).sort("created_at", DESCENDING).limit(10))

    client.close()

    alerts_text = "\n\n".join(_fmt_alert(d, i+1) for i, d in enumerate(top_alerts))
    med_text    = "\n".join(_fmt_alert(d, i+1) for i, d in enumerate(med_sample))
    griev_text  = "\n\n".join(_fmt_grievance(d, i+1) for i, d in enumerate(top_grievances))

    # News-category alerts use the same alert formatter
    news_text   = "\n".join(_fmt_alert(d, i+1) for i, d in enumerate(news_alerts))

    return {
        "window": {"from": start.isoformat(), "to": end.isoformat()},
        "stats": {
            "total_alerts": total_alerts,
            "high_alerts": high_alerts,
            "medium_alerts": med_alerts,
            "total_grievances": total_grievances,
            "categories": categories,
            "platforms": platforms,
        },
        "alerts_text": alerts_text,
        "medium_alerts_text": med_text,
        "news_text": news_text or "(no news-category alerts)",
        "grievances_text": griev_text or "(no grievances)",
    }


def _build_dsr(force: bool = False, tenant_id: Optional[str] = None) -> dict:
    """Generate (or return cached) DSR for yesterday — alerts & grievances only."""
    start, _ = _yesterday_window()
    date_key = start.strftime("%Y-%m-%d")
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    db = client[_tenant_db(tenant_id)]
    cache = db[DSR_COLLECTION]
    cache.create_index("date", unique=True)
    if not force:
        existing = cache.find_one({"date": date_key})
        if existing:
            existing.pop("_id", None)
            client.close()
            return existing
    client.close()

    raw = _collect_dsr_data(tenant_id=tenant_id)
    s = raw["stats"]

    prompt = textwrap.dedent(f"""\
        You are the AI Assistant Daily Intelligence Briefer for **Telangana Police**
        (CP / DCP / SOC analysts). Produce a crisp morning briefing from the
        alerts and grievances data below (yesterday, {date_key}).

        Data summary:
          - Total alerts: {s['total_alerts']} | HIGH: {s['high_alerts']} | MEDIUM: {s['medium_alerts']}
          - Total grievances: {s['total_grievances']}
          - Alert categories: {s['categories']}
          - Platforms: {s['platforms']}

        Use EXACTLY these five Markdown sections:

        ## High-Risk Alerts
        Top 3 HIGH-priority alerts. For each bullet:
          • **@handle** (platform) — one-line incident description
          • Risk: what law-and-order threat it poses
          • Action: takedown / FIR [BNS section] / escalate to DCP / field unit alert

        ## Most Hyped Topics
        Top 3 most-active themes/handles driving volume. For each:
          • **Theme / @handle** — why it is trending, engagement signal
          • Action: monitor / engage / counter-narrative

        ## Police-Relevant News
        Up to 3 news-category alerts that are directly relevant to police
        operations, law-and-order, or public safety in Telangana. For each:
          • **Headline** (source, platform) — significance to police
          • Action: brief note

        ## Grievances Summary
        - Count, top districts, top categories.
        - Flag any high-priority or unresolved grievances needing attention.
        - Action: assign / escalate / close

        ## Analyst's Note
        2-3 bullets: patterns, coordinated activity, new risky entities/handles,
        or anything the CP should be personally aware of today.

        CRITICAL RULES:
        - Use ONLY real data from the sections below. Do NOT invent handles,
          headlines, or incidents not present in the data.
        - If a section has no data (e.g. zero HIGH alerts), write
          "No items in this category for this period." and move on.
        - Add _(General context: …)_ ONLY as a brief supplement to real data,
          never as a replacement for missing data.
        - Bold real entities, `@real_handles`, `code` for real BNS sections.

        === HIGH-RISK ALERTS ===
        {raw['alerts_text'] or '(none)'}

        === MEDIUM ALERTS (sample) ===
        {raw['medium_alerts_text'] or '(none)'}

        === NEWS-CATEGORY ALERTS ===
        {raw['news_text']}

        === GRIEVANCES ===
        {raw['grievances_text']}
    """)

    llm_summary = ""
    try:
        llm_summary = llm_generate(
            prompt,
            temperature=0.2,
            max_tokens=1200,
            timeout=600,
        )
    except Exception as exc:
        logger.warning("DSR LLM generation failed: %s", exc)
        llm_summary = "_(LLM briefing unavailable — vLLM not reachable.)_"

    # Build the final markdown: stats header + LLM briefing
    header = textwrap.dedent(f"""\
        # Daily Status Report — {date_key}
        _Window: {raw['window']['from'][:10]} (yesterday, IST)_

        | | |
        |---|---|
        | 🚨 Total Alerts | **{s['total_alerts']:,}** |
        | 🔴 HIGH Risk | **{s['high_alerts']:,}** |
        | 🟠 MEDIUM Risk | **{s['medium_alerts']:,}** |
        | 📋 Grievances | **{s['total_grievances']:,}** |

    """)
    full_md = header + llm_summary

    doc = {
        "date": date_key,
        "generated_at": datetime.now(timezone.utc),
        "window": raw["window"],
        "stats": s,
        # keep collections key for backward compat with frontend
        "collections": {
            "alerts": {"count": s["total_alerts"]},
            "alerts_high": {"count": s["high_alerts"]},
            "alerts_medium": {"count": s["medium_alerts"]},
            "grievances": {"count": s["total_grievances"]},
        },
        "total_count": s["total_alerts"] + s["total_grievances"],
        "markdown": full_md,
        "llm_summary": llm_summary,
    }
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    db = client[_tenant_db(tenant_id)]
    db[DSR_COLLECTION].update_one({"date": date_key}, {"$set": doc}, upsert=True)
    client.close()
    doc.pop("_id", None)
    if isinstance(doc.get("generated_at"), datetime):
        doc["generated_at"] = doc["generated_at"].isoformat()
    return doc


@app.get("/api/rag/dsr")
def get_dsr(force: bool = False):
    """Return today's morning DSR (yesterday's activity)."""
    try:
        doc = _build_dsr(force=force, tenant_id=tenant_id)
        if isinstance(doc.get("generated_at"), datetime):
            doc["generated_at"] = doc["generated_at"].isoformat()
        return doc
    except Exception as e:
        logger.exception("DSR build failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/rag/dsr/history")
def dsr_history(limit: int = 14, tenant_id: Optional[str] = None):
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        col = client[_tenant_db(tenant_id)][DSR_COLLECTION]
        docs = list(col.find({}, {"samples": 0}).sort("date", DESCENDING).limit(min(limit, 60)))
        client.close()
        for d in docs:
            d.pop("_id", None)
            if isinstance(d.get("generated_at"), datetime):
                d["generated_at"] = d["generated_at"].isoformat()
        return {"reports": docs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _dsr_scheduler_loop():
    """Generate the DSR once per day at DSR_HOUR_UTC."""
    while not _scheduler_state["stop"].is_set():
        now = datetime.now(timezone.utc)
        target = now.replace(hour=DSR_HOUR_UTC, minute=0, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        sleep_s = (target - now).total_seconds()
        logger.info("Next DSR generation at %s UTC (in %.0fs)", target.isoformat(), sleep_s)
        if _scheduler_state["stop"].wait(sleep_s):
            return
        try:
            _build_dsr(force=True)
            logger.info("Morning DSR generated.")
        except Exception:
            logger.exception("Morning DSR generation failed")


@app.on_event("startup")
def _start_dsr_scheduler():
    t = threading.Thread(target=_dsr_scheduler_loop, name="rag-dsr-scheduler", daemon=True)
    t.start()


# ---------------------------------------------------------------------------
# Top-50 Alerts endpoint
#
# Fetches all alerts from the last 24 hours, sends them to the vLLM LLM, which
# ranks and returns the top 50 most important unique alerts for police review.
# Each returned alert carries the original MongoDB document id so the frontend
# can render it with the existing AlertCard flow (acknowledge / escalate / etc.)
# ---------------------------------------------------------------------------

class TopAlertsRequest(BaseModel):
    hours: int = 24          # look-back window in hours (default 24h)
    top_n: int = 50          # number of top alerts to return
    tenant_id: str | None = None
    districts: List[str] | None = None


@app.post("/api/rag/top-alerts")
def top_alerts(req: TopAlertsRequest):
    tenant_id = _require_tenant(req.tenant_id)
    """Fetch all alerts from the last N hours, ask the vLLM LLM to rank the top-50
    unique most-important ones, and return them with full document data."""
    hours = max(1, min(req.hours, 168))   # clamp 1h–7d
    top_n = max(1, min(req.top_n, 100))
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client[_tenant_db(tenant_id)]
        raw_docs = list(db.alerts.find(
            {"created_at": {"$gte": cutoff}},
            ALERT_FIELDS
        ).sort("created_at", DESCENDING).limit(2000))
        client.close()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB error: {e}")

    if not raw_docs:
        return {"alerts": [], "total_scanned": 0, "hours": hours,
                "message": f"No alerts found in the last {hours} hour(s)."}

    # Build a compact index for the LLM (id → snippet)
    # Deduplicate by author_handle to avoid flooding with the same source
    seen_handles: set = set()
    candidates: list = []   # (doc, snippet) pairs
    for d in raw_docs:
        # Use the UUID 'id' field — that's what the Node backend /api/alerts/bulk expects
        uuid_id = d.get("id") or str(d["_id"])
        handle = (d.get("author_handle") or d.get("author") or "").lstrip("@").lower()
        llm = d.get("llm_analysis") or {}
        threat = d.get("threat_details") or {}
        vdata = d.get("velocity_data") or {}
        score = threat.get("risk_score") or llm.get("score") or 0
        reasoning = (d.get("classification_explanation") or llm.get("reasoning") or "").strip()
        if "Primary AI analysis unavailable" in reasoning:
            reasoning = ""
        dedup_key = f"{handle}_{d.get('source_category','?')}_{d.get('alert_type','?')}"
        if dedup_key in seen_handles:
            continue
        seen_handles.add(dedup_key)
        ts = d.get("created_at")
        ts_s = ts.strftime("%d-%b %H:%M") if isinstance(ts, datetime) else "?"
        vinfo = (f"viral:{vdata.get('metric','?')} velocity={vdata.get('velocity','?')}"
                 if vdata.get("velocity") else "")
        snippet = (
            f"ID:{uuid_id} | pri={d.get('priority','?')} | risk={d.get('risk_level','?')} "
            f"| score={score}% | cat={d.get('source_category','?')} | type={d.get('alert_type','?')}\n"
            f"  @{handle} on {d.get('platform','?')} | {ts_s} {vinfo}\n"
            f"  URL: {d.get('content_url','')}\n"
            + (f"  Analysis: {reasoning[:250]}\n" if reasoning else "")
        )
        candidates.append((d, snippet, uuid_id))

    total_unique = len(candidates)

    # Build the LLM prompt
    candidates_text = "\n".join(s for _, s, _ in candidates)
    prompt = textwrap.dedent(f"""\
        You are a Telangana Police SOC analyst. Below are {total_unique} unique alerts
        from the last {hours} hour(s). Your task:

        1. Select the TOP {top_n} most important alerts that require police attention.
        2. Rank criteria (highest weight first):
           a. Direct threat to public order / communal violence / hate speech with legal implications
           b. High velocity / viral spread (rapid reach = rapid harm)
           c. High risk score (80%+)
           d. Sensitive categories: communal > political > defamation > narcotics > history_sheeters
           e. Novelty — prefer diverse handles over repeated entries from the same author

        3. Output ONLY a JSON array of the selected alert IDs in ranked order, like:
           ["id1","id2","id3",...]
           Do NOT output anything else — no explanation, no markdown, no extra text.
           The IDs must be taken EXACTLY as they appear in "ID:..." lines below.

        ALERTS:
        {candidates_text}
    """)

    try:
        raw_response = llm_generate(
            prompt,
            temperature=0.0,
            max_tokens=2048,
            timeout=300,
        )
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"LLM error: {e}")

    # Parse the JSON array from the LLM response
    import json as _json
    ranked_ids: list = []
    try:
        # Extract the JSON array — handle LLM wrapping it in ```json ... ```
        match = re.search(r"\[.*?\]", raw_response, re.DOTALL)
        if match:
            ranked_ids = _json.loads(match.group(0))
    except Exception:
        pass

    if not ranked_ids:
        logger.warning("top-alerts LLM parse failed; falling back to rule-based ranking")
        priority_weight = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}
        candidates.sort(key=lambda x: (
            -priority_weight.get(x[0].get("priority", "LOW"), 0),
            -(x[0].get("threat_details") or {}).get("risk_score", 0),
        ))
        ranked_ids = [uid for _, _, uid in candidates[:top_n]]

    # Build uuid_id → doc map
    doc_map = {uid: d for d, _, uid in candidates}

    # Assemble final list in ranked order, deduplicated
    seen_ids: set = set()
    result_docs = []
    for rid in ranked_ids:
        if rid in seen_ids or rid not in doc_map:
            continue
        seen_ids.add(rid)
        d = doc_map[rid]
        out = {k: v for k, v in d.items() if k != "_id"}
        out["id"] = rid   # always the UUID string from the 'id' field
        if isinstance(out.get("created_at"), datetime):
            out["created_at"] = out["created_at"].isoformat()
        result_docs.append(out)

    # Fill to top_n with highest-scored unseen ones
    if len(result_docs) < top_n:
        priority_weight = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}
        remaining = sorted(
            [(d, uid) for d, _, uid in candidates if uid not in seen_ids],
            key=lambda x: (
                -priority_weight.get(x[0].get("priority", "LOW"), 0),
                -(x[0].get("threat_details") or {}).get("risk_score", 0),
            )
        )
        for d, uid in remaining[: top_n - len(result_docs)]:
            out = {k: v for k, v in d.items() if k != "_id"}
            out["id"] = uid
            if isinstance(out.get("created_at"), datetime):
                out["created_at"] = out["created_at"].isoformat()
            result_docs.append(out)

    date_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    run_doc = {
        "date": date_key,
        "generated_at": datetime.now(timezone.utc),
        "hours": hours,
        "total_scanned": len(raw_docs),
        "total_unique": total_unique,
        "top_n": len(result_docs),
        # Store only the alert IDs + lightweight metadata to keep the doc small
        "alert_ids": [a["id"] for a in result_docs],
        "alert_meta": [
            {
                "id": a["id"],
                "priority": a.get("priority"),
                "risk_level": a.get("risk_level"),
                "source_category": a.get("source_category"),
                "platform": a.get("platform"),
                "author_handle": a.get("author_handle") or a.get("author"),
                "content_url": a.get("content_url"),
                "created_at": a.get("created_at"),
                "threat_details": a.get("threat_details"),
                "velocity_data": a.get("velocity_data"),
                "classification_explanation": a.get("classification_explanation"),
            }
            for a in result_docs
        ],
    }
    try:
        client2 = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        col2 = client2[DB_NAME]["rag_top_alerts"]
        col2.create_index([("date", 1), ("hours", 1)])
        col2.update_one(
            {"date": date_key, "hours": hours},
            {"$set": run_doc},
            upsert=True,
        )
        client2.close()
    except Exception as e:
        logger.warning("Failed to persist top-alerts run: %s", e)

    return {
        "alerts": result_docs,
        "total_scanned": len(raw_docs),
        "total_unique": total_unique,
        "top_n": len(result_docs),
        "hours": hours,
        "date": date_key,
    }


# ---------------------------------------------------------------------------
# Per-category Top-N Alerts endpoint
#
# Returns up to `top_n_per_category` LLM-ranked alerts for EACH source_category
# (communal, political, defamation, narcotics, history_sheeters, trouble_makers,
# others). The LLM is called once per category in parallel.
# ---------------------------------------------------------------------------

CATEGORY_KEYS = [
    "communal", "political", "defamation",
    "narcotics", "history_sheeters", "trouble_makers", "others",
]


class TopAlertsByCategoryRequest(BaseModel):
    hours: int = 24                  # look-back window
    top_n_per_category: int = 50     # max per category
    categories: Optional[list] = None  # restrict to a subset; default = all
    tenant_id: str | None = None
    districts: List[str] | None = None


def _rank_category_via_llm(category: str, candidates: list, top_n: int, hours: int) -> list:
    """Call the vLLM LLM once for a single category and return ranked uuid IDs,
    up to min(top_n, len(candidates)). After the LLM picks, pad with
    priority+risk-score sorted candidates not already chosen so the result
    always fills available capacity. Falls back fully to rule-based ranking
    if the LLM is unreachable or returns nothing parseable."""
    if not candidates:
        return []

    target = min(top_n, len(candidates))
    snippets = "\n".join(s for _, s, _ in candidates)

    # Pre-compute the rule-based fallback order once — used both as fallback
    # and to pad short LLM responses.
    priority_weight = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}
    rule_order = sorted(
        candidates,
        key=lambda x: (
            -priority_weight.get(x[0].get("priority", "LOW"), 0),
            -(x[0].get("threat_details") or {}).get("risk_score", 0),
        ),
    )
    rule_ids = [uid for _, _, uid in rule_order]

    prompt = textwrap.dedent(f"""\
        You are a Telangana Police SOC analyst reviewing alerts in the
        "{category}" category from the last {hours} hour(s).

        TASK: Return the top {target} most important alert IDs from the list below,
        ranked from MOST important to LEAST important.
        - If there are fewer than {target} alerts in the list, return ALL of them
          ranked in order.
        - Do NOT skip alerts: every alert in the list should appear in your
          output unless you are returning the full {target}-item cap.
        - Ranking priority (highest first):
            a. Direct threat to public order / law-and-order incidents
            b. High velocity / viral spread
            c. High risk score (80%+)
            d. Diverse handles — prefer variety over repeating the same author

        Output ONLY a JSON array of the alert IDs in ranked order:
          ["id1","id2","id3",...]
        No explanation. No markdown. IDs must be taken EXACTLY as shown in "ID:" lines.
        Your array MUST contain {target} IDs (or all alerts if fewer than {target} were supplied).

        ALERTS ({len(candidates)} total):
        {snippets}
    """)

    ranked_ids: list = []
    try:
        raw = llm_generate(
            prompt,
            temperature=0.0,
            max_tokens=4096,
            timeout=300,
        )
        import json as _json
        # Greedy match so a [..] containing newlines is captured whole
        match = re.search(r"\[.*\]", raw, re.DOTALL)
        if match:
            ranked_ids = _json.loads(match.group(0))
    except Exception as e:
        logger.warning("LLM ranking failed for category=%s: %s", category, e)

    # Keep only valid IDs (the LLM occasionally hallucinates), de-dup
    valid_ids = {uid for _, _, uid in candidates}
    seen: set = set()
    out: list = []
    for rid in ranked_ids:
        if rid in valid_ids and rid not in seen:
            seen.add(rid)
            out.append(rid)
            if len(out) >= target:
                break

    # Pad with rule-based ranked candidates not yet chosen, until we hit target
    if len(out) < target:
        for rid in rule_ids:
            if rid not in seen:
                seen.add(rid)
                out.append(rid)
                if len(out) >= target:
                    break

    return out


@app.post("/api/rag/top-alerts/by-category")
def top_alerts_by_category(req: TopAlertsByCategoryRequest):
    tenant_id = _require_tenant(req.tenant_id)
    """For each source_category, ask the vLLM LLM to rank the top-N most important
    alerts. Runs categories in parallel for latency. Returns a flat list of
    ranked alerts (preserving per-category internal order) plus per-category
    counts and breakdown."""
    hours = max(1, min(req.hours, 168))
    top_n = max(1, min(req.top_n_per_category, 100))
    requested_subset = {c.strip().lower() for c in (req.categories or []) if c}
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = client[_tenant_db(tenant_id)]
        # Larger pool than the single-LLM endpoint since we're partitioning across categories
        raw_docs = list(db.alerts.find(
            {"created_at": {"$gte": cutoff}},
            ALERT_FIELDS,
        ).sort("created_at", DESCENDING).limit(5000))
        client.close()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MongoDB error: {e}")

    if not raw_docs:
        return {"alerts": [], "categories": {}, "total_scanned": 0,
                "total_unique": 0, "top_n_per_category": top_n, "hours": hours,
                "message": f"No alerts found in the last {hours} hour(s)."}

    # Build candidates bucketed by the alert's ACTUAL source_category value
    # (so 'unknown', 'others', or any future category gets its own bucket and
    # matches the frontend chip display). Dedupe per (handle + alert_type)
    # within each bucket.
    buckets: dict = {}
    seen_per_cat: dict = {}
    for d in raw_docs:
        cat = (d.get("source_category") or "others").strip().lower() or "others"
        if requested_subset and cat not in requested_subset:
            continue
        if cat not in buckets:
            buckets[cat] = []
            seen_per_cat[cat] = set()
        uuid_id = d.get("id") or str(d["_id"])
        handle = (d.get("author_handle") or d.get("author") or "").lstrip("@").lower()
        dedup_key = f"{handle}_{d.get('alert_type','?')}"
        if dedup_key in seen_per_cat[cat]:
            continue
        seen_per_cat[cat].add(dedup_key)

        llm = d.get("llm_analysis") or {}
        threat = d.get("threat_details") or {}
        vdata = d.get("velocity_data") or {}
        score = threat.get("risk_score") or llm.get("score") or 0
        reasoning = (d.get("classification_explanation") or llm.get("reasoning") or "").strip()
        if "Primary AI analysis unavailable" in reasoning:
            reasoning = ""
        ts = d.get("created_at")
        ts_s = ts.strftime("%d-%b %H:%M") if isinstance(ts, datetime) else "?"
        vinfo = (f"viral:{vdata.get('metric','?')} velocity={vdata.get('velocity','?')}"
                 if vdata.get("velocity") else "")
        snippet = (
            f"ID:{uuid_id} | pri={d.get('priority','?')} | risk={d.get('risk_level','?')} "
            f"| score={score}% | type={d.get('alert_type','?')}\n"
            f"  @{handle} on {d.get('platform','?')} | {ts_s} {vinfo}\n"
            f"  URL: {d.get('content_url','')}\n"
            + (f"  Analysis: {reasoning[:250]}\n" if reasoning else "")
        )
        buckets[cat].append((d, snippet, uuid_id))

    total_unique = sum(len(b) for b in buckets.values())

    # Rank each category in parallel via the LLM
    ranked_by_cat: dict = {}
    cats_to_rank = [(c, items) for c, items in buckets.items() if items]
    with ThreadPoolExecutor(max_workers=min(4, len(cats_to_rank) or 1)) as ex:
        futures = {
            ex.submit(_rank_category_via_llm, cat, items, top_n, hours): cat
            for cat, items in cats_to_rank
        }
        for fut in as_completed(futures):
            cat = futures[fut]
            try:
                ranked_by_cat[cat] = fut.result()
            except Exception as e:
                logger.warning("category rank failed for %s: %s", cat, e)
                ranked_by_cat[cat] = []

    # Assemble flat result. Iterate categories in CATEGORY_KEYS order first
    # (so known/important categories appear first), then any extras alphabetically.
    ordered_cats = [c for c in CATEGORY_KEYS if c in buckets] + \
                   sorted([c for c in buckets.keys() if c not in CATEGORY_KEYS])

    seen_ids: set = set()
    result_docs: list = []
    category_summary: dict = {}
    for cat in ordered_cats:
        bucket_items = buckets[cat]
        if not bucket_items:
            category_summary[cat] = {"count": 0, "candidates": 0}
            continue
        doc_map = {uid: d for d, _, uid in bucket_items}
        per_cat = []
        for rid in ranked_by_cat.get(cat, []):
            if rid in seen_ids or rid not in doc_map:
                continue
            seen_ids.add(rid)
            d = doc_map[rid]
            out = {k: v for k, v in d.items() if k != "_id"}
            out["id"] = rid
            if isinstance(out.get("created_at"), datetime):
                out["created_at"] = out["created_at"].isoformat()
            per_cat.append(out)
        result_docs.extend(per_cat)
        category_summary[cat] = {"count": len(per_cat), "candidates": len(bucket_items)}

    date_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    run_doc = {
        "date": date_key,
        "mode": "by_category",
        "generated_at": datetime.now(timezone.utc),
        "hours": hours,
        "total_scanned": len(raw_docs),
        "total_unique": total_unique,
        "top_n_per_category": top_n,
        "categories": category_summary,
        "alert_ids": [a["id"] for a in result_docs],
        "alert_meta": [
            {
                "id": a["id"],
                "priority": a.get("priority"),
                "risk_level": a.get("risk_level"),
                "source_category": a.get("source_category"),
                "platform": a.get("platform"),
                "author_handle": a.get("author_handle") or a.get("author"),
                "content_url": a.get("content_url"),
                "created_at": a.get("created_at"),
                "threat_details": a.get("threat_details"),
                "velocity_data": a.get("velocity_data"),
                "classification_explanation": a.get("classification_explanation"),
            }
            for a in result_docs
        ],
    }
    try:
        client2 = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        col2 = client2[DB_NAME]["rag_top_alerts"]
        col2.create_index([("date", 1), ("hours", 1), ("mode", 1)])
        col2.update_one(
            {"date": date_key, "hours": hours, "mode": "by_category"},
            {"$set": run_doc},
            upsert=True,
        )
        client2.close()
    except Exception as e:
        logger.warning("Failed to persist per-category top-alerts run: %s", e)

    return {
        "alerts": result_docs,
        "categories": category_summary,
        "total_scanned": len(raw_docs),
        "total_unique": total_unique,
        "top_n_per_category": top_n,
        "hours": hours,
        "date": date_key,
    }


# ---------------------------------------------------------------------------
# Daily Intelligence Report (DIR)
#
# A comprehensive daily social-media intelligence digest covering:
#   • Trending topics & keywords
#   • Viral/high-velocity posts with links
#   • Platform-wise and region-wise analysis
#   • Sentiment breakdown
#   • Most active accounts
#   • AI-generated narrative summary
#   • Threat/relevance scores
#   • Category classification (Politics, Crime, Entertainment, etc.)
#
# Stored in `rag_dir` collection, auto-generated every 24h.
# ---------------------------------------------------------------------------

DIR_COLLECTION = os.getenv("DIR_COLLECTION", "rag_dir")
DIR_HOUR_UTC    = int(os.getenv("DIR_HOUR_UTC", "3"))   # 03:00 UTC ≈ 08:30 IST

# Map internal source_category values to human-readable labels
_CATEGORY_LABELS = {
    "communal":        "Communal / Religious",
    "political":       "Politics",
    "crime":           "Crime",
    "narcotics":       "Narcotics",
    "defamation":      "Defamation",
    "hate_speech":     "Hate Speech",
    "public_order":    "Public Order",
    "news":            "News",
    "entertainment":   "Entertainment",
    "misinformation":  "Misinformation",
    "violence":        "Violence",
    "terrorism":       "Terrorism",
    "cybercrime":      "Cybercrime",
    "other":           "Other",
    "unknown":         "Unclassified",
}


def _sentiment_label(s: str) -> str:
    if not s:
        return "neutral"
    sl = s.lower()
    if any(w in sl for w in ["negative", "anger", "hostile", "hate", "threat"]):
        return "negative"
    if any(w in sl for w in ["positive", "support", "praise"]):
        return "positive"
    return "neutral"


def _enrich_with_content(db, alerts_list: list) -> list:
    """Join alerts with the `contents` collection to add full post text and media URLs.

    Each alert gets new keys:
      • text          — the full post text
      • media         — list of {type, url, video_url, thumbnail_url, s3_url}
      • quoted_text   — text of the quoted/retweeted post (X only)
      • quoted_media  — media of the quoted post
    """
    if not alerts_list:
        return alerts_list
    content_ids = list({a.get("content_id") for a in alerts_list if a.get("content_id")})
    if not content_ids:
        return alerts_list
    try:
        content_docs = list(db.contents.find(
            {"id": {"$in": content_ids}},
            {"_id": 0, "id": 1, "text": 1, "media": 1, "quoted_content": 1,
             "engagement": 1, "published_at": 1, "scraped_content": 1},
        ))
        cmap = {c["id"]: c for c in content_docs}
        for a in alerts_list:
            cid = a.get("content_id")
            c = cmap.get(cid) if cid else None
            if not c:
                a["text"] = ""
                a["media"] = []
                continue
            a["text"] = (c.get("text") or c.get("scraped_content") or "")[:2000]
            # Normalise media: prefer s3_url for cross-origin reliability, fall back to url
            media_items = []
            for m in (c.get("media") or [])[:10]:
                if not isinstance(m, dict):
                    continue
                mtype = m.get("type") or "photo"
                url = m.get("s3_url") or m.get("url") or ""
                video_url = m.get("s3_url") if mtype in ("video", "animated_gif") else m.get("video_url")
                if not url and not video_url:
                    continue
                media_items.append({
                    "type": mtype,
                    "url": url,
                    "video_url": video_url or "",
                    "thumbnail_url": m.get("thumbnail_url") or url,
                })
            a["media"] = media_items
            qc = c.get("quoted_content") or {}
            if qc:
                a["quoted_text"] = (qc.get("text") or "")[:1000]
                qmedia = []
                for m in (qc.get("media") or [])[:6]:
                    if not isinstance(m, dict):
                        continue
                    mtype = m.get("type") or "photo"
                    url = m.get("s3_url") or m.get("url") or ""
                    video_url = m.get("s3_url") if mtype in ("video", "animated_gif") else m.get("video_url")
                    if not url and not video_url:
                        continue
                    qmedia.append({
                        "type": mtype,
                        "url": url,
                        "video_url": video_url or "",
                        "thumbnail_url": m.get("thumbnail_url") or url,
                    })
                a["quoted_media"] = qmedia
            eng = c.get("engagement") or {}
            if eng:
                a["engagement"] = {
                    "likes": eng.get("likes") or eng.get("like_count") or 0,
                    "shares": eng.get("retweets") or eng.get("shares") or eng.get("share_count") or 0,
                    "comments": eng.get("replies") or eng.get("comments") or eng.get("comment_count") or 0,
                    "views": eng.get("views") or eng.get("view_count") or 0,
                }
    except Exception as e:
        logger.warning("Failed to enrich alerts with content: %s", e)
    return alerts_list


def _collect_dir_data(hours: int = 24, tenant_id: Optional[str] = None) -> dict:
    """Pull comprehensive social-media intelligence data for the DIR."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    db = client[_tenant_db(tenant_id)]
    aq = {"created_at": {"$gte": cutoff}}

    # ── 1. Trending topics (from matched keywords) ───────────────────────────
    kw_pipeline = [
        {"$match": {**aq, "matched_keywords_normalized": {"$exists": True, "$not": {"$size": 0}}}},
        {"$unwind": "$matched_keywords_normalized"},
        {"$match": {"matched_keywords_normalized": {"$ne": None, "$ne": ""}}},
        {"$group": {
            "_id": "$matched_keywords_normalized",
            "count": {"$sum": 1},
            "platforms": {"$addToSet": "$platform"},
            "high_count": {"$sum": {"$cond": [{"$eq": ["$priority", "HIGH"]}, 1, 0]}},
            "categories": {"$addToSet": "$source_category"},
        }},
        {"$sort": {"count": -1}},
        {"$limit": 25},
    ]
    trending_keywords = list(db.alerts.aggregate(kw_pipeline))

    # ── 2. Platform breakdown with sentiment distribution ────────────────────
    plat_pipeline = [
        {"$match": aq},
        {"$group": {
            "_id": "$platform",
            "total":      {"$sum": 1},
            "high_risk":  {"$sum": {"$cond": [{"$eq": ["$priority", "HIGH"]}, 1, 0]}},
            "medium_risk":{"$sum": {"$cond": [{"$eq": ["$priority", "MEDIUM"]}, 1, 0]}},
            "avg_risk_score": {"$avg": "$threat_details.risk_score"},
            "sentiments": {"$push": "$llm_analysis.sentiment"},
        }},
        {"$sort": {"total": -1}},
        {"$limit": 10},
    ]
    platform_data_raw = list(db.alerts.aggregate(plat_pipeline))
    # Compute sentiment ratios per platform
    platform_data = []
    for p in platform_data_raw:
        sents = [_sentiment_label(s) for s in (p.get("sentiments") or []) if s]
        total_s = len(sents) or 1
        p["sentiment_breakdown"] = {
            "negative": round(sents.count("negative") / total_s * 100),
            "positive": round(sents.count("positive") / total_s * 100),
            "neutral":  round(sents.count("neutral")  / total_s * 100),
        }
        p.pop("sentiments", None)
        p["avg_risk_score"] = round(p.get("avg_risk_score") or 0, 1)
        platform_data.append(p)

    # ── 3. Viral / high-velocity posts ──────────────────────────────────────
    viral_posts_raw = list(db.alerts.find(
        {**aq, "velocity_data.velocity": {"$gt": 0}},
        {**ALERT_FIELDS, "velocity_data": 1, "content_url": 1, "title": 1},
    ).sort("velocity_data.velocity", DESCENDING).limit(15))
    viral_posts = []
    for d in viral_posts_raw:
        vdata = d.get("velocity_data") or {}
        llm = d.get("llm_analysis") or {}
        threat = d.get("threat_details") or {}
        ts = d.get("created_at")
        viral_posts.append({
            "id": str(d.get("id") or d["_id"]),
            "author_handle": (d.get("author_handle") or d.get("author") or "?").lstrip("@"),
            "platform": d.get("platform", "?"),
            "content_url": d.get("content_url", ""),
            "priority": d.get("priority", "?"),
            "source_category": d.get("source_category", "?"),
            "alert_type": d.get("alert_type", "?"),
            "velocity": vdata.get("velocity", 0),
            "velocity_metric": vdata.get("metric", ""),
            "velocity_window_min": vdata.get("time_window_minutes", "?"),
            "risk_score": threat.get("risk_score") or llm.get("score") or 0,
            "sentiment": llm.get("sentiment", ""),
            "reasoning": (d.get("classification_explanation") or llm.get("reasoning") or "")[:200],
            "timestamp": ts.isoformat() if isinstance(ts, datetime) else str(ts or ""),
        })

    # ── 4. Most active accounts ──────────────────────────────────────────────
    account_pipeline = [
        {"$match": aq},
        {"$group": {
            "_id": {"$ifNull": ["$author_handle", "$author"]},
            "count": {"$sum": 1},
            "high_count": {"$sum": {"$cond": [{"$eq": ["$priority", "HIGH"]}, 1, 0]}},
            "categories": {"$addToSet": "$source_category"},
            "platforms":  {"$addToSet": "$platform"},
            "max_risk":   {"$max": "$threat_details.risk_score"},
            "last_seen":  {"$max": "$created_at"},
            "sample_url": {"$first": "$content_url"},
        }},
        {"$match": {"_id": {"$ne": None, "$ne": ""}}},
        {"$sort": {"count": -1}},
        {"$limit": 15},
    ]
    active_accounts_raw = list(db.alerts.aggregate(account_pipeline))
    active_accounts = []
    for a in active_accounts_raw:
        ls = a.get("last_seen")
        active_accounts.append({
            "handle": (a.get("_id") or "?").lstrip("@"),
            "alert_count": a["count"],
            "high_risk_count": a.get("high_count", 0),
            "categories": [c for c in (a.get("categories") or []) if c],
            "platforms": [p for p in (a.get("platforms") or []) if p],
            "max_risk_score": a.get("max_risk") or 0,
            "last_seen": ls.isoformat() if isinstance(ls, datetime) else str(ls or ""),
            "sample_url": a.get("sample_url", ""),
        })

    # ── 5. Category breakdown ────────────────────────────────────────────────
    cat_pipeline = [
        {"$match": aq},
        {"$group": {
            "_id": "$source_category",
            "count": {"$sum": 1},
            "high_risk": {"$sum": {"$cond": [{"$eq": ["$priority", "HIGH"]}, 1, 0]}},
            "avg_risk_score": {"$avg": "$threat_details.risk_score"},
            "platforms": {"$addToSet": "$platform"},
        }},
        {"$sort": {"count": -1}},
    ]
    categories_raw = list(db.alerts.aggregate(cat_pipeline))
    categories = []
    for c in categories_raw:
        raw_cat = c.get("_id") or "unknown"
        categories.append({
            "category": raw_cat,
            "label": _CATEGORY_LABELS.get(raw_cat, raw_cat.replace("_", " ").title()),
            "count": c["count"],
            "high_risk": c.get("high_risk", 0),
            "avg_risk_score": round(c.get("avg_risk_score") or 0, 1),
            "platforms": [p for p in (c.get("platforms") or []) if p],
        })

    # ── 6. Overall sentiment analysis ────────────────────────────────────────
    sent_pipeline = [
        {"$match": {**aq, "llm_analysis.sentiment": {"$exists": True, "$ne": None}}},
        {"$group": {"_id": "$llm_analysis.sentiment", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]
    sentiment_raw = list(db.alerts.aggregate(sent_pipeline))
    # Normalise to negative / positive / neutral buckets
    sent_buckets: dict = {"negative": 0, "positive": 0, "neutral": 0, "others": {}}
    for s in sentiment_raw:
        label = _sentiment_label(s.get("_id", ""))
        if label in sent_buckets:
            sent_buckets[label] += s["count"]
        else:
            sent_buckets["others"][s.get("_id", "?")] = s["count"]

    # ── 7. High-threat posts with links ──────────────────────────────────────
    threat_posts_raw = list(db.alerts.find(
        {**aq, "priority": "HIGH"},
        ALERT_FIELDS,
    ).sort([("threat_details.risk_score", DESCENDING), ("created_at", DESCENDING)]).limit(20))
    threat_posts = []
    for d in threat_posts_raw:
        llm = d.get("llm_analysis") or {}
        threat = d.get("threat_details") or {}
        ts = d.get("created_at")
        vdata = d.get("velocity_data") or {}
        legal = _safe_join(d.get("legal_sections"))
        reasoning = (d.get("classification_explanation") or llm.get("reasoning") or "").strip()
        if "Primary AI analysis unavailable" in reasoning:
            reasoning = ""
        threat_posts.append({
            "id": str(d.get("id") or d["_id"]),
            "author_handle": (d.get("author_handle") or d.get("author") or "?").lstrip("@"),
            "platform": d.get("platform", "?"),
            "content_url": d.get("content_url", ""),
            "alert_type": d.get("alert_type", "?"),
            "source_category": d.get("source_category", "?"),
            "risk_score": threat.get("risk_score") or llm.get("score") or 0,
            "priority": d.get("priority", "?"),
            "sentiment": llm.get("sentiment", ""),
            "legal_sections": legal,
            "reasoning": reasoning[:250],
            "velocity": vdata.get("velocity", 0),
            "timestamp": ts.isoformat() if isinstance(ts, datetime) else str(ts or ""),
            "keywords": d.get("matched_keywords_normalized") or [],
        })

    # ── 8. Summary stats ─────────────────────────────────────────────────────
    total_alerts     = db.alerts.count_documents(aq)
    high_alerts      = db.alerts.count_documents({**aq, "priority": "HIGH"})
    med_alerts       = db.alerts.count_documents({**aq, "priority": "MEDIUM"})
    active_alerts    = db.alerts.count_documents({**aq, "status": "active"})
    escalated_alerts = db.alerts.count_documents({**aq, "status": "escalated"})
    total_grievances = db.grievances.count_documents(aq)

    # ── 9. Dial 100 calls in window ──────────────────────────────────────────
    # Real records use either `date` (call timestamp) or `createdAt`.
    dial100_q = {"$or": [
        {"date":      {"$gte": cutoff}},
        {"createdAt": {"$gte": cutoff}},
    ]}
    dial100_total = (
        db.dial100incidents.count_documents(dial100_q)
        if "dial100incidents" in db.list_collection_names() else 0
    )

    # ── 10. Grievance-family breakdown ───────────────────────────────────────
    existing_cols = set(db.list_collection_names())
    grievance_breakdown = {
        "grievances":                  db.grievances.count_documents(aq) if "grievances" in existing_cols else 0,
        "criticism_reports":           0,
        "suggestion_reports":          0,
        "grievance_workflow_reports":  0,
        "workflow_escalated":          0,
        "workflow_pending":            0,
        "workflow_closed":             0,
    }
    if "criticism_reports" in existing_cols:
        grievance_breakdown["criticism_reports"] = db.criticism_reports.count_documents(
            {"$or": [{"created_at": {"$gte": cutoff}}, {"createdAt": {"$gte": cutoff}}]}
        )
    if "suggestion_reports" in existing_cols:
        grievance_breakdown["suggestion_reports"] = db.suggestion_reports.count_documents(
            {"$or": [{"created_at": {"$gte": cutoff}}, {"createdAt": {"$gte": cutoff}}]}
        )
    if "grievance_workflow_reports" in existing_cols:
        wf_q = {"$or": [{"created_at": {"$gte": cutoff}}, {"createdAt": {"$gte": cutoff}}]}
        grievance_breakdown["grievance_workflow_reports"] = db.grievance_workflow_reports.count_documents(wf_q)
        grievance_breakdown["workflow_escalated"] = db.grievance_workflow_reports.count_documents(
            {**wf_q, "status": "ESCALATED"}
        )
        grievance_breakdown["workflow_pending"] = db.grievance_workflow_reports.count_documents(
            {**wf_q, "status": "PENDING"}
        )
        grievance_breakdown["workflow_closed"] = db.grievance_workflow_reports.count_documents(
            {**wf_q, "status": "CLOSED"}
        )

    # ── 11. Events: fetched vs relevant ──────────────────────────────────────
    events_breakdown = {"fetched": 0, "relevant": 0, "active": 0, "recent": []}
    if "events" in existing_cols:
        ev_q = {"$or": [{"created_at": {"$gte": cutoff}}, {"start_date": {"$gte": cutoff}}]}
        events_breakdown["fetched"] = db.events.count_documents(ev_q)
        # "Relevant" = events that produced alerts in the same window (linked via event_ids)
        # OR are currently active.
        events_breakdown["active"] = db.events.count_documents(
            {**ev_q, "status": {"$in": ["active", "planned"]}}
        )
        try:
            relevant_event_ids = db.alerts.distinct("event_ids", aq) or []
            relevant_event_ids = [e for e in relevant_event_ids if e]
            events_breakdown["relevant"] = (
                db.events.count_documents({"_id": {"$in": relevant_event_ids}})
                if relevant_event_ids else events_breakdown["active"]
            )
        except Exception:
            events_breakdown["relevant"] = events_breakdown["active"]
        # Top 10 recent events
        recent_ev = list(db.events.find(
            ev_q,
            {"_id": 1, "name": 1, "start_date": 1, "end_date": 1, "location": 1,
             "status": 1, "platforms": 1, "keywords": 1},
        ).sort("start_date", DESCENDING).limit(10))
        for e in recent_ev:
            kws = ", ".join((k.get("keyword") or "") for k in (e.get("keywords") or [])[:5])
            events_breakdown["recent"].append({
                "id":         str(e.get("_id")),
                "name":       e.get("name", "?"),
                "status":     e.get("status", "?"),
                "location":   e.get("location", "?"),
                "platforms":  e.get("platforms") or [],
                "keywords":   kws,
                "start_date": e["start_date"].isoformat()
                              if isinstance(e.get("start_date"), datetime) else "",
                "end_date":   e["end_date"].isoformat()
                              if isinstance(e.get("end_date"), datetime) else "",
            })

    # ── 12. Top 50 alerts (full list with URLs) ──────────────────────────────
    top_50_raw = list(db.alerts.find(
        aq, ALERT_FIELDS,
    ).sort([
        ("priority", DESCENDING),  # HIGH > MEDIUM > LOW alphabetically too
        ("threat_details.risk_score", DESCENDING),
        ("created_at", DESCENDING),
    ]).limit(50))
    top_50_alerts = []
    for d in top_50_raw:
        llm = d.get("llm_analysis") or {}
        threat = d.get("threat_details") or {}
        ts = d.get("created_at")
        top_50_alerts.append({
            "id":             str(d.get("id") or d["_id"]),
            "author_handle":  (d.get("author_handle") or d.get("author") or "?").lstrip("@"),
            "platform":       d.get("platform", "?"),
            "content_url":    d.get("content_url", ""),
            "alert_type":     d.get("alert_type", "?"),
            "source_category": d.get("source_category", "?"),
            "priority":       d.get("priority", "?"),
            "status":         d.get("status", "?"),
            "risk_score":     threat.get("risk_score") or llm.get("score") or 0,
            "sentiment":      llm.get("sentiment", ""),
            "title":          (d.get("title") or "")[:120],
            "timestamp":      ts.isoformat() if isinstance(ts, datetime) else str(ts or ""),
        })

    # ── 13. Top 5 concepts (largest source_categories with sample handles) ────
    concept_pipeline = [
        {"$match": {**aq, "source_category": {"$ne": None, "$ne": ""}}},
        {"$group": {
            "_id": "$source_category",
            "count":     {"$sum": 1},
            "high":      {"$sum": {"$cond": [{"$eq": ["$priority", "HIGH"]}, 1, 0]}},
            "platforms": {"$addToSet": "$platform"},
            "handles":   {"$addToSet": {"$ifNull": ["$author_handle", "$author"]}},
            "sample_url": {"$first": "$content_url"},
            "avg_risk":   {"$avg": "$threat_details.risk_score"},
        }},
        {"$sort": {"count": -1}},
        {"$limit": 5},
    ]
    top_concepts_raw = list(db.alerts.aggregate(concept_pipeline))
    top_concepts = []
    for c in top_concepts_raw:
        raw_cat = c.get("_id") or "unknown"
        handles = [h for h in (c.get("handles") or []) if h][:5]
        top_concepts.append({
            "concept":        raw_cat,
            "label":          _CATEGORY_LABELS.get(raw_cat, raw_cat.replace("_", " ").title()),
            "alert_count":    c["count"],
            "high_risk":      c.get("high", 0),
            "avg_risk_score": round(c.get("avg_risk") or 0, 1),
            "platforms":      [p for p in (c.get("platforms") or []) if p],
            "sample_handles": handles,
            "sample_url":     c.get("sample_url", ""),
        })

    # ── 14. Profiles (monitored sources) ─────────────────────────────────────
    profiles_breakdown = {
        "monitored":     0,
        "active":        0,
        "added_24h":     0,
        "deleted_24h":   0,
        "high_risk":     0,
    }
    if "sources" in existing_cols:
        profiles_breakdown["monitored"] = db.sources.estimated_document_count()
        profiles_breakdown["active"]    = db.sources.count_documents({"is_active": True})
        profiles_breakdown["added_24h"] = db.sources.count_documents({"created_at": {"$gte": cutoff}})
        profiles_breakdown["high_risk"] = db.sources.count_documents(
            {"risk_level": {"$in": ["high", "critical"]}}
        )
    # Deletions tracked via audit_logs (resource_type='source', action containing 'delete')
    if "audit_logs" in existing_cols:
        try:
            profiles_breakdown["deleted_24h"] = db.audit_logs.count_documents({
                "$and": [
                    {"$or": [{"created_at": {"$gte": cutoff}}, {"createdAt": {"$gte": cutoff}}, {"timestamp": {"$gte": cutoff}}]},
                    {"resource_type": {"$regex": "source", "$options": "i"}},
                    {"action":        {"$regex": "delete", "$options": "i"}},
                ]
            })
        except Exception:
            pass

    # ── 15. Top 10 monitored keywords (configured watch-words) ───────────────
    top_keywords_10 = []
    if "keywords" in existing_cols:
        kw_docs = list(db.keywords.find(
            {"is_active": {"$ne": False}},
            {"_id": 0, "keyword": 1, "category": 1, "language": 1, "weight": 1,
             "is_active": 1, "created_at": 1},
        ).sort([("weight", DESCENDING), ("created_at", DESCENDING)]).limit(10))
        for k in kw_docs:
            top_keywords_10.append({
                "keyword":  k.get("keyword", "?"),
                "category": k.get("category", "?"),
                "language": k.get("language", "?"),
                "weight":   k.get("weight", 0),
                "active":   k.get("is_active", True),
            })

    client.close()

    return {
        "window_hours": hours,
        "window_start": cutoff.isoformat(),
        "window_end": datetime.now(timezone.utc).isoformat(),
        "stats": {
            "total_alerts":     total_alerts,
            "high_alerts":      high_alerts,
            "medium_alerts":    med_alerts,
            "active_alerts":    active_alerts,
            "escalated_alerts": escalated_alerts,
            "total_grievances": total_grievances,
            "dial100_total":    dial100_total,
            "threat_rate_pct":  round(high_alerts / max(total_alerts, 1) * 100, 1),
        },
        "trending_keywords":   trending_keywords,
        "platform_data":       platform_data,
        "viral_posts":         viral_posts,
        "active_accounts":     active_accounts,
        "categories":          categories,
        "sentiment":           sent_buckets,
        "threat_posts":        threat_posts,
        # New sections (officer-requested)
        "dial100_total":       dial100_total,
        "grievance_breakdown": grievance_breakdown,
        "events_breakdown":    events_breakdown,
        "top_50_alerts":       top_50_alerts,
        "top_concepts":        top_concepts,
        "profiles_breakdown":  profiles_breakdown,
        "top_keywords_10":     top_keywords_10,
    }


def _build_dir(hours: int = 24, force: bool = False, tenant_id: Optional[str] = None) -> dict:
    """Generate (or return cached) Daily Intelligence Report."""
    now = datetime.now(timezone.utc)
    date_key = now.strftime("%Y-%m-%d")
    cache_key = f"{date_key}_{hours}h"

    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    db = client[_tenant_db(tenant_id)]
    cache = db[DIR_COLLECTION]
    cache.create_index([("cache_key", 1)], unique=True, background=True)
    if not force:
        existing = cache.find_one({"cache_key": cache_key})
        if existing:
            existing.pop("_id", None)
            if isinstance(existing.get("generated_at"), datetime):
                existing["generated_at"] = existing["generated_at"].isoformat()
            client.close()
            return existing
    client.close()

    raw = _collect_dir_data(hours=hours, tenant_id=tenant_id)
    s = raw["stats"]
    top_kw = ", ".join(
        f"{kw['_id']} ({kw['count']})" for kw in raw["trending_keywords"][:10]
    ) or "(none)"
    top_accounts = ", ".join(
        f"@{a['handle']} ({a['alert_count']} alerts)" for a in raw["active_accounts"][:8]
    ) or "(none)"
    top_cats = ", ".join(
        f"{c['label']} ({c['count']})" for c in raw["categories"][:8]
    ) or "(none)"
    plat_summary = ", ".join(
        f"{p['_id']} ({p['total']})" for p in raw["platform_data"][:6]
    ) or "(none)"
    viral_summary = "\n".join(
        f"  • @{v['author_handle']} on {v['platform']}: {v['velocity_metric']} velocity={v['velocity']} | "
        f"cat={v['source_category']} | URL: {v['content_url'] or 'N/A'}"
        for v in raw["viral_posts"][:8]
    ) or "(none)"
    threat_summary = "\n".join(
        f"  • @{t['author_handle']} on {t['platform']} | risk={t['risk_score']}% "
        f"| type={t['alert_type']} | {t['reasoning'][:150]} | URL: {t['content_url'] or 'N/A'}"
        for t in raw["threat_posts"][:10]
    ) or "(none)"
    sent_info = (
        f"Negative: {s.get('negative', raw['sentiment'].get('negative', 0))} | "
        f"Positive: {raw['sentiment'].get('positive', 0)} | "
        f"Neutral: {raw['sentiment'].get('neutral', 0)}"
    )

    prompt = textwrap.dedent(f"""\
        You are the AI Assistant Daily Intelligence Briefer for Telangana Police
        (CP, DCP, SOC analysts). Generate a comprehensive Daily Intelligence Report
        for the last {hours} hours as of {now.strftime('%d-%b-%Y %H:%M')} IST.

        === RAW INTELLIGENCE DATA ===
        PERIOD: Last {hours} hours
        Total Alerts: {s['total_alerts']} | HIGH: {s['high_alerts']} | MEDIUM: {s['medium_alerts']}
        Grievances: {s['total_grievances']}
        Threat Rate: {s['threat_rate_pct']}%

        TOP TRENDING KEYWORDS/TOPICS: {top_kw}
        MOST ACTIVE ACCOUNTS: {top_accounts}
        CATEGORY BREAKDOWN: {top_cats}
        PLATFORM BREAKDOWN: {plat_summary}
        SENTIMENT: {sent_info}

        VIRAL/HIGH-VELOCITY POSTS:
        {viral_summary}

        HIGH-THREAT POSTS (with URLs):
        {threat_summary}

        === END DATA ===

        Write the report using EXACTLY these 7 sections (Markdown ## headings):

        ## Executive Summary
        3-4 sentences. Overall threat landscape for the period. Highlight the most
        critical development that CP needs to know immediately. Include key numbers.

        ## Trending Topics & Keywords
        List top 8 trending topics/keywords. For each:
        • **[keyword]** — X alerts | platforms: ... | risk level (HIGH/MEDIUM/LOW)
        • Brief note on why it is trending or its significance.

        ## Viral & High-Velocity Posts
        List the top 5 viral posts. For each:
        • **@handle** on [platform] — [metric] velocity=[value] | [category]
        • [View Post](URL) | Risk: X% | Significance: one line

        ## Platform & Sentiment Analysis
        For each major platform: alert count, % high-risk, dominant sentiment.
        Overall sentiment breakdown (negative/positive/neutral %).
        Pattern note: which platform is highest-risk this period.

        ## High-Threat Intelligence
        Top 5 HIGH-priority alerts requiring immediate attention. For each:
        • **@handle** — [alert_type] | Risk: X% | [View Post](URL)
        • Threat: what law-and-order risk it poses
        • Action: specific recommendation (FIR / takedown / escalate / monitor)

        ## Active Threat Actors
        Top 5 most active accounts generating alerts. For each:
        • **@handle** — X alerts | categories | platforms
        • Threat level: HIGH/MEDIUM/LOW | Recommended action

        ## Analyst's Assessment
        3-4 bullets covering:
        • Dominant threat category this period and why
        • Any coordinated activity or emerging patterns
        • Jurisdiction/district-specific risks if detectable
        • One forward-looking note (watch-list for next 24h)

        CRITICAL RULES:
        - Use ONLY real data from the sections above. NEVER invent handles/URLs/incidents.
        - For every post mentioned: include [View Post](URL) if URL is available.
        - If a section has no data, write "No significant items in this period."
        - Be specific with numbers. Officers need hard data, not vague summaries.
        - Bold **@handles** and key figures. Use `code` for legal sections.
    """)

    llm_summary = ""
    try:
        llm_summary = llm_generate(
            prompt,
            temperature=0.15,
            max_tokens=1800,
            timeout=600,
        )
    except Exception as exc:
        logger.warning("DIR LLM generation failed: %s", exc)
        llm_summary = "_(AI narrative unavailable — vLLM not reachable.)_"

    doc = {
        "cache_key":   cache_key,
        "date":        date_key,
        "hours":       hours,
        "generated_at": now,
        "window_start": raw["window_start"],
        "window_end":   raw["window_end"],
        "stats":        raw["stats"],
        "trending_keywords": raw["trending_keywords"],
        "platform_data":     raw["platform_data"],
        "viral_posts":       raw["viral_posts"],
        "active_accounts":   raw["active_accounts"],
        "categories":        raw["categories"],
        "sentiment":         raw["sentiment"],
        "threat_posts":      raw["threat_posts"],
        "llm_summary":       llm_summary,
    }

    try:
        c2 = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        c2[DB_NAME][DIR_COLLECTION].update_one(
            {"cache_key": cache_key}, {"$set": doc}, upsert=True
        )
        c2.close()
    except Exception as e:
        logger.warning("DIR cache write failed: %s", e)

    doc.pop("_id", None)
    doc["generated_at"] = doc["generated_at"].isoformat()
    return doc


@app.get("/api/rag/dir")
def get_dir(hours: int = 24, force: bool = False):
    """Return the Daily Intelligence Report for the last N hours."""
    try:
        doc = _build_dir(hours=hours, force=force, tenant_id=tenant_id)
        return doc
    except Exception as e:
        logger.exception("DIR build failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/rag/dir/history")
def dir_history(limit: int = 14, tenant_id: Optional[str] = None):
    """List historical Daily Intelligence Reports, newest first."""
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        col = client[_tenant_db(tenant_id)][DIR_COLLECTION]
        docs = list(
            col.find({}, {
                "trending_keywords": 0, "viral_posts": 0,
                "active_accounts": 0, "threat_posts": 0,
            }).sort("generated_at", DESCENDING).limit(min(limit, 60))
        )
        client.close()
        for d in docs:
            d.pop("_id", None)
            if isinstance(d.get("generated_at"), datetime):
                d["generated_at"] = d["generated_at"].isoformat()
        return {"reports": docs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _dir_scheduler_loop():
    """Generate DIR once per day at DIR_HOUR_UTC."""
    while not _scheduler_state["stop"].is_set():
        now = datetime.now(timezone.utc)
        target = now.replace(hour=DIR_HOUR_UTC, minute=30, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        sleep_s = (target - now).total_seconds()
        logger.info("Next DIR generation at %s UTC (in %.0fs)", target.isoformat(), sleep_s)
        if _scheduler_state["stop"].wait(sleep_s):
            return
        try:
            _build_dir(hours=24, force=True)
            logger.info("Daily Intelligence Report generated.")
        except Exception:
            logger.exception("DIR generation failed")


@app.on_event("startup")
def _start_dir_scheduler():
    t = threading.Thread(target=_dir_scheduler_loop, name="rag-dir-scheduler", daemon=True)
    t.start()


@app.get("/api/rag/top-alerts/history")
def top_alerts_history(limit: int = 14, tenant_id: Optional[str] = None):
    """List past top-alert runs stored in rag_top_alerts, newest first."""
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        col = client[_tenant_db(tenant_id)]["rag_top_alerts"]
        docs = list(col.find({}, {"alert_meta": 0}).sort("generated_at", DESCENDING).limit(min(limit, 60)))
        client.close()
        for d in docs:
            d.pop("_id", None)
            if isinstance(d.get("generated_at"), datetime):
                d["generated_at"] = d["generated_at"].isoformat()
        return {"runs": docs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/rag/top-alerts/cached")
def top_alerts_cached(date: Optional[str] = None, hours: int = 24, mode: Optional[str] = None,
                      tenant_id: Optional[str] = None):
    """Return the cached top-alerts for a given date (default=today).
    `mode` can be omitted (legacy single-list cache) or "by_category" for the
    per-category cache. Returns alert_ids + alert_meta so frontend can fetch
    full cards via /api/alerts/bulk."""
    date_key = date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        col = client[_tenant_db(tenant_id)]["rag_top_alerts"]
        if mode == "by_category":
            query = {"date": date_key, "hours": hours, "mode": "by_category"}
        else:
            # Legacy cache docs were written without a `mode` field; match those.
            query = {"date": date_key, "hours": hours, "mode": {"$exists": False}}
        doc = col.find_one(query, {"_id": 0})
        client.close()
        if not doc:
            return {"found": False, "date": date_key}
        if isinstance(doc.get("generated_at"), datetime):
            doc["generated_at"] = doc["generated_at"].isoformat()
        doc["found"] = True
        return doc
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/rag/refresh-cache")
def refresh_cache():
    """Rebuild the local vector search cache from MongoDB."""
    try:
        store = VectorStore(MONGODB_URI, DB_NAME, VECTOR_COLLECTION)
        store.refresh_cache()
        count = len(store._texts)
        store.close()
        return {"message": f"Cache rebuilt with {count} vectors."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/rag/v2/analysis/{job_id}")
def v2_analysis(job_id: str, tenant_id: Optional[str] = None,
                districts: Optional[str] = None):
    """Progress, and the findings once there are any.

    Scoped to the tenant AND districts that started the job: a job id alone
    never reaches another officer's scope.
    """
    _require_v2()
    from orchestrator import analysis_job

    tid = _require_tenant(tenant_id)
    job = analysis_job.get(job_id, tid, _district_scope_key(_districts_param(districts)))
    if not job:
        if analysis_job.belongs_to_another_worker(job_id):
            # A well-formed id this process never issued: the deployment is
            # running more than one worker, and progressive analysis cannot work
            # that way. Saying so beats telling an officer their analysis is gone.
            raise HTTPException(
                status_code=503,
                detail="analysis is being served by another worker process; this "
                       "deployment must run a single worker")
        raise HTTPException(status_code=404, detail="analysis not found")
    out = job.snapshot(with_findings=True)
    if job.status == "done":
        out["evidence"] = analysis_job.evidence_payload(job)
        out["evidence_stage"] = "final"
    return out


@app.delete("/api/rag/v2/analysis/{job_id}")
def v2_analysis_cancel(job_id: str, tenant_id: Optional[str] = None,
                       districts: Optional[str] = None):
    _require_v2()
    from orchestrator import analysis_job

    tid = _require_tenant(tenant_id)
    job = analysis_job.get(job_id, tid, _district_scope_key(_districts_param(districts)))
    if not job:
        raise HTTPException(status_code=404, detail="analysis not found")
    analysis_job.cancel(job)
    return {"job_id": job_id, "status": "cancelling"}
