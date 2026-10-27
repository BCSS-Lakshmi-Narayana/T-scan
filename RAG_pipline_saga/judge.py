"""
judge.py — the LLM decides whether each record matches, and says why.

Retrieval finds records that LOOK related. Whether a post is actually
communal, actually against the police, actually international news, is a
judgement about meaning -- which is the one thing the model is for. So every
candidate is put to it directly:

    [3] "...temple procession stopped, stones thrown at..."
    -> {"id": 3, "match": ["communal"], "why": "clash during religious procession"}

Batched (several records per call) and run in parallel, because on a
bandwidth-bound box the prompt is cheap and the output is what costs: a
verdict is ~15 tokens, a paragraph is 200.

Every verdict is cached per (concept, record, content hash) in the tenant's
own database. The first officer to ask about "communal" pays for it; the next
one, and every repeat, reads it back. Asked often enough, a concept becomes a
tag without anyone having to design one. A record that is edited gets a new
hash and is judged again.
"""

from __future__ import annotations

import json
import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional

import concepts
import llm_planner

logger = logging.getLogger(__name__)

VERDICT_COLLECTION = "rag_verdicts"
BATCH_SIZE = int(os.getenv("JUDGE_BATCH_SIZE", "8"))
CONCURRENCY = int(os.getenv("JUDGE_CONCURRENCY", "4"))
RECORD_CHARS = int(os.getenv("JUDGE_RECORD_CHARS", "600"))

# Bump when the prompt changes meaningfully, so old verdicts are not reused
# under a different definition of "match".
PROMPT_VERSION = "v1"


def _label_block(labels: List[str]) -> str:
    lines = []
    for lab in labels:
        h = concepts.hint(lab)
        lines.append(f'  - "{lab}"' + (f": {h}" if h else ""))
    return "\n".join(lines)


def build_prompt(records: List[dict], labels: List[str], question: str) -> str:
    body = []
    for i, r in enumerate(records, 1):
        text = re.sub(r"\s+", " ", r.get("text") or "").strip()[:RECORD_CHARS]
        body.append(f"[{i}] {text}")
    single = len(labels) == 1
    return f"""\
You screen social media records for a police intelligence officer in Telangana, India.

Officer's request: "{question}"

Label{'' if single else 's'}:
{_label_block(labels)}

For EACH record decide which label{'' if single else 's'} genuinely appl{'ies' if single else 'y'}.
Judge what the record is ABOUT, not isolated words. A news report of such an
incident counts. A passing mention, a hashtag alone, or an unrelated use of a
word does not.{'' if single else ' A record may match several labels, or none.'}

Return ONLY JSON, one entry per record, in order:
{{"results": [{{"id": 1, "match": [{'"' + labels[0] + '"' if single else '"<label>", ...'}], "why": "<max 12 words>"}}, {{"id": 2, "match": [], "why": ""}}]}}
Use the label text exactly as written. "match" is [] when nothing applies.

RECORDS
""" + "\n".join(body)


def _parse(raw: str, n: int, labels: List[str]) -> Dict[int, dict]:
    """Model reply -> {record position: {"labels": [...], "why": str}}.

    A record missing from the reply is left out rather than defaulted to "no":
    unjudged is not the same as not matching, and caching it as "no" would
    hide it for good.
    """
    data = llm_planner.parse(raw)
    items = data.get("results") if isinstance(data, dict) else None
    if not isinstance(items, list):
        # Some models return the array bare.
        try:
            m = re.search(r"\[.*\]", raw or "", re.S)
            items = json.loads(m.group(0)) if m else None
        except Exception:
            items = None
    if not isinstance(items, list):
        return {}

    by_key = {concepts.cache_key(l): l for l in labels}
    out: Dict[int, dict] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item.get("id"))
        except (TypeError, ValueError):
            continue
        if not 1 <= idx <= n:
            continue
        got = item.get("match", [])
        if isinstance(got, (str, int, bool)):
            got = [got]
        matched = []
        for g in got if isinstance(got, list) else []:
            if g is True and len(labels) == 1:
                matched.append(labels[0])
            elif isinstance(g, int) and not isinstance(g, bool) and 1 <= g <= len(labels):
                matched.append(labels[g - 1])
            else:
                lab = by_key.get(concepts.cache_key(str(g)))
                if lab:
                    matched.append(lab)
        out[idx] = {"labels": sorted(set(matched), key=labels.index),
                    "why": str(item.get("why") or "").strip()[:160]}
    return out


def _vid(label: str, record_key: str) -> str:
    return f"{PROMPT_VERSION}|{concepts.cache_key(label)}|{record_key}"


def cached(db, records: List[dict], labels: List[str]) -> Dict[str, dict]:
    """Verdicts already known for every label, keyed by record key."""
    if db is None or not records:
        return {}
    ids = [_vid(l, r["key"]) for r in records for l in labels]
    found: Dict[str, dict] = {}
    try:
        for i in range(0, len(ids), 1000):
            for d in db[VERDICT_COLLECTION].find({"_id": {"$in": ids[i:i + 1000]}}):
                found[d["_id"]] = d
    except Exception as exc:
        logger.debug("verdict cache read failed: %s", exc)
        return {}

    out: Dict[str, dict] = {}
    for r in records:
        hits = [found.get(_vid(l, r["key"])) for l in labels]
        if all(hits):
            out[r["key"]] = {
                "labels": [l for l, h in zip(labels, hits) if h.get("match")],
                "why": next((h.get("why") for h in hits if h.get("match") and h.get("why")), ""),
                "cached": True,
            }
    return out


def _store(db, record: dict, labels: List[str], verdict: dict, model: str):
    if db is None:
        return
    from pymongo import ReplaceOne
    now = datetime.now(timezone.utc)
    ops = []
    for lab in labels:
        hit = lab in verdict["labels"]
        ops.append(ReplaceOne({"_id": _vid(lab, record["key"])}, {
            "_id": _vid(lab, record["key"]),
            "label": concepts.cache_key(lab),
            "record_key": record["key"],
            "document_id": record.get("document_id"),
            "match": hit,
            "why": verdict["why"] if hit else "",
            "model": model,
            "at": now,
        }, upsert=True))
    try:
        db[VERDICT_COLLECTION].bulk_write(ops, ordered=False)
    except Exception as exc:
        logger.debug("verdict cache write failed: %s", exc)


def judge(records: List[dict], labels: List[str], question: str,
          generate: Optional[Callable], db=None, model: str = "",
          on_batch: Optional[Callable[[Dict[str, dict]], None]] = None,
          stop: Optional[Callable[[], bool]] = None) -> Dict[str, dict]:
    """Verdicts for *records* against *labels*, keyed by record key.

    Each record is a dict with ``key`` (stable id + content hash) and
    ``text``. ``on_batch`` receives each batch's verdicts as it completes, so
    a caller can show results while the rest are still being judged. Cached
    verdicts are delivered first, in one batch, before any model call.
    """
    results = cached(db, records, labels)
    if results and on_batch:
        on_batch(dict(results))

    todo = [r for r in records if r["key"] not in results]
    if not todo or not generate:
        return results

    batches = [todo[i:i + BATCH_SIZE] for i in range(0, len(todo), BATCH_SIZE)]
    # Circuit breaker: a model that is down fails every batch, and each failure
    # can cost retries. After a few with no success, stop asking.
    health = {"ok": 0, "failed": 0}

    def run(batch: List[dict]) -> Dict[str, dict]:
        if stop and stop():
            return {}
        if health["failed"] >= 3 and not health["ok"]:
            return {}
        try:
            raw = generate(build_prompt(batch, labels, question),
                           BATCH_SIZE * 32 + 60)
        except Exception as exc:
            logger.warning("judge batch failed: %s", exc)
            raw = ""
        parsed = _parse(raw, len(batch), labels)
        health["ok" if parsed else "failed"] += 1
        got: Dict[str, dict] = {}
        for pos, verdict in parsed.items():
            rec = batch[pos - 1]
            got[rec["key"]] = verdict
            _store(db, rec, labels, verdict, model)
        return got

    # Submitted in order so the best-ranked candidates are judged first and
    # reach the officer's screen first.
    with ThreadPoolExecutor(max_workers=max(1, CONCURRENCY)) as pool:
        for got in pool.map(run, batches):
            if got:
                results.update(got)
                if on_batch:
                    on_batch(got)
    return results
