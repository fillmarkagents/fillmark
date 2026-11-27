// Driven by test/run.sh (FILLMARK_E2E_SCRIPT=test/e2e-settings.ts) on an anvil fork: client
// strategy settings signed by the owners of Kernel accounts made by the reference CLI. Fills
// under a setting carry its fingerprint, and the record library proves which setting each ran
// under from the router's logs alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import {
  ADDRESSES,
  assetOf,
  fillmarkAgent,
  memoryStore,
  routerAbi,
  settingHash,
  settingJson,
  settingTypedData,
  fingerprint,
  type Quote,
  type Setting,
} from "../src/index.js";
// The record library resolves its imports bundler-style, so it is loaded at run time only.
const lib = (name: string) => import(`../../record/src/${name}.ts`) as Promise<any>;
const [{ tagFills }, { buildRecord, decodeRouterLogs, routerTopics }, { getLogs, readFor }] = await Promise.all([lib("strategy"), lib("record"), lib("load")]);

const rpc = process.env.FILLMARK_RPC!;
const work = process.env.FILLMARK_E2E_DIR!;
const root = process.env.FILLMARK_ROOT!;
const transport = http(rpc, { timeout: 60_000 });
const pub = createPublicClient({ chain: robinhood, transport });
const test = createTestClient({ chain: robinhood, mode: "anvil", transport });
const LIST = ["WETH", "cbBTC", "TSLA", "NVDA", "QQQ", "MU", "AMD", "USO", "CRCL", "PLTR"];
const usd = (s: string) => parseUnits(s, 6);
const step = (msg: string) => console.log(`-- ${msg}`);

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
const strangerKey = key("stranger");
for (const k of [agentKey, clientKey]) await test.setBalance({ address: k.account.address, value: 10n ** 18n });

step("register the test agent (ERC-8004)");
const identityAbi = parseAbi(["function register(string agentURI) returns (uint256)"]);
const agentWallet = createWalletClient({ chain: robinhood, transport, account: agentKey.account });
const reg = await pub.simulateContract({ address: ADDRESSES.identity, abi: identityAbi, functionName: "register", args: [""], account: agentKey.account });
await pub.waitForTransactionReceipt({ hash: await agentWallet.writeContract(reg.request) });
const agentId = reg.result;

const startBlock = await pub.getBlockNumber();
const cliEnv = { ...process.env, FILLMARK_RPC: rpc, FILLMARK_ROUTER: ADDRESSES.router, FILLMARK_KEY_FILE: clientKey.path, FILLMARK_MAX_CLOCK_SKEW: "100000" };
function create(salt: number): Address {
  const flags = ["--max-per-trade", "50", "--daily-limit", "300", "--expiry-days", "30", "--max-slip-bps", "200", "--perf-fee-bps", "0", "--assets", LIST.join(",")];
  const r = spawnSync(join(root, "agent/node_modules/.bin/tsx"), ["src/cli.ts", "create", "--agent-id", String(agentId), "--salt", String(salt), ...flags], {
    cwd: join(root, "agent"),
    env: cliEnv,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return getAddress(JSON.parse(r.stdout).account);
}
step("client accounts made by the reference CLI");
const [DCA, FORGED, REB, PLAIN, LATER, UNDATED, BROKEN] = [1, 2, 3, 4, 5, 6, 7].map(create);
for (const a of [DCA, FORGED, REB, PLAIN, LATER, UNDATED, BROKEN])
  await test.request({ method: "anvil_dealERC20" as any, params: [a, ADDRESSES.usdg, "0x" + usd("200").toString(16)] as any });

const t0 = (await pub.getBlock()).timestamp;
const day = t0 / 86_400n;
const base = { agentId, takeProfitBps: 0, targets: [], cashBps: 0, driftBps: 0, everyDays: 0, seq: 1n };
const dcaOf = (account: Address): Setting => ({ ...base, account, strategy: "dca", takeProfitBps: 500, validFrom: (day - 2n) * 86_400n });
const settings: Record<Address, Setting> = {
  [DCA]: dcaOf(DCA),
  [FORGED]: dcaOf(FORGED),
  [REB]: {
    ...base,
    account: REB,
    strategy: "rebalance",
    targets: [
      { asset: assetOf("WETH")!.token, ticker: "WETH", weightBps: 5000 },
      { asset: assetOf("cbBTC")!.token, ticker: "cbBTC", weightBps: 3000 },
    ],
    cashBps: 2000,
    driftBps: 500,
    validFrom: (day - 2n) * 86_400n,
  },
  [LATER]: { ...dcaOf(LATER), validFrom: t0 - 60n },
  [UNDATED]: dcaOf(UNDATED),
  [BROKEN]: dcaOf(BROKEN),
};
const sign = async (s: Setting, by: PrivateKeyAccount) => by.signTypedData(settingTypedData(s) as any);
// What api.fillmark.trade answers: settings with the time it stored them (UNDATED: no time given).
const source: { setting: unknown; signature: Hex; received?: number }[] = [];
const yesterday = Number((day - 1n) * 86_400n + 600n);
const add = async (s: Setting, by: PrivateKeyAccount, received: number | undefined) =>
  source.push({ setting: settingJson(s), signature: await sign(s, by), ...(received === undefined ? {} : { received }) });
for (const [a, s] of Object.entries(settings) as [Address, Setting][])
  await add(s, a === FORGED ? strangerKey.account : clientKey.account, a === LATER ? Number(t0) : a === UNDATED ? undefined : yesterday);
// An item no wallet could sign (out of range, cannot be hashed): skipped, the rest still read.
source.push({ setting: { ...settingJson(dcaOf(PLAIN)), cashBps: 70000, seq: (1n << 64n).toString() }, signature: `0x${"11".repeat(65)}` });
// BROKEN's owner later signed a setting this SDK cannot follow (an unknown strategy).
await add({ ...settings[BROKEN]!, strategy: "momentum" as any, seq: 2n }, clientKey.account, yesterday);
const urls: string[] = [];
let sourceUp = true;
const fetchJson = async (url: string) => {
  urls.push(url);
  if (!sourceUp) throw new Error("down");
  return { agentId: String(agentId), settings: source };
};
const opts = { publicClient: pub, walletClient: agentWallet, agentId, fromBlock: startBlock, maxClockSkewSec: 100_000 };
const store = memoryStore();
const agent = fillmarkAgent({ ...opts, strategies: ["dca"], settings: { fetch: fetchJson }, store, policy: { maxFillsPerPairPerDay: 3, saleAboveCost: false } });

const ok = (q: Quote) => {
  assert.equal(q.ok, true, q.ok ? "" : `${q.reason}: ${q.message}`);
  return q as Extract<Quote, { ok: true }>;
};
const refused = (q: Quote, reason: string, re?: RegExp) => {
  assert.equal(q.ok, false, `expected ${reason}`);
  assert.equal((q as any).reason, reason);
  if (re) assert.match((q as any).message, re);
};

step("market");
const mk = await agent.market(LIST);
const fits = (m: (typeof mk)[number]) => m.tradable && Math.abs(Number(m.premiumPpm)) + m.poolFee! <= (m.capBps! - 30) * 100;
const X = mk.find(fits)?.ticker;
if (!X) throw new Error("STOP: no asset is inside its pool bounds at this block; run again later");
console.log(`   trading ${X}`);

step("the setting each account has today");
const sDca = await agent.setting(DCA);
assert.equal(sDca.kind, "active");
assert.ok(sDca.kind === "active" && sDca.followed && sDca.strategy === "dca" && sDca.digest === settingHash(settings[DCA]!));
assert.equal(sDca.kind === "active" && sDca.since, day * 86_400n, "stored yesterday, so in effect from today");
assert.deepEqual(await agent.setting(PLAIN), { kind: "none" });
assert.deepEqual(await agent.setting(LATER), { kind: "none" }, "stored today: from tomorrow");
assert.deepEqual(await agent.setting(UNDATED), { kind: "blocked", reason: "a setting waits to take effect" });
const forged = await agent.setting(FORGED);
assert.deepEqual(forged, { kind: "blocked", reason: "the latest setting was not signed by the account's owner now" });
const reb = await agent.setting(REB);
assert.ok(reb.kind === "active" && reb.strategy === "rebalance" && !reb.followed);
assert.deepEqual(await agent.setting(BROKEN), { kind: "blocked", reason: "unknown strategy" }, "a setting it cannot follow is kept, and blocks");
assert.deepEqual(urls, [`https://api.fillmark.trade/v1/settings?agent=${agentId}`], "one read for every account");

step("refusals");
refused(await agent.quoteBuy({ account: FORGED, asset: X, usdgIn: usd("15") }), "SettingBlocked", /owner/);
refused(await agent.quoteBuy({ account: UNDATED, asset: X, usdgIn: usd("15") }), "SettingBlocked", /waits/);
refused(await agent.quoteBuy({ account: REB, asset: X, usdgIn: usd("15") }), "StrategyNotFollowed", /rebalance/);
const rebalancer = fillmarkAgent({ ...opts, strategies: ["rebalance"], settings: { fetch: fetchJson } });
refused(await rebalancer.quoteBuy({ account: REB, asset: "TSLA", usdgIn: usd("15") }), "NotATarget");
const lazy = fillmarkAgent({ ...opts, settings: { fetch: fetchJson } }); // follows no strategy
refused(await lazy.quoteBuy({ account: DCA, asset: X, usdgIn: usd("15") }), "StrategyNotFollowed");
ok(await lazy.quoteBuy({ account: PLAIN, asset: X, usdgIn: usd("15") }));

step("two buys and a sale under the dca setting: each nonce carries the fingerprint");
const fp = fingerprint(settings[DCA]!);
const sent: Hex[] = [];
for (const amount of ["15", "12"]) {
  const q = ok(await agent.quoteBuy({ account: DCA, asset: X, usdgIn: usd(amount) }));
  assert.equal(q.strategy, "dca");
  assert.equal(q.setting, settingHash(settings[DCA]!));
  assert.equal(q.intent.nonce >> 128n, fp);
  sent.push((await agent.fill(q)).hash);
}
const qs = ok(await agent.quoteSell({ account: DCA, asset: X }));
assert.equal(qs.intent.nonce >> 128n, fp);
sent.push((await agent.fill(qs)).hash);
refused(await agent.quoteBuy({ account: DCA, asset: X, usdgIn: usd("10") }), "PairCap");

step("an account without a setting: the plain SDK nonce");
const qp = ok(await agent.quoteBuy({ account: PLAIN, asset: X, usdgIn: usd("15") }));
assert.equal(qp.strategy, null);
assert.equal(qp.setting, null);
const plainHash = (await agent.fill(qp)).hash;
const qLater = ok(await agent.quoteBuy({ account: LATER, asset: X, usdgIn: usd("15") }));
assert.equal(qLater.setting, null, "a setting stored today does not apply until tomorrow");

step("a setting the source shows only after a read earlier today applies from tomorrow");
await add(dcaOf(PLAIN), clientKey.account, yesterday);
const later = fillmarkAgent({ ...opts, strategies: ["dca"], settings: { fetch: fetchJson }, store }); // same store, a new read
assert.deepEqual(await later.setting(PLAIN), { kind: "none" });
assert.equal(JSON.parse(store.get(`${ADDRESSES.router}:${agentId}:settings:${PLAIN}`)!)[0].notBefore, String(day + 1n));
ok(await later.quoteBuy({ account: PLAIN, asset: X, usdgIn: usd("15") }));

step("the source down: today's read stands, a store never read today is not traded");
sourceUp = false;
const again = fillmarkAgent({ ...opts, strategies: ["dca"], settings: { fetch: fetchJson }, store, policy: { maxFillsPerPairPerDay: 3 } });
assert.equal((await again.setting(DCA)).kind, "active");
const stale = memoryStore();
stale.set(`${ADDRESSES.router}:${agentId}:settingsDay`, String(day - 1n)); // read yesterday only
const cold = fillmarkAgent({ ...opts, strategies: ["dca"], settings: { fetch: fetchJson }, store: stale });
refused(await cold.quoteBuy({ account: PLAIN, asset: X, usdgIn: usd("15") }), "SettingsUnavailable");
await assert.rejects(cold.setting(PLAIN), (e: any) => e.code === "SettingsUnavailable");
sourceUp = true;

step("the record library builds the fills from the router's logs and proves each fill's setting");
const head = await pub.getBlockNumber();
const raw = (await Promise.all(routerTopics(ADDRESSES.router).map((topic: Hex) => getLogs(pub, { address: ADDRESSES.router, topics: [topic] }, startBlock, head, 5_000_000n)))).flat();
const decoded = decodeRouterLogs(raw);
const fillBlocks = decoded.filter((l: any) => l.name === "Filled").map((l: any) => l.blockNumber);
const record = buildRecord(decoded, [], { block: head, ...(await readFor(pub, decoded, head, fillBlocks)) });
const fills = record.fills.filter((f: any) => f.agentId === agentId);
assert.equal(fills.length, sent.length + 1);
for (const f of fills) {
  const cfg = await pub.readContract({ address: ADDRESSES.router, abi: routerAbi, functionName: "configs", args: [f.account] });
  assert.equal(f.installId, cfg[5], "the fill's install, from the Installed event");
}
const byAccount = new Map(Object.entries(settings).map(([a, s]) => [a.toLowerCase(), [s]]));
const tags = tagFills(fills, byAccount);
for (const hash of sent) {
  const f = fills.find((x: any) => x.tx === hash)!;
  assert.deepEqual(tags.get(f.fillId.toLowerCase()), { strategy: "dca", setting: settingHash(settings[DCA]!) }, hash);
}
assert.equal(tags.get(fills.find((x: any) => x.tx === plainHash)!.fillId.toLowerCase()), undefined, "no setting, no tag");

clearInterval(beat);
console.log("E2E SETTINGS OK");
