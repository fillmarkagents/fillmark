#!/usr/bin/env bash
# End-to-end run on an anvil fork of Robinhood Chain mainnet. Needs the upstream RPC in
# FILLMARK_UPSTREAM_RPC (kept out of the process list) and the market in session at the
# fork block: the latest block, or FILLMARK_E2E_FORK_BLOCK (an archive RPC) from a trading
# day. anvil's clock then runs on from that block's time.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PORT=${FILLMARK_E2E_PORT:-8546}
WORK=$(mktemp -d)
ANVIL_PID=
TICK_PID=
# A busy anvil can ignore TERM, so it is killed after 5 s.
cleanup() {
  if [ -n "$TICK_PID" ]; then kill "$TICK_PID" 2>/dev/null || true; wait "$TICK_PID" 2>/dev/null || true; fi
  if [ -n "$ANVIL_PID" ]; then
    kill "$ANVIL_PID" 2>/dev/null || true
    for _ in $(seq 25); do kill -0 "$ANVIL_PID" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$ANVIL_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
  return 0
}
trap cleanup EXIT

if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "STOP: something already listens on port $PORT (set FILLMARK_E2E_PORT)" >&2
  exit 1
fi
# anvil reads the fork URL through an alias in a throwaway foundry.toml.
printf '[profile.default]\n\n[rpc_endpoints]\nupstream = "${FILLMARK_UPSTREAM_RPC}"\n' > "$WORK/foundry.toml"
FORK=()
[ -n "${FILLMARK_E2E_FORK_BLOCK:-}" ] && FORK=(--fork-block-number "$FILLMARK_E2E_FORK_BLOCK")
# Robinhood Chain allows contracts up to 98304 bytes (FillmarkRouterV2 is over 24 KiB).
(cd "$WORK" && exec anvil --fork-url upstream "${FORK[@]}" --code-size-limit 98304 --port "$PORT" --silent) &
ANVIL_PID=$!
for _ in $(seq 100); do cast chain-id -r "http://127.0.0.1:$PORT" >/dev/null 2>&1 && break; sleep 0.2; done
kill -0 "$ANVIL_PID" 2>/dev/null || { echo "STOP: anvil did not start" >&2; exit 1; }
# Local blocks on top of the fork: anvil sends fee history requests that reach back to the
# fork block upstream (forge asks for the last 10 blocks), and the upstream node no longer
# serves them for an old block ("historical state ... is not available").
for try in 1 2 3; do
  cast rpc anvil_mine 0x40 -r "http://127.0.0.1:$PORT" --rpc-timeout 120 >/dev/null && break
  [ "$try" = 3 ] && { echo "STOP: anvil could not mine on the fork" >&2; exit 1; }
  sleep 5
done
# After the deploy (forge script forks this node and must not see it move), an empty block
# every second: viem's receipt wait can see a transaction's block before anvil reports the
# transaction mined, and then waits for a next block that automine never makes.
(until [ -e "$WORK/deployed" ]; do sleep 1; done
 while sleep 1; do cast rpc evm_mine -r "http://127.0.0.1:$PORT" >/dev/null 2>&1 || true; done) &
TICK_PID=$!

cd "$ROOT/agent"
# The run moves the chain clock about 1.5 hours ahead, on top of a past fork block's age.
AGE=$(( $(date +%s) - $(cast block latest -f timestamp -r "http://127.0.0.1:$PORT") ))
FILLMARK_MAX_CLOCK_SKEW=$(( ${AGE#-} + 7200 )) FILLMARK_RPC="http://127.0.0.1:$PORT" FILLMARK_E2E_DIR="$WORK" FILLMARK_ROOT="$ROOT" ./node_modules/.bin/tsx "${FILLMARK_E2E_SCRIPT:-e2e/run.ts}"
