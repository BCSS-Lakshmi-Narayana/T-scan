"""
v2fixture.py — a deterministic two-tenant corpus for validating the v2 pipeline.

Test support only. Every record's THEME is known by construction, so recall
and classification can be scored against ground truth, and every analytic can
be recomputed by an ORACLE that does not use retriever.build_filter — a count
that agrees with the oracle agrees for an independent reason.

    tenant-alpha   Hyderabad, Karimnagar, Warangal, Ranga Reddy (+ tenant-wide)
    tenant-beta    Hyderabad, Nizamabad                       (+ tenant-wide)

Both tenants have a "Hyderabad", deliberately: a district filter alone would
leak beta's Hyderabad into alpha's answer; only the tenant clause stops it.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from fakemongo import FakeCollection, FakeDB, FakeVectorStore, hash_embed

NOW = datetime(2026, 9, 22, 12, 0, tzinfo=timezone.utc)
TENANTS = {"tenant-alpha": ["Hyderabad", "Karimnagar", "Warangal", "Ranga Reddy"],
           "tenant-beta": ["Hyderabad", "Nizamabad"]}
KINDS = {"alert": "vector_embeddings_alerts", "grievance": "vector_embeddings_grievances",
         "content": "vector_embeddings_contents"}
PLATFORMS = ["x", "facebook", "instagram", "youtube"]
HANDLES = ["ravi_news", "hyd_updates", "citizen_voice", "tg_watch", "local_reporter",
           "karim_times", "warangal_live", "public_desk"]

THEMES = {
    "communal": {"topic": "communal", "phrases": [
        "communal clash reported during religious procession",
        "tension between two communities after temple idol vandalised",
        "inflammatory communal speech shared in group"]},
    "ration": {"topic": None, "phrases": [
        "ration card not issued for months at the civil supplies office",
        "families denied PDS rice as ration shop stays closed",
        "fair price shop dealer diverting ration rice"]},
    "traffic": {"topic": "traffic", "phrases": [
        "heavy traffic jam near the junction signal not working",
        "traffic police challan dispute on the flyover",
        "vehicles stuck for hours in traffic congestion"]},
    "corruption": {"topic": "corruption", "phrases": [
        "official demanded bribe to process the land file",
        "corruption allegation against revenue office staff",
        "bribe taken for issuing certificate"]},
    "drugs": {"topic": "drugs", "phrases": [
        "ganja seized from college students",
        "drug peddling racket busted near bus stand",
        "narcotics supply network active in the colony"]},
}
THEME_KEYWORDS = {
    "communal": ["communal", "religious", "communities", "temple"],
    "ration": ["ration", "pds", "fair price", "civil supplies"],
    "traffic": ["traffic", "signal", "challan", "congestion"],
    "corruption": ["bribe", "corruption"],
    "drugs": ["ganja", "drug", "narcotics"],
}


def build(n_per_tenant: int = 240, seed: int = 7) -> dict:
    """{'dbs': {tenant: FakeDB}, 'docs': {key: doc}, 'truth': {doc_id: theme}}"""
    rng = random.Random(seed)
    dbs: Dict[str, FakeDB] = {}
    docs: Dict[str, dict] = {}
    truth: Dict[str, str] = {}
    themes = list(THEMES)
    for tenant, districts in TENANTS.items():
        db = FakeDB()
        for i in range(n_per_tenant):
            kind = list(KINDS)[i % 3]
            theme = themes[(i // 3) % len(themes)]
            place = (districts + [None])[rng.randrange(len(districts) + 1)]
            phrase = THEMES[theme]["phrases"][rng.randrange(3)]
            where = f" in {place}" if place else ""
            text = f"{phrase}{where}. Report {i} from {tenant.split('-')[1]} desk."
            doc_id = f"{tenant}-{kind}-{i:04d}"
            meta = {
                "tenant_id": tenant, "kind": kind, "document_id": doc_id,
                "chunk_id": doc_id + "#0", "source_collection": kind + "s",
                "content_hash": f"h{i:04d}{tenant[-4:]}",
                "platform": PLATFORMS[rng.randrange(4)],
                "sentiment": ["negative", "neutral", "positive"][rng.randrange(3)],
                "handle": HANDLES[rng.randrange(len(HANDLES))],
                "published_at": NOW - timedelta(hours=6 * i + rng.randrange(5)),
                # Public link: never carries the tenant, like a real post URL.
                "url": f"https://example.test/p/{hashlib.md5(f'{tenant}{i}'.encode()).hexdigest()[:10]}" if i % 7 else None,
            }
            if place:
                meta["districts"] = [place]
            if kind == "alert":
                meta["risk_level"] = ["high", "medium", "low"][rng.randrange(3)]
                meta["risk_score"] = rng.randrange(10, 95)
                meta["category"] = ["Law & Order", "Public Safety", "Other"][rng.randrange(3)]
            if THEMES[theme]["topic"]:
                meta["topics"] = [THEMES[theme]["topic"]]
            if rng.random() < 0.3:
                meta["tagged"] = [HANDLES[rng.randrange(len(HANDLES))]]
            doc = {"text": text, "metadata": meta}
            db[KINDS[kind]].insert_one(doc)
            docs[f"{tenant}:{doc_id}"] = doc
            truth[doc_id] = theme
        dbs[tenant] = db
    return {"dbs": dbs, "docs": docs, "truth": truth}


def backend_factory(corpus: dict, *, generate=None, fail: Optional[str] = None,
                    slow: float = 0.0):
    """backend_factory(tenant) -> (ToolBackend, close) over the fixture.
    `fail` injects failures: 'retrieval' (every find raises), 'analytics'
    (aggregate raises), 'embed' (embedding raises)."""
    from orchestrator.tools import ToolBackend

    def factory(tenant_id: str):
        db = corpus["dbs"][tenant_id]
        cols = {name: db[name] for name in KINDS.values()}
        if fail == "retrieval":
            cols = {n: _Failing(c) for n, c in cols.items()}
        elif fail == "analytics":
            cols = {n: _Failing(c, only=("aggregate", "count_documents")) for n, c in cols.items()}
        elif slow:
            cols = {n: _Slow(c, slow) for n, c in cols.items()}

        def embed(text):
            if fail == "embed":
                raise RuntimeError("embedder down")
            return hash_embed(text)
        stores = {name: FakeVectorStore(db[name]) for name in KINDS.values()}
        return ToolBackend(collections=cols, stores=stores, embed=embed, generate=generate,
                           db=None, model="scripted"), (lambda: None)
    return factory


class _Failing:
    def __init__(self, col, only=("find", "count_documents", "aggregate")):
        self._col, self._only = col, only

    def __getattr__(self, name):
        if name in self._only:
            def boom(*a, **k):
                raise ConnectionError(f"injected {name} failure")
            return boom
        return getattr(self._col, name)


class _Slow:
    def __init__(self, col, delay):
        self._col, self._delay = col, delay

    def __getattr__(self, name):
        import time
        attr = getattr(self._col, name)
        if callable(attr):
            def slow(*a, **k):
                time.sleep(self._delay)
                return attr(*a, **k)
            return slow
        return attr


# --------------------------------------------------------------------------- #
# scripted model — answers the REAL judge and expander prompts from truth
# --------------------------------------------------------------------------- #

def scripted_llm(truth_by_text: Optional[Dict[str, str]] = None, fail: bool = False,
                 synth: Optional[str] = None, plan_reply: Optional[dict] = None):
    """generate(prompt, max_tokens=..., temperature=..., model=...) -> str."""
    def generate(prompt, max_tokens=256, temperature=0.0, **kw):
        if fail:
            return "_(LLM generation failed after 3 attempts: injected)_"
        if "convert a police intelligence officer" in prompt:   # 1A planner fallback
            return json.dumps(plan_reply or {})
        if "RECORDS\n" in prompt:          # judge.build_prompt
            labels = re.findall(r'^\s+- "([^"]+)"', prompt, re.M)
            body = prompt.split("RECORDS\n", 1)[1]
            results = []
            for m in re.finditer(r"^\[(\d+)\] (.*)$", body, re.M):
                text = m.group(2).lower()
                hit = [lab for lab in labels
                       if any(k in text for k in THEME_KEYWORDS.get(_theme_of(lab), [lab.lower()]))]
                results.append({"id": int(m.group(1)), "match": hit,
                                "why": "mentions " + hit[0] if hit else ""})
            return json.dumps({"results": results})
        if '"terms"' in prompt:            # expander._prompt
            label = re.search(r'searched for: "([^"]+)"', prompt).group(1)
            return json.dumps({"terms": THEME_KEYWORDS.get(_theme_of(label), [label])})
        if "Choose ONE next action" in prompt:
            opts = json.loads(re.search(r"from (\[.*?\])", prompt).group(1))
            return json.dumps({"action": opts[0]})
        if "EVIDENCE:" in prompt and synth is not None:
            return synth
        return ""
    return generate


def _theme_of(label: str) -> str:
    l = label.lower()
    for theme, kws in THEME_KEYWORDS.items():
        if theme in l or any(k in l for k in kws):
            return theme
    return l


# --------------------------------------------------------------------------- #
# the oracle — independent of retriever.build_filter
# --------------------------------------------------------------------------- #

def oracle_docs(corpus: dict, tenant: str, districts: Optional[List[str]], *,
                since=None, until=None, kinds=(), sentiment=None, risk_levels=(),
                platforms=(), topics=()) -> List[dict]:
    out = []
    for key, d in corpus["docs"].items():
        m = d["metadata"]
        if m["tenant_id"] != tenant:
            continue
        ds = m.get("districts") or []
        if districts is not None:
            if not districts:
                continue
            if ds and not set(ds) & set(districts):
                continue
        ts = m.get("published_at")
        if since and ts < since:
            continue
        if until and ts > until:
            continue
        if kinds and m["kind"] not in kinds:
            continue
        if sentiment and m.get("sentiment") != sentiment:
            continue
        if risk_levels and m.get("risk_level") not in risk_levels:
            continue
        if platforms and m.get("platform") not in platforms:
            continue
        if topics and not set(m.get("topics") or []) & set(topics):
            continue
        out.append(d)
    return out


def doc_for_key(corpus: dict, record_key: str) -> Optional[dict]:
    """scan._record keys look like '<source_collection>:<doc_id>:<hash>'."""
    parts = record_key.split(":")
    doc_id = parts[1] if len(parts) > 1 else parts[0]
    tenant = "tenant-alpha" if doc_id.startswith("tenant-alpha") else "tenant-beta"
    return corpus["docs"].get(f"{tenant}:{doc_id}")
