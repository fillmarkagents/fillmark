// Drives e2e/run.sh: the real deploy script, a registered agent, a Kernel account made
// by the CLI, two agent runs, then withdraw, a failing withdraw, uninstall and reinstall.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestClient, erc20Abi, formatUnits, getAddress, hashTypedData, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import { planNonce, type Plan } from "../src/agent.js";
import { feedsAbi, routerAbi } from "../src/abi.generated.js";
import { ASSETS, IDENTITY, SESSIONS, USDG, clients, identityAbi } from "../src/chain.js";
import { intentDomain, intentTypes, type FillIntent } from "../src/intent.js";

const rpc = process.env.FILLMARK_RPC!;
const work = process.env.FILLMARK_E2E_DIR!;
const root = process.env.FILLMARK_ROOT!;
const tsx = join(root, "agent/node_modules/.bin/tsx");
const reputationAbi = [
  {
    type: "function",
    name: "getLastIndex",
    stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "address" }],
    outputs: [{ type: "uint64" }],
  },
] as const;
const REPUTATION: Address = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";

const test = createTestClient({ chain: robinhood, mode: "anvil", transport: http(rpc) });
const { pub } = clients();

function keyFile(name: string) {
  const key = generatePrivateKey();
  const path = join(work, `${name}.key`);
  writeFileSync(path, key + "\n", { mode: 0o600 });
  return { key, path, account: privateKeyToAccount(key) };
}

function step(msg: string) {
  console.log(`-- ${msg}`);
}

function cli(env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(tsx, ["src/cli.ts", ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function runAgent(config: string, env: Record<string, string> = {}) {
  const r = spawnSync(tsx, ["src/agent.ts", "--config", config, "--once"], { env: { ...process.env, ...env }, encoding: "utf8" });
  const lines = (r.stdout + r.stderr).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(r.status, 0, r.stderr);
  return lines as { level: string; msg: string; [k: string]: unknown }[];
}

const deployer = keyFile("deployer");
const agent = keyFile("agent");
const client = keyFile("client");
const guardian = privateKeyToAccount(generatePrivateKey()).address;
const safeOwners = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()).address);
for (const k of [deployer, agent, client]) {
  assert.equal(await pub.getCode({ address: k.account.address }), undefined, "fresh key has code");
  await test.setBalance({ address: k.account.address, value: 10n ** 18n });
}

step("deploy with script/Deploy.s.sol");
execFileSync(
  "forge",
  ["script", "script/Deploy.s.sol", "--rpc-url", rpc, "--private-key", deployer.key, "--broadcast", "--slow"],
  {
    cwd: root,
    env: {
      ...process.env,
      FILLMARK_DEPLOYER: deployer.account.address,
      FILLMARK_GUARDIAN: guardian,
      FILLMARK_SAFE_OWNERS: safeOwners.join(","),
      FOUNDRY_BROADCAST: join(work, "broadcast"),
    },
    stdio: "inherit",
  },
);
const run = JSON.parse(readFileSync(join(work, "broadcast/Deploy.s.sol/4663/run-latest.json"), "utf8"));
const created = (name: string) => getAddress(run.transactions.find((t: any) => t.contractName === name && t.transactionType === "CREATE").contractAddress);
const router = created("FillmarkRouter");
const feeds = created("FillmarkFeeds");
assert.equal(await pub.readContract({ address: router, abi: routerAbi, functionName: "feeds" }), feeds);
// The deployer gave every timelock role to the Safe and kept none.
const timelock = created("TimelockController");
const timelockAbi = parseAbi([
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32, address) view returns (bool)",
  "function getMinDelay() view returns (uint256)",
]);
const proposer = await pub.readContract({ address: timelock, abi: timelockAbi, functionName: "PROPOSER_ROLE" });
assert.equal(await pub.readContract({ address: timelock, abi: timelockAbi, functionName: "hasRole", args: [proposer, deployer.account.address] }), false);
assert.equal(await pub.readContract({ address: timelock, abi: timelockAbi, functionName: "getMinDelay" }), 2n * 86_400n);

step("move past the calendar start (deploy time + 30 min)");
await test.increaseTime({ seconds: 31 * 60 });
await test.mine({ blocks: 1 });
const now = (await pub.getBlock()).timestamp;
const session = SESSIONS[await pub.readContract({ address: feeds, abi: feedsAbi, functionName: "sessionAt", args: [now] })];
assert.notEqual(session, "Closed", "market is closed now; run e2e while US stocks trade (24/5)");
console.log(`   session: ${session}`);

step("register the agent (ERC-8004)");
const reg = await pub.simulateContract({ address: IDENTITY, abi: identityAbi, functionName: "register", args: [""], account: agent.account });
const agentWallet = clients(agent.account).wallet!;
await pub.waitForTransactionReceipt({ hash: await agentWallet.writeContract(reg.request) });
const agentId = reg.result;
assert.equal(await pub.readContract({ address: IDENTITY, abi: identityAbi, functionName: "getAgentWallet", args: [agentId] }), agent.account.address);

const env = { FILLMARK_RPC: rpc, FILLMARK_ROUTER: router, FILLMARK_KEY_FILE: client.path };
const installFlags = ["--agent-id", String(agentId), "--max-per-trade", "200", "--daily-limit", "500", "--expiry-days", "30", "--max-slip-bps", "200", "--assets", "TSLA,NVDA,WETH,cbBTC"];

step("cli create");
const c1 = cli(env, "create", ...installFlags);
assert.equal(c1.code, 0, c1.err);
const account = getAddress(JSON.parse(c1.out).account);
assert.equal(await pub.readContract({ address: router, abi: routerAbi, functionName: "isInitialized", args: [account] }), true);
await test.request({ method: "anvil_dealERC20" as any, params: [account, USDG, "0x" + parseUnits("1000", 6).toString(16)] as any });

step("EIP-712 hash matches the router");
const sample: FillIntent = {
  agentId, account, installId: 1n, tokenIn: USDG, tokenOut: ASSETS.TSLA, fee: 3000, amountIn: 1n, minOut: 2n,
  refSqrtPriceX96: 3n, maxDevBps: 4, sqrtPriceLimitX96: 5n, nonce: 6n, deadline: 7n,
};
assert.equal(
  hashTypedData({ domain: intentDomain(router, 4663), types: intentTypes, primaryType: "FillIntent", message: sample }),
  await pub.readContract({ address: router, abi: routerAbi, functionName: "hashIntent", args: [sample] }),
);

const plans: Plan[] = [
  { account, asset: "TSLA", usdgPerBuy: "50", intervalSec: 3600 },
  { account, asset: "NVDA", usdgPerBuy: "25", intervalSec: 3600 },
  { account, asset: "WETH", usdgPerBuy: "30", intervalSec: 3600 },
  { account, asset: "cbBTC", usdgPerBuy: "20", intervalSec: 3600 },
];
const config = join(work, "agent.json");
writeFileSync(config, JSON.stringify({ router, agentId: String(agentId), keyFile: agent.path, plans, allowExtended: true }));
const usdgOf = (a: Address) => pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const statsOf = (token: Address) => pub.readContract({ address: router, abi: routerAbi, functionName: "statsOf", args: [agentId, account, token] });

// Both agent runs must fall in one hourly slot: skip ahead if an hour boundary is near.
const left = 3600n - ((await pub.getBlock()).timestamp % 3600n);
if (left < 300n) {
  await test.increaseTime({ seconds: Number(left) + 1 });
  await test.mine({ blocks: 1 });
}

step("agent run 1: one fill per plan");
const l1 = runAgent(config);
const fills = l1.filter((l) => l.msg === "filled");
assert.equal(fills.length, 4, JSON.stringify(l1));
for (const f of fills) console.log(`   ${f.asset} fee ${f.fee}: ${f.usdg} USDG micro, cost ${f.costUsdg} USDG micro`);
assert.equal((await statsOf(ASSETS.TSLA)).fills, 1);
assert.equal((await statsOf(ASSETS.NVDA)).fills, 1);
assert.equal((await statsOf(ASSETS.WETH)).fills, 1);
assert.equal((await statsOf(ASSETS.cbBTC)).fills, 1);
assert.equal(await usdgOf(account), parseUnits("875", 6));
assert.equal(await pub.readContract({ address: REPUTATION, abi: reputationAbi, functionName: "getLastIndex", args: [agentId, account] }), 8n);
const t1 = (await pub.getBlock()).timestamp;
for (const p of plans) {
  const used = await pub.readContract({ address: router, abi: routerAbi, functionName: "nonceUsed", args: [account, planNonce(p, t1 / 3600n)] });
  assert.equal(used, true, `nonce for ${p.asset} slot`);
}

step("agent run 2 in the same slot: nothing happens");
const l2 = runAgent(config);
assert.equal(l2.filter((l) => l.msg === "filled").length, 0, JSON.stringify(l2));
assert.equal((await statsOf(ASSETS.TSLA)).fills, 1);

step("cli status");
const s = cli(env, "status", account);
assert.equal(s.code, 0, s.err);
const st = JSON.parse(s.out);
assert.equal(st.installed, true);
assert.equal(st.assets.TSLA.fills, 1);
assert.equal(st.assets.WETH.fills, 1);
assert.equal(st.assets.cbBTC.fills, 1);
console.log(`   cost vs NAV: TSLA ${st.assets.TSLA.costBps} bps, NVDA ${st.assets.NVDA.costBps} bps, WETH ${st.assets.WETH.costBps} bps, cbBTC ${st.assets.cbBTC.costBps} bps`);

step("cli withdraw an exact cbBTC amount (8 decimals)");
const btc = await pub.readContract({ address: ASSETS.cbBTC, abi: erc20Abi, functionName: "balanceOf", args: [account] });
assert.ok(btc > 0n);
assert.equal(st.balances.cbBTC, formatUnits(btc, 8));
const wb = cli(env, "withdraw", account, "cbBTC", st.balances.cbBTC);
assert.equal(wb.code, 0, wb.err);
assert.equal(await pub.readContract({ address: ASSETS.cbBTC, abi: erc20Abi, functionName: "balanceOf", args: [client.account.address] }), btc);
assert.equal(await pub.readContract({ address: ASSETS.cbBTC, abi: erc20Abi, functionName: "balanceOf", args: [account] }), 0n);

step("cli withdraw TSLA all to the owner");
const tsla = await pub.readContract({ address: ASSETS.TSLA, abi: erc20Abi, functionName: "balanceOf", args: [account] });
assert.ok(tsla > 0n);
const w = cli(env, "withdraw", account, "TSLA", "all");
assert.equal(w.code, 0, w.err);
assert.equal(await pub.readContract({ address: ASSETS.TSLA, abi: erc20Abi, functionName: "balanceOf", args: [client.account.address] }), tsla);
assert.equal(await pub.readContract({ address: ASSETS.TSLA, abi: erc20Abi, functionName: "balanceOf", args: [account] }), 0n);

step("cli withdraw more USDG than the account holds fails and says so");
const bad = cli(env, "withdraw", account, "USDG", "100000");
assert.equal(bad.code, 1);
assert.match(bad.err, /user operation failed/);
assert.equal(await usdgOf(account), parseUnits("875", 6));

step("cli uninstall stops the agent");
const u = cli(env, "uninstall", account);
assert.equal(u.code, 0, u.err);
assert.equal(await pub.readContract({ address: router, abi: routerAbi, functionName: "isInitialized", args: [account] }), false);
await test.increaseTime({ seconds: 3600 });
await test.mine({ blocks: 1 });
const l3 = runAgent(config);
assert.equal(l3.filter((l) => l.msg === "filled").length, 0);
assert.ok(l3.some((l) => l.msg === "account not open to this agent"), JSON.stringify(l3));

step("agent refuses an RPC clock far from the local clock");
const l4 = runAgent(config, { FILLMARK_MAX_CLOCK_SKEW: "60" });
assert.ok(l4.some((l) => l.msg === "tick failed" && String(l.error).includes("away from the local clock")), JSON.stringify(l4));

step("cli install again");
const i = cli(env, "install", account, ...installFlags);
assert.equal(i.code, 0, i.err);
const cfg = await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [account] });
assert.equal(cfg[5], true);
assert.equal(cfg[4], 2n);

console.log("E2E OK");
