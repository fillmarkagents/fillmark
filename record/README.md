# Fillmark record

Reads and computes the Fillmark record of ERC-8004 agents on Robinhood Chain (chain id 4663): every fill an agent made through a Fillmark router, its price against the router's reference price, its cost in USDG, and the client accounts it traded for. This is the code behind [api.fillmark.trade](https://docs.fillmark.trade/api) and the figures on [fillmark.trade](https://fillmark.trade); run it with any RPC to check them.

## Run it

```sh
npm install
RPC=https://rpc.mainnet.chain.robinhood.com npm test
```

`npm test` reads the whole record from chain and checks it against itself: each fill's two ERC-8004 entries, written by the client account to the Reputation Registry, must hold the same cost and size as the router's `Filled` event.

## Use it

```ts
import { createPublicClient, http } from "viem";
import { agentRecord, agentFillsPage, loadRecord } from "./src/index";

const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { batch: { batchSize: 10 } }) });
const record = await loadRecord(client);
console.log(agentRecord(record, 26144n, Math.floor(Date.now() / 1000)));
```

`loadRecord` reads router logs from the three routers' deploy blocks up to the head rounded down to 600 blocks, one event per request, in ranges of 5,000,000 blocks (pass `span` for a node with a smaller limit). It then reads each client account's owner from the Kernel ECDSA validator, each agent's ERC-8004 identity, and block times.

## What is in it

- `src/record.ts` builds the record from logs. It is pure: the same logs and reads always give the same record.
- `src/load.ts` reads those logs and reads from chain.
- `src/summary.ts` gives the JSON views the API serves: agents, one agent's totals, pages of fills, one transaction.
- `src/kernel.ts` checks that a client account was created the standard way, needed before an account is labelled as the Fillmark team's.
- `src/config.ts` holds the contract addresses and the Fillmark team wallets.

## How figures are counted

- `cost` is the USDG paid over the reference value of what was bought, or the reference value sold over the USDG received. Positive is worse for the client.
- `bps` is the fill price against the reference price; positive is worse for the client.
- A fill's ERC-8004 entries are the two the router wrote for it: in the fill's transaction, from the client account, with the fill id as `feedbackHash`, tags `fillmark-cost` and `fillmark-notional` (`-ext` in the extended session) and the cost and size of the `Filled` event. Anyone can write to the registry, so every other entry is left out.
- Cost per 100 USDG is the total cost over the total traded. Read it with the total cost and the worst fill: a ratio alone can be thinned out with cheap round trips.
- A client account is `team` when the Fillmark team owns it and the factory created it the standard way, linked to the agent when its owner is the agent's owner or agent wallet, `unknown` when its owner has not been read or could not be read, and independent otherwise. Ownership through other wallets cannot be seen on chain.
