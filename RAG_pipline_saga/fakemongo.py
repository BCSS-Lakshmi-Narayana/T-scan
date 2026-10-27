"""
fakemongo.py — an in-memory stand-in for the Mongo features this service uses.

Test support only; nothing in the service imports it. Filters are EVALUATED,
not pattern-matched: the tenant clause, the district $or/$exists/$size clause,
$in on arrays, date windows, $text, and the aggregation stages analytics.py
builds ($match, $unwind, $group with $sum and $dateToString, $sort, $limit).
A test that passes here passes because the filter selected the right rows.

Also a FakeVectorStore with the two methods retrieval calls (cosine_search,
similarity) over a deterministic hashing embedder, so semantic retrieval is
exercised without a model.
"""

from __future__ import annotations

import copy
import hashlib
import math
import re
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional

_MISSING = object()


def get_path(doc: Any, path: str):
    cur = doc
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part, _MISSING)
        else:
            return _MISSING
        if cur is _MISSING:
            return _MISSING
    return cur


def _values(got) -> List[Any]:
    """A field compared against a scalar matches if any array element does."""
    if got is _MISSING:
        return []
    if isinstance(got, list):
        return list(got) + [got]
    return [got]


def _cmp(op: str, got, val) -> bool:
    vals = _values(got)
    if op == "$eq":
        return any(v == val for v in vals) or (got is _MISSING and val is None)
    if op == "$ne":
        return not _cmp("$eq", got, val)
    if op == "$in":
        if got is _MISSING or got is None:
            return None in val
        if isinstance(got, list):
            return any(x in val for x in got)
        return got in val
    if op == "$nin":
        return not _cmp("$in", got, val)
    if op == "$exists":
        return (got is not _MISSING) == bool(val)
    if op == "$size":
        return isinstance(got, list) and len(got) == val
    if op in ("$gte", "$gt", "$lte", "$lt"):
        for v in vals:
            if v is None or isinstance(v, list):
                continue
            try:
                if op == "$gte" and v >= val: return True
                if op == "$gt" and v > val: return True
                if op == "$lte" and v <= val: return True
                if op == "$lt" and v < val: return True
            except TypeError:
                continue
        return False
    if op == "$regex":
        return any(isinstance(v, str) and re.search(val, v) for v in vals)
    raise NotImplementedError(op)


def matches(doc: dict, query: dict) -> bool:
    for key, want in (query or {}).items():
        if key == "$and":
            if not all(matches(doc, q) for q in want):
                return False
        elif key == "$or":
            if not any(matches(doc, q) for q in want):
                return False
        elif key == "$text":
            terms = [t.lower() for t in re.findall(r"\w+", want.get("$search", ""))]
            text = str(doc.get("text", "")).lower()
            if not any(t in text for t in terms):
                return False
        else:
            got = get_path(doc, key)
            if isinstance(want, dict) and want and all(k.startswith("$") for k in want):
                for op, val in want.items():
                    if op == "$options":
                        continue
                    if not _cmp(op, got, val):
                        return False
            elif not _cmp("$eq", got, want):
                return False
    return True


def _project(doc: dict, projection: Optional[dict]) -> dict:
    if not projection:
        return copy.deepcopy(doc)
    keep = {k for k, v in projection.items() if v == 1 or v is True}
    if not keep:
        return {k: copy.deepcopy(v) for k, v in doc.items() if projection.get(k, 1) != 0}
    return {k: copy.deepcopy(doc[k]) for k in keep if k in doc}


class Cursor:
    def __init__(self, docs: List[dict], text_scores: Optional[Dict[int, float]] = None):
        self._docs = docs

    def sort(self, keys, direction=None):
        if isinstance(keys, str):
            keys = [(keys, direction or 1)]
        for path, d in reversed(list(keys)):
            if isinstance(d, dict):          # {"$meta": "textScore"}
                continue
            self._docs.sort(key=lambda doc: _sortable(get_path(doc, path)), reverse=d == -1)
        return self

    def limit(self, n):
        if n:
            self._docs = self._docs[:n]
        return self

    def __iter__(self):
        return iter(self._docs)


def _sortable(v):
    if v is _MISSING or v is None:
        return (0, 0)
    if isinstance(v, datetime):
        return (1, v.timestamp())
    if isinstance(v, (int, float)):
        return (1, v)
    return (2, str(v))


class UpdateResult:
    def __init__(self, matched=0, modified=0, deleted=0, upserted_id=None):
        self.matched_count, self.modified_count = matched, modified
        self.deleted_count, self.upserted_id = deleted, upserted_id


class FakeCollection:
    def __init__(self, name: str = "col", docs: Iterable[dict] = ()):
        self.name = name
        self.docs: List[dict] = [copy.deepcopy(d) for d in docs]
        self.indexes: List[tuple] = []
        self.reads = 0
        self.writes = 0

    # -- reads ---------------------------------------------------------------
    def find(self, query=None, projection=None):
        self.reads += 1
        return Cursor([_project(d, projection) for d in self.docs if matches(d, query or {})])

    def find_one(self, query=None, projection=None):
        self.reads += 1
        for d in self.docs:
            if matches(d, query or {}):
                return _project(d, projection)
        return None

    def count_documents(self, query):
        self.reads += 1
        return sum(1 for d in self.docs if matches(d, query))

    def aggregate(self, pipeline: List[dict]):
        self.reads += 1
        rows = [copy.deepcopy(d) for d in self.docs]
        for stage in pipeline:
            (op, arg), = stage.items()
            if op == "$match":
                rows = [r for r in rows if matches(r, arg)]
            elif op == "$unwind":
                path = arg.lstrip("$")
                out = []
                for r in rows:
                    v = get_path(r, path)
                    if isinstance(v, list):
                        for item in v:
                            nr = copy.deepcopy(r)
                            _set_path(nr, path, item)
                            out.append(nr)
                    elif v is not _MISSING and v is not None:
                        out.append(r)
                rows = out
            elif op == "$group":
                groups: Dict[Any, dict] = {}
                for r in rows:
                    key = _eval(arg["_id"], r)
                    hk = _hashable(key)
                    g = groups.setdefault(hk, {"_id": key})
                    for field, acc in arg.items():
                        if field == "_id":
                            continue
                        (aop, aval), = acc.items()
                        if aop == "$sum":
                            g[field] = g.get(field, 0) + (_eval(aval, r) if not isinstance(aval, int) else aval)
                        else:
                            raise NotImplementedError(aop)
                rows = list(groups.values())
            elif op == "$sort":
                for path, d in reversed(list(arg.items())):
                    rows.sort(key=lambda r: _sortable(get_path(r, path)), reverse=d == -1)
            elif op == "$limit":
                rows = rows[:arg]
            elif op == "$count":
                rows = [{arg: len(rows)}] if rows else []
            else:
                raise NotImplementedError(op)
        return iter(rows)

    # -- writes --------------------------------------------------------------
    def insert_one(self, doc):
        self.writes += 1
        doc = copy.deepcopy(doc)
        doc.setdefault("_id", hashlib.md5(repr(len(self.docs)).encode() + repr(doc).encode()).hexdigest()[:24])
        if any(d.get("_id") == doc["_id"] for d in self.docs):
            raise KeyError("duplicate _id")
        self.docs.append(doc)
        return UpdateResult(upserted_id=doc["_id"])

    def _apply(self, doc, update):
        for op, fields in update.items():
            for k, v in fields.items():
                if op == "$set":
                    _set_path(doc, k, copy.deepcopy(v))
                elif op == "$inc":
                    cur = get_path(doc, k)
                    _set_path(doc, k, (0 if cur is _MISSING else cur) + v)
                elif op == "$setOnInsert":
                    pass
                elif op == "$push":
                    cur = get_path(doc, k)
                    _set_path(doc, k, ([] if cur is _MISSING else cur) + [copy.deepcopy(v)])
                else:
                    raise NotImplementedError(op)

    def update_one(self, query, update, upsert=False):
        self.writes += 1
        for d in self.docs:
            if matches(d, query):
                self._apply(d, update)
                return UpdateResult(1, 1)
        if upsert:
            doc = {k: v for k, v in query.items() if not k.startswith("$") and not isinstance(v, dict)}
            for k, v in (update.get("$setOnInsert") or {}).items():
                _set_path(doc, k, copy.deepcopy(v))
            self._apply(doc, {k: v for k, v in update.items() if k != "$setOnInsert"})
            return self.insert_one(doc)
        return UpdateResult(0, 0)

    def find_one_and_update(self, query, update, **kw):
        self.writes += 1
        for d in self.docs:
            if matches(d, query):
                before = copy.deepcopy(d)
                self._apply(d, update)
                return before
        return None

    def delete_one(self, query):
        self.writes += 1
        for i, d in enumerate(self.docs):
            if matches(d, query):
                del self.docs[i]
                return UpdateResult(deleted=1)
        return UpdateResult()

    def create_index(self, keys, **kw):
        self.indexes.append((keys, kw))


def _set_path(doc, path, value):
    parts = path.split(".")
    cur = doc
    for p in parts[:-1]:
        cur = cur.setdefault(p, {})
    cur[parts[-1]] = value


def _hashable(v):
    if isinstance(v, dict):
        return tuple(sorted((k, _hashable(x)) for k, x in v.items()))
    if isinstance(v, list):
        return tuple(_hashable(x) for x in v)
    return v


def _eval(expr, doc):
    if isinstance(expr, str) and expr.startswith("$"):
        v = get_path(doc, expr[1:])
        return None if v is _MISSING else v
    if isinstance(expr, dict) and "$dateToString" in expr:
        spec = expr["$dateToString"]
        v = _eval(spec["date"], doc)
        if not isinstance(v, datetime):
            return None
        fmt = spec["format"].replace("%G", "%G").replace("%V", "%V")
        return v.strftime(fmt)
    # A compound group key, e.g. {"bucket": <expr>, "doc": "$metadata.document_id"},
    # which is how a distinct-document count is expressed.
    if isinstance(expr, dict) and expr and not any(k.startswith("$") for k in expr):
        return {k: _eval(v, doc) for k, v in expr.items()}
    return expr


class FakeDB(dict):
    """db[name] -> FakeCollection, created on first use."""

    def __missing__(self, name):
        col = FakeCollection(name)
        self[name] = col
        return col

    def list_collection_names(self):
        return list(self.keys())


# --------------------------------------------------------------------------- #
# vectors
# --------------------------------------------------------------------------- #

def hash_embed(text: str, dims: int = 256) -> List[float]:
    """Deterministic bag-of-words embedding: same words, same direction."""
    v = [0.0] * dims
    for w in re.findall(r"\w+", (text or "").lower()):
        if len(w) < 3:
            continue
        h = int(hashlib.md5(w.encode()).hexdigest(), 16)
        v[h % dims] += 1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class FakeVectorStore:
    """cosine_search / similarity over a FakeCollection, honouring the same
    tenant and district boundary the real VectorStore enforces."""

    def __init__(self, collection: FakeCollection, embed=hash_embed):
        self.col = collection
        self.embed = embed

    def _scope_ok(self, d, tenant_id, districts):
        m = d.get("metadata", {})
        if tenant_id and m.get("tenant_id") != tenant_id:
            return False
        if districts is not None:
            ds = m.get("districts") or []
            if not districts:
                return False
            if ds and not set(ds) & set(districts):
                return False
        return True

    def cosine_search(self, query_vector, top_k=5, query_text="", tenant_id=None,
                      districts=None, **kw):
        out = []
        for d in self.col.docs:
            if not self._scope_ok(d, tenant_id, districts):
                continue
            vec = self.embed(d.get("text", ""))
            score = sum(a * b for a, b in zip(query_vector, vec))
            out.append({"text": d.get("text", ""), "metadata": copy.deepcopy(d.get("metadata", {})),
                        "score": round(score, 6)})
        out.sort(key=lambda h: h["score"], reverse=True)
        return out[:top_k]

    def similarity(self, query_vector, chunk_ids, fetch_limit=5000):
        wanted = set(chunk_ids)
        out = {}
        for d in self.col.docs:
            cid = d.get("metadata", {}).get("chunk_id")
            if cid in wanted:
                vec = self.embed(d.get("text", ""))
                out[cid] = sum(a * b for a, b in zip(query_vector, vec))
        return out
