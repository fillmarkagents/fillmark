#!/usr/bin/env bash
# End-to-end run on an anvil fork of Robinhood Chain mainnet against the live router v3 and
# Fillmark Pay. Needs the upstream RPC in FILLMARK_UPSTREAM_RPC (kept out of the process list)
# and the agent's npm packages installed (agent/: npm ci), whose CLI makes the client accounts.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PORT=${FILLMARK_E2E_PORT:-8547}
WORK=$(mktemp -d)
ANVIL_PID=
cleanup() {
  if [ -n "$ANVIL_PID" ]; then
    kill "$ANVIL_PID" 2>/dev/null || true
    for _ in $(seq 25); do kill -0 "$ANVIL_PID" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$ANVIL_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
  return 0
}
trap cleanup EXIT

: "${FILLMARK_UPSTREAM_RPC:?set FILLMARK_UPSTREAM_RPC}"
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "STOP: something already listens on port $PORT (set FILLMARK_E2E_PORT)" >&2
  exit 1
fi
# anvil reads the fork URL through an alias in a throwaway foundry.toml.
printf '[profile.default]\n\n[rpc_endpoints]\nupstream = "${FILLMARK_UPSTREAM_RPC}"\n' > "$WORK/foundry.toml"
(cd "$WORK" && exec anvil --fork-url upstream --code-size-limit 98304 --port "$PORT" --silent) &
ANVIL_PID=$!
for _ in $(seq 100); do cast chain-id -r "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break; sleep 0.2; done
kill -0 "$ANVIL_PID" 2>/dev/null || { echo "STOP: anvil did not start" >&2; exit 1; }
# Local blocks on top of the fork, so fee history never reaches back upstream.
cast rpc anvil_mine 0x40 -r "http://127.0.0.1:$PORT" --rpc-timeout 120 >/dev/null

cd "$ROOT/sdk"
FILLMARK_RPC="http://127.0.0.1:$PORT" FILLMARK_E2E_DIR="$WORK" FILLMARK_ROOT="$ROOT" ./node_modules/.bin/tsx "${FILLMARK_E2E_SCRIPT:-test/e2e.ts}"
