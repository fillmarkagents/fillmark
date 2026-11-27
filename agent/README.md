# Fillmark reference agent and client CLI

TypeScript (viem) tools for FillmarkRouterV3 on Robinhood Chain (4663).

- `src/agent.ts`: the agent. Each client account follows the strategy its owner chose, dca with
  take-profit or rebalance (see Strategies below). It finds its clients on chain: every account
  whose router config names this agent (found through the router's `Installed` events
  from `deployBlock`), is not past its expiry plus the router's 7-day sale grace (after
  expiry it only sells), and installed it with a performance fee of at least
  `minPerfFeeBps` (default 0). Under dca, each UTC day, for each asset the client allowed:
  - when the Chainlink price is at least `takeProfitBps` (default 500, 5%; at least 1; a dca setting brings its own)
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
  fills, is logged once and is tried again every 15 minutes.
  Fillmark Pay: with `payRateBps` (0 to 5) set, the agent keeps its terms on FillmarkPay
  with `setRate` at start (rate, and `payMinZeroAtBps`, default 100, as the lowest cost level
  a client may open with). Before a fill of an asset an account's open agreement does not
  track, it sends `track`; a buy waits if that fails, a sale goes on. With `payRequired`,
  once the burner has its token, it buys only for accounts whose open agreement allows and
  holds what is due plus what the buy adds, and still sells what it bought for the others.
  It reads the $FILLMARK pool price each tick and keeps the last hour of them. Once a UTC
  day per open agreement (also of accounts it no longer serves, until paid or closed) it
  settles what can be paid now, again later that day when the block budget held part back:
  only with at least `paySamples` prices seen (default 30, or as many as an hour of ticks
  holds), the current one within `paySlipBps` (default 300, 3%) of their median, at least
  `payMinUsdg` (default 0.01) payable, and with a minimum of that median less the pool's
  swap fees, the 10% burn and `paySlipBps`. Config: see `agent.example.json`.
  Strategies: the account's owner signs a setting (EIP-712, domain "Fillmark" version 1 on
  chain 4663 with the router as verifying contract) and posts it. The agent reads settings
  from `settingsUrl` (or `settingsFile`) at most every two minutes and keeps every one it has
  seen in `settingsStore`. It uses a setting only when its signer is the account's ECDSA owner
  and the ECDSA validator is the account's root validator. A setting takes effect at the first
  00:00 UTC after its `validFrom`, and not before the day after the agent first saw it; the
  highest `seq` in effect wins, and two settings with that seq stop the account. An account
  with no setting gets dca as before, under the same nonces. The agent never moves an account
  to another strategy than the one it chose: until it has read the settings once (or has them
  on disk) it trades nothing, and an account whose setting cannot be used (a signer that is
  not the owner) is not traded. A setting the agent first sees today starts tomorrow; until then
  the account keeps its strategy, except when the store was started today (lost, or a new
  machine) and the setting is dated before today: it may already be in effect, so the account
  waits for it.
  A setting's nonces carry its fingerprint (the top 128 bits of its EIP-712 digest), so every
  fill shows the setting it ran under. Under a dca setting the pause after a sale lasts while
  the router still holds that sale's gain.
  Rebalance: the setting gives target weights in bps for the client's allowed assets and for
  USDG (adding up to 10000), a drift threshold `driftBps` (100 to 5000, or 0 for none) and a
  schedule `everyDays` (0, 7 or 30). The agent values the account at the router's prices:
  each asset's balance, and the USDG less what Fillmark Pay and the router are owed. When a
  weight is off its target by the threshold, or in a scheduled window (3 days a week, 7 days a
  month, counted from the day after `validFrom`), it trades back to within half the threshold
  (50 bps on a schedule alone), in trades of at least 10 USDG: sales of the units it bought
  first (never the client's own units, and with no take-profit floor), largest first, then
  buys within the per-trade and daily limits. A sale that cannot go now (under 10 USDG, or
  refused) waits for the next tick and the buys go on without it. A day's sales also stay within
  the daily limit, which Fillmark Pay's allowance assumes. A run goes on the next day while it
  traded the day before; a day with no rebalance trade ends it. It starts only when every asset
  it must trade can be priced and traded now, sends at most `maxRebalanceTradesPerDay`
  (default 20) trades per account per day, and none after the permission expires. For an asset
  whose target is 0 it sells every unit it bought, the last of them even under 10 USDG.
  Moved units (`src/keeper.ts`): the router books units a client moves out of its account,
  or back in, only when someone next syncs that token (a settle, a fill of that asset or
  the close-out), at that moment's NAV, so whoever picks the moment picks the price. Each
  tick, for every account on router v3 whatever its agent, the agent sends `settle` for
  such a move (one worth at least 1 USDG at cost) and `closeOut` for a book whose router
  was removed, as soon as the call simulates. Settle needs a live price for every token of
  the book; until then the account's own agent can still book a move earlier with a fill
  of that asset. At most 10 a tick and 100 a day, 4M gas each, largest value first (the
  units it books at the latest reference price, whatever the account's agent); it stops
  below three times `minEth`. Router v2 books are not covered.
- `src/cli.ts`: client tool. `create` makes a Kernel v3.1 account with the router
  installed (`--perf-fee-bps` is the agent's share of net realized gains, its terms;
  `--regular-only` keeps stock fills out of extended hours; `--daily-limit` counts buys
  and their fill fees over any 24 hours);
  `status`, `withdraw`, `uninstall` and `install` work on it. `uninstall` closes the
  agent's book at the NAV of that moment when every token can be priced; otherwise
  `close-out` does it once prices are back. Anyone can send it, at any later time: the
  agent above sends it once every price is live, and the client can send it first.
  `settle` charges a due performance fee from
  the fee escrow the router holds on sale gains (then from the account), `release`
  returns escrow no fee can need without pricing any token, `pay-debt` pays fees owed to
  an agent that was removed, and `claim` sends an address the USDG the router could not
  pay it (for example while USDG froze it). `pay-open` opens a Fillmark Pay agreement
  with the account's agent on its current terms in one batch (a USDG allowance for
  FillmarkPay, one for all the account's agreements, to which it adds by default the rate on
  twice the daily buy limit for each day until the permission ends and 7 days after; then
  `open` tracking every allowed asset), `pay-close` ends it and sets the allowance to 0
  (`--keep-allowance` leaves it for another open agreement), and `pay-status` shows what is
  earned, paid and due. `strategy` signs the account's setting for its agent (no
  transaction, no gas) with the key in `FILLMARK_KEY_FILE` when that key is the owner, or
  prints the typed data for a wallet owner to sign; `--post` sends it to
  `FILLMARK_SETTINGS_URL`. User operations
  are hashed locally (chain 4663, EntryPoint v0.7) and sent to the EntryPoint by the key
  in `FILLMARK_KEY_FILE` with zero gas fees, so no bundler is needed and the account needs
  no ETH. By default that key is also the owner and signs. With `--owner`, `create` makes
  an account owned by another wallet and the key only pays gas. Owner-only commands then
  print the user operation and its hash, send nothing and exit 2; the owner signs the hash
  (personal_sign) and the command runs again with `--signature` (for `install`, with the
  printed `--expiry`; for `withdraw`, with the printed amount). A wallet-owned `withdraw`
  needs `--to`. A `withdraw` of a token the agent's open book tracks adds `settle` to the
  same batch when every token of the book has a live price, so the move is booked at that
  NAV; otherwise it goes alone and is booked at the next sync (the agent above sends one
  once every price of the book is live), and the output carries a `warning`: until then a
  fill of that asset by the account's agent books the units at the price of the moment
  the agent picks.
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
FILLMARK_UPSTREAM_RPC=... FILLMARK_E2E_SCRIPT=e2e/pay.ts ./e2e/run.sh    # Fillmark Pay on the live contracts, crypto only, any hour
FILLMARK_UPSTREAM_RPC=... FILLMARK_E2E_SCRIPT=e2e/strategy.ts ./e2e/run.sh   # client strategies on the live router, crypto only, any hour
```
