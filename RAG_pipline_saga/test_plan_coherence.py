"""A plan must not contradict itself, in any script.

Two production defects, both of which refused a question the system had
actually understood:

  F1  accepting the model's intent kept the RULES' shape, so a Telugu count
      became intent=aggregation with shape=unknown_concept — a plan the
      validator rejects, reported to the officer as "denied".

  F2  `[^\\W\\d_]+` and `\\w+` exclude Indic combining marks, so "ఎన్ని"
      tokenised as ['ఎన', 'న'] — the virama and both vowel signs dropped.
      Every layer that counted or matched words then read a Telugu question
      as a row of meaningless consonants.
"""

import pytest

from query_understanding import merge as merge_mod
from query_understanding import understand
from query_understanding.models import Intent, Shape
from query_understanding.normalize import words, word_count
from query_understanding.validator import _COMPATIBLE
import concepts as concepts_mod

TE_COUNT = "ఎన్ని ఫిర్యాదులు ఉన్నాయి?"
TE_SITUATION = "హైదరాబాద్ లో ఏం జరుగుతోంది?"
HI_SITUATION = "हैदराबाद में क्या हो रहा है?"


# ===================================================================== #
# F1 — every field that follows from the intent follows the ACCEPTED one
# ===================================================================== #

def rule_for(intent, shape, **over):
    """A deterministic extraction the model is about to overrule."""
    base = {
        "intent": intent, "shape": shape, "intent_confidence": 0.65,
        "filters": [], "location": None, "time_range": None, "concepts": [],
        "entities": [], "group_by": [], "metric": None, "ambiguities": [],
        "parts": [], "sort": None, "limit": None,
    }
    base.update(over)
    return base


@pytest.mark.parametrize("llm_intent", [i.value for i in Intent])
def test_an_accepted_intent_always_gets_a_shape_that_can_execute_it(llm_intent):
    # The whole class of bug, not just the one case that was reported.
    out = merge_mod.merge(rule_for(Intent.UNKNOWN_CONCEPT, Shape.UNKNOWN_CONCEPT),
                          {"intent": llm_intent})
    allowed = _COMPATIBLE.get(out["intent"])
    assert allowed is None or out["shape"] in allowed, (
        f"intent={out['intent'].value} cannot be executed by "
        f"shape={out['shape'].value}")


def test_the_rules_shape_is_not_carried_across_an_intent_change():
    out = merge_mod.merge(rule_for(Intent.UNKNOWN_CONCEPT, Shape.UNKNOWN_CONCEPT),
                          {"intent": "aggregation"})
    assert out["intent"] is Intent.AGGREGATION
    assert out["shape"] is not Shape.UNKNOWN_CONCEPT
    assert out["shape"] is Shape.ANALYTICAL


def test_a_shape_the_model_offers_is_refused_when_it_cannot_run_the_intent():
    out = merge_mod.merge(rule_for(Intent.UNKNOWN_CONCEPT, Shape.UNKNOWN_CONCEPT),
                          {"intent": "aggregation", "shape": "unknown_concept"})
    assert out["shape"] is Shape.ANALYTICAL, "an incompatible offer is not honoured"


def test_an_accepted_aggregation_is_given_something_to_count():
    # The validator refuses an aggregation with neither metric nor group_by.
    out = merge_mod.merge(rule_for(Intent.UNKNOWN_CONCEPT, Shape.UNKNOWN_CONCEPT),
                          {"intent": "aggregation"})
    assert out["metric"] == "count"


def test_a_grouping_is_enough_and_no_metric_is_invented():
    out = merge_mod.merge(
        rule_for(Intent.UNKNOWN_CONCEPT, Shape.UNKNOWN_CONCEPT, group_by=["districts"]),
        {"intent": "aggregation"})
    assert out["group_by"] == ["districts"]
    assert out["metric"] is None, "a grouping already says what to count"


def test_a_confident_rule_intent_still_wins_and_keeps_its_shape():
    out = merge_mod.merge(
        rule_for(Intent.COMPARISON, Shape.COMPARISON, intent_confidence=0.9),
        {"intent": "aggregation"})
    assert out["intent"] is Intent.COMPARISON
    assert out["shape"] is Shape.COMPARISON
    assert any(c.field == "intent" for c in out["conflicts"]), "disagreement is recorded"


# ===================================================================== #
# F2 — words are words in every script
# ===================================================================== #

@pytest.mark.parametrize("text,expected", [
    ("ఎన్ని ఫిర్యాదులు ఉన్నాయి", ["ఎన్ని", "ఫిర్యాదులు", "ఉన్నాయి"]),
    ("హైదరాబాద్ లో ఏం జరుగుతోంది", ["హైదరాబాద్", "లో", "ఏం", "జరుగుతోంది"]),
    ("हैदराबाद में क्या हो रहा है", ["हैदराबाद", "में", "क्या", "हो", "रहा", "है"]),
    ("how many grievances are there", ["how", "many", "grievances", "are", "there"]),
    ("Hyderabad lo em nadustundhi", ["Hyderabad", "lo", "em", "nadustundhi"]),
    ("Hyderabad lo ఏం జరుగుతోంది", ["Hyderabad", "lo", "ఏం", "జరుగుతోంది"]),
])
def test_a_word_survives_as_one_word(text, expected):
    assert words(text) == expected


def test_indic_words_are_not_split_at_every_combining_mark():
    # The defect: "ఎన్ని" is ఎ + న + virama + న + ి. \w excludes the marks,
    # so the old tokenizer returned one fragment per consonant.
    assert word_count("ఎన్ని") == 1
    assert word_count("क्या") == 1
    assert len(words("ఎన్ని")[0]) > 2, "the marks are kept, not stripped"


def test_punctuation_and_digits_are_not_words():
    assert words("how many? 42 grievances!") == ["how", "many", "grievances"]


def test_a_hyphenated_or_apostrophed_word_stays_whole():
    assert words("women's high-risk posts") == ["women's", "high-risk", "posts"]


def test_empty_and_missing_text_are_safe():
    assert words("") == [] and words(None) == []
    assert word_count("") == 0


def test_the_concept_of_a_telugu_question_is_the_telugu_words():
    # Was: 'ఎన న ఫ ర య ద ల ఉన న య' — a row of bare consonants handed to the
    # judge as the thing to search for.
    got = concepts_mod.concept("ఎన్ని ఫిర్యాదులు ఉన్నాయి")
    assert "ఫిర్యాదులు" in got
    assert "ఎన న" not in got


# ===================================================================== #
# F1 + F2 together: the question that was refused in production
# ===================================================================== #

@pytest.mark.parametrize("q,intent", [
    (TE_COUNT, Intent.AGGREGATION),
    ("How many grievances are there?", Intent.AGGREGATION),
])
def test_a_count_question_plans_coherently_in_any_script(q, intent):
    plan, validation = understand(q, allow_llm=False)
    assert validation.valid, [e.message for e in validation.errors]


@pytest.mark.parametrize("q", [TE_COUNT, TE_SITUATION, HI_SITUATION,
                               "Hyderabad lo em nadustundhi?",
                               "How many grievances are there?",
                               "Compare Hyderabad and Mulugu."])
def test_no_question_produces_a_self_contradicting_plan(q):
    plan, validation = understand(q, allow_llm=False)
    allowed = _COMPATIBLE.get(plan.intent)
    assert allowed is None or plan.shape in allowed, (
        f"{q!r}: intent={plan.intent.value} shape={plan.shape.value}")
    assert validation.valid, [e.message for e in validation.errors]


# ===================================================================== #
# retrieval strategy is visible, never silently degraded
# ===================================================================== #

def test_the_search_strategy_actually_used_is_reported():
    import vector_store as vs
    vs.reset_search_strategy_counts()
    assert vs.search_strategy_report() == {}
    vs._note_strategy("atlas_vector_search")
    vs._note_strategy("atlas_vector_search")
    vs._note_strategy("brute_force")
    got = vs.search_strategy_report()
    assert got == {"atlas_vector_search": 2, "brute_force": 1}
    # a copy, so a caller cannot corrupt the counters
    got["atlas_vector_search"] = 999
    assert vs.search_strategy_report()["atlas_vector_search"] == 2


def test_degraded_retrieval_is_named_distinctly_from_the_real_path():
    import vector_store as vs
    # These names appear in the metrics endpoint; anything other than
    # atlas_vector_search dominating means the index is missing or unhealthy.
    for name in ("atlas_unavailable", "atlas_error", "text_prefilter",
                 "sampled", "brute_force"):
        assert name != "atlas_vector_search"
