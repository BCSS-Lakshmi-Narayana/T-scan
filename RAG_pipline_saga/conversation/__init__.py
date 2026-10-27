"""
conversation — Phase 1C, Conversation State / Context.

    plan (Phase 1A) + ConversationState  ->  ResolvedQuery  ->  Policy Gate (1B)

Makes follow-ups resolvable ("what about yesterday?", "and in Warangal?",
"how many were there?") from STRUCTURED earlier turns. Memory is context, not
authority: nothing here grants access, and every resolved plan is judged by
the Policy Gate against the caller as they are now.

No model, no retrieval, no database read in resolution. Development-only:
/api/rag/conversation/resolve behind AI_ASSISTANT_ARCHITECTURE_V2 (off).
"""

from .config import (ENABLED_FLAG, SCHEMA_VERSION, ConversationConfig,
                     conversation_enabled)
from .models import (ContextUse, ConversationState, ConversationTurn,
                     ReferentType, ResolutionStatus, ResolvedQuery,
                     TurnContext, TypedReferent, UnresolvedReferent, Via)
from .resolver import ConversationAccessError, extract_context, resolve_query
from .store import (COLLECTION, ConversationConflict, ConversationError,
                    ConversationNotFound, ConversationStore,
                    InMemoryConversationStore, InvalidConversationId,
                    MongoConversationStore, build_turn, check_id)

__all__ = [
    "resolve_query", "extract_context", "build_turn", "check_id",
    "ConversationConfig", "SCHEMA_VERSION", "ENABLED_FLAG", "conversation_enabled",
    "ConversationState", "ConversationTurn", "TurnContext", "ResolvedQuery",
    "TypedReferent", "UnresolvedReferent", "ContextUse", "ReferentType",
    "ResolutionStatus", "Via", "ConversationStore", "InMemoryConversationStore",
    "MongoConversationStore", "ConversationError", "ConversationNotFound",
    "InvalidConversationId", "ConversationConflict", "ConversationAccessError",
    "COLLECTION",
]
