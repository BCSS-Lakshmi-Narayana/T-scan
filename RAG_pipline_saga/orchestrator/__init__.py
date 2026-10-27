"""
orchestrator — Phase 2, the deterministic-first orchestrator.

    compiler   (resolved QueryPlan, PolicyResult) -> ExecutionPlan
    executor   validated DAG, bounded concurrency, timeouts, cancellation
    tools      one handler per capability, wrapping existing retrieval/analytics/scan
    evidence   tool outputs -> citable Evidence
    verify     tenant, district, place, filter, time, arithmetic, sufficiency
    agent      bounded refinement (<= 2), menu-only
    respond    template + optional claim-checked synthesis
    pipeline   the whole request, end to end

Reached only through /api/rag/v2/* behind AI_ASSISTANT_ARCHITECTURE_V2.
"""
