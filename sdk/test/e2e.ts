// Driven by test/run.sh on an anvil fork: a registered test agent trades for Kernel accounts
// made by the reference CLI, through the live router v3, with every SDK path checked against
// the router's events, stats and ERC-8004 feedback.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  maxUint256,
  parseAbi,
  parseUnits,
  type Address,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import { ADDRESSES, ASSETS, FillmarkError, accountStatus, assetOf, fillmarkAgent, payAbi, routerAbi, type Quote } from "../src/index.js";

const rpc = process.env.FILLMARK_RPC!;
const work = process.env.FILLMARK_E2E_DIR!;
const root = process.env.FILLMARK_ROOT!;
const transport = http(rpc, { timeout: 60_000 });
const pub = createPublicClient({ chain: robinhood, transport });
const test = createTestClient({ chain: robinhood, mode: "anvil", transport });
// Assets the accounts allow; the test trades the ones whose pool price is inside the router's
// bounds at the fork block (a pool far above or below Chainlink refuses buys or sales).
const LIST = ["WETH", "cbBTC", "TSLA", "NVDA", "QQQ", "MU", "AMD", "USO", "CRCL", "PLTR"];
const usd = (s: string) => parseUnits(s, 6);
const step = (msg: string) => console.log(`-- ${msg}`);

// A block every second: viem can see a transaction's block before anvil reports it mined.
let beating = true;
const beat = setInterval(() => void (beating && test.mine({ blocks: 1 }).catch(() => undefined)), 1000);

function key(name: string) {
  const k = generatePrivateKey();
  const path = join(work, `${name}.key`);
  writeFileSync(path, k + "\n", { mode: 0o600 });
  return { key: k, path, account: privateKeyToAccount(k) };
}
const agentKey = key("agent");
const clientKey = key("client");
for (const k of [agentKey, clientKey]) await test.setBalance({ address: k.account.address, value: 10n ** 18n });

step("register the test agent (ERC-8004)");
const identityAbi = parseAbi(["function register(string agentURI) returns (uint256)", "function getAgentWallet(uint256) view returns (address)"]);
const agentWallet = createWalletClient({ chain: robinhood, transport, account: agentKey.account });
const reg = await pub.simulateContract({ address: ADDRESSES.identity, abi: identityAbi, functionName: "register", args: [""], account: agentKey.account });
await pub.waitForTransactionReceipt({ hash: await agentWallet.writeContract(reg.request) });
const agentId = reg.result;
console.log(`   agentId ${agentId}`);

const startBlock = await pub.getBlockNumber();
const cliEnv = {
  ...process.env,
  FILLMARK_RPC: rpc,
  FILLMARK_ROUTER: ADDRESSES.router,
  FILLMARK_KEY_FILE: clientKey.path,
  FILLMARK_MAX_CLOCK_SKEW: "100000",
};
function create(flags: string[], salt: number): Address {
  const r = spawnSync(join(root, "agent/node_modules/.bin/tsx"), ["src/cli.ts", "create", "--agent-id", String(agentId), "--salt", String(salt), ...flags], {
    cwd: join(root, "agent"),
    env: cliEnv,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const account = getAddress(JSON.parse(r.stdout).account);
  return account;
}
async function fund(account: Address, amount: string) {
  await test.request({ method: "anvil_dealERC20" as any, params: [account, ADDRESSES.usdg, "0x" + usd(amount).toString(16)] as any });
}

const now0 = (await pub.getBlock()).timestamp;
step("client accounts made by the reference CLI");
const A1 = create(["--max-per-trade", "50", "--daily-limit", "200", "--expiry-days", "30", "--max-slip-bps", "200", "--perf-fee-bps", "0", "--assets", LIST.join(",")], 1);
const A2 = create(["--max-per-trade", "20", "--daily-limit", "25", "--expiry", String(now0 + 3600n), "--max-slip-bps", "200", "--perf-fee-bps", "0", "--assets", LIST.join(",")], 2);
const A3 = create(["--max-per-trade", "50", "--daily-limit", "200", "--expiry-days", "30", "--max-slip-bps", "200", "--perf-fee-bps", "0", "--assets", LIST.join(",")], 3);
const A4 = create(["--max-per-trade", "50", "--daily-limit", "200", "--expiry-days", "30", "--max-slip-bps", "200", "--perf-fee-bps", "0", "--assets", LIST.join(",")], 4);
await fund(A1, "500");
await fund(A2, "100");
await fund(A3, "200");
await fund(A4, "5");
const A5 = create(["--max-per-trade", "50", "--daily-limit", "200", "--expiry-days", "30", "--max-slip-bps", "200", "--perf-fee-bps", "0", "--assets", LIST.join(",")], 5);
const A6 = create(["--max-per-trade", "50", "--daily-limit", "200", "--expiry-days", "30", "--max-slip-bps", "200", "--perf-fee-bps", "0", "--assets", LIST.join(",")], 6);
await fund(A5, "100");
await fund(A6, "100");

// Client settings come from the live api.fillmark.trade, which has none for fork accounts; with
// FILLMARK_E2E_NO_API=1 (a machine that cannot reach it) an empty source stands in.
const settings = process.env.FILLMARK_E2E_NO_API === "1" ? { fetch: async () => ({ settings: [] }) } : undefined;
const agent = fillmarkAgent({ publicClient: pub, walletClient: agentWallet, agentId, fromBlock: startBlock, maxClockSkewSec: 100_000, settings });

step("check");
const chk = await agent.check();
assert.equal(chk.agentWallet, agentKey.account.address);
assert.equal(chk.canSend, true);

step("clients");
const cl = await agent.clients();
assert.deepEqual(cl.map((c) => c.account).sort(), [A1, A2, A3, A4, A5, A6].sort());
const c1 = cl.find((c) => c.account === A1)!;
assert.equal(c1.maxPerTrade, usd("50"));
assert.equal(c1.dailyLimit, usd("200"));
assert.equal(c1.maxSlipBps, 200);
assert.deepEqual([...c1.assets].sort(), LIST.map((t) => assetOf(t)!.token).sort());
assert.equal(c1.usdg, usd("500"));
assert.equal(c1.canBuy, true);
assert.equal(c1.plainKernel, true);

step("market");
const mk = await agent.market([...LIST, "BABA"]);
assert.equal(mk.find((m) => m.ticker === "BABA")!.reason, "NoPool");
// Room for a buy and a sale: the pool's premium plus its fee stays 30 bps inside its cap.
const fits = (m: (typeof mk)[number]) =>
  m.tradable && Math.abs(Number(m.premiumPpm)) + m.poolFee! <= (m.capBps! - 30) * 100;
const usable = mk.filter((m) => m.ticker !== "BABA" && fits(m));
for (const m of mk) console.log(`   ${m.ticker}: ${m.tradable ? `premium ${m.premiumPpm} ppm, cap ${m.capBps} bps, fee ${m.poolFee}` : m.reason}`);
if (usable.length < 2) throw new Error(`STOP: only ${usable.length} assets are inside their pool bounds at this block; run again later`);
const [X, Y] = usable.map((m) => m.ticker!);
const [XT, YT] = [assetOf(X)!.token, assetOf(Y)!.token];
console.log(`   trading ${X} and ${Y}`);

const reputationAbi = parseAbi(["function getLastIndex(uint256 agentId, address client) view returns (uint64)"]);
const ok = (q: Quote) => {
  assert.equal(q.ok, true, q.ok ? "" : `${q.reason}: ${q.message}`);
  return q as Extract<Quote, { ok: true }>;
};
const refused = (q: Quote, reason: string) => {
  assert.equal(q.ok, false, `expected ${reason}`);
  assert.equal((q as any).reason, reason);
};

step("first buy for A1, checked against the router's event, stats and ERC-8004 feedback");
const q1 = ok(await agent.quoteBuy({ account: A1, asset: X, usdgIn: usd("20") }));
assert.equal(q1.side, "buy");
assert.ok(q1.boundBps > 0 && q1.boundBps <= 100);
const f1 = await agent.fill(q1);
assert.equal(f1.side, "buy");
assert.equal(f1.usdg, usd("20"));
assert.ok(f1.units >= q1.minOut);
assert.equal(f1.fillFee, (usd("20") * 3n) / 10_000n);
assert.equal(await pub.readContract({ address: ADDRESSES.reputation, abi: reputationAbi, functionName: "getLastIndex", args: [agentId, A1] }), 2n);
const s1 = await pub.readContract({ address: ADDRESSES.router, abi: routerAbi, functionName: "statsOf", args: [agentId, A1, XT] });
assert.equal(s1.fills, 1);
assert.equal(s1.notional, usd("20"));
assert.equal(s1.sumCost, f1.costUsdg);

step("a second buy of the pair fits the pair cap (2); a third is refused");
await agent.fill(ok(await agent.quoteBuy({ account: A1, asset: X, usdgIn: usd("10") })));
refused(await agent.quoteBuy({ account: A1, asset: X, usdgIn: usd("10") }), "PairCap");

step("two fills sent at once go out one after the other");
const [qa, qb] = [
  ok(await agent.quoteBuy({ account: A1, asset: Y, usdgIn: usd("15") })),
  ok(await agent.quoteBuy({ account: A3, asset: X, usdgIn: usd("15") })),
];
const [fa, fb] = await Promise.all([agent.fill(qa), agent.fill(qb)]);
assert.notEqual(fa.hash, fb.hash);
assert.equal(fa.token, YT);

step("refusals before any send");
refused(await agent.quoteBuy({ account: A1, asset: Y, usdgIn: usd("60") }), "OverTradeLimit");
refused(await agent.quoteBuy({ account: A1, asset: "AAPL", usdgIn: usd("15") }), "StockNotAllowed");
refused(await agent.quoteBuy({ account: A1, asset: Y, usdgIn: usd("5") }), "TooSmall");
refused(await agent.quoteBuy({ account: A4, asset: X, usdgIn: usd("10") }), "NoUsdg");
refused(await agent.quoteSell({ account: A4, asset: X }), "NotAgentUnits");
await agent.fill(ok(await agent.quoteBuy({ account: A2, asset: X, usdgIn: usd("20") })));
refused(await agent.quoteBuy({ account: A2, asset: X, usdgIn: usd("10") }), "OverDailyLimit");
assert.equal(await agent.maxBuy(A2, X), 0n);
assert.ok((await agent.maxBuy(A1, "cbBTC")) === usd("50"));

step("a sale under the lot's cost is refused by the policy; with the policy off it fills");
refused(await agent.quoteSell({ account: A1, asset: Y }), "BelowCost");
const free = fillmarkAgent({ publicClient: pub, walletClient: agentWallet, agentId, fromBlock: startBlock, maxClockSkewSec: 100_000, settings, policy: { saleAboveCost: false } });
const qs = ok(await free.quoteSell({ account: A1, asset: Y }));
const lotBefore = (await pub.readContract({ address: ADDRESSES.router, abi: routerAbi, functionName: "positionOf", args: [A1, agentId, YT] }))[0];
assert.equal(qs.intent.amountIn, lotBefore.qty, "a small lot is sold whole");
const fs = await free.fill(qs);
assert.equal(fs.side, "sell");
assert.equal(fs.units, lotBefore.qty);
assert.equal((await pub.readContract({ address: ADDRESSES.router, abi: routerAbi, functionName: "positionOf", args: [A1, agentId, YT] }))[0].qty, 0n);
refused(await free.quoteSell({ account: A1, asset: Y }), "NotAgentUnits");

step("after expiry: no buys, sales still quoted in the 7-day grace");
await test.increaseTime({ seconds: 4000 });
await test.mine({ blocks: 1 });
refused(await agent.quoteBuy({ account: A2, asset: X, usdgIn: usd("10") }), "PermissionExpired");
ok(await free.quoteSell({ account: A2, asset: X }));

step("a fill that reverts on chain is counted and its account skipped for the day");
const qr = ok(await agent.quoteBuy({ account: A3, asset: X, usdgIn: usd("15") }));
beating = false;
await test.setAutomine(false);
const pending = agent.fill(qr).then(
  () => assert.fail("the fill should revert"),
  (e) => e,
);
for (let i = 0; i < 100; i++) {
  const pool = (await test.request({ method: "txpool_content" as any })) as any;
  if (Object.keys(pool.pending ?? {}).length > 0) break;
  await new Promise((r) => setTimeout(r, 100));
}
await test.setNextBlockTimestamp({ timestamp: qr.intent.deadline + 1n });
await test.mine({ blocks: 1 });
const err = await pending;
assert.ok(err instanceof FillmarkError && err.code === "RevertedOnChain", String(err));
await test.setAutomine(true);
beating = true;
refused(await agent.quoteBuy({ account: A3, asset: Y, usdgIn: usd("15") }), "RevertedToday");

step("the daily send cap counts every send");
const capped = fillmarkAgent({ publicClient: pub, walletClient: agentWallet, agentId, fromBlock: startBlock, maxClockSkewSec: 100_000, settings, policy: { maxFillsPerDay: 1 } });
await capped.fill(ok(await capped.quoteBuy({ account: A3, asset: Y, usdgIn: usd("15") })));
const q4 = ok(await capped.quoteBuy({ account: A3, asset: Y, usdgIn: usd("15") }));
await assert.rejects(capped.fill(q4), (e: any) => e instanceof FillmarkError && e.code === "DailyCap");

step("a revert seen only after the receipt wait timed out still skips the account");
const slow = fillmarkAgent({ publicClient: pub, walletClient: agentWallet, agentId, fromBlock: startBlock, maxClockSkewSec: 100_000, settings, receiptTimeoutMs: 2000 });
const qt = ok(await slow.quoteBuy({ account: A5, asset: X, usdgIn: usd("12") }));
beating = false;
await test.setAutomine(false);
await assert.rejects(slow.fill(qt), (e: any) => e instanceof FillmarkError && e.code === "Pending");
refused(await slow.quoteBuy({ account: A5, asset: X, usdgIn: usd("12") }), "Pending");
await test.setNextBlockTimestamp({ timestamp: qt.intent.deadline + 1n });
await test.mine({ blocks: 1 });
await test.setAutomine(true);
beating = true;
// The late revert is found through the account's other asset too.
refused(await slow.quoteBuy({ account: A5, asset: Y, usdgIn: usd("12") }), "RevertedToday");
refused(await slow.quoteBuy({ account: A5, asset: X, usdgIn: usd("12") }), "RevertedToday");

step("a lot worth under 10 USDG is sold whole");
await agent.fill(ok(await agent.quoteBuy({ account: A6, asset: X, usdgIn: usd("10") })));
const small = ok(await free.quoteSell({ account: A6, asset: X }));
const lot6 = (await pub.readContract({ address: ADDRESSES.router, abi: routerAbi, functionName: "positionOf", args: [A6, agentId, XT] }))[0];
assert.equal(small.intent.amountIn, lot6.qty);
assert.ok(small.expectedOut < usd("10"), "the sale is under the router minimum");
const fsmall = await free.fill(small);
assert.equal(fsmall.units, lot6.qty);

step("forged quotes, bad policies and RPC failures");
await assert.rejects(agent.fill({ ...q1, intent: { ...q1.intent, minOut: 0n } } as Quote), (e: any) => e instanceof FillmarkError && e.code === "UnknownQuote");
assert.throws(() => fillmarkAgent({ publicClient: pub, agentId, policy: { maxFillsPerDay: Number.NaN } }), /maxFillsPerDay/);
assert.throws(() => fillmarkAgent({ publicClient: pub, agentId, policy: { deadlineSec: 5 } }), /deadlineSec/);
assert.throws(() => fillmarkAgent({ publicClient: pub, agentId, policy: { maxFillPerDay: 1 } as any }), /unknown policy field/);
await assert.rejects(agent.market(["NOPE"]), (e: any) => e instanceof FillmarkError && e.code === "UnknownStock");
assert.ok(Object.isFrozen(ADDRESSES) && Object.isFrozen(ASSETS) && Object.isFrozen(ASSETS[0]));
const dead = fillmarkAgent({ publicClient: createPublicClient({ chain: robinhood, transport: http("http://127.0.0.1:9/?key=leak-me", { retryCount: 0, timeout: 2000 }) }), agentId });
await assert.rejects(dead.check(), (e: any) => e instanceof FillmarkError && e.code === "RpcError" && !`${e.message}${e.stack}`.includes("leak-me") && e.cause === undefined);

step("router fees");
await agent.settleFees(A1);
await agent.release(A1);
await assert.rejects(agent.claim(), (e: any) => e instanceof FillmarkError && e.code === "BadAmount");
await assert.rejects(agent.closeOut(A1), (e: any) => e instanceof FillmarkError && e.code === "NotClosing");
const bk = await agent.book(A1);
assert.equal(bk.wallet, agentKey.account.address);
// The sold-out lot left the router's list when settle priced the book.
assert.deepEqual(bk.positions.map((p) => p.token), [XT]);
assert.ok(bk.positions.every((p) => p.lot.qty > 0n));

step("Fillmark Pay: rate, an agreement opened by the account, billing after a fill, track");
await agent.pay.setRate(2, 100);
assert.deepEqual({ ...(await agent.pay.terms()) }, { rateBps: 2, minZeroAtBps: 100 });
await test.setBalance({ address: A3, value: 10n ** 17n }); // gas for the impersonated account
await test.impersonateAccount({ address: A3 });
const acct = createWalletClient({ chain: robinhood, transport, account: A3 });
await pub.waitForTransactionReceipt({ hash: await acct.writeContract({ address: ADDRESSES.usdg, abi: erc20Abi, functionName: "approve", args: [ADDRESSES.pay, maxUint256] }) });
await pub.waitForTransactionReceipt({ hash: await acct.writeContract({ address: ADDRESSES.pay, abi: payAbi, functionName: "open", args: [agentId, 2, 100, [XT]] }) });
await test.stopImpersonatingAccount({ address: A3 });
const before = await agent.pay.due(A3);
const fresh = fillmarkAgent({ publicClient: pub, walletClient: agentWallet, agentId, fromBlock: startBlock, maxClockSkewSec: 100_000, settings });
await fresh.fill(ok(await fresh.quoteBuy({ account: A3, asset: X, usdgIn: usd("20") })));
const after = await agent.pay.due(A3);
assert.ok(after.accrued > before.accrued, "the fill is billed");
assert.equal(after.wait, "NoToken"); // $FILLMARK has not graduated: nothing can be paid yet
await agent.pay.track(A3, Y);
const tracked = await pub.readContract({ address: ADDRESSES.pay, abi: payAbi, functionName: "tokensOf", args: [A3, agentId] });
assert.deepEqual(tracked.map((b) => b.token), [XT, YT]);

step("record equals the router's Filled events");
const rec = await agent.record(); // every account that ever installed the agent
const events = await pub.getContractEvents({ address: ADDRESSES.router, abi: routerAbi, eventName: "Filled", args: { agentId }, fromBlock: startBlock });
assert.equal(rec.total.fills, events.length);
assert.equal(rec.total.notional, events.reduce((s, e) => s + e.args.fill!.usdgAmount, 0n));
assert.equal(rec.total.sumCost, events.reduce((s, e) => s + e.args.prices!.cost, 0n));

step("accountStatus");
const st = await accountStatus(pub, A1);
assert.equal(st.owner, clientKey.account.address);
assert.equal(st.permission?.agentId, agentId);
assert.equal(st.plainKernel, true);

console.log(`   not covered on a fork: the hold-period buy refusal (needs a sale with a gain, so a Chainlink update)`);
clearInterval(beat);
console.log("E2E OK");
