#!/usr/bin/env bash
# Deploy the Node backend on Server 1 from GitHub, compiled to bytecode.
#
#   ~/tscan/deploy.sh              build, smoke-test, swap in, restart
#   ~/tscan/deploy.sh --rollback   put the previous build back
#
# Runs as tscan with the encrypted volume mounted. The source is cloned into a
# temporary folder inside the volume, compiled, and deleted when the run ends,
# whether it succeeded or failed. Nothing readable source is left on the machine.
# If the build or its smoke test fails, the running backend is not touched.
#
# The frontend is served as a built bundle (source maps off) and is handled by
# `npm run build`, not this script.

set -euo pipefail

REPO="${TSCAN_REPO:-https://github.com/BCSS-Lakshmi-Narayana/T-scan.git}"
BRANCH="${TSCAN_BRANCH:-main}"
ROOT="$HOME/tscan"
APP="$ROOT/app"                    # compiled backend lives here
FE="$ROOT/frontend"               # built frontend (build/ served by pm2) + its .env
HEALTH="http://127.0.0.1:8000/api/health"
FE_URL="http://127.0.0.1:3000"
# Frontend build settings (kept here, not in git; source maps OFF so browser code can't be un-minified).
FE_BACKEND_URL="${FE_BACKEND_URL:-http://10.121.9.15:8000}"
export PATH="$HOME/node/bin:$PATH" # node + pm2

say() { printf '\n== %s\n' "$*"; }

mountpoint -q "$ROOT" || { echo "The encrypted volume is not mounted. Run: ~/bin/gocryptfs ~/.tscan_enc ~/tscan"; exit 1; }

wait_healthy() {
    local url=$1 limit=${2:-90} t=0
    until [ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" = "200" ]; do
        sleep 3; t=$((t + 3)); [ "$t" -ge "$limit" ] && return 1
    done
}

restart_and_check() {
    pm2 restart tscan-backend tscan-frontend >/dev/null
    local ok=1
    if wait_healthy "$HEALTH"; then echo "  backend: healthy"; else echo "  backend: NOT healthy after 90s. Check: pm2 logs tscan-backend"; ok=0; fi
    if wait_healthy "$FE_URL" 30; then echo "  frontend: serving"; else echo "  frontend: NOT serving. Check: pm2 logs tscan-frontend"; ok=0; fi
    [ "$ok" = "1" ]
}

if [ "${1:-}" = "--rollback" ]; then
    [ -d "$APP.prev" ] || { echo "no previous build to roll back to"; exit 1; }
    say "rolling back to the previous build (backend + frontend)"
    mv "$APP" "$APP.failed"; mv "$APP.prev" "$APP"; mv "$APP.failed" "$APP.prev"
    if [ -d "$FE/build.prev" ]; then
        rm -rf "$FE/build.failed"; mv "$FE/build" "$FE/build.failed"; mv "$FE/build.prev" "$FE/build"; mv "$FE/build.failed" "$FE/build.prev"
    fi
    restart_and_check
    exit
fi

TMP=$(mktemp -d "$ROOT/.deploy.XXXXXX")
trap 'rm -rf "$TMP"' EXIT                    # the source never outlives the run

say "fetching $BRANCH"
git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$TMP/src"
COMMIT=$(git -C "$TMP/src" rev-parse --short HEAD)
echo "  commit $COMMIT"

say "installing production dependencies (incl. bytenode)"
( cd "$TMP/src/backend" && PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund )

say "compiling to bytecode and smoke-testing the compiled build"
# --smoke loads the whole compiled graph with TSCAN_BOOT=off: it proves every
# .jsc is valid for this Node version without connecting to the DB or collecting.
# node_modules must be in place first so the module graph can load.
node "$TMP/src/tools/compile_node.js" "$TMP/src/backend" "$TMP/backend"
mv "$TMP/src/backend/node_modules" "$TMP/backend/node_modules"
cp "$APP/.env" "$TMP/backend/.env"           # .env is never in git; load needs it
( cd "$TMP/backend" && TSCAN_BOOT=off node src/index.js ) \
    || { echo "smoke test FAILED: the compiled build did not load on this Node version"; exit 1; }
echo "  smoke test passed: the compiled build loads"

say "keeping the live runtime data"
for d in storage downloads public/uploads; do
    [ -d "$APP/$d" ] && { mkdir -p "$TMP/backend/$(dirname "$d")"; cp -a "$APP/$d" "$TMP/backend/$d"; }
done

say "building the frontend (source maps off)"
( cd "$TMP/src/frontend"
  cp "$FE/.env" .env 2>/dev/null || true       # keep the live frontend .env if there is one
  PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund
  REACT_APP_BACKEND_URL="$FE_BACKEND_URL" ENABLE_HEALTH_CHECK=false GENERATE_SOURCEMAP=false \
    NODE_OPTIONS=--max-old-space-size=6144 npm run build )
[ -f "$TMP/src/frontend/build/index.html" ] || { echo "frontend build failed: no build/index.html"; exit 1; }
echo "  frontend built"

say "swapping in build $COMMIT (backend + frontend)"
rm -rf "$APP.prev"
[ -d "$APP" ] && mv "$APP" "$APP.prev"          # first run: no previous build
mv "$TMP/backend" "$APP"
echo "$COMMIT" > "$APP/DEPLOYED_COMMIT"
mkdir -p "$FE"
rm -rf "$FE/build.prev"
[ -d "$FE/build" ] && mv "$FE/build" "$FE/build.prev"
mv "$TMP/src/frontend/build" "$FE/build"

say "restarting"
if restart_and_check; then
    say "deployed $COMMIT. Roll back with: ~/tscan/deploy.sh --rollback"
else
    echo; echo "The new build did not come up. Roll back with: ~/tscan/deploy.sh --rollback"
    exit 1
fi
