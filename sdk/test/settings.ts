// Offline: the SDK's setting hashes, fingerprints and checks equal the reference agent's
// (agent/src/settings.ts) and the record library's (record/src/strategy.ts), including the
// setting the team account's owner signed on mainnet on 26 Nov 2026.
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { ADDRESSES, assetOf, fingerprint, invalidReason, parseSetting, settingHash, signerOf, withFingerprint, type Setting } from "../src/index.js";
import * as agentSide from "../../agent/src/settings.js";
// The record library resolves its imports bundler-style, so it is loaded at run time only.
const recordPath = "../../record/src/strategy.ts";
const recordSide: any = await import(recordPath);

const WETH = assetOf("WETH")!.token;
const CBBTC = assetOf("cbBTC")!.token;
const account = getAddress("0x404BaE2f867D691a09cb29E9d6223fb344230669");
const rebalance: Setting = {
  account,
  agentId: 7n,
  strategy: "rebalance",
  takeProfitBps: 0,
  targets: [
    { asset: WETH, ticker: "WETH", weightBps: 5000 },
    { asset: CBBTC, ticker: "cbBTC", weightBps: 3000 },
  ],
  cashBps: 2000,
  driftBps: 500,
  everyDays: 7,
  validFrom: 1795600000n,
  seq: 2n,
};
const dca: Setting = { account, agentId: 7n, strategy: "dca", takeProfitBps: 300, targets: [], cashBps: 0, driftBps: 0, everyDays: 0, validFrom: 1795600000n, seq: 1n };
const team: Setting = {
  account: getAddress("0xB5667f1c68bADFc54CE5eaCc60EACb89473Ec37C"),
  agentId: 26144n,
  strategy: "dca",
  takeProfitBps: 500,
  targets: [],
  cashBps: 0,
  driftBps: 0,
  everyDays: 0,
  validFrom: 1795686923n,
  seq: 1n,
};

assert.equal(settingHash(team), "0x32031c53629f42bfec19c82d5c2dbb131606ac8047d6ceb5ae6f195faa1c6073", "the team account's mainnet setting");
assert.equal(fingerprint(team), 0x32031c53629f42bfec19c82d5c2dbb13n);
for (const s of [rebalance, dca, team]) {
  assert.equal(settingHash(s), agentSide.settingHash(ADDRESSES.router, s as any));
  assert.equal(settingHash(s), recordSide.settingHash(s as any));
  assert.equal(fingerprint(s), agentSide.fingerprint(ADDRESSES.router, s as any));
  assert.equal(invalidReason(s), null);
}
assert.equal(settingHash(rebalance), "0x015cfba12b21ee9dc509e8e0e27b5b1df3679d679922d80898abc9d8fd6c50b1");
assert.equal(
  await signerOf({ setting: rebalance, signature: "0xee4f9b8a375470be28716012578a8d99d73ecf47d8dcf92b6443afa45010058c45061229777a59a8837427cddbdab56bacba8e81f03f9143105d124a37aae36b1c" }),
  getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
);
assert.equal(withFingerprint(fingerprint(dca), 12345n), agentSide.withFingerprint(agentSide.fingerprint(ADDRESSES.router, dca as any), 12345n));

const bad: [Setting, RegExp][] = [
  [{ ...rebalance, cashBps: 1000 }, /add up to 10000/],
  [{ ...rebalance, targets: [{ ...rebalance.targets[0]!, ticker: "cbBTC" }, rebalance.targets[1]!] }, /ticker does not match/],
  [{ ...dca, takeProfitBps: 99 }, /takeProfitBps/],
  [{ ...rebalance, driftBps: 0, everyDays: 0 }, /threshold, a schedule/],
  [{ ...rebalance, everyDays: 3 }, /everyDays/],
];
for (const [s, why] of bad) {
  assert.match(invalidReason(s)!, why);
  assert.equal(invalidReason(s), agentSide.invalidReason(s as any));
}
assert.match(invalidReason(rebalance, [WETH])!, /not allowed/);
assert.deepEqual(parseSetting(JSON.parse(JSON.stringify({ ...rebalance, agentId: "7", validFrom: "1795600000", seq: "2" }))), rebalance);
console.log("SETTINGS OK");
