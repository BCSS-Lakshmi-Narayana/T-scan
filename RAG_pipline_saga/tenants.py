"""
tenants.py — which database a tenant's data (and its vectors) live in.

The platform runs TENANT_DB_MODE=per-tenant: every tenant has its own MongoDB
database, and this service must resolve the right one per request rather than
reading a single DB_NAME. Vectors are written back into that same tenant
database, so a tenant's corpus never leaves its own storage.

The naming rule mirrors the Node backend's config/tenantConnections.dbNameFor
exactly, and the two must not drift: if they disagree, this service indexes a
database the application never reads, and every answer comes back empty.

    explicit tenant.db_name        -> used as-is (sanitised)
    otherwise                      -> TENANT_DB_PREFIX + slug

Configuration (.env):

    MONGODB_URI            the cluster (same one the backend uses)
    CONTROL_DB_NAME        control plane holding the tenant registry
    TENANT_DB_PREFIX       must match the backend's value
    TENANT_REGISTRY_TTL_S  how long a resolved tenant is cached
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Dict, List, Optional

from pymongo import MongoClient

logger = logging.getLogger(__name__)

MONGODB_URI = os.getenv("MONGODB_URI", "")
# The control plane, NOT a tenant database. Defaults to the backend's own value.
CONTROL_DB_NAME = os.getenv("CONTROL_DB_NAME", os.getenv("DB_NAME", "saga-super-admin"))
TENANT_DB_PREFIX = os.getenv("TENANT_DB_PREFIX", "police_tenant_")
REGISTRY_TTL_S = max(5, int(os.getenv("TENANT_REGISTRY_TTL_S", "300")))

# The control plane is SHARED between the sagas: the same registry holds police
# tenants and the political-state ones (type "state", with db_name pointing at
# state_tenant_*). This service must only ever touch its own, so every registry
# read is filtered by type. Without it the scheduler happily ingests another
# product's databases.
TENANT_TYPE = os.getenv("TENANT_TYPE", "police").strip()

# Mongo rejects these characters in a database name and caps it at 63 bytes.
# Same expression as the backend's sanitize().
_UNSAFE = re.compile(r'[/\\. "$*<>:|?]')


class TenantNotFound(RuntimeError):
    """The tenant id is not in the registry, or is not usable."""


@dataclass(frozen=True)
class Tenant:
    id: str
    slug: str
    db_name: str
    status: str = "active"
    type: str = ""

    @property
    def is_active(self) -> bool:
        return self.status in ("trial", "active")


def sanitize(value: str) -> str:
    return _UNSAFE.sub("_", str(value or ""))[:63]


def db_name_for(*, slug: str = "", db_name: str = "") -> str:
    """The database a tenant's data lives in.

    An explicit db_name always wins, so a tenant can be moved without a code
    change. Otherwise it is derived from the slug, which is already unique and
    URL-safe. Mirrors the backend one-for-one.
    """
    if db_name:
        return sanitize(db_name)
    if not slug:
        return ""
    return sanitize(f"{TENANT_DB_PREFIX}{slug}")


# --------------------------------------------------------------------------- #
# registry
# --------------------------------------------------------------------------- #

_cache: Dict[str, tuple] = {}          # tenant_id -> (Tenant, expires_at)
_lock = threading.Lock()
_client: Optional[MongoClient] = None


def _control_db():
    """One long-lived client for the control plane; pymongo pools internally."""
    global _client
    if _client is None:
        if not MONGODB_URI:
            raise TenantNotFound("MONGODB_URI is not configured")
        _client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    return _client[CONTROL_DB_NAME]


def _to_tenant(doc: dict) -> Tenant:
    slug = str(doc.get("slug") or "")
    resolved = db_name_for(slug=slug, db_name=str(doc.get("db_name") or ""))
    return Tenant(
        id=str(doc.get("id") or ""),
        slug=slug,
        db_name=resolved,
        status=str(doc.get("status") or "active"),
        type=str(doc.get("type") or ""),
    )


def resolve(tenant_id: str) -> Tenant:
    """Look up a tenant by id. Raises rather than falling back to a default
    database: a wrong database here is a cross-tenant read, not a slow query.
    """
    tid = (tenant_id or "").strip()
    if not tid:
        raise TenantNotFound("tenant_id is required")

    now = time.time()
    with _lock:
        hit = _cache.get(tid)
        if hit and hit[1] > now:
            return hit[0]

    doc = _control_db()["tenants"].find_one(
        {"id": tid, "type": TENANT_TYPE},
        {"id": 1, "slug": 1, "db_name": 1, "status": 1, "type": 1, "_id": 0},
    )
    if not doc:
        # Either unknown, or a tenant belonging to a different saga. Both are
        # "not yours" as far as this service is concerned.
        raise TenantNotFound(f"no {TENANT_TYPE} tenant with id {tid!r}")

    tenant = _to_tenant(doc)
    if not tenant.db_name:
        raise TenantNotFound(f"tenant {tenant.slug or tid!r} has no resolvable database name")
    if not tenant.is_active:
        raise TenantNotFound(f"tenant {tenant.slug!r} is {tenant.status}")

    with _lock:
        _cache[tid] = (tenant, now + REGISTRY_TTL_S)
    return tenant


def resolve_db_name(tenant_id: str) -> str:
    """The database name for a tenant id."""
    return resolve(tenant_id).db_name


def active_tenants() -> List[Tenant]:
    """Every tenant the scheduler should ingest for, newest registry state."""
    docs = _control_db()["tenants"].find(
        {"status": {"$in": ["trial", "active"]}, "type": TENANT_TYPE},
        {"id": 1, "slug": 1, "db_name": 1, "status": 1, "type": 1, "_id": 0},
    )
    out = []
    for d in docs:
        t = _to_tenant(d)
        if t.db_name:
            out.append(t)
        else:
            logger.warning("skipping tenant %s: no resolvable database name", t.id)
    return out


def invalidate(tenant_id: Optional[str] = None) -> None:
    """Drop cached lookups so a rename or a move takes effect without a restart."""
    with _lock:
        if tenant_id:
            _cache.pop(tenant_id, None)
        else:
            _cache.clear()
