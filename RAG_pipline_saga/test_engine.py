"""
test_engine.py — the retrieval engine: views, vocabulary, planner, fusion.

These pin the behaviours that fail SILENTLY. A broken filter does not raise;
it returns a shorter list, and an officer reads that as "there is nothing" when
the truth was "I excluded it".

    python -m pytest test_engine.py -q
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

import planner
import retriever
import views
import vocabulary
from retriever import QuerySpec


# --------------------------------------------------------------------------- #
# views: what reaches the vector
# --------------------------------------------------------------------------- #

ALERT = {
    "_id": "6aaa6128e1f2a6c09f5f848a",
    "tenant_id": "t1",
    "content_id": "9cb84932-1282-4f70-9bf1-05bc7ebbb878",
    "source_id": "8ae51b79-251d-4351-be5c-0ce1e75299ee",
    "analysis_id": "9563f9c4-75f4-42dc-8676-486d48245281",
    "alert_type": "ai_risk",
    "risk_level": "high",
    "is_read": True,
    "is_priority": False,
    "author": "@hydnewshunt",
    "author_handle": "hydnewshunt",
    "platform": "x",
    "content_url": "https://x.com/hydnewshunt/status/123",
    "content_published_at": datetime(2026, 9, 16, tzinfo=timezone.utc),
    "districts": ["Mulugu"],
    "classification_explanation": "Bribery allegation against a constable.",
    "threat_details": {"intent": "Allege corruption", "risk_score": 85,
                       "reasons": ["Bribery allegation against a constable.",
                                   "Risk Score: 85%"]},
    "llm_analysis": {"category": "Defamation", "summary": "Bribery allegation against a constable."},
}


def test_identifiers_never_reach_the_vector():
    # A quarter of the old text was UUIDs. They carry no meaning but do carry
    # position in the embedding.
    text, _ = views.render("alerts", ALERT)
    for noise in ("6aaa6128", "9cb84932", "8ae51b79", "9563f9c4", "t1"):
        assert noise not in text


def test_flags_and_timestamps_never_reach_the_vector():
    text, _ = views.render("alerts", ALERT)
    for noise in ("Is Read", "True", "False", "2026-09-16T"):
        assert noise not in text


def test_the_same_sentence_is_not_embedded_three_times():
    # reasons, classification_explanation and summary all carry it. Embedding
    # it three times tells the model it is three times as important.
    text, _ = views.render("alerts", ALERT)
    assert text.lower().count("bribery allegation against a constable") == 1


def test_a_facet_that_leaked_into_prose_is_removed():
    text, _ = views.render("alerts", ALERT)
    assert "Risk Score: 85%" not in text


def test_structured_fields_become_facets_not_text():
    text, facets = views.render("alerts", ALERT)
    assert facets["risk_level"] == "high"
    assert facets["risk_score"] == 85
    assert facets["handle"] == "hydnewshunt"
    assert facets["url"].endswith("/123")
    assert facets["districts"] == ["Mulugu"]
    # The handle is worth keeping in the text too - it is how people refer to
    # accounts - but the risk number is not prose.
    assert "85" not in text


def test_a_view_is_dramatically_smaller_than_the_document():
    text, _ = views.render("alerts", ALERT)
    from processor import DocumentConverter
    assert len(text) < len(DocumentConverter.convert(ALERT)) / 2


def test_a_grievance_keeps_the_post_it_replies_to():
    # The complaint is often in the post being replied to, not in the reply.
    doc = {
        "content": {"full_text": "@hydcitypolice please look into this"},
        "context": {"in_reply_to": {"content": {"full_text": "Bribe demanded at the checkpost"}}},
        "posted_by": {"handle": "@citizen1"},
        "platform": "x",
        "tweet_url": "https://x.com/citizen1/status/9",
    }
    text, facets = views.render("grievances", doc)
    assert "Bribe demanded at the checkpost" in text
    assert facets["handle"] == "citizen1"


def test_an_empty_document_yields_no_text_rather_than_labels():
    text, _ = views.render("contents", {"_id": "x", "tenant_id": "t1"})
    assert text.strip() == ""


# --------------------------------------------------------------------------- #
# vocabulary: the two axes the data lacks
# --------------------------------------------------------------------------- #

def test_topics_are_tagged_from_meaning_not_field_names():
    assert "corruption" in vocabulary.topics_in("constable demanded a bribe")
    assert "sexual_violence" in vocabulary.topics_in("rape case registered")
    assert "robbery" in vocabulary.topics_in("chain snatching near the market")


def test_topic_terms_match_whole_words_only():
    # "rape" inside "draped" would tag a fashion post as sexual violence.
    assert vocabulary.topics_in("the statue was draped in cloth") == []
    assert vocabulary.topics_in("scampi for dinner") == []


def test_indic_script_terms_are_matched():
    # \b is defined on ASCII word characters and never matches between two
    # Telugu letters, so these need substring matching.
    assert "corruption" in vocabulary.topics_in("పోలీస్ అవినీతి")
    assert "sexual_violence" in vocabulary.topics_in("बलात्कार का मामला")


def test_targets_say_who_a_post_is_about():
    assert "police" in vocabulary.targets_in("the police did nothing")
    assert "bjp" in vocabulary.targets_in("BJP leaders were present")
    assert "government" in vocabulary.targets_in("the state government failed")


def test_target_is_separate_from_stance():
    # Praise and attack both concern BJP. Collapsing them here would make a
    # supportive post indistinguishable from a hostile one.
    assert vocabulary.targets_in("BJP did excellent work") == \
           vocabulary.targets_in("BJP is destroying this state")


def test_tagging_returns_both_axes():
    tags = vocabulary.tag("BJP leader accused of taking a bribe")
    assert "bjp" in tags["targets"]
    assert "corruption" in tags["topics"]


# --------------------------------------------------------------------------- #
# planner
# --------------------------------------------------------------------------- #

TOPICS = vocabulary.query_topic_map()
TARGETS = vocabulary.query_target_map()


def _plan(q):
    return planner.plan(q, topic_map=TOPICS, target_map=TARGETS)


def test_no_date_means_all_time():
    # The old pipeline defaulted to 7 days, so a question with no date silently
    # excluded everything older than a week and looked like missing data.
    assert _plan("negative posts about corruption").since is None


def test_a_stated_window_is_honoured():
    spec = _plan("negative posts in the last 30 days")
    assert spec.since is not None
    age = datetime.now(timezone.utc) - spec.since
    assert timedelta(days=29) < age < timedelta(days=31)


def test_the_default_limit_is_a_readable_list():
    assert _plan("show me negative posts").limit >= 10


def test_an_explicit_count_is_honoured():
    assert _plan("show me 20 grievances").limit == 20
    assert _plan("at least 10 posts against police").limit == 10


def test_highest_risk_sorts_rather_than_filters():
    # Filtering to risk_level=high would drop a 95 that was never labelled
    # high. The question asks for an ordering.
    spec = _plan("what are the highest risk alerts")
    assert spec.sort == "risk"
    assert spec.risk_levels == []


def test_high_risk_filters():
    assert _plan("show me high-risk alerts").risk_levels == ["high"]


def test_sentiment_and_target_combine():
    spec = _plan("negative posts against police")
    assert spec.sentiment == "negative"
    assert "police" in spec.targets


def test_topic_and_target_combine():
    spec = _plan("posts against BJP about corruption")
    assert "bjp" in spec.targets
    assert "corruption" in spec.topics


def test_tagging_a_handle_is_not_authored_by_it():
    spec = _plan("posts tagging @TelanganaDGP")
    assert "TelanganaDGP" in spec.tagged
    assert spec.handles == []


def test_platform_and_kind_are_picked_up():
    spec = _plan("facebook grievances")
    assert spec.platforms == ["facebook"]
    assert spec.kinds == ["grievance"]


def test_a_count_question_is_recognised():
    assert planner.is_count_question("how many alerts are there")
    assert not planner.is_count_question("show me the alerts")


def test_describe_names_the_constraints_that_were_applied():
    said = planner.describe(_plan("negative facebook posts against police last week"))
    assert "negative" in said and "police" in said and "facebook" in said
    assert "all time" not in said


def test_describe_says_all_time_when_unbounded():
    assert "all time" in planner.describe(_plan("posts about corruption"))


# --------------------------------------------------------------------------- #
# filters: the tenant and district boundary survives every path
# --------------------------------------------------------------------------- #

def test_every_filter_carries_the_tenant():
    q = retriever.build_filter(QuerySpec(sentiment="negative"), "t1", None)
    assert q["metadata.tenant_id"] == "t1"


def test_an_officer_with_no_districts_matches_nothing():
    q = retriever.build_filter(QuerySpec(), "t1", [])
    assert q["metadata.districts"] == {"$in": []}


def test_a_state_admin_is_unrestricted():
    q = retriever.build_filter(QuerySpec(), "t1", None)
    assert "metadata.districts" not in q and "$and" not in q


def test_an_officer_sees_their_districts_plus_tenant_wide():
    q = retriever.build_filter(QuerySpec(), "t1", ["Mulugu"])
    ors = q["$and"][0]["$or"]
    assert {"metadata.districts": {"$in": ["Mulugu"]}} in ors
    assert {"metadata.districts": {"$exists": False}} in ors


def test_facets_become_the_query():
    spec = QuerySpec(sentiment="negative", risk_levels=["high"],
                     topics=["corruption"], targets=["police"],
                     platforms=["x"], min_risk_score=50)
    q = retriever.build_filter(spec, "t1", None)
    assert q["metadata.sentiment"] == "negative"
    assert q["metadata.risk_level"] == {"$in": ["high"]}
    assert q["metadata.topics"] == {"$in": ["corruption"]}
    assert q["metadata.targets"] == {"$in": ["police"]}
    assert q["metadata.risk_score"] == {"$gte": 50}


def test_an_unfiltered_spec_does_not_run_a_structured_query():
    # Returning the newest N of everything for a question with no constraints
    # is noise dressed as evidence.
    assert QuerySpec(text="hello").is_filtered() is False
    assert QuerySpec(sentiment="negative").is_filtered() is True


# --------------------------------------------------------------------------- #
# fusion
# --------------------------------------------------------------------------- #

def _hit(doc_id, via, text="t"):
    return {"text": text, "metadata": {"document_id": doc_id}, "via": via}


def test_agreement_between_retrievers_outranks_a_single_top_hit():
    structured = [_hit("b", "structured"), _hit("a", "structured")]
    semantic = [_hit("a", "semantic")]
    out = retriever.fuse(structured, semantic, limit=2)
    assert out[0]["metadata"]["document_id"] == "a"
    assert out[0]["via"] == "semantic+structured"


def test_a_record_is_never_returned_twice():
    out = retriever.fuse([_hit("a", "structured")], [_hit("a", "lexical")], limit=5)
    assert len(out) == 1


def test_fusion_respects_the_limit():
    many = [_hit(str(i), "structured") for i in range(50)]
    assert len(retriever.fuse(many, limit=10)) == 10


def test_evidence_rows_carry_a_link():
    rows = retriever.evidence([{
        "text": "x",
        "metadata": {"handle": "h", "url": "https://x.com/h/status/1",
                     "platform": "x", "risk_score": 85},
        "via": "structured",
    }])
    assert rows[0]["url"] == "https://x.com/h/status/1"
    assert rows[0]["risk_score"] == 85


# --------------------------------------------------------------------------- #
# regressions found against real data
# --------------------------------------------------------------------------- #

def test_a_moderation_label_is_not_a_topic():
    # An alert embeds its analysis reasoning, which says "this post constitutes
    # hate speech" about any post at all. Treating that phrase as a topic tagged
    # 134 of 238 alerts communal, including a neutral item about bus stations.
    # Topic terms name what a post is ABOUT, never a classifier's verdict.
    verdict = "The post constitutes hate speech under platform policy."
    assert "communal" not in vocabulary.topics_in(verdict)

    # The genuine subject words still tag.
    assert "communal" in vocabulary.topics_in("communal tension after the rally")
    assert "communal" in vocabulary.topics_in("riots broke out in the old city")


def test_multi_word_topics_are_askable():
    # Dropping phrases from the query map left "complaints about water supply"
    # with no topic at all, so it fell through to fuzzy retrieval.
    topics = vocabulary.query_topic_map()
    spec = planner.plan("facebook complaints about water supply", topic_map=topics)
    assert "civic" in spec.topics

    spec = planner.plan("chain snatching cases", topic_map=topics)
    assert "robbery" in spec.topics


def test_multi_word_targets_are_askable():
    targets = vocabulary.query_target_map()
    spec = planner.plan("posts about the state government", target_map=targets)
    assert "government" in spec.targets


# --------------------------------------------------------------------------- #
# routing: records vs breakdown vs trend
# --------------------------------------------------------------------------- #

def test_a_who_question_asks_for_a_breakdown_not_records():
    # Handing 15 rows to a model and asking which handle posts most gives an
    # answer computed from 15 when the truth spans hundreds.
    assert planner.wants_breakdown("which handles post the most negative content") == "handle"
    assert planner.wants_breakdown("who is posting about corruption") == "handle"


def test_a_breakdown_names_its_axis():
    assert planner.wants_breakdown("break down grievances by platform") == "platform"
    assert planner.wants_breakdown("split alerts by district") == "districts"
    assert planner.wants_breakdown("distribution by category") == "category"


def test_a_plain_request_for_posts_is_not_a_breakdown():
    assert planner.wants_breakdown("show me negative posts about corruption") is None
    assert planner.wants_breakdown("what are the highest risk alerts") is None


def test_trend_questions_are_recognised():
    assert planner.wants_trend("are communal posts rising")
    assert planner.wants_trend("compare this month with last month")
    assert not planner.wants_trend("show me communal posts")


# --------------------------------------------------------------------------- #
# the LLM planner: only called when needed, never trusted blindly
# --------------------------------------------------------------------------- #

import llm_planner  # noqa: E402


def test_the_model_is_not_called_when_rules_already_answered():
    calls = []

    def _gen(prompt, max_tokens):
        calls.append(prompt)
        return "{}"

    llm_planner.plan("negative posts against police", generate=_gen,
                     topic_map=TOPICS, target_map=TARGETS)
    assert calls == [], "rules covered it; the model call is pure latency"


def test_the_model_is_called_when_rules_found_nothing():
    calls = []

    def _gen(prompt, max_tokens):
        calls.append(prompt)
        return '{"sentiment":"negative","targets":["police"]}'

    spec = llm_planner.plan("what are people saying about how officers behave",
                            generate=_gen, topic_map=TOPICS, target_map=TARGETS)
    assert len(calls) == 1
    assert spec.sentiment == "negative"
    assert "police" in spec.targets


def test_json_survives_fences_and_preamble():
    # Small models wrap output in markdown or prefix it with "Here is".
    assert llm_planner.parse('```json\n{"sentiment":"negative"}\n```') == {"sentiment": "negative"}
    assert llm_planner.parse('Here is the JSON: {"sentiment":"positive"} hope that helps') \
        == {"sentiment": "positive"}
    assert llm_planner.parse("I cannot answer that") == {}
    assert llm_planner.parse("") == {}


def test_invented_values_are_dropped_not_queried():
    # A model asked for topics will answer "police_brutality". Querying an
    # unknown tag returns nothing, which reads as "no such posts" rather than
    # "I made that category up".
    spec = llm_planner.enrich(QuerySpec(),
                              {"topics": ["police_brutality", "corruption"],
                               "targets": ["the_mafia", "bjp"]})
    assert spec.topics == ["corruption"]
    assert spec.targets == ["bjp"]


def test_the_model_never_overwrites_what_rules_established():
    # Regex reads an explicit handle and date exactly; a model paraphrases them.
    spec = QuerySpec(sentiment="positive", topics=["traffic"], handles=["TelanganaDGP"])
    llm_planner.enrich(spec, {"sentiment": "negative", "topics": ["corruption"]})
    assert spec.sentiment == "positive"
    assert spec.topics == ["traffic"]
    assert spec.handles == ["TelanganaDGP"]


def test_an_unreachable_model_degrades_instead_of_failing():
    def _boom(prompt, max_tokens):
        raise ConnectionError("endpoint down")

    spec = llm_planner.plan("what are people saying about the checkposts",
                            generate=_boom, topic_map=TOPICS, target_map=TARGETS)
    assert isinstance(spec, QuerySpec), "a down model must not fail the question"
