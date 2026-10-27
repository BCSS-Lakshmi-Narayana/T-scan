"""
models.py — the execution contract.

    ResolvedQuery + PolicyResult  --compile-->  ExecutionPlan
    ExecutionPlan                 --execute-->  StepResults -> Evidence
    Evidence                      --verify-->   VerificationReport
    Evidence + Verification       --respond-->  AssistantResponse

Three rules:

  1. A STEP CAN ONLY NAME A CAPABILITY THE POLICY ALLOWED. Arguments are
     typed models with extra="forbid"; there is no free-form "args" dict, no
     code, no URL, no query document. The scope a step runs in is not an
     argument at all — it is taken from the PolicyResult at execution time.

  2. FACTS COME FROM TOOLS. Evidence carries the tool, step and record it
     came from. A number in a response must be traceable to one.

  3. EVERYTHING IS BOUNDED. Steps, dependencies, refinements, timeouts and
     result sizes all have ceilings stated here or in config.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

from policy.models import Capability

EXEC_VERSION = "exec-1"
MAX_STEPS = 16
MAX_REFINEMENTS = 2


class ExecutionMode(str, Enum):
    DETERMINISTIC = "deterministic"
    BOUNDED_AGENT = "bounded_agent"
    DEGRADED = "degraded"
    NONE = "none"                      # conversational, clarification, denial


class StepStatus(str, Enum):
    PENDING = "pending"
    OK = "ok"
    EMPTY = "empty"                    # ran, found nothing — a real answer
    FAILED = "failed"
    TIMED_OUT = "timed_out"
    SKIPPED = "skipped"                # a dependency failed
    CANCELLED = "cancelled"


# --------------------------------------------------------------------------- #
# typed arguments — one model per operation, nothing free-form
# --------------------------------------------------------------------------- #

class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SpecArgs(_Args):
    """The filter part of a request, in the retriever's own vocabulary."""
    text: str = ""
    kinds: List[str] = Field(default_factory=list)
    sentiment: Optional[str] = None
    risk_levels: List[str] = Field(default_factory=list)
    min_risk_score: Optional[int] = None
    categories: List[str] = Field(default_factory=list)
    stance: Optional[str] = None
    topics: List[str] = Field(default_factory=list)
    targets: List[str] = Field(default_factory=list)
    handles: List[str] = Field(default_factory=list)
    tagged: List[str] = Field(default_factory=list)
    platforms: List[str] = Field(default_factory=list)
    since: Optional[str] = None        # ISO, resolved from the plan's relative time
    until: Optional[str] = None
    limit: int = Field(default=15, ge=1, le=100)
    sort: Literal["relevance", "risk", "recent"] = "relevance"


class LocationArgs(_Args):
    text: str = Field(max_length=120)


class SearchArgs(_Args):
    spec: SpecArgs
    semantic: bool = True


class LookupArgs(_Args):
    spec: SpecArgs


class AggregateArgs(_Args):
    spec: SpecArgs
    group_by: List[str] = Field(default_factory=list, max_length=4)
    metric: Literal["count"] = "count"
    total: bool = True


class TrendArgs(_Args):
    spec: SpecArgs
    window_days: int = Field(default=30, ge=1, le=366)
    bucket: Literal["day", "week", "month"] = "day"


class ClassifyArgs(_Args):
    spec: SpecArgs
    labels: List[str] = Field(min_length=1, max_length=8)
    question: str = Field(max_length=500)
    deep: bool = False


class ConceptArgs(_Args):
    spec: SpecArgs
    label: str = Field(min_length=1, max_length=80)
    question: str = Field(max_length=500)


class RelatedArgs(_Args):
    spec: SpecArgs
    top_k: int = Field(default=10, ge=1, le=50)


class CompareSide(_Args):
    label: str = Field(max_length=80)
    districts: Optional[List[str]] = None       # narrowing only; intersected with scope
    since: Optional[str] = None
    until: Optional[str] = None


class CompareArgs(_Args):
    spec: SpecArgs
    sides: List[CompareSide] = Field(min_length=2, max_length=4)


class SituationArgs(_Args):
    spec: SpecArgs
    subject: str = Field(max_length=200)
    window_days: int = Field(default=7, ge=1, le=90)


StepArgs = Union[LocationArgs, SearchArgs, LookupArgs, AggregateArgs, TrendArgs,
                 ClassifyArgs, ConceptArgs, RelatedArgs, CompareArgs, SituationArgs]


class ExecutionStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    step_id: str = Field(pattern=r"^[a-z0-9_.-]{1,48}$")
    tool: Capability
    operation: str
    arguments: StepArgs
    dependencies: List[str] = Field(default_factory=list)
    purpose: str
    input_sources: List[str] = Field(default_factory=list)   # step ids whose output it reads
    output_schema: str = "records"
    essential: bool = True
    sub_question: Optional[int] = None
    provenance: Dict[str, Any] = Field(default_factory=dict)


class ExecutionPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str = EXEC_VERSION
    request_id: str
    mode: ExecutionMode
    steps: List[ExecutionStep] = Field(default_factory=list, max_length=MAX_STEPS)
    # Scope is copied from the PolicyResult, never computed here.
    effective_districts: Optional[List[str]] = None
    execution_districts: Optional[List[str]] = None   # effective ∩ resolved place
    # Set when the QUESTION named a place: records must be TAGGED to one of
    # these districts. Visibility alone (untagged = tenant-wide) is not enough
    # for "incidents in Karimnagar".
    place_districts: Optional[List[str]] = None
    constraints: Dict[str, Any] = Field(default_factory=dict)
    allowed_capabilities: List[Capability] = Field(default_factory=list)
    expected_outputs: List[str] = Field(default_factory=list)
    coverage: float = 1.0
    degraded: bool = False
    limitations: List[str] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)


# --------------------------------------------------------------------------- #
# results and evidence
# --------------------------------------------------------------------------- #

class StepResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    step_id: str
    tool: Capability
    status: StepStatus
    output: Dict[str, Any] = Field(default_factory=dict)
    error: Optional[str] = None
    took_ms: float = 0.0
    result_count: int = 0


class Evidence(BaseModel):
    """One fact or record a response may rest on."""
    model_config = ConfigDict(extra="forbid")
    evidence_id: str                      # E1, E2 … stable within a response
    source_type: Literal["record", "aggregate", "trend", "comparison", "location",
                         "verdict", "entity", "situation"]
    source_id: Optional[str] = None       # record key / document id
    collection: Optional[str] = None
    content: str = ""
    facts: Dict[str, Any] = Field(default_factory=dict)
    tool: Capability
    step_id: str
    # Internal: the scope the fact was read under. Stripped from public output.
    tenant_ref: Optional[str] = None
    districts: List[str] = Field(default_factory=list)
    timestamp: Optional[str] = None
    url: Optional[str] = None
    confidence: float = 1.0
    provenance: Dict[str, Any] = Field(default_factory=dict)


class VerificationIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")
    check: str
    severity: Literal["error", "warning", "info"]
    detail: str
    evidence_ids: List[str] = Field(default_factory=list)


class VerificationReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    passed: bool
    issues: List[VerificationIssue] = Field(default_factory=list)
    evidence_checked: int = 0
    evidence_removed: List[str] = Field(default_factory=list)
    sufficiency: Literal["sufficient", "partial", "empty", "insufficient"] = "sufficient"


class Citation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    evidence_id: str
    label: str
    url: Optional[str] = None


class Populations(BaseModel):
    """The three different sizes an answer has, never collapsed into one.

    `matching` is what the filters select, `analysed` is what the model has
    actually read, `displayed` is what is on screen. Reporting one of these as
    another is how "20 of 4,669 examined" came to describe an answer reasoned
    from seven records.
    """
    model_config = ConfigDict(extra="forbid")
    matching: Optional[int] = None
    analysed: int = 0
    displayed: int = 0


class AssistantResponse(BaseModel):
    """What the officer sees, in separable parts. `facts` are copied from
    tools; `interpretation` is the model's and is labelled as such."""
    model_config = ConfigDict(extra="forbid")
    request_id: str
    status: Literal["answered", "partial", "empty", "clarification", "denied", "error",
                    "conversational"]
    answer: str = ""
    facts: List[Dict[str, Any]] = Field(default_factory=list)
    analysis: Dict[str, Any] = Field(default_factory=dict)
    populations: Populations = Field(default_factory=Populations)
    interpretation: Optional[str] = None
    limitations: List[str] = Field(default_factory=list)
    evidence: List[Dict[str, Any]] = Field(default_factory=list)
    citations: List[Citation] = Field(default_factory=list)
    clarification: Optional[Dict[str, Any]] = None
    confidence: float = 0.0
    degraded: bool = False
    generated_by: Literal["template", "llm"] = "template"
    unsupported_claims_removed: int = 0
