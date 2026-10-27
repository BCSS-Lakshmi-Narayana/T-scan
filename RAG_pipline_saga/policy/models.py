"""
models.py — the Policy Gate's typed contract.

    QueryPlan + RequestContext + PolicyConfig  ->  PolicyResult

The plan says what was asked. The context says who is asking. The result says
what may run. Those three never merge: the plan carries no authority, the
context carries no question, and the result carries no answer.

Everything here is deterministic. The result holds no clock reading and no
random id, so the same inputs always serialise to the same bytes, which is
what makes a policy decision replayable in an audit.
"""

from __future__ import annotations

import hashlib
import logging
from enum import Enum
from typing import Dict, FrozenSet, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)

from query_understanding.models import TimeRange


# --------------------------------------------------------------------------- #
# controlled vocabularies
# --------------------------------------------------------------------------- #

class Capability(str, Enum):
    """One per Phase 1A tool. Import-time checked against tools.REGISTRY in
    registry.py, so the two vocabularies cannot drift apart silently."""
    LOOKUP_RECORDS = "lookup_records"
    HYBRID_SEARCH = "hybrid_search"
    AGGREGATE = "aggregate"
    TREND_ANALYSIS = "trend_analysis"
    CLASSIFY_RECORDS = "classify_records"
    UNKNOWN_CONCEPT_SEARCH = "unknown_concept_search"
    LOCATION_RESOLVE = "location_resolve"
    RELATED_CONTENT_SEARCH = "related_content_search"
    COMPARE_RESULTS = "compare_results"
    SITUATION_ANALYSIS = "situation_analysis"
    DEEP_SCAN = "deep_scan"


class PolicyDecision(str, Enum):
    ALLOWED = "allowed"
    DEGRADED = "degraded"
    CLARIFICATION_REQUIRED = "clarification_required"
    DENIED = "denied"


class Severity(str, Enum):
    """What a reason does to the decision. The decision is the worst severity
    present, so it is a pure function of the reasons."""
    ERROR = "error"          # -> DENIED
    CLARIFY = "clarify"      # -> CLARIFICATION_REQUIRED
    DEGRADE = "degrade"      # -> DEGRADED
    WARNING = "warning"      # travels downstream, decision unchanged
    INFO = "info"


class ReasonCode(str, Enum):
    # tenant
    TENANT_REQUIRED = "TENANT_REQUIRED"
    TENANT_INVALID = "TENANT_INVALID"
    TENANT_MISMATCH = "TENANT_MISMATCH"
    # identity
    ROLE_NOT_PERMITTED = "ROLE_NOT_PERMITTED"
    PERMISSION_REQUIRED = "PERMISSION_REQUIRED"
    # district
    DISTRICT_SCOPE_REQUIRED = "DISTRICT_SCOPE_REQUIRED"
    DISTRICT_SCOPE_INVALID = "DISTRICT_SCOPE_INVALID"
    DISTRICT_SCOPE_EMPTY = "DISTRICT_SCOPE_EMPTY"
    DISTRICT_OUTSIDE_SCOPE = "DISTRICT_OUTSIDE_SCOPE"
    SCOPE_NARROWED = "SCOPE_NARROWED"
    LOCATION_SCOPE_UNVERIFIED = "LOCATION_SCOPE_UNVERIFIED"
    LOCATION_AMBIGUOUS = "LOCATION_AMBIGUOUS"
    # capability
    UNKNOWN_TOOL = "UNKNOWN_TOOL"
    UNSAFE_PLAN = "UNSAFE_PLAN"
    CAPABILITY_NOT_ALLOWED = "CAPABILITY_NOT_ALLOWED"
    CAPABILITY_DISABLED = "CAPABILITY_DISABLED"
    CAPABILITY_UNAVAILABLE = "CAPABILITY_UNAVAILABLE"
    # plan shape
    INVALID_PLAN = "INVALID_PLAN"
    PLAN_EMPTY = "PLAN_EMPTY"
    UNSUPPORTED_METRIC = "UNSUPPORTED_METRIC"
    UNSUPPORTED_GROUPING = "UNSUPPORTED_GROUPING"
    # time
    TIME_RANGE_REQUIRED = "TIME_RANGE_REQUIRED"
    TIME_RANGE_UNRESOLVED = "TIME_RANGE_UNRESOLVED"
    TIME_RANGE_EXCEEDS_LIMIT = "TIME_RANGE_EXCEEDS_LIMIT"
    TIME_RANGE_DEFAULTED = "TIME_RANGE_DEFAULTED"
    # bounds and context
    BOUNDED_BY_RECORD_CAP = "BOUNDED_BY_RECORD_CAP"
    CONTEXT_REQUIRED = "CONTEXT_REQUIRED"
    REFERENT_UNRESOLVED = "REFERENT_UNRESOLVED"
    PLANNER_CONFLICT = "PLANNER_CONFLICT"


# User-safe text per code. Fixed strings: no tenant, no permission id, no
# internal name ever reaches an officer through a reason.
PUBLIC_MESSAGES: Dict[ReasonCode, str] = {
    ReasonCode.TENANT_REQUIRED: "Your session has no organisation context.",
    ReasonCode.TENANT_INVALID: "Your session's organisation context is not valid.",
    ReasonCode.TENANT_MISMATCH: "This request does not match your organisation.",
    ReasonCode.ROLE_NOT_PERMITTED: "Your role cannot use the assistant.",
    ReasonCode.PERMISSION_REQUIRED: "You do not have access to this assistant feature.",
    ReasonCode.DISTRICT_SCOPE_REQUIRED: "Your account has no district scope configured.",
    ReasonCode.DISTRICT_SCOPE_INVALID: "Your account's district scope is not valid.",
    ReasonCode.DISTRICT_SCOPE_EMPTY: "No districts are assigned to your account.",
    ReasonCode.DISTRICT_OUTSIDE_SCOPE: "The district you asked about is outside your assigned scope.",
    ReasonCode.SCOPE_NARROWED: "Results are limited to your assigned districts.",
    ReasonCode.LOCATION_SCOPE_UNVERIFIED: "The place you named could not be checked against your districts; results stay within your scope.",
    ReasonCode.LOCATION_AMBIGUOUS: "The place you named can mean more than one area.",
    ReasonCode.UNKNOWN_TOOL: "The request asked for an operation that does not exist.",
    ReasonCode.UNSAFE_PLAN: "The request could not be interpreted safely.",
    ReasonCode.CAPABILITY_NOT_ALLOWED: "That operation does not apply to this kind of question.",
    ReasonCode.CAPABILITY_DISABLED: "That operation is currently switched off.",
    ReasonCode.CAPABILITY_UNAVAILABLE: "That operation is not available yet.",
    ReasonCode.INVALID_PLAN: "The request could not be interpreted.",
    ReasonCode.PLAN_EMPTY: "The question could not be understood.",
    ReasonCode.UNSUPPORTED_METRIC: "That measure is not supported; only counts are available.",
    ReasonCode.UNSUPPORTED_GROUPING: "Results cannot be grouped that way.",
    ReasonCode.TIME_RANGE_REQUIRED: "Please give a time period for this operation.",
    ReasonCode.TIME_RANGE_UNRESOLVED: "The time period could not be understood.",
    ReasonCode.TIME_RANGE_EXCEEDS_LIMIT: "The time period is longer than this operation allows.",
    ReasonCode.TIME_RANGE_DEFAULTED: "No time period was given; the default period is used.",
    ReasonCode.BOUNDED_BY_RECORD_CAP: "Only the most recent records within the limit are examined.",
    ReasonCode.CONTEXT_REQUIRED: "This question refers to an earlier one; please restate it in full.",
    ReasonCode.REFERENT_UNRESOLVED: "Part of the question refers to something not stated.",
    ReasonCode.PLANNER_CONFLICT: "Part of the question could be read two ways.",
}


# --------------------------------------------------------------------------- #
# request context — who is asking. Built by the security layer, never the plan
# --------------------------------------------------------------------------- #

class DistrictMode(str, Enum):
    UNRESTRICTED = "unrestricted"   # districts=None, and the role may have it
    RESTRICTED = "restricted"       # districts=[...]
    NONE = "none"                   # districts=[] — matches nothing


class RequestContext(BaseModel):
    """The authenticated caller, in the shape the Node layer already produces:
    ``req.tenantId``, ``req.user.{id, role, districts}`` and the RBAC
    permission set ``req.rbac`` resolves.

    ``districts`` keeps its load-bearing meaning: None is no district scoping
    (admin), [] is an officer with zero districts and matches nothing. The
    two are never collapsed, and None is honoured only for a role configured
    as unrestricted — see scope.district_mode.

    There is no ``is_admin`` field to set. Admin is derived from the role, so
    a caller cannot claim it independently of the role that grants it.
    """
    model_config = ConfigDict(extra="forbid", frozen=True)

    tenant_id: Optional[str] = None
    user_id: Optional[str] = None
    role: Optional[str] = None
    districts: Optional[List[str]] = None
    # Flattened RBAC grants, "<page>:<feature>" — see permissions_from_rbac().
    permissions: FrozenSet[str] = Field(default_factory=frozenset)

    @field_validator("districts")
    @classmethod
    def _strip(cls, v):
        # Blank entries are dropped, never widened: [" "] becomes [] (nothing),
        # not None (everything).
        if v is None:
            return None
        return [d.strip() for d in v if isinstance(d, str) and d.strip()]


def permissions_from_rbac(rbac_permissions: Optional[dict]) -> FrozenSet[str]:
    """Flatten the Node RBAC shape ``{"/page": {enabled, features: [...]}}``
    (``req.rbac.permissions``) into "<page>:<feature>" grants.

    Mirrors rbacMiddleware.hasFeatureAccess: a feature counts only when its
    page is enabled. A disabled page grants nothing, whatever it lists.
    """
    out = set()
    for page, grant in (rbac_permissions or {}).items():
        if isinstance(grant, list):
            # The shape a caller reaches for by hand: {"/page": ["feature"]}.
            # It flattens to nothing, so every non-admin caller is denied and
            # the harness reports a security failure that is its own. Silent
            # before; said out loud now.
            logger.warning(
                "rbac permissions for %r are a list, not %s — this grants "
                "nothing. Every feature under this page will be denied.",
                page, '{"enabled": true, "features": [...]}')
            continue
        if not isinstance(grant, dict) or not grant.get("enabled"):
            continue
        path = "/" + str(page).strip("/")
        for feature in grant.get("features") or []:
            if isinstance(feature, str) and feature:
                out.add(f"{path}:{feature}")
    return frozenset(out)


# --------------------------------------------------------------------------- #
# the result
# --------------------------------------------------------------------------- #

class PolicyReason(BaseModel):
    """Structured and closed: a code from the taxonomy, never model text.
    ``detail`` holds only values the user supplied (a district they named, a
    metric they asked for) — never a tenant, permission id or secret."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    code: ReasonCode
    severity: Severity
    source: str = "policy"                 # policy | plan | context
    capability: Optional[Capability] = None
    sub_question: Optional[int] = None
    field: Optional[str] = None
    detail: Optional[str] = None


class Constraints(BaseModel):
    """What the orchestrator must honour when it executes. Limits come from
    existing configuration (scan.py, analytics.py) or from PolicyConfig —
    nothing is invented here."""
    model_config = ConfigDict(extra="forbid")
    tenant_scoped: bool = True
    district_mode: DistrictMode
    # Relative time is passed through untouched. The gate classifies a
    # range's size; it never turns "last week" into dates.
    time_range: TimeRange
    time_window_days_max: Optional[int] = None
    trend_default_window_days: Optional[int] = None
    max_window_records: Optional[int] = None
    recall_pool: Optional[int] = None
    judge_pool: Optional[int] = None
    deep_scan_max_records: Optional[int] = None
    deep_scan_max_days: Optional[int] = None
    location_as_free_text: bool = False
    # Filters only the model proposed. Downstream may relax them; it may not
    # treat them as the user's own words.
    soft_filters: List[str] = Field(default_factory=list)
    # Multi-part plans run whole or not at all. Partial execution is not a
    # defined-safe mode in this architecture.
    partial_execution: bool = False


class SubDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    index: int
    decision: PolicyDecision
    capabilities: List[Capability] = Field(default_factory=list)
    reason_codes: List[ReasonCode] = Field(default_factory=list)


class RuleTrace(BaseModel):
    """Provenance: which rule ran and what it concluded."""
    model_config = ConfigDict(extra="forbid")
    rule: str
    outcome: str                       # pass | fail | skip | apply


class PolicyAudit(BaseModel):
    """Internal audit record. Identifiers are hashed; nothing here is written
    anywhere in Phase 1B — it is returned for the caller to log."""
    model_config = ConfigDict(extra="forbid")
    policy_version: str
    config_fingerprint: str
    request_id: Optional[str] = None
    tenant_ref: Optional[str] = None       # sha256 prefix, never the raw id
    user_ref: Optional[str] = None
    role: Optional[str] = None
    district_mode: Optional[DistrictMode] = None
    decision: PolicyDecision
    requested_capabilities: List[Capability] = Field(default_factory=list)
    allowed_capabilities: List[Capability] = Field(default_factory=list)
    blocked_capabilities: List[Capability] = Field(default_factory=list)
    scope_decision: str
    reason_codes: List[ReasonCode] = Field(default_factory=list)


class PolicyResult(BaseModel):
    """What may run. Never what the answer is — there is no results field."""
    model_config = ConfigDict(extra="forbid")

    decision: PolicyDecision
    requested_capabilities: List[Capability] = Field(default_factory=list)
    # Non-empty only for ALLOWED / DEGRADED: the orchestrator may execute
    # these and nothing else.
    allowed_capabilities: List[Capability] = Field(default_factory=list)
    blocked_capabilities: List[Capability] = Field(default_factory=list)
    # None = unrestricted (admin), [] = nothing, [..] = exactly these.
    effective_districts: Optional[List[str]] = None
    constraints: Optional[Constraints] = None
    reasons: List[PolicyReason] = Field(default_factory=list)
    sub_decisions: List[SubDecision] = Field(default_factory=list)
    policy_version: str
    config_fingerprint: str
    trace: List[RuleTrace] = Field(default_factory=list)
    audit: PolicyAudit

    def reason_codes(self) -> List[ReasonCode]:
        return [r.code for r in self.reasons]

    def public(self) -> dict:
        """The officer-facing view: decision and fixed messages only. No
        tenant, no permission ids, no capability internals beyond names."""
        seen, reasons = set(), []
        for r in self.reasons:
            if r.severity in (Severity.INFO,) or r.code in seen:
                continue
            seen.add(r.code)
            reasons.append({"code": r.code.value, "message": PUBLIC_MESSAGES[r.code]})
        return {"decision": self.decision.value, "reasons": reasons}


def ref(value: Optional[str]) -> Optional[str]:
    """A stable, non-reversible reference for audit correlation."""
    if not value:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]
