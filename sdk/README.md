# @fillmark/sdk

TypeScript SDK for ERC-8004 agents that trade through the [Fillmark](https://fillmark.trade) router on Robinhood Chain (chain id 4663). It finds the client accounts that installed the agent, sizes and quotes fills inside each client's limits, and sends them from the agent wallet. Every fill is checked by the router against the Chainlink price and written to the agent's ERC-8004 reputation by the client's account.

```sh
npm install @fillmark/sdk viem
```

## Quick start

```ts
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import { fillmarkAgent } from "@fillmark/sdk";

const transport = http(process.env.RPC_URL);
const agent = fillmarkAgent({
  publicClient: createPublicClient({ chain: robinhood, transport }),
  walletClient: createWalletClient({ chain: robinhood, transport, account: privateKeyToAccount(agentKey) }),
  agentId: 123n, // the agent's ERC-8004 id; the key must be its agent wallet
  strategies: ["dca"], // client strategies this agent follows (see Client strategy settings)
});

await agent.check(); // chain, clock, and that the key is the agent wallet

for (const client of await agent.clients()) {
  const quote = await agent.quoteBuy({ account: client.account, asset: "TSLA" }); // the largest buy that fits
  if (!quote.ok) {
    console.log(client.account, quote.reason, quote.message);
    continue;
  }
  const fill = await agent.fill(quote);
  console.log(fill.hash, fill.shortfallPpm); // fill price against Chainlink, millionths
}
```

## What it does

| Call | |
| --- | --- |
| `check()` | Chain id, the RPC's clock, and that the wallet client is the agent wallet pinned in the ERC-8004 registry |
| `setting(account)` | The strategy setting the account's owner signed for this agent, as it applies today: none, active (and whether this agent follows it) or blocked |
| `clients()` | Accounts with this agent installed: limits, allowed assets, USDG, rolling 24-hour use, fee debt, whether buys are open |
| `market(assets?)` | Session, Chainlink price and age, the router pool's price against it, and whether the asset trades now |
| `maxBuy`, `maxSell` | The largest buy or sale the client's limits, balance and the agent's lot allow now |
| `quoteBuy`, `quoteSell` | Checks in the router's order, a Uniswap quote in the router's pool, and a simulation of the fill; refusals carry the router's error name |
| `fill(quote)` | Sends the quoted fill from the agent wallet with a fixed 1,500,000 gas limit |
| `record(accounts?)` | The agent's record from the router (fills, volume, total cost against Chainlink, worst fill) |
| `book`, `settleFees`, `release`, `closeOut`, `claimable`, `claim` | The agent's book with an account and its performance fees |
| `pay.setRate`, `pay.terms`, `pay.due`, `pay.track` | Fillmark Pay: the agent's rate and what clients owe it |
| `accountStatus(client, account)` | A client account as the router sees it (no agent needed) |

## Fill policy

The router enforces each client's limits. The SDK adds rules that keep an agent from wasting client money or its own ETH, applied to every `fill`:

1. No sale under the lot's cost after the fill fee (`saleAboveCost`).
2. No buy while a sale's gain waits out the router's 7-day hold, since the buy would cancel it (`noBuyDuringHold`).
3. At most `maxFillsPerPairPerDay` fills per account and asset per UTC day (default 2, up to 50).
4. Nonces come from the router, agent, install, account, asset, day and a counter, so a retry never fills twice.
5. Only standard Kernel accounts without hooks are traded, checked again before each send.
6. A fill that reverts on chain skips its account for the rest of the day; every send counts toward `maxFillsPerDay` (default 300).
7. One send at a time, and no new fill for an account and asset while the previous one is pending.

Rules 1 to 3 can be changed through `policy`; 4 to 7 cannot. The policy state lives in memory unless a `store` is passed (see `memoryStore` for the interface); a store on disk keeps the caps across restarts.

## Client strategy settings

A client chooses a strategy for an agent by signing a setting in the Fillmark app (EIP-712, no transaction): `dca` with a take-profit level, or `rebalance` with target weights, a cash share and a drift threshold or schedule. The app stores it at api.fillmark.trade. List the strategies the agent follows in `strategies`; the SDK then marks every fill with the account's setting and refuses accounts it cannot follow:

- A setting applies from the later of its own start day and the day after it was stored (00:00 UTC); one the source shows only after an earlier read the same day applies from the next day. So one day never mixes two settings. The latest `seq` wins, and only while the account's owner is the signer.
- A fill under a setting carries the top 128 bits of the setting's EIP-712 hash in the top 128 bits of its nonce. The router logs each fill's id from that nonce, so the Fillmark record shows which of the client's settings each fill was sent under. Under `rebalance` the SDK buys only the setting's target assets (`NotATarget`); when and how much to trade is the agent's code.
- Quotes for an account whose setting is in effect are refused with `StrategyNotFollowed` when the agent does not list its strategy, and with `SettingBlocked` when the latest setting cannot be followed (signed by someone other than the owner now, a strategy or field this SDK does not accept, a target asset the account no longer allows, two settings with the same `seq`).
- All the agent's settings are read in one request, again every two minutes and on each new UTC day, and every one seen is kept in the `store`. Pass a store on disk: with the default memory store, a restart forgets which settings were already seen today. If the source cannot be read and was not read today, quotes are refused with `SettingsUnavailable`.

What a strategy means (when to buy, sell or rebalance) is the agent's own code: `setting(account)` returns the signed parameters. `settings.url` points at another source with the same answer format, for self-hosting; a custom `settings.fetch` must time out on its own.

## Notes

- Use a private RPC, not the public one. Quotes come from it; a lying RPC can make a quote worse, but never past the limits the client set on chain.
- Amounts are bigints: USDG has 6 decimals, prices have Chainlink's 8, asset units use the token's decimals (`ASSETS`).
- The bundled asset list is a hint; whether an asset trades is always read from chain.
- Errors are `FillmarkError` with a `code` and a short message. They never include the RPC URL.

Contracts, docs and the reference agent: [github.com/fillmarkagents/fillmark](https://github.com/fillmarkagents/fillmark), [docs.fillmark.trade](https://docs.fillmark.trade). MIT license.
