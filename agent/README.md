# Fillmark reference agent and client CLI

TypeScript (viem) tools for FillmarkRouter on Robinhood Chain (4663).

- `src/agent.ts`: DCA agent. It finds its clients on chain: every account whose router
  config names this agent (found through the router's `Installed` events from
  `deployBlock`), is not expired, and holds at least one trade's USDG. Once per UTC day,
  for each asset the client allowed, it buys the client's per-trade limit, while the
  daily limit and the balance allow it. At most `maxFillsPerDay` (default 300) buys are
  sent per day across all clients, counted from the router's `Filled` events so the cap
  holds across restarts, and buys go round robin (every account's first asset, then every
  account's second) so no single account takes the whole cap. Only Kernel accounts on the
  known implementation with no executor hook are traded, and each fill is sent with a
  1.2M gas cap, so no account can make a fill burn the agent's ETH; an account whose fill
  reverts on chain is skipped for the rest of the day. Below `minEth` (default 0.0005 ETH)
  in the agent wallet it sends nothing and logs an error once an hour; below four times
  that it logs a warning. Stocks trade in the regular session only unless
  `allowExtended` is set; crypto (WETH, cbBTC) trades at any hour unless halted. An asset
  whose feed is older than its max age, or unreadable, is skipped and logged. Every fee
  tier is quoted with Uniswap's QuoterV2 (no signature needed), and the best tier the
  router accepts in simulation is sent with `minOut` set `minOutBufferBps` below its
  quote. An intent is signed only for a tier about to be tried, with that tier's `minOut`
  and the day's nonce, and expires at the end of that UTC day, so at most one fills, on
  that day. The nonce comes from the account, asset and day, so retries, restarts and a
  client changing its limits cannot buy the same asset twice in one day; up to
  `legacyNonceUntilDay` a buy under the earlier plan-based nonce also counts. Quotes and
  fills stop at `maxSlipBps` above the pool's spot price, which is stricter than the
  router's NAV bound: a buy too large for the pool depth inside that range never fills,
  is logged once as "no fee tier can fill" and is tried again every 15 minutes. Config:
  see `agent.example.json`.
- `src/cli.ts`: client tool. `create` makes a Kernel v3.1 account with the router
  installed; `status`, `withdraw`, `uninstall` and `install` work on it. User operations
  are hashed locally (chain 4663, EntryPoint v0.7) and sent to the EntryPoint by the key
  in `FILLMARK_KEY_FILE` with zero gas fees, so no bundler is needed and the account needs
  no ETH. By default that key is also the owner and signs. With `--owner`, `create` makes
  an account owned by another wallet and the key only pays gas. Owner-only commands then
  print the user operation and its hash, send nothing and exit 2; the owner signs the hash
  (personal_sign) and the command runs again with `--signature` (for `install`, with the
  printed `--expiry`; for `withdraw`, with the printed amount). A wallet-owned `withdraw`
  needs `--to`.
- `fillmark-agent.service`: systemd unit that keeps the agent running from
  `/srv/apps/fillmark/agent` with `/etc/fillmark/agent.json`, as root without capabilities.
  Set the node path in `ExecStart` to `command -v node`, copy it to `/etc/systemd/system/`,
  then `systemctl enable --now fillmark-agent`; logs go to `journalctl -u fillmark-agent`.

Quotes and reads come from the RPC, so use one you trust. A lying RPC can make the
agent pick a worse tier or a looser `minOut`, but never beyond the limits the client
set on chain (`maxSlipBps` against the Chainlink NAV, per-trade and daily limits).
User operation hashes and account addresses are computed locally, and the RPC's block
time is refused if it is more than 5 minutes off the local clock. Other values from the
RPC (nonces, balances, prices, the account owner) are bounded by on-chain checks; a lying
RPC could still hand out a future user operation nonce and hold that signed operation
back, so run the CLI against a trusted RPC.

Keys and the RPC URL are read from 0600 files (`/etc/fillmark/...`), never from
arguments.

```sh
npm ci
npm run typecheck
npm run cli -- status <account>          # FILLMARK_ROUTER=0x...
npm run agent -- --config /etc/fillmark/agent.json --once
FILLMARK_UPSTREAM_RPC=... ./e2e/run.sh   # anvil fork e2e, needs the market in session
```
