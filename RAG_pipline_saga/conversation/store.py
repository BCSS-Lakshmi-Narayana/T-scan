"""
store.py — where conversation state lives, and who may read it.

Ownership is checked twice, on purpose. The lookup is keyed by tenant and
user as well as id, and the loaded state's own tenant_id and user_id are then
compared again. Knowing another officer's conversation id — or another
tenant's — returns exactly what an unknown id returns: not found. There is no
error that confirms a conversation exists but belongs to someone else.

Appends are compare-and-set on `turn_count`. Two tabs answering at once
cannot both become turn N+1; the second is refused and must re-resolve
against the state the first produced.

Two implementations share one Protocol:

  InMemoryConversationStore  development endpoint and tests. Process-local,
                             lost on restart, which is correct for a dev
                             harness and writes nothing anywhere.
  MongoConversationStore     for when the orchestrator exists. One collection
                             per TENANT DATABASE, so isolation is physical as
                             well as logical, matching every other tenant
                             collection in this system. Not wired in Phase 1C.
"""

from __future__ import annotations

import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, List, Optional, Protocol

from .config import ConversationConfig
from .models import ConversationState, ConversationTurn

COLLECTION = "ai_conversations"
_ID = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


class ConversationError(Exception):
    code = "CONVERSATION_ERROR"


class ConversationNotFound(ConversationError):
    """Unknown, expired, foreign or incompatible — deliberately one error to
    the caller. `reason` is for the audit log only."""
    code = "CONVERSATION_NOT_FOUND"

    def __init__(self, reason: str = "not_found"):
        super().__init__(reason)
        self.reason = reason


class InvalidConversationId(ConversationError):
    code = "CONVERSATION_ID_INVALID"


class ConversationConflict(ConversationError):
    code = "CONVERSATION_CONFLICT"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    # Server-issued only. A client cannot choose an id, so it cannot aim one
    # at somebody else's.
    return uuid.uuid4().hex


def check_id(conversation_id: Optional[str]) -> str:
    cid = (conversation_id or "").strip()
    if not _ID.match(cid):
        # Covers "*", "all", "", "$ne", paths and anything else a wildcard or
        # an operator could be smuggled through.
        raise InvalidConversationId(cid[:16])
    return cid


def _owner(tenant_id: Optional[str], user_id: Optional[str]) -> tuple:
    t, u = (tenant_id or "").strip(), (user_id or "").strip()
    if not t or not u:
        # No anonymous conversations: without both, there is no owner to
        # check against, and an ownerless state is readable by anyone.
        raise ConversationNotFound("missing_owner")
    return t, u


def _verify(state: ConversationState, tenant_id: str, user_id: str,
            config: ConversationConfig, at: datetime) -> ConversationState:
    if state.tenant_id != tenant_id:
        raise ConversationNotFound("tenant_mismatch")
    if state.user_id != user_id:
        raise ConversationNotFound("user_mismatch")
    if state.schema_version != config.schema_version:
        # Never reinterpret an older shape.
        raise ConversationNotFound("schema_incompatible")
    if at >= state.expires_at:
        raise ConversationNotFound("expired")
    return state


def build_turn(sequence: int, question: str, resolved, config: ConversationConfig,
               at: Optional[datetime] = None, query_plan=None) -> ConversationTurn:
    """A turn from a ResolvedQuery. Only turns that fully or partly resolved
    carry context forward; a turn still waiting for clarification does not
    become the ground the next question stands on."""
    from .models import ResolutionStatus
    contributes = resolved.status in (ResolutionStatus.RESOLVED,
                                      ResolutionStatus.PARTIALLY_RESOLVED)
    plan = query_plan or resolved.resolved_plan
    return ConversationTurn(
        turn_id=uuid.uuid4().hex[:16], sequence=sequence,
        user_query=(question or plan.raw_query)[:config.max_query_chars],
        query_plan=plan, resolved_plan=resolved.resolved_plan, status=resolved.status,
        resolved_referents=resolved.resolved_referents,
        unresolved_referents=resolved.unresolved_referents,
        context=resolved.turn_context if contributes else None,
        created_at=at or now_utc())


def advance(state: ConversationState, turn: ConversationTurn,
            config: ConversationConfig, at: datetime) -> ConversationState:
    """The state after `turn`, bounded. Pure: the caller decides whether it
    can be written."""
    turns = (list(state.recent_turns) + [turn])[-config.max_turns:]
    update = {"turn_count": turn.sequence, "recent_turns": turns, "updated_at": at,
              "expires_at": at + timedelta(seconds=config.ttl_seconds)}
    if turn.context is not None:
        update.update(active=turn.context, active_turn=turn.sequence)
    return state.model_copy(update=update)


class ConversationStore(Protocol):
    def create(self, tenant_id: str, user_id: str, at: Optional[datetime] = None) -> ConversationState: ...
    def get(self, tenant_id: str, user_id: str, conversation_id: str,
            at: Optional[datetime] = None) -> ConversationState: ...
    def append(self, state: ConversationState, turn: ConversationTurn,
               expected_sequence: int, at: Optional[datetime] = None) -> ConversationState: ...
    def delete(self, tenant_id: str, user_id: str, conversation_id: str) -> bool: ...


def _fresh(tenant_id: str, user_id: str, config: ConversationConfig, at: datetime) -> ConversationState:
    return ConversationState(conversation_id=new_id(), tenant_id=tenant_id, user_id=user_id,
                             schema_version=config.schema_version, created_at=at, updated_at=at,
                             expires_at=at + timedelta(seconds=config.ttl_seconds))


def _check_append(state: ConversationState, turn: ConversationTurn, expected: int) -> None:
    if turn.sequence != expected + 1:
        raise ConversationConflict(f"turn {turn.sequence} does not follow {expected}")


# --------------------------------------------------------------------------- #
# in-memory
# --------------------------------------------------------------------------- #

class InMemoryConversationStore:
    def __init__(self, config: Optional[ConversationConfig] = None, max_conversations: int = 5000):
        self.config = config or ConversationConfig()
        self.max_conversations = max_conversations
        self._lock = threading.Lock()
        # Keyed by id alone, deliberately: ownership must be proven by the
        # check in _verify, not merely implied by the key.
        self._data: Dict[str, ConversationState] = {}

    def _sweep(self, at: datetime) -> None:
        for cid in [c for c, s in self._data.items() if at >= s.expires_at]:
            del self._data[cid]
        while len(self._data) >= self.max_conversations:
            oldest = min(self._data, key=lambda c: self._data[c].updated_at)
            del self._data[oldest]

    def create(self, tenant_id, user_id, at=None):
        at = at or now_utc()
        t, u = _owner(tenant_id, user_id)
        state = _fresh(t, u, self.config, at)
        with self._lock:
            self._sweep(at)
            self._data[state.conversation_id] = state
        return state

    def get(self, tenant_id, user_id, conversation_id, at=None):
        at = at or now_utc()
        t, u = _owner(tenant_id, user_id)
        cid = check_id(conversation_id)
        with self._lock:
            state = self._data.get(cid)
            if state is None:
                raise ConversationNotFound("not_found")
            try:
                return _verify(state, t, u, self.config, at)
            except ConversationNotFound as exc:
                if exc.reason in ("expired", "schema_incompatible"):
                    del self._data[cid]
                raise

    def append(self, state, turn, expected_sequence, at=None):
        at = at or now_utc()
        _check_append(state, turn, expected_sequence)
        with self._lock:
            current = self._data.get(state.conversation_id)
            if current is None:
                raise ConversationNotFound("not_found")
            _verify(current, state.tenant_id, state.user_id, self.config, at)
            if current.turn_count != expected_sequence:
                raise ConversationConflict(
                    f"expected turn {expected_sequence}, store is at {current.turn_count}")
            updated = advance(current, turn, self.config, at)
            self._data[state.conversation_id] = updated
            return updated

    def delete(self, tenant_id, user_id, conversation_id):
        t, u = _owner(tenant_id, user_id)
        cid = check_id(conversation_id)
        with self._lock:
            state = self._data.get(cid)
            if state is None or state.tenant_id != t or state.user_id != u:
                return False
            del self._data[cid]
            return True


# --------------------------------------------------------------------------- #
# MongoDB — per-tenant database
# --------------------------------------------------------------------------- #

class MongoConversationStore:
    """``collection_for(tenant_id)`` returns the ``ai_conversations``
    collection in that tenant's own database (tenants.resolve_db_name). It is
    injected, so this module imports no driver and tests need no server."""

    def __init__(self, collection_for: Callable[[str], object],
                 config: Optional[ConversationConfig] = None):
        self.collection_for = collection_for
        self.config = config or ConversationConfig()

    @staticmethod
    def ensure_indexes(collection) -> None:
        collection.create_index([("tenant_id", 1), ("user_id", 1), ("conversation_id", 1)],
                                unique=True, name="owner_conversation")
        # Mongo's TTL monitor removes idle conversations on its own.
        collection.create_index("expires_at", expireAfterSeconds=0, name="ttl_expires_at")

    @staticmethod
    def _to_doc(state: ConversationState) -> dict:
        doc = state.model_dump(mode="json")
        # BSON dates, so the TTL index can act on them.
        for key in ("created_at", "updated_at", "expires_at"):
            doc[key] = getattr(state, key)
        return doc

    @staticmethod
    def _from_doc(doc: dict) -> ConversationState:
        doc = {k: v for k, v in doc.items() if k != "_id"}
        for key in ("created_at", "updated_at", "expires_at"):
            if isinstance(doc.get(key), datetime) and doc[key].tzinfo is None:
                doc[key] = doc[key].replace(tzinfo=timezone.utc)   # BSON drops tz
        return ConversationState.model_validate(doc)

    def create(self, tenant_id, user_id, at=None):
        at = at or now_utc()
        t, u = _owner(tenant_id, user_id)
        state = _fresh(t, u, self.config, at)
        self.collection_for(t).insert_one(self._to_doc(state))
        return state

    def get(self, tenant_id, user_id, conversation_id, at=None):
        at = at or now_utc()
        t, u = _owner(tenant_id, user_id)
        cid = check_id(conversation_id)
        # The owner is part of the query: a foreign id finds nothing, rather
        # than finding something and then being refused.
        doc = self.collection_for(t).find_one({"tenant_id": t, "user_id": u,
                                               "conversation_id": cid})
        if doc is None:
            raise ConversationNotFound("not_found")
        if doc.get("schema_version") != self.config.schema_version:
            raise ConversationNotFound("schema_incompatible")
        return _verify(self._from_doc(doc), t, u, self.config, at)

    def append(self, state, turn, expected_sequence, at=None):
        at = at or now_utc()
        _check_append(state, turn, expected_sequence)
        t, u = _owner(state.tenant_id, state.user_id)
        updated = advance(state, turn, self.config, at)
        doc = self._to_doc(updated)
        result = self.collection_for(t).find_one_and_update(
            {"tenant_id": t, "user_id": u, "conversation_id": state.conversation_id,
             "turn_count": expected_sequence, "schema_version": self.config.schema_version},
            {"$set": {k: v for k, v in doc.items() if k != "conversation_id"}})
        if result is None:
            raise ConversationConflict(f"expected turn {expected_sequence}")
        return updated

    def delete(self, tenant_id, user_id, conversation_id):
        t, u = _owner(tenant_id, user_id)
        cid = check_id(conversation_id)
        res = self.collection_for(t).delete_one({"tenant_id": t, "user_id": u,
                                                 "conversation_id": cid})
        return bool(getattr(res, "deleted_count", 0))


__all__: List[str] = [
    "ConversationStore", "InMemoryConversationStore", "MongoConversationStore",
    "ConversationError", "ConversationNotFound", "InvalidConversationId",
    "ConversationConflict", "build_turn", "advance", "check_id", "new_id", "now_utc",
    "COLLECTION",
]
