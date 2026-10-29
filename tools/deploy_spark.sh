#!/usr/bin/env bash
# Deploy the AI services on the DGX Spark from GitHub, compiled.
#
#   ~/tscan/deploy.sh              build, test, swap in, restart
#   ~/tscan/deploy.sh --rollback   put the previous build back
#
# Runs as tscan with the encrypted volume mounted. The source is cloned into a
# temporary folder inside the volume, compiled, and deleted when the run ends,
# whether it succeeded or failed. Nothing readable is left on the machine.
# If the build or its tests fail, the running services are not touched.

set -euo pipefail

REPO="${TSCAN_REPO:-https://github.com/BCSS-Lakshmi-Narayana/T-scan.git}"
BRANCH="${TSCAN_BRANCH:-main}"
ROOT="$HOME/tscan"
APP="$ROOT/app"
VENV="$ROOT/venv"
export PATH="$HOME/node/bin:$PATH"          # pm2

declare -A SRC_DIR=([rag]=RAG_pipline_saga [sentiment]=social_media_sentiment_analysis-multitennacy)
declare -A PM2_NAME=([rag]=tscan-rag [sentiment]=tscan-sentiment)
declare -A HEALTH=([rag]=http://127.0.0.1:8100/api/rag/health [sentiment]=http://127.0.0.1:8003/health)

say() { printf '\n== %s\n' "$*"; }

mountpoint -q "$ROOT" || { echo "The encrypted volume is not mounted. Run: ~/bin/gocryptfs ~/.tscan_enc ~/tscan"; exit 1; }

wait_healthy() {   # the sentiment service needs about two minutes to load its models
    local url=$1 limit=${2:-240} t=0
    until [ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" = "200" ]; do
        sleep 5; t=$((t + 5))
        [ "$t" -ge "$limit" ] && return 1
    done
}

restart_and_check() {
    pm2 restart "${PM2_NAME[rag]}" "${PM2_NAME[sentiment]}" >/dev/null
    for n in rag sentiment; do
        if wait_healthy "${HEALTH[$n]}"; then echo "  $n: healthy"
        else echo "  $n: NOT healthy after 4 minutes. Check: pm2 logs ${PM2_NAME[$n]}"; return 1; fi
    done
}

if [ "${1:-}" = "--rollback" ]; then
    for n in rag sentiment; do
        [ -d "$APP/$n.prev" ] || { echo "no previous build of $n to roll back to"; exit 1; }
    done
    say "rolling back to the previous build"
    for n in rag sentiment; do
        mv "$APP/$n" "$APP/$n.failed"; mv "$APP/$n.prev" "$APP/$n"; mv "$APP/$n.failed" "$APP/$n.prev"
    done
    restart_and_check
    exit
fi

TMP=$(mktemp -d "$ROOT/.deploy.XXXXXX")
trap 'rm -rf "$TMP"' EXIT                    # the source never outlives the run

say "fetching $BRANCH"
git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$TMP/src"
COMMIT=$(git -C "$TMP/src" rev-parse --short HEAD)
echo "  commit $COMMIT"

say "compiling and testing the RAG service"
"$VENV/rag/bin/python" "$TMP/src/tools/compile_python.py" \
    "$TMP/src/${SRC_DIR[rag]}" "$TMP/rag" --test

say "compiling and testing the sentiment service"
"$VENV/sentiment/bin/python" "$TMP/src/tools/compile_python.py" \
    "$TMP/src/${SRC_DIR[sentiment]}" "$TMP/sentiment"
mkdir -p "$TMP/sentiment/tests"
cp "$TMP/src/${SRC_DIR[sentiment]}/tests/"{__init__,test_api_tenant_stance,test_service_auth,test_llm_gate_fairness}.py \
    "$TMP/sentiment/tests/"
( cd "$TMP/sentiment" && TSCAN_COMPILED_BUILD=1 "$VENV/sentiment/bin/python" -m unittest \
    tests.test_api_tenant_stance tests.test_service_auth tests.test_llm_gate_fairness )
rm -rf "$TMP/sentiment/tests"

say "keeping the live configuration"
for n in rag sentiment; do
    cp "$APP/$n/.env" "$TMP/$n/.env"        # .env is never in git
done

say "swapping in build $COMMIT"
for n in rag sentiment; do
    rm -rf "$APP/$n.prev"
    mv "$APP/$n" "$APP/$n.prev"
    mv "$TMP/$n" "$APP/$n"
done
echo "$COMMIT" > "$APP/DEPLOYED_COMMIT"

say "restarting"
if restart_and_check; then
    say "deployed $COMMIT. Roll back with: ~/tscan/deploy.sh --rollback"
else
    echo; echo "The new build did not come up. Roll back with: ~/tscan/deploy.sh --rollback"
    exit 1
fi
