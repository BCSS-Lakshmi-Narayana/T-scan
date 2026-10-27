"""
related.py — records related to a seed set, ranked on several signals.

    semantic similarity   cosine against the seeds' centroid (vector_store.similarity)
    lexical overlap       shared rare words
    entity overlap        shared author / tagged accounts / targets / topics
    location overlap      shared districts
    time proximity        published within days of a seed

Each signal ranks the candidates on its own; ranks are fused with RRF, so no
signal's scale dominates and agreement between signals is what lifts a
record. The result is RETRIEVAL EVIDENCE: "these share an author and a
district with the alerts you asked about". It is never a label — a high
cosine does not make two posts "about the same incident", and the output says
which signals matched rather than asserting a relationship.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Callable, Dict, List, Optional

from . import entities

RRF_K = 60
_WORD = re.compile(r"[^\W\d_]{4,}", re.U)
_STOP = {"this", "that", "with", "from", "have", "been", "were", "they", "their", "about",
         "will", "your", "what", "when", "which", "there", "police", "https", "http"}


def _words(text: str) -> set:
    return {w.lower() for w in _WORD.findall(text or "")} - _STOP


def _ts(v) -> Optional[float]:
    if isinstance(v, datetime):
        return v.timestamp()
    if isinstance(v, str):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def _rank(scores: Dict[str, float]) -> Dict[str, int]:
    ordered = sorted((k for k, v in scores.items() if v > 0), key=lambda k: -scores[k])
    return {k: i for i, k in enumerate(ordered)}


def score(seeds: List[dict], candidates: List[dict], *, embed: Optional[Callable] = None,
          stores: Optional[Dict[str, object]] = None, top_k: int = 10) -> List[dict]:
    """Candidates most related to `seeds`, each with the signals that matched.
    Records are dicts with key, text, meta, collection (scan.window shape)."""
    seed_keys = {s.get("key") for s in seeds}
    pool = [c for c in candidates if c.get("key") not in seed_keys]
    if not seeds or not pool:
        return []

    seed_words = set().union(*(_words(s.get("text", "")) for s in seeds))
    lexical = {c["key"]: float(len(_words(c.get("text", "")) & seed_words)) for c in pool}

    ent, loc_, overlaps = {}, {}, {}
    for c in pool:
        shared: Dict[str, set] = {}
        for s in seeds:
            for kind, vals in entities.overlap(s, c).items():
                shared.setdefault(kind, set()).update(vals)
        overlaps[c["key"]] = {k: sorted(v) for k, v in shared.items()}
        ent[c["key"]] = float(sum(len(v) for k, v in shared.items() if k != "district"))
        loc_[c["key"]] = float(len(shared.get("district", ())))

    seed_times = [t for t in (_ts((s.get("meta") or {}).get("published_at")) for s in seeds) if t]
    prox = {}
    for c in pool:
        t = _ts((c.get("meta") or {}).get("published_at"))
        if t and seed_times:
            days = min(abs(t - st) for st in seed_times) / 86400
            prox[c["key"]] = 1.0 / (1.0 + days)

    semantic: Dict[str, float] = {}
    if embed and stores:
        try:
            vec = embed(" ".join(s.get("text", "")[:300] for s in seeds[:5]))
            by_col: Dict[str, List[dict]] = {}
            for c in pool:
                by_col.setdefault(c.get("collection"), []).append(c)
            for col, items in by_col.items():
                store = stores.get(col)
                ids = [(c.get("meta") or {}).get("chunk_id") for c in items]
                got = store.similarity(vec, [i for i in ids if i]) if store else {}
                for c in items:
                    cid = (c.get("meta") or {}).get("chunk_id")
                    if cid in got:
                        semantic[c["key"]] = float(got[cid])
        except Exception:
            semantic = {}

    signals = {"semantic": semantic, "lexical": lexical, "entity": ent,
               "location": loc_, "time": prox}
    ranks = {name: _rank(s) for name, s in signals.items()}
    fused: Dict[str, float] = {}
    for name, r in ranks.items():
        for k, i in r.items():
            fused[k] = fused.get(k, 0.0) + 1.0 / (RRF_K + i + 1)

    by_key = {c["key"]: c for c in pool}
    out = []
    for k in sorted(fused, key=lambda x: -fused[x])[:top_k]:
        matched = [n for n, r in ranks.items() if k in r]
        # One weak signal alone (a shared district, a nearby date) is not
        # "related"; at least two, or a real content/entity match, is.
        if len(matched) < 2 and not ({"entity", "lexical", "semantic"} & set(matched)):
            continue
        out.append({**by_key[k], "related_score": round(fused[k], 6), "signals": matched,
                    "shared": overlaps.get(k, {})})
    return out
