// Drives e2e/run.sh with FILLMARK_E2E_SCRIPT=e2e/pay.ts: Fillmark Pay with the live router v3
// and the live FillmarkPay on a fork. WETH and cbBTC trade at any hour. Until the burner has
// its token the timelock is impersonated to set one of the two graduated Pons USDG launches
// with a 1% creator tax that the Pay fork tests use, once each, as $FILLMARK may sort either
// side of USDG.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestClient, encodeFunctionData, erc20Abi, getAddress, http, keccak256, parseEventLogs, parseUnits, toHex, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import { Agent, DAY, GAS_CAP, loadConfig } from "../src/agent.js";
import { burnerAbi, payAbi, routerAbi } from "../src/abi.generated.js";
import { ASSETS, IDENTITY, PAY, USDG, clients, identityAbi, loadKey } from "../src/chain.js";
import type { FillIntent } from "../src/intent.js";
import { WAITS, minReceivedPerUsdg, payAllowance, tokenPerUsdg } from "../src/pay.js";

const rpc = process.env.FILLMARK_RPC!;
const work = process.env.FILLMARK_E2E_DIR!;
const root = process.env.FILLMARK_ROOT!;
const tsx = join(root, "agent/node_modules/.bin/tsx");
const test = createTestClient({ chain: robinhood, mode: "anvil", transport: http(rpc) });
const { pub } = clients();
const WETH = ASSETS.WETH;
const CBBTC = ASSETS.cbBTC;
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";
const live = JSON.parse(readFileSync(join(root, "deployments/4663-pay.json"), "utf8"));
const v3 = JSON.parse(readFileSync(join(root, "deployments/4663-v3.json"), "utf8"));
const router = getAddress(live.router);
const burner = getAddress(live.burner);
const timelock = getAddress(v3.timelock);
assert.equal(getAddress(live.pay), PAY);
// Creator tax 100 bps, hook fee 100 bps, buyback off; the first sorts below USDG.
const TAX_BELOW_USDG: Address = "0x344CF1B52856218d1d9e02cBd17454D57F1e4c44";
const TAX_ABOVE_USDG: Address = "0xf3977F40D5135eB26DBc4cA055f94e24491e79af";

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
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
function runAgent(extra: Record<string, string> = {}) {
  const r = spawnSync(tsx, ["src/agent.ts", "--config", config, "--once"], { env: { ...process.env, ...extra }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return (r.stdout + r.stderr).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) as Line[];
}
const has = (l: Line[], msg: string, a?: Address) => l.some((x) => x.msg.startsWith(msg) && (a === undefined || x.account === a));
const fills = (l: Line[], a?: Address) => l.filter((x) => x.msg === "filled" && (a === undefined || x.account === a));
const balanceOf = (token: Address, a: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const due = (a: Address) => pub.readContract({ address: PAY, abi: payAbi, functionName: "dueOf", args: [a, agentId] });
const agreement = (a: Address) => pub.readContract({ address: PAY, abi: payAbi, functionName: "agreementOf", args: [a, agentId] });
const tracked = async (a: Address) =>
  (await pub.readContract({ address: PAY, abi: payAbi, functionName: "tokensOf", args: [a, agentId] })).map((b) => getAddress(b.token));
const deal = (a: Address, token: Address, amount: bigint) => test.request({ method: "anvil_dealERC20" as any, params: [a, token, toHex(amount)] as any });

/// Sends `fn` from `who` (an account or the timelock) on the fork.
async function as(who: Address, address: Address, abi: any, functionName: string, args: unknown[]) {
  await test.setBalance({ address: who, value: 10n ** 18n });
  await test.impersonateAccount({ address: who });
  const hash = await test.request({
    method: "eth_sendTransaction" as any,
    params: [{ from: who, to: address, data: encodeFunctionData({ abi, functionName, args }) }] as any,
  });
  await test.stopImpersonatingAccount({ address: who });
  const receipt = await pub.waitForTransactionReceipt({ hash: hash as `0x${string}` });
  assert.equal(receipt.status, "success", `${functionName} from ${who} reverted`);
  return receipt;
}

/// A 12 USDG WETH buy for `a` sent by the agent wallet with a nonce the agent never uses.
async function seedBuy(a: Address, tag: string) {
  const cfg = await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [a] });
  const it: FillIntent = {
    agentId, account: a, installId: cfg[5], tokenIn: USDG, tokenOut: WETH, amountIn: parseUnits("12", 6), minOut: 1n,
    sqrtPriceLimitX96: 0n, nonce: BigInt(keccak256(toHex(tag))), deadline: (await pub.getBlock()).timestamp + 300n,
  };
  const sim = await pub.simulateContract({ address: router, abi: routerAbi, functionName: "execute", args: [it], account: agent.account });
  assert.equal((await pub.waitForTransactionReceipt({ hash: await agentWallet.writeContract({ ...sim.request, gas: GAS_CAP }) })).status, "success");
}

/// What FillmarkPay must owe, from the router's stats and the bases taken when tracking began.
async function expectedAccrued(a: Address) {
  const ag = await agreement(a);
  const bases = await pub.readContract({ address: PAY, abi: payAbi, functionName: "tokensOf", args: [a, agentId] });
  let notional = 0n;
  let cost = 0n;
  for (const b of bases) {
    const s = await pub.readContract({ address: router, abi: routerAbi, functionName: "statsOf", args: [agentId, a, b.token] });
    notional += s.notional - b.notional;
    cost += s.sumCost - b.sumCost;
  }
  const rate = BigInt(ag.rateBps);
  const full = (notional * rate) / 10_000n;
  if (cost <= 0n) return full;
  const cut = (cost * rate + BigInt(ag.zeroAtBps) - 1n) / BigInt(ag.zeroAtBps);
  return full > cut ? full - cut : 0n;
}

const agent = keyFile("agent");
const client = keyFile("client");
for (const k of [agent, client]) await test.setBalance({ address: k.account.address, value: 10n ** 18n });
const agentWallet = clients(agent.account).wallet!;

step("register the agent");
const reg = await pub.simulateContract({ address: IDENTITY, abi: identityAbi, functionName: "register", args: [""], account: agent.account });
await pub.waitForTransactionReceipt({ hash: await agentWallet.writeContract(reg.request) });
const agentId = reg.result;
const deployBlock = await pub.getBlockNumber(); // the accounts below come after it
writeFileSync(join(work, "deployed"), ""); // run.sh starts its block heartbeat now

// One UTC day for the whole run.
const toMidnight = DAY - ((await pub.getBlock()).timestamp % DAY);
if (toMidnight < 3600n) {
  await test.increaseTime({ seconds: Number(toMidnight) + 1 });
  await test.mine({ blocks: 1 });
}

const env = { FILLMARK_RPC: rpc, FILLMARK_ROUTER: router, FILLMARK_KEY_FILE: client.path };
async function account(name: string, salt: string, usdg = "1000"): Promise<Address> {
  const r = cli("create", "--agent-id", String(agentId), "--max-per-trade", "12", "--daily-limit", "60", "--expiry-days", "30",
    "--max-slip-bps", "200", "--perf-fee-bps", "0", "--assets", "WETH,cbBTC", "--salt", salt);
  const a = getAddress(r.account);
  if (usdg !== "0") await deal(a, USDG, parseUnits(usdg, 6));
  console.log(`   ${name}: ${a}`);
  return a;
}
// No USDG yet, so nothing is bought before their agreements open.
const A = await account("A (opens with pay-open)", "31", "0");
const B = await account("B (opens tracking WETH only)", "32", "0");

const config = join(work, "agent.json");
const writeConfig = (extra: Record<string, unknown> = {}) =>
  writeFileSync(config, JSON.stringify({ router, agentId: String(agentId), keyFile: agent.path, deployBlock: String(deployBlock), allowExtended: true, payRateBps: 2, payRequired: true, paySamples: 1, payMinUsdg: "0", ...extra }));

step("config checks: payRequired must be a boolean, and paySamples ticks must fit in an hour");
writeConfig({ payRequired: "true" });
assert.throws(() => loadConfig(config), /payRequired must be true or false/);
writeConfig({ paySamples: 61, tickSec: 60 });
assert.throws(() => loadConfig(config), /must fit in one hour/);
writeConfig({ payMinUsdg: "0.0000001" });
assert.throws(() => loadConfig(config), /payMinUsdg/);
// A config without pay settings still loads with a long tick (paySamples follows the tick).
writeFileSync(config, JSON.stringify({ router, agentId: String(agentId), keyFile: agent.path, deployBlock: "1", tickSec: 300 }));
assert.equal(loadConfig(config).paySamples, 12);
assert.equal(loadConfig(config).payMinUsdg, 10_000n);

step("first run: the agent sets its terms (2 bps, zero at 100 bps)");
writeConfig();
let l = runAgent();
assert.ok(has(l, "Fillmark Pay terms set"), JSON.stringify(l));
assert.deepEqual(await pub.readContract({ address: PAY, abi: payAbi, functionName: "termsOf", args: [agentId] }), { rateBps: 2, minZeroAtBps: 100 });
assert.equal(fills(l).length, 0, JSON.stringify(l));

step("a second run sends no setRate");
l = runAgent();
assert.ok(!has(l, "Fillmark Pay terms set"), JSON.stringify(l));
assert.equal(fills(l).length, 0);

step("A opens with pay-open: approve and open in one batch, every allowed asset tracked");
const cfgA = await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [A] });
const openA = cli("pay-open", A, "--agent-id", String(agentId));
assert.equal(openA.rateBps, 2);
assert.equal(openA.zeroAtBps, 100);
assert.equal(openA.tokens, 2);
const allowanceA = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [A, PAY] });
assert.equal(allowanceA, parseUnits(openA.allowanceUsdg, 6));
// 2 bps x twice 60 USDG a day x (30 days + 7 days of sales) = 0.888 USDG
assert.equal(allowanceA, payAllowance(2, cfgA[9], cfgA[4], (await pub.getBlock()).timestamp, 0n));
assert.equal(allowanceA, 888_000n);
assert.deepEqual((await tracked(A)).sort(), [WETH, CBBTC].sort());
assert.equal((await agreement(A)).open, true);

step("B opens tracking WETH only (from the account itself)");
await as(B, USDG, erc20Abi, "approve", [PAY, parseUnits("1", 6)]);
await as(B, PAY, payAbi, "open", [agentId, 2, 100, [WETH]]);
assert.deepEqual(await tracked(B), [WETH]);

step("the agent buys for both; before B's cbBTC buy it adds cbBTC to B's agreement");
for (const a of [A, B]) await deal(a, USDG, parseUnits("1000", 6));
l = runAgent();
assert.deepEqual(fills(l, A).map((x) => [x.asset, x.side]).sort(), [["WETH", "buy"], ["cbBTC", "buy"]], JSON.stringify(l));
assert.deepEqual(fills(l, B).map((x) => [x.asset, x.side]).sort(), [["WETH", "buy"], ["cbBTC", "buy"]], JSON.stringify(l));
assert.ok(has(l, "token added to the Fillmark Pay agreement", B), JSON.stringify(l));
assert.deepEqual(await tracked(B), [WETH, CBBTC]);
for (const a of [A, B]) {
  const d = await due(a);
  assert.equal(d.accrued, await expectedAccrued(a));
  assert.ok(d.accrued > 0n, `nothing accrued for ${a}`);
  console.log(`   ${a === A ? "A" : "B"} owes ${d.due} USDG micro (${WAITS[d.wait]})`);
}

const tokenSet = (await pub.readContract({ address: burner, abi: burnerAbi, functionName: "token" })) !== zeroAddress;
if (!tokenSet) {
  step("no $FILLMARK pool yet: nothing is payable, and the agent sends no settle");
  for (const a of [A, B]) {
    const d = await due(a);
    assert.equal(WAITS[d.wait], "NoToken");
    assert.equal(d.payNow, 0n);
  }
  assert.ok(!has(l, "Fillmark Pay settle") && !has(l, "Fillmark Pay settled"), JSON.stringify(l));
}

/// The agent's settles of A and B after the burner has its token: exact USDG, 90/10 split,
/// at least the agent's own minimum, nothing left in Pay.
async function settleBoth(label: string) {
  const tok = getAddress(await pub.readContract({ address: burner, abi: burnerAbi, functionName: "token" }));
  const key = await pub.readContract({ address: burner, abi: burnerAbi, functionName: "poolKey" });
  const usdgIs0 = getAddress(key.currency0) === USDG;
  const ref = tokenPerUsdg(await pub.readContract({ address: burner, abi: burnerAbi, functionName: "sqrtPriceX96" }), usdgIs0);
  const before = { A: await balanceOf(USDG, A), B: await balanceOf(USDG, B), agent: await balanceOf(tok, agent.account.address), dead: await balanceOf(tok, DEAD) };
  const owed = { A: (await due(A)).due, B: (await due(B)).due };
  // Below payMinUsdg nothing is settled: the gas would cost more than the pay.
  writeConfig({ payMinUsdg: "0.01" });
  const small = runAgent();
  assert.ok(owed.A < 10_000n && !has(small, "Fillmark Pay settled"), JSON.stringify(small));
  writeConfig();
  const lines = runAgent();
  assert.equal(fills(lines).length, 0, JSON.stringify(lines)); // the same day: no buys left
  const settled = lines.filter((x) => x.msg === "Fillmark Pay settled");
  assert.deepEqual(settled.map((x) => x.account).sort(), [A, B].sort(), JSON.stringify(lines));
  let toAgent = 0n;
  let burned = 0n;
  for (const x of settled) {
    const a = x.account as Address;
    const paid = BigInt(x.usdgPaid as string);
    const got = BigInt(x.fillmarkToAgent as string);
    const burn = BigInt(x.fillmarkBurned as string);
    assert.equal(paid, owed[a === A ? "A" : "B"], "the whole due fits the block budget, balance and allowance");
    assert.equal(before[a === A ? "A" : "B"] - (await balanceOf(USDG, a)), paid);
    assert.equal(burn, ((got + burn) * 1_000n) / 10_000n);
    // Received per USDG at least the agent's minimum (paySamples 1: the median is this price).
    assert.ok(got * 1_000_000n >= paid * minReceivedPerUsdg(ref, 200, 300), `${label}: ${got} for ${paid}`);
    // And close to spot less 1% fee, 1% tax and the 10% burn (a tiny buy barely moves the pool).
    const ideal = (paid * ref * 98n * 90n) / (1_000_000n * 100n * 100n);
    assert.ok(got * 10_000n >= ideal * 9_950n && got <= ideal, `${label}: got ${got}, spot says ${ideal}`);
    assert.equal((await agreement(a)).paid, paid);
    assert.equal(WAITS[(await due(a)).wait], "NothingDue");
    toAgent += got;
    burned += burn;
    console.log(`   ${label}: ${a === A ? "A" : "B"} paid ${paid} USDG micro, agent got ${got}, burned ${burn}`);
  }
  assert.equal((await balanceOf(tok, agent.account.address)) - before.agent, toAgent);
  assert.equal((await balanceOf(tok, DEAD)) - before.dead, burned);
  assert.equal(await balanceOf(USDG, PAY), 0n);
  assert.equal(await balanceOf(tok, PAY), 0n);
}

if (!tokenSet) {
  const snap = await test.snapshot();
  step("the timelock sets a launch that sorts above USDG; the agent settles A and B");
  await as(timelock, burner, burnerAbi, "setToken", [TAX_ABOVE_USDG]);
  await settleBoth("above USDG");
  await test.revert({ id: snap });
  step("again from before the token, with a launch that sorts below USDG; B removes the agent first and is still settled");
  cli("uninstall", B);
  assert.equal((await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [B] }))[6], false);
  await as(timelock, burner, burnerAbi, "setToken", [TAX_BELOW_USDG]);
  assert.notEqual(getAddress((await pub.readContract({ address: burner, abi: burnerAbi, functionName: "poolKey" })).currency0), USDG);
  await settleBoth("below USDG");
} else {
  step("the burner already has its token: the agent settles A and B");
  await settleBoth("live token");
}

step("a run later the same day sends nothing: nothing is due");
l = runAgent();
assert.ok(!has(l, "Fillmark Pay settled"), JSON.stringify(l));
assert.equal(fills(l).length, 0);

step("Fillmark Pay pays out now: no buys for E (no agreement) or F (agreement, no allowance)");
const E = await account("E (no agreement)", "35");
const F = await account("F (open agreement, allowance set to 0)", "36");
cli("pay-open", F, "--agent-id", String(agentId));
await as(F, USDG, erc20Abi, "approve", [PAY, 0n]);
l = runAgent();
assert.equal(fills(l, E).length + fills(l, F).length, 0, JSON.stringify(l));
assert.ok(has(l, "no open Fillmark Pay agreement", E), JSON.stringify(l));
assert.ok(has(l, "Fillmark Pay allowance or USDG below", F), JSON.stringify(l));

step("a sudden pool move makes the settle wait; once most prices of the hour sit there it goes through");
const C = await account("C (seeded fills, settled by an agent running in this process)", "33");
cli("pay-open", C, "--agent-id", String(agentId));
await seedBuy(C, "e2e-pay-seed-C");
assert.ok((await due(C)).due > 0n);
writeConfig({ paySamples: 5, paySlipBps: 50, tickSec: 5 });
const inProcess = new Agent(loadConfig(config), loadKey(agent.path));
const captured: Line[] = [];
const keep = { log: console.log, error: console.error };
const grab = (...a: unknown[]) => {
  try {
    captured.push(JSON.parse(String(a[0])));
  } catch {
    keep.log(...a);
  }
};
console.log = grab;
console.error = grab;
let paidC = 0n;
try {
  await inProcess.init();
  const tick = async () => {
    await inProcess.tick();
    // Chain time moves on, so the tick after the burner's buy is not in its second.
    await test.increaseTime({ seconds: 2 });
    await test.mine({ blocks: 1 });
  };
  for (let i = 0; i < 3; i++) await tick(); // three samples at the quiet price; C's own buys go out
  // The burner's hourly buy (0.5% of the pool's USDG side) moves $FILLMARK about 1%.
  await deal(burner, USDG, parseUnits("100000", 6));
  await (async () => {
    const { request } = await pub.simulateContract({ address: burner, abi: burnerAbi, functionName: "burn", account: agent.account });
    await pub.waitForTransactionReceipt({ hash: await agentWallet.writeContract(request) });
  })();
  await test.mine({ blocks: 1 });
  await tick(); // 4 samples: fewer than 5
  await tick(); // [P, P, p, p, p] sorted: the median is the quiet price, P is away from it
  assert.ok(captured.some((x) => x.msg.startsWith("Fillmark Pay: the pool price is away")), JSON.stringify(captured));
  assert.equal((await agreement(C)).paid, 0n);
  await tick(); // [P, P, P, p, p, p]: the upper middle is still p
  assert.equal((await agreement(C)).paid, 0n);
  await tick(); // [P, P, P, P, p, p, p]: the median is P, the price has held
  paidC = (await agreement(C)).paid;
} finally {
  console.log = keep.log;
  console.error = keep.error;
}
assert.ok(paidC > 0n, JSON.stringify(captured));
assert.ok(captured.some((x) => x.msg === "Fillmark Pay settled" && x.account === C), JSON.stringify(captured));
console.log(`   C paid ${paidC} USDG micro after the price held`);

step("D ends the agreement with pay-close: what is due is kept, no more buys, and its sale still goes out unbilled");
// D's lot comes from a buy sent here with a nonce the agent never uses, so the agent may sell it today.
const D = await account("D (closes its agreement)", "34");
cli("pay-open", D, "--agent-id", String(agentId));
await seedBuy(D, "e2e-pay-seed-D");
const dueD = (await due(D)).due;
assert.ok(dueD > 0n);
cli("pay-close", D, "--agent-id", String(agentId));
const closedD = await agreement(D);
assert.equal(closedD.open, false);
assert.equal(closedD.carry, dueD);
assert.equal(await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [D, PAY] }), 0n);
const statusD = cli("pay-status", D, "--agent-id", String(agentId));
assert.equal(statusD.open, false);
assert.equal(statusD.wait, "NotOpen");
assert.equal(parseUnits(statusD.carryUsdg, 6), dueD);
writeConfig({ takeProfitBps: -500 });
l = runAgent({ FILLMARK_E2E_LOW_TAKE_PROFIT: "1" });
const soldD = fills(l, D);
assert.ok(soldD.length > 0 && soldD.every((x) => x.side === "sell" && x.asset === "WETH"), JSON.stringify(l));
assert.ok(has(l, "no open Fillmark Pay agreement", D), JSON.stringify(l)); // its cbBTC is not bought
const afterD = await due(D);
assert.equal(WAITS[afterD.wait], "NotOpen");
assert.equal(afterD.accrued, 0n);
assert.equal(afterD.carry, dueD, "the sale after closing adds nothing");
const statusC = cli("pay-status", C, "--agent-id", String(agentId));
assert.equal(statusC.open, true);
assert.deepEqual(statusC.tokens.sort(), ["WETH", "cbBTC"].sort());

step("pay-close --keep-allowance leaves the allowance another agreement may use");
const allowanceC = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [C, PAY] });
assert.ok(allowanceC > 0n);
cli("pay-close", C, "--agent-id", String(agentId), "--keep-allowance");
assert.equal((await agreement(C)).open, false);
assert.equal(await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [C, PAY] }), allowanceC);
step("pay-open adds to the allowance already given");
const reopened = cli("pay-open", C, "--agent-id", String(agentId));
assert.ok(parseUnits(reopened.allowanceUsdg, 6) > allowanceC);
assert.equal(await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [C, PAY] }), parseUnits(reopened.allowanceUsdg, 6));

console.log("E2E PAY OK");
