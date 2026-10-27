"""
policy — the Policy / Capability Gate.

    QueryPlan + RequestContext  ->  PolicyResult
                                    allowed | degraded | clarification_required | denied

A deterministic safety boundary between understanding and execution. It
decides what a plan may do; it never does it. No model, no retrieval, no
database, no answer.

    from policy import evaluate, RequestContext
    result = evaluate(plan, RequestContext(tenant_id="t1", role="admin"))

Development-only until the orchestrator exists: reachable through
/api/rag/policy-check behind AI_ASSISTANT_ARCHITECTURE_V2 (default off).
"""

from .config import (ENABLED_FLAG, PERM_AI_CHAT, PERM_AI_DEEP_SCAN,
                     POLICY_VERSION, PolicyConfig, policy_enabled)
from .evaluator import decide, evaluate, evaluate_raw
from .models import (PUBLIC_MESSAGES, Capability, Constraints, DistrictMode,
                     PolicyDecision, PolicyReason, PolicyResult, ReasonCode,
                     RequestContext, Severity, SubDecision,
                     permissions_from_rbac)
from .registry import CAPABILITIES, ESSENTIAL, CapabilitySpec

__all__ = [
    "evaluate", "evaluate_raw", "decide", "policy_enabled", "ENABLED_FLAG",
    "POLICY_VERSION", "PERM_AI_CHAT", "PERM_AI_DEEP_SCAN", "PolicyConfig",
    "Capability", "CapabilitySpec", "CAPABILITIES", "ESSENTIAL", "Constraints",
    "DistrictMode", "PolicyDecision", "PolicyReason", "PolicyResult",
    "ReasonCode", "RequestContext", "Severity", "SubDecision",
    "PUBLIC_MESSAGES", "permissions_from_rbac",
]
