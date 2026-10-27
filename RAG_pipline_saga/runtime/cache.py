"""
cache.py — a TTL + LRU cache whose keys cannot cross a security boundary.

A key is built by `key(namespace, tenant_id, districts, *parts)`. The tenant
and the district scope are REQUIRED arguments, not optional parts, so there is
no way to write a cache entry that another tenant or a differently-scoped
officer could read: None (admin), [] (nothing) and ["A","B"] all produce
different keys, and the tenant is always first.

What is cached, and why it is safe:

  plan        question text -> QueryPlan      deterministic; still keyed per tenant
  location    place text -> resolution        static gazetteer; keyed by gazetteer version
  retrieval   step arguments -> tool output   per tenant + scope + resolved time window,
                                              short TTL, so a new record appears within it
Nothing is cached for scans (they write verdicts and are judged once anyway)
or for anything involving the conversation (per user, already stored).
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from collections import OrderedDict
from typing import Any, List, Optional, Tuple


def scope_key(districts: Optional[List[str]]) -> str:
    if districts is None:
        return "*unrestricted*"
    if not districts:
        return "*none*"
    return ",".join(sorted(d.strip().casefold() for d in districts))


def key(namespace: str, tenant_id: str, districts: Optional[List[str]], *parts: Any) -> str:
    if not tenant_id or not str(tenant_id).strip():
        raise ValueError("cache keys require a tenant")
    blob = json.dumps([namespace, str(tenant_id), scope_key(districts), parts],
                      sort_keys=True, default=str)
    return f"{namespace}:{hashlib.sha256(blob.encode()).hexdigest()}"


class ScopedCache:
    def __init__(self, max_items: int = 2000, ttl_s: float = 60.0):
        self.max_items, self.ttl_s = max_items, ttl_s
        self._data: "OrderedDict[str, Tuple[float, Any]]" = OrderedDict()
        self._lock = threading.Lock()
        self.hits = self.misses = 0

    def get(self, k: str):
        with self._lock:
            item = self._data.get(k)
            if item is None or item[0] < time.monotonic():
                if item is not None:
                    del self._data[k]
                self.misses += 1
                return None
            self._data.move_to_end(k)
            self.hits += 1
            return item[1]

    def set(self, k: str, value: Any, ttl_s: Optional[float] = None) -> None:
        with self._lock:
            self._data[k] = (time.monotonic() + (ttl_s or self.ttl_s), value)
            self._data.move_to_end(k)
            while len(self._data) > self.max_items:
                self._data.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def stats(self) -> dict:
        total = self.hits + self.misses
        return {"items": len(self._data), "hits": self.hits, "misses": self.misses,
                "hit_rate": round(self.hits / total, 3) if total else None}


PLANS = ScopedCache(max_items=int(os.getenv("AI_CACHE_PLAN_ITEMS", "2000")),
                    ttl_s=float(os.getenv("AI_CACHE_PLAN_TTL", "600")))
RETRIEVAL = ScopedCache(max_items=int(os.getenv("AI_CACHE_RETRIEVAL_ITEMS", "500")),
                        ttl_s=float(os.getenv("AI_CACHE_RETRIEVAL_TTL", "60")))
