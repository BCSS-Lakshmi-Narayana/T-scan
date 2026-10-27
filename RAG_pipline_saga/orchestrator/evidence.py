"""
evidence.py — tool outputs become citable, traceable evidence.

Every Evidence item says which step and tool produced it and, for records,
which stored record it is. Ids are assigned in step order (E1, E2 …) so the
same execution always numbers its evidence the same way, and a citation in a
response can only ever point at something in this list.
"""

from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Optional

from policy.models import ref

from .executor import ExecutionOutcome
from .models import Evidence, ExecutionPlan, StepStatus

_FACT_FIELDS = ("kind", "handle", "platform", "published_at", "risk_level", "risk_score",
                "sentiment", "category", "topics", "targets", "tagged")


def _iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


def _record_ev(eid, rec, step, tenant_id, extra=None) -> Evidence:
    m = rec.get("meta") or {}
    facts = {k: _iso(m.get(k)) for k in _FACT_FIELDS if m.get(k) not in (None, "", [])}
    facts.update(extra or {})
    return Evidence(
        evidence_id=eid, source_type="record", source_id=rec.get("key"),
        collection=rec.get("collection"), content=(rec.get("text") or "")[:600], facts=facts,
        tool=step.tool, step_id=step.step_id,
        # The scope the record was READ under, and the tenant it carries.
        tenant_ref=ref(m.get("tenant_id")) if m.get("tenant_id") else None,
        districts=list(m.get("districts") or []), timestamp=_iso(m.get("published_at")),
        url=m.get("url"), confidence=1.0,
        provenance={"via": rec.get("via"), "document_id": rec.get("document_id"),
                    "tenant_checked": bool(m.get("tenant_id")), "_tenant": m.get("tenant_id")})


def build(plan: ExecutionPlan, outcome: ExecutionOutcome, tenant_id: str) -> List[Evidence]:
    out: List[Evidence] = []
    n = 0

    def nid():
        nonlocal n
        n += 1
        return f"E{n}"

    for step in plan.steps:
        res = outcome.results.get(step.step_id)
        if res is None or res.status not in (StepStatus.OK, StepStatus.EMPTY):
            continue
        o = res.output
        base = dict(tool=step.tool, step_id=step.step_id, tenant_ref=ref(tenant_id))
        schema = step.output_schema
        if schema == "records":
            if o.get("total") is not None:
                out.append(Evidence(evidence_id=nid(), source_type="aggregate",
                                    facts={"total": o["total"], "measure": "matching records",
                                           # Only present when the period is empty
                                           # and the scope is not: it is what turns
                                           # "0 matching records" into "the data
                                           # stops four weeks ago".
                                           **({"latest_available": o["latest_available"]}
                                              if o.get("latest_available") else {})},
                                    content=f"{o['total']} matching record(s)", **base))
            for rec in o.get("records", []):
                extra = {"signals": rec["signals"], "shared": rec.get("shared", {})} \
                    if "signals" in rec else None
                out.append(_record_ev(nid(), rec, step, tenant_id, extra))
        elif schema == "aggregate":
            if o.get("total") is not None:
                out.append(Evidence(evidence_id=nid(), source_type="aggregate",
                                    facts={"total": o["total"], "measure": "matching records",
                                           # Only present when the period is empty
                                           # and the scope is not: it is what turns
                                           # "0 matching records" into "the data
                                           # stops four weeks ago".
                                           **({"latest_available": o["latest_available"]}
                                              if o.get("latest_available") else {})},
                                    content=f"{o['total']} matching record(s)", **base))
            for by, rows in (o.get("breakdowns") or {}).items():
                out.append(Evidence(evidence_id=nid(), source_type="aggregate",
                                    facts={"group_by": by, "rows": rows[:25]},
                                    content=f"counts by {by}", **base))
        elif schema == "trend":
            out.append(Evidence(evidence_id=nid(), source_type="trend",
                                facts={k: o.get(k) for k in ("current", "previous", "change_pct",
                                                             "direction", "days",
                                                             "current_window", "previous_window",
                                                             "latest_available", "comparable")},
                                content=f"{o.get('current')} vs {o.get('previous')}", **base))
        elif schema == "comparison":
            out.append(Evidence(evidence_id=nid(), source_type="comparison",
                                facts={"sides": [{k: s.get(k) for k in ("label", "count")}
                                                 for s in o.get("sides", [])],
                                       "difference": o.get("difference"),
                                       "change_pct": o.get("change_pct")},
                                content="comparison", **base))
        elif schema == "location":
            out.append(Evidence(evidence_id=nid(), source_type="location",
                                facts={k: o.get(k) for k in ("status", "query", "districts",
                                                             "assumption", "confidence")},
                                content=f"place: {o.get('query')}", **base))
        elif schema == "verdicts":
            out.append(Evidence(evidence_id=nid(), source_type="aggregate",
                                facts={"counts": o.get("counts", {}), "checked": o.get("checked"),
                                       "window_total": o.get("window_total"),
                                       "verified": o.get("verified"), "labels": o.get("labels"),
                                       "deep": o.get("deep")},
                                content="classification counts", **base))
            for card in o.get("matches", []):
                out.append(Evidence(
                    evidence_id=nid(), source_type="verdict", source_id=card.get("key"),
                    content=(card.get("text") or "")[:600],
                    facts={"labels": card.get("labels", []), "why": card.get("why", ""),
                           "verified": o.get("verified", True), "cached": card.get("cached"),
                           **{k: card.get(k) for k in ("kind", "handle", "platform",
                                                       "published_at", "risk_level",
                                                       "sentiment") if card.get(k)}},
                    districts=list(card.get("districts") or []), timestamp=card.get("published_at"),
                    url=card.get("url"),
                    # A model's label is not a fact about the record; it is a
                    # verdict, and its confidence says so.
                    confidence=0.8 if o.get("verified", True) else 0.3,
                    provenance={"scope": "query-filtered", "source": "judge"}, **base))
        elif schema == "situation":
            # Deliberately not evidence: the tool composed it from RAW outputs,
            # some of which verification may remove. The situation a response
            # states is rebuilt from verified evidence (situation_from_verified).
            continue
    return out


def situation_from_verified(kept: List[Evidence], plan: ExecutionPlan) -> Optional[Evidence]:
    """The situation, composed only from evidence that passed verification."""
    from enrichment import situation as situation_mod
    step = next((s for s in plan.steps if s.tool.value == "situation_analysis"), None)
    if step is None:
        return None

    def as_record(e: Evidence) -> dict:
        meta = {k: v for k, v in e.facts.items() if k not in ("signals", "shared")}
        meta["districts"] = list(e.districts)
        return {"key": e.source_id, "meta": meta, "text": e.content,
                "signals": e.facts.get("signals"), "shared": e.facts.get("shared", {})}

    records = [as_record(e) for e in kept if e.source_type == "record" and "signals" not in e.facts]
    related = [as_record(e) for e in kept if e.source_type == "record" and "signals" in e.facts]
    breakdowns, total, latest = {}, None, None
    for e in kept:
        if e.source_type == "aggregate" and "rows" in e.facts:
            breakdowns[e.facts["group_by"]] = e.facts["rows"]
        elif e.source_type == "aggregate" and "total" in e.facts and e.tool.value == "aggregate":
            total = e.facts["total"]
        latest = latest or e.facts.get("latest_available")
    trend = next((e.facts for e in kept if e.source_type == "trend"), None)
    latest = latest or (trend or {}).get("latest_available")
    a = step.arguments
    sit = situation_mod.build(a.subject, records=records, total=total, breakdowns=breakdowns,
                              trend=trend, related=related, window_days=a.window_days,
                              latest_available=latest)
    # Verification leaves gaps in the numbering; a new id must come after the
    # highest one, or a citation could point at the wrong evidence.
    n = max((int(e.evidence_id[1:]) for e in kept if e.evidence_id[1:].isdigit()), default=0) + 1
    return Evidence(evidence_id=f"E{n}", source_type="situation",
                    facts={k: sit.get(k) for k in ("subject", "volume", "risk", "window_days",
                                                   "observations", "where", "who",
                                                   "recurring_entities", "connections")},
                    content="situation summary (from verified evidence)", tool=step.tool,
                    step_id=step.step_id, provenance={"composed_from": "verified_evidence"})
