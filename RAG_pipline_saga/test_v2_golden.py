"""
The v2 golden set as a test: every case must pass, and the acceptance
criteria are asserted as numbers, not eyeballed from a report.

Recall and precision here are measured on the fixture with the scripted
judge; they prove the pipeline carries recall and verdicts through correctly.
Production retrieval quality is not claimed by this test.
"""

import pytest

import validate_v2

RESULT = validate_v2.run()
SUMMARY = RESULT["summary"]
CASES = RESULT["results"]


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_golden_case(case):
    assert case.get("error") is None, case.get("error")
    assert case["passed"], {k: v for k, v in case.items() if k != "analytics"}


def test_acceptance_criteria():
    s = SUMMARY
    assert s["analytics_exactness"] == 1.0 and s["analytics_checks"] >= 30
    assert s["tool_selection_accuracy"] >= 0.90
    assert s["citation_correctness"] == 1.0
    assert s["unsupported_claims"] == 0
    assert s["tenant_leakage"] == 0 and s["district_leakage"] == 0
    assert s["unauthorised_tool_executions"] == 0 and s["scope_escalations"] == 0
    assert s["max_refinements"] <= 2
    assert s["fixture_recall_at_20"] >= 0.85
    assert s["fixture_classification_precision"] >= 0.85


def test_every_required_category_is_covered():
    cats = {c["category"] for c in CASES}
    assert {"basic", "multilingual", "context", "ambiguity", "analytical", "unknown_concept",
            "security", "failure"} <= cats
