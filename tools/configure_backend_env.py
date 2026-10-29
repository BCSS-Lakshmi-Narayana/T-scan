#!/usr/bin/env python3
"""Turn the backend .env copied from the old setup into the one for the app server.

    MONGO_APP_PW=... RAG_SERVICE_API_KEY=... SENTIMENT_SERVICE_API_KEY=... \\
        python3 tools/configure_backend_env.py backend/.env  http://10.121.9.15

What it changes, and why:

  MONGODB_URI, SUPER_ADMIN_MONGODB_URI   the local MongoDB on this server
  RAG_API_URL, SENTIMENT_SERVICE_URL     the SSH tunnel to the AI services
  RAG_SERVICE_API_KEY, SENTIMENT_SERVICE_API_KEY
                                         the shared secrets the AI services check
  CORS_ORIGINS                           the address officers use, nothing else
  DEFAULT_TENANT_SLUG                    t-scan. A request by bare IP carries no
                                         tenant in its address, so the backend
                                         falls back to this; the old value named
                                         a tenant that is not in this database
  NODE_ENV                               production

What it deliberately leaves alone:

  PLATFORM_SECRETS_KEY   it encrypts credentials already stored in the database.
                         Changing it makes them unreadable.

What it removes:

  every commented-out assignment ("# KEY=value"). Those are how old credentials
  survive in a file long after anyone stopped using them.

The file is rewritten in place, with owner-only permissions. Nothing is printed
except key names.
"""

from __future__ import annotations

import os
import re
import stat
import sys
from urllib.parse import quote_plus

ASSIGN = re.compile(r"^(\s*)(#\s*)?([A-Z][A-Z0-9_]*)\s*=(.*)$")
TENANT_SLUG = "t-scan"


def _need(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"{name} is not set. Type it in for this run; nothing is stored.")
    return v


def build_updates(origin: str) -> dict[str, str]:
    pw = quote_plus(_need("MONGO_APP_PW"))
    mongo = f"mongodb://tscanapp:{pw}@127.0.0.1:27017/?replicaSet=rs0&authSource=admin"
    rag_key = _need("RAG_SERVICE_API_KEY")
    sent_key = _need("SENTIMENT_SERVICE_API_KEY")
    for name, key in (("RAG_SERVICE_API_KEY", rag_key), ("SENTIMENT_SERVICE_API_KEY", sent_key)):
        if len(key) < 32:
            sys.exit(f"{name} is {len(key)} characters; the AI services require at least 32.")
    return {
        "MONGODB_URI": f'"{mongo}"',
        "SUPER_ADMIN_MONGODB_URI": f'"{mongo}"',
        "RAG_API_URL": '"http://127.0.0.1:8100"',
        "SENTIMENT_SERVICE_URL": '"http://127.0.0.1:8003"',
        "RAG_SERVICE_API_KEY": rag_key,
        "SENTIMENT_SERVICE_API_KEY": sent_key,
        "CORS_ORIGINS": f'"{origin}"',
        "DEFAULT_TENANT_SLUG": TENANT_SLUG,
        "NODE_ENV": "production",
    }


def rewrite(text: str, updates: dict[str, str]) -> tuple[str, dict[str, int]]:
    out, seen, dropped = [], set(), 0
    for raw in text.splitlines():
        m = ASSIGN.match(raw.rstrip("\r"))
        if m and m.group(2):            # a commented-out assignment
            dropped += 1
            continue
        if m and m.group(3) in updates:
            key = m.group(3)
            if key in seen:             # a duplicate would win over the one we set
                continue
            out.append(f"{key}={updates[key]}")
            seen.add(key)
            continue
        out.append(raw.rstrip("\r"))
    missing = [k for k in updates if k not in seen]
    if missing:
        out += ["", "# --- set for the app server ---"] + [f"{k}={updates[k]}" for k in missing]
    return "\n".join(out).rstrip("\n") + "\n", {
        "replaced": len(seen), "added": len(missing), "dropped_commented": dropped}


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    path, origin = sys.argv[1], sys.argv[2].rstrip("/")
    if not re.fullmatch(r"https?://[A-Za-z0-9.-]+(:\d+)?", origin):
        sys.exit(f"origin must look like http://10.121.9.15, got: {origin}")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    new, stats = rewrite(text, build_updates(origin))
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(new)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    print(f"{path}: {stats['replaced']} settings replaced, {stats['added']} added, "
          f"{stats['dropped_commented']} commented-out assignments removed")
    for k in ("PLATFORM_SECRETS_KEY", "JWT_SECRET"):
        print(f"  {k}: {'kept' if re.search(rf'^{k}=', new, re.M) else 'MISSING'}")


if __name__ == "__main__":
    main()
