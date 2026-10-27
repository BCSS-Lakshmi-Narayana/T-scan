"""
timeutil.py — relative time becomes dates here, and only here.

Phase 1A keeps "last week" relative so a plan means the same thing whenever
it is replayed. Execution is the one place that must pick actual dates, and
it does so against ONE timestamp per request (`now`), passed in, so a request
is internally consistent and a test is reproducible.

Calendar periods use IST (the force's working day), not UTC: "yesterday" for
an officer in Karimnagar at 01:00 is the IST day before.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

from query_understanding.models import TimeKind, TimeRange

IST = timezone(timedelta(hours=5, minutes=30))


def _day_start(t: datetime) -> datetime:
    return t.replace(hour=0, minute=0, second=0, microsecond=0)


def resolve(tr: TimeRange, now: datetime) -> Tuple[Optional[datetime], Optional[datetime]]:
    """(since, until) in UTC, or (None, None) for all time. Raises nothing:
    an unresolved kind yields (None, None) and the Policy Gate has already
    asked for clarification on it."""
    local = now.astimezone(IST)
    today = _day_start(local)
    k, n = tr.kind, tr.n or 1

    def utc(a, b):
        return (a.astimezone(timezone.utc) if a else None,
                b.astimezone(timezone.utc) if b else None)

    if k is TimeKind.TODAY:
        return utc(today, local)
    if k is TimeKind.YESTERDAY:
        return utc(today - timedelta(days=1), today - timedelta(microseconds=1))
    if k is TimeKind.LAST_N_HOURS:
        return utc(local - timedelta(hours=n), local)
    if k is TimeKind.LAST_N_DAYS:
        return utc(local - timedelta(days=n), local)
    if k is TimeKind.LAST_N_WEEKS:
        return utc(local - timedelta(weeks=n), local)
    if k is TimeKind.LAST_N_MONTHS:
        return utc(local - timedelta(days=30 * n), local)
    if k is TimeKind.THIS_WEEK:
        return utc(today - timedelta(days=today.weekday()), local)
    if k is TimeKind.LAST_WEEK:
        start = today - timedelta(days=today.weekday() + 7)
        return utc(start, start + timedelta(days=7) - timedelta(microseconds=1))
    if k is TimeKind.THIS_MONTH:
        return utc(today.replace(day=1), local)
    if k is TimeKind.LAST_MONTH:
        first = today.replace(day=1)
        prev = (first - timedelta(days=1)).replace(day=1)
        return utc(prev, first - timedelta(microseconds=1))
    if k is TimeKind.THIS_YEAR:
        return utc(today.replace(month=1, day=1), local)
    if k in (TimeKind.CUSTOM_RANGE, TimeKind.SINCE, TimeKind.AFTER, TimeKind.BEFORE):
        return utc(tr.start, tr.end if k is not TimeKind.SINCE else (tr.end or local))
    return None, None


def iso(t: Optional[datetime]) -> Optional[str]:
    return t.astimezone(timezone.utc).isoformat() if t else None


def parse(s: Optional[str]) -> Optional[datetime]:
    return datetime.fromisoformat(s) if s else None
