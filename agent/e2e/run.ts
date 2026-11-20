// Drives e2e/run.sh: the real deploy script, a registered agent, Kernel accounts made by
// the CLI, agent runs that find their clients on chain (ETH reserve, a legacy-nonce buy,
// round robin and the daily fill cap across restarts, daily limits, unfunded, expired,
// hooked and non-Kernel accounts), then withdraw, a failing withdraw, uninstall and
// reinstall, and an account owned by a wallet that only signs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestClient, encodeAbiParameters, erc20Abi, formatUnits, getAddress, hashTypedData, http, keccak256, pad, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import { DAY, buyNonce, legacyNonce } from "../src/agent.js";
import { feedsAbi, routerAbi } from "../src/abi.generated.js";
import { ASSETS, ECDSA_VALIDATOR, IDENTITY, SESSIONS, UNISWAP_FACTORY, USDG, clients, factoryAbi, identityAbi, poolAbi } from "../src/chain.js";
import { intentDomain, intentTypes, signIntent, type FillIntent } from "../src/intent.js";

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

const deployBlock = (await pub.getBlockNumber()) + 1n;
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
const installFlags = ["--agent-id", String(agentId), "--max-per-trade", "50", "--daily-limit", "200", "--expiry-days", "30", "--max-slip-bps", "200", "--assets", "TSLA,NVDA,WETH,cbBTC"];
const deal = (a: Address, usdg: string) => test.request({ method: "anvil_dealERC20" as any, params: [a, USDG, "0x" + parseUnits(usdg, 6).toString(16)] as any });

step("cli create");
const c1 = cli(env, "create", ...installFlags);
assert.equal(c1.code, 0, c1.err);
const account = getAddress(JSON.parse(c1.out).account);
assert.equal(await pub.readContract({ address: router, abi: routerAbi, functionName: "isInitialized", args: [account] }), true);
await deal(account, "1000");

step("EIP-712 hash matches the router");
const sample: FillIntent = {
  agentId, account, installId: 1n, tokenIn: USDG, tokenOut: ASSETS.TSLA, fee: 3000, amountIn: 1n, minOut: 2n,
  refSqrtPriceX96: 3n, maxDevBps: 4, sqrtPriceLimitX96: 5n, nonce: 6n, deadline: 7n,
};
assert.equal(
  hashTypedData({ domain: intentDomain(router, 4663), types: intentTypes, primaryType: "FillIntent", message: sample }),
  await pub.readContract({ address: router, abi: routerAbi, functionName: "hashIntent", args: [sample] }),
);

const usdgOf = (a: Address) => pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const statsOf = (token: Address, a: Address = account) => pub.readContract({ address: router, abi: routerAbi, functionName: "statsOf", args: [agentId, a, token] });
const filled = (lines: { msg: string; [k: string]: unknown }[], a?: Address) => lines.filter((l) => l.msg === "filled" && (!a || l.account === a));
const lastServed = (lines: { msg: string; [k: string]: unknown }[]) => lines.filter((l) => l.msg === "clients").at(-1)?.served;

step("the live account's 19 Nov 2026 TSLA buy used the legacy nonce this agent also checks");
const live = getAddress("0xB5667f1c68bADFc54CE5eaCc60EACb89473Ec37C");
const liveRouter = getAddress("0xe542a7c8779962b8f819c4352d1436e08bc2d388");
assert.equal(await pub.readContract({ address: liveRouter, abi: routerAbi, functionName: "nonceUsed", args: [live, legacyNonce(live, ASSETS.TSLA, 10_000_000n, 20_776n)] }), true);

// All agent runs below must fall in one UTC day: skip ahead if midnight is near.
const toMidnight = DAY - ((await pub.getBlock()).timestamp % DAY);
if (toMidnight < 1800n) {
  await test.increaseTime({ seconds: Number(toMidnight) + 1 });
  await test.mine({ blocks: 1 });
}

step("more accounts: B has a 60 USDG daily limit, C holds 5 USDG and expires in 15 minutes");
const cB = cli(env, "create", ...installFlags.map((f, k) => (installFlags[k - 1] === "--max-per-trade" ? "30" : installFlags[k - 1] === "--daily-limit" ? "60" : f)), "--salt", "2");
assert.equal(cB.code, 0, cB.err);
const accountB = getAddress(JSON.parse(cB.out).account);
await deal(accountB, "1000");
const expC = (await pub.getBlock()).timestamp + 900n;
const flagsC = installFlags.flatMap((f, k) => (f === "--expiry-days" ? ["--expiry", String(expC)] : installFlags[k - 1] === "--expiry-days" ? [] : [f]));
const cC = cli(env, "create", ...flagsC, "--salt", "3");
assert.equal(cC.code, 0, cC.err);
const accountC = getAddress(JSON.parse(cC.out).account);
await deal(accountC, "5");

const config = join(work, "agent.json");
const day = (await pub.getBlock()).timestamp / DAY;
const writeConfig = (maxFillsPerDay: number) =>
  writeFileSync(
    config,
    JSON.stringify({ router, agentId: String(agentId), keyFile: agent.path, deployBlock: String(deployBlock), maxFillsPerDay, legacyNonceUntilDay: String(day), allowExtended: true }),
  );
writeConfig(4);

step("below the ETH reserve the agent sends nothing");
await test.setBalance({ address: agent.account.address, value: 10n ** 12n });
const l0 = runAgent(config);
assert.equal(filled(l0).length, 0, JSON.stringify(l0));
assert.ok(l0.some((l) => l.msg === "agent ETH below the reserve, no fills until it is topped up"), JSON.stringify(l0));
await test.setBalance({ address: agent.account.address, value: 10n ** 18n });

step("a TSLA buy for A under the plan-based agent's nonce, as the old agent sent it");
const tslaPool = await pub.readContract({ address: UNISWAP_FACTORY, abi: factoryAbi, functionName: "getPool", args: [USDG, ASSETS.TSLA, 500] });
const [sqrtTsla] = await pub.readContract({ address: tslaPool, abi: poolAbi, functionName: "slot0" });
const cfgA = await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [account] });
const legacyIt: FillIntent = {
  agentId, account, installId: cfgA[4], tokenIn: USDG, tokenOut: ASSETS.TSLA, fee: 500, amountIn: 50_000_000n, minOut: 1n,
  refSqrtPriceX96: sqrtTsla, maxDevBps: 50, sqrtPriceLimitX96: 0n, nonce: legacyNonce(account, ASSETS.TSLA, 50_000_000n, day),
  deadline: (await pub.getBlock()).timestamp + 300n,
};
const legacySim = await pub.simulateContract({
  address: router, abi: routerAbi, functionName: "execute", args: [legacyIt, await signIntent(agent.account, router, 4663, legacyIt)], account: agent.account,
});
await pub.waitForTransactionReceipt({ hash: await agentWallet.writeContract(legacySim.request) });
assert.equal((await statsOf(ASSETS.TSLA)).fills, 1);

step("agent run 1 with a cap of 4 fills a day, round robin: A's NVDA, then B's NVDA and TSLA, then the cap");
const l1 = runAgent(config);
const assetsOf = (lines: { msg: string; [k: string]: unknown }[], a: Address) => filled(lines, a).map((l) => l.asset).sort();
assert.deepEqual(assetsOf(l1, account), ["NVDA"], JSON.stringify(l1));
assert.deepEqual(assetsOf(l1, accountB), ["NVDA", "TSLA"], JSON.stringify(l1));
assert.equal(filled(l1).length, 3, JSON.stringify(l1));
assert.ok(l1.some((l) => l.msg === "daily fill cap reached, no more buys today"), JSON.stringify(l1));
for (const f of filled(l1)) console.log(`   ${f.asset} fee ${f.fee}: ${f.usdg} USDG micro, cost ${f.costUsdg} USDG micro`);

step("a new process with the same cap: today's fills are counted from chain, nothing is sent");
const l1b = runAgent(config);
assert.equal(filled(l1b).length, 0, JSON.stringify(l1b));
assert.ok(l1b.some((l) => l.msg === "daily fill cap reached, no more buys today"), JSON.stringify(l1b));

step("agent run 2 with a cap of 300: A buys the rest, B is at its daily limit, C is not funded");
writeConfig(300);
const l2 = runAgent(config);
assert.deepEqual(assetsOf(l2, account), ["WETH", "cbBTC"], JSON.stringify(l2));
assert.equal(filled(l2).length, 2, JSON.stringify(l2));
assert.equal(lastServed(l2), 2, JSON.stringify(l2));
assert.ok(l2.some((l) => l.msg === "daily limit reached" && l.account === accountB), JSON.stringify(l2));
for (const t of ["TSLA", "NVDA", "WETH", "cbBTC"]) assert.equal((await statsOf(ASSETS[t])).fills, 1, t);
assert.equal(await usdgOf(account), parseUnits("800", 6));
assert.equal(await usdgOf(accountB), parseUnits("940", 6));
assert.equal(await pub.readContract({ address: REPUTATION, abi: reputationAbi, functionName: "getLastIndex", args: [agentId, account] }), 8n);
for (const t of ["NVDA", "WETH", "cbBTC"]) {
  const used = await pub.readContract({ address: router, abi: routerAbi, functionName: "nonceUsed", args: [account, buyNonce(account, ASSETS[t], day)] });
  assert.equal(used, true, `nonce for ${t} today`);
}

step("agent run 3 the same day: nothing happens");
const l3 = runAgent(config);
assert.equal(filled(l3).length, 0, JSON.stringify(l3));
assert.equal((await statsOf(ASSETS.TSLA)).fills, 1);

step("a Kernel account with an executor hook, or on another implementation, is never traded");
const cD = cli(env, "create", ...installFlags, "--salt", "4");
assert.equal(cD.code, 0, cD.err);
const accountD = getAddress(JSON.parse(cD.out).account);
await deal(accountD, "100");
const EXECUTOR_SLOT = "0x1bbee3173dbdc223633258c9f337a0fff8115f206d302bea0ed3eac003b68b86";
const hookSlot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [router, EXECUTOR_SLOT]));
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const word = (a: Address) => pad(a, { size: 32 });
assert.equal(await pub.getStorageAt({ address: accountD, slot: hookSlot }), word("0x0000000000000000000000000000000000000001"));
const burner = privateKeyToAccount(generatePrivateKey()).address;
await test.setCode({ address: burner, bytecode: "0x5b600056" }); // loops until out of gas
for (const [slot, value] of [[hookSlot, word(burner)], [IMPL_SLOT, word(ECDSA_VALIDATOR)]] as const) {
  const before = await pub.getStorageAt({ address: accountD, slot });
  await test.setStorageAt({ address: accountD, index: slot, value });
  const lD = runAgent(config);
  assert.equal(filled(lD, accountD).length, 0, JSON.stringify(lD));
  assert.ok(lD.some((l) => l.msg === "account is not a plain Kernel account, skipped today" && l.account === accountD), JSON.stringify(lD));
  await test.setStorageAt({ address: accountD, index: slot, value: before! });
}
const uD = cli(env, "uninstall", accountD);
assert.equal(uD.code, 0, uD.err);

step("an address that is not a Kernel account installs the agent: never traded");
const eoa = keyFile("eoa");
await test.setBalance({ address: eoa.account.address, value: 10n ** 18n });
const eoaWallet = clients(eoa.account).wallet!;
const eoaInit = encodeAbiParameters(
  [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }, { type: "uint16" }, { type: "address[]" }],
  [agentId, 50_000_000n, 200_000_000n, (await pub.getBlock()).timestamp + 86_400n, 200, [ASSETS.WETH]],
);
await pub.waitForTransactionReceipt({ hash: await eoaWallet.writeContract({ address: router, abi: routerAbi, functionName: "onInstall", args: [eoaInit] }) });
await deal(eoa.account.address, "1000");
const lE = runAgent(config);
assert.equal(filled(lE).length, 0, JSON.stringify(lE));
assert.ok(lE.some((l) => l.msg === "account is not a plain Kernel account, skipped today" && l.account === eoa.account.address), JSON.stringify(lE));
await pub.waitForTransactionReceipt({ hash: await eoaWallet.writeContract({ address: router, abi: routerAbi, functionName: "onUninstall", args: ["0x"] }) });

step("B reinstalls with other limits the same day: assets bought today are not bought again");
const ub = cli(env, "uninstall", accountB);
assert.equal(ub.code, 0, ub.err);
const ib = cli(env, "install", accountB, ...installFlags.map((f, k) => (installFlags[k - 1] === "--max-per-trade" ? "20" : installFlags[k - 1] === "--daily-limit" ? "100" : f)));
assert.equal(ib.code, 0, ib.err);
const lB = runAgent(config);
assert.deepEqual(filled(lB, accountB).map((l) => l.asset).sort(), ["WETH", "cbBTC"], JSON.stringify(lB));
assert.equal(filled(lB).length, 2, JSON.stringify(lB));

step("C funded: served; after its expiry: dropped");
await deal(accountC, "300");
const l4 = runAgent(config);
assert.equal(filled(l4, accountC).length, 4, JSON.stringify(l4));
assert.equal(lastServed(l4), 3, JSON.stringify(l4));
await test.increaseTime({ seconds: 1000 });
await test.mine({ blocks: 1 });
await deal(accountC, "300");
const l5 = runAgent(config);
assert.equal(filled(l5).length, 0, JSON.stringify(l5));
assert.equal(lastServed(l5), 2, JSON.stringify(l5));

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
assert.equal(await usdgOf(account), parseUnits("800", 6));

step("cli uninstall stops the agent");
const u = cli(env, "uninstall", account);
assert.equal(u.code, 0, u.err);
assert.equal(await pub.readContract({ address: router, abi: routerAbi, functionName: "isInitialized", args: [account] }), false);
const l6 = runAgent(config);
assert.equal(filled(l6).length, 0, JSON.stringify(l6));
assert.equal(lastServed(l6), 1, JSON.stringify(l6));

step("agent refuses an RPC clock far from the local clock");
const l7 = runAgent(config, { FILLMARK_MAX_CLOCK_SKEW: "60" });
assert.ok(l7.some((l) => l.msg === "tick failed" && String(l.error).includes("away from the local clock")), JSON.stringify(l7));

step("cli install again");
const i = cli(env, "install", account, ...installFlags);
assert.equal(i.code, 0, i.err);
const cfg = await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [account] });
assert.equal(cfg[5], true);
assert.equal(cfg[4], 2n);

step("cli create with a wallet owner: the sending key only pays");
const ext = privateKeyToAccount(generatePrivateKey());
const zeroOwner = cli(env, "create", ...installFlags, "--salt", "1", "--owner", "0x0000000000000000000000000000000000000000");
assert.equal(zeroOwner.code, 1);
assert.match(zeroOwner.err, /must be a wallet/);
const c2 = cli(env, "create", ...installFlags, "--salt", "1", "--owner", ext.address);
assert.equal(c2.code, 0, c2.err);
const created2 = JSON.parse(c2.out);
const account2 = getAddress(created2.account);
assert.equal(created2.owner, ext.address);
assert.equal(created2.paidBy, client.account.address);
await test.request({ method: "anvil_dealERC20" as any, params: [account2, USDG, "0x" + parseUnits("100", 6).toString(16)] as any });
assert.equal(JSON.parse(cli(env, "status", account2).out).owner, ext.address);

step("a wallet-owned withdraw needs --to");
const noTo = cli(env, "withdraw", account2, "USDG", "40");
assert.equal(noTo.code, 1);
assert.match(noTo.err, /give --to/);

step("owner-only command without a signature sends nothing, exits 2 and prints the operation");
const p1 = cli(env, "withdraw", account2, "USDG", "40", "--to", ext.address);
assert.equal(p1.code, 2, p1.err);
const pending = JSON.parse(p1.out);
assert.equal(pending.sent, false);
assert.equal(pending.owner, ext.address);
assert.equal(pending.to, ext.address);
assert.equal(getAddress(pending.userOp.sender), account2);
assert.equal(await usdgOf(account2), parseUnits("100", 6));

step("a signature from another key is refused before sending");
const wrong = await client.account.signMessage({ message: { raw: pending.userOpHash } });
const p2 = cli(env, "withdraw", account2, "USDG", "40", "--to", ext.address, "--signature", wrong);
assert.equal(p2.code, 1);
assert.match(p2.err, /not the owner/);
assert.equal(await usdgOf(account2), parseUnits("100", 6));

step("the owner's personal_sign signature, with v as 0/1, withdraws");
const good = await ext.signMessage({ message: { raw: pending.userOpHash } });
const goodV01 = (good.slice(0, 130) + (parseInt(good.slice(130), 16) - 27).toString(16).padStart(2, "0")) as Hex;
const p3 = cli(env, "withdraw", account2, "USDG", "40", "--to", ext.address, "--signature", goodV01);
assert.equal(p3.code, 0, p3.err);
assert.equal(await usdgOf(account2), parseUnits("60", 6));
assert.equal(await usdgOf(ext.address), parseUnits("40", 6));

step("the same signature cannot be used twice");
const p4 = cli(env, "withdraw", account2, "USDG", "40", "--to", ext.address, "--signature", good);
assert.equal(p4.code, 1);
assert.match(p4.err, /not the owner/);

step("the owner signs uninstall");
const u1 = cli(env, "uninstall", account2);
assert.equal(u1.code, 2, u1.err);
const u2 = cli(env, "uninstall", account2, "--signature", await ext.signMessage({ message: { raw: JSON.parse(u1.out).userOpHash } }));
assert.equal(u2.code, 0, u2.err);
assert.equal(await pub.readContract({ address: router, abi: routerAbi, functionName: "isInitialized", args: [account2] }), false);

step("the owner signs install; the signed run reuses the printed expiry after time moves");
const i1 = cli(env, "install", account2, ...installFlags);
assert.equal(i1.code, 2, i1.err);
const ip = JSON.parse(i1.out);
await test.increaseTime({ seconds: 15 });
await test.mine({ blocks: 1 });
const flagsAt = installFlags.flatMap((f, k) => (f === "--expiry-days" ? ["--expiry", ip.expiry] : installFlags[k - 1] === "--expiry-days" ? [] : [f]));
const i2 = cli(env, "install", account2, ...flagsAt, "--signature", await ext.signMessage({ message: { raw: ip.userOpHash } }));
assert.equal(i2.code, 0, i2.err);
const cfg2 = await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [account2] });
assert.equal(cfg2[5], true);
assert.equal(cfg2[3], BigInt(ip.expiry));

console.log("E2E OK");
