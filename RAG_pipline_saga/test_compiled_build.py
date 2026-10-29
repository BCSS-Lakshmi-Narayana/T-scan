"""Rules the source must follow so the compiled build behaves like the source.

The service ships compiled (tools/compile_python.py). Two things broke only in
the compiled form, and passed every other test, because no test exercised
them. These read the source on purpose, so they skip against a build.
"""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent
SKIP = {".venv", "venv", "__pycache__", "build", "reports", "outputs", ".pytest_cache"}


def _runtime_sources():
    for p in ROOT.rglob("*.py"):
        rel = p.relative_to(ROOT)
        if any(part in SKIP for part in rel.parts):
            continue
        if p.name.startswith("test_") or p.name in {"conftest.py", "fakemongo.py", "v2fixture.py"}:
            continue
        yield p


@pytest.mark.reads_source
def test_no_module_loads_dotenv_without_a_path():
    """With no path, load_dotenv() finds .env from the calling Python frame.

    Compiled code has no frame, so the compiled service loaded no settings at
    all: the assistant's feature flag read as off and every question got 404,
    while health checks, which need no settings, still answered 200.
    """
    bare = re.compile(r"^\s*load_dotenv\(\s*\)", re.M)
    offenders = [str(p.relative_to(ROOT)) for p in _runtime_sources()
                 if bare.search(p.read_text(encoding="utf-8", errors="replace"))]
    assert offenders == [], f"load_dotenv() needs an explicit path in: {offenders}"


@pytest.mark.reads_source
def test_every_pydantic_model_module_loads_the_compat_shim_first():
    """Compiled methods are a type pydantic does not recognise as a method.

    Without _compiled_compat imported first, a model with any method fails to
    build in the compiled service ("A non-annotated attribute was detected").
    """
    model = re.compile(r"^class \w+\((?:BaseModel|BaseSettings)\b", re.M)
    shim = re.compile(r"^import _compiled_compat\b", re.M)
    first_pydantic = re.compile(r"^(?:from pydantic\b|import pydantic\b)", re.M)
    missing = []
    for p in _runtime_sources():
        s = p.read_text(encoding="utf-8", errors="replace")
        if not model.search(s):
            continue
        m_shim, m_pyd = shim.search(s), first_pydantic.search(s)
        if not m_shim or (m_pyd and m_shim.start() > m_pyd.start()):
            missing.append(str(p.relative_to(ROOT)))
    assert missing == [], f"import _compiled_compat before pydantic in: {missing}"
