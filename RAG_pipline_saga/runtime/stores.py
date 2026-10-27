"""
stores.py — which conversation store and audit sink this process uses.

    AI_CONVERSATION_STORE = memory | mongo      (default memory)
    AI_AUDIT_SINK         = log | mongo         (default log)

Defaults write nothing to any database. For a multi-worker deployment the
conversation store MUST be `mongo`: the in-memory store is per process, and a
follow-up landing on another worker would find no conversation. With `mongo`,
each tenant's conversations live in that tenant's own database
(`ai_conversations`), with the unique owner index and TTL index created once
per tenant database on first use.

The Mongo client is injected (`client_factory`) so this module is testable
without a server and imports no driver at module load.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Callable, Optional

import conversation as conv

logger = logging.getLogger("ai.stores")
AUDIT_COLLECTION = "ai_audit"

_lock = threading.Lock()
_store = None
_indexed: set = set()


def conversation_backend() -> str:
    return os.getenv("AI_CONVERSATION_STORE", "memory").strip().lower()


def conversation_store(db_for_tenant: Optional[Callable[[str], object]] = None):
    """The process's conversation store. `db_for_tenant(tenant_id)` returns
    that tenant's database handle; required for `mongo`."""
    global _store
    with _lock:
        if _store is not None:
            return _store
        cfg = conv.ConversationConfig.from_env()
        if conversation_backend() == "mongo":
            if db_for_tenant is None:
                raise RuntimeError("AI_CONVERSATION_STORE=mongo needs a tenant database factory")

            def collection_for(tenant_id: str):
                col = db_for_tenant(tenant_id)[conv.COLLECTION]
                if tenant_id not in _indexed:
                    conv.MongoConversationStore.ensure_indexes(col)
                    _indexed.add(tenant_id)
                return col
            _store = conv.MongoConversationStore(collection_for, cfg)
        else:
            _store = conv.InMemoryConversationStore(cfg)
        return _store


def reset() -> None:
    global _store
    with _lock:
        _store = None
        _indexed.clear()


class AuditSink:
    """Append-only record of what ran, for evidentiary reconstruction:
    identifiers, digests and the answer — never the source records."""

    def __init__(self, db_for_tenant: Optional[Callable[[str], object]] = None):
        self.mode = os.getenv("AI_AUDIT_SINK", "log").strip().lower()
        self.db_for_tenant = db_for_tenant

    def write(self, tenant_id: str, record: dict) -> None:
        record = {**record, "at": datetime.now(timezone.utc)}
        if self.mode == "mongo" and self.db_for_tenant:
            try:
                self.db_for_tenant(tenant_id)[AUDIT_COLLECTION].insert_one(record)
                return
            except Exception as exc:
                logger.warning("audit write failed, logging instead: %s", exc)
        logger.info("ai-audit %s", json.dumps(record, default=str)[:4000])
