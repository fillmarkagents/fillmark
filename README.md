<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/fillmark-banner-dark.png">
  <img src="brand/fillmark-banner.png" alt="Fillmark. Agent fills, marked against the market.">
</picture>

# Fillmark Agents

An on-chain execution-quality record for ERC-8004 agents trading Robinhood stock tokens
and crypto tokens against USDG on Uniswap v3, measured against Chainlink feeds, on
Robinhood Chain (4663). Tokens may have any number of decimals up to 18.

Site [fillmark.trade](https://fillmark.trade), client app [app.fillmark.trade](https://app.fillmark.trade),
docs [docs.fillmark.trade](https://docs.fillmark.trade), updates on X [@fillmarkagents](https://x.com/fillmarkagents).

- `src/FillmarkRouterV3.sol`: the current router, an ERC-7579 executor module. Only the
  agent wallet pinned when the client installs it may send a fill. Each token trades in one
  official USDG pool (28 of the 30 registered tokens; BABA and COIN have none), and the
  router bounds every swap's price itself. With C the smaller of the pool's cap and the
  client's slippage limit less the fill fee, the pool price after the swap may be at most C
  above Chainlink NAV for a buy (below it for a sale), and the pool tick at most the smaller
  of C and the pool's TWAP cap past its TWAP in the same direction. The client's own account
  writes the fill's cost and notional to the ERC-8004
  Reputation Registry in the same transaction; a write that fails is counted and logged
  instead of blocking the fill. Each fill pays a fill fee in USDG to the burner (3
  bps, at most 10, set through the timelock). Buys count against the client's limit over the
  current hour and the 24 before it, fill fee included; the agent sells only units it bought, and may keep
  selling them for 7 days after the permission expires. A client may keep the agent to
  regular US market hours for stocks. A performance fee of 0 to 30% of realized gains above
  the agent's previous peak is held in the router while a sale's gain waits to count, then
  paid or returned by the router's rules.
- `src/FillmarkRouterV2.sol`: the second router, retired (see Deployment): signed fill
  intents, the fill fee and a performance fee ledger, with the pool chosen by the agent.
- `src/FillmarkBurner.sol`: receives the fill fees, and nothing can withdraw them. Once the
  timelock sets the $FILLMARK token (only once, and only for a graduated Pons V2 launch
  paired with USDG whose position Pons locked), anyone may call `burn()` at most once an
  hour. Each call spends at most 0.5% of the USDG side of that locked position on
  $FILLMARK and sends what it buys to 0xdEaD.
- `src/FillmarkPay.sol`: pays an ERC-8004 agent in $FILLMARK from the client account it
  trades for. The agent sets a rate of 0 to 5 bps and the lowest zero point a client may
  pick; the client opens an agreement from its own account with a zero point Z of at most
  1,000 bps. The agent earns its rate on the notional router v3 recorded for the
  agreement's tokens since they were tracked, cut in a straight line by their recorded
  cost: all of it at an average cost of zero or better, none at Z. Only the agent wallet
  pinned in the router settles, naming the least $FILLMARK it accepts per USDG. The account
  pays what is due in USDG, Pay buys $FILLMARK with it in the burner's Pons pool and sends
  90% to that wallet and 10% to 0xdEaD. All of Pay buys at most 0.1% of the locked
  position's USDG side per Ethereum block, and nothing in the same second as a burn. A
  client may close at any time; what is still owed is billed if it opens again with the
  same agent. Until the burner has its token, settle pays nothing.
- `src/FillmarkRouter.sol`: the first router, retired (see Deployment). It has v2's price,
  slippage and limit checks, without fees or a ledger.
- `src/FillmarkFeeds.sol`: token to Chainlink feed map, the US market calendar for
  stock tokens and halts for crypto tokens (which otherwise trade at any hour while
  their feed is fresh), add-only, administered through a timelock. A guardian may add
  a closure or crypto halt at once (starting within 1 hour, at most 3 days per fixed
  30-day window).
- `script/Deploy.s.sol`: deploys the owner (a Safe 2-of-3), the timelock, feeds (every token
  in `assets.json` and the NYSE calendar through 2028) and the first router. A one-time
  deployer runs the setup, then hands the timelock's proposer, executor and canceller roles
  to the Safe and keeps none.
- `script/DeployV2.s.sol`: deploys the burner and the second router next to the first
  one, using the live feeds and the timelock as admin of both. The deployer gets no role.
- `script/DeployV3.s.sol` and `v3-pools.json`: deploy the current router next to the others,
  with the live feeds, burner, timelock as admin and the feeds' guardian, and its official
  pools, caps and TWAP window as measured by a price sampler before deploy. The deployer
  gets no role.
- `script/DeployPay.s.sol`: deploys Pay next to router v3, which is its only setting.
- `assets.json`: the tokens registered at deploy: every token on Robinhood Chain with a
  Chainlink USD feed, a genuine contract (Robinhood's stock token beacon, or the issuer's
  own listing) and a Uniswap v3 USDG pool that filled $100 both ways within 10% of NAV
  when measured. Later tokens are added through the timelock.
- `agent/`: reference agent and client CLI (TypeScript, viem). Each client account follows the
  strategy its owner signed, dca with take-profit or rebalance to target weights; an account
  with no setting gets dca. See `agent/README.md`.
  The agent can change while the deployed contracts cannot.
- `record/`: the code that reads the Fillmark record from chain and computes it, behind
  [api.fillmark.trade](https://docs.fillmark.trade/api) and the figures on fillmark.trade.
  See `record/README.md`.
- `brand/`: logo, mark, avatar and banner files. See `brand/README.md`.

## Deployment

Robinhood Chain (4663). Tag `v1.0.0` is the deployed source of the feeds and the first
router, tag `v2.0.0` of the second router and the burner, tag `v3.0.0` of the current
router, and tag `pay-v1.0.0` of Fillmark Pay. The reference agent that runs for ERC-8004
agent 26144 is tag `agent-v0.6.2`.

| Contract | Address |
| --- | --- |
| Owner, Safe 2-of-3 | `0x6C3a19517e5c1cff510BC163DCA4a46C7a969261` |
| TimelockController, 2-day delay | `0x54b6b215e216938Cb673b5d256593c0a1dDacAC3` |
| FillmarkFeeds | `0xa54584AA004DD9E60522437A96F700d6d283EAA0` |
| FillmarkRouterV3 (current) | `0x6F01e2bE7d1D31E88dF177bEC23392D1905FC8Aa` |
| FillmarkRouterV2 (second, retired) | `0x15A172CAA75AB7de22E9Bb3Cd981eA8c76cBe366` |
| FillmarkBurner | `0x418106F0356E638C3823221FDBd2fBb3e8D7B024` |
| FillmarkPay | `0x0f967E8CD8D3C9393DA64023d443b9Af691ED4D8` |
| FillmarkRouter (first, retired) | `0xe542a7c8779962b8f819c4352d1436e08bc2d388` |
| Guardian (closures, halts and switching a v3 pool off only) | `0x534eeE806911FF49529e49A6cb94A5B3A6e9cBc3` |
| Reference agent wallet, ERC-8004 agent 26144 (identity owned by the Safe) | `0xDCe0AAc0A8E6629A0ae3c739ced29B8B31c960B8` |

The Safe is the timelock's proposer, executor and canceller, and the timelock is its own
admin. No router has an owner or can be upgraded, and neither has Pay. Through the
timelock, the Safe can add tokens, market periods, closures and halts to the feeds, change
the fill fee of routers v2 and v3 (0 to 10 bps), set or replace a v3 official pool and its
caps, and set the burner's token once. The guardian may switch a v3 pool off at once; only
the timelock switches it on. The deployer holds no role. `deployments/4663.json`,
`deployments/4663-v2.json`, `deployments/4663-v3.json` and `deployments/4663-pay.json` list
the deploy transactions, and the matching folders under `broadcast/` hold the Foundry
broadcasts. A recursive clone builds bytecode identical to the deployed contracts.
`FOUNDRY_PROFILE=chain forge build --sizes` checks them against Robinhood Chain's
98,304-byte contract size limit.

Routers v1 and v2 are retired. They cannot be switched off, but their price bounds are
weaker than v3's: the agent picks the pool fee tier and signs its own reference price, so
only the client's slippage limit binds the fill. On 26 Nov 2026 no account had either
installed. The client app installs v3 only, the CLI refuses to install v1 or v2, and the SDK works
with v3 only.

## Tests

Clone with the submodules. Tests fork mainnet, no mocks:

```sh
git clone --recursive https://github.com/fillmarkagents/fillmark
cd fillmark
forge build
FILLMARK_RPC=<rpc url> forge test
cd agent && npm ci && FILLMARK_UPSTREAM_RPC=<rpc url> ./e2e/run.sh
```

The fork tests and the e2e need US stocks in session (24/5) and fresh feeds.
`test/Pay.t.sol` was run with `FILLMARK_FORK_BLOCK=122878720`, which needs an archive RPC.
