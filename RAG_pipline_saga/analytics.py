"""
analytics.py — the questions retrieval cannot answer.

"Which handles post the most negative content?" has no answer in a list of
retrieved chunks. Nor does "how did communal posts this month compare with
last?", or "break these down by platform". They are aggregations, and handing
an LLM fifteen rows and asking it to count is how you get a confident wrong
number: it sees fifteen, so it says fifteen, and the true answer was four
hundred.

So these route to MongoDB aggregation pipelines and come back as exact figures
the model reports rather than derives.

Every pipeline starts from the same filter the retrievers use, so the tenant
and district boundary applies identically here. An aggregate that skipped it
would leak the SHAPE of another tenant's data even without showing a record --
a count is still disclosure.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import retriever
from retriever import QuerySpec

logger = logging.getLogger(__name__)

# Facets worth grouping by, mapped to their stored path. Restricted on purpose:
# grouping by a free-text field produces thousands of one-row buckets, and
# grouping by an unindexed one scans the collection.
GROUPABLE = {
    "handle": "$metadata.handle",
    "platform": "$metadata.platform",
    "sentiment": "$metadata.sentiment",
    "risk_level": "$metadata.risk_level",
    "category": "$metadata.category",
    "kind": "$metadata.kind",
    "topics": "$metadata.topics",      # array: unwound first
    "targets": "$metadata.targets",    # array: unwound first
    "districts": "$metadata.districts",
}

ARRAY_FACETS = {"topics", "targets", "districts"}


def breakdown(col, spec: QuerySpec, tenant_id: str, districts: Optional[List[str]],
              by: str, limit: int = 15) -> List[dict]:
    """Counts per value of *by*, largest first.

    Answers "which handles post the most negative content", "break these down
    by platform", "what are the main topics in grievances".
    """
    if by not in GROUPABLE:
        return []

    match = retriever.build_filter(spec, tenant_id, districts)
    pipeline: List[Dict[str, Any]] = [{"$match": match}]

    # An array field counts once per value, not once per document: a post
    # tagged both corruption and robbery belongs in both buckets.
    if by in ARRAY_FACETS:
        pipeline.append({"$unwind": f"${'metadata.' + by}"})

    pipeline += [
        # Count distinct source documents, not chunk rows: a post split into
        # three chunks belongs to its bucket once, not three times. Grouping
        # twice is cheaper than collecting ids into a per-bucket array.
        {"$group": {"_id": {"bucket": GROUPABLE[by], "doc": "$metadata.document_id"}}},
        {"$group": {"_id": "$_id.bucket", "n": {"$sum": 1}}},
        {"$match": {"_id": {"$nin": [None, ""]}}},
        {"$sort": {"n": -1}},
        {"$limit": max(1, min(limit, 50))},
    ]

    try:
        return [{"value": d["_id"], "count": d["n"]} for d in col.aggregate(pipeline)]
    except Exception as exc:
        logger.warning("breakdown by %s failed: %s", by, exc)
        return []


def over_time(col, spec: QuerySpec, tenant_id: str, districts: Optional[List[str]],
              bucket: str = "day", limit: int = 60) -> List[dict]:
    """Counts per time bucket, oldest first — for "is this rising or falling".

    Documents with no timestamp are excluded rather than bucketed to epoch,
    which would otherwise show a spike in 1970.
    """
    fmt = {"hour": "%Y-%m-%dT%H", "day": "%Y-%m-%d",
           "week": "%G-W%V", "month": "%Y-%m"}.get(bucket, "%Y-%m-%d")

    match = retriever.build_filter(spec, tenant_id, districts)
    match["metadata.published_at"] = {**match.get("metadata.published_at", {}), "$ne": None}

    pipeline = [
        {"$match": match},
        # Distinct documents per bucket, not chunk rows - see breakdown().
        {"$group": {"_id": {
            "bucket": {"$dateToString": {"format": fmt, "date": "$metadata.published_at"}},
            "doc": "$metadata.document_id"}}},
        {"$group": {"_id": "$_id.bucket", "n": {"$sum": 1}}},
        {"$sort": {"_id": 1}},
        {"$limit": max(1, min(limit, 400))},
    ]
    try:
        return [{"bucket": d["_id"], "count": d["n"]} for d in col.aggregate(pipeline)]
    except Exception as exc:
        logger.warning("over_time failed: %s", exc)
        return []


def compare_windows(col, spec: QuerySpec, tenant_id: str,
                    districts: Optional[List[str]], days: int = 30) -> dict:
    """This period against the one before it.

    "Are communal posts rising?" is two counts and a difference. Asking a model
    to infer a trend from fifteen retrieved rows produces a direction, and the
    direction is a guess.
    """
    now = datetime.now(timezone.utc)
    current_from = now - timedelta(days=days)
    previous_from = now - timedelta(days=days * 2)

    def _count(since: datetime, until: datetime) -> int:
        window = QuerySpec(**{**spec.__dict__, "since": since, "until": until})
        try:
            return retriever.count(col, window, tenant_id, districts)
        except Exception as exc:
            logger.warning("window count failed: %s", exc)
            return 0

    current = _count(current_from, now)
    previous = _count(previous_from, current_from)

    # A percentage change from zero is undefined, not infinite. Reporting
    # "+100%" when the previous period had nothing is a fabricated trend.
    if previous:
        change = round((current - previous) / previous * 100, 1)
    else:
        change = None

    return {
        "days": days,
        "current": current,
        "previous": previous,
        "change_pct": change,
        "direction": ("up" if current > previous else
                      "down" if current < previous else "flat"),
    }


def summarise(rows: List[dict], by: str) -> str:
    """One line naming the top buckets, for the prompt.

    Kept as text so the model reports the figures rather than recomputing them
    from the records it was shown.
    """
    if not rows:
        return ""
    parts = [f"{r['value']} ({r['count']})" for r in rows[:8]]
    return f"BREAKDOWN by {by}: " + ", ".join(parts)
