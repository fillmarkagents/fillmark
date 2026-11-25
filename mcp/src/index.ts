#!/usr/bin/env node
// Fillmark MCP server (stdio): read an ERC-8004 agent's Fillmark clients and market, quote
// fills and, when enabled, send them from the agent wallet. Client limits are enforced by the
// router; the SDK's fill policy applies to every send.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ASSETS,
  FillmarkError,
  REASONS,
  accountStatus,
  assetOf,
  errorName,
  fillmarkAgent,
  memoryStore,
  type Quote,
} from "@fillmark/sdk";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import { z } from "zod";
import { fileStore, loadConfig, privateDir, readSecret, takeLock } from "./config.js";

const VERSION = "0.1.0";
const QUOTE_TTL_MS = 60_000;
const RECEIPT_TIMEOUT_MS = 30_000; // under the MCP client's own request timeout

const cfg = loadConfig();
const transport = http(cfg.rpc, { timeout: 30_000 });
const pub = createPublicClient({ chain: robinhood, transport });
let wallet;
if (cfg.fills) {
  const key = readSecret(cfg.keyFile!);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${cfg.keyFile} does not hold a 0x-prefixed 32-byte private key`);
  wallet = createWalletClient({ chain: robinhood, transport, account: privateKeyToAccount(key as Hex) });
  // One sending server per agent and per wallet: two would race the wallet's nonces and the caps.
  privateDir(cfg.stateDir);
  const lockDir = join(homedir(), ".fillmark-mcp", "locks");
  privateDir(lockDir);
  const releases: (() => void)[] = [];
  process.on("exit", () => releases.forEach((r) => r()));
  releases.push(
    takeLock(join(lockDir, `wallet-${wallet.account.address.toLowerCase()}.lock`), `wallet ${wallet.account.address}`),
  );
  releases.push(takeLock(join(cfg.stateDir, `agent-${cfg.agentId}.lock`), `agent ${cfg.agentId}`));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));
}
// Only the sending server keeps state on disk; a read-only server never sends and keeps none.
const store = cfg.fills ? fileStore(cfg.stateDir, cfg.agentId) : memoryStore();
const agent = fillmarkAgent({
  publicClient: pub,
  walletClient: wallet,
  agentId: cfg.agentId,
  store,
  receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
  policy: { maxFillsPerDay: cfg.maxFillsPerDay, minEth: parseEther(cfg.minEth), deadlineSec: QUOTE_TTL_MS / 1000 },
});

const usdg = (v: bigint) => formatUnits(v, 6);
const units = (token: Address, v: bigint) => formatUnits(v, assetOf(token)?.decimals ?? 18);
const price = (v: bigint | undefined) => (v === undefined ? undefined : formatUnits(v, 8));
const bps = (ppm: bigint | undefined) => (ppm === undefined ? undefined : (Number(ppm) / 100).toFixed(2));
const ticker = (token: Address) => assetOf(token)?.ticker ?? token;
const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString();
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an address");

function reply(value: unknown) {
  const text = JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  return { content: [{ type: "text" as const, text }] };
}

/// Every error leaves as a short code and sentence: viem messages can carry the RPC URL.
function guard<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return reply(await fn(args));
    } catch (err) {
      const code = err instanceof FillmarkError ? err.code : errorName(err);
      const message = err instanceof FillmarkError ? err.message : (REASONS[code.replace(/\[.*$/, "")] ?? "The call failed.");
      return { isError: true, content: [{ type: "text" as const, text: `${code}: ${message}` }] };
    }
  };
}

const quotes = new Map<string, { quote: Extract<Quote, { ok: true }>; expires: number }>();

const server = new McpServer({ name: "fillmark", version: VERSION });
const read = { readOnlyHint: true, openWorldHint: true };

server.registerTool(
  "list_clients",
  {
    title: "List client accounts",
    description: "Client accounts that installed this agent on the Fillmark router, with their limits, USDG and allowed assets.",
    annotations: read,
  },
  guard(async () =>
    (await agent.clients()).map((c) => ({
      account: c.account,
      assets: c.assets.map(ticker),
      maxPerTradeUsdg: usdg(c.maxPerTrade),
      dailyLimitUsdg: usdg(c.dailyLimit),
      boughtLast24hUsdg: usdg(c.spent),
      usdg: usdg(c.usdg),
      debtUsdg: usdg(c.debt),
      maxSlipBps: c.maxSlipBps,
      perfFeeBps: c.perfFeeBps,
      regularHoursOnly: c.regularOnly,
      expires: iso(c.expiry),
      canBuy: c.canBuy,
      salesAllowedUntil: iso(c.sellUntil),
      tradable: c.plainKernel,
    })),
  ),
);

server.registerTool(
  "market",
  {
    title: "Market status",
    description: "For each asset: session, Chainlink price, the router pool's price against it, and whether it trades now.",
    inputSchema: {
      assets: z.array(z.string().max(42)).max(40).optional().describe("Tickers such as TSLA or WETH; all assets when empty"),
    },
    annotations: read,
  },
  guard(async ({ assets }: { assets?: string[] }) =>
    (await agent.market(assets?.length ? assets : undefined)).map((m) => ({
      asset: m.ticker ?? m.token,
      session: m.session,
      tradable: m.tradable,
      reason: m.reason && (REASONS[m.reason] ?? m.reason),
      chainlinkPrice: price(m.price),
      priceAgeSec: m.priceAge,
      poolPrice: price(m.spot),
      poolPremiumBps: bps(m.premiumPpm),
      poolCapBps: m.capBps,
    })),
  ),
);

server.registerTool(
  "quote",
  {
    title: "Quote a fill",
    description:
      "Quotes a buy (amount in USDG) or a sale (amount in asset units) for a client account and checks it against the client's limits, the router and the fill policy. Without an amount it quotes the largest size that fits. Returns a quote_id valid for 60 seconds.",
    inputSchema: {
      side: z.enum(["buy", "sell"]),
      account: address,
      asset: z.string().max(42),
      amount: z
        .string()
        .max(40)
        .regex(/^[0-9]+(\.[0-9]+)?$/)
        .optional()
        .describe("USDG for a buy, asset units for a sale; at most the token's decimals"),
    },
    annotations: read,
  },
  guard(async ({ side, account, asset, amount }: { side: "buy" | "sell"; account: string; asset: string; amount?: string }) => {
    const a = assetOf(asset);
    if (!a) throw new FillmarkError("UnknownStock", `Unknown asset ${asset}; known: ${ASSETS.map((x) => x.ticker).join(", ")}.`);
    const places = side === "buy" ? 6 : a.decimals;
    if (amount !== undefined && (amount.split(".")[1] ?? "").length > places)
      throw new FillmarkError("BadAmount", `The amount has more than ${places} decimal places.`);
    const q =
      side === "buy"
        ? await agent.quoteBuy({
            account: account as Address,
            asset: a.ticker,
            usdgIn: amount === undefined ? undefined : parseUnits(amount, 6),
          })
        : await agent.quoteSell({
            account: account as Address,
            asset: a.ticker,
            units: amount === undefined ? undefined : parseUnits(amount, a.decimals),
          });
    if (!q.ok) return { ok: false, reason: q.reason, message: q.message };
    for (const [id, v] of quotes) if (v.expires < Date.now()) quotes.delete(id);
    const id = randomUUID();
    if (cfg.fills) quotes.set(id, { quote: q, expires: Date.now() + QUOTE_TTL_MS });
    const inToken = q.intent.tokenIn;
    const outToken = q.intent.tokenOut;
    return {
      ok: true,
      quote_id: cfg.fills ? id : undefined,
      side: q.side,
      account: q.intent.account,
      asset: a.ticker,
      amountIn: side === "buy" ? usdg(q.intent.amountIn) : units(inToken, q.intent.amountIn),
      expectedOut: side === "buy" ? units(outToken, q.expectedOut) : usdg(q.expectedOut),
      minOut: side === "buy" ? units(outToken, q.minOut) : usdg(q.minOut),
      chainlinkValueUsdg: usdg(q.navValue),
      expectedBpsVsChainlink: bps(q.expectedPpm),
      routerBoundBps: q.boundBps,
      expiresInSec: QUOTE_TTL_MS / 1000,
      note: cfg.fills ? "send it with fill" : "fills are off on this server (read mode)",
    };
  }),
);

if (cfg.fills) {
  server.registerTool(
    "fill",
    {
      title: "Send a quoted fill",
      description:
        "Sends exactly the fill of a quote_id from the agent wallet. Each quote can be sent once, within 60 seconds. A Pending result means the fill was sent and may still land: do not quote that account and asset again until it resolves.",
      inputSchema: { quote_id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ quote_id }: { quote_id: string }) => {
      const hit = quotes.get(quote_id);
      quotes.delete(quote_id);
      if (!hit || hit.expires < Date.now()) throw new FillmarkError("UnknownQuote", "No live quote with that id; quote again.");
      const f = await agent.fill(hit.quote);
      return {
        tx: f.hash,
        side: f.side,
        asset: ticker(f.token),
        usdg: usdg(f.usdg),
        units: units(f.token, f.units),
        fillFeeUsdg: usdg(f.fillFee),
        chainlinkPrice: price(f.nav),
        fillPrice: price(f.fillPrice),
        bpsVsChainlink: bps(f.shortfallPpm),
        costUsdg: usdg(f.costUsdg),
        feedbackRefused: f.feedbackRefused,
      };
    }),
  );

  server.registerTool(
    "settle_fees",
    {
      title: "Settle performance fees",
      description:
        "Asks the router to charge the performance fee this agent has earned from a client account (router settle). Once per account per UTC day; a fee the account cannot pay becomes debt that blocks its buys.",
      inputSchema: { account: address },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guard(async ({ account }: { account: string }) => {
      const acct = getAddress(account.toLowerCase());
      const key = `mcp:settle:${Math.floor(Date.now() / 86_400_000)}:${acct}`;
      if (store.get(key)) throw new FillmarkError("SettledToday", "Fees for this account were already settled today.");
      const st = await accountStatus(pub, acct);
      if (st.permission?.agentId !== cfg.agentId)
        throw new FillmarkError("WrongAgent", "This account's permission is not for this agent.");
      store.set(key, "sending"); // a second call while this one runs is refused
      try {
        const tx = await agent.settleFees(acct);
        store.set(key, tx);
        return { tx };
      } catch (err) {
        // Sent but not confirmed, or reverted, still uses the day's settle; a refusal before sending does not.
        const sent = err instanceof FillmarkError && (err.code === "Pending" || err.code === "RevertedOnChain");
        store.set(key, sent ? (err as FillmarkError).code : undefined);
        throw err;
      }
    }),
  );
}

server.registerTool(
  "record",
  {
    title: "Execution record",
    description:
      "This agent's Fillmark record per client account and asset: fills, volume, total cost against Chainlink and the worst fill.",
    annotations: read,
  },
  guard(async () => {
    const r = await agent.record();
    const per100 = (cost: bigint, notional: bigint) => (notional === 0n ? undefined : usdg((cost * 100_000_000n) / notional));
    return {
      total: {
        fills: r.total.fills,
        volumeUsdg: usdg(r.total.notional),
        costUsdg: usdg(r.total.sumCost),
        costPer100Usdg: per100(r.total.sumCost, r.total.notional),
        worstBps: bps(r.total.worstPpm),
      },
      rows: r.rows.map((x) => ({
        account: x.account,
        asset: ticker(x.token),
        fills: x.fills,
        volumeUsdg: usdg(x.notional),
        costUsdg: usdg(x.sumCost),
        worstBps: bps(x.worst),
      })),
    };
  }),
);

server.registerTool(
  "fees",
  {
    title: "Fees and payments",
    description: "This agent's book with a client account (realized result, fee debt, escrow, lots) and its Fillmark Pay bill.",
    inputSchema: { account: address },
    annotations: read,
  },
  guard(async ({ account }: { account: string }) => {
    const acct = getAddress(account.toLowerCase());
    const [b, due, claimable] = await Promise.all([agent.book(acct), agent.pay.due(acct), agent.claimable()]);
    return {
      book: {
        realizedUsdg: usdg(b.realized),
        perfFeeBps: b.perfFeeBps,
        feeDebtUsdg: usdg(b.debt),
        feesPaidUsdg: usdg(b.paid),
        escrowReadyUsdg: usdg(b.escMatured),
        closing: b.closing,
        lots: b.positions.map((p) => ({ asset: ticker(p.token), units: units(p.token, p.lot.qty), costUsdg: usdg(p.lot.cost) })),
      },
      pay: { dueUsdg: usdg(due.due), payableNowUsdg: usdg(due.payNow), waitingFor: due.wait },
      claimableUsdg: usdg(claimable),
    };
  }),
);

await server.connect(new StdioServerTransport());
console.error(
  `fillmark-mcp ${VERSION}: agent ${cfg.agentId}, ${cfg.fills ? "fills on" : "read mode"}${cfg.rpc ? "" : ", public RPC"}`,
);
