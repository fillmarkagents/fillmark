// Plain-JSON views of the record, the shapes api.fillmark.trade serves. Amounts are decimal
// strings with every digit kept, so nothing is rounded on the way.
import type { Address, Hex } from "viem";
import type { Account, Agent, ChainRecord, Feedback, FeedbackFail, Fill, Install } from "./record";

// Maps built once per record, so no answer scans the whole record for each fill or account.
type Lookup = { byAgent: Map<bigint, Fill[]>; byTx: Map<string, Fill[]>; accounts: Map<string, Account>; installs: Map<string, Install>; feedback: Map<string, Feedback[]>; fails: Map<string, FeedbackFail[]> };
const lookups = new WeakMap<ChainRecord, Lookup>();
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};
function lookup(r: ChainRecord): Lookup {
  let l = lookups.get(r);
  if (l) return l;
  l = { byAgent: new Map(), byTx: new Map(), accounts: new Map(), installs: new Map(), feedback: new Map(), fails: new Map() };
  for (const f of r.fills) {
    push(l.byAgent, f.agentId, f);
    push(l.byTx, f.tx.toLowerCase(), f);
  }
  for (const a of r.accounts) if (!l.accounts.has(a.account.toLowerCase())) l.accounts.set(a.account.toLowerCase(), a);
  for (const i of r.installs) if (!l.installs.has(i.account.toLowerCase())) l.installs.set(i.account.toLowerCase(), i);
  for (const x of r.feedback) push(l.feedback, `${x.tx}:${x.hash}:${x.client}`.toLowerCase(), x);
  for (const x of r.feedbackFails) push(l.fails, `${x.tx}:${x.hash}:${x.account}`.toLowerCase(), x);
  lookups.set(r, l);
  return l;
}

export const fmt = (v: bigint, decimals: number): string => {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = decimals ? `.${(abs % base).toString().padStart(decimals, "0")}` : "";
  return `${neg ? "-" : ""}${whole}${frac}`;
};
const usdg = (v: bigint) => fmt(v, 6);
const price = (v: bigint) => fmt(v, 8);

// ---- Totals, as fillmark.trade counts them ----

export type Totals = { fills: number; notional: bigint; cost: bigint; worstBps: number | null };

export function totals(fills: Fill[]): Totals {
  return {
    fills: fills.length,
    notional: fills.reduce((s, f) => s + f.usdg, 0n),
    cost: fills.reduce((s, f) => s + f.cost, 0n),
    worstBps: fills.length ? fills.reduce((m, f) => (f.shortfallBps > m ? f.shortfallBps : m), fills[0].shortfallBps) : null,
  };
}

// Cost per 100 USDG traded (USDG, 6 decimals). A nonzero cost that rounds to 0 keeps the
// smallest unit, so it never reads as exactly at the market price.
export function costPer100(t: Totals): bigint | null {
  if (t.notional === 0n) return null;
  const v = (t.cost * 100_000_000n) / t.notional;
  return v === 0n && t.cost !== 0n ? (t.cost < 0n ? -1n : 1n) : v;
}

// How a client account relates to the agent: the Fillmark team's, the agent owner's or agent
// wallet's, unknown (owner not read), or null (independent). Ownership through other wallets
// cannot be seen on chain.
export type Link = "team" | "owner" | "unknown" | null;
export function linkOf(account: Account | undefined, agent: Agent | undefined): Link {
  if (!account) return "unknown";
  if (account.team) return "team";
  const owner = account.owner?.toLowerCase();
  if (!owner) return "unknown";
  if (!agent) return null;
  if (owner === agent.owner?.toLowerCase() || owner === agent.wallet?.toLowerCase()) return "owner";
  return null;
}

// ---- JSON views ----

const SESSION = ["closed", "extended", "regular"] as const;

export type FillJson = {
  router: Address;
  routerVersion: 1 | 2 | 3;
  tx: Hex;
  logIndex: number;
  block: string;
  time: number | null;
  fillId: Hex;
  agentId: string;
  account: Address;
  asset: { token: Address; ticker: string | null };
  side: "buy" | "sell";
  usdg: string;
  amount: string;
  fillPrice: string;
  marketPrice: string;
  bps: number;
  costUsdg: string;
  fillFeeUsdg: string;
  session: (typeof SESSION)[number];
  clientLimitBps: number | null;
};

export type FeedbackJson = { tag1: string; tag2: string; value: string; valueDecimals: number; client: Address; logIndex: number };

// A fill with the ERC-8004 entries its client account wrote in the same transaction, and any
// entry the registry refused (router v3 keeps the fill and logs it).
export function fillWithFeedback(r: ChainRecord, f: Fill): FillJson & { feedback: FeedbackJson[]; feedbackFailed: string[] } {
  const key = `${f.tx}:${f.fillId}:${f.account}`.toLowerCase();
  const l = lookup(r);
  return {
    ...fillJson(f),
    feedback: (l.feedback.get(key) ?? [])
      .map((x) => ({ tag1: x.tag1, tag2: x.tag2, value: x.value.toString(), valueDecimals: x.valueDecimals, client: x.client, logIndex: x.logIndex })),
    feedbackFailed: (l.fails.get(key) ?? []).map((x) => x.tag1),
  };
}

export function fillJson(f: Fill): FillJson {
  return {
    router: f.router,
    routerVersion: f.version,
    tx: f.tx,
    logIndex: f.logIndex,
    block: f.block.toString(),
    time: f.time,
    fillId: f.fillId,
    agentId: f.agentId.toString(),
    account: f.account,
    asset: { token: f.stock, ticker: f.asset?.ticker ?? null },
    side: f.buy ? "buy" : "sell",
    usdg: usdg(f.usdg),
    amount: fmt(f.amount, f.decimals),
    fillPrice: price(f.price),
    marketPrice: price(f.nav),
    bps: f.shortfallBps,
    costUsdg: usdg(f.cost),
    fillFeeUsdg: usdg(f.fillFee),
    session: SESSION[f.session] ?? "closed",
    clientLimitBps: f.maxSlipBps,
  };
}

const asOf = (r: ChainRecord) => ({ asOfBlock: r.block.toString(), asOfTime: r.time });
const point = (f: Fill | undefined) => (f ? { tx: f.tx, block: f.block.toString(), time: f.time } : null);

function totalsJson(fills: Fill[]) {
  const t = totals(fills);
  const per = costPer100(t);
  const worst = t.worstBps === null ? undefined : fills.find((f) => f.shortfallBps === t.worstBps);
  return {
    fills: t.fills,
    buys: fills.filter((f) => f.buy).length,
    sells: fills.filter((f) => !f.buy).length,
    usdgTraded: usdg(t.notional),
    costUsdg: usdg(t.cost),
    costPer100Usdg: per === null ? null : usdg(per),
    worstFill: worst ? { bps: worst.shortfallBps, tx: worst.tx, logIndex: worst.logIndex, block: worst.block.toString() } : null,
  };
}

// How many fills an agent has.
export const agentFillCount = (r: ChainRecord, agentId: bigint) => lookup(r).byAgent.get(agentId)?.length ?? 0;

// A copy, newest first: callers may reverse it.
const agentFills = (r: ChainRecord, agentId: bigint) => [...(lookup(r).byAgent.get(agentId) ?? [])];

// Every agent the routers have seen, through a permission or a fill, in that order. No ranking.
export function agentsList(r: ChainRecord) {
  return {
    ...asOf(r),
    agents: r.agents.map((a) => {
      const fills = agentFills(r, a.agentId);
      return { agentId: a.agentId.toString(), name: a.name, fills: fills.length, firstFill: point(fills[fills.length - 1]), lastFill: point(fills[0]) };
    }),
  };
}

// One agent's record; null when the routers have never seen it.
export function agentRecord(r: ChainRecord, agentId: bigint, now: number) {
  const agent = r.agents.find((a) => a.agentId === agentId);
  if (!agent) return null;
  const fills = agentFills(r, agentId);
  const groups = new Map<string, Fill[]>();
  for (const f of fills) push(groups, f.stock.toLowerCase(), f);

  // Client accounts that ever named this agent in a permission or traded with it.
  const seen = [...new Set([...r.named.filter((n) => n.agentId === agentId).map((n) => n.account.toLowerCase()), ...fills.map((f) => f.account.toLowerCase())])];
  const counts = { total: seen.length, independent: 0, linkedToAgent: 0, team: 0, unknown: 0, active: 0 };
  for (const lower of seen) {
    const link = linkOf(
      lookup(r).accounts.get(lower),
      agent,
    );
    if (link === "team") counts.team++;
    else if (link === "owner") counts.linkedToAgent++;
    else if (link === "unknown") counts.unknown++;
    else counts.independent++;
    const install = lookup(r).installs.get(lower);
    if (install && install.installed && install.agentId === agentId && install.expiry > now) counts.active++;
  }

  return {
    ...asOf(r),
    agent: { agentId: agent.agentId.toString(), name: agent.name, summary: agent.summary, owner: agent.owner, wallet: agent.wallet },
    totals: totalsJson(fills),
    assets: [...groups.values()]
      .map((g) => ({ token: g[0].stock, ticker: g[0].asset?.ticker ?? null, ...totalsJson(g) }))
      .sort((a, b) => b.fills - a.fills),
    routers: {
      v1: fills.filter((f) => f.version === 1).length,
      v2: fills.filter((f) => f.version === 2).length,
      v3: fills.filter((f) => f.version === 3).length,
    },
    clients: counts,
    firstFill: point(fills[fills.length - 1]),
    lastFill: point(fills[0]),
  };
}

export const PAGE = 100;

// One agent's fills in pages of 100 counted from its first fill, so a page never changes once
// full; only the last page grows. No page given means the last one. Fills are newest first
// within a page. Null when the routers have never seen the agent or the page does not exist.
export function agentFillsPage(r: ChainRecord, agentId: bigint, page: number | null) {
  if (!r.agents.some((a) => a.agentId === agentId)) return null;
  const oldestFirst = agentFills(r, agentId).reverse();
  const pages = Math.max(1, Math.ceil(oldestFirst.length / PAGE));
  const p = page ?? pages;
  if (!Number.isInteger(p) || p < 1 || p > pages) return null;
  const fills = oldestFirst.slice((p - 1) * PAGE, p * PAGE).reverse();
  return { ...asOf(r), agentId: agentId.toString(), page: p, pages, perPage: PAGE, fills: fills.map((f) => fillWithFeedback(r, f)) };
}

// Where each fill sits: one line per fill, "tx agentId page", lowercase tx, for a lookup that
// does not parse the whole record.
export function txIndex(r: ChainRecord): string {
  const lines: string[] = [];
  for (const a of r.agents) {
    agentFills(r, a.agentId)
      .reverse()
      .forEach((f, i) => lines.push(`${f.tx.toLowerCase()} ${a.agentId} ${Math.floor(i / PAGE) + 1}`));
  }
  return lines.length ? `\n${lines.join("\n")}\n` : "\n";
}

// Whether a transaction holds Fillmark fills, with the ERC-8004 entries each fill wrote.
export function fillsInTx(r: ChainRecord, tx: Hex) {
  const lower = tx.toLowerCase();
  const fills = [...(lookup(r).byTx.get(lower) ?? [])].sort((a, b) => a.logIndex - b.logIndex);
  return { ...asOf(r), tx: lower as Hex, fillmark: fills.length > 0, fills: fills.map((f) => fillWithFeedback(r, f)) };
}
