"""The deep-analysis stage: three populations, batching, cache, aggregation.

These cover the properties an officer's safety depends on — that the model's
reading never becomes a claim about the world, and that a population of
hundreds is never sent to the model as one prompt or read twice.
"""

import hashlib

import orchestrator.analysis as A
from retriever import QuerySpec


def rec(i, text, **meta):
    return {"key": f"alerts:doc{i}:hash{i}", "document_id": f"doc{i}",
            "collection": "alerts", "text": text, "meta": meta}


def line(i, **f):
    base = {"topic": "women safety", "where": "Hyderabad",
            "who": "@someone", "claim": "alleges police inaction"}
    base.update(f)
    return f"{i}|" + "|".join(f"{k}={v}" for k, v in base.items())


# ------------------------------------------------------------ populations

def test_a_count_question_reads_no_records_at_all():
    # The database answers "how many" exactly; sending thousands of posts to a
    # model to recount them would be slower and less correct.
    assert A.pool_size("count") == 0
    assert A.pool_size("aggregation") == 0


def test_each_intent_gets_the_population_its_question_needs():
    assert A.pool_size("situation_analysis") > A.pool_size("filtered_search")
    assert A.pool_size("filtered_search") > 0
    assert A.pool_size("comparison") > 0
    assert A.pool_size("trend_analysis") > 0
    # an intent nobody configured still gets a sane, non-zero population
    assert A.pool_size("something_new") == A.DEFAULT_POOL


# ---------------------------------------------------------------- batching

def test_a_large_population_is_never_sent_as_one_prompt():
    records = [rec(i, f"post {i}") for i in range(250)]
    prompts = []

    def generate(p, _max):
        prompts.append(p)
        n = p.count("\n1. ") + len([l for l in p.splitlines() if l.strip().startswith(("1.", "2."))])
        return "\n".join(line(i) for i in range(1, A.BATCH_SIZE + 1))

    A.analyse(records, "what is happening?", generate, db=None, model="m")
    assert len(prompts) == 25, "250 records must arrive as 25 batches of 10"
    for p in prompts:
        assert p.count("\n") < 60, "a batch prompt must stay small"


def test_every_record_in_the_population_gets_a_finding():
    records = [rec(i, f"post {i}") for i in range(30)]
    out = A.analyse(records, "q",
                    lambda p, m: "\n".join(line(i) for i in range(1, A.BATCH_SIZE + 1)),
                    db=None, model="m")
    assert len(out) == 30


def test_a_dead_model_stops_being_asked_rather_than_timing_out_repeatedly():
    calls = {"n": 0}

    def dead(p, m):
        calls["n"] += 1
        raise RuntimeError("model down")

    A.analyse([rec(i, "x") for i in range(200)], "q", dead, db=None, model="m")
    assert calls["n"] <= 6, "the circuit breaker must stop the run early"


def test_an_unparseable_batch_produces_no_findings_rather_than_invented_ones():
    out = A.analyse([rec(1, "x")], "q", lambda p, m: "the model rambled", db=None, model="m")
    assert out == {}


# ------------------------------------------------------------------- cache

class FakeDB:
    def __init__(self):
        self.docs = {}
        self.reads = 0

    def __getitem__(self, _name):
        return self

    def find(self, q):
        self.reads += 1
        return [self.docs[i] for i in q["_id"]["$in"] if i in self.docs]

    def bulk_write(self, ops, ordered=True):
        for op in ops:
            self.docs[op._filter["_id"]] = op._doc


def test_the_same_post_is_never_analysed_twice():
    db = FakeDB()
    records = [rec(i, f"post {i}") for i in range(20)]
    gen = lambda p, m: "\n".join(line(i) for i in range(1, A.BATCH_SIZE + 1))

    calls = {"n": 0}

    def counting(p, m):
        calls["n"] += 1
        return gen(p, m)

    first = A.analyse(records, "q", counting, db=db, model="m")
    assert calls["n"] == 2 and len(first) == 20

    second = A.analyse(records, "q", counting, db=db, model="m")
    assert calls["n"] == 2, "a second ask over the same records must hit the cache"
    assert len(second) == 20
    assert all(f.cached for f in second.values())


def test_edited_content_and_a_new_version_both_miss_the_cache():
    db = FakeDB()
    gen = lambda p, m: line(1)
    A.analyse([rec(1, "original")], "q", gen, db=db, model="m")

    # the key carries the content hash, so edited text is a different record
    edited = {"key": "alerts:doc1:hashCHANGED", "document_id": "doc1",
              "collection": "alerts", "text": "edited", "meta": {}}
    assert A.cached(db, [edited], "m") == {}
    # a different model, and a different analysis version, are both misses
    assert A.cached(db, [rec(1, "original")], "other-model") == {}
    assert A.cache_id("k", "m").startswith(A.ANALYSIS_VERSION)


def test_a_broken_cache_never_takes_the_analysis_down():
    class Broken(FakeDB):
        def find(self, q):
            raise RuntimeError("mongo is unhappy")

    out = A.analyse([rec(1, "x")], "q", lambda p, m: line(1), db=Broken(), model="m")
    assert len(out) == 1


# ------------------------------------------------------- what findings say

def test_a_post_is_recorded_as_a_claim_not_as_an_event():
    out = A.parse(line(1, claim="says a woman was harassed at the station"),
                  [rec(1, "x")])
    f = out["alerts:doc1:hash1"]
    assert f.claim == "says a woman was harassed at the station"
    assert f.topic == "women safety"


def test_risk_and_sentiment_come_from_the_database_not_from_the_model():
    # These ratings already exist and are the product's own, so asking the
    # model for them would both cost output tokens per record and let a model
    # opinion contradict the record.
    out = A.parse(line(1), [rec(1, "x", risk_level="low", sentiment="negative",
                                kind="complaint")])
    f = out["alerts:doc1:hash1"]
    assert f.risk == "low" and f.sentiment == "negative"
    assert f.content_type == "complaint"


def test_the_model_is_not_asked_for_what_the_database_already_holds():
    prompt = A.build_prompt([rec(1, "x")], "q")
    for field in ("sent=", "sum=", "type=", "risk="):
        assert field not in prompt, f"{field} is already stored on the record"


def test_empty_and_unknown_fields_are_dropped_rather_than_guessed():
    out = A.parse(line(1, where="none", who="", claim="unknown"), [rec(1, "x")])
    f = out["alerts:doc1:hash1"]
    assert f.locations == [] and f.people == [] and f.claim == ""


def test_the_model_is_not_asked_to_re_judge_relevance():
    # Measured: for "show me high risk activity in Hyderabad" the model called
    # 46 of 47 posts irrelevant, though every one had passed the risk and
    # district filters the question compiled to. The filters decide the
    # population; the model only describes what is in it.
    prompt = A.build_prompt([rec(1, "x")], "q")
    assert "rel=" not in prompt
    assert A.parse(line(1), [rec(1, "x")])["alerts:doc1:hash1"].relevant is True


# ------------------------------------------------------------- aggregation

def findings_for(spec):
    """spec: list of (topic, where, who, claim)."""
    out, recs = {}, {}
    for i, (topic, where, who, claim) in enumerate(spec):
        k = f"alerts:doc{i}:h{i}"
        out[k] = A.Finding(key=k, document_id=f"doc{i}", topic=topic,
                           locations=[where] if where else [], people=[who] if who else [],
                           claim=claim)
        recs[k] = rec(i, "t", handle=who)
    return out, recs


def test_recurring_themes_places_and_accounts_are_surfaced():
    f, r = findings_for([
        ("women safety", "Hyderabad", "@a", "alleges harassment near the metro"),
        ("women safety", "Hyderabad", "@b", "alleges harassment near the metro"),
        ("traffic", "Hyderabad", "@c", "complains about signal failures downtown"),
    ])
    agg = A.aggregate(f, r)
    assert agg["themes"][0] == {"value": "women safety", "count": 2}
    assert agg["locations"][0]["value"] == "Hyderabad"
    assert agg["analysed"] == 3 and agg["relevant"] == 3


def test_a_cluster_is_never_presented_as_one_confirmed_incident():
    f, r = findings_for([("women safety", "Hyderabad", "@a", "x" * 20),
                         ("women safety", "Hyderabad", "@b", "y" * 20)])
    agg = A.aggregate(f, r)
    assert agg["clusters"] and agg["clusters"][0]["size"] == 2
    assert "not necessarily one incident" in agg["clusters"][0]["note"]


def test_a_claim_repeated_by_one_account_is_not_a_repeated_claim():
    same = "alleges the dam has collapsed"
    f, r = findings_for([("civic", "Hyderabad", "@a", same),
                         ("civic", "Hyderabad", "@a", same)])
    assert A.aggregate(f, r)["repeated_claims"] == []

    f, r = findings_for([("civic", "Hyderabad", "@a", same),
                         ("civic", "Hyderabad", "@b", same)])
    assert A.aggregate(f, r)["repeated_claims"][0]["accounts"] == 2


def test_irrelevant_findings_do_not_pollute_the_themes():
    f, r = findings_for([("women safety", "Hyderabad", "@a", "c" * 20)])
    k2 = "alerts:doc9:h9"
    f[k2] = A.Finding(key=k2, topic="cricket", relevant=False)
    r[k2] = rec(9, "t")
    agg = A.aggregate(f, r)
    assert [t["value"] for t in agg["themes"]] == ["women safety"]
    assert agg["analysed"] == 2 and agg["relevant"] == 1


# ------------------------------------------------- what reaches the screen

def test_displayed_records_span_the_findings_instead_of_one_loud_theme():
    spec = [("women safety", "Hyderabad", f"@a{i}", "z" * 20) for i in range(10)]
    spec += [("traffic", "Hyderabad", "@t1", "q" * 20),
             ("traffic", "Hyderabad", "@t2", "q" * 20)]
    f, r = findings_for(spec)
    order = list(f.keys())
    agg = A.aggregate(f, r)
    shown = A.representative(f, order, agg, count=4)
    topics = {f[k].topic for k in shown}
    assert "traffic" in topics, "the smaller theme must still be represented"
    assert len(shown) == 4


def test_the_display_set_is_far_smaller_than_the_analysed_population():
    spec = [("women safety", "Hyderabad", f"@a{i}", "z" * 20) for i in range(300)]
    f, r = findings_for(spec)
    shown = A.representative(f, list(f.keys()), A.aggregate(f, r), count=20)
    assert len(shown) == 20 and len(f) == 300


def test_irrelevant_records_are_not_shown_as_evidence():
    f, r = findings_for([("women safety", "Hyderabad", "@a", "z" * 20)])
    k2 = "alerts:doc9:h9"
    f[k2] = A.Finding(key=k2, topic="cricket", relevant=False)
    shown = A.representative(f, list(f.keys()) + [k2], A.aggregate(f, r), count=20)
    assert k2 not in shown


def test_a_record_that_was_never_read_is_not_offered_as_evidence():
    f, r = findings_for([("women safety", "Hyderabad", "@a", "z" * 20)])
    order = list(f.keys()) + ["alerts:never:analysed"]
    assert "alerts:never:analysed" not in A.representative(f, order, A.aggregate(f, r))


# -------------------------------------------------- building the population

class FakeCol:
    def __init__(self, docs): self.docs = docs
    def count_documents(self, q): return len(self.docs)
    def find(self, q, proj=None):
        class C:
            def __init__(s, d): s.d = d
            def sort(s, _): return s
            def limit(s, n): return iter(s.d[:n])
        return C(self.docs)


def _doc(i, text):
    return {"text": text, "metadata": {"document_id": f"d{i}", "content_hash": f"h{i}",
                                       "source_collection": "alerts",
                                       "published_at": f"2026-09-{(i % 28) + 1:02d}"}}


def test_a_count_intent_builds_no_population_and_reads_nothing():
    recs, total = A.build_population({"c": FakeCol([_doc(0, "x")])}, None,
                                     QuerySpec(text="x"), "t", None, size=0)
    assert recs == [] and total == 0


def test_the_window_is_read_wider_than_the_population_then_ranked():
    # 400 posts, only some mention the thing asked about. Taking the newest 20
    # would mostly miss them; ranking first is what puts them in front.
    docs = [_doc(i, "unrelated chatter about cricket") for i in range(400)]
    for i in range(0, 400, 40):
        docs[i] = _doc(i, "women safety harassment complaint near the metro")

    recs, total = A.build_population({"c": FakeCol(docs)}, None,
                                     QuerySpec(text="women safety"), "t", None,
                                     size=20, terms=["women", "safety", "harassment"])
    assert total == 400, "the matching count must report the whole window"
    assert len(recs) == 20, "only the ranked slice is analysed"
    hits = sum(1 for r in recs if "women safety" in r["text"])
    assert hits >= 5, f"ranking must surface the relevant posts, got {hits}"


def test_a_window_smaller_than_the_population_is_used_whole():
    docs = [_doc(i, "x") for i in range(5)]
    recs, total = A.build_population({"c": FakeCol(docs)}, None,
                                     QuerySpec(text="x"), "t", None, size=50)
    assert len(recs) == 5 and total == 5


def test_the_batch_prompt_states_how_many_lines_it_expects():
    # Without this the model stopped part-way through a batch and a third of
    # the records came back with no findings, having already been paid for.
    prompt = A.build_prompt([rec(i, "x") for i in range(7)], "q")
    assert "EXACTLY 7 lines" in prompt


# ------------------------------------------- what the model is shown/told

def test_our_own_record_label_is_not_fed_back_as_the_post_topic():
    # Every curated record begins "Alert: ..." or "Complaint: ...". Leaving that
    # in made the model answer topic=complaint for almost everything, so the
    # recurring themes came back as a list of our own record kinds.
    prompt = A.build_prompt([rec(1, "Complaint: @user the streetlights are out")], "q")
    assert "the streetlights are out" in prompt
    assert "Complaint:" not in prompt.split("POSTS:")[1]


def test_the_summary_may_not_claim_a_change_it_was_never_given():
    # Live: "indicating an increase in reported issues" — invented, there was
    # no comparison over time anywhere in the input.
    seen = {}
    A.summarise("how has activity changed?", {"analysed": 200, "themes": [
        {"value": "complaint", "count": 14}]}, 7694,
        lambda p, m: seen.setdefault("prompt", p) or "x")
    p = seen["prompt"]
    assert "Do NOT say anything increased, decreased" in p


def test_the_summary_may_not_conclude_anything_about_what_it_never_read():
    # Live: "Mulugu ... was not mentioned in the analysis" reads as "nothing is
    # happening in Mulugu". Absence from a sample is not absence in the data.
    seen = {}
    A.summarise("compare Hyderabad and Mulugu", {"analysed": 300, "themes": []}, 7694,
                lambda p, m: seen.setdefault("prompt", p) or "x")
    p = seen["prompt"]
    assert "are a SAMPLE" in p
    assert "NOT that there is nothing happening there" in p


def test_no_summary_is_attempted_without_findings():
    assert A.summarise("q", {"analysed": 0}, 100, lambda p, m: "should not be called") == ""


def test_the_cache_version_moves_with_the_prompt():
    # Twice now a prompt change shipped without this, and the cache kept
    # serving findings produced by the OLD prompt — which looks like the model
    # ignoring an instruction rather than a stale cache. The guard: the version
    # string must name the prompt's current shape.
    # This used to assert the version string equalled a literal, which only
    # fires when someone edits the version — the opposite of the failure. The
    # version now CARRIES the prompt's fingerprint, so a prompt edit invalidates
    # the cache by itself and there is nothing left to forget.
    import hashlib
    fingerprint = hashlib.sha1(A._PROMPT.encode("utf-8")).hexdigest()[:8]
    assert A.ANALYSIS_VERSION.endswith("+" + fingerprint)
    assert A.ANALYSIS_VERSION.startswith(A._ANALYSIS_SCHEMA_VERSION)
    assert A.cache_id("k", "m").startswith(A.ANALYSIS_VERSION)


def test_editing_the_prompt_invalidates_cached_findings(monkeypatch):
    db = FakeDB()
    records = [rec(i, f"post {i}") for i in range(10)]
    gen = lambda p, m: "\n".join(line(i) for i in range(1, A.BATCH_SIZE + 1))
    A.analyse(records, "q", gen, db=db, model="m")
    assert all(f.cached for f in A.cached(db, records, "m").values())

    # A changed prompt is a changed analysis. Findings produced by the old
    # wording must not be mixed in with the new.
    edited = A._PROMPT + "\nOne more instruction."
    monkeypatch.setattr(A, "_PROMPT", edited)
    monkeypatch.setattr(A, "ANALYSIS_VERSION",
                        f"{A._ANALYSIS_SCHEMA_VERSION}+"
                        f"{hashlib.sha1(edited.encode('utf-8')).hexdigest()[:8]}")
    assert A.cached(db, records, "m") == {}


def test_a_theme_does_not_split_its_own_count_across_singular_and_plural():
    # Live: "complaint 7" beside "complaints 4" read as two findings when it
    # was one of eleven.
    f, r = findings_for([("complaint", "Hyderabad", f"@a{i}", "z" * 20) for i in range(7)]
                        + [("complaints", "Hyderabad", f"@b{i}", "z" * 20) for i in range(4)])
    themes = A.aggregate(f, r)["themes"]
    assert themes[0] == {"value": "complaint", "count": 11}
    assert not any(t["value"] == "complaints" for t in themes)


def test_words_that_merely_end_in_s_are_left_alone():
    # "press" must not become "pres", and two genuinely different themes must
    # not be folded together just because one ends in s.
    f, r = findings_for([("press", "Hyderabad", "@a", "z" * 20),
                         ("protest", "Hyderabad", "@b", "z" * 20)])
    values = {t["value"] for t in A.aggregate(f, r)["themes"]}
    assert values == {"press", "protest"}


# -------------------------------------------------------------- profiling

def test_an_analysis_reports_what_it_actually_cost():
    # A 40s analysis used to be one number. Reading the population, the model
    # batches and the synthesis were indistinguishable, so the obvious
    # question — is the model slow, or are we reading too much? — had no
    # answer in the data.
    records = [rec(i, f"post {i}") for i in range(30)]
    gen = lambda p, m: "\n".join(line(i) for i in range(1, A.BATCH_SIZE + 1))
    stats = {}
    A.analyse(records, "q", gen, db=None, model="m", stats=stats)
    assert stats["records"] == 30
    assert stats["batches"] == 3
    assert stats["llm_calls"] == 3
    assert stats["llm_failed"] == 0
    assert stats["parsed"] == 30
    assert stats["llm_ms"] >= 0


def test_a_cache_that_stopped_hitting_is_visible_in_the_numbers():
    db = FakeDB()
    records = [rec(i, f"post {i}") for i in range(20)]
    gen = lambda p, m: "\n".join(line(i) for i in range(1, A.BATCH_SIZE + 1))
    A.analyse(records, "q", gen, db=db, model="m")

    stats = {}
    A.analyse(records, "q", gen, db=db, model="m", stats=stats)
    assert stats["cache_hits"] == 20
    assert stats["llm_calls"] == 0, "a fully cached run must cost no model call"
    assert stats["llm_ms"] == 0.0


def test_a_failing_model_is_counted_as_failed_not_merely_slow():
    def dead(p, m):
        raise RuntimeError("ollama down")

    stats = {}
    A.analyse([rec(i, "x") for i in range(20)], "q", dead, db=None, model="m",
              stats=stats)
    assert stats["llm_calls"] >= 1
    assert stats["llm_failed"] == stats["llm_calls"]
    assert stats["parsed"] == 0


def test_analysis_model_use_is_visible_next_to_the_router_s():
    """Analysis calls the model outside the router's pool.

    One Ollama on one shared GPU serves both, so ANALYSIS_CONCURRENCY batch
    calls run ON TOP OF AI_LLM_CONCURRENCY interactive ones. Neither counter
    alone shows the real concurrent pressure, which is why the total used to be
    guessed at from latency.
    """
    A.reset_model_load()
    records = [rec(i, f"post {i}") for i in range(30)]
    gen = lambda p, m: "\n".join(line(i) for i in range(1, A.BATCH_SIZE + 1))
    A.analyse(records, "q", gen, db=None, model="m")

    load = A.model_load()
    assert load["calls"] == 3
    assert load["running"] == 0, "a finished analysis holds no slot"
    assert load["failed"] == 0
    assert load["ms"] >= 0
    assert load["concurrency"] == A.CONCURRENCY and load["batch_size"] == A.BATCH_SIZE


def test_a_failing_batch_releases_its_slot():
    A.reset_model_load()

    def dead(p, m):
        raise RuntimeError("ollama down")

    A.analyse([rec(i, "x") for i in range(20)], "q", dead, db=None, model="m")
    load = A.model_load()
    assert load["running"] == 0, "a failed call must not leak a slot"
    assert load["failed"] == load["calls"] >= 1


# ------------------------------------------------- trend comparability

import orchestrator.tools as T


def test_a_percentage_is_withheld_when_the_base_is_too_small():
    # "+27075%" from 24 records is arithmetically right and reads as a broken
    # gauge. The counts are the finding; the ratio is noise.
    assert T.MIN_COMPARABLE_BASE >= 1 and T.MAX_COMPARABLE_RATIO >= 2

    def comparable(current, previous):
        return (previous >= T.MIN_COMPARABLE_BASE
                and current <= previous * T.MAX_COMPARABLE_RATIO)

    assert not comparable(6522, 24), "too few before"
    assert not comparable(7161, 30), "base cleared the floor, ratio still absurd"
    assert comparable(120, 100), "an ordinary change is still reported"
    assert comparable(300, 100), "tripling is reportable"
    assert not comparable(2000, 100), "twentyfold is not a percentage"


def test_the_wording_withholds_it_rather_than_hiding_the_counts():
    from enrichment import situation as S
    out = S.build("x", records=[], total=6522, breakdowns={},
                  trend={"current": 6522, "previous": 24, "change_pct": 27075.0,
                         "comparable": False},
                  related=[], window_days=45)
    text = " ".join(out["observations"])
    assert "24" in text and "6522" in text, "both counts must still be stated"
    assert "27075" not in text, "the meaningless percentage must not be shown"
    assert "too few" in text


def test_an_ordinary_change_still_states_its_percentage():
    from enrichment import situation as S
    out = S.build("x", records=[], total=120, breakdowns={},
                  trend={"current": 120, "previous": 100, "change_pct": 20.0,
                         "comparable": True},
                  related=[], window_days=7)
    assert "+20" in " ".join(out["observations"])


def test_records_the_model_skipped_are_retried_once():
    """A dropped line left a record unanalysed: 158 of 167 on a live population.

    The count was honest, but a record we paid to retrieve and prompt for
    should be read. One retry, never a loop.
    """
    records = [rec(i, f"post {i}") for i in range(20)]
    calls = {"n": 0}

    def flaky(prompt, max_tokens):
        calls["n"] += 1
        # First two batches drop their last two lines; the retry answers fully.
        n = A.BATCH_SIZE - 2 if calls["n"] <= 2 else A.BATCH_SIZE
        return "\n".join(line(i) for i in range(1, n + 1))

    stats = {}
    out = A.analyse(records, "q", flaky, db=None, model="m", stats=stats)
    assert len(out) == 20, f"only {len(out)} of 20 analysed"
    assert stats.get("retried") == 4
    assert not stats.get("unanalysed")


def test_the_retry_happens_at_most_once():
    records = [rec(i, f"post {i}") for i in range(20)]
    calls = {"n": 0}

    def always_short(prompt, max_tokens):
        # Answers one record per batch, however small the batch — so the retry
        # cannot clear the backlog and must still stop.
        calls["n"] += 1
        return line(1)

    stats = {}
    A.analyse(records, "q", always_short, db=None, model="m", stats=stats)
    # 2 original batches + at most 1 retry pass over the stragglers.
    assert calls["n"] <= 4, f"{calls['n']} model calls — the retry looped"
    assert stats.get("unanalysed", 0) > 0, "what is still missing must be counted"


def test_a_dead_model_is_not_retried():
    def dead(p, m):
        raise RuntimeError("ollama down")

    stats = {}
    A.analyse([rec(i, "x") for i in range(20)], "q", dead, db=None, model="m", stats=stats)
    assert "retried" not in stats, "a model that answers nothing must not be asked twice"
