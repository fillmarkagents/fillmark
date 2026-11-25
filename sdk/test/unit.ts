// Read-only checks against Robinhood Chain (FILLMARK_RPC): the SDK's addresses, asset list and
// arithmetic must equal what the live contracts hold and compute.
import assert from "node:assert/strict";
import { createPublicClient, erc20Abi, getAddress, http, parseAbi } from "viem";
import { robinhood } from "viem/chains";
import { ADDRESSES, ASSETS, CHAIN_ID, ROUTER_DEPLOY_BLOCK, bucketOf, buyRoom, feedsAbi, navValue, navValueCeil, payAbi, priceLimit, routerAbi, spotPrice } from "../src/index.js";

const rpc = process.env.FILLMARK_RPC;
if (!rpc) throw new Error("set FILLMARK_RPC");
const pub = createPublicClient({ chain: robinhood, transport: http(rpc, { timeout: 30_000 }) });
const read = (address: `0x${string}`, abi: any, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args }) as Promise<any>;

assert.equal(await pub.getChainId(), CHAIN_ID);

// Addresses: the router's immutables, Pay's wiring and the deploy block.
assert.equal(await read(ADDRESSES.router, routerAbi, "feeds"), ADDRESSES.feeds);
assert.equal(await read(ADDRESSES.router, routerAbi, "usdg"), ADDRESSES.usdg);
assert.equal(await read(ADDRESSES.router, routerAbi, "burner"), ADDRESSES.burner);
assert.equal(await read(ADDRESSES.router, routerAbi, "identity"), ADDRESSES.identity);
assert.equal(await read(ADDRESSES.router, routerAbi, "reputation"), ADDRESSES.reputation);
assert.equal(await read(ADDRESSES.pay, payAbi, "router"), ADDRESSES.router);
assert.equal(await read(ADDRESSES.pay, payAbi, "burner"), ADDRESSES.burner);
assert.equal(await read(ADDRESSES.pay, payAbi, "usdg"), ADDRESSES.usdg);
// The router's creation transaction (deployments/4663-v3.json).
const created = await pub.getTransactionReceipt({ hash: "0x456b76ccf13f5f8ce60a75edba8bfad61858354fbec1f10275b56017a84b25fe" });
assert.equal(created.blockNumber, ROUTER_DEPLOY_BLOCK);
assert.equal(created.contractAddress && getAddress(created.contractAddress), ADDRESSES.router);
const quoterFactory = await read(ADDRESSES.quoter, parseAbi(["function factory() view returns (address)"]), "factory");
assert.equal(quoterFactory, await read(ADDRESSES.router, routerAbi, "factory"));
console.log("addresses OK");

// Assets: each has a feed, the token's decimals and the feeds' decimals agree, and the
// crypto flag matches.
for (const a of ASSETS) {
  assert.notEqual(await read(ADDRESSES.feeds, feedsAbi, "feedOf", [a.token]), "0x0000000000000000000000000000000000000000", a.ticker);
  assert.equal(Number(await read(ADDRESSES.feeds, feedsAbi, "decimalsOf", [a.token])), a.decimals, a.ticker);
  assert.equal(Number(await read(a.token, erc20Abi, "decimals")), a.decimals, a.ticker);
  assert.equal(await read(ADDRESSES.feeds, feedsAbi, "isCrypto", [a.token]), a.crypto, a.ticker);
  assert.equal(getAddress(a.token), a.token);
}
const pooled = (await Promise.all(ASSETS.map((a) => read(ADDRESSES.router, routerAbi, "poolOf", [a.token])))).filter((p) => p.active).length;
console.log(`assets OK (${ASSETS.length} priced, ${pooled} with an active router pool)`);

// Arithmetic: the router's pure functions on edge and random inputs.
let seed = 7n;
const rand = (bits: bigint) => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
  return (seed * seed * 31n + seed) % (1n << bits);
};
const cases = 60;
for (let i = 0; i < cases; i++) {
  const decimals = [0, 6, 8, 18][i % 4];
  const amount = i < 4 ? [0n, 1n, 10n ** 30n, 123n][i] : rand(80n);
  const price = 1n + rand(40n);
  assert.equal(navValue(amount, price, decimals), await read(ADDRESSES.router, routerAbi, "navValueOf", [amount, price, decimals]));
  assert.equal(navValueCeil(amount, price, decimals), await read(ADDRESSES.router, routerAbi, "navValueCeil", [amount, price, decimals]));
  const sqrtP = 4295128740n + rand(150n);
  for (const token0 of [true, false])
    assert.equal(spotPrice(sqrtP, token0, decimals), await read(ADDRESSES.router, routerAbi, "spotPrice", [sqrtP, token0, decimals]));
  const usdgAmount = i < 10 ? [0n, 9_999_999n, 10_000_000n, 29_999_999n, 30_000_000n, 999_999_999n, 1_000_000_000n, 9_999_999_999n, 10_000_000_000n, 10n ** 20n][i] : rand(40n);
  assert.equal(bucketOf(usdgAmount), Number(await read(ADDRESSES.router, routerAbi, "bucketOf", [usdgAmount])));
}
console.log(`arithmetic OK (${cases} cases each)`);

// The sizing helpers against the live reference agent's own functions.
const ref = await import("../../agent/src/agent.js");
const usdg = ADDRESSES.usdg;
for (let i = 0; i < cases; i++) {
  const token = ASSETS[i % ASSETS.length].token;
  const sqrtP = 4295128740n + rand(150n);
  const slip = 1 + Number(rand(10n) % 1000n);
  assert.equal(priceLimit(sqrtP, token, usdg, true, slip), ref.buyLimit(sqrtP, token, slip));
  assert.equal(priceLimit(sqrtP, token, usdg, false, slip), ref.sellLimit(sqrtP, token, slip));
  const [perTrade, daily, spent] = [rand(36n), rand(38n), rand(38n)];
  assert.equal(buyRoom(perTrade, daily, spent, 3n), ref.buyAmount(perTrade, daily, spent, 3n));
}
console.log(`sizing OK (${cases} cases each)`);
console.log("UNIT OK");
