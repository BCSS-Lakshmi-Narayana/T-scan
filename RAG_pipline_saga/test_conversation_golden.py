"""
The Conversation Context golden set, run as a test.

Cases live in query_understanding/golden_queries.json under
"conversation_cases". Each asks its turns, in order, in one real (in-memory)
conversation — plan, resolve, gate, commit — exactly as the development
endpoint does, and asserts only what it lists about the LAST turn.
"""

import json
import os

import pytest

from conversation import (ConversationNotFound, InMemoryConversationStore,
                          InvalidConversationId, ResolutionStatus, build_turn,
                          resolve_query)
from policy import PolicyConfig, PolicyDecision, RequestContext, evaluate
from query_understanding import understand
from query_understanding.models import FilterField

GOLDEN_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "query_understanding", "golden_queries.json")
with open(GOLDEN_PATH, encoding="utf-8") as fh:
    GOLDEN = json.load(fh)

CONTEXTS = GOLDEN["policy_contexts"]
CASES = GOLDEN["conversation_cases"]
CONVERSING = [c for c in CASES if c["category"] != "isolation"]
ISOLATION = [c for c in CASES if c["category"] == "isolation"]
USER = "golden-officer"


def _ctx(preset, user=USER):
    c = CONTEXTS[preset]
    return RequestContext(tenant_id=c["tenant_id"], user_id=user, role=c["role"],
                          districts=c["districts"], permissions=frozenset(c["permissions"]))


def converse(case):
    """Run every turn; return (resolved, decision, state) for the last."""
    store = InMemoryConversationStore()
    author = _ctx(case.get("author", "admin"))
    final = _ctx(case.get("final", case.get("author", "admin")))
    state = store.create(author.tenant_id, author.user_id)
    overrides = case.get("raw_override", {})
    resolved = decision = None
    for i, question in enumerate(case["turns"]):
        last = i == len(case["turns"]) - 1
        ctx = final if last else author
        plan, _ = understand(question)
        if str(i) in overrides:
            text = overrides[str(i)]
            plan = plan.model_copy(update={"raw_query": text, "normalized_query": text})
        resolved = resolve_query(plan, state, ctx, config=store.config)
        decision = evaluate(resolved.resolved_plan, ctx, config=PolicyConfig())
        state = store.append(state, build_turn(state.turn_count + 1, question, resolved,
                                               store.config, query_plan=plan),
                             expected_sequence=state.turn_count)
    return resolved, decision, state


@pytest.mark.parametrize("case", CONVERSING, ids=[c["id"] for c in CONVERSING])
def test_golden_conversation(case):
    resolved, decision, _ = converse(case)
    exp = case["expect"]
    plan = resolved.resolved_plan
    why = (f"status={resolved.status.value} intent={plan.intent.value} "
           f"loc={plan.location.text if plan.location else None} "
           f"filters={[(f.field.value, f.value) for f in plan.filters]} "
           f"unresolved={[(u.target_type.value, u.reason, u.candidates) for u in resolved.unresolved_referents]}")

    assert resolved.status is ResolutionStatus(exp["status"]), why
    if "follow_up" in exp:
        assert resolved.metadata.follow_up is exp["follow_up"], why
    if "intent" in exp:
        assert plan.intent.value == exp["intent"], why
    if "intent_not" in exp:
        assert plan.intent.value != exp["intent_not"], why
    if "location" in exp:
        assert (plan.location.text if plan.location else None) == exp["location"], why
    if "time_kind" in exp:
        assert plan.time_range.kind.value == exp["time_kind"], why
    for field, value in (exp.get("filters") or {}).items():
        assert str(value) in [str(v) for v in plan.filter_values(FilterField(field))], why
    for field in exp.get("absent_filters", []):
        assert not plan.has_filter(FilterField(field)), why
    for field, value in (exp.get("absent_values") or {}).items():
        assert str(value) not in [str(v) for v in plan.filter_values(FilterField(field))], why
    for text in exp.get("concepts_include", []):
        assert any(text.lower() in c.text.lower() for c in plan.concepts), why
    if exp.get("inherits_concepts"):
        assert plan.concepts and all(c.source.value == "context" for c in plan.concepts), why
    for facet in exp.get("group_by", []):
        assert facet in plan.group_by, why
    for kind, turn in exp.get("referents", []):
        assert any(r.target_type.value == kind and r.source_turn == turn
                   for r in resolved.resolved_referents), why
    for kind, reason in exp.get("unresolved", []):
        assert any(u.target_type.value == kind and u.reason == reason
                   for u in resolved.unresolved_referents), why
    if "candidates" in exp:
        got = {n for u in resolved.unresolved_referents for n in u.candidates}
        assert got == set(exp["candidates"]), why
    for field, via in exp.get("context_used", []):
        assert any(u.field == field and u.via.value == via for u in resolved.context_used), why
    for r in exp.get("resets", []):
        assert r in resolved.resets, why
    if "comparison_subjects" in exp:
        assert [s.text for s in resolved.comparison_subjects] == exp["comparison_subjects"], why

    if "policy" in exp:
        assert decision.decision is PolicyDecision(exp["policy"]), \
            f"{decision.decision.value} {[r.value for r in decision.reason_codes()]}"
    if "policy_any" in exp:
        assert decision.decision.value in exp["policy_any"]
    for code in exp.get("policy_reasons", []):
        assert code in [r.value for r in decision.reason_codes()]
    if "effective_districts" in exp:
        assert decision.effective_districts == exp["effective_districts"]


@pytest.mark.parametrize("case", ISOLATION, ids=[c["id"] for c in ISOLATION])
def test_golden_isolation(case):
    store = InMemoryConversationStore()
    owner_t, owner_u = case["owner"]
    state = store.create(owner_t, owner_u)
    plan, _ = understand("Show alerts in Karimnagar.")
    owner_ctx = RequestContext(tenant_id=owner_t, user_id=owner_u, role="admin")
    resolved = resolve_query(plan, state, owner_ctx)
    store.append(state, build_turn(1, plan.raw_query, resolved, store.config), 0)

    req_t, req_u = case["requester"]
    cid = case.get("conversation_id", state.conversation_id)
    expected = case["expect"]["error"]
    if expected is None:
        got = store.get(req_t, req_u, cid)
        assert got.active is not None and got.active.locations[0].text == "Karimnagar"
    elif expected == "invalid":
        with pytest.raises(InvalidConversationId):
            store.get(req_t, req_u, cid)
    else:
        with pytest.raises(ConversationNotFound):
            store.get(req_t, req_u, cid)


def test_the_conversation_golden_set_meets_the_required_counts():
    from collections import Counter
    counts = Counter(c["category"] for c in CASES)
    required = {"follow_up": 10, "referent": 10, "inheritance": 10, "ambiguous": 5,
                "isolation": 5, "scope_change": 5, "multilingual": 5}
    for category, n in required.items():
        assert counts[category] >= n, category


def test_earlier_golden_sections_are_untouched():
    assert len(GOLDEN["queries"]) == 47 and len(GOLDEN["policy_cases"]) == 23
