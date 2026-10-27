"""
feedback.py — officer feedback (ai_feedback), kept apart from facts.

Feedback never edits a record, a count or a verdict directly. It is stored,
triaged by a person, and only then may it act — and the only thing it can
act on is a VERDICT (a model's label), by adding a human verdict that
supersedes it. Source data is never touched.

    new ─► triaged ─► in_eval_set ─► applied
       └──► dismissed

Kinds are a closed list; free text goes in `reason`, capped, never parsed as
an instruction.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

import concepts as concept_mod

COLLECTION = "ai_feedback"
VERDICTS = "rag_verdicts"
KINDS = ("answer_quality", "retrieval_quality", "incorrect_interpretation", "missing_evidence",
         "incorrect_classification", "incorrect_location", "incorrect_concept", "useful",
         "not_useful")
STATES = ("new", "triaged", "in_eval_set", "applied", "dismissed")
_NEXT = {"new": {"triaged", "dismissed"}, "triaged": {"in_eval_set", "applied", "dismissed"},
         "in_eval_set": {"applied", "dismissed"}, "applied": set(), "dismissed": set()}


class FeedbackError(ValueError):
    pass


class FeedbackTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: str = Field(pattern=r"^(answer|evidence|verdict|location|concept)$")
    request_id: Optional[str] = Field(default=None, max_length=64)
    evidence_id: Optional[str] = Field(default=None, max_length=16)
    record_key: Optional[str] = Field(default=None, max_length=200)
    concept: Optional[str] = Field(default=None, max_length=80)


class FeedbackIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str
    target: FeedbackTarget
    verdict: Optional[str] = Field(default=None, pattern=r"^(correct|incorrect|partial)$")
    correct_labels: List[str] = Field(default_factory=list, max_length=8)
    reason: str = Field(default="", max_length=1000)


class FeedbackStore:
    def __init__(self, db, tenant_id: str):
        if not tenant_id:
            raise FeedbackError("feedback is per tenant")
        self.col = db[COLLECTION]
        self.verdicts = db[VERDICTS]
        self.tenant_id = tenant_id

    def submit(self, user_id: str, item: FeedbackIn) -> str:
        if item.kind not in KINDS:
            raise FeedbackError(f"unknown feedback kind {item.kind}")
        if not user_id:
            raise FeedbackError("feedback needs an author")
        doc = {"tenant_id": self.tenant_id, "user_id": user_id,
               "at": datetime.now(timezone.utc), "kind": item.kind,
               "target": item.target.model_dump(), "verdict": item.verdict,
               "correct_labels": item.correct_labels, "reason": item.reason, "state": "new",
               "history": []}
        res = self.col.insert_one(doc)
        return str(getattr(res, "inserted_id", None) or getattr(res, "upserted_id", ""))

    def _get(self, fid: str) -> dict:
        doc = self.col.find_one({"_id": fid, "tenant_id": self.tenant_id})
        if not doc:
            raise FeedbackError("feedback not found")
        return doc

    def move(self, fid: str, to: str, *, actor: str, actor_role: str) -> dict:
        if actor_role not in ("admin", "superadmin"):
            raise FeedbackError("triage needs an admin")
        doc = self._get(fid)
        if to not in _NEXT.get(doc["state"], set()):
            raise FeedbackError(f"{doc['state']} -> {to} is not permitted")
        if to == "applied":
            self._apply(doc, actor)
        self.col.update_one({"_id": fid, "tenant_id": self.tenant_id},
                            {"$set": {"state": to},
                             "$push": {"history": {"to": to, "actor": actor,
                                                   "at": datetime.now(timezone.utc)}}})
        return self._get(fid)

    def _apply(self, doc: dict, actor: str) -> None:
        """The only mutation feedback can cause: a HUMAN verdict on a record
        for a concept, superseding the model's. Nothing else is writable."""
        t = doc["target"]
        if doc["kind"] not in ("incorrect_classification", "incorrect_concept") or \
                not t.get("record_key") or not t.get("concept"):
            raise FeedbackError("only a classification correction on a specific record and "
                                "concept can be applied")
        label = concept_mod.cache_key(t["concept"])
        match = t["concept"] in doc.get("correct_labels", []) if doc.get("correct_labels") \
            else doc.get("verdict") == "correct"
        self.verdicts.update_one(
            {"_id": f"human|{label}|{t['record_key']}"},
            {"$set": {"label": label, "record_key": t["record_key"], "match": bool(match),
                      "why": doc.get("reason", "")[:300], "source": "human", "model": None,
                      "reviewer": actor, "at": datetime.now(timezone.utc),
                      "feedback_id": str(doc["_id"])}},
            upsert=True)

    def list(self, state: Optional[str] = None) -> List[dict]:
        q = {"tenant_id": self.tenant_id}
        if state:
            q["state"] = state
        return list(self.col.find(q))
