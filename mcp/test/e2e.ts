// Driven by sdk/test/run.sh (FILLMARK_E2E_SCRIPT=../mcp/test/e2e.ts) on an anvil fork: the built
// server runs over stdio under the official MCP client, and every tool is called against the
// live router v3 for a registered test agent and a Kernel account made by the reference CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, parseAbi, parseUnits, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";

const root = process.env.FILLMARK_ROOT!;
const work = process.env.FILLMARK_E2E_DIR!;
// A query parameter on the RPC URL stands in for an API key: no tool output may ever show it.
const SECRET = "k3y-must-not-leak";
const rpc = `${process.env.FILLMARK_RPC!}/?key=${SECRET}`;
const transport = http(rpc, { timeout: 60_000 });
const pub = createPublicClient({ chain: robinhood, transport });
const test = createTestClient({ chain: robinhood, mode: "anvil", transport });
const step = (msg: string) => console.log(`-- ${msg}`);
const beat = setInterval(() => void test.mine({ blocks: 1 }).catch(() => undefined), 1000);

function key(name: string) {
  const k = generatePrivateKey();
  const path = join(work, `${name}.key`);
  writeFileSync(path, k + "\n", { mode: 0o600 });
  return { key: k, path, account: privateKeyToAccount(k) };
}
const agentKey = key("agent");
const clientKey = key("client");
for (const k of [agentKey, clientKey]) await test.setBalance({ address: k.account.address, value: 10n ** 18n });

step("register the test agent and make a client account with the reference CLI");
const identityAbi = parseAbi(["function register(string agentURI) returns (uint256)"]);
const reg = await pub.simulateContract({ address: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", abi: identityAbi, functionName: "register", args: [""], account: agentKey.account });
await pub.waitForTransactionReceipt({ hash: await createWalletClient({ chain: robinhood, transport, account: agentKey.account }).writeContract(reg.request) });
const agentId = reg.result;
const LIST = ["WETH", "cbBTC", "TSLA", "NVDA", "QQQ", "MU", "AMD", "USO", "CRCL", "PLTR"];
const r = spawnSync(join(root, "agent/node_modules/.bin/tsx"), ["src/cli.ts", "create", "--agent-id", String(agentId), "--max-per-trade", "50", "--daily-limit", "300", "--expiry-days", "30", "--max-slip-bps", "200", "--perf-fee-bps", "0", "--assets", LIST.join(",")], {
  cwd: join(root, "agent"),
  env: { ...process.env, FILLMARK_RPC: process.env.FILLMARK_RPC, FILLMARK_ROUTER: "0x6F01e2bE7d1D31E88dF177bEC23392D1905FC8Aa", FILLMARK_KEY_FILE: clientKey.path },
  encoding: "utf8",
});
assert.equal(r.status, 0, r.stderr);
const A1 = getAddress(JSON.parse(r.stdout).account) as Address;
await test.request({ method: "anvil_dealERC20" as any, params: [A1, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", "0x" + parseUnits("300", 6).toString(16)] as any });

const server = join(root, "mcp/dist/index.js");
const stateDir = join(work, "state");
const baseEnv = { PATH: process.env.PATH!, HOME: work, FILLMARK_AGENT_ID: String(agentId), FILLMARK_RPC: rpc, FILLMARK_STATE_DIR: stateDir };
const outputs: string[] = [];
async function connect(env: Record<string, string>) {
  const client = new Client({ name: "fillmark-e2e", version: "0.0.0" });
  const t = new StdioClientTransport({ command: process.execPath, args: [server], env: { ...baseEnv, ...env }, stderr: "pipe" });
  t.stderr?.on("data", (d) => outputs.push(String(d)));
  await client.connect(t);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content[0].text as string;
    outputs.push(text);
    return { error: res.isError === true, text, json: res.isError ? undefined : JSON.parse(text) };
  };
  return { client, call };
}

// A stale wallet lock (no valid pid, as after a crash mid-write) must not block the start.
mkdirSync(join(work, ".fillmark-mcp", "locks"), { recursive: true, mode: 0o700 });
writeFileSync(join(work, ".fillmark-mcp", "locks", `wallet-${agentKey.account.address.toLowerCase()}.lock`), "0\n", { mode: 0o600 });

step("fills on, started first in an empty state dir over a stale lock: seven tools with their hints");
const rw = await connect({ FILLMARK_KEY_FILE: agentKey.path, FILLMARK_ENABLE_FILLS: "1", FILLMARK_MAX_FILLS_PER_DAY: "4" });
const tools = (await rw.client.listTools()).tools;
assert.deepEqual(tools.map((t) => t.name).sort(), ["fees", "fill", "list_clients", "market", "quote", "record", "settle_fees"]);
assert.equal(tools.find((t) => t.name === "fill")!.annotations?.destructiveHint, true);
assert.equal(tools.find((t) => t.name === "market")!.annotations?.readOnlyHint, true);

step("a second sending server for the same wallet is refused, even with another state dir");
const second = spawnSync(process.execPath, [server], { env: { ...baseEnv, FILLMARK_STATE_DIR: join(work, "other"), FILLMARK_KEY_FILE: agentKey.path, FILLMARK_ENABLE_FILLS: "1" }, input: "", encoding: "utf8", timeout: 30_000 });
assert.notEqual(second.status, 0);
assert.match(second.stderr, /another fillmark-mcp/);

step("a read-only server runs beside it and has no send tools");
const ro = await connect({});
const roTools = (await ro.client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(roTools, ["fees", "list_clients", "market", "quote", "record"]);
await ro.client.close();

step("list_clients and market");
const cl = await rw.call("list_clients");
assert.equal(cl.json.length, 1);
assert.equal(cl.json[0].account, A1);
assert.equal(cl.json[0].maxPerTradeUsdg, "50");
const mk = await rw.call("market", { assets: LIST });
const usable = mk.json.filter((m: any) => m.tradable && Math.abs(Number(m.poolPremiumBps)) <= m.poolCapBps - 40).map((m: any) => m.asset);
if (usable.length < 2) throw new Error(`STOP: only ${usable.length} assets inside their pool bounds now; run again later`);
const [X, Y] = usable;
console.log(`   trading ${X} and ${Y}`);

step("quote and fill; a quote is sent once");
const q = await rw.call("quote", { side: "buy", account: A1, asset: X, amount: "15" });
assert.equal(q.json.ok, true, q.text);
const f = await rw.call("fill", { quote_id: q.json.quote_id });
assert.equal(f.error, false, f.text);
assert.equal(f.json.usdg, "15");
assert.equal(f.json.side, "buy");
const again = await rw.call("fill", { quote_id: q.json.quote_id });
assert.equal(again.error, true);
assert.match(again.text, /^UnknownQuote/);

step("refusals come back as reasons");
const big = await rw.call("quote", { side: "buy", account: A1, asset: Y, amount: "60" });
assert.deepEqual([big.json.ok, big.json.reason], [false, "OverTradeLimit"]);
const fine = await rw.call("quote", { side: "buy", account: A1, asset: Y, amount: "15.0000001" });
assert.match(fine.text, /^BadAmount/);
assert.match((await rw.call("market", { assets: ["NOPE"] })).text, /^UnknownStock/);
assert.ok((await rw.call("market", { assets: [] })).json.length >= 28, "an empty list means every asset");
const unknown = await rw.call("quote", { side: "buy", account: A1, asset: "NOPE", amount: "15" });
assert.equal(unknown.error, true);
assert.match(unknown.text, /^UnknownStock/);

step("two fills at once both land");
const [qa, qb] = [await rw.call("quote", { side: "buy", account: A1, asset: Y, amount: "12" }), await rw.call("quote", { side: "buy", account: A1, asset: X, amount: "12" })];
assert.ok(qa.json.ok && qb.json.ok, qa.text + qb.text);
const [fa, fb] = await Promise.all([rw.call("fill", { quote_id: qa.json.quote_id }), rw.call("fill", { quote_id: qb.json.quote_id })]);
assert.ok(!fa.error && !fb.error, fa.text + fb.text);
assert.notEqual(fa.json.tx, fb.json.tx);

step("settle_fees once per account per day");
assert.match((await rw.call("settle_fees", { account: agentKey.account.address })).text, /^WrongAgent/);
const st = await rw.call("settle_fees", { account: A1 });
assert.equal(st.error, false, st.text);
assert.match((await rw.call("settle_fees", { account: A1 })).text, /^SettledToday/);

step("the daily send cap (4, the settle included) holds, and the state file is private");
const q4 = await rw.call("quote", { side: "buy", account: A1, asset: Y, amount: "12" });
assert.equal(q4.json.ok, true, q4.text);
const f4 = await rw.call("fill", { quote_id: q4.json.quote_id });
assert.match(f4.text, /^DailyCap/);
const statePath = join(stateDir, `agent-${agentId}.json`);
assert.equal(statSync(statePath).mode & 0o777, 0o600);
const day = BigInt((await pub.getBlock()).timestamp) / 86_400n;
assert.equal(JSON.parse(readFileSync(statePath, "utf8"))[`0x6F01e2bE7d1D31E88dF177bEC23392D1905FC8Aa:${agentId}:sent:${day}`], "4");

step("record and fees");
const rec = await rw.call("record");
assert.equal(rec.json.total.fills, 3);
assert.equal(rec.json.total.volumeUsdg, "39");
const fees = await rw.call("fees", { account: A1 });
assert.equal(fees.error, false, fees.text);
assert.equal(fees.json.pay.waitingFor, "NotOpen");

await rw.client.close();

step("no output carries the RPC URL");
assert.ok(!outputs.join("\n").includes(SECRET), "the RPC URL leaked");
clearInterval(beat);
console.log("MCP E2E OK");
