"""
concepts.py — the concept registry and its lifecycle (rag_concepts).

Schema and states follow AI_ASSISTANT_ARCHITECTURE.md §I.3, with one state
added for an explicit "no":

    ephemeral ─► judged ─► cached ─► candidate ─► promoted ─► retired
        (asked)   (verdicts)  (reused)  (proposed)   (human)     (human)
                                   └──────────► rejected (human)

  ephemeral   asked about once; nothing is known about it
  judged      the judge has produced verdicts for it (rag_verdicts)
  cached      its terms/verdicts are reused (rag_concept_terms)
  candidate   usage and verdict volume make it worth a human look —
              a PROPOSAL, recorded with the numbers that triggered it
  promoted    a named human approved it, with measured precision at or above
              the acceptance bar; only now may it be treated as vocabulary
  retired     a human took it out of use; reversible
  rejected    a human decided it is not a concept worth keeping

Rules the code enforces, not just the document:

  * No transition skips a human where the table says one is needed.
    promote / retire / reject require `actor` with an admin role.
  * Promotion requires precision >= PROMOTION_PRECISION (0.85) measured on
    at least MIN_EVAL human-checked verdicts, passed in as numbers — the
    registry never computes its own acceptance from model verdicts.
  * Model verdicts are counted as verdicts (source "llm"), never as facts.
  * Every transition is appended to `history` with who, when and why.

The collection is injected (the tenant's own database), so every concept is
per tenant and tests need no server.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Optional

import concepts as concept_mod

COLLECTION = "rag_concepts"
VERDICTS = "rag_verdicts"
STATES = ("ephemeral", "judged", "cached", "candidate", "promoted", "retired", "rejected")
PROMOTION_PRECISION = 0.85
MIN_EVAL = 30
CANDIDATE_ASKS = 3
CANDIDATE_VERDICTS = 20

_TRANSITIONS: Dict[str, set] = {
    "ephemeral": {"judged", "rejected"},
    "judged": {"cached", "candidate", "rejected"},
    "cached": {"candidate", "rejected"},
    "candidate": {"promoted", "rejected", "cached"},
    "promoted": {"retired"},
    "retired": {"cached", "promoted"},
    "rejected": {"ephemeral"},
}
_HUMAN_ONLY = {"promoted", "retired", "rejected"}


class LifecycleError(ValueError):
    pass


def _now():
    return datetime.now(timezone.utc)


class ConceptRegistry:
    def __init__(self, db, tenant_id: str):
        if not tenant_id:
            raise LifecycleError("a concept registry is per tenant")
        self.col = db[COLLECTION]
        self.verdicts = db[VERDICTS]
        self.tenant_id = tenant_id

    def _id(self, label: str) -> str:
        return concept_mod.cache_key(label)

    def get(self, label: str) -> Optional[dict]:
        return self.col.find_one({"_id": self._id(label), "tenant_id": self.tenant_id})

    def status(self, label: str) -> str:
        doc = self.get(label)
        return doc["status"] if doc else "unknown"

    def record_ask(self, label: str, user_ref: Optional[str] = None) -> dict:
        """An officer asked about `label`. Creates it as ephemeral; never
        promotes it. Returns the current document."""
        cid = self._id(label)
        now = _now()
        self.col.update_one(
            {"_id": cid, "tenant_id": self.tenant_id},
            {"$setOnInsert": {"label_display": label, "status": "ephemeral",
                              "created_at": now, "history": [], "tenant_id": self.tenant_id,
                              "verdict_stats": {"judged": 0, "positive": 0, "negative": 0}},
             "$inc": {"usage.asks": 1},
             "$set": {"usage.last_asked": now}},
            upsert=True)
        return self.get(label)

    def refresh_verdict_stats(self, label: str) -> dict:
        """Count this concept's stored verdicts (rag_verdicts) — model
        verdicts stay verdicts; this is bookkeeping, not truth."""
        key = self._id(label)
        judged = positive = 0
        # Model verdicts only: a human correction is evaluation data, counted
        # separately, and never inflates the model's apparent volume.
        for v in self.verdicts.find({"label": key, "source": {"$ne": "human"}}):
            judged += 1
            positive += 1 if v.get("match") else 0
        stats = {"judged": judged, "positive": positive, "negative": judged - positive}
        self.col.update_one({"_id": key, "tenant_id": self.tenant_id},
                            {"$set": {"verdict_stats": stats}})
        doc = self.get(label)
        if doc and doc["status"] == "ephemeral" and judged:
            self.transition(label, "judged", actor="system", reason="verdicts exist")
        return stats

    def maybe_propose(self, label: str) -> Optional[str]:
        """Move to `candidate` when use and evidence cross the thresholds.
        A proposal, not a promotion."""
        doc = self.get(label)
        if not doc or doc["status"] not in ("judged", "cached"):
            return None
        asks = (doc.get("usage") or {}).get("asks", 0)
        judged = (doc.get("verdict_stats") or {}).get("judged", 0)
        if asks >= CANDIDATE_ASKS and judged >= CANDIDATE_VERDICTS:
            self.transition(label, "candidate", actor="system",
                            reason=f"asked {asks}x, {judged} verdicts")
            return "candidate"
        return None

    def transition(self, label: str, to: str, *, actor: str, actor_role: str = "system",
                   reason: str = "", metrics: Optional[dict] = None) -> dict:
        if to not in STATES:
            raise LifecycleError(f"unknown state {to}")
        doc = self.get(label)
        if doc is None:
            raise LifecycleError("unknown concept")
        frm = doc["status"]
        if to not in _TRANSITIONS.get(frm, set()):
            raise LifecycleError(f"{frm} -> {to} is not a permitted transition")
        if to in _HUMAN_ONLY and (actor == "system" or actor_role not in ("admin", "superadmin")):
            raise LifecycleError(f"moving to {to} needs a named admin")
        update: Dict[str, object] = {"status": to}
        if to == "promoted":
            m = metrics or {}
            if m.get("evaluated", 0) < MIN_EVAL or m.get("precision", 0.0) < PROMOTION_PRECISION:
                raise LifecycleError(f"promotion needs precision >= {PROMOTION_PRECISION} on "
                                     f">= {MIN_EVAL} human-checked verdicts")
            update["promotion"] = {"approved_by": actor, "approved_at": _now(),
                                   "metrics": m, "reversible_to": "cached", "notes": reason}
        entry = {"from": frm, "to": to, "actor": actor, "at": _now(), "reason": reason[:300]}
        self.col.update_one({"_id": self._id(label), "tenant_id": self.tenant_id},
                            {"$set": update, "$push": {"history": entry}})
        return self.get(label)

    def is_trusted(self, label: str) -> bool:
        """Only a promoted concept may be used as vocabulary."""
        return self.status(label) == "promoted"

    def list(self, status: Optional[str] = None) -> List[dict]:
        q = {"tenant_id": self.tenant_id}
        if status:
            q["status"] = status
        return list(self.col.find(q))
