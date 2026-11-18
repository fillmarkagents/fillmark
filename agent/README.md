# Fillmark reference agent and client CLI

TypeScript (viem) tools for FillmarkRouter on Robinhood Chain (4663).

- `src/agent.ts`: DCA agent. Each plan buys `usdgPerBuy` of one asset (a ticker from
  `../assets.json`, e.g. TSLA, SPY, WETH or cbBTC) for one client account at most once
  per `intervalSec`. Stock plans trade in the regular session only unless
  `allowExtended` is set; crypto (WETH, cbBTC) trades at any hour unless halted. A plan whose feed is older than its max age is skipped and logged.
  Every fee tier is quoted with Uniswap's QuoterV2 (no signature needed), and the
  best tier the router accepts in simulation is sent with
  `minOut` set `minOutBufferBps` below its quote. An intent is signed only for a tier
  about to be tried, with that tier's `minOut` and the slot's nonce, so at most one
  fills. The nonce comes from the plan and the interval slot, so retries and restarts
  cannot buy twice in one slot; changing a plan's amount or interval starts a new
  series. Quotes and fills stop at `maxSlipBps` above the pool's spot price, which is
  stricter than the router's NAV bound: a buy too large for the pool depth inside that
  range never fills and is logged as "no fee tier can fill". Config: see
  `agent.example.json`.
- `src/cli.ts`: client tool. `create` makes a Kernel v3.1 account with the router
  installed; `status`, `withdraw`, `uninstall` and `install` work on it. User operations
  are hashed locally (chain 4663, EntryPoint v0.7), signed by the owner key and sent to
  the EntryPoint by the owner with zero gas fees, so no bundler is needed and the
  account needs no ETH.

Quotes and reads come from the RPC, so use one you trust. A lying RPC can make the
agent pick a worse tier or a looser `minOut`, but never beyond the limits the client
set on chain (`maxSlipBps` against the Chainlink NAV, per-trade and daily limits).
User operation hashes and account addresses are computed locally, and the RPC's block
time is refused if it is more than 5 minutes off the local clock. Other values from the
RPC (nonces, balances, prices) are bounded by on-chain checks; a lying RPC could still
hand out a future user operation nonce and hold that signed operation back, so run the
CLI against a trusted RPC.

Keys and the RPC URL are read from 0600 files (`/etc/fillmark/...`), never from
arguments.

```sh
npm ci
npm run typecheck
npm run cli -- status <account>          # FILLMARK_ROUTER=0x...
npm run agent -- --config /etc/fillmark/agent.json --once
FILLMARK_UPSTREAM_RPC=... ./e2e/run.sh   # anvil fork e2e, needs the market in session
```
