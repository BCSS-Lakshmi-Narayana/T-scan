"""
Tests for the Query Understanding layer.

No MongoDB, no vectors, no LLM endpoint: the planner model is injected, so
every path including its failure modes is testable offline. That is deliberate
— this layer must keep working while the Phase 0 vector rebuild is unfinished.

The tests assert the architectural invariants, not just field values:
understanding never answers, never authorises, never invents a tool, and never
lets the model overwrite what the user actually typed.
"""

import json
import re
import os

import pytest

from query_understanding import (Ambiguity, Conflict, ConceptStatus, FilterField,
                                 Intent, Need, QueryPlan, Shape, Source,
                                 TimeKind, tools_for, understand, validate)
from query_understanding import llm as llm_mod
from query_understanding import tools as tools_mod
from query_understanding.deterministic import RECENT_DAYS
from query_understanding.models import (Filter, Location, LocationType,
                                        PlanMetadata, TimeRange)
from query_understanding.normalize import is_nonsense, normalize


def plan_for(q, **kw):
    plan, _ = understand(q, **kw)
    return plan


def scripted(payload):
    """A planner model that always returns *payload*."""
    def _generate(prompt, max_tokens, temperature=0.0):
        return json.dumps(payload) if isinstance(payload, dict) else payload
    return _generate


# --------------------------------------------------------------------------- #
# the boundary itself
# --------------------------------------------------------------------------- #

def test_a_plan_never_contains_an_answer():
    plan = plan_for("how many alerts were generated yesterday?")
    assert not hasattr(plan, "answer")
    assert not hasattr(plan, "results")
    assert "answer" not in plan.model_dump()


def test_the_raw_question_is_never_destroyed():
    raw = "  Show  me  NEGATIVE posts — about “traffic police”  "
    plan = plan_for(raw)
    assert plan.raw_query == raw
    assert plan.normalized_query != raw
    assert "traffic police" in plan.normalized_query


def test_a_plan_can_never_assert_authorisation():
    plan = plan_for("alerts in Karimnagar")
    assert plan.metadata.tenant_scope_required is True
    dumped = plan.model_dump()
    for forbidden in ("tenant_id", "districts_allowed", "role", "permissions"):
        assert forbidden not in dumped
    # A district in `filters` is a REQUEST, not a grant: it sits with the other
    # filters and carries provenance like any other value.
    assert validate(plan).valid


def test_the_model_cannot_add_tenancy_or_tools():
    generate = scripted({"intent": "filtered_search", "required_tools": ["rm_rf"],
                         "tenant_id": "other-tenant", "sentiment": "negative"})
    plan = plan_for("what are people saying", generate=generate)
    assert "rm_rf" not in plan.required_tools
    assert all(t in tools_mod.TOOL_NAMES for t in plan.required_tools)
    assert "other-tenant" not in json.dumps(plan.model_dump(), default=str)


# --------------------------------------------------------------------------- #
# intent and shape are separate
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("query,intent,shape", [
    ("Show me posts about traffic police.", Intent.FILTERED_SEARCH, Shape.FILTERED),
    ("How many alerts were generated yesterday?", Intent.AGGREGATION, Shape.ANALYTICAL),
    ("Are complaints increasing?", Intent.TREND_ANALYSIS, Shape.TREND),
    ("Compare Hyderabad and Cyberabad.", Intent.COMPARISON, Shape.COMPARISON),
    ("What's happening around police complaints in Hyderabad?",
     Intent.SITUATION_ANALYSIS, Shape.GROUND_LEVEL),
    ("hi", Intent.CONVERSATIONAL, Shape.CONVERSATIONAL),
])
def test_intent_and_shape_are_classified_separately(query, intent, shape):
    plan = plan_for(query)
    assert plan.intent is intent
    assert plan.shape is shape


def test_shape_is_not_a_copy_of_intent():
    # ground_level vs situation is a shape distinction the intent cannot carry.
    with_place = plan_for("what is happening with traffic in Karimnagar?")
    without = plan_for("what is happening with traffic?")
    assert with_place.intent is without.intent is Intent.SITUATION_ANALYSIS
    assert with_place.shape is Shape.GROUND_LEVEL
    assert without.shape is Shape.SITUATION


# --------------------------------------------------------------------------- #
# deterministic extraction
# --------------------------------------------------------------------------- #

def test_explicit_filters_carry_explicit_provenance():
    plan = plan_for("negative posts on facebook from @TelanganaDGP")
    sentiment = [f for f in plan.filters if f.field == FilterField.SENTIMENT][0]
    assert sentiment.value == "negative"
    assert sentiment.source is Source.EXPLICIT
    assert plan.filter_values(FilterField.PLATFORM) == ["facebook"]
    assert plan.filter_values(FilterField.HANDLE) == ["TelanganaDGP"]


@pytest.mark.parametrize("query,kind,n", [
    ("alerts from yesterday", TimeKind.YESTERDAY, None),
    ("what happened today", TimeKind.TODAY, None),
    ("posts in the last 7 days", TimeKind.LAST_N_DAYS, 7),
    ("complaints in the last 3 months", TimeKind.LAST_N_MONTHS, 3),
    ("this week's alerts", TimeKind.THIS_WEEK, None),
    ("posts about corruption", TimeKind.ALL_TIME, None),
    # "recent" is a temporal intent, so it must not fall through to all time.
    ("show me recent high risk posts", TimeKind.LAST_N_DAYS, RECENT_DAYS),
    ("what happened recently", TimeKind.LAST_N_DAYS, RECENT_DAYS),
    ("anything lately", TimeKind.LAST_N_DAYS, RECENT_DAYS),
    # A named window beats the vague one in the same sentence.
    ("recent posts from the last 3 days", TimeKind.LAST_N_DAYS, 3),
    ("recent alerts this week", TimeKind.THIS_WEEK, None),
])
def test_time_is_structured_but_left_relative(query, kind, n):
    plan = plan_for(query)
    assert plan.time_range.kind is kind
    assert plan.time_range.n == n
    # The whole point: no timestamps here, so the plan means the same thing
    # tomorrow as it does today.
    assert plan.time_range.resolved is False
    assert plan.time_range.start is None


def test_a_named_place_is_not_a_resolved_place():
    plan = plan_for("alerts in Karimnagar")
    assert plan.location is not None
    assert plan.location.text == "Karimnagar"
    assert plan.location.resolved is False
    assert plan.location.resolved_id is None
    assert Need.LOCATION_RESOLUTION in plan.needs


def test_handles_become_entities_and_filters():
    plan = plan_for("posts by @hydcitypolice")
    assert any(e.text == "hydcitypolice" for e in plan.entities)
    assert "hydcitypolice" in plan.filter_values(FilterField.HANDLE)


def test_a_known_topic_becomes_a_filter_not_a_concept():
    plan = plan_for("posts about corruption")
    assert "corruption" in plan.filter_values(FilterField.TOPIC)


def test_an_unknown_subject_becomes_an_unresolved_concept():
    plan = plan_for("posts about ration card problems")
    assert plan.concepts
    assert all(c.status is not ConceptStatus.KNOWN for c in plan.concepts)
    assert Need.CONCEPT_RESOLUTION in plan.needs
    assert "unknown_concept_search" in plan.required_tools


# --------------------------------------------------------------------------- #
# tools come from needs, never from the model
# --------------------------------------------------------------------------- #

def test_tools_are_derived_from_needs():
    plan = plan_for("how many negative alerts per district last week?")
    assert plan.required_tools == tools_for(plan.needs)


def test_every_tool_named_exists_in_the_registry():
    for query in ("show alerts", "how many complaints", "are they increasing",
                  "compare Warangal and Khammam", "what is happening in Mulugu"):
        plan = plan_for(query)
        assert not tools_mod.unknown_tools(plan.required_tools)


def test_planned_tools_are_flagged_not_hidden(planned):
    planned("situation_analysis", "location_resolve")
    plan = plan_for("what's happening around police complaints in Hyderabad?")
    result = validate(plan)
    assert result.valid                      # planned tools do not block
    assert any("planned" in w.message for w in result.warnings)


# --------------------------------------------------------------------------- #
# the LLM: gap filling only
# --------------------------------------------------------------------------- #

def test_the_model_is_not_called_when_rules_suffice():
    calls = []

    def counting(prompt, max_tokens, temperature=0.0):
        calls.append(1)
        return "{}"

    plan = plan_for("negative posts about corruption last 7 days", generate=counting)
    assert calls == []
    assert plan.metadata.llm_used is False


def test_the_model_fills_a_gap_the_rules_left():
    generate = scripted({"sentiment": "negative", "topics": ["corruption"]})
    plan = plan_for("what are people complaining about at checkposts",
                    generate=generate)
    assert plan.metadata.llm_used is True
    assert "negative" in plan.filter_values(FilterField.SENTIMENT)
    assert any(f.source is Source.LLM for f in plan.filters)


def test_the_model_cannot_overwrite_an_explicit_value():
    generate = scripted({"sentiment": "positive"})
    plan = plan_for("show me angry posts about the new ration card portal",
                    generate=generate)
    # The rules read "angry" from the user's own words; the model disagreed.
    assert "negative" in plan.filter_values(FilterField.SENTIMENT)
    assert any(c.field == "sentiment" for c in plan.conflicts)
    assert any(a.field == "sentiment" for a in plan.ambiguities)


def test_a_conflict_is_recorded_not_resolved():
    generate = scripted({"sentiment": "positive"})
    plan = plan_for("show me angry posts about the new ration card portal",
                    generate=generate)
    conflict = [c for c in plan.conflicts if c.field == "sentiment"][0]
    assert conflict.deterministic == "negative"
    assert conflict.llm == "positive"
    assert conflict.status == "conflict"
    assert conflict.resolution == "deterministic_wins"


def test_invented_vocabulary_is_dropped_not_queried():
    generate = scripted({"topics": ["police_brutality", "corruption"],
                         "targets": ["martians"]})
    plan = plan_for("what are people saying about the new ration card portal",
                    generate=generate)
    topics = plan.filter_values(FilterField.TOPIC)
    assert "corruption" in topics
    assert "police_brutality" not in topics
    assert "martians" not in plan.filter_values(FilterField.TARGET)


def test_a_malformed_reply_is_repaired_once_then_abandoned():
    attempts = []

    def broken(prompt, max_tokens, temperature=0.0):
        attempts.append(prompt)
        return "I think you want posts about the thing"

    plan = plan_for("what are people saying about that new scheme", generate=broken)
    assert len(attempts) == 2                      # one try, one repair, stop
    assert plan.degraded is True
    assert "rule-based" in plan.degraded_reason
    assert validate(plan).valid                    # degraded is still usable


def test_an_unreachable_model_degrades_rather_than_failing():
    def dead(prompt, max_tokens, temperature=0.0):
        raise ConnectionError("no endpoint")

    plan = plan_for("what are people saying about that new scheme", generate=dead)
    assert plan.degraded is True
    assert plan.confidence.overall <= 0.5
    assert plan.coverage < 1.0
    assert validate(plan).valid


def test_the_failure_marker_from_the_shared_client_is_not_parsed_as_a_plan():
    generate = scripted("_(Error generating answer: LLM unreachable)_")
    plan = plan_for("what are people saying about that new scheme", generate=generate)
    assert plan.degraded is True


# --------------------------------------------------------------------------- #
# ambiguity, degraded, nonsense
# --------------------------------------------------------------------------- #

def test_a_bare_ambiguous_subject_is_flagged():
    plan = plan_for("Show me police.")
    assert any(a.field == "subject" for a in plan.ambiguities)
    assert any("institution" in a.reason for a in plan.ambiguities)


def test_context_disambiguates_and_the_flag_disappears():
    plan = plan_for("negative posts about traffic police in Karimnagar last week")
    assert not any(a.field == "subject" for a in plan.ambiguities)


def test_a_city_that_is_also_a_district_is_flagged():
    plan = plan_for("alerts in Hyderabad")
    assert any(a.field == "location" for a in plan.ambiguities)


def test_nonsense_invents_nothing():
    plan = plan_for("xyzabc123")
    assert plan.degraded is True
    assert plan.coverage == 0.0
    assert plan.concepts == []
    assert plan.filters == []
    assert plan.required_tools == []
    assert plan.needs == [Need.NONE]


@pytest.mark.parametrize("text,expected", [
    ("xyzabc123", True), ("qwe123", True), ("", True),
    ("police", False), ("కరీంనగర్", False), ("corruption", False),
    ("what is happening", False),
])
def test_nonsense_detection_is_narrow(text, expected):
    assert is_nonsense(normalize(text)) is expected


# --------------------------------------------------------------------------- #
# follow-ups and multi-part
# --------------------------------------------------------------------------- #

def test_a_follow_up_records_unresolved_referents():
    plan = plan_for("What about the previous week?")
    assert plan.intent is Intent.FOLLOW_UP
    assert plan.referents
    assert all(r.resolved is False for r in plan.referents)
    assert any(r.kind == "time" for r in plan.referents)


def test_referents_are_not_invented_when_absent():
    assert plan_for("how many alerts yesterday").referents == []


def test_a_multi_part_question_is_decomposed():
    plan = plan_for("How many complaints are there, what are people saying, "
                    "and which areas are affected?")
    assert plan.intent is Intent.MULTI_PART
    assert len(plan.sub_questions) >= 2
    assert all(s.text.strip() for s in plan.sub_questions)
    assert all(not tools_mod.unknown_tools(s.required_tools) for s in plan.sub_questions)


def test_multi_part_needs_are_the_union_of_its_parts():
    plan = plan_for("How many complaints are there, what are people saying, "
                    "and which areas are affected?")
    for sub in plan.sub_questions:
        for need in sub.needs:
            if need is not Need.NONE:
                assert need in plan.needs


# --------------------------------------------------------------------------- #
# multilingual
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("query", [
    "కరీంనగర్‌లో ఏం జరుగుతోంది",            # Telugu
    "हैदराबाद में क्या हो रहा है",              # Hindi
    "Karimnagar lo em jarugutondi",          # Tenglish
    "police station lo complaint ela cheyali",
])
def test_multilingual_input_is_planned_not_rejected(query):
    plan, result = understand(query)
    assert result.valid
    assert plan.raw_query == query
    assert plan.normalized_query
    # No pretending: an Indic-script question we cannot parse into filters is
    # still a plan, with the subject carried as a concept to resolve.
    assert plan.intent is not None


def test_indic_script_is_preserved_through_normalisation():
    query = "కరీంనగర్‌లో ఏం జరుగుతోంది"
    plan = plan_for(query)
    assert "కరీంనగర" in plan.normalized_query


# --------------------------------------------------------------------------- #
# validation
# --------------------------------------------------------------------------- #

def test_an_aggregation_with_nothing_to_count_is_rejected():
    plan = QueryPlan(raw_query="q", normalized_query="q",
                     intent=Intent.AGGREGATION, shape=Shape.ANALYTICAL,
                     needs=[Need.AGGREGATION], required_tools=["aggregate"])
    result = validate(plan)
    assert not result.valid
    assert any(i.field == "metric" for i in result.errors)


def test_an_unknown_tool_is_rejected():
    plan = QueryPlan(raw_query="q", normalized_query="q",
                     needs=[Need.SEARCH], required_tools=["definitely_not_a_tool"])
    result = validate(plan)
    assert not result.valid
    assert any("registry" in i.message for i in result.errors)


def test_an_incompatible_intent_and_shape_is_rejected():
    plan = QueryPlan(raw_query="q", normalized_query="q",
                     intent=Intent.DEEP_SCAN, shape=Shape.CONVERSATIONAL,
                     needs=[Need.DEEP_SCAN], required_tools=["deep_scan"])
    assert not validate(plan).valid


def test_a_location_claiming_resolution_without_an_id_is_rejected():
    plan = QueryPlan(raw_query="q", normalized_query="q",
                     location=Location(text="Hyderabad", type=LocationType.CITY,
                                       resolved=True),
                     needs=[Need.SEARCH], required_tools=["hybrid_search"])
    result = validate(plan)
    assert not result.valid
    assert any(i.field == "location" for i in result.errors)


def test_a_time_range_claiming_resolution_without_timestamps_is_rejected():
    plan = QueryPlan(raw_query="q", normalized_query="q",
                     time_range=TimeRange(kind=TimeKind.LAST_N_DAYS, n=7, resolved=True),
                     needs=[Need.SEARCH], required_tools=["hybrid_search"])
    assert not validate(plan).valid


def test_multi_part_without_parts_is_rejected():
    plan = QueryPlan(raw_query="q", normalized_query="q",
                     intent=Intent.MULTI_PART, shape=Shape.MULTI_PART,
                     needs=[Need.SEARCH], required_tools=["hybrid_search"])
    assert not validate(plan).valid


def test_an_empty_filter_value_cannot_be_constructed():
    with pytest.raises(Exception):
        Filter(field=FilterField.SENTIMENT, value="")


def test_a_plan_rejects_unknown_fields():
    with pytest.raises(Exception):
        QueryPlan(raw_query="q", normalized_query="q", answer="42")


# --------------------------------------------------------------------------- #
# observability
# --------------------------------------------------------------------------- #

def test_every_plan_is_measured():
    plan = plan_for("negative alerts yesterday")
    assert plan.metadata.total_ms > 0
    assert plan.metadata.deterministic_ms >= 0
    assert plan.metadata.request_id
    assert plan.metadata.planner_version


def test_llm_latency_is_recorded_separately():
    generate = scripted({"sentiment": "negative"})
    plan = plan_for("what are people saying about the new ration card portal",
                    generate=generate)
    assert plan.metadata.llm_used is True
    assert plan.metadata.llm_attempts >= 1
    assert plan.metadata.prompt_version == llm_mod.PROMPT_VERSION


def test_the_rules_only_path_is_fast():
    # Not a benchmark: a guard against someone putting a network call in the
    # deterministic path.
    plan = plan_for("negative posts about corruption on x last 7 days")
    assert plan.metadata.llm_used is False
    assert plan.metadata.total_ms < 250


def test_the_gate_turns_on_the_subject_not_on_any_filter():
    """A filter that does not say what a post is ABOUT must not suppress the
    model: sentiment narrows, it does not identify."""
    calls = []

    def counting(prompt, max_tokens, temperature=0.0):
        calls.append(1)
        return "{}"

    plan_for("negative posts about corruption", generate=counting)
    assert calls == []                      # topic known -> rules suffice

    plan_for("negative posts about the new ration card portal", generate=counting)
    assert len(calls) == 2                  # subject unknown -> model + repair


# --------------------------------------------------------------------------- #
# The three queries a user ran in the browser. They are kept together because
# together they pin the boundary between a self-contained question and a
# follow-up: Q1 and Q3 must inherit nothing, Q2 must inherit almost everything.
# --------------------------------------------------------------------------- #

BROWSER_Q1 = "Show me recent high risk posts in Hyderabad"
BROWSER_Q2 = "How many were there this week?"
BROWSER_Q3 = "Compare Hyderabad and Mulugu for high risk content"


def test_browser_q1_recent_is_a_bounded_window_not_all_time():
    """The regression this guards: "recent" was dropped, so a question asking
    for recent posts was answered from the whole corpus."""
    plan = plan_for(BROWSER_Q1)
    assert plan.time_range.kind is TimeKind.LAST_N_DAYS
    assert plan.time_range.n == RECENT_DAYS
    assert plan.time_range.kind is not TimeKind.ALL_TIME
    assert plan.time_range.source is Source.EXPLICIT
    assert plan.location is not None and plan.location.text == "Hyderabad"
    assert plan.filter_values(FilterField.RISK_LEVEL) == ["high"]


def test_browser_q3_is_self_contained_and_keeps_all_time():
    """Both places are named and the risk level is stated, so the question
    stands on its own: no window may be inherited into it."""
    plan = plan_for(BROWSER_Q3)
    assert plan.time_range.kind is TimeKind.ALL_TIME
    assert plan.time_range.source is Source.DEFAULT
    assert plan.filter_values(FilterField.RISK_LEVEL) == ["high"]
    text = plan.normalized_query.lower()
    assert "hyderabad" in text and "mulugu" in text


def test_browser_q2_is_a_follow_up_and_q1_q3_are_not():
    from conversation import cues as cues_mod
    for q, expected in ((BROWSER_Q1, False), (BROWSER_Q2, True), (BROWSER_Q3, False)):
        assert cues_mod.detect(plan_for(q)).follow_up is expected, q


def _converse(*questions):
    """Run a real multi-turn conversation through the store, exactly as the
    pipeline does, and return the last ResolvedQuery."""
    import conversation as conv
    store = conv.InMemoryConversationStore(conv.ConversationConfig())
    state = store.create("tenant-x", "user-x")
    resolved = None
    for q in questions:
        resolved = conv.resolve_query(plan_for(q), state, config=store.config)
        turn = conv.build_turn(state.turn_count + 1, q, resolved, store.config)
        state = store.append(state, turn, expected_sequence=state.turn_count)
    return resolved


def test_browser_q2_inherits_place_and_risk_but_brings_its_own_week():
    resolved = _converse(BROWSER_Q1, BROWSER_Q2)
    plan = resolved.resolved_plan
    assert plan.time_range.kind is TimeKind.THIS_WEEK          # its own, explicit
    assert plan.time_range.source is Source.EXPLICIT
    assert plan.location is not None and plan.location.text == "Hyderabad"
    assert plan.location.source is Source.CONTEXT              # inherited
    assert plan.filter_values(FilterField.RISK_LEVEL) == ["high"]


def test_a_self_contained_question_inherits_no_window():
    """Q3 after Q2: the conversation is holding "this week", and the
    comparison must still be answered over all time."""
    resolved = _converse(BROWSER_Q1, BROWSER_Q2, BROWSER_Q3)
    assert resolved.resolved_plan.time_range.kind is TimeKind.ALL_TIME


# --------------------------------------------------------------------------- #
# Broad situation questions. An officer rarely names the analysis they want:
# "is anything serious going on" is the same request as "what is the situation",
# and both need the aggregate/trend/situation path, not a nearest-record search.
# --------------------------------------------------------------------------- #

SITUATION_QUESTIONS = [
    "What is happening in Hyderabad?",
    "Give me a situation summary for Hyderabad",
    "Is anything serious happening in Hyderabad?",
    "any serious issues in Hyderabad",
    "Anything concerning in Hyderabad?",
    "What's getting attention in Hyderabad?",
    "What should I look at first?",
    "Hyderabad lo emaina serious issue nadustunda?",
    "Hyderabad lo enti jarugutondi?",
    "anything worth attention in Warangal",
    "what needs attention today",
    "are there any problems in Karimnagar",
]


@pytest.mark.parametrize("question", SITUATION_QUESTIONS)
def test_broad_questions_reach_the_situation_path(question):
    plan = plan_for(question)
    assert plan.intent is Intent.SITUATION_ANALYSIS, plan.intent
    for tool in ("hybrid_search", "aggregate", "trend_analysis", "situation_analysis"):
        assert tool in plan.required_tools, (tool, plan.required_tools)


@pytest.mark.parametrize("question", SITUATION_QUESTIONS)
def test_the_situation_path_asks_for_related_content(question):
    """Distinct issues cannot be told apart by ranking; grouping needs this
    tool, and a tool the plan never asks for is never allowed to run."""
    assert "related_content_search" in plan_for(question).required_tools


def test_serious_still_means_high_risk_on_the_situation_path():
    """Routing changed; extraction must not. "serious" is still a risk filter."""
    plan = plan_for("Hyderabad lo emaina serious issue nadustunda?")
    assert plan.intent is Intent.SITUATION_ANALYSIS
    assert plan.filter_values(FilterField.RISK_LEVEL) == ["high"]
    assert plan.location is not None and plan.location.text == "Hyderabad"


@pytest.mark.parametrize("question,intent", [
    # A plain retrieval request must NOT be dragged onto the situation path.
    ("Show me high risk posts in Hyderabad", Intent.FILTERED_SEARCH),
    ("Show me recent high risk posts in Hyderabad", Intent.FILTERED_SEARCH),
    ("negative posts on facebook", Intent.FILTERED_SEARCH),
    # More specific signals still win over the broadened situation phrasing.
    ("How many serious issues in Hyderabad", Intent.AGGREGATION),
    ("Are serious issues increasing in Hyderabad", Intent.TREND_ANALYSIS),
    ("Compare Hyderabad and Mulugu for high risk content", Intent.COMPARISON),
])
def test_narrow_questions_are_not_swept_into_situation_analysis(question, intent):
    assert plan_for(question).intent is intent


# --------------------------------------------------------------------------- #
# Routing fixes from the 30-query officer validation. Each of these was a
# question an officer actually asked that went down the wrong path.
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("question", [
    "How many high risk posts are there in Hyderabad?",
    "How many high risk posts were there in Hyderabad this week?",
    "Are there any high risk posts in Warangal?",
])
def test_a_complete_question_containing_there_is_not_a_follow_up(question):
    """"there" made these look like back-references, so a fully specified
    question was answered with "I don't have that earlier question"."""
    from conversation import cues as cues_mod
    plan = plan_for(question)
    assert cues_mod.detect(plan).follow_up is False, question


def test_an_elliptical_there_is_still_a_follow_up():
    """The fix must not cost us the real case."""
    from conversation import cues as cues_mod
    assert cues_mod.detect(plan_for("How many were there this week?")).follow_up is True


@pytest.mark.parametrize("question", [
    "Hyderabad lo em jarugutundi?",
    "Hyderabad lo enti jarugutondi?",
    "Hyderabad lo attention kavalsina issues emunnayi?",
    "Hyderabad lo emaina serious issue nadustunda?",
    "Hyderabad lo situation enti?",
])
def test_romanised_telugu_situation_questions_reach_the_situation_path(question):
    assert plan_for(question).intent is Intent.SITUATION_ANALYSIS, question


@pytest.mark.parametrize("question", [
    "Hyderabad lo em jarugutundi?",
    "Hyderabad lo attention kavalsina issues emunnayi?",
    "Ekkada ekkuva attention undi?",
])
def test_telugu_grammar_is_never_searched_as_a_concept(question):
    """"lo em jarugutundi" became the thing being searched for, and records
    were judged against a fragment of the officer's own grammar."""
    from query_understanding.deterministic import TELUGU_FUNCTION_WORDS
    for concept in plan_for(question).concepts:
        for word in concept.text.lower().split():
            assert word.strip("?.,!") not in TELUGU_FUNCTION_WORDS, (concept.text, question)


@pytest.mark.parametrize("question", [
    "Which has more high risk posts, Hyderabad or Mulugu?",
    "Which district has more protests, Hyderabad or Warangal?",
])
def test_natural_comparison_phrasing_is_a_comparison(question):
    assert plan_for(question).intent is Intent.COMPARISON, question


@pytest.mark.parametrize("question", [
    "How has high risk activity in Hyderabad changed recently?",
    "How have complaints changed in Warangal?",
])
def test_how_has_x_changed_is_a_trend(question):
    assert plan_for(question).intent is Intent.TREND_ANALYSIS, question


@pytest.mark.parametrize("question", [
    "Women safety related posts ekkuva ekkada unnayi?",
    "Ekkada ekkuva attention undi?",
])
def test_ekkada_asks_which_places_so_it_groups_by_district(question):
    plan = plan_for(question)
    assert plan.intent is Intent.AGGREGATION, question
    assert "districts" in plan.group_by, plan.group_by


@pytest.mark.parametrize("question,topic", [
    ("Show me recent posts about protests in Hyderabad.", "protest"),
    ("Show me posts about protest in Hyderabad.", "protest"),
    ("posts about murders", "murder"),
])
def test_plural_topic_words_resolve_to_the_topic_facet(question, topic):
    """A plural missed the vocabulary and fell through to a 30s concept scan."""
    plan = plan_for(question)
    assert topic in plan.filter_values(FilterField.TOPIC), plan.filters
    assert plan.intent is not Intent.UNKNOWN_CONCEPT


# --------------------------------------------------------------------------- #
# Romanised Telugu "what is happening". Officers spell these a dozen ways, so
# the rule matches the verb stem; enumerating endings only ever covers the
# spellings already seen.
# --------------------------------------------------------------------------- #

HAPPENING_VARIANTS = [
    "hyderabad lo em nadustundhi",
    "Hyderabad lo em nadustundi?",
    "Hyderabad lo em nadustondi?",
    "Hyderabad lo em nadusthundi?",
    "Hyderabad lo em jarugutundi?",
    "Hyderabad lo em jarugutundhi?",
    "Hyderabad lo em jaruguthundi?",
    "Hyderabad lo em jaruguthundhi?",
    "Hyderabad lo em jarugutondi?",
    "Hyderabad lo em jaruguthondi?",
    "Hyderabad lo emaina nadustundha?",
    "Hyderabad lo emaina jarugutundha?",
    "Hyderabad lo enti jarigindi?",
]


@pytest.mark.parametrize("question", HAPPENING_VARIANTS)
def test_every_spelling_of_happening_reaches_situation_analysis(question):
    plan = plan_for(question)
    assert plan.intent is Intent.SITUATION_ANALYSIS, (question, plan.intent)
    assert plan.location is not None and plan.location.text.lower() == "hyderabad"


@pytest.mark.parametrize("question", HAPPENING_VARIANTS)
def test_the_verb_is_never_searched_for(question):
    """"nadustundhi" as a concept sent records to be judged against the
    officer's own verb, and the answer read "checked: nadustundhi 9"."""
    for c in plan_for(question).concepts:
        assert not re.search(r"jarug|jarig|nadus", c.text, re.I), (c.text, question)


@pytest.mark.parametrize("question", HAPPENING_VARIANTS)
def test_happening_questions_are_not_unknown_concepts(question):
    plan = plan_for(question)
    assert plan.intent is not Intent.UNKNOWN_CONCEPT
    assert "unknown_concept_search" not in plan.required_tools


def test_a_spelling_nobody_has_typed_yet_still_routes():
    """The point of matching the stem: the next typist invents another ending."""
    for made_up in ("Hyderabad lo em jarugutunnadi?", "Hyderabad lo em nadusthondhi?"):
        assert plan_for(made_up).intent is Intent.SITUATION_ANALYSIS, made_up


def test_english_words_are_not_swallowed_by_the_telugu_stems():
    """The stems must not eat ordinary questions."""
    for q, want in (("Show me high risk posts in Hyderabad", Intent.FILTERED_SEARCH),
                    ("How many alerts yesterday?", Intent.AGGREGATION)):
        assert plan_for(q).intent is want, q
