"""
tools.py — the controlled tool vocabulary a plan may name.

A plan that names a tool nobody implemented is worse than a plan that names
none: the orchestrator would dispatch into nothing, and the failure would
surface as an empty answer rather than an error. So tool names are an enum
with a status, the model may never invent one, and `needs` — not the model —
decide which tools a plan asks for.

`status` is honest about what exists today. `available` means the capability is
callable in this repository right now; `planned` means the contract is agreed
and the implementation is not here yet. Nothing pretends.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

from .models import Need


@dataclass(frozen=True)
class Tool:
    name: str
    need: Need
    status: str            # available | planned
    backed_by: str         # where the capability lives today
    description: str


# Status reflects what is implemented. Phase 0/1: retrieval, analytics and the
# concept scan. Phases 2-3 added location, related content, comparison and
# situation analysis (orchestrator/tools.py, enrichment/).
REGISTRY: Dict[str, Tool] = {t.name: t for t in (
    Tool("lookup_records", Need.EXACT_LOOKUP, "available", "retriever.structured",
         "Exact filtered records, no ranking."),
    Tool("hybrid_search", Need.SEARCH, "available", "retriever + engine",
         "Structured + lexical + semantic, fused by RRF."),
    Tool("aggregate", Need.AGGREGATION, "available", "analytics.breakdown",
         "Counts, distributions and rankings from the database."),
    Tool("trend_analysis", Need.TREND_ANALYSIS, "available", "analytics.compare_windows",
         "Window-over-window movement."),
    Tool("classify_records", Need.CLASSIFICATION, "available", "judge.judge",
         "Label records against known concepts."),
    Tool("unknown_concept_search", Need.CONCEPT_RESOLUTION, "available", "scan.run",
         "Expand, recall, rerank and judge a concept nothing is tagged with."),
    Tool("deep_scan", Need.DEEP_SCAN, "available", "scan.run(deep=True)",
         "Exhaustive classification as a durable job."),
    Tool("related_content_search", Need.SEARCH, "available", "enrichment.related",
         "Records related to a record, entity or topic."),
    Tool("location_resolve", Need.LOCATION_RESOLUTION, "available", "enrichment.location",
         "Text to gazetteer entity, with hierarchy and aliases."),
    Tool("compare_results", Need.COMPARISON, "available", "orchestrator.tools.compare_results",
         "Compare two or more result sets on a named dimension."),
    Tool("situation_analysis", Need.SITUATION_ANALYSIS, "available", "enrichment.situation",
         "Fan-out: volume, trend, risk, entities and places for one subject."),
)}

TOOL_NAMES = frozenset(REGISTRY)
AVAILABLE_TOOLS = frozenset(n for n, t in REGISTRY.items() if t.status == "available")

# One need can be served by exactly one tool today; the list form leaves room
# for alternatives without changing the contract.
NEED_TO_TOOLS: Dict[Need, List[str]] = {
    Need.SEARCH: ["hybrid_search"],
    Need.EXACT_LOOKUP: ["lookup_records"],
    Need.AGGREGATION: ["aggregate"],
    Need.TREND_ANALYSIS: ["trend_analysis"],
    Need.CLASSIFICATION: ["classify_records"],
    Need.CONCEPT_RESOLUTION: ["unknown_concept_search"],
    Need.LOCATION_RESOLUTION: ["location_resolve"],
    Need.COMPARISON: ["compare_results"],
    # A situation is a set of distinct issues, not a list of nearest records,
    # so the situation path also asks for related content: that is what groups
    # the matches into issues instead of ranking them. The compiler already
    # builds the step; without the tool here the plan never requests it, so the
    # gate never allows it and the step is dropped.
    Need.SITUATION_ANALYSIS: ["situation_analysis", "related_content_search"],
    Need.DEEP_SCAN: ["deep_scan"],
    Need.EVIDENCE: [],
    Need.NONE: [],
}


def tools_for(needs: List[Need]) -> List[str]:
    """Needs decide tools, in a stable order. The model never names a tool."""
    out: List[str] = []
    for need in needs:
        for name in NEED_TO_TOOLS.get(need, []):
            if name not in out:
                out.append(name)
    return out


def unknown_tools(names: List[str]) -> List[str]:
    return [n for n in names if n not in TOOL_NAMES]


def planned_tools(names: List[str]) -> List[str]:
    return [n for n in names if n in REGISTRY and REGISTRY[n].status == "planned"]
