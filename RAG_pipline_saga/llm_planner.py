"""
llm_planner.py — the fallback that makes arbitrary phrasing work.

planner.py resolves the shapes officers ask most often, by rule: no tokens, no
latency, no dependency on a model endpoint. But rules only know the phrasings
they were written for. "Posts criticising how officers behave at checkposts"
names no keyword in any list, and a rule planner leaves it unconstrained.

So the two run together, and each does what it is actually better at:

  RULES win on syntax      @handles, "last 30 days", "top 20", platforms.
                           A regex reads these exactly; a model paraphrases
                           them and sometimes rounds "last 45 days" to a month.

  THE MODEL wins on meaning  topics and targets that are implied rather than
                             named, and sentiment expressed obliquely
                             ("people are furious about").

The model is called ONLY when rules left the question underconstrained, so the
common path stays at zero tokens. Its output is merged, never trusted wholesale:
a field the rules established is not overwritten, and anything the model invents
outside the known vocabularies is dropped rather than queried.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Callable, Dict, List, Optional

import planner
import vocabulary
from retriever import QuerySpec

logger = logging.getLogger(__name__)

# Small budget: the reply is a short JSON object. On a bandwidth-bound box
# every token costs, and a planner that thinks out loud is a planner that times
# out.
MAX_TOKENS = 220


def _schema_block() -> str:
    topics = ", ".join(sorted(vocabulary.TOPICS))
    targets = ", ".join(sorted(vocabulary.TARGETS))
    return f"""\
Return ONLY a JSON object. No explanation, no markdown fences, no thinking.

Fields (omit any that do not apply — omission means "no constraint"):
  sentiment  "negative" | "positive" | "neutral"
  topics     array from: {topics}
  targets    array from: {targets}
  kinds      array from: alert, grievance, content
  platforms  array from: x, facebook, instagram, youtube, whatsapp
  sort       "risk" | "recent" | "relevance"

Rules:
- targets is WHO the post is about, not whether it is for or against.
  "posts attacking BJP" and "posts praising BJP" both have targets ["bjp"].
  Opposition is expressed by sentiment, not by targets.
- Only use values from the lists above. If the subject is not in the list,
  omit the field rather than inventing a value.
- Omit a field you are unsure about. A missing filter returns more records;
  a wrong one silently hides the answer."""


EXAMPLES = [
    ("posts criticising how officers behave at checkposts",
     '{"sentiment":"negative","targets":["police"]}'),
    ("what are people saying about bribes in the revenue office",
     '{"topics":["corruption"],"targets":["government"]}'),
    ("anything alarming today",
     '{"sort":"risk"}'),
    ("show me chain snatching incidents",
     '{"topics":["robbery"]}'),
    ("citizens praising the traffic police",
     '{"sentiment":"positive","targets":["police"],"topics":["traffic"]}'),
]


def build_prompt(question: str) -> str:
    shots = "\n".join(f"Q: {q}\nA: {a}" for q, a in EXAMPLES)
    return f"{_schema_block()}\n\n{shots}\n\nQ: {question}\nA:"


_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S)
_OBJECT = re.compile(r"\{.*\}", re.S)


def parse(raw: str) -> dict:
    """Pull a JSON object out of whatever the model returned.

    Small models wrap JSON in fences, prefix it with "Here is", or emit a
    thinking block first. None of that is worth a retry when the object itself
    is recoverable.
    """
    if not raw:
        return {}
    text = raw.strip()

    fenced = _FENCE.search(text)
    if fenced:
        text = fenced.group(1)

    match = _OBJECT.search(text)
    if not match:
        return {}
    try:
        got = json.loads(match.group(0))
        return got if isinstance(got, dict) else {}
    except json.JSONDecodeError:
        logger.info("planner: unparseable JSON from model: %r", raw[:160])
        return {}


def _clean_list(values, allowed: set) -> List[str]:
    """Keep only values the database can actually filter on.

    A model asked for topics will happily answer "police_brutality". Querying an
    unknown tag returns nothing, which reads to the officer as "no such posts"
    rather than "I made that category up".
    """
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, list):
        return []
    out = []
    for v in values:
        key = str(v).strip().lower().replace(" ", "_")
        if key in allowed and key not in out:
            out.append(key)
    return out


def enrich(spec: QuerySpec, data: dict) -> QuerySpec:
    """Merge model output into a rule-built spec, without overwriting it.

    Rules are authoritative for anything they matched: they read an explicit
    handle or date exactly, and a model that paraphrases one is a regression.
    The model only fills gaps.
    """
    if not data:
        return spec

    if not spec.sentiment:
        s = str(data.get("sentiment", "")).strip().lower()
        if s in ("negative", "positive", "neutral"):
            spec.sentiment = s

    if not spec.topics:
        spec.topics = _clean_list(data.get("topics"), set(vocabulary.TOPICS))
    if not spec.targets:
        spec.targets = _clean_list(data.get("targets"), set(vocabulary.TARGETS))
    if not spec.kinds:
        spec.kinds = _clean_list(data.get("kinds"), {"alert", "grievance", "content"})
    if not spec.platforms:
        spec.platforms = _clean_list(
            data.get("platforms"), {"x", "facebook", "instagram", "youtube", "whatsapp"})

    if spec.sort == "relevance":
        srt = str(data.get("sort", "")).strip().lower()
        if srt in ("risk", "recent", "relevance"):
            spec.sort = srt

    return spec


def plan(question: str, generate: Optional[Callable] = None,
         topic_map: Dict[str, str] = None,
         target_map: Dict[str, str] = None) -> QuerySpec:
    """A QuerySpec for *question*, using the model only when rules fall short.

    ``generate`` is a callable taking (prompt, max_tokens) and returning text.
    It is injected so this module needs no knowledge of the LLM endpoint, and
    so the merge logic is testable without one.
    """
    spec = planner.plan(question, topic_map=topic_map, target_map=target_map)

    # Rules covered it: an explicit handle, a date, a risk sort, a named topic.
    # Calling the model here would add latency and could only do harm.
    if spec.is_filtered() or not generate:
        return spec

    try:
        raw = generate(build_prompt(question), MAX_TOKENS)
    except Exception as exc:
        # An unreachable model must degrade to lexical and semantic retrieval,
        # not to an error: an unfiltered answer is worse than a narrow one, but
        # both beat a failure.
        logger.warning("planner model unavailable, continuing unfiltered: %s", exc)
        return spec

    return enrich(spec, parse(raw))
