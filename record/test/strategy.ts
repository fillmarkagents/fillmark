// Strategy settings and fill tags, offline. The vectors were built with the reference agent's own
// code (agent/src/settings.ts and agent.ts), so a change on either side that breaks the match fails here.
// npm run test:strategy
import assert from "node:assert/strict";
import { getAddress, type Hex } from "viem";
import { ASSETS, ROUTER_V3 } from "../src/config";
import type { Fill } from "../src/record";
import {
  accountGroup, buyNonce, fillIdOf, fingerprint, invalidReason, parseSetting, rebalanceNonce, saleNonce, sdkNonce, settingHash, signerOf, tagFills, withFingerprint, type Setting,
} from "../src/strategy";

const token = (t: string) => getAddress(ASSETS.find((a) => a.ticker === t)!.token);
const WETH = token("WETH");
const CBBTC = token("cbBTC");
const account = getAddress("0x404BaE2f867D691a09cb29E9d6223fb344230669");
const signer = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const rebalance: Setting = {
  account, agentId: 7n, strategy: "rebalance", takeProfitBps: 0,
  targets: [{ asset: WETH, ticker: "WETH", weightBps: 5000 }, { asset: CBBTC, ticker: "cbBTC", weightBps: 3000 }],
  cashBps: 2000, driftBps: 500, everyDays: 7, validFrom: 1795600000n, seq: 2n,
};
const dca: Setting = { account, agentId: 7n, strategy: "dca", takeProfitBps: 300, targets: [], cashBps: 0, driftBps: 0, everyDays: 0, validFrom: 1795600000n, seq: 1n };

assert.equal(settingHash(rebalance), "0x015cfba12b21ee9dc509e8e0e27b5b1df3679d679922d80898abc9d8fd6c50b1");
assert.equal(settingHash(dca), "0x9d958bfb749ecbd85e9dd7d6300b68b7f41d9135b09939e8088a1698cb8d2995");
assert.equal(
  await signerOf({ setting: rebalance, signature: "0xee4f9b8a375470be28716012578a8d99d73ecf47d8dcf92b6443afa45010058c45061229777a59a8837427cddbdab56bacba8e81f03f9143105d124a37aae36b1c" }),
  signer,
);
assert.equal(
  await signerOf({ setting: dca, signature: "0x585a305691cff422060c40d977a14869c8f87823cd9f51571e658f6cca7fff365e4bc006cd85fa390858719f0a622e0e9947efe474427ce417c4945cc73e3c951b" }),
  signer,
);
const day = 20783n;
assert.equal(buyNonce(account, WETH, day), 60047429502794922295502138163297682814143751871473005394112457151353340367684n);
assert.equal(saleNonce(account, WETH, day, 3n), 1023178634173726366546327370166657560728284627665055212920264519815981375693n);
assert.equal(rebalanceNonce(account, CBBTC, day, true, 2n), 25755495134604212189013047774589600231196078796246014334305014150678254610150n);
console.log("OK   hashes, signatures and nonces match the agent's");

// Settings checks.
assert.equal(invalidReason(rebalance), null);
assert.equal(invalidReason(dca), null);
assert.match(invalidReason({ ...rebalance, cashBps: 1000 })!, /add up to 10000/);
assert.match(invalidReason({ ...rebalance, targets: [{ ...rebalance.targets[0]!, ticker: "cbBTC" }, rebalance.targets[1]!] })!, /ticker does not match/);
assert.match(invalidReason(rebalance, [WETH])!, /not allowed/);
assert.match(invalidReason({ ...dca, takeProfitBps: 99 })!, /takeProfitBps/);
assert.match(invalidReason({ ...rebalance, driftBps: 0, everyDays: 0 })!, /threshold, a schedule/);
assert.deepEqual(parseSetting(JSON.parse(JSON.stringify({ ...rebalance, agentId: "7", validFrom: "1795600000", seq: "2" }))), rebalance);
console.log("OK   settings checks");

// Tags: fills built from the agent's nonces, as the router logs them.
const time = Number(day * 86_400n) + 3600;
let k = 0;
const fill = (stock: typeof WETH, buy: boolean, nonce: bigint, agentId = 7n): Fill =>
  ({ router: ROUTER_V3, version: 3, fillId: fillIdOf(ROUTER_V3, account, nonce), tx: `0x${(++k).toString(16).padStart(64, "0")}` as Hex, block: 1n, logIndex: k, time, account, agentId, stock, buy, usdg: 20_000_000n, fillFee: 6_000n }) as unknown as Fill;
const fpR = fingerprint(rebalance);
const fpD = fingerprint(dca);
const fills = [
  fill(WETH, true, buyNonce(account, WETH, day)), // own dca
  fill(WETH, false, saleNonce(account, WETH, day, 0n)),
  fill(CBBTC, true, withFingerprint(fpD, buyNonce(account, CBBTC, day))), // dca setting
  fill(CBBTC, false, withFingerprint(fpR, rebalanceNonce(account, CBBTC, day, true, 0n))), // rebalance
  fill(CBBTC, false, withFingerprint(fpR, rebalanceNonce(account, CBBTC, day, true, 1n))),
  fill(WETH, false, withFingerprint(fpR, rebalanceNonce(account, WETH, day, true, 0n)), 8n), // another agent's id
  fill(WETH, true, 12345n), // not the reference agent's nonce
];
const settings = new Map([[account.toLowerCase(), [dca, rebalance]]]);
const tags = tagFills(fills, settings);
const tag = (i: number) => tags.get(fills[i]!.fillId.toLowerCase());
assert.deepEqual(tag(0), { strategy: "dca", setting: null });
assert.deepEqual(tag(1), { strategy: "dca", setting: null });
assert.deepEqual(tag(2), { strategy: "dca", setting: settingHash(dca) });
assert.deepEqual(tag(3), { strategy: "rebalance", setting: settingHash(rebalance) });
assert.deepEqual(tag(4), { strategy: "rebalance", setting: settingHash(rebalance) });
assert.equal(tag(5), undefined, "a setting binds one agent id");
assert.equal(tag(6), undefined);
assert.equal(tagFills(fills.slice(3, 5), new Map()).size, 0, "a rebalance fill needs its setting");
const later = { ...rebalance, validFrom: (day + 1n) * 86_400n }; // takes effect the day after the fills
const fpL = fingerprint(later);
const early = [fill(CBBTC, false, withFingerprint(fpL, rebalanceNonce(account, CBBTC, day, true, 0n)))];
assert.equal(tagFills(early, new Map([[account.toLowerCase(), [later]]])).size, 0, "a setting is never tried before its effective day");
const some = tagFills(fills, settings, new Set([fills[3]!.fillId.toLowerCase()]));
assert.deepEqual([...some.keys()], [fills[3]!.fillId.toLowerCase()], "only the fills asked for are tagged");
assert.equal(accountGroup(fills.slice(0, 3), tags), "dca");
assert.equal(accountGroup(fills.slice(3, 5), tags), "rebalance");
assert.equal(accountGroup(fills.slice(0, 5), tags), "mixed");
assert.equal(accountGroup(fills.slice(5), tags), "unattributed");
console.log("OK   fill tags and account groups");

// Fills sent with @fillmark/sdk: n counts buys and sales of the pair together, under one install.
const sdk = (stock: typeof WETH, buy: boolean, n: bigint, fp: bigint | null, nonceInstall = 4n): Fill => {
  const base = sdkNonce(ROUTER_V3, 7n, nonceInstall, account, stock, day, n);
  return { ...fill(stock, buy, fp === null ? base : withFingerprint(fp, base)), installId: 4n } as Fill;
};
const viaSdk = [
  sdk(WETH, true, 0n, fpD),
  sdk(WETH, true, 1n, fpD),
  sdk(WETH, false, 2n, fpD), // the pair's third fill of the day
  sdk(CBBTC, true, 0n, fpR),
  sdk(CBBTC, true, 1n, null), // the SDK with no setting
  sdk(CBBTC, true, 2n, fpR, 5n), // a nonce built for another install than the fill's
];
const sdkTags = tagFills(viaSdk, settings);
const st = (i: number) => sdkTags.get(viaSdk[i]!.fillId.toLowerCase());
for (const i of [0, 1, 2]) assert.deepEqual(st(i), { strategy: "dca", setting: settingHash(dca) });
assert.deepEqual(st(3), { strategy: "rebalance", setting: settingHash(rebalance) });
assert.equal(st(4), undefined, "an SDK fill without a setting is not attributed");
assert.equal(st(5), undefined, "the nonce must be from the install the fill ran under");
console.log("OK   SDK fill tags");
console.log("ALL OK");
