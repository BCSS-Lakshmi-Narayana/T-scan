"""
config.py — every policy knob in one place.

Two kinds of value live here:

  * REUSED — read from the same environment variable, with the same default,
    as the module that enforces it at execution time (scan.py, analytics.py).
    The gate states the limit; it does not own it. test_policy.py asserts the
    defaults match so the two cannot drift.
  * NEW — limits the architecture requires and nothing defined before Phase
    1B. Each is named, defaulted and overridable; none is hidden in the
    evaluator.

The fingerprint hashes the whole config, so a decision can be traced to the
exact policy that made it, not just the code version.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, dataclass, field, replace
from typing import Dict, FrozenSet, Optional

from .models import Capability

POLICY_VERSION = "policy-v1"
ENABLED_FLAG = "AI_POLICY_ENABLED"

# The RBAC page the assistant lives on (backend/src/config/rbacConfig.js).
AI_PAGE = "/ai-assistant"
# Existing feature: the one grant the product already defines for the chat.
PERM_AI_CHAT = f"{AI_PAGE}:ai_chat"
# NEW: not in rbacConfig.js yet. Deep scan is the most expensive capability,
# so it is gated separately; until the product adds this feature id, only
# admin roles (who bypass feature checks) hold it.
PERM_AI_DEEP_SCAN = f"{AI_PAGE}:ai_deep_scan"


def policy_enabled() -> bool:
    return os.getenv(ENABLED_FLAG, "true").strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: Optional[int]) -> Optional[int]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_set(name: str) -> FrozenSet[str]:
    return frozenset(s.strip() for s in os.getenv(name, "").split(",") if s.strip())


@dataclass(frozen=True)
class PolicyConfig:
    version: str = POLICY_VERSION

    # -- roles (User.role enum in backend/src/models/User.js) -------------- #
    known_roles: FrozenSet[str] = frozenset({"superadmin", "admin", "level-1"})
    # rbacMiddleware treats both as full access and skips feature checks.
    admin_roles: FrozenSet[str] = frozenset({"superadmin", "admin"})
    # ragController.districtsFor() sends districts=null ONLY for 'admin'.
    # A superadmin gets its own list or []. Mirrored exactly, not widened.
    unrestricted_district_roles: FrozenSet[str] = frozenset({"admin"})

    # -- capability -> permission ------------------------------------------ #
    capability_permissions: Dict[Capability, str] = field(default_factory=lambda: {
        **{c: PERM_AI_CHAT for c in Capability},
        Capability.DEEP_SCAN: PERM_AI_DEEP_SCAN,
    })
    # Switched off by configuration, in addition to anything not yet built.
    disabled_capabilities: FrozenSet[Capability] = frozenset()

    # -- analytics (analytics.py) ------------------------------------------ #
    # analytics.breakdown / over_time / compare_windows compute counts only.
    supported_metrics: FrozenSet[str] = frozenset({"count"})
    # analytics.GROUPABLE, plus the time bucket over_time produces.
    supported_group_by: FrozenSet[str] = frozenset({
        "handle", "platform", "sentiment", "risk_level", "category", "kind",
        "topics", "targets", "districts", "published_at"})
    # analytics.compare_windows(days=30)
    trend_default_window_days: int = 30

    # -- scan (scan.py, same env vars) -------------------------------------- #
    scan_window_max: int = 6000        # SCAN_WINDOW_MAX
    scan_recall_pool: int = 200        # SCAN_RECALL_POOL
    scan_judge_pool: int = 60          # SCAN_JUDGE_POOL
    scan_deep_max: int = 3000          # SCAN_DEEP_MAX

    # -- NEW limits --------------------------------------------------------- #
    # A deep scan judges every record in its window with the LLM; an
    # unbounded window is the one request that can monopolise the GPU.
    deep_scan_max_days: int = 31       # AI_POLICY_DEEP_SCAN_MAX_DAYS
    # No general range cap existed before; None keeps today's behaviour.
    max_range_days: Optional[int] = None   # AI_POLICY_MAX_RANGE_DAYS

    @classmethod
    def from_env(cls) -> "PolicyConfig":
        disabled = set()
        for name in _env_set("AI_POLICY_DISABLED_CAPABILITIES"):
            try:
                disabled.add(Capability(name))
            except ValueError:
                # An unknown name in config is ignored, not fatal: disabling
                # is fail-safe, and a typo must not take the assistant down.
                continue
        return cls(
            disabled_capabilities=frozenset(disabled),
            scan_window_max=_env_int("SCAN_WINDOW_MAX", 6000),
            scan_recall_pool=_env_int("SCAN_RECALL_POOL", 200),
            scan_judge_pool=_env_int("SCAN_JUDGE_POOL", 60),
            scan_deep_max=_env_int("SCAN_DEEP_MAX", 3000),
            deep_scan_max_days=_env_int("AI_POLICY_DEEP_SCAN_MAX_DAYS", 31),
            max_range_days=_env_int("AI_POLICY_MAX_RANGE_DAYS", None),
        )

    def with_(self, **changes) -> "PolicyConfig":
        return replace(self, **changes)

    def fingerprint(self) -> str:
        def norm(v):
            if isinstance(v, (set, frozenset)):
                return sorted(norm(x) for x in v)
            if isinstance(v, dict):
                return {str(norm(k)): norm(x) for k, x in sorted(v.items(), key=lambda kv: str(kv[0]))}
            if isinstance(v, Capability):
                return v.value
            return v
        blob = json.dumps({k: norm(v) for k, v in asdict(self).items()}, sort_keys=True)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]
