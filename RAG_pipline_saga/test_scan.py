"""
Tests for on-demand concept scans: routing, the judge, its cache, and the
funnel end to end. No MongoDB, GPU or model needed -- collections, the verdict
store and the LLM are faked.
"""

import os
import time
from datetime import datetime, timedelta, timezone

os.environ["RERANKER_ENABLED"] = "false"
os.environ["SCAN_SUMMARY"] = "false"

import concepts
import expander
import judge
import scan


# --------------------------------------------------------------------------- #
# fakes
# --------------------------------------------------------------------------- #

class _Cursor(list):
    def sort(self, *a, **k):
        return self

    def limit(self, n):
        return _Cursor(self[:n])


class FakeWindow:
    """A vector collection. Records every filter it is given."""

    def __init__(self, docs):
        self.docs = docs
        self.queries = []

    def count_documents(self, q):
        self.queries.append(q)
        return len(self.docs)

    def find(self, q, proj=None):
        self.queries.append(q)
        return _Cursor(self.docs)


class FakeVerdicts:
    def __init__(self):
        self.rows = {}

    def find(self, q):
        ids = q["_id"]["$in"]
        return [self.rows[i] for i in ids if i in self.rows]

    def bulk_write(self, ops, ordered=False):
        for op in ops:
            doc = op._doc
            self.rows[doc["_id"]] = doc

    def find_one(self, q):
        return None

    def replace_one(self, *a, **k):
        pass


class FakeDB(dict):
    def __missing__(self, name):
        self[name] = FakeVerdicts()
        return self[name]


def _doc(i, text, days_ago=1):
    return {
        "text": text,
        "metadata": {
            "document_id": f"d{i}", "chunk_id": f"d{i}::0", "content_hash": f"h{i}",
            "source_collection": "contents", "kind": "content", "handle": f"user{i}",
            "platform": "x", "url": f"https://x.com/p/{i}",
            "published_at": datetime.now(timezone.utc) - timedelta(days=days_ago),
        },
    }


def _records(texts):
    return [{"key": f"k{i}", "text": t} for i, t in enumerate(texts)]


class ScriptedLLM:
    """Answers judge prompts: a record matches when it contains *word*."""

    def __init__(self, word="temple"):
        self.word = word
        self.calls = 0

    def __call__(self, prompt, max_tokens):
        self.calls += 1
        if "Return ONLY a JSON object: {\"terms\"" in prompt:
            return '{"terms": []}'
        body = prompt.split("RECORDS\n", 1)[1]
        items = []
        for line in body.splitlines():
            if not line.startswith("["):
                continue
            idx = int(line[1:line.index("]")])
            hit = self.word in line.lower()
            items.append({"id": idx, "match": ["communal"] if hit else [],
                          "why": "religious clash" if hit else ""})
        import json
        return json.dumps({"results": items})


# --------------------------------------------------------------------------- #
# routing
# --------------------------------------------------------------------------- #

def test_an_untagged_concept_is_scanned():
    assert scan.route("show me communal content from last 7 days") == {
        "mode": "concept", "labels": ["communal"]}


def test_which_a_and_which_b_is_a_group_scan():
    got = scan.route("tell me which are the posts that are related to communal "
                     "and which are related to international national local like that")
    assert got == {"mode": "group",
                   "labels": ["communal", "international", "national", "local"]}


def test_classify_into_is_a_group_scan():
    got = scan.route("classify these posts into international, national, state and local")
    assert got["labels"] == ["international", "national", "state", "local"]


def test_a_single_which_is_not_a_group():
    assert concepts.group_labels("which posts are communal") == []


def test_pure_filters_stay_with_the_engine():
    for q in ("top 10 high risk alerts", "high risk alerts today", "latest grievances"):
        assert scan.route(q) is None, q


def test_aggregates_stay_with_the_engine():
    for q in ("how many negative posts last week",
              "which handles post the most negative content",
              "are corruption complaints rising"):
        assert scan.route(q) is None, q


def test_a_listed_concept_keeps_its_items_apart():
    assert concepts.concept("posts related to rapes, robbery or corruption with links") \
        == "rapes, robbery, corruption"


def test_the_concept_cache_key_ignores_order_and_case():
    assert concepts.cache_key("Communal Violence") == concepts.cache_key("violence communal")


def test_hard_filters_keep_the_date_but_drop_keyword_topics():
    spec = scan.hard_spec("negative communal posts about corruption last 7 days")
    assert spec.since is not None
    assert spec.sentiment == "negative"
    # A keyword tag must not pre-filter: the judge exists for posts without it.
    assert spec.topics == [] and spec.targets == []


# --------------------------------------------------------------------------- #
# expansion
# --------------------------------------------------------------------------- #

def test_expansion_seeds_every_listed_topic_without_a_model():
    terms = [t.lower() for t in expander.expand("rapes, robbery, corruption")]
    assert "rape" in terms and "theft" in terms and "bribe" in terms
    assert "rapes, robbery, corruption" not in terms


def test_indic_terms_match_as_substrings():
    recs = [{"key": "a", "text": "ఇక్కడ అల్లర్లు జరిగాయి"}, {"key": "b", "text": "bus stand"}]
    assert scan.lexical_scores(recs, ["అల్లర్లు"]) == {"a": 1}


def test_latin_terms_match_whole_words():
    recs = [{"key": "a", "text": "a draped cloth"}, {"key": "b", "text": "rape case filed"}]
    assert scan.lexical_scores(recs, ["rape"]) == {"b": 1}


def test_fusion_keeps_unscored_records_at_the_back():
    recs = [{"key": k} for k in "abc"]
    order = [r["key"] for r in scan.rrf(recs, {"c": 3}, {"c": 0.9, "b": 0.5})]
    assert order == ["c", "b", "a"]


# --------------------------------------------------------------------------- #
# the judge
# --------------------------------------------------------------------------- #

def test_parse_accepts_label_text_index_and_bool():
    labels = ["communal", "local"]
    raw = ('{"results": [{"id": 1, "match": ["Communal"], "why": "x"},'
           ' {"id": 2, "match": [2]}, {"id": 3, "match": []}]}')
    got = judge._parse(raw, 3, labels)
    assert got[1]["labels"] == ["communal"]
    assert got[2]["labels"] == ["local"]
    assert got[3]["labels"] == []
    assert judge._parse('{"results":[{"id":1,"match":[true]}]}', 1, ["communal"])[1]["labels"] == ["communal"]


def test_an_invented_label_is_dropped():
    got = judge._parse('{"results":[{"id":1,"match":["police_brutality"]}]}', 1, ["communal"])
    assert got[1]["labels"] == []


def test_a_record_missing_from_the_reply_is_unjudged_not_no():
    got = judge._parse('{"results":[{"id":1,"match":[]}]}', 2, ["communal"])
    assert 2 not in got


def test_verdicts_are_cached_and_reused():
    db, llm = FakeDB(), ScriptedLLM()
    recs = _records(["temple stones thrown", "bus timings"])
    first = judge.judge(recs, ["communal"], "q", llm, db=db)
    calls = llm.calls
    second = judge.judge(recs, ["communal"], "q", llm, db=db)
    assert llm.calls == calls                      # nothing re-judged
    assert first["k0"]["labels"] == second["k0"]["labels"] == ["communal"]
    assert second["k0"]["cached"] is True


def test_an_edited_record_is_judged_again():
    db, llm = FakeDB(), ScriptedLLM()
    judge.judge([{"key": "doc:h1", "text": "temple"}], ["communal"], "q", llm, db=db)
    calls = llm.calls
    judge.judge([{"key": "doc:h2", "text": "temple"}], ["communal"], "q", llm, db=db)
    assert llm.calls == calls + 1


def test_a_down_model_is_not_retried_for_every_batch():
    calls = {"n": 0}

    def broken(prompt, max_tokens):
        calls["n"] += 1
        raise ConnectionError("down")

    old = judge.CONCURRENCY
    judge.CONCURRENCY = 1
    try:
        got = judge.judge(_records([f"t{i}" for i in range(80)]), ["communal"], "q", broken)
    finally:
        judge.CONCURRENCY = old
    assert got == {}
    assert calls["n"] == 3


# --------------------------------------------------------------------------- #
# the funnel end to end
# --------------------------------------------------------------------------- #

def _run(question, docs, llm, districts=None, deep=False):
    col = FakeWindow(docs)
    plan = scan.route(question)
    job = scan.ScanJob(question, "t1", "admin", plan["mode"], plan["labels"], deep)
    scan.run(job, collections={"vector_embeddings_contents": col}, stores={},
             tenant_id="t1", districts=districts, db=FakeDB(), generate=llm)
    return job, col


def test_every_window_query_carries_the_tenant_and_districts():
    _, col = _run("communal posts last 7 days", [_doc(1, "temple clash")],
                  ScriptedLLM(), districts=["Karimnagar"])
    assert col.queries
    for q in col.queries:
        assert q["metadata.tenant_id"] == "t1"
        assert "$and" in q                         # the district clause


def test_only_confirmed_records_are_returned_with_reasons():
    docs = [_doc(1, "bus stand renovated"), _doc(2, "stones thrown at temple procession"),
            _doc(3, "traffic jam")]
    job, _ = _run("show me communal content from last 7 days", docs, ScriptedLLM())
    snap = job.snapshot()
    assert [c["handle"] for c in snap["matches"]] == ["user2"]
    assert snap["matches"][0]["why"] == "religious clash"
    assert snap["matches"][0]["url"] == "https://x.com/p/2"
    assert snap["counts"] == {"communal": 1}
    assert snap["verified"] is True


def test_a_down_model_shows_unverified_candidates_not_nothing():
    def broken(prompt, max_tokens):
        raise ConnectionError("down")

    job, _ = _run("communal posts last 7 days",
                  [_doc(1, "riot near temple"), _doc(2, "bus stand")], broken)
    snap = job.snapshot()
    assert snap["verified"] is False
    assert snap["matches"]
    assert "not been verified" in snap["note"]


def test_a_scan_is_only_visible_to_the_scope_that_started_it():
    job = scan.ScanJob("q", "t1", "Karimnagar", "concept", ["x"], False)
    with scan._jobs_lock:
        scan._jobs[job.id] = job
    assert scan.get(job.id, "t1", "Karimnagar") is job
    assert scan.get(job.id, "t2", "Karimnagar") is None
    assert scan.get(job.id, "t1", "admin") is None


def test_start_runs_in_the_background_and_finishes():
    docs = [_doc(1, "temple clash")]

    def deps():
        return {"collections": {"vector_embeddings_contents": FakeWindow(docs)},
                "stores": {}, "tenant_id": "t1", "districts": None,
                "db": FakeDB(), "generate": ScriptedLLM()}

    job = scan.start("communal posts", "t1", "admin", deps)
    for _ in range(100):
        if job.snapshot()["status"] != "running":
            break
        time.sleep(0.02)
    snap = job.snapshot()
    assert snap["status"] == "done"
    assert snap["found"] == 1


def test_posts_is_generic_not_the_contents_collection():
    # Every alert and grievance is a post; "posts" must not exclude them.
    assert scan.hard_spec("show me communal posts").kinds == []
    assert scan.hard_spec("communal grievances").kinds == ["grievance"]


def test_related_to_a_word_is_not_a_tagged_handle():
    assert scan.hard_spec("posts related to rapes, robbery or corruption").tagged == []
    assert scan.hard_spec("complaints sent to @TelanganaDGP").tagged == ["TelanganaDGP"]
