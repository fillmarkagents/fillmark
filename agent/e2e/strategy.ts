// Drives e2e/run.sh with FILLMARK_E2E_SCRIPT=e2e/strategy.ts: client strategy settings with the
// live router v3 on a fork. WETH and cbBTC trade at any hour, so the whole run stays in one UTC
// day. A setting is used from the day after the agent first sees it, so settings meant for today
// are written into the agent's store as seen yesterday, as a running agent would have them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestClient, erc20Abi, getAddress, http, parseUnits, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import { DAY, buyNonce, rebalanceNonce, saleNonce } from "../src/agent.js";
import { routerAbi } from "../src/abi.generated.js";
import { ASSETS, IDENTITY, USDG, clients, identityAbi } from "../src/chain.js";
import { planRebalance } from "../src/rebalance.js";
import { fingerprint, settingHash, settingJson, signSetting, withFingerprint, type Setting } from "../src/settings.js";

const rpc = process.env.FILLMARK_RPC!;
const work = process.env.FILLMARK_E2E_DIR!;
const root = process.env.FILLMARK_ROOT!;
const tsx = join(root, "agent/node_modules/.bin/tsx");
const test = createTestClient({ chain: robinhood, mode: "anvil", transport: http(rpc) });
const { pub } = clients();
const WETH = ASSETS.WETH!;
const CBBTC = ASSETS.cbBTC!;
const v3 = JSON.parse(readFileSync(join(root, "deployments/4663-v3.json"), "utf8"));
const router = getAddress(v3.router);

function keyFile(name: string) {
  const key = generatePrivateKey();
  const path = join(work, `${name}.key`);
  writeFileSync(path, key + "\n", { mode: 0o600 });
  return { key, path, account: privateKeyToAccount(key) };
}
const step = (msg: string) => console.log(`-- ${msg}`);
type Line = { msg: string; [k: string]: unknown };
function cli(...args: string[]) {
  const r = spawnSync(tsx, ["src/cli.ts", ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout);
}
const logged: Line[] = []; // every fill the agent logged, for the record check at the end
function runAgent() {
  const r = spawnSync(tsx, ["src/agent.ts", "--config", config, "--once"], { env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const lines = (r.stdout + r.stderr).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) as Line[];
  logged.push(...lines.filter((x) => x.msg === "filled"));
  return lines;
}
const has = (l: Line[], msg: string, a?: Address) => l.some((x) => x.msg.startsWith(msg) && (a === undefined || x.account === a));
const fills = (l: Line[], a?: Address) => l.filter((x) => x.msg === "filled" && (a === undefined || x.account === a));
const balanceOf = (token: Address, a: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const used = (a: Address, nonce: bigint) => pub.readContract({ address: router, abi: routerAbi, functionName: "nonceUsed", args: [a, nonce] });
const deal = (a: Address, token: Address, amount: bigint) => test.request({ method: "anvil_dealERC20" as any, params: [a, token, toHex(amount)] as any });
const lotOf = async (a: Address, t: Address) => (await pub.readContract({ address: router, abi: routerAbi, functionName: "positionOf", args: [a, agentId, t] }))[0];
const priceOf = async (t: Address) => (await pub.readContract({ address: router, abi: routerAbi, functionName: "priceOf", args: [t] }))[0];

step("planning: a sale is at most what the agent's own units are worth, and a sale under the minimum leaves the buys");
{
  const A = "0x0000000000000000000000000000000000000001" as Address;
  const B = "0x0000000000000000000000000000000000000002" as Address;
  const usd = (n: number) => BigInt(n) * 1_000_000n;
  // A is far over target, but the agent's own units of it are worth only 6 USDG: no sale, B is bought.
  let p = planRebalance([{ token: A, units: 5n, value: usd(200), sellable: usd(6), weightBps: 1000 }, { token: B, units: 0n, value: 0n, sellable: 0n, weightBps: 7000 }], usd(100), 2000, usd(10));
  assert.deepEqual(p.sells, []);
  assert.deepEqual(p.buys, [{ token: B, usdg: usd(40) }], "buys come from the cash above its target");
  // The agent's units are worth 50: the sale stops there, not at the whole gap.
  p = planRebalance([{ token: A, units: 5n, value: usd(200), sellable: usd(50), weightBps: 1000 }, { token: B, units: 0n, value: 0n, sellable: 0n, weightBps: 7000 }], usd(100), 2000, usd(10));
  assert.deepEqual(p.sells, [{ token: A, usdg: usd(50) }]);
  assert.deepEqual(p.buys, [{ token: B, usdg: usd(90) }]);
}

const agent = keyFile("agent");
const client = keyFile("client");
const stranger = keyFile("stranger");
for (const k of [agent, client]) await test.setBalance({ address: k.account.address, value: 10n ** 18n });
const agentWallet = clients(agent.account).wallet!;

step("register the agent");
const reg = await pub.simulateContract({ address: IDENTITY, abi: identityAbi, functionName: "register", args: [""], account: agent.account });
await pub.waitForTransactionReceipt({ hash: await agentWallet.writeContract(reg.request) });
const agentId = reg.result;
const deployBlock = await pub.getBlockNumber();
writeFileSync(join(work, "deployed"), "");

// One UTC day for the whole run.
const toMidnight = DAY - ((await pub.getBlock()).timestamp % DAY);
if (toMidnight < 3n * 3600n) {
  await test.increaseTime({ seconds: Number(toMidnight) + 1 });
  await test.mine({ blocks: 1 });
  // The agent and the CLI refuse a chain clock too far from the local one: allow the jump.
  process.env.FILLMARK_MAX_CLOCK_SKEW = String(Number(process.env.FILLMARK_MAX_CLOCK_SKEW ?? "300") + Number(toMidnight) + 60);
}
const now = (await pub.getBlock()).timestamp;
const day = now / DAY;

const env = { FILLMARK_RPC: rpc, FILLMARK_ROUTER: router, FILLMARK_KEY_FILE: client.path };
async function account(name: string, salt: string, usdg: string): Promise<Address> {
  const r = cli("create", "--agent-id", String(agentId), "--max-per-trade", "30", "--daily-limit", "150", "--expiry-days", "30",
    "--max-slip-bps", "200", "--perf-fee-bps", "0", "--assets", "WETH,cbBTC", "--salt", salt);
  const a = getAddress(r.account);
  await deal(a, USDG, parseUnits(usdg, 6));
  console.log(`   ${name}: ${a}`);
  return a;
}
const L = await account("L (no setting: dca as 0.5.0)", "41", "200");
const R = await account("R (rebalance WETH 50%, cbBTC 30%, cash 20%)", "42", "300");
const B = await account("B (setting signed by a stranger)", "43", "200");
const N = await account("N (setting signed today: dca until tomorrow)", "44", "200");
const C = await account("C (two settings with one seq)", "45", "200");
const F = await account("F (first setting dated yesterday, first seen today)", "46", "200");
const D = await account("D (dca setting: take-profit 3%)", "47", "200");
const S = await account("S (rebalance on a weekly schedule only)", "48", "300");

const settingsFile = join(work, "settings.json");
const store = join(work, "store.json");
const config = join(work, "agent.json");
writeFileSync(config, JSON.stringify({ router, agentId: String(agentId), keyFile: agent.path, deployBlock: String(deployBlock), allowExtended: true, settingsFile, settingsStore: store }));

const yesterday = now - DAY;
const base = (account: Address, seq: bigint): Omit<Setting, "strategy"> => ({
  account, agentId, takeProfitBps: 0, targets: [], cashBps: 0, driftBps: 0, everyDays: 0, validFrom: yesterday - 60n, seq,
});
const rebalance = (account: Address, seq: bigint, weth: number, cbbtc: number, cash: number): Setting => ({
  ...base(account, seq), strategy: "rebalance", driftBps: 500,
  targets: [{ asset: WETH, ticker: "WETH", weightBps: weth }, { asset: CBBTC, ticker: "cbBTC", weightBps: cbbtc }], cashBps: cash,
});
const dca = (account: Address, seq: bigint, tp: number): Setting => ({ ...base(account, seq), strategy: "dca", takeProfitBps: tp });

type Entry = { setting: ReturnType<typeof settingJson>; signature: Hex; digest: Hex; signer: Address; seenDay: string };
const entry = async (s: Setting, signer: typeof client, seenDay: bigint): Promise<Entry> => {
  const x = await signSetting(router, s, signer.account);
  return { setting: settingJson(s), signature: x.signature, digest: settingHash(router, s), signer: signer.account.address, seenDay: seenDay.toString() };
};
const writeSettings = (list: Entry[]) => writeFileSync(settingsFile, JSON.stringify({ settings: list.map(({ setting, signature }) => ({ setting, signature })) }));
// The store as a running agent would have it: started before today.
const seed = (list: Entry[]) => writeFileSync(store, JSON.stringify({ agentId: agentId.toString(), router, since: (day - 1n).toString(), settings: list }));

step("no settings source and nothing on disk: no trades at all");
let l = runAgent();
assert.ok(has(l, "could not read client settings and none are on disk"), JSON.stringify(l));
assert.equal(fills(l).length, 0, JSON.stringify(l));
assert.ok(!existsSync(store));

step("settings: R rebalances, B and C are refused, N was signed today, F's is new; R, B and C were seen yesterday");
const rSet = rebalance(R, 1n, 5000, 3000, 2000);
const nSet = { ...dca(N, 1n, 300), validFrom: now - 30n };
const dSet = dca(D, 1n, 300);
const sSet: Setting = { ...rebalance(S, 1n, 4000, 4000, 2000), driftBps: 0, everyDays: 7 };
const seen = [
  await entry(rSet, client, day - 1n),
  await entry(dca(B, 1n, 300), stranger, day - 1n),
  await entry(dca(C, 1n, 300), client, day - 1n),
  await entry(dca(C, 1n, 400), client, day - 1n),
  await entry(dSet, client, day - 1n),
  await entry(sSet, client, day - 1n),
];
const fresh = await entry(nSet, client, day);
const fSet = dca(F, 1n, 300); // dated yesterday, like R's, but the agent never saw it before today
const fNew = await entry(fSet, client, day);
seed(seen);
writeSettings([...seen, fresh, fNew]);
l = runAgent();
const fpR = fingerprint(router, rSet);

step("L, N and F: dca with the 0.5.0 nonces (F's setting starts tomorrow)");
for (const a of [L, N, F]) {
  assert.deepEqual(fills(l, a).map((x) => [x.asset, x.side, x.strategy, x.setting]).sort(), [["WETH", "buy", "dca", null], ["cbBTC", "buy", "dca", null]], JSON.stringify(l));
  for (const t of [WETH, CBBTC]) assert.equal(await used(a, buyNonce(a, t, day)), true);
}
step("D: dca under its setting, nonces carry the setting's fingerprint");
assert.deepEqual(fills(l, D).map((x) => [x.asset, x.side, x.strategy, x.setting]).sort(), [["WETH", "buy", "dca", settingHash(router, dSet)], ["cbBTC", "buy", "dca", settingHash(router, dSet)]], JSON.stringify(l));
for (const t of [WETH, CBBTC]) {
  assert.equal(await used(D, withFingerprint(fingerprint(router, dSet), buyNonce(D, t, day))), true);
  assert.equal(await used(D, buyNonce(D, t, day)), false, "no 0.5.0 nonce for an account with a setting");
}

step("S: a schedule with no threshold rebalances on the day the setting takes effect");
assert.ok(fills(l, S).length >= 2 && fills(l, S).every((x) => x.side === "buy" && x.strategy === "rebalance" && x.setting === settingHash(router, sSet)), JSON.stringify(l));

step("B (signer is not the owner) and C (two settings share a seq) are blocked");
assert.ok(l.some((x) => x.msg === "account blocked: no trades" && x.account === B && String(x.reason).includes("not signed by the account's owner")), JSON.stringify(l));
assert.ok(l.some((x) => x.msg === "account blocked: no trades" && x.account === C && String(x.reason).includes("share the latest seq")), JSON.stringify(l));
assert.equal(fills(l, B).length + fills(l, C).length, 0);

step("R: rebalance buys toward 50/30/20, nonces carry its fingerprint, stopped by the daily limit");
const rFills = fills(l, R);
assert.ok(rFills.length >= 4, JSON.stringify(l));
assert.ok(rFills.every((x) => x.side === "buy" && x.strategy === "rebalance" && x.setting === settingHash(router, rSet)), JSON.stringify(rFills));
assert.equal(await used(R, withFingerprint(fpR, rebalanceNonce(R, WETH, day, false, 0n))), true);
assert.equal(await used(R, buyNonce(R, WETH, day)), false, "no dca nonce for a rebalance account");
const spent = await pub.readContract({ address: router, abi: routerAbi, functionName: "windowSpent", args: [R] });
assert.ok(spent <= parseUnits("150", 6), `spent ${spent}`);
const value = async (a: Address) => {
  const w = ((await balanceOf(WETH, a)) * (await priceOf(WETH))) / 10n ** 20n;
  const b = ((await balanceOf(CBBTC, a)) * (await priceOf(CBBTC))) / 10n ** 10n;
  return { w, b, cash: await balanceOf(USDG, a) };
};
let v = await value(R);
console.log(`   R after day 1: WETH ${v.w}, cbBTC ${v.b}, USDG ${v.cash} (micro USDG)`);
assert.ok(v.w > v.b, "WETH, the larger target, is bought first");

step("the store keeps every setting seen; N's is dated today");
const kept = JSON.parse(readFileSync(store, "utf8")).settings as Entry[];
assert.equal(kept.length, 8);
for (const a of [N, F]) assert.equal(kept.find((x) => x.setting.account === a)!.seenDay, day.toString());
assert.equal(JSON.parse(readFileSync(store, "utf8")).since, (day - 1n).toString(), "the store keeps the day it was started");

step("a second run the same day: nothing more (dca done for the day, R at its daily limit)");
l = runAgent();
assert.equal(fills(l).length, 0, JSON.stringify(l));
assert.ok(has(l, "rebalance: daily limit reached", R) || has(l, "rebalance:", R), JSON.stringify(l));

step("the source drops every setting: R keeps rebalance, no account goes back to dca");
writeSettings([]);
l = runAgent();
assert.equal(fills(l).length, 0, JSON.stringify(l));
assert.ok(l.some((x) => x.msg === "strategy" && x.account === R && x.strategy === "rebalance" && x.setting === settingHash(router, rSet)), JSON.stringify(l));
assert.ok(!has(l, "account blocked", R), JSON.stringify(l));

step("R's new targets (WETH 10%, cbBTC 70%, cash 20%), seen yesterday: WETH sold today, sales within the daily limit");
const rSet2 = rebalance(R, 2n, 1000, 7000, 2000);
seed([...JSON.parse(readFileSync(store, "utf8")).settings, await entry(rSet2, client, day - 1n)]);
const lotBefore = (await lotOf(R, WETH)).qty;
l = runAgent();
const sold = fills(l, R).filter((x) => x.side === "sell");
assert.ok(sold.length > 0 && sold.every((x) => x.asset === "WETH" && x.setting === settingHash(router, rSet2)), JSON.stringify(l));
const soldUsdg = sold.reduce((s, x) => s + BigInt(x.usdg as string), 0n);
assert.ok(soldUsdg <= parseUnits("150", 6), `sold ${soldUsdg}`);
assert.ok((await lotOf(R, WETH)).qty < lotBefore);
assert.equal(await used(R, withFingerprint(fingerprint(router, rSet2), rebalanceNonce(R, WETH, day, true, 0n))), true);
assert.equal(await used(R, saleNonce(R, WETH, day, 0n)), false);
v = await value(R);
console.log(`   R after the new targets: WETH ${v.w}, cbBTC ${v.b}, USDG ${v.cash} (micro USDG)`);

step("R's targets drop WETH (cbBTC 80%, cash 20%): every WETH unit the agent bought is sold, the last under 10 USDG as the whole lot");
const rSet3 = rebalance(R, 3n, 0, 8000, 2000);
rSet3.targets = rSet3.targets.filter((t) => t.weightBps > 0);
seed([...JSON.parse(readFileSync(store, "utf8")).settings, await entry(rSet3, client, day - 1n)]);
l = runAgent();
const sold3 = fills(l, R).filter((x) => x.side === "sell");
assert.ok(sold3.length > 0 && sold3.every((x) => x.asset === "WETH" && x.setting === settingHash(router, rSet3)), JSON.stringify(l));
assert.equal((await lotOf(R, WETH)).qty, 0n, "nothing left of the agent's WETH lot");
const soldAll = [...sold, ...sold3].reduce((s2, x) => s2 + BigInt(x.usdg as string), 0n);
assert.ok(soldAll <= parseUnits("150", 6), `sold ${soldAll} today, over the daily limit`);
console.log(`   R sold ${sold3.map((x) => x.usdg).join(" + ")} micro USDG of WETH; ${soldAll} today in all`);

step("the CLI signs a setting for the owner, refuses a bad one, and checks the owner");
const signed = cli("strategy", R, "--agent-id", String(agentId), "--seq", "4", "--strategy", "rebalance", "--targets", "WETH:4000,cbBTC:4000", "--cash-bps", "2000", "--drift-bps", "300");
assert.equal(signed.setting.seq, "4");
assert.equal(signed.digest, settingHash(router, { ...rebalance(R, 4n, 4000, 4000, 2000), driftBps: 300, validFrom: BigInt(signed.setting.validFrom) }));
const bad = spawnSync(tsx, ["src/cli.ts", "strategy", R, "--agent-id", String(agentId), "--seq", "4", "--strategy", "rebalance", "--targets", "WETH:5000,cbBTC:4000", "--drift-bps", "300"], { env: { ...process.env, ...env }, encoding: "utf8" });
assert.notEqual(bad.status, 0);
assert.match(bad.stderr, /add up to 10000/);
const other = spawnSync(tsx, ["src/cli.ts", "strategy", R, "--agent-id", String(agentId), "--seq", "4", "--strategy", "dca", "--take-profit-bps", "300"], { env: { ...process.env, ...env, FILLMARK_KEY_FILE: stranger.path }, encoding: "utf8" });
assert.equal(other.status, 2, other.stderr);
assert.equal(JSON.parse(other.stdout).owner, client.account.address);

step("a new store (lost, or a new machine) and settings dated before today: those accounts wait, no trades");
const config2 = join(work, "agent2.json");
const store2 = join(work, "store2.json");
writeSettings([...seen, fNew, await entry(rSet2, client, day), await entry(rSet3, client, day)]);
writeFileSync(config2, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), settingsStore: store2 }));
{
  const r = spawnSync(tsx, ["src/agent.ts", "--config", config2, "--once"], { env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const l2 = (r.stdout + r.stderr).trim().split("\n").filter(Boolean).map((x) => JSON.parse(x)) as Line[];
  for (const a of [R, F]) assert.ok(l2.some((x) => x.msg === "account blocked: no trades" && x.account === a && x.reason === "a setting waits to take effect"), JSON.stringify(l2));
  assert.equal(fills(l2).length, 0, JSON.stringify(l2));
  assert.equal(JSON.parse(readFileSync(store2, "utf8")).since, day.toString());
}

step("the record library proves each fill's strategy from its fillId alone");
const events = await pub.getContractEvents({ address: router, abi: routerAbi, eventName: "Filled", args: { agentId }, fromBlock: deployBlock });
assert.equal(events.length, logged.length, "every fill on chain was logged by the agent, and no other");
const proof = [];
for (const e of events) {
  const x = logged.find((y) => y.tx === e.transactionHash)!;
  assert.ok(x, `no agent log for ${e.transactionHash}`);
  const time = Number((await pub.getBlock({ blockNumber: e.blockNumber })).timestamp);
  const f = e.args.fill!;
  proof.push({ router, fillId: e.args.fillId, account: f.account, agentId: String(f.agentId), stock: f.stock, buy: f.buy, usdg: String(f.usdgAmount), time, strategy: x.strategy, setting: x.setting });
}
const all = [...JSON.parse(readFileSync(store, "utf8")).settings as Entry[]].map((x) => x.setting);
const proofFile = join(work, "fork-fills.json");
writeFileSync(proofFile, JSON.stringify({ settings: all, fills: proof }));
const recordTsx = join(root, "record/node_modules/.bin/tsx");
assert.ok(existsSync(recordTsx), "install the record library's packages first: cd record && npm ci");
const tagged = spawnSync(recordTsx, ["test/fork-tags.ts", proofFile], { cwd: join(root, "record"), encoding: "utf8" });
assert.equal(tagged.status, 0, tagged.stderr + tagged.stdout);
console.log(`   ${tagged.stdout.trim()}`);

console.log("E2E STRATEGY OK");
