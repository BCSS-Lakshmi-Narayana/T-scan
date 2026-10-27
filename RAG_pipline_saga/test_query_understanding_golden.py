"""
The Query Understanding golden set, run as a test.

Each entry asserts only the fields it names. Where a question genuinely
supports more than one reading, `intent_any` lists the acceptable ones — a
golden set that demands one answer per question would encode the planner's
current quirks as requirements and break on every sensible improvement.

Runs rules-only (no planner model injected), so it is deterministic, offline
and fast. The LLM paths have their own tests in test_query_understanding.py.
"""

import json
import os

import pytest

from query_understanding import FilterField, Intent, Need, Shape, understand
from query_understanding import tools as tools_mod

GOLDEN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "query_understanding", "golden_queries.json")

with open(GOLDEN_PATH, encoding="utf-8") as fh:
    GOLDEN = json.load(fh)

CASES = GOLDEN["queries"]


def _ids(case):
    return case["id"]


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_golden_query(case):
    plan, validation = understand(case["query"])

    # Every plan must be structurally valid, always.
    assert validation.valid, [i.message for i in validation.errors]
    assert plan.raw_query == case["query"]
    assert not tools_mod.unknown_tools(plan.required_tools)

    if "intent" in case:
        assert plan.intent.value == case["intent"], f"intent for {case['id']}"
    if "intent_any" in case:
        assert plan.intent.value in case["intent_any"], \
            f"{plan.intent.value} not in {case['intent_any']}"
    if "shape" in case:
        assert plan.shape.value == case["shape"]

    for field, value in (case.get("filters") or {}).items():
        values = [str(v) for v in plan.filter_values(FilterField(field))]
        assert str(value) in values, f"{field}={value} missing (got {values})"

    if "time_kind" in case:
        assert plan.time_range.kind.value == case["time_kind"]
    if "time_n" in case:
        assert plan.time_range.n == case["time_n"]

    if "location_text" in case:
        assert plan.location is not None, "expected a location"
        assert plan.location.text.lower() == case["location_text"]
        # Never resolved here — resolution belongs to a service that does not
        # exist yet, and claiming it would be a lie the orchestrator believes.
        assert plan.location.resolved is False

    for need in case.get("needs", []):
        assert Need(need) in plan.needs, f"need {need} missing from {plan.needs}"

    for tool in case.get("tools", []):
        assert tool in plan.required_tools
    if case.get("tools") == []:
        assert plan.required_tools == []

    for facet in case.get("group_by", []):
        assert facet in plan.group_by

    if "min_sub_questions" in case:
        assert len(plan.sub_questions) >= case["min_sub_questions"]
    if "min_referents" in case:
        assert len(plan.referents) >= case["min_referents"]
    if "min_ambiguities" in case:
        assert len(plan.ambiguities) >= case["min_ambiguities"]

    if "degraded" in case:
        assert plan.degraded is case["degraded"]
    if "coverage" in case:
        assert plan.coverage == case["coverage"]


def test_the_golden_set_covers_every_required_category():
    """A golden set missing a category silently stops guarding it."""
    ids = " ".join(c["id"] for c in CASES)
    for prefix in ("lookup", "filter", "time", "agg", "trend", "cmp", "class",
                   "situ", "unk", "deep", "multi", "follow", "amb", "ml",
                   "none", "chat"):
        assert f"{prefix}-" in ids, f"no {prefix} cases in the golden set"
    assert len(CASES) >= 30, "golden set should hold at least 30 queries"


def test_no_golden_case_asserts_an_answer():
    """Planning benchmark, not a QA benchmark."""
    for case in CASES:
        assert "answer" not in case
        assert "expected_records" not in case
