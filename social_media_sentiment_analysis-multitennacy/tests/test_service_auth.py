"""The backend -> sentiment service key check.

Drives the ASGI middleware directly: no client library, no model load. The
property pinned is that with a key configured, a request without it never
reaches a handler, and that a deployment cannot reach the network with the
check silently off.
"""
from __future__ import annotations

import asyncio
import os
import re
import unittest
from pathlib import Path
from unittest import mock

from service_auth import MIN_KEY_LENGTH, ServiceAuthMiddleware, install_service_auth

KEY = "k" * 40
ROOT = Path(__file__).resolve().parent.parent


async def _inner(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


def _call(app, path="/analyze", method="POST", headers=(), kind="http"):
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


def _guarded():
    return ServiceAuthMiddleware(_inner, key=KEY, exempt=("/health",))


class _FakeApp:
    def __init__(self):
        self.added = []

    def add_middleware(self, cls, **kw):
        self.added.append((cls, kw))


class TestTheCheck(unittest.TestCase):
    def test_no_key_is_refused_before_any_handler(self):
        sent = _call(_guarded())
        self.assertEqual(_status(sent), 401)
        self.assertNotIn(b"ok", b"".join(m.get("body", b"") for m in sent))

    def test_wrong_key_is_refused(self):
        self.assertEqual(_status(_call(_guarded(), headers=[("x-api-key", "w" * 40)])), 401)

    def test_a_prefix_of_the_key_is_refused(self):
        self.assertEqual(_status(_call(_guarded(), headers=[("x-api-key", KEY[:-1])])), 401)

    def test_the_right_key_reaches_the_handler(self):
        self.assertEqual(_status(_call(_guarded(), headers=[("x-api-key", KEY)])), 200)

    def test_header_name_is_case_insensitive(self):
        self.assertEqual(_status(_call(_guarded(), headers=[("X-Api-Key", KEY)])), 200)

    def test_health_needs_no_key(self):
        self.assertEqual(_status(_call(_guarded(), path="/health", method="GET")), 200)

    def test_only_health_is_exempt_not_its_neighbours(self):
        for path in ("/health/x", "/healthz", "/analyze/intelligence"):
            self.assertEqual(_status(_call(_guarded(), path=path)), 401, path)

    def test_a_preflight_needs_no_key(self):
        self.assertEqual(_status(_call(_guarded(), method="OPTIONS")), 200)

    def test_a_websocket_without_the_key_is_closed(self):
        self.assertEqual(_call(_guarded(), kind="websocket"),
                         [{"type": "websocket.close", "code": 1008}])


class TestInstalling(unittest.TestCase):
    def test_with_a_key_it_is_installed(self):
        app = _FakeApp()
        with mock.patch.dict(os.environ, {"X_KEY": KEY}):
            self.assertTrue(install_service_auth(app, "X_KEY", exempt=("/h",)))
        self.assertIs(app.added[0][0], ServiceAuthMiddleware)

    def test_without_a_key_it_stays_open(self):
        app = _FakeApp()
        env = {k: v for k, v in os.environ.items()
               if k not in ("X_KEY", "SERVICE_AUTH_REQUIRED")}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertFalse(install_service_auth(app, "X_KEY"))
        self.assertEqual(app.added, [])

    def test_required_but_missing_stops_the_service_booting(self):
        env = {k: v for k, v in os.environ.items() if k != "X_KEY"}
        env["SERVICE_AUTH_REQUIRED"] = "true"
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaisesRegex(RuntimeError, "Refusing to start"):
                install_service_auth(_FakeApp(), "X_KEY")

    def test_a_short_key_is_rejected(self):
        with mock.patch.dict(os.environ, {"X_KEY": "short"}):
            with self.assertRaisesRegex(RuntimeError, str(MIN_KEY_LENGTH)):
                install_service_auth(_FakeApp(), "X_KEY")


@unittest.skipIf(os.environ.get("TSCAN_COMPILED_BUILD") == "1",
                 "reads api_server.py; a compiled build has no source by design")
class TestGuardRails(unittest.TestCase):
    def setUp(self):
        self.src = (ROOT / "api_server.py").read_text(encoding="utf-8")

    def test_the_service_installs_the_check(self):
        """A later edit that drops the call would silently reopen the service."""
        self.assertRegex(self.src,
                         r'install_service_auth\(\s*app\s*,\s*"SENTIMENT_SERVICE_API_KEY"')

    def test_only_health_is_exempt_in_the_service(self):
        m = re.search(r"install_service_auth\([^)]*exempt=\(([^)]*)\)", self.src)
        self.assertIsNotNone(m, "exempt list not found")
        self.assertEqual(re.findall(r'"([^"]+)"', m.group(1)), ["/health"])


if __name__ == "__main__":
    unittest.main()
