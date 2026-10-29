"""
location.py — place text -> a gazetteer entity, or an honest "unresolved".

Deterministic. Resolution order, most certain first:

    1. exact name or alias (Latin, Telugu, Hindi)        confidence 1.0
    2. one-edit fuzzy match on a long Latin name        confidence 0.8
       ("karimnagr" -> Karimnagar; never on short names, where one edit
        turns one real place into another)
    3. otherwise UNRESOLVED — the text stays free text, and nothing guesses

Several entries for one name (Hyderabad is a district AND a commissionerate
AND the city) collapse when they cover the same districts, because for
retrieval they mean the same thing. When they cover DIFFERENT districts
(Warangal district vs Warangal Commissionerate), an explicit word in the
question decides ("commissionerate", "CP", "district"); without one the
district reading is taken, flagged as an assumption, never silently.

Resolution states WHERE a place is. It never states whether the caller may
look there — that stays with the Policy Gate.
"""

from __future__ import annotations

import json
import os
import re
import unicodedata
from functools import lru_cache
from typing import Dict, List, Optional, Tuple

import _compiled_compat  # noqa: F401  (before any pydantic model; see the module)
from pydantic import BaseModel, ConfigDict, Field

_DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gazetteer_telangana.json")
_ZW = re.compile(r"[​-‍⁠﻿]")


class Place(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    id: str
    name: str
    type: str
    districts: Tuple[str, ...] = ()
    aliases: Tuple[str, ...] = ()


class LocationResolution(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str
    status: str                        # resolved | ambiguous | unresolved
    place: Optional[Place] = None
    candidates: List[Place] = Field(default_factory=list)
    districts: List[str] = Field(default_factory=list)
    confidence: float = 0.0
    method: str = "none"               # exact | fuzzy | none
    assumption: Optional[str] = None   # stated when a default reading was taken
    gazetteer_version: str = ""


def fold(text: str) -> str:
    text = unicodedata.normalize("NFC", _ZW.sub("", text or "")).casefold()
    text = text.replace("–", "-").replace("—", "-")
    return " ".join(re.sub(r"[^\w\s-]", " ", text).split())


@lru_cache(maxsize=1)
def _load() -> Tuple[str, Tuple[Place, ...]]:
    with open(_DATA, encoding="utf-8") as fh:
        raw = json.load(fh)
    places = tuple(Place(id=e["id"], name=e["name"], type=e["type"],
                         districts=tuple(e.get("districts", [])),
                         aliases=tuple(sorted({fold(a) for a in e["aliases"] + [e["name"]]})))
                   for e in raw["entries"])
    return raw["version"], places


def version() -> str:
    return _load()[0]


@lru_cache(maxsize=1)
def _alias_index() -> Dict[str, List[Place]]:
    index: Dict[str, List[Place]] = {}
    for p in _load()[1]:
        for a in p.aliases:
            index.setdefault(a, []).append(p)
    return index


def _edit1(a: str, b: str) -> bool:
    if abs(len(a) - len(b)) > 1 or a == b:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    if len(a) > len(b):
        a, b = b, a
    i = j = diff = 0
    while i < len(a) and j < len(b):
        if a[i] != b[j]:
            diff += 1
            j += 1
            if diff > 1:
                return False
        else:
            i += 1
            j += 1
    return True


_TYPE_HINTS = [(re.compile(r"\bcommissionerate\b|\bcp\b|\bpolice commissionerate\b", re.I), "commissionerate"),
               (re.compile(r"\bdistrict\b|\bjilla\b|\bజిల్లా\b|\bजिला\b", re.I), "district"),
               (re.compile(r"\bcity\b|\btown\b", re.I), "city")]


def _collapse(places: List[Place], context: str) -> Tuple[List[Place], Optional[str]]:
    """Same districts -> one meaning. Different -> a type hint decides, else
    the district reading, stated as an assumption."""
    uniq: Dict[Tuple[str, ...], Place] = {}
    for p in places:
        uniq.setdefault(tuple(sorted(p.districts)), p)
    if len(uniq) == 1:
        return [next(iter(uniq.values()))], None
    for pattern, kind in _TYPE_HINTS:
        if pattern.search(context):
            hinted = [p for p in places if p.type == kind]
            if len(hinted) == 1:
                return hinted, None
    districts_only = [p for p in places if p.type == "district"]
    if len(districts_only) == 1:
        others = sorted({p.type for p in places if p.type != "district"})
        return districts_only, (f"'{districts_only[0].name}' read as the district, not the "
                                f"{' / '.join(others)}")
    return list(uniq.values()), None


def resolve(text: str, context: str = "") -> LocationResolution:
    q = fold(text)
    ver = version()
    if not q:
        return LocationResolution(query=text, status="unresolved", gazetteer_version=ver)
    index = _alias_index()
    hits = list(index.get(q, []))
    method, confidence = "exact", 1.0
    if not hits and re.fullmatch(r"[a-z][a-z \-]{5,}", q):
        hits = [p for alias, ps in index.items() if len(alias) >= 6 and _edit1(q, alias) for p in ps]
        method, confidence = "fuzzy", 0.8
    if not hits:
        return LocationResolution(query=text, status="unresolved", gazetteer_version=ver)
    chosen, assumption = _collapse(hits, context or text)
    if len(chosen) > 1:
        return LocationResolution(query=text, status="ambiguous", candidates=chosen,
                                  method=method, confidence=0.5, gazetteer_version=ver)
    place = chosen[0]
    if assumption:
        confidence = min(confidence, 0.75)
    return LocationResolution(query=text, status="resolved", place=place,
                              districts=list(place.districts), confidence=confidence,
                              method=method, assumption=assumption, gazetteer_version=ver)


def find_all(text: str) -> List[LocationResolution]:
    """Every place a question names, in order — including Telugu and Hindi
    script names Phase 1A's Latin-only list cannot see. Longest alias wins
    at each position, so "ranga reddy" is not also "reddy"."""
    t = fold(text)
    found: List[Tuple[int, int, str]] = []
    for alias in sorted(_alias_index(), key=len, reverse=True):
        latin = re.fullmatch(r"[a-z0-9 \-]+", alias) is not None
        # Latin names need word boundaries; Indic names carry case suffixes
        # (కరీంనగర్లో = "in Karimnagar"), so they match as prefixes of a word.
        pattern = rf"(?<![\w]){re.escape(alias)}(?![\w])" if latin else re.escape(alias)
        for m in re.finditer(pattern, t):
            if any(s <= m.start() < e or s < m.end() <= e for s, e, _ in found):
                continue
            found.append((m.start(), m.end(), alias))
    found.sort()
    out, seen = [], set()
    for _, _, alias in found:
        r = resolve(alias, context=text)
        key = r.place.id if r.place else alias
        if key not in seen:
            seen.add(key)
            out.append(r)
    return out


def same_district(a: str, b: str) -> bool:
    """Do two district strings name the same district? Tenants store names
    their own way ("Rangareddy", "Ranga Reddy"); aliases settle it."""
    fa, fb = fold(a), fold(b)
    if fa == fb:
        return True
    pa = [p.id for p in _alias_index().get(fa, []) if p.type == "district"]
    pb = [p.id for p in _alias_index().get(fb, []) if p.type == "district"]
    return bool(pa) and pa == pb


def intersect(place_districts: List[str], allowed: Optional[List[str]]) -> Optional[List[str]]:
    """Caller-scope districts that a resolved place covers. None = caller is
    unrestricted (the place's own districts apply). Uses the CALLER'S spelling,
    because that is what the stored records carry."""
    if allowed is None:
        return list(place_districts)
    return [a for a in allowed if any(same_district(a, d) for d in place_districts)]
