"""
respond.py — verified evidence -> an answer an officer can check.

Two writers, one rulebook:

  TEMPLATE  deterministic sentences built from evidence facts. Always
            available; used when no model is configured, when the model is
            down, and whenever the model's draft fails the claim check.
  LLM       optional synthesis over the SAME evidence (never raw database
            access). Its draft is claim-checked sentence by sentence:
              - every [E#] it cites must exist in the evidence list
              - every number it states must appear in the evidence facts
            A sentence failing either is removed and counted. If more than a
            third of the draft fails, the whole draft is discarded for the
            template: a mostly-wrong summary is worse than a plain one.

Numbers are never produced by the model: a count in the answer is the count
the database returned.
"""

from __future__ import annotations

import re
from typing import Callable, Dict, List, Optional, Tuple

from query_understanding.models import Intent, QueryPlan, TimeKind

from .models import (AssistantResponse, Citation, Evidence, ExecutionPlan,
                     VerificationReport)

PROMPT_VERSION = "respond@v2"   # v2: semantic guards - records are not incidents
_CITE = re.compile(r"\[(E\d+)\]")
_NUM = re.compile(r"(?<![\w.])[-+]?\d+(?:[.,]\d+)?%?")
_SENT = re.compile(r"(?<=[.!?])\s+|\n+")
_ENUM = re.compile(r"(?m)^\s*\d{1,3}[.)]\s+")


def _label(value) -> str:
    """A stored label in the words it is read in.

    `women_safety` and `risk_level` are column spellings. They reached the
    officer unchanged in both the template and the model's prose, because the
    model copies a label exactly as it is handed one. Only the separator
    changes -- no renaming, so a label stays traceable to its row.
    """
    return str(value if value is not None else "").replace("_", " ")


def _public_ev(ev: Evidence) -> dict:
    """What leaves the service. No tenant, no internal provenance."""
    return {"id": ev.evidence_id, "type": ev.source_type, "content": ev.content[:400],
            "facts": ev.facts, "url": ev.url, "timestamp": ev.timestamp,
            "districts": ev.districts, "confidence": ev.confidence, "tool": ev.tool.value}


def _numbers(evidence: List[Evidence]) -> set:
    out: set = set()

    def walk(v):
        if isinstance(v, bool):
            return
        if isinstance(v, (int, float)):
            out.add(float(v))
            out.add(float(abs(v)))
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, (list, tuple)):
            for x in v:
                walk(x)
        elif isinstance(v, str):
            for m in _NUM.findall(v):
                try:
                    out.add(float(m.rstrip("%").replace(",", "")))
                except ValueError:
                    pass
    for ev in evidence:
        walk(ev.facts)
        walk(ev.content)
    return out


def _row_values(ev: Evidence) -> set:
    """The labels a breakdown actually contains, matchable as written.

    Stored labels are database spellings -- "women_safety" -- while an answer
    an officer reads says "women safety". Both forms are accepted so that
    writing it properly is not treated as inventing it.
    """
    out = set()
    for r in (ev.facts.get("rows") or []):
        raw = r.get("value", r.get("bucket"))
        if raw is None:
            continue
        s = str(raw).strip().lower()
        if s:
            out.add(s)
            out.add(s.replace("_", " "))
    return out


#: A sentence naming three or more things: "a, b and c". This is the shape the
#: model uses when it reports what a breakdown contains, and the shape it used
#: when it reported contents that were not in the breakdown.
_LISTING = re.compile(r"[^,;:]+,[^,;:]+(?:,|\s+and\s+)", re.I)

#: A time window stated in the prose. The model must not name one that is not
#: the plan's own -- the worked example's "in the last 7 days" was reproduced
#: verbatim over an all-time count.
#
# The preposition is optional because this runs over two different strings:
# a sentence ("...in the last 7 days") and the scope _scope() produces
# ("the last 7 days"). Requiring it matched the first and missed the second,
# so a window the plan HAD set was struck out as invented.
_WINDOW = re.compile(
    r"(?:\b(?:in|over|during|within|for)\s+)?\bthe\s+(?:last|past|previous)\s+"
    r"[\w-]+\s+(?:hour|day|week|month|year)s?\b"
    r"|\b(?:today|yesterday|this week|last week|this month|last month"
    r"|this year|last year)\b", re.I)


def check_claims(text: str, evidence: List[Evidence], question: str = "",
                 scope: Optional[str] = None) -> Tuple[str, int]:
    """(cleaned text, sentences removed).

    A number is checked against the evidence the SENTENCE CITES, not against
    every number anywhere in the evidence set. Under the looser rule a theme
    that appeared in 19 posts licensed the sentence "There are 19 negative
    posts", because 19 existed somewhere -- the count beside it was 716. Every
    figure was real; the sentence was false.
    """
    by_id = {e.evidence_id: e for e in evidence}
    # Numbers the question itself supplies ("top 5", "last 30 days") are the
    # officer's own and need no evidence.
    # The scope's own figure belongs to the plan, not to any evidence item:
    # "the last 7 days" has a 7 in it that no fact needs to supply.
    from_question = {float(n.rstrip("%").replace(",", ""))
                     for n in _NUM.findall((question or "") + " " + (scope or ""))}
    global_numbers = _numbers(evidence) | from_question
    kept, removed = [], 0
    # A numbered list's "2." is layout, not a claim; it is removed before
    # numbers are checked. Numbers INSIDE the line are still checked.
    text = _ENUM.sub("", text or "")
    for sent in _SENT.split(text.strip()):
        if not sent.strip():
            continue
        cites = _CITE.findall(sent)
        if any(c not in by_id for c in cites):
            removed += 1
            continue
        cited = [by_id[c] for c in cites]
        nums = []
        for n in _NUM.findall(_CITE.sub("", sent)):
            try:
                nums.append(float(n.rstrip("%").replace(",", "")))
            except ValueError:
                pass
        # Numbers must come from what this sentence points at. With nothing
        # cited there is nothing to point at, so the looser whole-set check
        # applies and the sentence may not carry a figure of its own.
        allowed = _numbers(cited) | from_question if cited else global_numbers
        if any(n not in allowed for n in nums):
            removed += 1
            continue
        # A window the plan did not set is invented, however plausible.
        if scope and _WINDOW.search(sent) and not _WINDOW.search(scope):
            removed += 1
            continue
        # A sentence that lists what a breakdown contains must name something
        # the breakdown actually contains.
        tables = [e for e in cited if e.facts.get("rows")]
        if tables and _LISTING.search(sent):
            low = sent.lower()
            if not any(v in low for e in tables for v in _row_values(e)):
                removed += 1
                continue
        kept.append(sent)
    return " ".join(kept).strip(), removed


# --------------------------------------------------------------------------- #
# template
# --------------------------------------------------------------------------- #

def _records(evidence):
    return [e for e in evidence if e.source_type in ("record", "verdict")]


def _line(e: Evidence) -> str:
    f = e.facts
    who = f"@{f['handle']}" if f.get("handle") else (f.get("kind") or "record")
    when = (f.get("published_at") or e.timestamp or "")[:10]
    bits = [who, f.get("platform"), when]
    head = " · ".join(b for b in bits if b)
    extra = f" — labelled {', '.join(f['labels'])}" if f.get("labels") else ""
    return f"{head}: {e.content[:160].strip()}{extra} [{e.evidence_id}]"


_SCOPE_WORDS = {
    TimeKind.ALL_TIME: "all time",
    TimeKind.TODAY: "today",
    TimeKind.YESTERDAY: "yesterday",
    TimeKind.THIS_WEEK: "this week",
    TimeKind.LAST_WEEK: "last week",
    TimeKind.THIS_MONTH: "this month",
    TimeKind.LAST_MONTH: "last month",
    TimeKind.THIS_YEAR: "this year",
}
_SCOPE_UNITS = {
    TimeKind.LAST_N_HOURS: "hour",
    TimeKind.LAST_N_DAYS: "day",
    TimeKind.LAST_N_WEEKS: "week",
    TimeKind.LAST_N_MONTHS: "month",
}


def _scope(plan: QueryPlan) -> Optional[str]:
    """The period an answer covers, in plain words.

    A count is read as the whole truth unless the window is stated, and the
    window is often one the question never named -- "recent" becomes seven
    days, a follow-up inherits last turn's month. Returns None when the range
    cannot be described, so nothing misleading is printed.
    """
    tr = plan.time_range
    if tr.kind in _SCOPE_WORDS:
        return _SCOPE_WORDS[tr.kind]
    if tr.kind in _SCOPE_UNITS and tr.n:
        unit = _SCOPE_UNITS[tr.kind]
        return f"the last {tr.n} {unit}" if tr.n == 1 else f"the last {tr.n} {unit}s"
    day = "%d %b %Y"
    if tr.kind is TimeKind.CUSTOM_RANGE and tr.start and tr.end:
        return f"{tr.start.strftime(day)} to {tr.end.strftime(day)}"
    if tr.kind is TimeKind.SINCE and tr.start:
        return f"since {tr.start.strftime(day)}"
    if tr.kind is TimeKind.AFTER and tr.start:
        return f"after {tr.start.strftime(day)}"
    if tr.kind is TimeKind.BEFORE and tr.end:
        return f"before {tr.end.strftime(day)}"
    return None


#: What each kind of request is called in a multi-part answer. Derived from
#: the sub-question's INTENT, never from its words: echoing "what are people
#: saying" back as a line of the answer reads as a claim the evidence does not
#: make, and the claim checker was right to strike it.
_SECTION_LABEL = {
    Intent.AGGREGATION: "Count",
    Intent.LOOKUP: "Matching records",
    Intent.FILTERED_SEARCH: "Matching activity",
    Intent.SITUATION_ANALYSIS: "What is being discussed",
    Intent.TREND_ANALYSIS: "Change over time",
    Intent.COMPARISON: "Side by side",
    Intent.CLASSIFICATION: "Classification",
    Intent.UNKNOWN_CONCEPT: "Matching activity",
}


def _heading(sub) -> str:
    """A short label for one request inside a multi-part answer."""
    if getattr(sub, "group_by", None):
        return "Distribution"
    return _SECTION_LABEL.get(getattr(sub, "intent", None), "Findings")


def _describe(plan: QueryPlan, evidence: List[Evidence], report: VerificationReport,
              scope: str, say_examined: bool = True) -> List[str]:
    """The measured sentences for ONE request's evidence.

    `say_examined` is off for a section of a multi-part answer: how many
    records were read is a fact about the ANSWER, and stating it per section
    produced a per-section number that nothing in the evidence supports.
    """
    parts: List[str] = []
    total = next((e for e in evidence if e.source_type == "aggregate" and "total" in e.facts), None)
    trend = next((e for e in evidence if e.source_type == "trend"), None)
    cmp_ = next((e for e in evidence if e.source_type == "comparison"), None)
    counts = next((e for e in evidence if e.source_type == "aggregate" and "counts" in e.facts), None)
    sit = next((e for e in evidence if e.source_type == "situation"), None)
    scope = _scope(plan)
    if report.sufficiency == "empty":
        where = f" in {scope}" if scope else " in the requested period"
        stale = _staleness_note(evidence)
        return (f"No matching records were found within your scope{where}"
                + (f" [{total.evidence_id}]." if total else ".")
                + (f" {stale}" if stale else ""))
    # How many records were actually read, as opposed to how many matched. A
    # population printed next to nine posts reads as though all of them were
    # examined, which is the difference between a count and an investigation.
    examined = len(_records(evidence))
    if sit:
        parts += [f"{o} [{sit.evidence_id}]" for o in sit.facts.get("observations", [])]
        matched = (total.facts.get("total") if total else None)
        if examined and say_examined:
            of_pop = (f" of {matched} matching" if isinstance(matched, int)
                      and matched > examined else "")
            parts.append(f"{examined} record(s){of_pop} were examined as evidence"
                         f"{'; the most relevant are listed below.' if examined else '.'}")
    elif total:
        suffix = f" — {scope}" if scope else ""
        n = total.facts["total"]
        if n == 0 and examined:
            # The count and the records disagree: nothing matches these filters
            # exactly, yet retrieval found something close enough to survive
            # verification. Printing "0 matching record(s)" above a list of
            # posts reads as a broken answer, so say which it is.
            parts.append(f"No records match these filters exactly{suffix} "
                         f"[{total.evidence_id}]. The {examined} closest by search "
                         f"are below — check them against what you asked for.")
        else:
            parts.append(f"{n} matching record(s){suffix} [{total.evidence_id}].")
        if n == 0:
            stale = _staleness_note(evidence)
            if stale:
                parts.append(stale)
        if examined and say_examined and isinstance(n, int) and n > examined:
            parts.append(f"{examined} of them examined as evidence below.")
    for e in evidence:
        if e.source_type == "aggregate" and "rows" in e.facts and not sit:
            rows = e.facts["rows"][:5]
            if rows:
                key = "value" if "value" in rows[0] else "bucket"
                # Column spelling is not reading spelling: "By risk_level:
                # women_safety" is the database describing itself.
                parts.append(f"By {_label(e.facts['group_by'])}: " + ", ".join(
                    f"{_label(r[key])} ({r['count']})" for r in rows) + f" [{e.evidence_id}].")
    if trend and not sit:
        f = trend.facts
        if f.get("change_pct") is None:
            pct = "no percentage change can be stated (none in the previous window)"
        elif f.get("comparable") is False:
            # 6,522 against 24 is "+27075%": arithmetically right, and it reads
            # as a broken gauge rather than as activity.
            pct = f"too few in the previous window ({f['previous']}) to state a percentage"
        else:
            pct = f"{f['change_pct']:+}%"
        parts.append(f"{f['current']} in the last {f['days']} day(s) against {f['previous']} in "
                     f"the {f['days']} before — {f['direction']}, {pct} [{trend.evidence_id}].")
        if f.get("latest_available"):
            parts.append(f"Both windows are empty; the most recent record in your "
                         f"scope is from {str(f['latest_available'])[:10]}, so the "
                         f"data may not be current.")
    if cmp_:
        sides = cmp_.facts["sides"]
        parts.append(" vs ".join(f"{s['label']}: {s['count']}" for s in sides)
                     + f" [{cmp_.evidence_id}].")
    if counts:
        c = counts.facts.get("counts") or {}
        if c:
            parts.append("Of " + str(counts.facts.get("checked") or 0) + " record(s) checked: "
                         + ", ".join(f"{k} {v}" for k, v in c.items())
                         + f" [{counts.evidence_id}].")
        if counts.facts.get("verified") is False:
            parts.append("The AI judge was unavailable; the records below are closest by search "
                         "and are NOT verified.")
    return parts


def _staleness_note(evidence) -> Optional[str]:
    """"Nothing in the last 7 days" plus the date of the newest record there is.

    Measured on the live corpus: the newest grievance was four weeks old, so
    every situation and trend question answered "0 matching records in the last
    7 day(s)" — correct, and indistinguishable from a broken assistant. Naming
    the newest record tells the officer the period is empty, not the system.
    """
    for e in evidence:
        latest = e.facts.get("latest_available") if e.facts else None
        if latest:
            day = str(latest)[:10]
            return (f"No records fall in that period. The most recent record in "
                    f"your scope is from {day}, so the data may not be current.")
    return None


def template(plan: QueryPlan, evidence: List[Evidence], report: VerificationReport) -> str:
    scope = _scope(plan)
    total0 = next((e for e in evidence
                   if e.source_type == "aggregate" and "total" in e.facts), None)
    if report.sufficiency == "empty":
        where = f" in {scope}" if scope else " in the requested period"
        stale = _staleness_note(evidence)
        return (f"No matching records were found within your scope{where}"
                + (f" [{total0.evidence_id}]." if total0 else ".")
                + (f" {stale}" if stale else ""))

    parts: List[str] = []
    subs = list(getattr(plan, "sub_questions", None) or [])
    if plan.intent is Intent.MULTI_PART and subs:
        # Each request keeps its own section. Merging two answers into one
        # paragraph loses which figure answered which question, and the
        # officer asked two things precisely because they are two things.
        # Steps are compiled with a q<index>. prefix, so the evidence for
        # each request is identifiable without guessing.
        for sub in subs:
            own = [e for e in evidence
                   if str(getattr(e, "step_id", "") or "").startswith(f"q{sub.index}.")]
            said = _describe(plan, own, report, scope, say_examined=False) if own else []
            if said:
                parts.append(_heading(sub))
                parts += said
        if parts:
            # Stated once, for the answer as a whole.
            shown = len(_records(evidence))
            if shown:
                parts.append(f"{shown} record(s) were examined as evidence; "
                             "the most relevant are listed below.")
    if not parts:
        parts = _describe(plan, evidence, report, scope)
    recs = _records(evidence)[:10]
    if recs:
        parts.append("\n".join(f"{i + 1}. {_line(e)}" for i, e in enumerate(recs)))
    return "\n".join(parts) if parts else "The results could not be summarised."


# --------------------------------------------------------------------------- #
# the response
# --------------------------------------------------------------------------- #

# The model reads counts and labels and reaches for the dramatic reading: a
# volume of posts becomes a wave of incidents, a monitoring district becomes a
# crime scene, "murder" as a topic becomes a murder. Each line below blocks one
# of those inferences, because an officer acting on the wrong one acts on a
# situation that does not exist.
_SYNTHESIS_PROMPT = """You are the AI Assistant, writing for a police officer.

WHAT THE EVIDENCE IS — read before writing:
- A "record" is one monitored social-media post. A record count counts POSTS,
  never incidents, victims, arrests or events.
- risk_level=high is a classifier's label on the text of a post. It is not
  proof that anything happened.
- A district is the monitoring scope a post was captured under. It is NOT
  evidence that the post describes something happening in that district.
- A topic count is how many posts mention a theme. It is not a count of
  distinct incidents or situations.
- A trend is a change in the volume of posts, not a change in real events.

RULES:
1. Ground every statement in the evidence below and cite it like [E3].
2. Copy numbers exactly from the evidence. Never compute or estimate one.
3. Never call a place an issue, a problem or a risk. A place is where content
   was monitored, not the subject of the answer.
4. Do not say a serious incident is occurring unless specific evidence
   describes one. High volume, a high-risk label, a rising trend, and topics
   such as murder, women safety or protest are NOT that evidence.
5. Keep these apart: (a) observed content activity, (b) recurring themes,
   (c) distinct situations, (d) what a specific post states.
6. If the evidence establishes only activity and themes, say exactly that.
7. Describe a distinct situation only where specific posts support it, and
   cite them. If none are identifiable, say the evidence shows recurring
   themes rather than confirmed situations. Never manufacture situations.
8. If the matching content is broad, national or off-topic, state that as a
   limitation instead of treating every record as a local incident.
9. Never invent a location, cause, victim, actor, timeline or relationship.
10. No speculation about intent or guilt.

PHRASING — follow the SHAPE of these forms, never their contents. Every
<angle-bracketed> slot must be filled from the evidence below, and the period
must be the one given under SCOPE:
  "The monitored scope contains <total> <measure> <scope> [E<n>]."
  "The largest observed <facet> groups are <value>, <value> and <value> [E<n>]."
  "This indicates increased content activity; the record volume is not a count
   of distinct incidents [E<n>]."

Do not carry any qualifier across from these forms. In particular, do not call
records "high-risk" unless a fact says risk_level=high, and do not name a time
window other than the one under SCOPE.

Write 3-6 sentences. Plain, precise, no filler.

"""


#: Appended on the second attempt. Names the three ways the first draft is
#: rejected, in the order they actually occur.
_RETRY_NOTE = """

The previous draft was rejected. Rewrite it, and this time:
- use ONLY figures that appear in the evidence item you cite in that same
  sentence; do not take a figure from one item and cite another;
- name the period exactly as SCOPE gives it, or do not mention a period;
- when you say what a breakdown contains, name the values listed under its
  `rows`, spelled as they appear there.

ANSWER:"""


def _render_rows(facts: dict) -> str:
    """A breakdown's own values, in the model's view of the evidence.

    These used to be stripped out of the prompt while the template printed
    them, so the model was asked to describe a grouping it had never been
    shown. It did what a model does with a named-but-unseen list: it invented
    one. "The largest observed topic groups are complaints, criticism, and
    requests for accountability" against real rows of murder, women_safety and
    protest -- every number in the answer correct, every label fabricated.
    """
    rows = facts.get("rows") or []
    if not rows:
        return ""
    key = "value" if rows and "value" in rows[0] else "bucket"
    # Shown in reading spelling, not column spelling. The model copies a label
    # exactly as it is given, so handing it "women_safety" put the underscore
    # in the sentence an officer reads. check_claims accepts either form.
    shown = ", ".join(f"{_label(r.get(key))}={r.get('count')}" for r in rows[:10])
    more = f" (+{len(rows) - 10} more)" if len(rows) > 10 else ""
    return f" | rows: {shown}{more}"


def _prompt(question: str, evidence: List[Evidence], scope: Optional[str] = None) -> str:
    # Analysis first, records second. The situation summary is appended after
    # verification so it sorts last, and a flat head-30 slice would drop the
    # aggregate, trend and situation facts in favour of thirty posts -- leaving
    # the model to describe a situation it was never shown.
    analysis = [e for e in evidence if e.source_type != "record"]
    records = [e for e in evidence if e.source_type == "record"]
    rows = []
    for e in (analysis + records)[:30]:
        plain = {k: v for k, v in e.facts.items() if k != "rows"}
        rows.append(f"[{e.evidence_id}] {e.source_type}: {e.content[:300]} | facts: "
                    f"{plain}{_render_rows(e.facts)}")
    # The period is a property of the PLAN, not of any one evidence item, so
    # without it stated the model reached for the one in the worked example and
    # wrote "in the last 7 days" over an all-time count.
    head = f"SCOPE: this answer covers {scope}.\n\n" if scope else ""
    return (_SYNTHESIS_PROMPT + head
            + f"QUESTION: {question}\n\nEVIDENCE:\n" + "\n".join(rows) + "\n\nANSWER:")


def build(*, request_id: str, qplan: QueryPlan, eplan: ExecutionPlan, evidence: List[Evidence],
          report: VerificationReport, degraded: bool, limitations: List[str],
          generate: Optional[Callable] = None, synthesize: bool = False) -> AssistantResponse:
    # How many records were actually read is a fact about this evidence set, so
    # it is recorded as one. Stating it without backing would make the answer
    # carry a number no evidence holds, and the claim check would be right to
    # strip it. Counted after verification, so removed records are not counted.
    examined = len(_records(evidence))
    if examined:
        for e in evidence:
            if e.source_type == "aggregate" and "total" in e.facts:
                e.facts.setdefault("examined", examined)
    text = template(qplan, evidence, report)
    generated_by, interpretation, removed = "template", None, 0
    if synthesize and generate and evidence and report.sufficiency != "empty":
        scope = _scope(qplan)
        prompt = _prompt(qplan.raw_query, evidence, scope)
        try:
            # Two attempts, because the model's own answer is what the officer
            # reads first and falling back to the count template loses it
            # entirely. The second attempt is told what was struck out and why,
            # which is cheaper than loosening the check that caught it.
            for attempt in range(2):
                draft = generate(prompt if attempt == 0 else prompt + _RETRY_NOTE,
                                 max_tokens=400, temperature=0.1)
                cleaned, removed = check_claims(draft or "", evidence, qplan.raw_query, scope)
                total_sents = max(1, len(_SENT.split((draft or "").strip())))
                if cleaned and removed <= total_sents / 3:
                    interpretation, generated_by = cleaned, "llm"
                    break
        except Exception:
            removed = 0
    status = {"empty": "empty", "partial": "partial", "insufficient": "partial"}.get(
        report.sufficiency, "answered")
    if degraded and status == "answered":
        status = "partial"
    facts = []
    for e in evidence:
        if e.source_type in ("aggregate", "trend", "comparison"):
            facts.append({"evidence_id": e.evidence_id, "type": e.source_type,
                          **{k: v for k, v in e.facts.items() if k != "rows"},
                          **({"rows": e.facts["rows"][:10]} if "rows" in e.facts else {})})
    analysis = {}
    for e in evidence:
        if e.source_type == "situation":
            analysis["situation"] = e.facts
    cited = {c for c in _CITE.findall(text + " " + (interpretation or ""))}
    citations = [Citation(evidence_id=e.evidence_id,
                          label=(e.facts.get("handle") or e.facts.get("kind") or e.source_type),
                          url=e.url) for e in evidence if e.evidence_id in cited]
    lim = list(dict.fromkeys(limitations + [i.detail for i in report.issues
                                            if i.severity == "warning"]))
    if report.evidence_removed:
        lim.append(f"{len(report.evidence_removed)} retrieved item(s) were excluded by "
                   f"verification (outside scope, filters or period, or duplicates).")
    conf = 0.9 if status == "answered" else 0.6 if status == "partial" else 0.8
    return AssistantResponse(
        request_id=request_id, status=status, answer=text, facts=facts, analysis=analysis,
        interpretation=interpretation, limitations=lim,
        evidence=[_public_ev(e) for e in evidence], citations=citations,
        confidence=conf, degraded=degraded, generated_by=generated_by,
        unsupported_claims_removed=removed)


def simple(request_id: str, status: str, answer: str, *, limitations=None,
           clarification=None) -> AssistantResponse:
    return AssistantResponse(request_id=request_id, status=status, answer=answer,
                             limitations=list(limitations or []), clarification=clarification,
                             confidence=0.0 if status in ("denied", "error") else 0.5)
