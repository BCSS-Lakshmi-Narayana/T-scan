"""
The Policy Gate golden set, run as a test.

Cases live in query_understanding/golden_queries.json under "policy_cases",
beside the Phase 1A queries they extend. Each asserts only what it names;
plans come from the rules-only planner, so the set also pins the contract
between understanding and policy.
"""

import json
import os

import pytest

from policy import (Capability, PolicyConfig, PolicyDecision, RequestContext,
                    evaluate)
from query_understanding import understand

GOLDEN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "query_understanding", "golden_queries.json")
with open(GOLDEN_PATH, encoding="utf-8") as fh:
    GOLDEN = json.load(fh)

CONTEXTS = GOLDEN["policy_contexts"]
CASES = GOLDEN["policy_cases"]


def _ctx(name):
    c = CONTEXTS[name]
    return RequestContext(tenant_id=c["tenant_id"], role=c["role"],
                          districts=c["districts"], user_id=f"golden-{name}",
                          permissions=frozenset(c["permissions"]))


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_golden_policy_case(case, planned):
    # A case written against a tool that did not exist yet states that
    # condition explicitly, so its expected decision is still what is tested.
    planned(*case.get("planned", []))
    plan, _ = understand(case["query"])
    if case.get("inject_tools"):
        plan = plan.model_copy(update={"required_tools": plan.required_tools + case["inject_tools"]})
    config = PolicyConfig()
    if case.get("disabled"):
        config = config.with_(disabled_capabilities=frozenset(Capability(c) for c in case["disabled"]))

    r = evaluate(plan, _ctx(case["context"]), config=config)

    assert r.decision is PolicyDecision(case["decision"]), \
        f"{r.decision.value}: {[x.code.value for x in r.reasons]}"
    allowed = {c.value for c in r.allowed_capabilities}
    blocked = {c.value for c in r.blocked_capabilities}
    if "allowed" in case:
        if case["allowed"] == []:
            assert allowed == set()
        assert set(case["allowed"]) <= allowed, allowed
    if "blocked" in case:
        assert set(case["blocked"]) <= blocked, blocked
    if "effective_districts" in case:
        assert r.effective_districts == case["effective_districts"]
    for code in case.get("reasons", []):
        assert code in {x.code.value for x in r.reasons}, code
    if "min_sub_decisions" in case:
        assert len(r.sub_decisions) >= case["min_sub_decisions"]


def test_the_policy_golden_set_covers_every_required_category():
    ids = {c["id"] for c in CASES}
    for required in ("pol-lookup", "pol-filtered", "pol-aggregation", "pol-trend",
                     "pol-comparison", "pol-situation", "pol-unknown-concept", "pol-deep-scan",
                     "pol-multi-part", "pol-unauthorized-district", "pol-missing-tenant",
                     "pol-missing-permission", "pol-disabled-capability",
                     "pol-invalid-capability", "pol-admin-unrestricted",
                     "pol-officer-restricted", "pol-telugu", "pol-hindi", "pol-tenglish",
                     "pol-ambiguous-location"):
        assert required in ids, required
    decisions = {c["decision"] for c in CASES}
    assert decisions == {d.value for d in PolicyDecision}, "every decision must be exercised"


def test_phase_1a_golden_queries_are_untouched():
    assert len(GOLDEN["queries"]) == 47
    assert all("decision" not in c for c in GOLDEN["queries"])
