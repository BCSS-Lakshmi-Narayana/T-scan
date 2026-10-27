"""
query_understanding — natural language to a validated QueryPlan.

The first boundary of the target architecture. It decides what the officer is
asking for; it never decides what the answer is, and it never decides what the
officer is allowed to see.

    from query_understanding import understand
    plan, validation = understand("negative posts about traffic police")

Behind AI_ASSISTANT_ARCHITECTURE_V2 (default off). The live assistant path is
untouched by this package.
"""

from .models import (Ambiguity, Concept, ConceptStatus, Conflict, Entity,
                     Filter, FilterField, FilterOp, Intent, Location,
                     LocationType, Need, QueryPlan, Referent, Shape, Source,
                     SubQuestion, TimeKind, TimeRange, ValidationResult,
                     PLAN_VERSION)
from .service import FEATURE_FLAG, understand, v2_enabled
from .tools import AVAILABLE_TOOLS, REGISTRY, TOOL_NAMES, tools_for
from .validator import validate

__all__ = [
    "understand", "validate", "v2_enabled", "FEATURE_FLAG", "PLAN_VERSION",
    "QueryPlan", "ValidationResult", "Intent", "Shape", "Need", "Source",
    "Filter", "FilterField", "FilterOp", "TimeRange", "TimeKind", "Location",
    "LocationType", "Entity", "Concept", "ConceptStatus", "Ambiguity",
    "Conflict", "Referent", "SubQuestion",
    "REGISTRY", "TOOL_NAMES", "AVAILABLE_TOOLS", "tools_for",
]
