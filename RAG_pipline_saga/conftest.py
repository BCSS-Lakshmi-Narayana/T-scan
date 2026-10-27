"""
Shared pytest fixtures.

`planned` marks named tools as not-yet-implemented for one test. Phase 1A/1B
tests of the unavailable-capability path (degrade when optional, deny when
essential, free-text fallback) were written while location, comparison,
related-content and situation tools did not exist. Those tools now exist; the
tests keep their exact assertions and state the unavailable condition
explicitly instead of relying on the registry's state at the time.
"""

import dataclasses
import os

# Tests must never load a GPU model: the machine's GPU is shared with the
# production sentiment worker. The reranker degrades to pass-through.
os.environ["RERANKER_ENABLED"] = "false"

import pytest


@pytest.fixture
def planned(monkeypatch):
    from query_understanding import tools as qu_tools

    def mark(*names):
        for name in names:
            tool = qu_tools.REGISTRY[name]
            monkeypatch.setitem(qu_tools.REGISTRY, name, dataclasses.replace(tool, status="planned"))
    return mark


def pytest_collection_modifyitems(config, items):
    """Categorise by file, so a new test in a known file is marked for free.

    Correctness is the default. Security, concurrency and load are marked
    because they are the ones worth running — or excluding — on their own.
    """
    by_file = {
        "test_adversarial.py": ("security",),
        "test_isolation.py": ("security",),
        "test_tenant_db.py": ("security",),
        "test_policy.py": ("security",),
        "test_policy_golden.py": ("security",),
        "test_router_load.py": ("concurrency", "load"),
        "test_mongo_pool.py": ("concurrency",),
    }
    for item in items:
        name = os.path.basename(str(item.fspath))
        for marker in by_file.get(name, ()):
            item.add_marker(getattr(pytest.mark, marker))
