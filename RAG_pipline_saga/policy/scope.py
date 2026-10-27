"""
scope.py — tenant and district rules. Pure functions, no I/O.

Two distinctions carry the whole file:

  districts=None vs districts=[]
      None is no district scoping and is honoured only for a role the config
      names as unrestricted. [] is an officer with zero districts and matches
      nothing. Both are falsy in Python, which is exactly how they get merged.

  scope narrowing vs query rewriting
      Narrowing: the caller's UI selection, or a state-wide question, is
      intersected with what the caller may see, and the result says so.
      Rewriting: the officer ASKED about Warangal and is silently answered
      about Hyderabad. The first is allowed and flagged; the second never
      happens — a named district outside scope is refused, not substituted.

The gate verifies a tenant's form, never its existence: the registry lookup
(tenants.resolve) is a control-plane read and belongs to the API layer, which
already performs it on every data route.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from query_understanding.models import (FilterField, LocationType, QueryPlan,
                                        TimeKind, TimeRange)

from .config import PolicyConfig
from .models import DistrictMode, ReasonCode, RequestContext

# Wildcards and sentinels that must never be read as "every tenant". The
# character class is tenants._UNSAFE — the same one the database-name
# sanitiser rejects — kept here so the gate imports no database module.
_WILDCARD_TENANTS = {"*", "all", "any", "none", "null", "undefined", "__all__"}
_UNSAFE_TENANT_CHARS = re.compile(r'[/\\. "$*<>:|?]')
# "__none__" is ragController's query-param encoding of districts=[]; as a
# literal district it would be a decoding bug, not a place.
_INVALID_DISTRICTS = {"*", "__none__", "all", "any"}


def check_tenant(ctx: RequestContext, requested_tenant_id: Optional[str]) -> Optional[ReasonCode]:
    tid = (ctx.tenant_id or "").strip()
    if not tid:
        return ReasonCode.TENANT_REQUIRED
    if tid.lower() in _WILDCARD_TENANTS or _UNSAFE_TENANT_CHARS.search(tid):
        return ReasonCode.TENANT_INVALID
    if requested_tenant_id is not None and requested_tenant_id.strip() != tid:
        return ReasonCode.TENANT_MISMATCH
    return None


def is_admin(ctx: RequestContext, config: PolicyConfig) -> bool:
    return (ctx.role or "") in config.admin_roles


def district_mode(ctx: RequestContext, config: PolicyConfig) -> Tuple[Optional[DistrictMode], Optional[ReasonCode]]:
    if ctx.districts is None:
        if (ctx.role or "") in config.unrestricted_district_roles:
            return DistrictMode.UNRESTRICTED, None
        # Missing scope is never promoted to unrestricted.
        return None, ReasonCode.DISTRICT_SCOPE_REQUIRED
    if any(d.lower() in _INVALID_DISTRICTS for d in ctx.districts):
        return None, ReasonCode.DISTRICT_SCOPE_INVALID
    if not ctx.districts:
        return DistrictMode.NONE, None
    return DistrictMode.RESTRICTED, None


@dataclass
class ScopeFinding:
    code: ReasonCode
    detail: Optional[str] = None
    sub_question: Optional[int] = None


@dataclass
class ScopeOutcome:
    effective: Optional[List[str]]
    findings: List[ScopeFinding] = field(default_factory=list)
    summary: str = ""


def _fold(s: str) -> str:
    return " ".join(str(s).split()).casefold()


def _named_districts(plan: QueryPlan) -> List[Tuple[str, Optional[int]]]:
    """(name, sub_question) for every DISTRICT filter the question carries,
    whether the rules or the model produced it — provenance never widens."""
    out: List[Tuple[str, Optional[int]]] = []

    def from_filters(filters, idx):
        for f in filters:
            if f.field is not FilterField.DISTRICT:
                continue
            values = f.value if isinstance(f.value, (list, tuple)) else [f.value]
            for v in values:
                if isinstance(v, str) and v.strip():
                    out.append((v.strip(), idx))

    from_filters(plan.filters, None)
    for sub in plan.sub_questions:
        from_filters(sub.filters, sub.index)
    return out


def resolve_scope(plan: QueryPlan, ctx: RequestContext, mode: DistrictMode,
                  requested_districts: Optional[List[str]]) -> ScopeOutcome:
    """The districts execution may touch, plus what the gate had to say about
    how the question's own places relate to them."""
    allowed = ctx.districts or []
    allowed_folded = {_fold(d): d for d in allowed}
    findings: List[ScopeFinding] = []

    # -- 1. the caller's own selection: narrowing is safe -------------------- #
    effective: Optional[List[str]]
    if mode is DistrictMode.UNRESTRICTED:
        effective = None
        if requested_districts is not None:
            effective = [d.strip() for d in requested_districts if d and d.strip()]
    elif mode is DistrictMode.NONE:
        effective = []
    else:
        effective = list(allowed)
        if requested_districts is not None:
            picked = [allowed_folded[_fold(d)] for d in requested_districts
                      if d and _fold(d) in allowed_folded]
            dropped = [d for d in requested_districts if d and _fold(d) not in allowed_folded]
            if dropped and not picked:
                # Nothing requested is visible; intersecting to [] would read
                # as "no results", not "not permitted".
                findings.append(ScopeFinding(ReasonCode.DISTRICT_OUTSIDE_SCOPE,
                                             ", ".join(sorted(dropped))))
            elif dropped:
                findings.append(ScopeFinding(ReasonCode.SCOPE_NARROWED,
                                             ", ".join(sorted(dropped))))
            effective = sorted(set(picked)) if picked else effective

    # -- 2. places the question names: never rewritten ----------------------- #
    if mode is DistrictMode.RESTRICTED:
        for name, idx in _named_districts(plan):
            if _fold(name) in allowed_folded:
                continue
            findings.append(ScopeFinding(ReasonCode.DISTRICT_OUTSIDE_SCOPE, name, idx))

        loc = plan.location
        if loc is not None and _fold(loc.text) not in allowed_folded:
            if loc.type is LocationType.DISTRICT:
                findings.append(ScopeFinding(ReasonCode.DISTRICT_OUTSIDE_SCOPE, loc.text))
            elif loc.type in (LocationType.STATE, LocationType.COUNTRY):
                # Wider than the caller's scope: answer the part they may see
                # and say so.
                findings.append(ScopeFinding(ReasonCode.SCOPE_NARROWED, loc.text))
            else:
                # A city, commissionerate or unknown place. Without the
                # location service there is no hierarchy to test it against.
                # Execution is still confined to `effective`, so nothing leaks;
                # the officer is told the check could not be made.
                findings.append(ScopeFinding(ReasonCode.LOCATION_SCOPE_UNVERIFIED, loc.text))

    summary = {DistrictMode.UNRESTRICTED: "unrestricted" if effective is None else "admin-narrowed",
               DistrictMode.NONE: "no-districts",
               DistrictMode.RESTRICTED: "restricted"}[mode]
    if any(f.code is ReasonCode.DISTRICT_OUTSIDE_SCOPE for f in findings):
        summary += ":outside-scope"
    elif any(f.code is ReasonCode.SCOPE_NARROWED for f in findings):
        summary += ":narrowed"
    return ScopeOutcome(effective=effective, findings=findings, summary=summary)


# --------------------------------------------------------------------------- #
# time — classified by size, never resolved to dates
# --------------------------------------------------------------------------- #

_FIXED_DAYS = {
    TimeKind.TODAY: 1, TimeKind.YESTERDAY: 1,
    TimeKind.THIS_WEEK: 7, TimeKind.LAST_WEEK: 7,
    TimeKind.THIS_MONTH: 31, TimeKind.LAST_MONTH: 31,
    TimeKind.THIS_YEAR: 366,
}
_PER_N = {TimeKind.LAST_N_DAYS: 1, TimeKind.LAST_N_WEEKS: 7, TimeKind.LAST_N_MONTHS: 31}

# Open-ended or unknown size: the gate cannot bound them without a clock.
UNBOUNDED_KINDS = frozenset({TimeKind.ALL_TIME, TimeKind.SINCE, TimeKind.AFTER,
                             TimeKind.BEFORE, TimeKind.UNRESOLVED})


def window_days(tr: TimeRange) -> Optional[int]:
    """Upper bound on the range's length in days, or None when the range is
    open-ended. Worst case per kind (a month counts as 31), so a limit is
    never passed by a short month."""
    if tr.kind in _FIXED_DAYS:
        return _FIXED_DAYS[tr.kind]
    if tr.kind in _PER_N and tr.n:
        return tr.n * _PER_N[tr.kind]
    if tr.kind is TimeKind.LAST_N_HOURS and tr.n:
        return max(1, math.ceil(tr.n / 24))
    if tr.kind is TimeKind.CUSTOM_RANGE and tr.start and tr.end:
        return max(1, (tr.end - tr.start).days + 1)
    return None
