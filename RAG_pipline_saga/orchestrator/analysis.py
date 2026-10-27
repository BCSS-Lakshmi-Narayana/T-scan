"""Deep analysis: what an answer is REASONED over, as opposed to what it shows.

An answer has three different populations and conflating them is how a search
box gets mistaken for an analyst:

    matching    every record the deterministic filters select.  Thousands.
                Used for exact counts and coverage.  Never read by a model.

    analysed    the highest-relevance slice of that population, read record by
                record by the model in bounded batches.  Hundreds.
                This is what the findings and the synthesis rest on.

    displayed   the representative records put in front of the officer.
                ~20.  A reading aid, not the basis of the answer.

Before this module the three were one object of about fifteen records, so
"2,632 matching records" was followed by an answer reasoned from seven of them.

Two things make a population of hundreds affordable:

  * batching — records go to the model in small groups, several at a time,
    never as one enormous prompt;
  * caching — a record's findings are stored against its content hash, so the
    same post is never sent to the model twice, and a second question over an
    overlapping window is mostly cache hits.

What this module must never do is turn observation into fact.  Every guard in
the prompt below exists because the alternative is an officer acting on an
incident that only ever happened in a post.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

# Bumped by hand when the FIELDS change — a schema decision a human makes.
_ANALYSIS_SCHEMA_VERSION = "analysis@v3"

# The prompt's own fingerprint is appended below, once the prompt is defined.
# Twice a prompt change shipped without a bump and the cache kept serving
# findings produced by the OLD prompt, which reads exactly like a model
# ignoring an instruction. Deriving it removes the chance to forget rather
# than testing that nobody did.
ANALYSIS_VERSION = _ANALYSIS_SCHEMA_VERSION
ANALYSIS_COLLECTION = "rag_record_analysis"

BATCH_SIZE = int(os.getenv("ANALYSIS_BATCH_SIZE", "10"))

# How many batches may be in the model at once.
#
# These calls do NOT go through runtime.router: the job is handed a raw generate
# function so a long analysis cannot trip the interactive breaker. The cost is
# that the model sees CONCURRENCY batch calls ON TOP OF the router's own
# AI_LLM_CONCURRENCY, and one Ollama on one shared GPU serves both. Left at its
# measured value rather than changed on a hunch, and counted below so the total
# pressure is visible instead of inferred.
CONCURRENCY = int(os.getenv("ANALYSIS_CONCURRENCY", "4"))

_MODEL_LOAD = {"running": 0, "calls": 0, "failed": 0, "ms": 0.0}
_MODEL_LOCK = threading.Lock()


def model_load() -> Dict[str, float]:
    """Analysis's own model use, for the metrics endpoint.

    `running` here plus the router's `running` is what the model is actually
    being asked to do at once. Neither number alone shows it.
    """
    with _MODEL_LOCK:
        return {**_MODEL_LOAD, "concurrency": CONCURRENCY, "batch_size": BATCH_SIZE}


def reset_model_load() -> None:
    with _MODEL_LOCK:
        _MODEL_LOAD.update(running=0, calls=0, failed=0, ms=0.0)


RECORD_CHARS = int(os.getenv("ANALYSIS_RECORD_CHARS", "500"))

# How many records each kind of question is worth reading.  A count needs no
# reading at all — the database answers it exactly — while a situation is the
# whole point of this module.  Configurable because the right number depends on
# the tenant's volume, not on anything in the code.
POOL = {
    "count": int(os.getenv("ANALYSIS_POOL_COUNT", "0")),
    "aggregation": int(os.getenv("ANALYSIS_POOL_COUNT", "0")),
    "filtered_search": int(os.getenv("ANALYSIS_POOL_ACTIVITY", "300")),
    "unknown_concept": int(os.getenv("ANALYSIS_POOL_ACTIVITY", "300")),
    "situation_analysis": int(os.getenv("ANALYSIS_POOL_SITUATION", "800")),
    "comparison": int(os.getenv("ANALYSIS_POOL_COMPARISON", "300")),
    "trend_analysis": int(os.getenv("ANALYSIS_POOL_TREND", "200")),
}
DEFAULT_POOL = int(os.getenv("ANALYSIS_POOL_DEFAULT", "200"))


def pool_size(intent: str) -> int:
    """How many records this intent is worth reading. 0 = deterministic only."""
    return POOL.get(str(intent or ""), DEFAULT_POOL)


# --------------------------------------------------------------------------- #
# one record's findings
# --------------------------------------------------------------------------- #

@dataclass
class Finding:
    """What the model observed in ONE monitored post.

    Every field is about the post, never about the world. `claim` is what the
    post asserts, which is not the same as something that happened; `risk` is
    how the post was rated, which is not evidence that anything occurred.
    """
    key: str
    document_id: str = ""
    relevant: bool = True
    topic: str = ""
    locations: List[str] = field(default_factory=list)
    people: List[str] = field(default_factory=list)
    entities: List[str] = field(default_factory=list)
    content_type: str = ""
    claim: str = ""
    risk: str = ""
    sentiment: str = ""
    cached: bool = False

    def as_doc(self) -> dict:
        d = asdict(self)
        d.pop("cached", None)
        return d


_LIST_SPLIT = re.compile(r"\s*[,;]\s*")


def _clean_list(raw: str, limit: int = 6) -> List[str]:
    if not raw:
        return []
    out = []
    for part in _LIST_SPLIT.split(raw):
        p = part.strip().strip(".").strip()
        if p and p.lower() not in ("none", "n/a", "na", "-", "unknown"):
            out.append(p[:60])
        if len(out) >= limit:
            break
    return out


def _clean(raw: str, limit: int = 120) -> str:
    v = (raw or "").strip().strip(".").strip()
    return "" if v.lower() in ("none", "n/a", "na", "-", "unknown") else v[:limit]


# --------------------------------------------------------------------------- #
# the prompt
# --------------------------------------------------------------------------- #

# A pipe-delimited line per record rather than JSON: a small model produces
# malformed JSON often enough that a parser for it would drop whole batches,
# and a dropped batch is silently missing analysis.
_PROMPT = """You are analysing monitored SOCIAL MEDIA POSTS for a police analyst.

WHAT THESE ARE — read before writing:
- Each numbered item is ONE post someone published online. It is not a police
  record, an incident report, or a confirmed event.
- What a post says is a CLAIM by its author. Write it as a claim.
- A "risk" rating describes the POST, not a proven danger.
- A district is where the post is MONITORED, which is not necessarily where
  anything described in it happened.
- If the post does not say something, leave that field empty. Never guess a
  name, a place or a number that is not in the text.

QUESTION BEING INVESTIGATED: {question}

Output EXACTLY {n} lines — one for every post, numbered 1 to {n}, none skipped.
Each line in this format and no other:

<number>|topic=<2-4 words>|where=<places named IN the post>|who=<people/orgs named>|claim=<what the post asserts, <=12 words>

Rules:
- where/who: comma separated, or empty. Only what the post itself names.
- Keep every field short. Do not add any other text, header, or explanation.
- Even if a post is brief or unclear, still output its line.

POSTS:
{posts}

LINES:"""


#: schema version + prompt fingerprint. A prompt edit changes the cache key on
#: its own, so findings from the previous wording are never mixed in with new
#: ones.
PROMPT_FINGERPRINT = hashlib.sha1(_PROMPT.encode("utf-8")).hexdigest()[:8]
ANALYSIS_VERSION = f"{_ANALYSIS_SCHEMA_VERSION}+{PROMPT_FINGERPRINT}"


def build_prompt(batch: List[dict], question: str) -> str:
    posts = []
    for i, r in enumerate(batch, 1):
        text = _KIND_PREFIX.sub("", re.sub(r"\s+", " ", (r.get("text") or "")).strip())
        text = text[:RECORD_CHARS]
        posts.append(f"{i}. {text}")
    # The count is stated explicitly: without it the model quietly stopped
    # part-way through a batch, and a third of the records we had already paid
    # to prompt for came back with no findings at all.
    return _PROMPT.format(n=len(batch), question=(question or "").strip()[:300],
                          posts="\n".join(posts))


# Curated text is stored as "Alert: ..." / "Complaint: ...". That prefix is
# OUR classification of the record, not what the post is about, and leaving it
# in made the model answer topic=complaint for almost everything — so the
# recurring themes came back as a list of our own record kinds.
_KIND_PREFIX = re.compile(
    r"^(?:alert|complaint|post|report|grievance|suggestion|query|criticism|news)\s*:\s*",
    re.I)

_FIELD = re.compile(r"(\w+)=([^|]*)")


def parse(raw: str, batch: List[dict]) -> Dict[str, Finding]:
    """Findings keyed by record key. Unparseable lines are skipped, not faked."""
    out: Dict[str, Finding] = {}
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line or "|" not in line:
            continue
        head, _, rest = line.partition("|")
        m = re.match(r"^\s*(\d{1,3})", head)
        if not m:
            continue
        pos = int(m.group(1))
        if not (1 <= pos <= len(batch)):
            continue
        rec = batch[pos - 1]
        f = {k.lower(): v for k, v in _FIELD.findall(rest)}
        meta = rec.get("meta") or {}
        out[rec["key"]] = Finding(
            key=rec["key"],
            document_id=str(rec.get("document_id") or ""),
            # Relevance is NOT re-judged here. These records already passed
            # the deterministic filters the question compiled to; asking the
            # model "is this relevant to 'show me high risk activity'?" was
            # measured returning 1 of 47 for posts that all genuinely matched.
            relevant=True,
            topic=_clean(f.get("topic", ""), 40).lower(),
            locations=_clean_list(f.get("where", "")),
            people=_clean_list(f.get("who", "")),
            entities=_clean_list(f.get("who", "")),
            content_type=str(meta.get("kind") or meta.get("category") or "").lower(),
            claim=_clean(f.get("claim", ""), 160),
            # Risk and sentiment are the product's own ratings and already
            # stored. Asking the model for them would cost output tokens per
            # record AND let a model opinion contradict the record itself.
            risk=str(meta.get("risk_level") or "").lower(),
            sentiment=str(meta.get("sentiment") or "").lower(),
        )
    return out


# --------------------------------------------------------------------------- #
# the cache
# --------------------------------------------------------------------------- #

def cache_id(record_key: str, model: str) -> str:
    """`record_key` already ends in the content hash, so an edited post misses."""
    return f"{ANALYSIS_VERSION}|{model or '-'}|{record_key}"


def cached(db, records: List[dict], model: str) -> Dict[str, Finding]:
    """Findings already known for these exact records at this exact version."""
    if db is None or not records:
        return {}
    ids = [cache_id(r["key"], model) for r in records]
    out: Dict[str, Finding] = {}
    try:
        for i in range(0, len(ids), 1000):
            for d in db[ANALYSIS_COLLECTION].find({"_id": {"$in": ids[i:i + 1000]}}):
                doc = d.get("finding") or {}
                if doc.get("key"):
                    out[doc["key"]] = Finding(**{**doc, "cached": True})
    except Exception as exc:
        logger.debug("analysis cache read failed: %s", exc)
        return {}
    return out


def store(db, findings: Dict[str, Finding], model: str):
    if db is None or not findings:
        return
    try:
        from pymongo import ReplaceOne
        now = datetime.now(timezone.utc)
        ops = [ReplaceOne(
            {"_id": cache_id(k, model)},
            {"_id": cache_id(k, model), "record_key": k,
             "document_id": f.document_id, "version": ANALYSIS_VERSION,
             "model": model, "at": now, "finding": f.as_doc()},
            upsert=True) for k, f in findings.items()]
        db[ANALYSIS_COLLECTION].bulk_write(ops, ordered=False)
    except Exception as exc:
        logger.debug("analysis cache write failed: %s", exc)


# --------------------------------------------------------------------------- #
# batched analysis
# --------------------------------------------------------------------------- #

def analyse(records: List[dict], question: str, generate: Optional[Callable],
            db=None, model: str = "",
            on_batch: Optional[Callable[[Dict[str, Finding]], None]] = None,
            stop: Optional[Callable[[], bool]] = None,
            stats: Optional[dict] = None) -> Dict[str, Finding]:
    """Findings for every record, keyed by record key.

    Cached findings are delivered first, in one batch and without a model call,
    so a repeated question over an overlapping window returns almost at once.
    `on_batch` receives each batch as it lands, which is what lets the answer
    fill in progressively instead of blocking for the whole population.

    `stats`, when given, is filled with what this run actually cost: cache
    hits, batch count, model calls and the time spent in them. Without it a
    slow analysis could only be guessed at from the total, which is how a
    cache that had quietly stopped hitting looked like a slow model.
    """
    results = cached(db, records, model)
    if stats is not None:
        stats.update(records=len(records), cache_hits=len(results), batches=0,
                     llm_calls=0, llm_ms=0.0, llm_failed=0, parsed=0)
    if results and on_batch:
        on_batch(dict(results))

    todo = [r for r in records if r["key"] not in results]
    if not todo or not generate:
        return results

    batches = [todo[i:i + BATCH_SIZE] for i in range(0, len(todo), BATCH_SIZE)]
    if stats is not None:
        stats["batches"] = len(batches)
    stats_lock = threading.Lock()
    # A model that is down fails every batch and each failure costs a timeout.
    # After a few failures with nothing succeeding, stop asking.
    health = {"ok": 0, "failed": 0}

    # Output budget per record. Measured: too tight and the model stops
    # mid-batch, which reads as a parse failure and silently loses records we
    # have already paid for.
    def run(batch: List[dict]) -> Dict[str, Finding]:
        if (stop and stop()) or (health["failed"] >= 3 and not health["ok"]):
            return {}
        t0 = time.perf_counter()
        failed = False
        with _MODEL_LOCK:
            _MODEL_LOAD["running"] += 1
            _MODEL_LOAD["calls"] += 1
        try:
            raw = generate(build_prompt(batch, question), BATCH_SIZE * 52 + 64)
        except Exception as exc:
            logger.warning("analysis batch failed: %s", exc)
            raw, failed = "", True
        finally:
            call_ms = (time.perf_counter() - t0) * 1000
            with _MODEL_LOCK:
                _MODEL_LOAD["running"] -= 1
                _MODEL_LOAD["ms"] = round(_MODEL_LOAD["ms"] + call_ms, 1)
                _MODEL_LOAD["failed"] += 1 if failed else 0
        got = parse(raw, batch)
        health["ok" if got else "failed"] += 1
        if stats is not None:
            with stats_lock:
                stats["llm_calls"] += 1
                stats["llm_ms"] = round(stats["llm_ms"] + call_ms, 1)
                stats["llm_failed"] += 1 if failed else 0
                stats["parsed"] += len(got)
        store(db, got, model)
        return got

    # Submitted in rank order so the best candidates are analysed first and
    # reach the officer's screen first.
    try:
        with ThreadPoolExecutor(max_workers=max(1, CONCURRENCY)) as pool:
            for got in pool.map(run, batches):
                if got:
                    results.update(got)
                    if on_batch:
                        on_batch(got)
    except RuntimeError as exc:
        # The process is going away while a background job is mid-population.
        # Nothing is wrong with the analysis, and a traceback here reads like a
        # failure: the findings already collected are returned instead.
        if "interpreter shutdown" not in str(exc):
            raise
        logger.info("analysis stopped at interpreter shutdown with %d findings",
                    len(results))
        return results

    # One retry for the stragglers. A model that drops a line mid-batch leaves
    # that record unanalysed: measured 158 of 167 on a live population. The
    # count was reported honestly, but a record we paid to retrieve and prompt
    # for should actually be read. Bounded to a single pass so a model that is
    # simply failing cannot turn this into a loop.
    missed = [r for r in todo if r["key"] not in results]
    if missed and not (stop and stop()) and health["ok"]:
        retry_batches = [missed[i:i + BATCH_SIZE]
                         for i in range(0, len(missed), BATCH_SIZE)]
        logger.info("retrying %d record(s) the model skipped, in %d batch(es)",
                    len(missed), len(retry_batches))
        if stats is not None:
            stats["retried"] = len(missed)
        for batch in retry_batches:
            got = run(batch)
            if got:
                results.update(got)
                if on_batch:
                    on_batch(got)
        still = [r for r in missed if r["key"] not in results]
        if still:
            logger.warning("%d record(s) remain unanalysed after one retry",
                           len(still))
            if stats is not None:
                stats["unanalysed"] = len(still)
    return results


# --------------------------------------------------------------------------- #
# cross-record aggregation
# --------------------------------------------------------------------------- #

# Words that carry no meaning as a theme on their own.
_STOP_THEME = {"", "other", "general", "misc", "news", "post", "update", "none"}


def _merge_plurals(counts: Counter) -> Counter:
    """Fold "complaints" into "complaint".

    The model writes whichever form the post suggested, so the same theme
    arrived twice and split its own count — "complaint 7" beside
    "complaints 4" reads as two findings when it is one of eleven. Only an
    exact singular/plural pair is merged; nothing is stemmed, because
    collapsing genuinely different words would be worse than splitting one.
    """
    out = Counter()
    for term, n in counts.items():
        singular = term[:-1] if term.endswith("s") and not term.endswith("ss") else term
        out[singular if singular in counts else term] += n
    return out


def aggregate(findings: Dict[str, Finding], records: Dict[str, dict],
              limit: int = 8) -> dict:
    """What the analysed population says as a body, rather than post by post.

    Clusters group posts that share a theme AND a named place, which is the
    weakest link worth drawing. It is explicitly NOT a claim that they describe
    the same incident — several accounts posting about "women safety" in
    Hyderabad may be discussing several different things, and the officer is
    told that rather than sold a false linkage.
    """
    rel = [f for f in findings.values() if f.relevant]
    themes = _merge_plurals(Counter(f.topic for f in rel if f.topic not in _STOP_THEME))
    places = Counter(p for f in rel for p in f.locations)
    people = Counter(p for f in rel for p in f.people)
    types = Counter(f.content_type for f in rel if f.content_type)
    sentiment = Counter(f.sentiment for f in rel if f.sentiment)

    clusters: Dict[tuple, List[str]] = defaultdict(list)
    for f in rel:
        if f.topic in _STOP_THEME:
            continue
        where = (f.locations[0].lower() if f.locations else "")
        clusters[(f.topic, where)].append(f.key)

    grouped = sorted(((k, v) for k, v in clusters.items() if len(v) > 1),
                     key=lambda kv: len(kv[1]), reverse=True)[:limit]

    def rows(counter):
        return [{"value": v, "count": c} for v, c in counter.most_common(limit)]

    return {
        "analysed": len(findings),
        "relevant": len(rel),
        "cached": sum(1 for f in findings.values() if f.cached),
        "themes": rows(themes),
        "locations": rows(places),
        "people": rows(people),
        "content_types": rows(types),
        "sentiment": rows(sentiment),
        "clusters": [{
            "theme": theme,
            "where": where or None,
            "size": len(keys),
            # The officer must not read a cluster as one confirmed event.
            "note": "posts sharing a theme and a place; not necessarily one incident",
            "records": keys[:5],
        } for (theme, where), keys in grouped],
        # The claims most often repeated across DIFFERENT accounts carry more
        # weight than one account repeating itself, so count distinct authors.
        "repeated_claims": _repeated_claims(rel, records, limit),
    }


def _repeated_claims(rel: List[Finding], records: Dict[str, dict], limit: int) -> List[dict]:
    by_claim: Dict[str, set] = defaultdict(set)
    for f in rel:
        c = (f.claim or "").strip().lower()
        if len(c) < 12:
            continue
        handle = ((records.get(f.key) or {}).get("meta") or {}).get("handle") or f.key
        by_claim[c].add(str(handle))
    out = [{"claim": c, "accounts": len(a)} for c, a in by_claim.items() if len(a) > 1]
    return sorted(out, key=lambda r: r["accounts"], reverse=True)[:limit]


def representative(findings: Dict[str, Finding], order: List[str],
                   agg: dict, count: int = 20) -> List[str]:
    """The record keys worth showing, in the officer's reading order.

    One from each cluster first, so the displayed set spans what was found
    rather than repeating the single loudest theme, then the best-ranked
    remainder. `order` is the retrieval ranking, so ties break toward
    relevance.
    """
    rank = {k: i for i, k in enumerate(order)}
    picked: List[str] = []
    seen = set()

    for c in agg.get("clusters", []):
        for key in sorted(c.get("records", []), key=lambda k: rank.get(k, 1 << 30)):
            if key not in seen:
                picked.append(key)
                seen.add(key)
                break

    for key in order:
        if len(picked) >= count:
            break
        f = findings.get(key)
        # Only records the model actually read are offered as evidence: the
        # answer rests on the analysed population, so the evidence should too.
        if key in seen or f is None or not f.relevant:
            continue
        picked.append(key)
        seen.add(key)

    picked.sort(key=lambda k: rank.get(k, 1 << 30))
    return picked[:count]


# --------------------------------------------------------------------------- #
# building the analysis population
# --------------------------------------------------------------------------- #

def build_population(collections, stores, spec, tenant_id, districts, size,
                     embed=None, terms=None):
    """(records, matching_total) — the slice worth reading, ranked by relevance.

    Reading the window by recency alone was measurably wrong: for "high risk
    activity in Hyderabad" it handed the model the most recent high-risk posts,
    four fifths of which were about something else entirely, and only a tenth
    came back relevant. So the window is deliberately read WIDER than the
    population, then ranked, and only the top slice is read by the model.

    `matching_total` is the deterministic count over the whole window and is
    never affected by the ranking: it is the population the answer reports.
    """
    from scan import window, lexical_scores, semantic_scores, rrf, WINDOW_MAX

    if size <= 0:
        return [], 0
    cap = min(max(size * 4, size + 200), WINDOW_MAX)
    records, total = window(collections, spec, tenant_id, districts, cap=cap)
    if len(records) <= size:
        return records, total

    maps = []
    if terms:
        maps.append(lexical_scores(records, terms))
    text = (getattr(spec, "text", "") or "").strip()
    if embed and stores and text:
        try:
            maps.append(semantic_scores(records, stores, embed(text)))
        except Exception as exc:
            logger.debug("semantic ranking unavailable: %s", exc)
    ranked = rrf(records, *maps) if maps else records
    return ranked[:size], total


# --------------------------------------------------------------------------- #
# synthesis over the analysed population
# --------------------------------------------------------------------------- #

_SUMMARY_PROMPT = """You are the AI Assistant, briefing a police officer.

WHAT YOU ARE SUMMARISING — read before writing:
- These are counts and observations drawn from MONITORED SOCIAL MEDIA POSTS.
- A post count is a count of POSTS, never of incidents, crimes or events.
- What a post alleges is an ALLEGATION. Write "posts allege", never "there was".
- A district is where posts are MONITORED, not where anything happened.
- Several posts sharing a theme are several POSTS, not one confirmed incident.
- Use ONLY the figures and themes given below. Invent nothing. If something is
  not listed, it is not known.

QUESTION: {question}

WHAT WAS ANALYSED: {analysed} monitored posts, the most relevant of {matching}
matching the officer's filters. These {analysed} are a SAMPLE, so absence from
the lists below says nothing about the rest.

RECURRING THEMES (theme, number of posts):
{themes}

PLACES NAMED INSIDE POSTS (place, number of posts):
{places}

ACCOUNTS POSTING REPEATEDLY (account, number of posts):
{accounts}

GROUPS OF POSTS SHARING A THEME AND A PLACE:
{clusters}

CLAIMS MADE BY MORE THAN ONE ACCOUNT:
{claims}

Write for the officer, in this shape and nothing else:

<2-3 sentences answering the question directly, in plain English>

Key observations
- <observation grounded in a figure above>
- <observation grounded in a figure above>
- <observation grounded in a figure above>

Rules:
- Every number you write must appear above.
- No heading other than "Key observations".
- Do not speculate about causes, culprits or what will happen next.
- Do NOT say anything increased, decreased, rose, fell or changed. No
  comparison over time was given to you, so you cannot know it.
- Do NOT draw any conclusion about a place, person or topic that does not
  appear above. If something is absent from these lists it means it was not
  in what was read, NOT that there is nothing happening there.
- Say "posts" for everything you count. Never "incidents", "cases" or
  "events".

BRIEFING:"""


def _rows_text(rows: List[dict], key: str = "value", empty: str = "(none)") -> str:
    if not rows:
        return empty
    return "\n".join(f"- {r.get(key)}: {r.get('count')}" for r in rows[:8])


def summarise(question: str, agg: dict, matching: Optional[int],
              generate: Optional[Callable]) -> str:
    """A grounded briefing over the analysed population, or "" if unavailable.

    Returns an empty string rather than a guess when the model is unavailable:
    the officer then gets the measured figures and the evidence, which is less
    than a briefing but is never wrong.
    """
    if not generate or not agg.get("analysed"):
        return ""
    clusters = "\n".join(
        f"- {c['theme']} in {c['where'] or 'no place named'}: {c['size']} posts"
        for c in agg.get("clusters", [])[:6]) or "(none)"
    claims = "\n".join(
        f"- \"{c['claim']}\" — posted by {c['accounts']} different accounts"
        for c in agg.get("repeated_claims", [])[:5]) or "(none)"
    prompt = _SUMMARY_PROMPT.format(
        question=(question or "").strip()[:300],
        analysed=agg.get("analysed", 0),
        matching=matching if matching is not None else "an unknown number of",
        themes=_rows_text(agg.get("themes", [])),
        places=_rows_text(agg.get("locations", [])),
        accounts=_rows_text(agg.get("people", [])),
        clusters=clusters, claims=claims)
    try:
        return (generate(prompt, 420) or "").strip()
    except Exception as exc:
        logger.warning("analysis summary failed: %s", exc)
        return ""


_COMPARE_PROMPT = """You are the AI Assistant, briefing a police officer.

WHAT YOU ARE COMPARING — read before writing:
- These are counts of MONITORED SOCIAL MEDIA POSTS, per location, never counts
  of incidents, crimes or events.
- Places are monitored to different depths. More posts in one place can mean
  more monitoring there, not more happening there. Say so if the gap is large.
- What posts allege is an ALLEGATION. Write "posts allege", never "there was".
- Use ONLY the figures and themes below. Invent nothing.

QUESTION: {question}

{blocks}
Write for the officer, in this shape and nothing else:

<2-3 sentences stating what each side shows, factually, side by side>

Key observations
- <observation grounded in a figure above>
- <observation grounded in a figure above>

Rules:
- Every number you write must appear above.
- No heading other than "Key observations".
- Do not rank the places as better or worse, safer or more dangerous.
- Say one side has MORE of something only when its number is actually larger.
  Read the figures before comparing them.
- "matching posts" is each side's headline figure. Do not compare the theme
  tallies as if they were the totals.
- Do not say anything increased, decreased or changed: no comparison over time
  was given to you.
- Say "posts" for everything you count.

BRIEFING:"""


def compare_sides(question: str, sides: List[tuple],
                  generate: Optional[Callable]) -> str:
    """A briefing over several scopes, each read separately.

    `sides` is (label, matching, aggregate). Returns "" rather than a guess
    when the model is unavailable — the officer still has each side's measured
    figures and evidence, which is less than a briefing but never wrong.
    """
    usable = [(label, matching, agg) for label, matching, agg in sides
              if agg and agg.get("analysed")]
    if not generate or len(usable) < 2:
        return ""
    blocks = []
    for label, matching, agg in usable:
        blocks.append(
            f"{label.upper()}\n"
            f"  matching posts: {matching if matching is not None else 'unknown'}\n"
            f"  posts read: {agg.get('analysed', 0)}\n"
            f"  recurring themes:\n{_rows_text(agg.get('themes', []))}\n"
            f"  places named in posts:\n{_rows_text(agg.get('locations', []))}\n")
    try:
        return (generate(_COMPARE_PROMPT.format(
            question=(question or "").strip()[:300],
            blocks="\n".join(blocks)), 420) or "").strip()
    except Exception as exc:
        logger.warning("comparison summary failed: %s", exc)
        return ""
