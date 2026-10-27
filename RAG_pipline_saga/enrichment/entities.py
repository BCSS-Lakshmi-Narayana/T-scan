"""
entities.py — who and what recurs, taken from structure, not guessed.

Sources, in order of trust:

  record metadata   handle (author), tagged accounts, targets, districts —
                    facts the ingestion pipeline stored; counted exactly
  question text     @handles; police units matched by pattern (PS, SHO, DCP…);
                    places via the gazetteer

There is no named-entity model here. A name that only appears inside free
text is not promoted to an entity, because an uncertain extraction presented
as "this person is involved" is precisely the unsupported claim the verifier
exists to stop. Every entity carries the record keys it came from.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from typing import Dict, List

from . import location as loc

_UNIT = re.compile(
    r"\b([A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)?)\s+(?:police station|ps|traffic police|"
    r"commissionerate|circle|zone|division)\b"
    r"|\b(?:dcp|acp|sho|si|ci|sp|dsp|cp|dgp|igp)\b", re.I)
_HANDLE = re.compile(r"@([\w.]{2,30})")


def from_question(text: str) -> List[dict]:
    out = [{"type": "account", "text": h, "source": "question"} for h in _HANDLE.findall(text or "")]
    for m in _UNIT.finditer(text or ""):
        out.append({"type": "police_unit", "text": m.group(0).strip(), "source": "question"})
    for r in loc.find_all(text or ""):
        if r.place:
            out.append({"type": "location", "text": r.place.name, "id": r.place.id,
                        "source": "gazetteer"})
    return out


def from_records(records: List[dict], min_count: int = 1) -> List[dict]:
    """Entities that recur across `records` (each a dict with `key` and
    `meta`), with exact counts and the keys that support them."""
    seen: Dict[tuple, set] = defaultdict(set)
    for r in records:
        m = r.get("meta") or {}
        key = r.get("key")
        if m.get("handle"):
            seen[("account", str(m["handle"]).lstrip("@").lower(), "author")].add(key)
        for t in m.get("tagged") or []:
            seen[("account", str(t).lstrip("@").lower(), "tagged")].add(key)
        for t in m.get("targets") or []:
            seen[("organisation", str(t).lower(), "target")].add(key)
        for d in m.get("districts") or []:
            seen[("location", str(d), "district")].add(key)
    out = []
    for (etype, text, role), keys in seen.items():
        if len(keys) >= min_count:
            out.append({"type": etype, "text": text, "role": role, "count": len(keys),
                        "record_keys": sorted(k for k in keys if k)[:20]})
    out.sort(key=lambda e: (-e["count"], e["type"], e["text"]))
    return out


def repeated(records: List[dict], min_count: int = 2) -> List[dict]:
    return from_records(records, min_count=min_count)


def overlap(a: dict, b: dict) -> Dict[str, List[str]]:
    """Shared structured entities between two records' metadata."""
    ma, mb = a.get("meta") or {}, b.get("meta") or {}

    def bag(m):
        return {
            "account": {str(x).lstrip("@").lower() for x in
                        ([m.get("handle")] if m.get("handle") else []) + list(m.get("tagged") or [])},
            "target": {str(x).lower() for x in m.get("targets") or []},
            "topic": {str(x).lower() for x in m.get("topics") or []},
            "district": {str(x) for x in m.get("districts") or []},
        }
    ba, bb = bag(ma), bag(mb)
    return {k: sorted(ba[k] & bb[k]) for k in ba if ba[k] & bb[k]}


def counts_by(records: List[dict], field: str) -> Counter:
    c: Counter = Counter()
    for r in records:
        v = (r.get("meta") or {}).get(field)
        for x in (v if isinstance(v, list) else [v]):
            if x not in (None, ""):
                c[x] += 1
    return c
