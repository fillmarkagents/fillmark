<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/fillmark-banner-dark.png">
  <img src="brand/fillmark-banner.png" alt="Fillmark. Agent trades have a cost. Fillmark counts it.">
</picture>

# Fillmark Agents

An on-chain execution-quality record for ERC-8004 agents trading Robinhood stock tokens
and crypto tokens against USDG on Uniswap v3, measured against Chainlink feeds, on
Robinhood Chain (4663). Tokens may have any number of decimals up to 18.

- `src/FillmarkRouter.sol`: ERC-7579 executor module. Agents sign fill intents; every fill
  must land within the client's slippage bound against NAV, and the client's own account
  writes the fill's cost and notional to the ERC-8004 Reputation Registry in the same
  transaction.
- `src/FillmarkFeeds.sol`: token to Chainlink feed map, the US market calendar for
  stock tokens and halts for crypto tokens (which otherwise trade at any hour while
  their feed is fresh), add-only, administered through a timelock. A guardian may add
  a closure or crypto halt at once (starting within 1 hour, at most 3 days per 30-day
  window).
- `script/Deploy.s.sol`: deploys the owner (a Safe 2-of-3), the timelock, feeds (every token
  in `assets.json` and the NYSE calendar through 2028) and router. A one-time deployer runs
  the setup, then hands the timelock's proposer, executor and canceller roles to the Safe
  and keeps none.
- `assets.json`: the tokens registered at deploy: every token on Robinhood Chain with a
  Chainlink USD feed, a genuine contract (Robinhood's stock token beacon, or the issuer's
  own listing) and a Uniswap v3 USDG pool that filled $100 both ways within 10% of NAV
  when measured. Later tokens are added through the timelock.
- `agent/`: reference DCA agent and client CLI (TypeScript, viem). See `agent/README.md`.
- `brand/`: logo, mark, avatar and banner files. See `brand/README.md`.

## Deployment

Robinhood Chain (4663). Tag `v1.0.0` is the deployed source.

| Contract | Address |
| --- | --- |
| Owner, Safe 2-of-3 | `0x6C3a19517e5c1cff510BC163DCA4a46C7a969261` |
| TimelockController, 2-day delay | `0x54b6b215e216938Cb673b5d256593c0a1dDacAC3` |
| FillmarkFeeds | `0xa54584AA004DD9E60522437A96F700d6d283EAA0` |
| FillmarkRouter | `0xe542a7c8779962b8f819c4352d1436e08bc2d388` |
| Guardian (closures and halts only) | `0x534eeE806911FF49529e49A6cb94A5B3A6e9cBc3` |

The Safe is the timelock's proposer, executor and canceller, the timelock is its own admin,
the router has no owner and cannot be upgraded, and the deployer holds no role.
`deployments/4663.json` lists the deploy transactions, and `broadcast/Deploy.s.sol/4663/`
holds the Foundry broadcast. A recursive clone builds bytecode identical to the deployed
router and feeds.

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
