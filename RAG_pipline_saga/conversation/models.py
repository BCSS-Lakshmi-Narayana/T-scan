"""
models.py — the conversation contract.

Conversation memory is CONTEXT, NOT AUTHORITY. Three rules shape every model:

  1. STRUCTURE, NOT PROSE. A turn stores the plan the user's words produced,
     never the assistant's answer. What the model once claimed is not a fact
     the next turn may build on; the database stays the only source of truth.

  2. NO AUTHORISATION IS STORED. There is no policy decision, permission or
     district scope anywhere in the state. Each resolved plan is judged by
     the Policy Gate against the caller as they are NOW, so a scope that was
     revoked between turns cannot be carried forward by the conversation.

  3. EVERYTHING IS BOUNDED AND VERSIONED. A fixed number of turns, a fixed
     number of context items, an idle TTL, and a schema version that is
     checked, never guessed around.

Phase 1A types (Filter, Location, TimeRange, Concept, QueryPlan) are reused
as-is, so a remembered location is exactly the object the planner produced.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from enum import Enum
from typing import Any, List, Optional

import _compiled_compat  # noqa: F401  (before any pydantic model; see the module)
from pydantic import BaseModel, ConfigDict, Field

from query_understanding.models import (Ambiguity, Concept, Entity, Filter,
                                        Intent, Location, QueryPlan, Shape,
                                        TimeRange)

from .config import SCHEMA_VERSION


class ReferentType(str, Enum):
    LOCATION = "location"
    TIME_RANGE = "time_range"
    CONCEPT = "concept"
    ENTITY = "entity"
    FILTER = "filter"
    RESULT_SET = "result_set"                  # "those alerts", "how many were there"
    COMPARISON_SUBJECT = "comparison_subject"  # "compare THAT with Hyderabad"
    PREVIOUS_QUERY = "previous_query"          # "break THAT down"


class ResolutionStatus(str, Enum):
    RESOLVED = "RESOLVED"
    PARTIALLY_RESOLVED = "PARTIALLY_RESOLVED"
    CONTEXT_REQUIRED = "CONTEXT_REQUIRED"
    CONTEXT_AMBIGUOUS = "CONTEXT_AMBIGUOUS"


class Via(str, Enum):
    """How a value reached the resolved plan. Precedence, highest first:
    explicit > referent > inherited. `reset` records a deliberate drop."""
    EXPLICIT = "explicit"
    REFERENT = "referent"
    INHERITED = "inherited"
    RESET = "reset"


# --------------------------------------------------------------------------- #
# what a turn contributes to the conversation
# --------------------------------------------------------------------------- #

class TurnContext(BaseModel):
    """The structured subject of one turn: what the user was asking about.
    Extracted from the turn's resolved plan; never from assistant output."""
    model_config = ConfigDict(extra="forbid")
    intent: Intent
    shape: Shape
    # Every place the turn named, in order. More than one makes a later
    # "there" ambiguous rather than silently the first.
    locations: List[Location] = Field(default_factory=list)
    location_ambiguities: List[Ambiguity] = Field(default_factory=list)
    time_range: TimeRange = Field(default_factory=TimeRange)
    filters: List[Filter] = Field(default_factory=list)
    concepts: List[Concept] = Field(default_factory=list)
    entities: List[Entity] = Field(default_factory=list)
    group_by: List[str] = Field(default_factory=list)
    metric: Optional[str] = None


class TypedReferent(BaseModel):
    """A back-reference resolved against a specific earlier turn."""
    model_config = ConfigDict(extra="forbid")
    token: str
    target_type: ReferentType
    source_turn: Optional[int] = None     # None when the current turn supplied it
    value: Any = None                     # JSON form of the Phase 1A object
    confidence: float = Field(default=0.9, ge=0.0, le=1.0)
    source: str = "context"               # context | explicit — never "llm" here


class UnresolvedReferent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str
    target_type: ReferentType
    reason: str                           # no_context | ambiguous | incompatible
    essential: bool = True
    candidates: List[str] = Field(default_factory=list)


class ContextUse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: str
    via: Via
    source_turn: Optional[int] = None


# --------------------------------------------------------------------------- #
# turns and state
# --------------------------------------------------------------------------- #

class ConversationTurn(BaseModel):
    """One exchange, as structure. Deliberately absent: the assistant's reply
    and the policy decision. The reply lives in the UI; the decision is
    recomputed every time, because authorisation is never remembered."""
    model_config = ConfigDict(extra="forbid")
    turn_id: str
    sequence: int = Field(ge=1)
    user_query: str
    query_plan: QueryPlan                 # what the planner produced
    resolved_plan: QueryPlan              # what the context layer made of it
    status: ResolutionStatus
    resolved_referents: List[TypedReferent] = Field(default_factory=list)
    unresolved_referents: List[UnresolvedReferent] = Field(default_factory=list)
    # None when the turn adds nothing to build on: a greeting, a question that
    # could not be understood, or one still waiting for clarification.
    context: Optional[TurnContext] = None
    created_at: datetime


class ConversationState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: str = SCHEMA_VERSION
    conversation_id: str
    tenant_id: str
    user_id: str
    # The last committed sequence. Appends are compare-and-set on it, so two
    # writers cannot both become turn N+1.
    turn_count: int = 0
    # The latest contributing turn's context, materialised for inspection.
    active: Optional[TurnContext] = None
    active_turn: Optional[int] = None
    recent_turns: List[ConversationTurn] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    expires_at: datetime


# --------------------------------------------------------------------------- #
# the result of resolution
# --------------------------------------------------------------------------- #

class ResolutionMetadata(BaseModel):
    """Internal observability. Identifiers are hashed."""
    model_config = ConfigDict(extra="forbid")
    conversation_ref: Optional[str] = None
    turn_sequence: int = 1                # the sequence this turn would take
    context_version: str = SCHEMA_VERSION
    follow_up: bool = False
    cues: List[str] = Field(default_factory=list)
    context_items_used: int = 0
    referents_resolved: int = 0
    referents_unresolved: int = 0


class ResolvedQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: ResolutionStatus
    # Always a new object; the planner's plan is never modified in place.
    # For CONTEXT_REQUIRED / CONTEXT_AMBIGUOUS it is shaped as an unresolved
    # follow-up, so the Policy Gate independently refuses to run it.
    resolved_plan: QueryPlan
    resolved_referents: List[TypedReferent] = Field(default_factory=list)
    unresolved_referents: List[UnresolvedReferent] = Field(default_factory=list)
    context_used: List[ContextUse] = Field(default_factory=list)
    resets: List[str] = Field(default_factory=list)
    # "compare THAT with Hyderabad": both sides, typed.
    comparison_subjects: List[Location] = Field(default_factory=list)
    turn_context: Optional[TurnContext] = None
    metadata: ResolutionMetadata = Field(default_factory=ResolutionMetadata)


def ref(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]
