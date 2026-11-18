#!/usr/bin/env bash
# End-to-end run on an anvil fork of Robinhood Chain mainnet. Needs the upstream RPC in
# FILLMARK_UPSTREAM_RPC (kept out of the process list) and the market in session.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PORT=${FILLMARK_E2E_PORT:-8546}
WORK=$(mktemp -d)
ANVIL_PID=
cleanup() { [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

if cast chain-id -r "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
  echo "STOP: something already listens on port $PORT (set FILLMARK_E2E_PORT)" >&2
  exit 1
fi
# anvil reads the fork URL through an alias in a throwaway foundry.toml.
printf '[profile.default]\n\n[rpc_endpoints]\nupstream = "${FILLMARK_UPSTREAM_RPC}"\n' > "$WORK/foundry.toml"
(cd "$WORK" && exec anvil --fork-url upstream --port "$PORT" --silent) &
ANVIL_PID=$!
for _ in $(seq 100); do cast chain-id -r "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break; sleep 0.2; done
kill -0 "$ANVIL_PID" 2>/dev/null || { echo "STOP: anvil did not start" >&2; exit 1; }

cd "$ROOT/agent"
# The run moves the chain clock about 1.5 hours ahead.
FILLMARK_MAX_CLOCK_SKEW=7200 FILLMARK_RPC="http://127.0.0.1:$PORT" FILLMARK_E2E_DIR="$WORK" FILLMARK_ROOT="$ROOT" ./node_modules/.bin/tsx e2e/run.ts
