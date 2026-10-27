"""
query_collections.py — which collections the assistant may search, in one place.

The list existed twice: once in api_server as ALLOWED_QUERY_COLLECTIONS and once
in each validation harness. The copies had already drifted — one said
`telegram_messages`, the other `telegrammessages`, and one carried reporting
collections the other did not. A harness that searches a different set from the
server validates something the server does not do.

The list is deployment configuration, not code: ALLOWED_QUERY_COLLECTIONS
overrides it, and a deployment for another domain sets its own. That is also the
seam a generic API needs — the names below are the only thing here that knows
what kind of records this system holds.
"""

from __future__ import annotations

import logging
import os
from typing import List

logger = logging.getLogger(__name__)

#: Prefix every vector collection carries. One place, because a mismatch means
#: searching nothing and looking like an empty database.
VECTOR_PREFIX = os.getenv("VECTOR_COLLECTION", "vector_embeddings")

#: Officers ask about every module in the portal, so the allow-list is
#: intentionally broad. A name that does not exist in a tenant's database is
#: skipped, so listing one costs nothing.
DEFAULT_COLLECTIONS = (
    "alerts", "grievances", "events", "dial100incidents", "pois", "keywords",
    "sources", "contents", "dailyprogrammes", "telegrammessages",
    "criticism_reports", "grievance_workflow_reports", "query_reports",
    "suggestion_reports",
)


#: Collections the assistant may NEVER search, whatever configuration says.
#:
#: This is a floor, not a preference. A deployment's .env listed 44 collections
#: including `users`, `settings`, `auditlogs`, `pagepermissions` and
#: `policymappings` — identity, configuration and the audit trail. Nothing was
#: exposed, because none of them had been embedded, but the only thing standing
#: between an officer and the user table was that an embedding job had not run
#: yet. An allow-list is the wrong place to be careful: it is edited by whoever
#: is adding a collection, and it fails open.
#:
#: These hold accounts, credentials, authorisation rules, system configuration
#: or the audit log. None of them is intelligence about the world, so none of
#: them is ever an answer to an officer's question.
NEVER_SEARCHABLE = frozenset({
    "users", "settings", "grievancesettings", "pagepermissions", "policymappings",
    "platformpolicies", "auditlogs", "search_history", "counters", "templates",
    "alertthresholds", "legalsections", "twitteraccounts", "sessions", "tenants",
    "apikeys", "credentials", "permissions", "roles",
})


def allowed_collections() -> List[str]:
    """Source collection names the assistant may search, in order.

    Configuration may narrow this list; it may not widen it past
    NEVER_SEARCHABLE.
    """
    raw = os.getenv("ALLOWED_QUERY_COLLECTIONS")
    names = list(DEFAULT_COLLECTIONS)
    if raw:
        configured = [c.strip() for c in raw.split(",") if c.strip()]
        if configured:
            names = configured
    kept, refused = [], []
    for name in names:
        (refused if name.lower() in NEVER_SEARCHABLE else kept).append(name)
    if refused:
        logger.warning(
            "refusing to search %d configured collection(s) that hold accounts, "
            "configuration or the audit trail: %s", len(refused), ", ".join(sorted(refused)))
    return kept


def vector_collections() -> List[str]:
    """The same list as vector collection names."""
    return [f"{VECTOR_PREFIX}_{c}" for c in allowed_collections()]


def existing_vector_collections(db) -> List[str]:
    """Those a given tenant database actually has.

    Sorted, so two callers asking the same question search in the same order and
    a result set does not depend on dictionary ordering.
    """
    present = set(db.list_collection_names())
    return sorted(n for n in vector_collections() if n in present)
