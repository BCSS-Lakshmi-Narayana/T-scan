"""
models.py — the QueryPlan contract.

This is the boundary between natural language and execution. Everything
downstream (policy gate, orchestrator, tools, evidence, verification) reads a
QueryPlan and nothing else, so the contract has to be typed, validated and
stable rather than "whatever the model returned".

Three rules shape every model here:

  1. NOTHING IS ANSWERED. A plan describes what to find out, never what the
     answer is. There is no field for results.

  2. EVERY VALUE CARRIES ITS PROVENANCE. A filter the user typed and a filter
     a 7B model guessed are both `sentiment=negative`, and treating them as
     equally trustworthy is how a wrong guess silently narrows a search to
     nothing. `source` and `confidence` travel with the value.

  3. NOTHING HERE GRANTS ACCESS. The plan may *request* a district; it can
     never assert one. Tenant and district authorisation stay with the
     security layer, which combines them with the plan later. The LLM is never
     asked for, and never believed about, who the caller is.

Unresolved is a first-class state. "Hyderabad" is a location the user named,
not a location the system has resolved, and saying so is what stops a later
stage from quietly filtering on a district that was never verified.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

PLAN_VERSION = "1.0"


# --------------------------------------------------------------------------- #
# controlled vocabularies
# --------------------------------------------------------------------------- #

class Intent(str, Enum):
    """WHAT the user wants done. Kept small and extensible on purpose."""
    LOOKUP = "lookup"                        # fetch specific records
    FILTERED_SEARCH = "filtered_search"      # search narrowed by facets
    AGGREGATION = "aggregation"              # counts, distributions, rankings
    TREND_ANALYSIS = "trend_analysis"        # movement over time
    COMPARISON = "comparison"                # A against B
    CLASSIFICATION = "classification"        # label these records
    SITUATION_ANALYSIS = "situation_analysis"  # "what is happening with X"
    UNKNOWN_CONCEPT = "unknown_concept"      # names something nothing is tagged with
    DEEP_SCAN = "deep_scan"                  # exhaustive, explicitly requested
    FOLLOW_UP = "follow_up"                  # depends on the previous turn
    MULTI_PART = "multi_part"                # several questions in one
    # Not in the target taxonomy, required for parity with the live router:
    # greetings and capability questions must still be representable or the
    # new layer cannot describe traffic the old one already handles.
    CONVERSATIONAL = "conversational"


class Shape(str, Enum):
    """HOW it must be executed. Deliberately separate from Intent: "how many
    alerts yesterday" is intent=aggregation, shape=analytical, and an
    orchestrator routes on shape while a policy gate reasons about intent."""
    SIMPLE_LOOKUP = "simple_lookup"
    FILTERED = "filtered"
    ANALYTICAL = "analytical"
    TREND = "trend"
    COMPARISON = "comparison"
    GROUND_LEVEL = "ground_level"
    SITUATION = "situation"
    MULTI_PART = "multi_part"
    FOLLOW_UP = "follow_up"
    UNKNOWN_CONCEPT = "unknown_concept"
    DEEP_SCAN = "deep_scan"
    CONVERSATIONAL = "conversational"


class Need(str, Enum):
    """The kind of evidence required — not the tool that produces it."""
    SEARCH = "search"
    EXACT_LOOKUP = "exact_lookup"
    AGGREGATION = "aggregation"
    CLASSIFICATION = "classification"
    LOCATION_RESOLUTION = "location_resolution"
    CONCEPT_RESOLUTION = "concept_resolution"
    TREND_ANALYSIS = "trend_analysis"
    COMPARISON = "comparison"
    SITUATION_ANALYSIS = "situation_analysis"
    DEEP_SCAN = "deep_scan"
    EVIDENCE = "evidence"
    NONE = "none"


class Source(str, Enum):
    """Where a value came from. Drives merge precedence and explainability."""
    EXPLICIT = "explicit"        # the user's own words, matched by rule
    DETERMINISTIC = "deterministic"   # derived by rule from those words
    LLM = "llm"                  # the model's reading of intent
    CONTEXT = "context"          # carried from an earlier turn (future)
    DEFAULT = "default"          # system default, nobody asked for it


class FilterField(str, Enum):
    """Only fields the backend can actually filter on. Adding one here without
    a retriever behind it produces a plan that silently returns nothing."""
    PLATFORM = "platform"
    SENTIMENT = "sentiment"
    RISK_LEVEL = "risk_level"
    RISK_SCORE = "risk_score"
    CATEGORY = "category"
    DISTRICT = "district"
    KIND = "kind"
    HANDLE = "handle"
    TAGGED = "tagged"
    TOPIC = "topic"
    TARGET = "target"
    STANCE = "stance"
    CONTENT_TYPE = "content_type"


class FilterOp(str, Enum):
    EQ = "eq"
    IN = "in"
    NOT_EQ = "not_eq"
    GTE = "gte"
    LTE = "lte"
    BETWEEN = "between"
    EXISTS = "exists"


class TimeKind(str, Enum):
    """Relative time stays relative. Resolving "last 7 days" to timestamps
    inside understanding would make the plan unreproducible — the same plan
    replayed tomorrow would mean a different week. The execution layer
    resolves it against the request timestamp."""
    ALL_TIME = "all_time"
    TODAY = "today"
    YESTERDAY = "yesterday"
    LAST_N_HOURS = "last_n_hours"
    LAST_N_DAYS = "last_n_days"
    LAST_N_WEEKS = "last_n_weeks"
    LAST_N_MONTHS = "last_n_months"
    THIS_WEEK = "this_week"
    LAST_WEEK = "last_week"
    THIS_MONTH = "this_month"
    LAST_MONTH = "last_month"
    THIS_YEAR = "this_year"
    CUSTOM_RANGE = "custom_range"
    SINCE = "since"
    BEFORE = "before"
    AFTER = "after"
    UNRESOLVED = "unresolved"     # a temporal phrase we could not structure


class LocationType(str, Enum):
    STATE = "state"
    DISTRICT = "district"
    COMMISSIONERATE = "commissionerate"
    ZONE = "zone"
    DIVISION = "division"
    MANDAL = "mandal"
    VILLAGE = "village"
    CITY = "city"
    POLICE_STATION = "police_station"
    NEIGHBOURHOOD = "neighbourhood"
    COUNTRY = "country"
    UNKNOWN = "unknown"


class EntityType(str, Enum):
    PERSON = "person"
    ORGANISATION = "organisation"
    ACCOUNT = "account"          # @handle
    PLACE = "place"
    EVENT = "event"
    OTHER = "other"


class ConceptStatus(str, Enum):
    KNOWN = "known"              # in the curated vocabulary today
    CANDIDATE = "candidate"      # plausible, needs the concept service
    UNKNOWN = "unknown"          # nothing is tagged with this


# --------------------------------------------------------------------------- #
# value objects
# --------------------------------------------------------------------------- #

class Provenanced(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    source: Source = Source.DETERMINISTIC


class Filter(Provenanced):
    field: FilterField
    operator: FilterOp = FilterOp.EQ
    value: Any = None
    raw: Optional[str] = None          # the phrase this came from

    @field_validator("value")
    @classmethod
    def _no_empty(cls, v, info):
        if v in (None, "", []) and info.data.get("operator") != FilterOp.EXISTS:
            raise ValueError("filter value may not be empty")
        return v


class TimeRange(Provenanced):
    kind: TimeKind = TimeKind.ALL_TIME
    n: Optional[int] = Field(default=None, ge=1, le=3650)   # for last_n_*
    start: Optional[datetime] = None      # only for explicit dates
    end: Optional[datetime] = None
    raw: Optional[str] = None
    resolved: bool = False                # timestamps computed? not here

    @field_validator("n")
    @classmethod
    def _n_needed(cls, v, info):
        kind = info.data.get("kind")
        if kind in (TimeKind.LAST_N_DAYS, TimeKind.LAST_N_HOURS,
                    TimeKind.LAST_N_WEEKS, TimeKind.LAST_N_MONTHS) and v is None:
            raise ValueError(f"{kind} requires n")
        return v


class Location(Provenanced):
    text: str
    type: LocationType = LocationType.UNKNOWN
    # A name the user typed is not a place the system knows. Only the location
    # service may set this true.
    resolved: bool = False
    resolved_id: Optional[str] = None
    hierarchy: List[str] = Field(default_factory=list)


class Entity(Provenanced):
    text: str
    type: EntityType = EntityType.OTHER
    resolved_id: Optional[str] = None


class Concept(Provenanced):
    text: str
    normalized: Optional[str] = None
    status: ConceptStatus = ConceptStatus.CANDIDATE


class Referent(BaseModel):
    """An unresolved back-reference: "that", "there", "the previous week"."""
    model_config = ConfigDict(extra="forbid")
    token: str
    kind: str                       # topic | location | time | result | other
    resolved: bool = False
    resolved_value: Optional[str] = None


class Ambiguity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: str
    reason: str
    candidates: List[str] = Field(default_factory=list)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)


class Conflict(BaseModel):
    """Deterministic extraction and the model disagreed. Recorded, never
    silently resolved — the policy gate decides whether to ask."""
    model_config = ConfigDict(extra="forbid")
    field: str
    deterministic: Any = None
    llm: Any = None
    status: str = "conflict"
    resolution: str = "deterministic_wins"


class Confidence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    overall: float = Field(default=0.5, ge=0.0, le=1.0)
    fields: Dict[str, float] = Field(default_factory=dict)


class SubQuestion(BaseModel):
    """One part of a multi-part question. Deliberately shallow: sub-questions
    do not nest, because a plan that can recurse is a plan nobody can bound."""
    model_config = ConfigDict(extra="forbid")
    index: int
    text: str
    intent: Intent
    shape: Shape
    needs: List[Need] = Field(default_factory=list)
    required_tools: List[str] = Field(default_factory=list)
    filters: List[Filter] = Field(default_factory=list)
    metric: Optional[str] = None
    group_by: List[str] = Field(default_factory=list)


class PlanMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    request_id: Optional[str] = None
    # Set by the service, never by the model.
    deterministic_ms: float = 0.0
    llm_ms: float = 0.0
    total_ms: float = 0.0
    llm_used: bool = False
    llm_model: Optional[str] = None
    llm_attempts: int = 0
    prompt_version: Optional[str] = None
    #: How this plan was arrived at: rules alone, or rules plus a semantic
    #: reading. Recorded so a wrong answer can be traced to the layer that
    #: produced it without re-running the question.
    understanding_mode: Literal["deterministic", "hybrid"] = "deterministic"
    #: What the semantic layer said about its OWN reading, 0-1. Never a claim
    #: about the world.
    semantic_confidence: Optional[float] = None
    #: What the officer wants done, and how much reading it deserves. The
    #: analysis engine still owns the population SIZES; this only says which
    #: band the question falls in.
    operation: Optional[str] = None
    analysis_depth: Optional[str] = None
    planner_version: str = PLAN_VERSION
    # A reminder carried in the artefact itself: this plan authorises nothing.
    tenant_scope_required: bool = True


# --------------------------------------------------------------------------- #
# the plan
# --------------------------------------------------------------------------- #

class QueryPlan(BaseModel):
    """What the user asked for, structured. Never what the answer is."""
    model_config = ConfigDict(extra="forbid")

    version: str = PLAN_VERSION
    raw_query: str                       # never modified, never discarded
    normalized_query: str

    intent: Intent = Intent.FILTERED_SEARCH
    shape: Shape = Shape.FILTERED

    filters: List[Filter] = Field(default_factory=list)
    location: Optional[Location] = None
    time_range: TimeRange = Field(default_factory=TimeRange)
    concepts: List[Concept] = Field(default_factory=list)
    entities: List[Entity] = Field(default_factory=list)

    group_by: List[str] = Field(default_factory=list)
    metric: Optional[str] = None
    limit: Optional[int] = Field(default=None, ge=1, le=500)
    sort: Optional[str] = None

    sub_questions: List[SubQuestion] = Field(default_factory=list)

    needs: List[Need] = Field(default_factory=list)
    required_tools: List[str] = Field(default_factory=list)

    confidence: Confidence = Field(default_factory=Confidence)
    ambiguities: List[Ambiguity] = Field(default_factory=list)
    conflicts: List[Conflict] = Field(default_factory=list)
    referents: List[Referent] = Field(default_factory=list)

    degraded: bool = False
    degraded_reason: Optional[str] = None
    # How much of the question the plan believes it captured, 0..1. Distinct
    # from confidence: a plan can be confident about the half it understood.
    coverage: float = Field(default=1.0, ge=0.0, le=1.0)

    metadata: PlanMetadata = Field(default_factory=PlanMetadata)

    # -- convenience, used by tests and the future gate -------------------- #

    def filter_values(self, field: FilterField) -> List[Any]:
        return [f.value for f in self.filters if f.field == field]

    def has_filter(self, field: FilterField) -> bool:
        return any(f.field == field for f in self.filters)

    def unresolved_concepts(self) -> List[Concept]:
        return [c for c in self.concepts if c.status != ConceptStatus.KNOWN]


class ValidationIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")
    severity: str                   # error | warning
    field: str
    message: str


class ValidationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    valid: bool
    issues: List[ValidationIssue] = Field(default_factory=list)

    @property
    def errors(self) -> List[ValidationIssue]:
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self) -> List[ValidationIssue]:
        return [i for i in self.issues if i.severity == "warning"]
