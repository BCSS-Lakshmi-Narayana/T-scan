"""A phrase that widens scope is not a subject to search for.

Reported as "the context keeps continuing and the new question is not detected".
The reproducible part was this: in a conversation, "all districts" after
"Show me grievances in Hyderabad." answered

    Of 60 record(s) checked: districts 32

because "districts" became an unknown CONCEPT, the resolver's rule "a follow-up
carrying an unknown concept and no filters is an unknown-concept search" fired,
and the question turned into a classification scan of the officer's own scope
word. The same failure class as an instruction becoming a concept, and as Telugu
grammar becoming a concept.

Correct behaviour: it is a follow-up. It inherits the subject and clears the
location, so the answer is every grievance rather than 60 judged records.
"""

import pytest

import conversation as conv
import v2fixture as fx
import vocabulary
from orchestrator import pipeline
from policy import PERM_AI_CHAT, RequestContext
from query_understanding import deterministic as qu_det
from query_understanding import understand
from query_understanding.models import FilterField, Intent

CORPUS = fx.build()
ADMIN = RequestContext(tenant_id="tenant-alpha", user_id="a1", role="admin")


def deps(**kw):
    base = dict(store=conv.InMemoryConversationStore(),
                backend_factory=fx.backend_factory(CORPUS),
                raw_generate=fx.scripted_llm(), cache=False)
    base.update(kw)
    return pipeline.Deps(**base)


RESETS = ["all districts", "every district", "all areas", "everywhere",
          "all locations", "all regions", "statewide", "all time", "any time"]


# ======================================================== understanding

@pytest.mark.parametrize("phrase", RESETS)
def test_a_bare_scope_phrase_is_recognised_as_one(phrase):
    assert qu_det.is_bare_scope_reset(phrase), f"{phrase!r} not recognised"


@pytest.mark.parametrize("phrase", RESETS)
def test_a_scope_word_never_becomes_a_concept(phrase):
    plan, validation = understand(phrase, allow_llm=False)
    assert plan.concepts == [], (
        f"{phrase!r} produced concepts {[c.text for c in plan.concepts]}, which "
        f"would be searched for as a subject")
    assert plan.intent is Intent.FOLLOW_UP
    assert validation.valid


@pytest.mark.parametrize("question", [
    "grievances in all districts",
    "show me all districts with high risk alerts",
    "how many grievances are there everywhere?",
])
def test_a_scope_phrase_inside_a_real_question_is_not_a_bare_reset(question):
    assert not qu_det.is_bare_scope_reset(question)
    plan, validation = understand(question, allow_llm=False)
    assert plan.intent is not Intent.FOLLOW_UP
    assert validation.valid


@pytest.mark.parametrize("question", [
    "Where are grievances concentrated?",
    "Break down alerts by platform.",
    "Which accounts post most often?",
    "posts about water supply problems",
    "How many grievances are there?",
    "Show me grievances in Hyderabad.",
])
def test_ordinary_questions_are_untouched(question):
    assert not qu_det.is_bare_scope_reset(question)
    plan, validation = understand(question, allow_llm=False)
    assert validation.valid
    assert plan.intent is not Intent.FOLLOW_UP


def test_a_district_word_is_still_a_grouping_facet():
    # "districts" must stay usable as something to group BY, even though it is
    # never something to search FOR.
    plan, _ = understand("Where are grievances concentrated?", allow_llm=False)
    assert "districts" in plan.group_by


# ======================================================== in conversation

def test_a_scope_reset_inherits_the_subject_and_clears_the_place():
    d = deps()
    first = pipeline.run("Show me grievances in Hyderabad.", ADMIN, d, now=fx.NOW)
    scoped = (first.response.populations or {})
    scoped = scoped.get("matching") if isinstance(scoped, dict) else None

    second = pipeline.run("all districts", ADMIN, d,
                          conversation_id=first.conversation_id, now=fx.NOW)
    plan = second.internal.get("query_plan") or {}
    # The subject survives...
    assert ("kind", "grievance") in {(f.get("field"), str(f.get("value")))
                                     for f in (plan.get("filters") or [])}
    # ...and the place does not.
    assert not plan.get("location")
    assert plan.get("intent") != "unknown_concept", (
        "the scope word became a concept again")
    steps = [s.get("tool") for s in ((second.internal.get("execution_plan") or {})
                                     .get("steps") or [])]
    assert "classify_records" not in steps and "unknown_concept_search" not in steps, (
        f"a scope reset compiled to {steps}")

    widened = second.response.populations
    widened = widened.get("matching") if isinstance(widened, dict) else None
    if isinstance(scoped, int) and isinstance(widened, int):
        assert widened >= scoped, (
            f"widening the scope returned fewer records ({scoped} -> {widened})")


def test_a_scope_reset_with_nothing_to_attach_to_asks():
    # Standalone, it is not a question. Asking is right; inventing a subject
    # is what produced "60 record(s) checked".
    r = pipeline.run("all districts", ADMIN, deps(), now=fx.NOW)
    assert r.response.status in ("clarification", "empty", "answered")
    steps = [s.get("tool") for s in ((r.internal.get("execution_plan") or {})
                                     .get("steps") or [])]
    assert "classify_records" not in steps


# ======================================================== configuration

def test_the_scope_phrases_are_configuration_not_code():
    table = vocabulary.query_vocabulary().get("scope_reset")
    assert table, "scope_reset is not configured"
    assert set(table) >= {"location", "time"}
    for dimension, terms in table.items():
        assert terms and all(isinstance(t, str) and t.strip() for t in terms), dimension


def test_every_scope_word_is_treated_as_grammar():
    for terms in vocabulary.query_vocabulary()["scope_reset"].values():
        for term in terms:
            for word in term.split():
                assert qu_det._is_scope_word(word.rstrip("*")), word
