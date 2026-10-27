"""The same question in any script must mean the same thing.

The defect these cover: the planner matched its vocabulary with ASCII word
boundaries, and the query-side topic and target maps dropped every term without
a Latin letter. So "How many grievances are there?" counted the 190 grievances
and "ఎన్ని ఫిర్యాదులు ఉన్నాయి?" counted all 7,214 records in the tenant. Same
tenant, same question, two different numbers, and nothing in the answer said
which one was the subject.

The fix is one configured layer, not a longer regex — query_vocabulary.json,
matched on tokens from the shared Unicode tokenizer. These tests are therefore
about equivalence between languages, not about specific patterns.
"""

import json

import pytest

import vocabulary
from query_understanding import understand
from query_understanding.models import FilterField, Intent, Shape


def plan_for(question):
    plan, validation = understand(question, allow_llm=False)
    return plan, validation


def filters_of(plan):
    return {(f.field.value, str(f.value)) for f in plan.filters}


def semantics(question):
    """Everything about a question that must not depend on its language."""
    plan, validation = plan_for(question)
    return {
        "intent": plan.intent,
        "shape": plan.shape,
        "metric": plan.metric,
        "group_by": tuple(plan.group_by),
        "filters": frozenset(filters_of(plan)),
        "location": plan.location.text if plan.location else None,
        "valid": validation.valid,
    }


# ====================================================================== #
# the reported defect: one question, three scripts, one meaning
# ====================================================================== #

COUNT_GRIEVANCES = [
    pytest.param("How many grievances are there?", id="en"),
    pytest.param("ఎన్ని ఫిర్యాదులు ఉన్నాయి?", id="te-script"),
    pytest.param("कितनी शिकायतें हैं?", id="hi-script"),
]


@pytest.mark.parametrize("question", COUNT_GRIEVANCES)
def test_a_count_of_grievances_is_the_same_plan_in_every_script(question):
    plan, validation = plan_for(question)
    assert validation.valid, [e.message for e in validation.errors]
    assert plan.intent is Intent.AGGREGATION
    assert plan.shape is Shape.ANALYTICAL
    assert plan.metric == "count"
    assert ("kind", "grievance") in filters_of(plan), (
        "without the subject this counts every record in the tenant")


def test_the_three_scripts_agree_on_every_field_that_decides_the_answer():
    got = [semantics(q.values[0]) for q in COUNT_GRIEVANCES]
    assert got[0] == got[1] == got[2], (
        "a question that differs only in script must not produce a different "
        f"query: {got}")


def test_the_subject_is_what_narrows_the_count():
    # The regression this guards: "kind" present but ignored is the same bug as
    # "kind" absent, so the assertion is about the filter reaching the plan.
    with_subject = plan_for("ఎన్ని ఫిర్యాదులు ఉన్నాయి?")[0]
    without_subject = plan_for("ఎన్ని ఉన్నాయి?")[0]
    assert ("kind", "grievance") in filters_of(with_subject)
    assert not any(f.field is FilterField.KIND for f in without_subject.filters)


# ====================================================================== #
# language coverage: script, romanised, and mixed
# ====================================================================== #

@pytest.mark.parametrize("question,expected", [
    # English
    ("How many alerts are there?", Intent.AGGREGATION),
    ("What is happening in Hyderabad?", Intent.SITUATION_ANALYSIS),
    # Telugu script
    ("ఎన్ని హెచ్చరికలు ఉన్నాయి?", Intent.AGGREGATION),
    ("హైదరాబాద్ లో ఏం జరుగుతోంది?", Intent.SITUATION_ANALYSIS),
    ("హెచ్చరికలు పెరిగాయా?", Intent.TREND_ANALYSIS),
    ("హైదరాబాద్ ములుగు పోల్చు", Intent.COMPARISON),
    # Hindi script
    ("कितने अलर्ट हैं?", Intent.AGGREGATION),
    ("हैदराबाद में क्या हो रहा है?", Intent.SITUATION_ANALYSIS),
    ("शिकायतें बढ़ीं?", Intent.TREND_ANALYSIS),
    # Tenglish (romanised Telugu) — already worked, must keep working
    ("Hyderabad lo em nadustundhi?", Intent.SITUATION_ANALYSIS),
    ("enni firyadulu unnayi?", Intent.AGGREGATION),
    # mixed language in one question
    ("Hyderabad lo ఎన్ని ఫిర్యాదులు ఉన్నాయి?", Intent.AGGREGATION),
    ("ఫిర్యాదులు in Hyderabad", Intent.FILTERED_SEARCH),
])
def test_intent_is_read_from_the_question_whatever_script_it_is_in(question, expected):
    plan, validation = plan_for(question)
    assert plan.intent is expected, (
        f"{question!r} read as {plan.intent.value}")
    assert validation.valid, [e.message for e in validation.errors]


@pytest.mark.parametrize("question,place", [
    ("హైదరాబాద్ లో ఏం జరుగుతోంది?", "Hyderabad"),
    ("హైదరాబాద్‌లో ఎన్ని ఫిర్యాదులు?", "Hyderabad"),   # case ending attached
    ("करीमनगर में क्या हो रहा है?", "Karimnagar"),
    ("ములుగు లో ఏం జరుగుతోంది?", "Mulugu"),
    ("వరంగల్ లో ఫిర్యాదులు", "Warangal"),
    ("What is happening in Hyderabad?", "Hyderabad"),
])
def test_a_place_named_in_any_script_is_the_same_place(question, place):
    plan, _ = plan_for(question)
    assert plan.location is not None, f"{question!r} named no place"
    assert plan.location.text == place


@pytest.mark.parametrize("question,topic", [
    ("అవినీతి గురించి ఫిర్యాదులు", "corruption"),
    ("भ्रष्टाचार की शिकायतें", "corruption"),
    ("హత్య కేసులు", "murder"),
    ("चोरी की शिकायतें", "robbery"),
    ("corruption complaints", "corruption"),
])
def test_a_topic_named_in_any_script_is_the_same_topic(question, topic):
    plan, _ = plan_for(question)
    assert ("topic", topic) in filters_of(plan), (
        f"{question!r} produced {filters_of(plan)}")


@pytest.mark.parametrize("question,target", [
    ("పోలీసు మీద ఫిర్యాదులు", "police"),
    ("पुलिस के खिलाफ शिकायतें", "police"),
    ("ప్రభుత్వం గురించి", "government"),
    ("complaints against police", "police"),
])
def test_a_target_named_in_any_script_is_the_same_target(question, target):
    plan, _ = plan_for(question)
    assert ("target", target) in filters_of(plan)


@pytest.mark.parametrize("question,facet", [
    ("ఫిర్యాదులు ఏ జిల్లాలో ఎక్కువ?", "districts"),
    ("किस जिले में ज्यादा शिकायतें हैं?", "districts"),
    ("Where are grievances concentrated?", "districts"),
])
def test_a_facet_named_in_any_script_is_grouped_on(question, facet):
    plan, _ = plan_for(question)
    assert facet in plan.group_by, f"{question!r} grouped by {plan.group_by}"


@pytest.mark.parametrize("question,level", [
    ("గంభీర హెచ్చరికలు", "high"),
    ("गंभीर शिकायतें", "high"),
    ("high risk alerts", "high"),
])
def test_a_risk_level_named_in_any_script_is_the_same_level(question, level):
    plan, _ = plan_for(question)
    assert ("risk_level", level) in filters_of(plan)


# ====================================================================== #
# officer phrasing: the question as it is actually typed
# ====================================================================== #

@pytest.mark.parametrize("question", [
    "ఫిర్యాదులు చూపించు",              # "show complaints"
    "शिकायतें दिखाओ",
    "హైదరాబాద్ ఫిర్యాదులు",
    "अलर्ट दिखाओ",
])
def test_a_bare_imperative_still_finds_its_subject(question):
    plan, validation = plan_for(question)
    assert validation.valid, [e.message for e in validation.errors]
    assert any(f.field is FilterField.KIND for f in plan.filters), (
        f"{question!r} lost its subject: {filters_of(plan)}")


@pytest.mark.parametrize("question", [
    "ఎన్ని ఫిర్యాదులు ఉన్నాయి?",
    "हैदराबाद में क्या हो रहा है?",
])
def test_grammar_is_never_searched_for_as_a_subject(question):
    # "ఉన్నాయి" and "है" are grammar. Left in, they became the thing being
    # searched for and records were judged against the officer's own verb.
    plan, _ = plan_for(question)
    texts = {c.text for c in plan.concepts}
    for grammar in ("ఉన్నాయి", "ఉన్న", "है", "हैं", "क्या", "ఏం"):
        assert grammar not in texts, f"{grammar!r} became a concept"


# ====================================================================== #
# the vocabulary is configuration, and behaves like it
# ====================================================================== #

def test_the_vocabulary_file_is_data_the_loader_validates():
    vocab = vocabulary.query_vocabulary()
    assert vocab, "vocabulary did not load"
    for section in ("subjects", "frames", "places", "group_by", "function_words"):
        assert section in vocab, f"{section} missing"
    # Commentary keys are not values: a "_doc" entry must never become a
    # canonical filter value.
    for section, table in vocab.items():
        for value in table:
            assert not value.startswith("_"), f"{section}.{value} is documentation"


def test_every_configured_frame_maps_to_an_intent():
    from query_understanding import deterministic
    for name in vocabulary.query_vocabulary()["frames"]:
        assert name in deterministic._FRAME_INTENT, (
            f"frame {name!r} is configured but no intent executes it")


def test_every_configured_place_is_in_the_gazetteer():
    from query_understanding import deterministic
    for canonical in vocabulary.query_vocabulary()["places"]:
        assert canonical in deterministic.TELANGANA_PLACES, (
            f"place alias {canonical!r} resolves to a name the gazetteer does "
            f"not know, so its type and district scope would be missing")


def test_every_configured_facet_is_one_the_aggregator_supports():
    from query_understanding import deterministic
    known = {facet for _, facet in deterministic._GROUP_HINTS}
    for facet in vocabulary.query_vocabulary()["group_by"]:
        assert facet in known, f"group_by {facet!r} is not a facet in use"


def test_a_missing_vocabulary_file_degrades_instead_of_failing():
    original = vocabulary.QUERY_VOCABULARY_PATH
    try:
        vocabulary.QUERY_VOCABULARY_PATH = "no-such-file.json"
        vocabulary.reload_query_vocabulary()
        assert vocabulary.query_vocabulary() == {}
        assert vocabulary.matches("subjects", "ఎన్ని ఫిర్యాదులు") == []
        # English still works: the rules never depended on the file.
        plan, validation = plan_for("How many grievances are there?")
        assert validation.valid and plan.intent is Intent.AGGREGATION
    finally:
        vocabulary.QUERY_VOCABULARY_PATH = original
        vocabulary.reload_query_vocabulary()


def test_a_malformed_vocabulary_file_degrades_instead_of_failing(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("{ this is not json", encoding="utf-8")
    original = vocabulary.QUERY_VOCABULARY_PATH
    try:
        vocabulary.QUERY_VOCABULARY_PATH = str(bad)
        vocabulary.reload_query_vocabulary()
        assert vocabulary.query_vocabulary() == {}
        assert vocabulary.frame("ఎన్ని ఫిర్యాదులు") is None
    finally:
        vocabulary.QUERY_VOCABULARY_PATH = original
        vocabulary.reload_query_vocabulary()


def test_a_deployment_can_supply_its_own_vocabulary(tmp_path):
    # The seam a non-police deployment needs: new domain terms, no code change.
    own = tmp_path / "own.json"
    own.write_text(json.dumps({
        "version": "test@v1",
        "subjects": {"ticket": ["టికెట్*", "ticket", "tickets"]},
        "frames": {"count": ["ఎన్ని"]},
    }), encoding="utf-8")
    original = vocabulary.QUERY_VOCABULARY_PATH
    try:
        vocabulary.QUERY_VOCABULARY_PATH = str(own)
        vocabulary.reload_query_vocabulary()
        assert vocabulary.matches("subjects", "ఎన్ని టికెట్లు ఉన్నాయి?") == ["ticket"]
        assert vocabulary.frame("ఎన్ని టికెట్లు ఉన్నాయి?") == "count"
        # and the police terms are gone, because the file replaced them
        assert vocabulary.matches("subjects", "ఎన్ని ఫిర్యాదులు") == []
    finally:
        vocabulary.QUERY_VOCABULARY_PATH = original
        vocabulary.reload_query_vocabulary()


def test_a_short_stem_is_refused_as_a_prefix_rule(tmp_path):
    # "ఏ*" would match most of the language. A rule that matches everything is
    # worse than a missing rule.
    own = tmp_path / "own.json"
    own.write_text(json.dumps({
        "subjects": {"everything": ["ఏ*", "పో*"]},
    }), encoding="utf-8")
    original = vocabulary.QUERY_VOCABULARY_PATH
    try:
        vocabulary.QUERY_VOCABULARY_PATH = str(own)
        vocabulary.reload_query_vocabulary()
        assert vocabulary.matches("subjects", "ఏం జరుగుతోంది") == []
    finally:
        vocabulary.QUERY_VOCABULARY_PATH = original
        vocabulary.reload_query_vocabulary()


def test_unknown_sections_are_asked_for_safely():
    assert vocabulary.matches("no_such_section", "anything") == []
    assert vocabulary.matches("subjects", "") == []
    assert vocabulary.matches("subjects", None) == []


# ====================================================================== #
# the gazetteer answers in both scripts, and the two layers agree
# ====================================================================== #

def test_every_place_in_the_gazetteer_is_askable_in_both_scripts():
    # 37 of 47 places had no Devanagari alias, so a Hindi question naming a
    # district was answered for the whole state instead.
    import io
    import json
    import re
    import os
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "enrichment", "gazetteer_telangana.json")
    entries = json.load(io.open(path, encoding="utf-8"))["entries"]
    missing = {"te": [], "hi": []}
    for entry in entries:
        names = list(entry.get("aliases") or []) + [entry["name"]]
        if not any(re.search(r"[\u0c00-\u0c7f]", n) for n in names):
            missing["te"].append(entry["name"])
        if not any(re.search(r"[\u0900-\u097f]", n) for n in names):
            missing["hi"].append(entry["name"])
    assert missing == {"te": [], "hi": []}, missing


def test_no_alias_mixes_two_scripts():
    # A typo like "गचीबowली" matches nothing and hides the gap it was meant
    # to close.
    import io
    import json
    import re
    import os
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "enrichment", "gazetteer_telangana.json")
    for entry in json.load(io.open(path, encoding="utf-8"))["entries"]:
        for alias in entry.get("aliases") or []:
            indic = re.search(r"[\u0900-\u097f\u0c00-\u0c7f]", alias)
            latin = re.search(r"[A-Za-z]", alias)
            assert not (indic and latin), f"{entry['name']}: mixed-script alias {alias!r}"


@pytest.mark.parametrize("question,place", [
    ("संगारेड्डी में क्या हो रहा है?", "Sangareddy"),
    ("मुलुगु में क्या हो रहा है?", "Mulugu"),
    ("निर्मल में शिकायतें", "Nirmal"),
    ("सिकंदराबाद में अलर्ट", "Secunderabad"),
    ("సంగారెడ్డిలో ఏం జరుగుతోంది?", "Sangareddy"),
])
def test_a_hindi_or_telugu_question_is_scoped_to_the_district_it_names(question, place):
    from enrichment.plan import enrich_plan
    plan, _ = understand(question, allow_llm=False)
    enriched, _ = enrich_plan(plan)
    assert enriched.location is not None, f"{question!r} named no place"
    assert enriched.location.text == place


# ====================================================================== #
# the vocabulary is part of what a cached plan depends on
# ====================================================================== #

def test_a_vocabulary_change_invalidates_a_cached_plan(tmp_path):
    # Otherwise the plan produced by the OLD terms keeps being served, which is
    # the same stale-cache failure as an unbumped analysis version.
    from orchestrator import pipeline
    before = pipeline._understanding_version()
    own = tmp_path / "own.json"
    own.write_text(json.dumps({"version": "test@v9",
                               "subjects": {"ticket": ["ticket"]}}), encoding="utf-8")
    original = vocabulary.QUERY_VOCABULARY_PATH
    try:
        vocabulary.QUERY_VOCABULARY_PATH = str(own)
        vocabulary.reload_query_vocabulary()
        pipeline._understanding_version.cache_clear()
        after = pipeline._understanding_version()
        assert before != after, "the cache key did not change with the vocabulary"
    finally:
        vocabulary.QUERY_VOCABULARY_PATH = original
        vocabulary.reload_query_vocabulary()
        pipeline._understanding_version.cache_clear()


def test_the_understanding_version_names_both_its_inputs():
    from orchestrator import pipeline
    import query_understanding as qu
    version = pipeline._understanding_version()
    assert qu.PLAN_VERSION in version
    assert vocabulary.query_vocabulary_version() in version


def test_an_edited_vocabulary_file_changes_its_version(tmp_path):
    a = tmp_path / "a.json"
    a.write_text(json.dumps({"version": "same@v1", "subjects": {"x": ["one"]}}),
                 encoding="utf-8")
    original = vocabulary.QUERY_VOCABULARY_PATH
    try:
        vocabulary.QUERY_VOCABULARY_PATH = str(a)
        vocabulary.reload_query_vocabulary()
        first = vocabulary.query_vocabulary_version()
        # Same declared version, different terms: the content must still count,
        # or an edit without a version bump would serve stale plans.
        a.write_text(json.dumps({"version": "same@v1", "subjects": {"x": ["two"]}}),
                     encoding="utf-8")
        vocabulary.reload_query_vocabulary()
        assert vocabulary.query_vocabulary_version() != first
    finally:
        vocabulary.QUERY_VOCABULARY_PATH = original
        vocabulary.reload_query_vocabulary()
