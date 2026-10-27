"""Where a question stops being self-contained and starts needing the last one.

The rule, in one line: context fills in what a question leaves out; it never
makes a complete question incomplete.

The bug these cover: "how many grievances are there" was refused on an empty
conversation as "this refers to an earlier question I don't have". The word
"grievances" was recognised and became a KIND filter, KIND was not counted as
naming a subject, so the existential "there" was read as pointing back at a
previous result set. Understanding the noun was what broke the question —
"how many profiles are there" worked only because "profiles" is not a
known kind.
"""

import pytest

from conversation import (InMemoryConversationStore, ResolutionStatus, build_turn,
                          resolve_query)
from policy import PolicyConfig, RequestContext, evaluate
from query_understanding import understand
from query_understanding.models import FilterField

OFFICER = RequestContext(tenant_id="t-1", user_id="officer-1", role="admin",
                         districts=None,
                         permissions=frozenset({"ai_chat", "ai_deep_scan"}))


def converse(*questions, ctx=OFFICER):
    """Ask every turn in one real conversation; return the last resolution."""
    store = InMemoryConversationStore()
    state = store.create(ctx.tenant_id, ctx.user_id)
    resolved = None
    for question in questions:
        plan, _ = understand(question)
        resolved = resolve_query(plan, state, ctx, config=store.config)
        state = store.append(state, build_turn(state.turn_count + 1, question, resolved,
                                               store.config, query_plan=plan),
                             expected_sequence=state.turn_count)
    return resolved


def filters(resolved):
    return {f.field: f.value for f in resolved.resolved_plan.filters}


def where(resolved):
    loc = resolved.resolved_plan.location
    return loc.text if loc else None


def describe(resolved):
    p = resolved.resolved_plan
    return (f"status={resolved.status.value} intent={p.intent.value} "
            f"follow_up={resolved.metadata.follow_up} loc={where(resolved)} "
            f"filters={[(f.field.value, f.value) for f in p.filters]}")


# ===================================================================== #
# standalone: complete questions, answered without a conversation
# ===================================================================== #

@pytest.mark.parametrize("question,kind", [
    ("how many grievances are there", "grievance"),
    ("How many grievances are there?", "grievance"),
    ("how many alerts are there", "alert"),
])
def test_a_complete_count_question_needs_no_previous_question(question, kind):
    r = converse(question)
    assert r.status is ResolutionStatus.RESOLVED, describe(r)
    assert r.metadata.follow_up is False, describe(r)
    assert not r.unresolved_referents, describe(r)
    assert filters(r).get(FilterField.KIND) == kind, describe(r)


def test_a_subject_the_planner_does_not_recognise_still_stands_alone():
    # "profiles" is not a known kind, so it survives as a concept. This case
    # worked even while the bug was live; it is here so the two paths to
    # "has its own subject" stay in step.
    r = converse("how many profiles are there")
    assert r.status is ResolutionStatus.RESOLVED, describe(r)
    assert r.metadata.follow_up is False, describe(r)


def test_naming_a_place_as_well_is_still_standalone():
    r = converse("how many grievances are there in Hyderabad")
    assert r.status is ResolutionStatus.RESOLVED, describe(r)
    assert r.metadata.follow_up is False, describe(r)
    assert where(r) == "Hyderabad", describe(r)
    assert filters(r).get(FilterField.KIND) == "grievance", describe(r)


def test_a_standalone_question_invents_no_location():
    # "unspecified" must stay unspecified. The scope it is answered under is
    # the caller's own, decided by the policy gate, not guessed here.
    r = converse("how many grievances are there")
    assert where(r) is None, describe(r)
    assert evaluate(r.resolved_plan, OFFICER, config=PolicyConfig()) is not None


# ===================================================================== #
# follow-ups: questions that genuinely need the last one
# ===================================================================== #

def test_a_question_with_no_subject_is_a_follow_up():
    r = converse("Show me grievances in Hyderabad.", "how many are there")
    assert r.metadata.follow_up is True, describe(r)
    assert where(r) == "Hyderabad", describe(r)
    assert filters(r).get(FilterField.KIND) == "grievance", describe(r)


def test_swapping_the_place_keeps_the_subject():
    r = converse("Show me grievances in Hyderabad.", "What about Mulugu?")
    assert r.metadata.follow_up is True, describe(r)
    assert where(r) == "Mulugu", describe(r)
    assert filters(r).get(FilterField.KIND) == "grievance", describe(r)


def test_swapping_the_period_keeps_subject_and_place():
    r = converse("Show me grievances in Hyderabad.", "What about the last 30 days?")
    assert r.metadata.follow_up is True, describe(r)
    assert where(r) == "Hyderabad", describe(r)
    assert filters(r).get(FilterField.KIND) == "grievance", describe(r)


def test_asking_how_it_changed_keeps_subject_and_place():
    r = converse("Show me grievances in Hyderabad.", "How has it changed?")
    assert r.metadata.follow_up is True, describe(r)
    assert where(r) == "Hyderabad", describe(r)


def test_narrowing_by_a_modifier_is_a_follow_up_not_a_new_subject():
    # "the low risk ones" narrows what is already being discussed. A modifier
    # must never make a question look self-contained.
    r = converse("Show me high risk activity in Hyderabad.", "And the low risk ones?")
    assert r.metadata.follow_up is True, describe(r)
    assert where(r) == "Hyderabad", describe(r)


def test_asking_where_it_gets_attention_keeps_the_subject():
    r = converse("Show me grievance activity in Hyderabad.",
                 "Where is it getting more attention?")
    assert r.metadata.follow_up is True, describe(r)


# ===================================================================== #
# the current question wins, and does not inherit what it did not ask for
# ===================================================================== #

def test_a_new_complete_question_does_not_inherit_the_old_one():
    # THE case from the report: after a high-risk Hyderabad question, asking a
    # whole new question must not drag "high risk" and "Hyderabad" along.
    r = converse("Show me high risk activity in Hyderabad.",
                 "How many grievances are there?")
    assert r.status is ResolutionStatus.RESOLVED, describe(r)
    assert r.metadata.follow_up is False, describe(r)
    assert filters(r).get(FilterField.KIND) == "grievance", describe(r)
    assert where(r) is None, "Hyderabad was not asked for again: " + describe(r)
    assert FilterField.RISK_LEVEL not in filters(r), (
        "high risk belonged to the previous question: " + describe(r))


def test_an_explicit_place_beats_the_inherited_one():
    r = converse("Show me high risk activity in Hyderabad.",
                 "How many grievances are there in Mulugu?")
    assert where(r) == "Mulugu", describe(r)
    assert filters(r).get(FilterField.KIND) == "grievance", describe(r)


# ===================================================================== #
# the shape of the plan an officer's question produces
# ===================================================================== #

def test_the_plan_for_a_standalone_count_is_auditable():
    r = converse("how many grievances are there")
    plan = r.resolved_plan
    assert plan.intent.value in ("count", "aggregation"), describe(r)
    assert filters(r).get(FilterField.KIND) == "grievance"
    assert plan.location is None
    assert r.metadata.follow_up is False
    assert not r.unresolved_referents


def test_the_plan_for_a_follow_up_count_records_what_it_inherited():
    r = converse("Show me grievances in Hyderabad.", "how many are there")
    plan = r.resolved_plan
    assert plan.intent.value in ("count", "aggregation"), describe(r)
    assert filters(r).get(FilterField.KIND) == "grievance"
    assert where(r) == "Hyderabad"
    assert r.metadata.follow_up is True
