// Drives e2e/run.sh with FILLMARK_E2E_SCRIPT=e2e/keeper.ts: the agent books units clients
// moved, for accounts of any agent. A client of another agent (20% performance fee) moves
// WETH the agent bought out of its account straight from the owner wallet, with no settle:
// the agent settles it at the next tick. Another client removes the router during a crypto
// halt, so its close-out cannot run: the agent waits, then closes the book when prices are
// back. Crypto trades at any hour, so this runs while US stocks are closed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestClient, encodeFunctionData, encodePacked, erc20Abi, getAddress, http, keccak256, parseAbi, parseEventLogs, parseUnits, toHex, zeroHash, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import { GAS_CAP } from "../src/agent.js";
import { routerAbi } from "../src/abi.generated.js";
import { ASSETS, IDENTITY, USDG, clients, identityAbi, kernelAbi } from "../src/chain.js";
import type { FillIntent } from "../src/intent.js";

const rpc = process.env.FILLMARK_RPC!;
const work = process.env.FILLMARK_E2E_DIR!;
const root = process.env.FILLMARK_ROOT!;
const tsx = join(root, "agent/node_modules/.bin/tsx");
const test = createTestClient({ chain: robinhood, mode: "anvil", transport: http(rpc) });
const { pub } = clients();
const WETH = ASSETS.WETH;
const FEEDS_GUARDIAN: Address = "0x534eeE806911FF49529e49A6cb94A5B3A6e9cBc3"; // script/DeployV3.s.sol GUARDIAN
const feedsAbi = parseAbi(["function addCryptoHalt(uint64 start, uint64 end)", "function guardian() view returns (address)"]);

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
  const r = spawnSync(tsx, ["src/agent.ts", "--config", config, "--once"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return (r.stdout + r.stderr).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) as { msg: string; [k: string]: unknown }[];
}

const deployer = keyFile("deployer");
const keeper = keyFile("keeper"); // the reference agent's wallet: it runs the keeper
const other = keyFile("other"); // another agent, whose clients the keeper also serves
const client = keyFile("client");
for (const k of [deployer, keeper, other, client]) await test.setBalance({ address: k.account.address, value: 10n ** 18n });

const deployBlock = (await pub.getBlockNumber()) + 1n;
step("deploy with script/DeployV3.s.sol");
execFileSync(
  "forge",
  ["script", "script/DeployV3.s.sol", "--rpc-url", rpc, "--private-key", deployer.key, "--broadcast", "--slow"],
  { cwd: root, env: { ...process.env, FOUNDRY_PROFILE: "chain", FILLMARK_DEPLOYER: deployer.account.address, FOUNDRY_BROADCAST: join(work, "broadcast") }, stdio: "inherit" },
);
const run = JSON.parse(readFileSync(join(work, "broadcast/DeployV3.s.sol/4663/run-latest.json"), "utf8"));
writeFileSync(join(work, "deployed"), ""); // run.sh starts its block heartbeat after the deploy
const router = getAddress(run.transactions.find((t: any) => t.contractName === "FillmarkRouterV3" && t.transactionType === "CREATE").contractAddress);
const feeds = await pub.readContract({ address: router, abi: routerAbi, functionName: "feeds" });
assert.equal(await pub.readContract({ address: feeds, abi: feedsAbi, functionName: "guardian" }), FEEDS_GUARDIAN);

async function register(k: ReturnType<typeof keyFile>) {
  const reg = await pub.simulateContract({ address: IDENTITY, abi: identityAbi, functionName: "register", args: [""], account: k.account });
  await pub.waitForTransactionReceipt({ hash: await clients(k.account).wallet!.writeContract(reg.request) });
  return reg.result;
}
step("register the reference agent and another agent");
const keeperId = await register(keeper);
const otherId = await register(other);

const env = { FILLMARK_RPC: rpc, FILLMARK_ROUTER: router, FILLMARK_KEY_FILE: client.path };
const wethOf = (a: Address) => pub.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [a] });
const lotOf = async (a: Address) => (await pub.readContract({ address: router, abi: routerAbi, functionName: "positionOf", args: [a, otherId, WETH] }))[0];
const outOf = async (a: Address) => (await pub.readContract({ address: router, abi: routerAbi, functionName: "positionOf", args: [a, otherId, WETH] }))[3];
const owner = clients(client.account).wallet!;

async function account(name: string, salt: string): Promise<Address> {
  const r = cli(env, "create", "--agent-id", String(otherId), "--max-per-trade", "100", "--daily-limit", "500", "--expiry-days", "30",
    "--max-slip-bps", "200", "--perf-fee-bps", "2000", "--assets", "WETH", "--salt", salt);
  assert.equal(r.code, 0, r.err);
  const a = getAddress(JSON.parse(r.out).account);
  await test.request({ method: "anvil_dealERC20" as any, params: [a, USDG, toHex(parseUnits("1000", 6))] as any });
  console.log(`   ${name}: ${a}, agent ${otherId}, 20% performance fee`);
  return a;
}

/// A WETH buy by the other agent: it gives the account a lot in that agent's book.
async function seed(a: Address, usdg: string) {
  const cfg = await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [a] });
  const it: FillIntent = {
    agentId: otherId, account: a, installId: cfg[5], tokenIn: USDG, tokenOut: WETH, amountIn: parseUnits(usdg, 6), minOut: 1n,
    sqrtPriceLimitX96: 0n, nonce: BigInt(keccak256(toHex(`e2e-keeper-${a}`))), deadline: (await pub.getBlock()).timestamp + 300n,
  };
  const { request } = await pub.simulateContract({ address: router, abi: routerAbi, functionName: "execute", args: [it], account: other.account });
  const receipt = await pub.waitForTransactionReceipt({ hash: await clients(other.account).wallet!.writeContract({ ...request, gas: GAS_CAP }) });
  assert.equal(receipt.status, "success", `seed buy for ${a} reverted`);
}

/// The owner wallet calls its account directly, as the app does.
async function ownerCall(a: Address, data: `0x${string}`) {
  const receipt = await pub.waitForTransactionReceipt({ hash: await owner.sendTransaction({ to: a, data, gas: 4_000_000n }) });
  assert.equal(receipt.status, "success");
  return receipt;
}

const settingsFile = join(work, "settings.json");
writeFileSync(settingsFile, JSON.stringify({ settings: [] }));
const config = join(work, "agent.json");
writeFileSync(config, JSON.stringify({ router, agentId: String(keeperId), keyFile: keeper.path, deployBlock: String(deployBlock), settingsFile, settingsStore: join(work, "store.json") }));

step("X: the other agent buys WETH, the client moves it out from the owner wallet with no settle");
const X = await account("X", "21");
await seed(X, "50");
const lot = await lotOf(X);
assert.ok(lot.qty > 0n);
await ownerCall(X, encodeFunctionData({ abi: kernelAbi, functionName: "execute", args: [zeroHash, encodePacked(["address", "uint256", "bytes"], [WETH, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [client.account.address, lot.qty] })])] }));
assert.equal(await wethOf(X), 0n);
assert.equal((await lotOf(X)).qty, lot.qty, "nothing is booked until someone syncs");

step("the reference agent's tick books it at once");
const l1 = runAgent(config);
const b1 = l1.filter((x) => x.msg === "moved units booked");
assert.deepEqual(b1.map((x) => [x.account, x.agentId, x.call]), [[X, String(otherId), "settle"]], JSON.stringify(l1));
assert.equal((await lotOf(X)).qty, 0n);
assert.equal((await outOf(X)).qty, lot.qty);
const r1 = await pub.getTransactionReceipt({ hash: b1[0].tx as `0x${string}` });
assert.equal(getAddress(r1.from), keeper.account.address);
const moved = parseEventLogs({ abi: routerAbi, eventName: "MovedOut", logs: r1.logs });
assert.equal(moved.length, 1);
assert.equal(moved[0].args.qty, lot.qty);
console.log(`   booked ${moved[0].args.qty} units at pnl ${moved[0].args.pnl} in ${b1[0].tx}`);

step("the next tick sends nothing for X");
const l2 = runAgent(config);
assert.equal(l2.filter((x) => x.msg === "moved units booked").length, 0, JSON.stringify(l2));

step("Y: the client removes the router during a crypto halt, so its close-out waits");
const Y = await account("Y", "22");
await seed(Y, "50");
// The live guardian adds the halt (anvil sends for it without its key).
await test.setBalance({ address: FEEDS_GUARDIAN, value: 10n ** 18n });
const now = (await pub.getBlock()).timestamp;
const haltData = encodeFunctionData({ abi: feedsAbi, functionName: "addCryptoHalt", args: [now + 60n, now + 660n] });
const halt = await test.sendUnsignedTransaction({ from: FEEDS_GUARDIAN, to: feeds, data: haltData });
assert.equal((await pub.waitForTransactionReceipt({ hash: halt })).status, "success");
await test.increaseTime({ seconds: 65 });
await test.mine({ blocks: 1 });
await ownerCall(Y, encodeFunctionData({ abi: kernelAbi, functionName: "uninstallModule", args: [2n, router, "0x"] }));
assert.equal((await pub.readContract({ address: router, abi: routerAbi, functionName: "bookOf", args: [Y, otherId] })).closing, true);

step("during the halt the agent waits");
const l3 = runAgent(config);
assert.ok(l3.some((x) => x.msg === "moved units wait for a live price" && x.account === Y && x.call === "closeOut"), JSON.stringify(l3));
assert.equal(l3.filter((x) => x.msg === "moved units booked").length, 0, JSON.stringify(l3));

step("after the halt the agent closes the book");
await test.increaseTime({ seconds: 600 });
await test.mine({ blocks: 1 });
const l4 = runAgent(config);
const b4 = l4.filter((x) => x.msg === "moved units booked");
assert.deepEqual(b4.map((x) => [x.account, x.call]), [[Y, "closeOut"]], JSON.stringify(l4));
assert.equal(await pub.readContract({ address: router, abi: routerAbi, functionName: "openBook", args: [Y] }), 0n);
assert.equal((await pub.readContract({ address: router, abi: routerAbi, functionName: "bookOf", args: [Y, otherId] })).closing, false);

console.log("E2E KEEPER OK");
