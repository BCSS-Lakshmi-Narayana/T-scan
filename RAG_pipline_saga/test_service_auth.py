"""The backend -> RAG service key check.

Drives the ASGI middleware directly rather than through a client, so these need
no httpx and no model load.

What is pinned here is the one property that matters: with a key configured, a
request that does not carry it never reaches a handler. Every other test exists
to make that hard to lose by accident -- a short key, a missing key on a
service that is meant to be locked, an endpoint quietly added to the exempt
list.
"""

import asyncio
import os
import re
from pathlib import Path
from unittest import mock

import pytest

from service_auth import MIN_KEY_LENGTH, ServiceAuthMiddleware, install_service_auth

KEY = "k" * 40


async def _inner(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


def _call(app, path="/api/rag/v2/query", method="GET", headers=(), kind="http"):
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {"type": kind, "method": method, "path": path,
             "headers": [(k.lower().encode(), v.encode()) for k, v in headers]}
    asyncio.run(app(scope, receive, send))
    return sent


def _status(sent):
    return next(m["status"] for m in sent if m["type"] == "http.response.start")


def _guarded(exempt=("/api/rag/health",)):
    return ServiceAuthMiddleware(_inner, key=KEY, exempt=exempt)


class _FakeApp:
    def __init__(self):
        self.added = []

    def add_middleware(self, cls, **kw):
        self.added.append((cls, kw))


# ------------------------------------------------------------ the check itself

def test_a_request_without_the_key_is_refused_before_any_handler():
    sent = _call(_guarded())
    assert _status(sent) == 401
    assert b"ok" not in b"".join(m.get("body", b"") for m in sent)


def test_a_request_with_the_wrong_key_is_refused():
    assert _status(_call(_guarded(), headers=[("x-api-key", "w" * 40)])) == 401


def test_a_key_that_is_only_a_prefix_of_the_real_one_is_refused():
    assert _status(_call(_guarded(), headers=[("x-api-key", KEY[:-1])])) == 401


def test_the_right_key_reaches_the_handler():
    assert _status(_call(_guarded(), headers=[("x-api-key", KEY)])) == 200


def test_the_header_name_is_case_insensitive():
    assert _status(_call(_guarded(), headers=[("X-Api-Key", KEY)])) == 200


def test_a_post_is_guarded_like_a_get():
    assert _status(_call(_guarded(), method="POST")) == 401


def test_health_needs_no_key():
    assert _status(_call(_guarded(), path="/api/rag/health")) == 200


def test_a_preflight_needs_no_key():
    assert _status(_call(_guarded(), method="OPTIONS")) == 200


def test_only_the_exempt_path_is_exempt_not_its_neighbours():
    # Exact match: a prefix rule would have exempted /api/rag/health/../v2.
    for path in ("/api/rag/health/x", "/api/rag/healthz", "/api/rag/v2/query"):
        assert _status(_call(_guarded(), path=path)) == 401, path


def test_a_websocket_without_the_key_is_closed():
    sent = _call(_guarded(), kind="websocket")
    assert sent == [{"type": "websocket.close", "code": 1008}]


def test_lifespan_events_are_not_blocked():
    # Blocking startup would stop the service booting at all.
    sent = []

    async def inner(scope, receive, send):
        sent.append(scope["type"])

    asyncio.run(ServiceAuthMiddleware(inner, key=KEY)(
        {"type": "lifespan"}, None, None))
    assert sent == ["lifespan"]


# ------------------------------------------------------------------ installing

def test_with_a_key_the_middleware_is_installed():
    app = _FakeApp()
    with mock.patch.dict(os.environ, {"X_KEY": KEY}, clear=False):
        assert install_service_auth(app, "X_KEY", exempt=("/h",)) is True
    cls, kw = app.added[0]
    assert cls is ServiceAuthMiddleware and kw["exempt"] == ("/h",)


def test_without_a_key_it_stays_open_and_says_so(caplog):
    app = _FakeApp()
    with mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop("X_KEY", None)
        os.environ.pop("SERVICE_AUTH_REQUIRED", None)
        assert install_service_auth(app, "X_KEY") is False
    assert app.added == []


def test_when_auth_is_required_a_missing_key_stops_the_service_booting():
    with mock.patch.dict(os.environ, {"SERVICE_AUTH_REQUIRED": "true"}, clear=False):
        os.environ.pop("X_KEY", None)
        with pytest.raises(RuntimeError, match="Refusing to start"):
            install_service_auth(_FakeApp(), "X_KEY")


def test_a_short_key_is_rejected():
    with mock.patch.dict(os.environ, {"X_KEY": "short"}, clear=False):
        with pytest.raises(RuntimeError, match=str(MIN_KEY_LENGTH)):
            install_service_auth(_FakeApp(), "X_KEY")


def test_a_blank_key_counts_as_missing():
    with mock.patch.dict(os.environ, {"X_KEY": "   "}, clear=False):
        os.environ.pop("SERVICE_AUTH_REQUIRED", None)
        assert install_service_auth(_FakeApp(), "X_KEY") is False


# -------------------------------------------------------------- guard rails

def test_the_service_actually_installs_the_check():
    """A later edit that drops the call would silently reopen the service."""
    src = (Path(__file__).parent / "api_server.py").read_text(encoding="utf-8")
    assert re.search(r'install_service_auth\(\s*app\s*,\s*"RAG_SERVICE_API_KEY"', src)


def test_only_health_is_exempt_in_the_service():
    src = (Path(__file__).parent / "api_server.py").read_text(encoding="utf-8")
    m = re.search(r"install_service_auth\([^)]*exempt=\(([^)]*)\)", src)
    assert m, "exempt list not found"
    assert re.findall(r'"([^"]+)"', m.group(1)) == ["/api/rag/health"]
