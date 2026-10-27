"""
llm.py — the model's reading of a question, bounded hard.

Called only when the rules leave something material unsettled. It is asked for
a small, closed-vocabulary object and nothing else: no prose, no tool names, no
tenant, no district authorisation, no answer.

Three bounds that matter:

  * ONE REPAIR, THEN STOP. A malformed reply gets exactly one repair attempt
    with the error quoted back. After that the planner degrades to the rule
    result. There is no retry loop; an endpoint that is confidently wrong
    twice will be wrong a third time, and the officer is waiting.

  * VALUES OUTSIDE THE VOCABULARY ARE DROPPED, not queried. A model asked for a
    topic will happily answer "police_brutality"; filtering on a tag nothing
    carries returns zero rows, which reads as "there is nothing" rather than
    "I invented that category".

  * IT NEVER NAMES A TOOL. Needs come from intent, tools come from needs. The
    model has no say in what gets executed.

The shared llm_client is reused rather than a second Ollama client being
introduced. It exposes temperature but not seed, so determinism here is
temperature=0 only — recorded rather than claimed otherwise.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Callable, Optional, Tuple

import vocabulary

from .models import Intent, Shape

logger = logging.getLogger("query_understanding.llm")

PROMPT_VERSION = "qu-plan@v2"
MAX_TOKENS = 320
TEMPERATURE = 0.0

_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S)
_OBJECT = re.compile(r"\{.*\}", re.S)

_INTENTS = [i.value for i in Intent]
#: What the officer wants DONE with the records, as distinct from the intent's
#: execution shape. Kept small: each maps onto work the pipeline already does.
_OPERATIONS = ["retrieve", "count", "summarise", "investigate", "rank",
               "distribute", "relate", "compare"]
#: How much reading the question deserves. The analysis engine still owns the
#: population SIZES; this only says which band the question falls in.
_DEPTHS = ["minimal", "search", "ranked", "deep"]
_RECENCY = ["today", "recent", "week", "month", "all_time"]
_SHAPES = [s.value for s in Shape]


def build_prompt(question: str, rule_summary: str) -> str:
    """Ask the model what KIND of question this is — never what the answer is.

    The previous version listed the intent enum by name and told the model that
    anything it did not recognise belonged in "concepts". That taught it the
    wrong job: an unfamiliar PHRASING became an unknown SUBJECT, so "Which
    areas are seeing more activity?" came back as intent=unknown_concept with
    the concept "areas seeing more activity". Every intent is now described by
    what the officer wants done, and the frame/subject distinction is stated
    first, because getting that wrong is what made the assistant feel like a
    keyword search.
    """
    topics = ", ".join(sorted(vocabulary.TOPICS))
    targets = ", ".join(sorted(vocabulary.TARGETS))
    return f"""You read a police intelligence officer's question and describe WHAT KIND OF QUESTION IT IS. You never answer it, never search, and never name a tool.

Return ONLY a JSON object. No prose, no markdown fences, no thinking.

THE DISTINCTION THAT MATTERS MOST
Every question has a FRAME (what is being asked) and sometimes a SUBJECT
(what it is about).
  "What is happening in Hyderabad?"    frame: what is happening. subject: none.
  "How many grievances are there?"     frame: how many.          subject: grievances.
  "Which areas have more activity?"    frame: where is it most.  subject: none.
Frame words are NEVER a subject. what, where, which, who, why, how, happening,
going on, driving, important, attention, activity, changed, involved, talking
about, unusual, serious, emerging, developments — all frame. So are the words
that point without naming: this, that, these, those, it, here, there, same.
A subject is a thing the records could be tagged with: a topic, a person, an
organisation, a place, a named event. If the question has only a frame, return
"concepts": [].

INTENT — pick by what the officer wants done:
  aggregation        counting, ranking, or WHERE/WHICH has the most. Asking
                     where something is GREATEST is a distribution and belongs
                     here, never in situation_analysis.
                     how many X | which areas have more | where is this
                     concentrated | where is it getting more attention |
                     ekkada ekkuva undi
  filtered_search    show me records matching something.
                     show me X | give me the important ones | anything about X
  situation_analysis WHAT is going on, what should I know, is anything serious.
                     Use it for WHAT is happening — never for WHERE it is most.
                     what's happening | anything unusual | what are people talking
                     about | what's driving this | any major developments |
                     tell me what's important here
  trend_analysis     has it changed, is it rising, what changed.
  comparison         one scope against another.
  lookup             fetch particular or related records. show me related posts
  unknown_concept    ONLY when the question NAMES a specific thing that is not a
                     known topic or target, e.g. "posts about the Osman Sagar dam".
                     NEVER because the WORDING is unfamiliar to you.
  follow_up          cannot be understood without the previous question.
                     how many are there | what about Mulugu | has this increased
  conversational     ONLY a greeting or "what can you do".

ROMANISED TELUGU / TENGLISH — read the meaning, do not transliterate:
  lo = in | em, emi, emaina = what, any | jarugutundi, jarigindi, nadustundhi,
  jaruguthundi = is happening, happened | ekkada = where | ekkuva = more, most |
  undi, unnayi, unda = is there, are there | chupinchu = show me |
  sambandhinchina = related to | recent ga = recently | muchyamaina, important vi
  = the important ones | enti = what is
  So "Hyderabad lo em nadustundhi?" is situation_analysis about Hyderabad, and
  "Ekkada ekkuva undi?" is aggregation asking where it is greatest.

Fields (omit any you are unsure of; omission means "no opinion"):
  intent      one of: {", ".join(_INTENTS)}
  operation   one of: {", ".join(_OPERATIONS)}
  depth       how much reading the question deserves, one of: {", ".join(_DEPTHS)}
              minimal = a number answers it. search = show matching records.
              ranked = pick out the notable ones. deep = read broadly and explain.
  recency     one of: {", ".join(_RECENCY)} — only if the question implies a period
  sentiment   "negative" | "positive" | "neutral"
  topics      array from: {topics}
  targets     array from: {targets}
  concepts    named subjects NOT in the lists above. Frame words are not subjects.
  location    a place the question names, as written
  group_by    one of: handle, platform, districts, topics, category, sentiment, risk_level
  metric      "count" | "average" | "share"
  confidence  0.0-1.0, how sure you are of the intent
  ambiguities array of {{"field": "...", "reason": "..."}} when the question could
              reasonably be read more than one way

Rules:
- Only use values from the lists. An unlisted subject goes in "concepts".
- A question built ONLY from frame words has no subject at all. Choose
  follow_up if it leans on an earlier question ("who is involved?", "what
  changed?", "where is this concentrated?"), otherwise the intent its frame
  asks for. Such a question is NEVER unknown_concept — there is no concept
  in it to be unknown.
- targets is WHO the text is about, not whether it is for or against.
- Never output tool names, tenant ids, district permissions, or an answer.
- Never invent a location, a person or a date the question does not contain.

Rules already established (do not contradict, do not repeat):
{rule_summary}

QUESTION: {question}
JSON:"""


def parse(raw: str) -> dict:
    """Pull a JSON object out of whatever came back."""
    if not raw or raw.startswith("_("):      # llm_client's failure marker
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
        return {}


def clean(data: dict) -> dict:
    """Keep only what the vocabulary allows; drop the rest silently but count it."""
    if not data:
        return {}
    out: dict = {"_dropped": []}

    def _enum(field: str, allowed: list):
        value = str(data.get(field, "")).strip().lower()
        if value in allowed:
            out[field] = value
        elif value:
            out["_dropped"].append(f"{field}={value}")

    _enum("intent", _INTENTS)
    _enum("shape", _SHAPES)
    _enum("sentiment", ["negative", "positive", "neutral"])
    _enum("group_by", ["handle", "platform", "districts", "topics", "category",
                       "sentiment", "risk_level"])
    _enum("metric", ["count", "average", "share"])
    _enum("operation", _OPERATIONS)
    _enum("depth", _DEPTHS)
    _enum("recency", _RECENCY)

    # A number the model states about ITS OWN reading, not about the world.
    try:
        conf = float(data.get("confidence"))
        if 0.0 <= conf <= 1.0:
            out["confidence"] = round(conf, 3)
    except (TypeError, ValueError):
        pass

    for field, allowed in (("topics", set(vocabulary.TOPICS)),
                           ("targets", set(vocabulary.TARGETS))):
        values = data.get(field)
        if isinstance(values, str):
            values = [values]
        kept = []
        for value in values or []:
            key = str(value).strip().lower().replace(" ", "_")
            if key in allowed:
                kept.append(key)
            elif key:
                out["_dropped"].append(f"{field}={key}")
        if kept:
            out[field] = kept

    concepts = data.get("concepts")
    if isinstance(concepts, str):
        concepts = [concepts]
    kept_concepts = [str(c).strip()[:60] for c in (concepts or [])
                     if str(c).strip() and len(str(c).strip()) > 1][:5]
    if kept_concepts:
        out["concepts"] = kept_concepts

    location = data.get("location")
    if isinstance(location, str) and 1 < len(location.strip()) <= 60:
        out["location"] = location.strip()

    ambiguities = []
    for item in data.get("ambiguities") or []:
        if isinstance(item, dict) and item.get("field") and item.get("reason"):
            ambiguities.append({"field": str(item["field"])[:40],
                                "reason": str(item["reason"])[:200]})
    if ambiguities:
        out["ambiguities"] = ambiguities[:4]

    # Anything the model tried to say about tools or tenancy is not merely
    # ignored — it is recorded, because a model reaching for them is a signal.
    for forbidden in ("required_tools", "tools", "tenant_id", "tenant", "districts_allowed"):
        if forbidden in data:
            out["_dropped"].append(f"forbidden:{forbidden}")
    return out


def plan(question: str, rule_summary: str,
         generate: Optional[Callable] = None) -> Tuple[dict, dict]:
    """(cleaned fields, telemetry). Never raises."""
    telemetry = {"llm_used": False, "llm_ms": 0.0, "attempts": 0,
                 "prompt_version": PROMPT_VERSION, "error": None, "dropped": []}
    if not generate:
        return {}, telemetry

    started = time.perf_counter()
    prompt = build_prompt(question, rule_summary)
    raw = ""
    for attempt in (1, 2):
        telemetry["attempts"] = attempt
        try:
            raw = generate(prompt, MAX_TOKENS, TEMPERATURE)
        except Exception as exc:
            telemetry["error"] = f"{type(exc).__name__}: {exc}"[:160]
            break
        data = parse(raw)
        if data:
            cleaned = clean(data)
            telemetry.update(llm_used=True,
                             llm_ms=round((time.perf_counter() - started) * 1000, 1),
                             dropped=cleaned.pop("_dropped", []))
            return cleaned, telemetry
        if attempt == 1:
            # One repair, quoting what came back. Then we stop.
            prompt = (f"{prompt}\n\nYour previous reply was not valid JSON:\n"
                      f"{(raw or '')[:200]}\nReturn only the JSON object.")
            logger.info("query understanding: repairing malformed planner reply")

    telemetry.update(llm_ms=round((time.perf_counter() - started) * 1000, 1),
                     error=telemetry["error"] or "unparseable-json")
    return {}, telemetry
