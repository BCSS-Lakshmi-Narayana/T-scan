"""
agent.py — the bounded refinement path.

Runs only AFTER deterministic execution, only when verification says the
evidence is empty or insufficient, and at most MAX_REFINEMENTS (2) times.

The model — when one is configured — does not name tools, write arguments or
touch scope. It picks ONE item from a menu this module builds, of actions
that are (a) allowed by the PolicyResult for this request and (b) not yet
tried. Each menu item's step is constructed here, from the same typed
argument models the compiler uses, with the plan's own filters, time and
districts. So the worst a confused or hostile model can do is choose a
different allowed refinement, or "stop".

    relax_soft_filters      drop filters only the MODEL proposed (never the
                            user's, never time, never place)
    concept_search          the concept pipeline, if the search came back empty
    related_content         records related to what WAS found
    stop

Without a model, the same menu is walked deterministically in that order.
"""

from __future__ import annotations

import json
import re
from typing import Callable, List, Optional, Tuple

from policy.models import Capability
from query_understanding.models import QueryPlan, Source

from . import compiler
from .models import (MAX_REFINEMENTS, ConceptArgs, ExecutionPlan, ExecutionStep,
                     RelatedArgs, SearchArgs, VerificationReport)

C = Capability
PROMPT_VERSION = "agent@v1"


def menu(qplan: QueryPlan, eplan: ExecutionPlan, report: VerificationReport,
         tried: List[str], have_records: bool) -> List[str]:
    allowed = set(eplan.allowed_capabilities)
    items = []
    if any(f.source is Source.LLM for f in qplan.filters) and C.HYBRID_SEARCH in allowed:
        items.append("relax_soft_filters")
    if not have_records and C.UNKNOWN_CONCEPT_SEARCH in allowed and qplan.concepts \
            and not any(s.tool is C.UNKNOWN_CONCEPT_SEARCH for s in eplan.steps):
        items.append("concept_search")
    if have_records and C.RELATED_CONTENT_SEARCH in allowed \
            and not any(s.tool is C.RELATED_CONTENT_SEARCH for s in eplan.steps):
        items.append("related_content")
    return [i for i in items if i not in tried]


def choose(options: List[str], question: str, report: VerificationReport,
           generate: Optional[Callable]) -> Tuple[str, str]:
    """(action, source). The model's reply is parsed as JSON and must name an
    option verbatim; anything else — prose, a tool name, an argument — falls
    back to the deterministic first option."""
    if not options:
        return "stop", "none"
    if generate:
        prompt = (f"An assistant searched for: {question!r}. Result: {report.sufficiency}. "
                  f"Choose ONE next action from {json.dumps(options + ['stop'])}. "
                  'Reply only with JSON: {"action": "<one of the options>"}')
        try:
            raw = generate(prompt, max_tokens=40, temperature=0.0) or ""
            m = re.search(r"\{.*\}", raw, re.S)
            action = json.loads(m.group(0)).get("action") if m else None
            if action in options or action == "stop":
                return action, "llm"
        except Exception:
            pass
    return options[0], "deterministic"


def step_for(action: str, qplan: QueryPlan, eplan: ExecutionPlan, now, n: int,
             found_step: Optional[str]) -> Optional[ExecutionStep]:
    sid = f"refine{n}"
    if action == "relax_soft_filters":
        hard = [f for f in qplan.filters if f.source is not Source.LLM]
        spec = compiler.spec_from_plan(qplan, now, filters=hard)
        return ExecutionStep(step_id=sid, tool=C.HYBRID_SEARCH, operation="hybrid",
                             arguments=SearchArgs(spec=spec), purpose="Search again without "
                             "the filters only the model inferred", essential=False,
                             provenance={"refinement": action, "iteration": n})
    if action == "concept_search":
        spec = compiler.spec_from_plan(qplan, now)
        return ExecutionStep(step_id=sid, tool=C.UNKNOWN_CONCEPT_SEARCH, operation="scan",
                             arguments=ConceptArgs(spec=spec, label=compiler._concept_label(qplan),
                                                   question=qplan.raw_query[:500]),
                             purpose="Look for the concept itself, not the words",
                             essential=False, output_schema="verdicts",
                             provenance={"refinement": action, "iteration": n})
    if action == "related_content" and found_step:
        spec = compiler.spec_from_plan(qplan, now)
        return ExecutionStep(step_id=sid, tool=C.RELATED_CONTENT_SEARCH, operation="related",
                             arguments=RelatedArgs(spec=spec, top_k=10),
                             dependencies=[found_step], input_sources=[found_step],
                             purpose="Records connected to what was found", essential=False,
                             provenance={"refinement": action, "iteration": n})
    return None
