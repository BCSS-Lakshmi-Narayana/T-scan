"""
mongo_pool.py — one MongoClient per connection configuration, per process.

A MongoClient is not a connection. It is a connection POOL with its own
monitoring threads, its own SRV resolution and its own TLS handshakes to every
node in the replica set. PyMongo's documentation is explicit that one client
should be shared for the lifetime of the process.

Measured on this deployment, against Atlas:

    a vector search, steady state                          27 ms
    the first search on a freshly constructed VectorStore  829 ms
    first connect across the seven stores one scope needs  3,684 ms

So the connection cost, when it is paid, is 135x the query it enables. The
warm-store cache in api_server already avoids paying it per request, but it
evicts, and every eviction means the next use reconnects and re-runs
create_index. Tooling and validation harnesses construct stores freshly and paid
it every time, which made measurements taken through them unrepresentative.

What this module does NOT do:

  * It does not choose databases. `database()` takes the name the caller
    resolved; tenant isolation is a database-name decision made upstream, and a
    shared client cannot blur it — a client is a connection to a cluster, and
    `client[db]` is still scoped to that database.
  * It does not close clients on a caller's behalf. A shared client closed by
    one holder would break every other holder mid-request. Shutdown is explicit
    (`close_all`), and tests reset it (`reset`).
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Optional, Tuple

from pymongo import MongoClient
from pymongo.database import Database

logger = logging.getLogger(__name__)

#: Options every pooled client gets unless the caller overrides them. A server
#: selection timeout is the difference between a slow answer and a request
#: thread parked for thirty seconds on a cluster that is not there.
DEFAULT_OPTIONS: Dict[str, Any] = {"serverSelectionTimeoutMS": 5000}

_CLIENTS: Dict[Tuple, MongoClient] = {}
_LOCK = threading.Lock()
_CREATED = 0
_REUSED = 0


def _key(uri: str, options: Dict[str, Any]) -> Tuple:
    """Identity of a client: its URI and the options that shape the pool.

    Two callers asking for the same URI with different timeouts genuinely want
    different clients, so the options are part of the key rather than being
    silently dropped — a 5 s selection timeout must not be handed to a caller
    that asked for 30 s.
    """
    return (uri, tuple(sorted((k, repr(v)) for k, v in options.items())))


def client(uri: str, **options: Any) -> MongoClient:
    """The process's client for *uri*, created on first ask.

    Raises whatever MongoClient raises on a malformed URI, so a
    misconfiguration is still loud — a pool that hands back a broken client
    would turn one bad config into a mystery at every call site.
    """
    if not uri:
        raise ValueError("a MongoDB URI is required")
    opts = {**DEFAULT_OPTIONS, **options}
    key = _key(uri, opts)
    global _CREATED, _REUSED
    with _LOCK:
        existing = _CLIENTS.get(key)
        if existing is not None:
            _REUSED += 1
            return existing
        created = MongoClient(uri, **opts)
        _CLIENTS[key] = created
        _CREATED += 1
        logger.info("mongo client created (%d live)", len(_CLIENTS))
        return created


def database(uri: str, db_name: str, **options: Any) -> Database:
    """One database on the pooled client. The name is the caller's decision."""
    if not db_name:
        raise ValueError("a database name is required")
    return client(uri, **options)[db_name]


def stats() -> Dict[str, int]:
    """How well the pool is working. Reported by the metrics endpoint.

    `created` climbing with request count means something is still building its
    own clients and the pool is not being used.
    """
    with _LOCK:
        return {"live": len(_CLIENTS), "created": _CREATED, "reused": _REUSED}


def close_all() -> None:
    """Close every pooled client. For process shutdown, and for tests."""
    with _LOCK:
        clients = list(_CLIENTS.values())
        _CLIENTS.clear()
    for c in clients:
        try:
            c.close()
        except Exception as exc:                                  # noqa: BLE001
            logger.debug("closing a pooled client failed: %s", exc)


def reset() -> None:
    """Forget every client without closing it.

    For tests that need a clean pool but must not close a client another test
    still holds. Counters are left alone: they are cumulative for the process.
    """
    with _LOCK:
        _CLIENTS.clear()
