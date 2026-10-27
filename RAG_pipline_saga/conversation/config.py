"""
config.py — every bound on conversation memory, in one place.

Defaults follow what the application already does with short-lived AI state:
the scan job store keeps a job for SCAN_JOB_TTL_S = 1800 s, so an idle
conversation lives as long. Ten turns is enough for any follow-up chain an
officer actually types, and small enough to audit by eye.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, replace

# Bumped whenever the stored shape changes. A stored state with another
# version is never reinterpreted: it is treated as absent and a new
# conversation begins.
SCHEMA_VERSION = "conv-1"
ENABLED_FLAG = "AI_CONVERSATION_ENABLED"


def conversation_enabled() -> bool:
    return os.getenv(ENABLED_FLAG, "true").strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default
    # Out-of-range config is clamped, not trusted: "remember 1,000,000 turns"
    # must not become the behaviour because someone typed an extra zero.
    return max(lo, min(hi, value))


@dataclass(frozen=True)
class ConversationConfig:
    max_turns: int = 10               # AI_CONVERSATION_MAX_TURNS
    max_context_items: int = 20       # AI_CONVERSATION_MAX_CONTEXT_ITEMS
    ttl_seconds: int = 1800           # AI_CONVERSATION_TTL (idle)
    max_query_chars: int = 500        # stored copy of the user's text
    schema_version: str = SCHEMA_VERSION

    @classmethod
    def from_env(cls) -> "ConversationConfig":
        return cls(
            max_turns=_env_int("AI_CONVERSATION_MAX_TURNS", 10, 1, 50),
            max_context_items=_env_int("AI_CONVERSATION_MAX_CONTEXT_ITEMS", 20, 1, 100),
            ttl_seconds=_env_int("AI_CONVERSATION_TTL", 1800, 60, 86400),
        )

    def with_(self, **changes) -> "ConversationConfig":
        return replace(self, **changes)
