"""Two orchestration gaps: separate requests, and comparison per side."""

import pytest

from query_understanding import understand
from query_understanding.deterministic import MAX_PARTS, _split_parts
from query_understanding.normalize import normalize
import orchestrator.analysis as A
import orchestrator.analysis_job as J
from retriever import QuerySpec
from test_analysis_job import FakeCol, wait


# ===================================================================== #
# decomposition: only genuinely separate requests
# ===================================================================== #

@pytest.mark.parametrize("q", [
    "How many grievances are there and where are they concentrated?",
    "Show recent high risk activity and tell me what is changing.",
    "Compare Hyderabad and Mulugu and tell me what changed.",
    "How many grievances are there in Hyderabad and what are people talking about?",
])
def test_two_requests_become_two_plans(q):
    assert len(_split_parts(normalize(q))) == 2
    plan = understand(q, allow_llm=False)[0]
    assert len(plan.sub_questions) == 2, [s.text for s in plan.sub_questions]


@pytest.mark.parametrize("q", [
    "Show recent high risk grievances",
    "Compare Hyderabad and Mulugu",
    "Show me alerts and grievances",
    "How many grievances are there in Hyderabad?",
    "Which of these posts are communal and which are national?",
])
def test_one_request_stays_one_plan(q):
    # An "and" joining two NOUNS is one request; only a second question frame
    # starts a second. A repeated interrogative partitions one question.
    assert _split_parts(normalize(q)) == [], q
    assert understand(q, allow_llm=False)[0].sub_questions == []


def test_decomposition_is_bounded():
    q = ("how many grievances are there and where are they concentrated and "
         "what are people talking about and who is involved and when did it start")
    assert len(_split_parts(normalize(q))) <= MAX_PARTS


def test_each_part_keeps_the_words_the_officer_used():
    parts = _split_parts(normalize(
        "How many grievances are there and where are they concentrated?"))
    assert parts[0].lower().startswith("how many grievances")
    assert "concentrated" in parts[1].lower()


# ===================================================================== #
# comparison: a population per side, never pooled
# ===================================================================== #

def sides(*labels):
    return [J.Side(label=l, spec=QuerySpec(text="grievances"), districts=[l],
                   matching=1000 + i) for i, l in enumerate(labels)]


def deps(n=60):
    return lambda: {
        "collections": {"alerts": FakeCol(n)}, "stores": {},
        "spec": QuerySpec(text="grievances"), "tenant_id": "t1",
        "districts": None, "embed": None,
        "generate": lambda p, m: "\n".join(
            f"{i}|topic=civic|where=Hyderabad|who=@a{i}|claim=alleges a civic problem"
            for i in range(1, A.BATCH_SIZE + 1)),
        "db": None, "model": "m", "terms": ["grievances"], "close": lambda: None,
    }


def test_each_side_gets_its_own_population():
    job = wait(J.start("Compare Hyderabad and Mulugu.", "comparison", "t1", "H",
                       deps(60), size=40, sides=sides("Hyderabad", "Mulugu")))
    assert job.status == "done"
    assert len(job.sides) == 2
    for side in job.sides:
        assert side.population == 40, f"{side.label} read its own population"
        assert side.analysed == 40
        assert side.findings, f"{side.label} has its own findings"
        assert side.evidence_keys, f"{side.label} has its own evidence"


def test_progress_is_reported_per_side_not_pooled():
    job = wait(J.start("Compare Hyderabad and Mulugu.", "comparison", "t1", "H",
                       deps(60), size=30, sides=sides("Hyderabad", "Mulugu")))
    snap = job.snapshot()
    assert "sides" in snap and len(snap["sides"]) == 2
    assert [s["label"] for s in snap["sides"]] == ["Hyderabad", "Mulugu"]
    for s in snap["sides"]:
        assert s["population"] == 30 and s["analysed"] == 30
        assert s["matching"] is not None, "each side reports its own matching count"


def test_each_side_reports_its_own_matching_count():
    job = wait(J.start("Compare Hyderabad and Mulugu.", "comparison", "t1", "H",
                       deps(40), size=20, sides=sides("Hyderabad", "Mulugu")))
    found = {s.label: s.matching for s in job.sides}
    assert found["Hyderabad"] != found["Mulugu"], "one pooled number describes neither"


def test_comparison_findings_are_exposed_per_side():
    job = wait(J.start("Compare Hyderabad and Mulugu.", "comparison", "t1", "H",
                       deps(40), size=20, sides=sides("Hyderabad", "Mulugu")))
    view = job.snapshot(with_findings=True)
    assert "comparison" in view
    assert [s["label"] for s in view["comparison"]["sides"]] == ["Hyderabad", "Mulugu"]
    for s in view["comparison"]["sides"]:
        assert s["analysed"] > 0 and "themes" in s


def test_evidence_says_which_side_it_came_from():
    job = wait(J.start("Compare Hyderabad and Mulugu.", "comparison", "t1", "H",
                       deps(40), size=20, sides=sides("Hyderabad", "Mulugu")))
    payload = J.evidence_payload(job)
    assert payload
    labels = {e["facts"].get("side") for e in payload}
    assert labels == {"Hyderabad", "Mulugu"}, (
        "evidence from one place must never read as the other's")


def test_evidence_spans_the_sides_rather_than_one_dominating():
    job = wait(J.start("Compare Hyderabad and Mulugu.", "comparison", "t1", "H",
                       deps(80), size=60, sides=sides("Hyderabad", "Mulugu")))
    payload = J.evidence_payload(job)
    counts = {}
    for e in payload:
        side = e["facts"].get("side")
        counts[side] = counts.get(side, 0) + 1
    assert len(counts) == 2 and min(counts.values()) > 0
    assert len(payload) <= 20


def test_three_sides_are_supported():
    job = wait(J.start("Compare three places.", "comparison", "t1", "H", deps(40),
                       size=15, sides=sides("A", "B", "C")))
    assert len(job.sides) == 3 and all(s.analysed == 15 for s in job.sides)


# ===================================================================== #
# what a cross-side briefing may say
# ===================================================================== #

def agg_for(themes):
    return {"analysed": 50, "themes": [{"value": t, "count": c} for t, c in themes],
            "locations": [], "people": []}


def test_a_cross_side_briefing_is_told_monitoring_depth_differs():
    seen = {}
    A.compare_sides("Compare Hyderabad and Mulugu.",
                    [("Hyderabad", 4241, agg_for([("civic", 10)])),
                     ("Mulugu", 26, agg_for([("civic", 2)]))],
                    lambda p, m: seen.setdefault("p", p) or "x")
    p = seen["p"]
    assert "monitored to different depths" in p
    assert "Do not rank the places as better or worse" in p
    assert "never counts" in p


def test_no_cross_side_briefing_without_two_sides_to_compare():
    called = []
    out = A.compare_sides("q", [("Hyderabad", 10, agg_for([("civic", 1)]))],
                          lambda p, m: called.append(p) or "x")
    assert out == "" and not called


def test_a_side_that_was_never_read_is_not_compared():
    called = []
    out = A.compare_sides("q", [("Hyderabad", 10, agg_for([("civic", 1)])),
                                ("Mulugu", 0, {"analysed": 0})],
                          lambda p, m: called.append(p) or "x")
    assert out == "" and not called, "comparing against nothing is not a comparison"


def test_a_side_briefing_is_told_not_to_call_a_smaller_number_larger():
    # Live: "Hyderabad has more posts (78) compared to Mulugu (134)" — 78 < 134.
    # With no matching figures the model reached for theme tallies instead.
    seen = {}
    A.compare_sides("Compare Hyderabad and Mulugu.",
                    [("Hyderabad", 4241, agg_for([("civic", 10)])),
                     ("Mulugu", 26, agg_for([("civic", 2)]))],
                    lambda p, m: seen.setdefault("p", p) or "x")
    p = seen["p"]
    assert "only when its number is actually larger" in p
    assert "Do not compare the theme\n  tallies as if they were the totals" in p
    # each side's headline figure is actually in the prompt
    assert "4241" in p and "26" in p
