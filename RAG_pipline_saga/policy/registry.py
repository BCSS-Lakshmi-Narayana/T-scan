"""
registry.py — the single capability registry.

Availability is not restated here: it is read from query_understanding.tools,
where Phase 1A records which tools exist. This file adds only what policy
needs on top — which intents a capability serves, whether it is high-risk,
and which capabilities a given intent cannot do without.

`allowed_intents` is derived from deterministic._needs_for, the function that
produces every plan's needs. test_policy.py walks every intent against every
needs flag and proves the gate accepts what the planner emits, so a correct
plan is never refused for a mapping error here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, FrozenSet, List

from query_understanding import tools as qu_tools
from query_understanding.models import Intent

from .models import Capability

I = Intent
_DATA_INTENTS = frozenset(i for i in Intent if i is not Intent.CONVERSATIONAL)


@dataclass(frozen=True)
class CapabilitySpec:
    capability: Capability
    allowed_intents: FrozenSet[Intent]
    # Deep, broad or model-heavy: gets constraints, never runs on a request
    # alone.
    high_risk: bool = False
    # Every data capability reads tenant data, so every one is scoped. Kept
    # explicit so a future capability that is not must say so.
    requires_tenant: bool = True
    requires_district_scope: bool = True

    @property
    def available(self) -> bool:
        tool = qu_tools.REGISTRY.get(self.capability.value)
        return bool(tool and tool.status == "available")

    @property
    def backed_by(self) -> str:
        tool = qu_tools.REGISTRY.get(self.capability.value)
        return tool.backed_by if tool else "-"


CAPABILITIES: Dict[Capability, CapabilitySpec] = {s.capability: s for s in (
    CapabilitySpec(Capability.LOOKUP_RECORDS, frozenset({I.LOOKUP, I.MULTI_PART})),
    CapabilitySpec(Capability.HYBRID_SEARCH, frozenset({
        I.LOOKUP, I.FILTERED_SEARCH, I.FOLLOW_UP, I.CLASSIFICATION,
        I.SITUATION_ANALYSIS, I.UNKNOWN_CONCEPT, I.MULTI_PART})),
    CapabilitySpec(Capability.AGGREGATE, frozenset({
        I.AGGREGATION, I.TREND_ANALYSIS, I.COMPARISON, I.SITUATION_ANALYSIS,
        I.MULTI_PART})),
    CapabilitySpec(Capability.TREND_ANALYSIS, frozenset({
        I.TREND_ANALYSIS, I.SITUATION_ANALYSIS, I.MULTI_PART}), high_risk=True),
    CapabilitySpec(Capability.CLASSIFY_RECORDS, frozenset({I.CLASSIFICATION, I.MULTI_PART})),
    # Concept resolution is appended to ANY data intent with an unresolved
    # concept (_needs_for), so it is compatible with all of them.
    CapabilitySpec(Capability.UNKNOWN_CONCEPT_SEARCH, _DATA_INTENTS, high_risk=True),
    # Likewise location resolution, for any intent with an unresolved place.
    CapabilitySpec(Capability.LOCATION_RESOLVE, _DATA_INTENTS),
    CapabilitySpec(Capability.RELATED_CONTENT_SEARCH, frozenset({
        I.LOOKUP, I.FILTERED_SEARCH, I.FOLLOW_UP, I.SITUATION_ANALYSIS}), high_risk=True),
    CapabilitySpec(Capability.COMPARE_RESULTS, frozenset({I.COMPARISON, I.MULTI_PART})),
    CapabilitySpec(Capability.SITUATION_ANALYSIS, frozenset({I.SITUATION_ANALYSIS, I.MULTI_PART})),
    CapabilitySpec(Capability.DEEP_SCAN, frozenset({I.DEEP_SCAN}), high_risk=True),
)}

# Without these the intent has no meaning; anything else the plan asks for is
# supporting, and losing it degrades the answer rather than voiding it.
ESSENTIAL: Dict[Intent, FrozenSet[Capability]] = {
    I.LOOKUP: frozenset({Capability.LOOKUP_RECORDS}),
    I.FILTERED_SEARCH: frozenset({Capability.HYBRID_SEARCH}),
    I.AGGREGATION: frozenset({Capability.AGGREGATE}),
    I.TREND_ANALYSIS: frozenset({Capability.TREND_ANALYSIS}),
    I.COMPARISON: frozenset({Capability.COMPARE_RESULTS}),
    # Classifying needs a set to classify.
    I.CLASSIFICATION: frozenset({Capability.CLASSIFY_RECORDS, Capability.HYBRID_SEARCH}),
    # A situation without the fan-out is still search results about it.
    I.SITUATION_ANALYSIS: frozenset({Capability.HYBRID_SEARCH}),
    I.UNKNOWN_CONCEPT: frozenset({Capability.UNKNOWN_CONCEPT_SEARCH}),
    I.DEEP_SCAN: frozenset({Capability.DEEP_SCAN}),
    I.FOLLOW_UP: frozenset({Capability.HYBRID_SEARCH}),
    # Decided per sub-question.
    I.MULTI_PART: frozenset(),
    I.CONVERSATIONAL: frozenset(),
}


def lookup(name: str):
    """Capability for a tool name, or None. The only way a string becomes a
    capability — an unrecognised name never does."""
    try:
        return Capability(name)
    except ValueError:
        return None


def high_risk() -> List[Capability]:
    return [c for c, s in CAPABILITIES.items() if s.high_risk]


# The two vocabularies must be the same set. Failing at import is deliberate:
# a tool the gate does not know would be refused forever; a capability with
# no tool would be allowed into nothing.
_missing = set(qu_tools.TOOL_NAMES) ^ {c.value for c in Capability}
if _missing or set(CAPABILITIES) != set(Capability):
    raise RuntimeError(f"capability registry out of sync with query_understanding.tools: "
                       f"{sorted(_missing)}")
