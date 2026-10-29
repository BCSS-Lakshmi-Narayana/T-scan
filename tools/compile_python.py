#!/usr/bin/env python3
"""Build a compiled copy of a Python service, so no readable source ships.

    python tools/compile_python.py RAG_pipline_saga  build/RAG_pipline_saga
    python tools/compile_python.py RAG_pipline_saga  build/RAG_pipline_saga --test

Run it with the service's own interpreter (its .venv), on the machine that will
run the result: a compiled module only loads on the same CPU architecture and
the same Python version it was built with.

What the output contains
  * every runtime module as a native extension (.so / .pyd) instead of .py
  * package __init__.py files as they are (imports only; see --compile-init)
  * data the code reads at runtime: JSON, the test console, .env
What it leaves out
  * tests, caches, reports, the virtual environment, .git
  * docstrings and comments. Comments never survive compiling; docstrings
    would, as readable text inside the binary, so they are dropped

A module that will not compile is kept as .py and listed at the end, so a
partial build is visible rather than silently shipped.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SKIP_DIRS = {".venv", "venv", "__pycache__", ".pytest_cache", ".vector_cache", "outputs",
             "reports", ".logs", "tests", "build", ".git", "node_modules"}

# Python semantics, not Cython's. annotation_typing=False matters most: by
# default Cython turns "x: int" into an enforced C type and changes behaviour.
# binding/always_allow_keywords keep signatures introspectable for FastAPI.
DIRECTIVES = {
    "language_level": 3,
    "binding": True,
    "always_allow_keywords": True,
    "annotation_typing": False,
    "embedsignature": False,
    "emit_code_comments": False,
}

BUILD_ONE = r"""
import sys
from setuptools import setup, Extension
from Cython.Build import cythonize
from Cython.Compiler import Options
Options.docstrings = False
name, source, tmp = sys.argv[1], sys.argv[2], sys.argv[3]
setup(
    ext_modules=cythonize([Extension(name, [source])], compiler_directives=%r, quiet=True),
    script_args=["build_ext", "--inplace", "--build-temp", tmp],
)
""" % (DIRECTIVES,)


# Helpers only the tests import. Used to test the build, never shipped in it.
TEST_HELPERS = {"conftest.py", "fakemongo.py", "v2fixture.py"}


def is_test(p: Path) -> bool:
    return p.name.startswith("test_") or p.name in TEST_HELPERS


def copy_tree(src: Path, dst: Path) -> None:
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        rel = Path(root).relative_to(src)
        for f in files:
            p = Path(root) / f
            if p.suffix in (".pyc", ".pyo", ".c", ".so", ".pyd") or is_test(p):
                continue
            (dst / rel).mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dst / rel / f)


def strip_init(p: Path) -> None:
    """Keep a package __init__.py's statements, drop its docstrings and comments.

    These stay as .py (compiling package initialisers is the fragile part),
    and their docstrings described each package's design in prose.
    """
    import ast
    tree = ast.parse(p.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if (isinstance(body, list) and body and isinstance(body[0], ast.Expr)
                and isinstance(getattr(body[0], "value", None), ast.Constant)
                and isinstance(body[0].value.value, str)):
            node.body = body[1:] or [ast.Pass()]
    p.write_text(ast.unparse(tree) + "\n", encoding="utf-8")


def modules(dst: Path, compile_init: bool) -> list[tuple[str, Path]]:
    out = []
    for p in sorted(dst.rglob("*.py")):
        if p.name == "__init__.py" and not compile_init:
            continue
        rel = p.relative_to(dst).with_suffix("")
        out.append((".".join(rel.parts), p))
    return out


def build_one(dst: Path, name: str, src: Path) -> tuple[str, bool, str]:
    with tempfile.TemporaryDirectory() as tmp:
        r = subprocess.run([sys.executable, "-c", BUILD_ONE, name,
                            str(src.relative_to(dst)), tmp],
                           cwd=dst, capture_output=True, text=True)
    return name, r.returncode == 0, (r.stderr or r.stdout)[-1500:]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--compile-init", action="store_true", help="compile package __init__.py too")
    ap.add_argument("--test", action="store_true", help="run the source tree's tests against the build")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    a = ap.parse_args()

    src, dst = Path(a.src).resolve(), Path(a.dst).resolve()
    if dst.exists():
        shutil.rmtree(dst)
    copy_tree(src, dst)
    mods = modules(dst, a.compile_init)
    print(f"compiling {len(mods)} modules with {a.jobs} workers ...", flush=True)

    t0, failed = time.time(), []
    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        for name, ok, log in pool.map(lambda m: build_one(dst, *m), mods):
            if ok:
                (dst / Path(*name.split("."))).with_suffix(".py").unlink()
            else:
                failed.append((name, log))
    for c in dst.rglob("*.c"):
        c.unlink()
    for init in dst.rglob("__init__.py"):
        strip_init(init)
    shutil.rmtree(dst / "build", ignore_errors=True)

    print(f"compiled {len(mods) - len(failed)} of {len(mods)} in {time.time() - t0:.0f}s")
    if failed:
        print(f"\n{len(failed)} module(s) did NOT compile and are still .py:")
        for name, log in failed:
            print(f"  - {name}\n      {log.strip().splitlines()[-1] if log.strip() else ''}")
    left = [p.relative_to(dst) for p in dst.rglob("*.py")]
    print(f"\n.py files left in the build: {len(left)}")
    for p in left:
        print("   ", p)

    # A module that did not compile is still readable source. Shipping it would
    # defeat the build, so stop here rather than let a passing test run carry
    # it through: deploy_spark.sh treats any failure as "do not swap in".
    if failed:
        print("\nREFUSING TO CONTINUE: the build would contain readable source.")
        return 1
    if a.test:
        return run_tests(src, dst)
    return 0


def run_tests(src: Path, dst: Path) -> int:
    """Copy the tests in beside the build, run them, take them out again."""
    copied = []
    if (src / "tests" / "__init__.py").exists():
        (dst / "tests").mkdir(exist_ok=True)
        shutil.copy2(src / "tests" / "__init__.py", dst / "tests" / "__init__.py")
        copied.append(dst / "tests" / "__init__.py")
    for p in src.rglob("*.py"):
        # tests/ is skipped when building, but it is where tests live here.
        if any(part in SKIP_DIRS - {"tests"} for part in p.relative_to(src).parts) or not is_test(p):
            continue
        target = dst / p.relative_to(src)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, target)
        copied.append(target)
    print(f"\nrunning {len(copied)} test files against the compiled build ...", flush=True)
    try:
        # Tests marked reads_source check the source tree itself; the build has
        # none by design, so conftest skips them when this is set.
        env = {**os.environ, "TSCAN_COMPILED_BUILD": "1"}
        r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider"],
                           cwd=dst, env=env)
        return r.returncode
    finally:
        for p in copied:
            p.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
