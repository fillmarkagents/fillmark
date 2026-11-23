// Drives e2e/run.sh with FILLMARK_E2E_SCRIPT=e2e/sell.ts: the take-profit sale on a fork.
// Crypto trades at any hour, so this runs while US stocks are closed. A fork cannot move a
// Chainlink price, so each account gets a lot from a buy signed here with its own nonce,
// and the agent runs with a take-profit threshold below that lot's cost.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestClient, erc20Abi, getAddress, http, keccak256, parseUnits, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import { DAY, buyNonce, saleNonce } from "../src/agent.js";
import { routerAbi } from "../src/abi.generated.js";
import { ASSETS, FEE_TIERS, IDENTITY, UNISWAP_FACTORY, USDG, clients, factoryAbi, identityAbi, poolAbi } from "../src/chain.js";
import { signIntent, type FillIntent } from "../src/intent.js";

const rpc = process.env.FILLMARK_RPC!;
const work = process.env.FILLMARK_E2E_DIR!;
const root = process.env.FILLMARK_ROOT!;
const tsx = join(root, "agent/node_modules/.bin/tsx");
const test = createTestClient({ chain: robinhood, mode: "anvil", transport: http(rpc) });
const { pub } = clients();
const WETH = ASSETS.WETH; // token0 of its USDG pools
const CBBTC = ASSETS.cbBTC; // token1 of its USDG pools

function keyFile(name: string) {
  const key = generatePrivateKey();
  const path = join(work, `${name}.key`);
  writeFileSync(path, key + "\n", { mode: 0o600 });
  return { key, path, account: privateKeyToAccount(key) };
}
const step = (msg: string) => console.log(`-- ${msg}`);
function cli(env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(tsx, ["src/cli.ts", ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function runAgent(config: string) {
  const r = spawnSync(tsx, ["src/agent.ts", "--config", config, "--once"], { env: { ...process.env, FILLMARK_E2E_LOW_TAKE_PROFIT: "1" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return (r.stdout + r.stderr).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) as { msg: string; [k: string]: unknown }[];
}

const deployer = keyFile("deployer");
const agent = keyFile("agent");
const client = keyFile("client");
for (const k of [deployer, agent, client]) await test.setBalance({ address: k.account.address, value: 10n ** 18n });

const deployBlock = (await pub.getBlockNumber()) + 1n;
step("deploy with script/DeployV2.s.sol");
execFileSync(
  "forge",
  ["script", "script/DeployV2.s.sol", "--rpc-url", rpc, "--private-key", deployer.key, "--broadcast", "--slow", "--code-size-limit", "98304"],
  { cwd: root, env: { ...process.env, FILLMARK_DEPLOYER: deployer.account.address, FOUNDRY_BROADCAST: join(work, "broadcast") }, stdio: "inherit" },
);
const run = JSON.parse(readFileSync(join(work, "broadcast/DeployV2.s.sol/4663/run-latest.json"), "utf8"));
writeFileSync(join(work, "deployed"), ""); // run.sh starts its block heartbeat after the deploy
const created = (name: string) => getAddress(run.transactions.find((t: any) => t.contractName === name && t.transactionType === "CREATE").contractAddress);
const router = created("FillmarkRouterV2");
const burner = created("FillmarkBurner");

step("register the agent");
const reg = await pub.simulateContract({ address: IDENTITY, abi: identityAbi, functionName: "register", args: [""], account: agent.account });
const agentWallet = clients(agent.account).wallet!;
await pub.waitForTransactionReceipt({ hash: await agentWallet.writeContract(reg.request) });
const agentId = reg.result;

// One UTC day for all runs below.
const toMidnight = DAY - ((await pub.getBlock()).timestamp % DAY);
if (toMidnight < 1800n) {
  await test.increaseTime({ seconds: Number(toMidnight) + 1 });
  await test.mine({ blocks: 1 });
}
const day = (await pub.getBlock()).timestamp / DAY;

const env = { FILLMARK_RPC: rpc, FILLMARK_ROUTER: router, FILLMARK_KEY_FILE: client.path };
const usdgOf = (a: Address) => pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const wethOf = (a: Address) => pub.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const lotOf = async (a: Address, token: Address = WETH) => (await pub.readContract({ address: router, abi: routerAbi, functionName: "positionOf", args: [a, agentId, token] }))[0];
const deal = (a: Address, token: Address, amount: bigint) =>
  test.request({ method: "anvil_dealERC20" as any, params: [a, token, toHex(amount)] as any });

async function account(name: string, maxPerTrade: string, salt: string, asset = "WETH", dailyLimit = "2000"): Promise<Address> {
  const r = cli(env, "create", "--agent-id", String(agentId), "--max-per-trade", maxPerTrade, "--daily-limit", dailyLimit, "--expiry-days", "30",
    "--max-slip-bps", "200", "--perf-fee-bps", "0", "--assets", asset, "--salt", salt);
  assert.equal(r.code, 0, r.err);
  const a = getAddress(JSON.parse(r.out).account);
  await deal(a, USDG, parseUnits("1000", 6));
  console.log(`   ${name}: ${a}, ${maxPerTrade} USDG per trade, ${dailyLimit} a day`);
  return a;
}

/// A buy of `usdg` signed here with a nonce the agent never uses: it gives the account a lot.
/// `n` tells the buys of one account apart.
async function seed(a: Address, usdg: string, n = 0, token: Address = WETH) {
  const cfg = await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [a] });
  let last = "";
  for (const fee of FEE_TIERS) {
    const pool = await pub.readContract({ address: UNISWAP_FACTORY, abi: factoryAbi, functionName: "getPool", args: [USDG, token, fee] });
    if (pool === "0x0000000000000000000000000000000000000000") continue;
    const [sqrtP] = await pub.readContract({ address: pool, abi: poolAbi, functionName: "slot0" });
    const it: FillIntent = {
      agentId, account: a, installId: cfg[5], tokenIn: USDG, tokenOut: token, fee, amountIn: parseUnits(usdg, 6), minOut: 1n,
      refSqrtPriceX96: sqrtP, maxDevBps: 50, sqrtPriceLimitX96: 0n, nonce: BigInt(keccak256(toHex(`e2e-seed-${a}-${n}`))),
      deadline: (await pub.getBlock()).timestamp + 300n,
    };
    const sig = await signIntent(agent.account, router, 4663, it);
    try {
      const { request } = await pub.simulateContract({ address: router, abi: routerAbi, functionName: "execute", args: [it, sig], account: agent.account });
      await pub.waitForTransactionReceipt({ hash: await agentWallet.writeContract(request) });
      return;
    } catch (err) {
      last = String((err as Error).message).replace(/\s*\n\s*/g, " / ").slice(0, 600); // this tier is rejected: try the next one
    }
  }
  throw new Error(`no tier can seed ${a}: ${last}`);
}

step("accounts: E sells its whole lot at once, G sells it in several sales, K (cbBTC) stops at its daily limit, F (10 USDG per trade) cannot sell");
const E = await account("E", "1000", "11");
const G = await account("G", "12", "12");
const F = await account("F", "10", "13");
const K = await account("K", "12", "15", "cbBTC", "60");
await seed(E, "20");
for (let n = 0; n < 3; n++) await seed(G, "12", n); // a lot worth about 36 USDG, more than one 12 USDG sale
for (let n = 0; n < 3; n++) await seed(F, "10", n);
for (let n = 0; n < 3; n++) await seed(K, "12", n, CBBTC);
// E also holds WETH the client sent itself: the agent never sells it.
const own = parseUnits("0.01", 18);
await deal(E, WETH, (await wethOf(E)) + own);

const config = join(work, "agent.json");
const writeConfig = (takeProfitBps: number) =>
  writeFileSync(config, JSON.stringify({ router, agentId: String(agentId), keyFile: agent.path, deployBlock: String(deployBlock), takeProfitBps, allowExtended: true }));
const pre = { E: await lotOf(E), G: await lotOf(G), K: await lotOf(K, CBBTC), Ebal: await wethOf(E), burner: await usdgOf(burner) };

step("a take-profit threshold below 1 bp is refused outside fork tests");
writeConfig(-500);
const refused = spawnSync(tsx, ["src/agent.ts", "--config", config, "--once"], { encoding: "utf8" });
assert.notEqual(refused.status, 0);
assert.match(refused.stdout + refused.stderr, /takeProfitBps must be an integer in 1\.\.100000/);

step("take-profit threshold below cost (-5%), as a fork cannot raise the price: E sells its whole lot, G sells until under 10 USDG is left, K stops at its daily limit, F buys instead");
writeConfig(-500);
const l = runAgent(config);
const by = (a: Address) => l.filter((x) => x.msg === "filled" && x.account === a);
const usdg = (x: { [k: string]: unknown }) => BigInt(x.usdg as string);
const e = by(E);
assert.deepEqual(e.map((x) => x.side), ["sell"], JSON.stringify(l));
assert.equal(BigInt(e[0].assetAmount as string), pre.E.qty); // the whole lot in one sale
assert.equal((await lotOf(E)).qty, 0n);
assert.equal(await wethOf(E), pre.Ebal - pre.E.qty);
assert.ok((await wethOf(E)) >= own, "the client's own WETH stays");
const g = by(G);
assert.ok(g.length >= 2 && g.every((x) => x.side === "sell"), JSON.stringify(l));
for (const x of g) assert.ok(usdg(x) >= 10_000_000n && usdg(x) <= 12_000_000n, `G sold ${usdg(x)}`);
const gLot = await lotOf(G);
assert.ok(gLot.qty < pre.G.qty);
const gLeft = (gLot.qty * BigInt(g.at(-1)!.nav as string)) / 10n ** 20n; // NAV value of what is left
assert.ok(gLeft < 10_200_000n, `G kept ${gLeft} USDG micro of its lot`);
const k = by(K);
assert.deepEqual(k.map((x) => x.side), ["sell", "sell"], JSON.stringify(l)); // 60 USDG a day, 36 spent on the seed buys: two sales of about 12
assert.ok((await lotOf(K, CBBTC)).qty > 0n);
const f = by(F);
assert.deepEqual(f.map((x) => x.side), ["buy"], JSON.stringify(l));
assert.equal(usdg(f[0]), 10_000_000n);
assert.ok(l.some((x) => x.msg.startsWith("take-profit reached but no sale fits") && x.account === F), JSON.stringify(l));
const all = l.filter((x) => x.msg === "filled");
assert.equal(all.length, e.length + g.length + k.length + f.length, JSON.stringify(l));
const fees = all.reduce((s, x) => s + BigInt(x.fillFee as string), 0n);
assert.equal(await usdgOf(burner), pre.burner + fees);
for (const [n, xs] of [["E", e], ["G", g], ["K", k]] as const) for (const x of xs) console.log(`   ${n} sold ${x.assetAmount} units for ${x.usdg} USDG micro, fill fee ${x.fillFee}`);
const book = await pub.readContract({ address: router, abi: routerAbi, functionName: "bookOf", args: [G, agentId] });
console.log(`   G book after the sales: realized ${book.realized}, debt ${book.debt}`);
for (const [a, token] of [[E, WETH], [G, WETH], [K, CBBTC]] as const) {
  assert.equal(await pub.readContract({ address: router, abi: routerAbi, functionName: "nonceUsed", args: [a, saleNonce(a, token, day, 0n)] }), true);
  assert.equal(await pub.readContract({ address: router, abi: routerAbi, functionName: "nonceUsed", args: [a, buyNonce(a, token, day)] }), false, "no buy on a sale day");
}
assert.equal(await pub.readContract({ address: router, abi: routerAbi, functionName: "nonceUsed", args: [F, buyNonce(F, WETH, day)] }), true);

step("the same day again: nothing is sent");
const again = runAgent(config);
assert.equal(again.filter((x) => x.msg === "filled").length, 0, JSON.stringify(again));

step("with the production threshold (5%) a new account's lot is not in profit: H buys");
const H = await account("H", "12", "14");
for (let n = 0; n < 3; n++) await seed(H, "12", n);
const hBefore = await lotOf(H);
writeConfig(500);
const lh = runAgent(config);
const fh = lh.filter((x) => x.msg === "filled");
assert.equal(fh.length, 1, JSON.stringify(lh));
assert.equal(fh[0].account, H);
assert.equal(fh[0].side, "buy");
assert.ok((await lotOf(H)).qty > hBefore.qty);

console.log("E2E SELL OK");
