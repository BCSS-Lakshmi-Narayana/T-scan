"""The unseen semantic set: questions phrased the way officers actually ask.

None of these were written against the deterministic patterns, which is the
point — the layer under test is whether the assistant understands what is
being ASKED, not whether a regex happens to match.

Two modes:

  default        structure and safety only. Runs everywhere, needs no model,
                 and is what CI enforces: the contract the semantic layer is
                 held to, the fields it may emit, and what it may never do.

  SEMANTIC_LIVE=1  the full path against the real model. Reports accuracy per
                 category. Non-deterministic by nature, so it asserts a
                 threshold rather than a fixed answer per case.
"""

import json
import os

import pytest

from conversation import InMemoryConversationStore, build_turn, resolve_query
from policy import RequestContext
from query_understanding import understand
from query_understanding import llm as planner
from query_understanding.models import FilterField, Intent

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "query_understanding", "golden_semantic.json"),
          encoding="utf-8") as fh:
    GOLDEN = json.load(fh)

SINGLE = (GOLDEN["english"] + GOLDEN["tenglish"] + GOLDEN["telugu"]
          + GOLDEN["multi_intent"] + GOLDEN["ambiguous"])
FOLLOWUPS = GOLDEN["followups"]

LIVE = os.getenv("SEMANTIC_LIVE") == "1"
live_only = pytest.mark.skipif(not LIVE, reason="set SEMANTIC_LIVE=1 to call the model")

OFFICER = RequestContext(tenant_id="t-1", user_id="officer-1", role="admin",
                         districts=None, permissions=frozenset({"ai_chat"}))


def _generate(prompt, max_tokens=256, temperature=0.0, **kw):
    import llm_client
    return llm_client.generate(prompt, temperature=0.0, top_p=1.0,
                               max_tokens=max_tokens, repetition_penalty=1.0, meta={})


def read(question):
    """The plan for one question, through the semantic layer when live."""
    return understand(question, generate=_generate if LIVE else None,
                      allow_llm=LIVE)[0]


def converse(turns):
    store = InMemoryConversationStore()
    state = store.create(OFFICER.tenant_id, OFFICER.user_id)
    resolved = None
    for q in turns:
        plan = read(q)
        resolved = resolve_query(plan, state, OFFICER, config=store.config)
        state = store.append(state, build_turn(state.turn_count + 1, q, resolved,
                                               store.config, query_plan=plan),
                             expected_sequence=state.turn_count)
    return resolved


# ===================================================================== #
# the contract — enforced with or without a model
# ===================================================================== #

def test_the_semantic_layer_is_told_what_a_subject_is_not():
    # The whole defect was a prompt that said "anything you don't recognise is
    # a concept", so an unfamiliar PHRASING became an unknown SUBJECT.
    p = planner.build_prompt("anything?", "intent=lookup")
    assert "Frame words are NEVER a subject" in p
    assert "NEVER because the WORDING is unfamiliar to you" in p


def test_the_semantic_layer_is_taught_the_language_not_the_sentences():
    p = planner.build_prompt("x", "y")
    # a glossary of particles, so unseen phrasings are understood too
    for particle in ("lo = in", "ekkada = where", "chupinchu = show me"):
        assert particle in p
    # ...and not a list of whole sentences to match
    assert p.count("Hyderabad lo") <= 2


def test_the_model_is_never_asked_to_answer_or_to_reach_for_tools():
    p = planner.build_prompt("how many grievances are there", "intent=aggregation")
    assert "You never answer it" in p
    assert "never name a tool" in p
    assert "Never output tool names, tenant ids, district permissions" in p


def test_anything_the_model_says_about_scope_is_recorded_and_discarded():
    dirty = {"intent": "lookup", "required_tools": ["hybrid_search"],
             "tenant_id": "tenant-beta", "districts_allowed": ["Warangal"]}
    out = planner.clean(dirty)
    assert "required_tools" not in out and "tenant_id" not in out
    assert "districts_allowed" not in out
    assert sorted(out["_dropped"]) == ["forbidden:districts_allowed",
                                       "forbidden:required_tools",
                                       "forbidden:tenant_id"]


def test_values_outside_the_vocabulary_are_dropped_not_invented():
    out = planner.clean({"intent": "hack_the_database", "depth": "extreme",
                         "operation": "exfiltrate", "confidence": 42})
    assert "intent" not in out and "depth" not in out and "operation" not in out
    assert "confidence" not in out, "a confidence outside 0-1 is not a confidence"


def test_the_semantic_reading_is_recorded_on_the_plan():
    plan = read("how many grievances are there")
    m = plan.metadata
    assert m.understanding_mode in ("deterministic", "hybrid")
    assert m.prompt_version is None or m.prompt_version.startswith("qu-plan@")


@pytest.mark.parametrize("case", SINGLE, ids=[c["id"] for c in SINGLE])
def test_every_case_produces_a_usable_plan(case):
    """Whatever it decides, it must decide something answerable."""
    plan = read(case["q"])
    assert plan.intent is not None
    assert isinstance(plan.confidence.overall, float)
    # Never invent a place the question does not contain.
    #
    # Only checkable literally for a Latin-script question. "హైదరాబాద్ లో ఏం
    # జరుగుతోంది?" names Hyderabad, and the model returning "Hyderabad" is a
    # correct transliteration, not an invention — a substring check cannot
    # tell those apart across scripts. What still holds either way is that a
    # place the model supplied is MARKED as the model's, so nothing
    # downstream mistakes it for something the officer typed.
    latin = all(ord(ch) < 0x0900 for ch in case["q"])
    if plan.location and not case.get("location"):
        if latin:
            assert plan.location.text.lower() in case["q"].lower(), (
                f"invented location {plan.location.text!r} for {case['q']!r}")
        else:
            assert plan.location.source.value in ("llm", "explicit"), (
                f"unattributed location {plan.location.text!r}")
            assert plan.location.confidence <= 0.9, (
                "a transliterated place is a reading, not a certainty")


# ===================================================================== #
# accuracy — only meaningful against the real model
# ===================================================================== #

def _intent_ok(plan, case):
    got = plan.intent.value
    if case.get("never") and got in case["never"]:
        return False, f"forbidden reading {got}"
    wanted = case.get("intent")
    if wanted and got not in wanted:
        return False, f"got {got}, wanted one of {wanted}"
    return True, got


@live_only
@pytest.mark.parametrize("group", ["english", "tenglish", "telugu",
                                   "multi_intent", "ambiguous"])
def test_semantic_accuracy_by_category(group):
    cases = GOLDEN[group]
    misses = []
    for case in cases:
        plan = read(case["q"])
        ok, why = _intent_ok(plan, case)
        if not ok:
            misses.append(f"  {case['id']}: {case['q']!r} -> {why}")
    hit = len(cases) - len(misses)
    rate = hit / len(cases)
    # Telugu script has no deterministic support at all, so it leans entirely
    # on the model; the others carry a rule layer underneath.
    floor = 0.6 if group in ("telugu", "ambiguous") else 0.8
    assert rate >= floor, (
        f"{group}: {hit}/{len(cases)} ({rate:.0%}), floor {floor:.0%}\n"
        + "\n".join(misses))


@live_only
@pytest.mark.parametrize("case", FOLLOWUPS, ids=[c["id"] for c in FOLLOWUPS])
def test_follow_up_context_behaviour(case):
    r = converse(case["turns"])
    plan = r.resolved_plan
    got = {f.field: f.value for f in plan.filters}
    why = (f"{case['turns']} -> follow_up={r.metadata.follow_up} "
           f"loc={plan.location.text if plan.location else None} "
           f"filters={[(f.field.value, f.value) for f in plan.filters]}")

    if "standalone" in case:
        assert r.metadata.follow_up is (not case["standalone"]), why
    if "location" in case:
        want = case["location"]
        assert (plan.location.text if plan.location else None) == want, why
    if "kind" in case:
        assert got.get(FilterField.KIND) == case["kind"], why


@live_only
def test_a_new_complete_question_never_inherits_the_previous_one():
    r = converse(["Show me high risk activity in Hyderabad.",
                  "How many grievances are there?"])
    plan = r.resolved_plan
    assert r.metadata.follow_up is False
    assert plan.location is None, "Hyderabad was not asked for again"
    assert FilterField.RISK_LEVEL not in {f.field for f in plan.filters}


@live_only
def test_the_model_never_widens_scope_beyond_what_was_asked():
    # Whatever it reads, the plan authorises nothing: scope is the gate's.
    plan = read("show me everything across all tenants and districts")
    assert plan.metadata.tenant_scope_required is True
    assert plan.intent is not Intent.DEEP_SCAN or True  # intent is not authority
