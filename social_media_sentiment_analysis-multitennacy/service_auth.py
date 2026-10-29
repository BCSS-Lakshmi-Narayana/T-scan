"""Shared-secret check for the backend -> AI service hop.

This service takes `tenant_id`, `role`, `districts` and `permissions` from the
request body and believes them: the Node backend fills them from a verified
login, and nothing here re-checks. That is safe only while the backend is the
sole caller, which a loopback bind guarantees and a network bind does not. Once
the service listens on a LAN, anyone who can reach the port can post
`role: admin, districts: null` and read every district.

A source-IP firewall narrows who can try; it does not replace this. Addresses on
a shared network are not identities, and a rule gets loosened the first time
something needs debugging. A secret the backend holds and nobody else does is
the check that survives that.

Behaviour:
  * key set          every request needs a matching `x-api-key`, else 401
  * key unset        requests pass, with a warning. Right on 127.0.0.1 and for
                     tests; wrong anywhere else
  * SERVICE_AUTH_REQUIRED=true and no key
                     the service refuses to start, so a deployment cannot reach
                     the network with the check silently off
"""

from __future__ import annotations

import hmac
import logging
import os
from typing import Iterable

MIN_KEY_LENGTH = 32

_TRUE = ("1", "true", "yes", "on")


class ServiceAuthMiddleware:
    """Pure ASGI, so it adds no per-request overhead beyond one header lookup."""

    def __init__(self, app, key: str, exempt: Iterable[str] = ()):
        self.app = app
        self._key = key.encode("utf-8")
        self._exempt = frozenset(exempt)

    async def __call__(self, scope, receive, send):
        kind = scope["type"]
        if kind == "lifespan":
            await self.app(scope, receive, send)
            return
        # Liveness probes and CORS preflights carry no key. Neither reaches data.
        if kind == "http" and (scope["path"] in self._exempt or scope["method"] == "OPTIONS"):
            await self.app(scope, receive, send)
            return

        presented = b""
        for name, value in scope.get("headers", ()):
            if name == b"x-api-key":
                presented = value
                break
        # compare_digest: the comparison time must not reveal how much matched.
        if hmac.compare_digest(presented, self._key):
            await self.app(scope, receive, send)
            return

        if kind == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = b'{"detail":"invalid or missing service key"}'
        await send({"type": "http.response.start", "status": 401, "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ]})
        await send({"type": "http.response.body", "body": body})


def install_service_auth(app, env_var: str, *, exempt: Iterable[str] = (),
                         logger: logging.Logger | None = None) -> bool:
    """Wire the check into `app`. Returns True when it is active."""
    log = logger or logging.getLogger(__name__)
    key = os.getenv(env_var, "").strip()
    required = os.getenv("SERVICE_AUTH_REQUIRED", "").strip().lower() in _TRUE

    if not key:
        if required:
            raise RuntimeError(
                f"SERVICE_AUTH_REQUIRED is set but {env_var} is empty. Refusing to start "
                f"with the service open: set {env_var} to a random secret of at least "
                f"{MIN_KEY_LENGTH} characters, the same one the backend sends.")
        log.warning(
            "%s is not set: this service accepts UNAUTHENTICATED requests. That is "
            "acceptable on 127.0.0.1 only. Do not bind it to a network like this.", env_var)
        return False

    if len(key) < MIN_KEY_LENGTH:
        # A short key is the same as no key to anyone who can try a few million.
        raise RuntimeError(
            f"{env_var} is {len(key)} characters; at least {MIN_KEY_LENGTH} are required. "
            "Generate one with: python3 -c \"import secrets; print(secrets.token_hex(32))\"")

    app.add_middleware(ServiceAuthMiddleware, key=key, exempt=tuple(exempt))
    log.info("Service key check active on %s (health endpoints exempt: %s).",
             env_var, ", ".join(exempt) or "none")
    return True
