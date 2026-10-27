"""
verify.py — nothing reaches the response unchecked.

Checks, in order, each recorded as an issue:

  tenant        a record carrying another tenant's id is REMOVED (error)
  district      a record outside the execution districts is REMOVED (error);
                records with no districts are tenant-wide and allowed
  filters       semantic retrieval ranks by similarity inside the scope but
                does not apply facet filters, so a record contradicting an
                EXPLICIT filter (sentiment, risk, platform, kind) is REMOVED
  time          a record outside the resolved window is REMOVED
  duplicates    the same record twice is collapsed
  aggregates    counts are non-negative integers; a scalar facet's buckets
                cannot sum above its total; a trend's percentage is recomputed
  contradiction two tools counting the same thing differently is flagged
  sources       records without a link are noted (cited by id instead)
  sufficiency   empty is a real answer ("none in scope"), not an error

The database's numbers are authoritative: verification may REMOVE records a
response would cite, and may FLAG numbers, but it never edits a count.
"""

from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Optional

from query_understanding.models import FilterField, QueryPlan, Source

from enrichment import location as loc

from . import timeutil
from .models import (Evidence, ExecutionPlan, VerificationIssue,
                     VerificationReport)

_SCALAR_FACETS = {"handle", "platform", "sentiment", "risk_level", "category", "kind"}


def _in_scope(ev_districts: List[str], allowed: Optional[List[str]]) -> bool:
    if allowed is None or not ev_districts:
        return True
    return any(loc.same_district(a, d) for a in allowed for d in ev_districts)


def _ts(v) -> Optional[datetime]:
    """A record's timestamp, always timezone-aware.

    Mongo hands back naive datetimes while the plan's window is IST-aware, and
    comparing the two raises. Records are stored in IST, so a naive value is
    read as IST rather than guessed at.
    """
    if not v:
        return None
    try:
        ts = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timeutil.IST)


def verify(evidence: List[Evidence], plan: ExecutionPlan, qplan: QueryPlan,
           tenant_id: str) -> tuple:
    """(kept evidence, report)."""
    issues: List[VerificationIssue] = []
    removed: List[str] = []
    kept: List[Evidence] = []
    seen_sources: Dict[str, str] = {}
    explicit = {f.field: {str(v).lower() for v in (f.value if isinstance(f.value, list) else [f.value])}
                for f in qplan.filters if f.source in (Source.EXPLICIT, Source.DETERMINISTIC,
                                                       Source.CONTEXT)}
    since = until = None
    if plan.steps:
        spec = getattr(plan.steps[0].arguments, "spec", None)
        if spec is not None:
            since, until = timeutil.parse(spec.since), timeutil.parse(spec.until)

    def drop(ev, check, detail):
        removed.append(ev.evidence_id)
        issues.append(VerificationIssue(check=check, severity="error", detail=detail,
                                        evidence_ids=[ev.evidence_id]))

    for ev in evidence:
        if ev.source_type in ("record", "verdict"):
            t = ev.provenance.get("_tenant")
            if t is not None and t != tenant_id:
                drop(ev, "tenant", "record belongs to another tenant")
                continue
            if not _in_scope(ev.districts, plan.execution_districts):
                drop(ev, "district", "record is outside the execution districts")
                continue
            if plan.place_districts and (not ev.districts or
                                         not _in_scope(ev.districts, plan.place_districts)):
                drop(ev, "place", "record is not tagged to the place asked about")
                continue
            if ev.source_type == "record":
                bad = []
                for field, key in ((FilterField.SENTIMENT, "sentiment"),
                                   (FilterField.RISK_LEVEL, "risk_level"),
                                   (FilterField.PLATFORM, "platform"),
                                   (FilterField.KIND, "kind")):
                    want = explicit.get(field)
                    got = ev.facts.get(key)
                    if want and got is not None and str(got).lower() not in want:
                        bad.append(f"{key}={got}")
                if bad:
                    drop(ev, "filters", "record contradicts requested " + ", ".join(bad))
                    continue
                ts = _ts(ev.timestamp)
                if ts and ((since and ts < since) or (until and ts > until)):
                    drop(ev, "time", "record is outside the requested period")
                    continue
            if ev.source_id:
                if ev.source_id in seen_sources:
                    removed.append(ev.evidence_id)
                    issues.append(VerificationIssue(check="duplicates", severity="info",
                                                    detail=f"same record as {seen_sources[ev.source_id]}",
                                                    evidence_ids=[ev.evidence_id]))
                    continue
                seen_sources[ev.source_id] = ev.evidence_id
            if ev.source_type == "record" and not ev.url:
                issues.append(VerificationIssue(check="sources", severity="info",
                                                detail="record has no link; cited by id",
                                                evidence_ids=[ev.evidence_id]))
        kept.append(ev)

    # -- numbers ------------------------------------------------------------
    totals = {}
    for ev in kept:
        f = ev.facts
        if ev.source_type == "aggregate" and "total" in f:
            if not isinstance(f["total"], int) or f["total"] < 0:
                issues.append(VerificationIssue(check="aggregates", severity="error",
                                                detail="total is not a non-negative integer",
                                                evidence_ids=[ev.evidence_id]))
            totals[ev.step_id] = f["total"]
    for ev in kept:
        f = ev.facts
        if ev.source_type == "aggregate" and "rows" in f:
            s = sum(int(r.get("count", 0)) for r in f["rows"])
            tot = totals.get(ev.step_id)
            if any(int(r.get("count", 0)) < 0 for r in f["rows"]):
                issues.append(VerificationIssue(check="aggregates", severity="error",
                                                detail="negative bucket count",
                                                evidence_ids=[ev.evidence_id]))
            if tot is not None and f["group_by"] in _SCALAR_FACETS and s > tot \
                    and len(f["rows"]) < 25:
                issues.append(VerificationIssue(check="aggregates", severity="error",
                                                detail=f"buckets sum to {s}, above the total {tot}",
                                                evidence_ids=[ev.evidence_id]))
        if ev.source_type == "trend" and f.get("previous"):
            expect = round((f["current"] - f["previous"]) / f["previous"] * 100, 1)
            if f.get("change_pct") != expect:
                issues.append(VerificationIssue(check="aggregates", severity="error",
                                                detail="trend percentage does not recompute",
                                                evidence_ids=[ev.evidence_id]))

    # -- contradictions: two steps counting the same spec -------------------
    trend = next((e for e in kept if e.source_type == "trend"), None)
    agg_total = next((e for e in kept if e.source_type == "aggregate" and "total" in e.facts), None)
    aligned = plan.metadata.get("window_aligned") or plan.metadata.get("time_kind") == "last_n_days"
    if trend and agg_total and aligned and \
            trend.facts.get("current") not in (None, agg_total.facts["total"]):
        issues.append(VerificationIssue(
            check="contradiction", severity="warning",
            detail="the trend's current window and the total count different periods",
            evidence_ids=[trend.evidence_id, agg_total.evidence_id]))
    labels: Dict[str, set] = {}
    for ev in kept:
        if ev.source_type == "verdict" and ev.source_id:
            key = tuple(sorted(ev.facts.get("labels", [])))
            labels.setdefault(ev.source_id, set()).add(key)
    for sid, variants in labels.items():
        if len(variants) > 1:
            issues.append(VerificationIssue(check="contradiction", severity="warning",
                                            detail=f"record {sid} was labelled differently by two steps"))

    # -- sufficiency ----------------------------------------------------------
    substantive = [e for e in kept if e.source_type != "location"]
    numbers_zero = all((e.facts.get("total") == 0) for e in substantive
                       if e.source_type == "aggregate" and "total" in e.facts)
    records = [e for e in substantive if e.source_type in ("record", "verdict")]
    has_numbers = any(e.source_type in ("aggregate", "trend", "comparison", "situation")
                      for e in substantive)
    if not substantive:
        sufficiency = "empty"
    elif not records and not has_numbers:
        sufficiency = "insufficient"
    elif not records and numbers_zero and not any(e.source_type in ("trend", "comparison")
                                                  for e in substantive):
        sufficiency = "empty"
    elif removed and not records:
        sufficiency = "partial"
    else:
        sufficiency = "sufficient"
    passed = not any(i.severity == "error" and i.check in ("aggregates",) for i in issues)
    return kept, VerificationReport(passed=passed, issues=issues, evidence_checked=len(evidence),
                                    evidence_removed=removed, sufficiency=sufficiency)
