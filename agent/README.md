# Fillmark reference agent and client CLI

TypeScript (viem) tools for FillmarkRouterV3 on Robinhood Chain (4663).

- `src/agent.ts`: DCA agent with take-profit. It finds its clients on chain: every account
  whose router config names this agent (found through the router's `Installed` events
  from `deployBlock`), is not past its expiry plus the router's 7-day sale grace (after
  expiry it only sells), and installed it with a performance fee of at least
  `minPerfFeeBps` (default 0). Each UTC day, for each asset the client allowed:
  - when the Chainlink price is at least `takeProfitBps` (default 500, 5%; at least 1)
    above the average cost of the units this agent bought for the account (the router's
    lot, read with `positionOf`), it sells, again and again that day, until the lot is
    sold. Sales do not use the daily limit (router v3 counts buys only). Each sale is about the client's per-trade limit,
    or the rest of the lot if worth less, and never more than the lot, so units the client
    sent itself stay. A sale is sized so the USDG received and its NAV value stay inside
    the per-trade limit even if the pool moves by `maxDevBps` or the feed by 0.5% before
    it lands, and its `minOut` is at least the router's 10 USDG minimum and, after the
    fill fee, the cost of the units sold, so a sale never sells below cost. A day with a
    sale has no buy of that asset, and neither do the next 7 days (the router's `hold`
    in whole days): a buy then would take the sale's waiting gain off its cost, so at a
    flat price above the mark the agent could buy one day and sell the next. When not
    even one sale fits (a per-trade limit under about 10.2 USDG, or a lot worth less than
    10 USDG), the agent buys instead, unless that pause applies;
  - otherwise it buys once, outside that pause, when the account holds the USDG plus the
    router's fill fee (3 bps, sent to the burner) and owes this agent no fees: the
    client's per-trade limit, or less so that the buy and its fill fee fit what is left of
    the router's rolling 24-hour limit (`windowSpent`), and at least 10 USDG.
  At most `maxFillsPerDay` (default 300) fills
  are sent per day across all clients, counted from the router's `Filled` events so the cap
  holds across restarts, and pairs go round robin (every account's first asset, then every
  account's second) so no single account takes the whole cap. Only Kernel accounts on the
  known implementation with no executor hook are traded, and each fill is sent with a
  1.5M gas cap (v3 fills use about 0.70M to 0.92M in fork tests), so no account can make a fill burn the agent's ETH; an account whose fill
  reverts on chain is skipped for the rest of the day. Below `minEth` (default 0.0005 ETH)
  in the agent wallet it sends nothing and logs an error once an hour; below four times
  that it logs a warning. Stocks trade in the regular session only unless
  `allowExtended` is set and the client did not install for regular hours only; crypto
  (WETH, cbBTC) trades at any hour unless halted. An asset whose feed is older than its
  max age, or unreadable, or whose router pool is switched off, is skipped and logged.
  Router v3 trades each token in one official pool and bounds the price itself (against
  the Chainlink NAV and the pool's TWAP); the agent quotes that pool with Uniswap's
  QuoterV2, simulates the fill and sends it from its own wallet, with `minOut` set
  `minOutBufferBps` below the quote. v3 takes no signature: only the agent wallet pinned
  at install may send a fill. A fill the router refuses in simulation is logged and tried
  again every 15 minutes. An intent expires at the end of its UTC day. A buy's nonce comes from the account, asset and day, and a sale's also from
  its number that day, so retries, restarts and a client changing its limits can never
  buy an asset twice in one day or repeat a sale; up to `previousRouterUntilDay` a buy
  under the same nonce on `previousRouter` (the v2 router clients move from) also counts,
  so the day a client moves never buys twice. Quotes and fills also stop at `maxSlipBps`
  from the pool's spot price: a trade too large for the pool depth inside that range never
  fills, is logged once and is tried again every 15 minutes. Config: see
  `agent.example.json`.
- `src/cli.ts`: client tool. `create` makes a Kernel v3.1 account with the router
  installed (`--perf-fee-bps` is the agent's share of net realized gains, its terms;
  `--regular-only` keeps stock fills out of extended hours; `--daily-limit` counts buys
  and their fill fees over any 24 hours);
  `status`, `withdraw`, `uninstall` and `install` work on it. `uninstall` closes the
  agent's book at the NAV of that moment when every token can be priced; otherwise
  `close-out` does it once prices are back. `settle` charges a due performance fee from
  the fee escrow the router holds on sale gains (then from the account), `release`
  returns escrow no fee can need without pricing any token, `pay-debt` pays fees owed to
  an agent that was removed, and `claim` sends an address the USDG the router could not
  pay it (for example while USDG froze it). User operations
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
agent use a looser `minOut`, but never beyond the limits the client
set on chain (`maxSlipBps` and the pool's bounds against the Chainlink NAV and TWAP,
per-trade and daily limits).
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
FILLMARK_UPSTREAM_RPC=... FILLMARK_E2E_SCRIPT=e2e/sell.ts ./e2e/run.sh   # take-profit sales, crypto only, any hour
```
