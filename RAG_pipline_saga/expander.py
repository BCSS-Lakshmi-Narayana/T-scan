"""
expander.py — a concept, as the words people actually post it in.

"Communal" rarely appears in a communal post. What appears is "danga",
"mandir", "masjid", a slur, a Telugu phrase. Recall for a concept needs those
words, so the model expands the concept once into terms in English, romanised
Telugu/Hindi and native script.

Cached per concept (in-process and in the tenant's database), so an expansion
costs one model call the first time a concept is ever asked, and nothing after.
The curated vocabulary seeds it: when the concept names a known topic, its
hand-written terms are always included, whether or not the model is up.
"""

from __future__ import annotations

import logging
import re
import threading
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional

import concepts
import llm_planner
import vocabulary

logger = logging.getLogger(__name__)

CACHE_COLLECTION = "rag_concept_terms"
MAX_TERMS = 24
MAX_TOKENS = 260
# Lexical matching is a regex pass over the window, so a long list is cheap.
MAX_LEXICAL_TERMS = 90

_memory: Dict[str, List[str]] = {}
_lock = threading.Lock()


def _prompt(label: str) -> str:
    hint = concepts.hint(label)
    about = f' ("{label}" here means: {hint})' if hint else ""
    return f"""\
Social media posts from Telangana, India are being searched for: "{label}"{about}.

List words and short phrases that such posts actually contain -- in English,
romanised Telugu, romanised Hindi, Telugu script and Hindi script. Include
slang, synonyms, related events and the names of things typically involved.
Do not include generic words (police, people, government) unless the concept
is specifically about them.

Return ONLY a JSON object: {{"terms": ["...", "..."]}} with at most {MAX_TERMS} terms."""


def _items(label: str) -> List[str]:
    """ "rapes, robbery, corruption" -> the three items; a plain concept is
    one item. Each item is matched on its own, never as the joined phrase."""
    return [i.strip() for i in label.split(",") if i.strip()]


def _seed(label: str) -> List[str]:
    """Hand-curated terms for every known topic or target the concept names."""
    words = set(re.findall(r"\w+", label.lower()))
    # "rapes" should find the "rape" entries.
    words |= {w[:-1] for w in words if len(w) > 4 and w.endswith("s")}
    topic_map = vocabulary.query_topic_map()
    target_map = vocabulary.query_target_map()
    out: List[str] = []
    for item in _items(label):
        key = item.lower().replace(" ", "_")
        for table in (vocabulary.TOPICS, vocabulary.TARGETS):
            out.extend(table.get(key, []))
    for w in words:
        for table, qmap in ((vocabulary.TOPICS, topic_map), (vocabulary.TARGETS, target_map)):
            if w in table:
                out.extend(table[w])
            if w in qmap:
                out.extend(table.get(qmap[w], []))
    return out


def _dedupe(terms: List[str]) -> List[str]:
    seen, out = set(), []
    for t in terms:
        t = str(t).strip()
        k = t.lower()
        if 1 < len(t) <= 60 and k not in seen:
            seen.add(k)
            out.append(t)
    return out


def expand(label: str, generate: Optional[Callable] = None, db=None) -> List[str]:
    """Terms for *label*: the label itself, curated seeds, and model output.

    Never raises. With no model and no cache this is the label plus seeds,
    which is still better recall than the label alone.
    """
    key = concepts.cache_key(label)
    if not key:
        return []

    with _lock:
        if key in _memory:
            return _memory[key]

    cached = None
    if db is not None:
        try:
            cached = db[CACHE_COLLECTION].find_one({"_id": key})
        except Exception as exc:
            logger.debug("expansion cache read failed: %s", exc)
    if cached and cached.get("terms"):
        terms = cached["terms"]
    else:
        generated: List[str] = []
        if generate:
            try:
                data = llm_planner.parse(generate(_prompt(label), MAX_TOKENS))
                got = data.get("terms")
                if isinstance(got, list):
                    generated = [str(t) for t in got]
            except Exception as exc:
                logger.warning("concept expansion unavailable: %s", exc)
        terms = _dedupe(_items(label) + _seed(label) + generated)[:MAX_LEXICAL_TERMS]
        # Only a model-backed expansion is worth persisting; a seeds-only one
        # would pin the weaker list after the model comes back.
        if generated and db is not None:
            try:
                db[CACHE_COLLECTION].replace_one(
                    {"_id": key},
                    {"_id": key, "label": label, "terms": terms,
                     "at": datetime.now(timezone.utc)},
                    upsert=True)
            except Exception as exc:
                logger.debug("expansion cache write failed: %s", exc)
        if not generated:
            return terms

    with _lock:
        _memory[key] = terms
    return terms
