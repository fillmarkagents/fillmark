// The Fillmark record from router logs: fills, permissions, agent fees and the ERC-8004 entries
// client accounts wrote. Building it is pure, so anyone who feeds the same logs and reads gets
// the same record (see load.ts for reading them from chain).
import { decodeEventLog, getAddress, parseAbi, toEventSelector, type Abi, type Address, type Hex } from "viem";
import { REPUTATION, ROUTER_V1, ROUTER_V2, ROUTER_V3, TEAM_WALLETS, assetOf, versionOf, type Asset } from "./config";
import { routerV1Abi } from "./routerV1Abi";
import { routerV2Abi } from "./routerV2Abi";
import { routerV3Abi } from "./routerV3Abi";

export const reputationAbi = parseAbi([
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);

const ROUTER_EVENTS = ["Filled", "Installed", "Uninstalled", "Settled", "ClosedOut", "DebtPaid", "FeedbackFailed"] as const;
type RouterEvent = (typeof ROUTER_EVENTS)[number];

const abiOf = (router: Address): Abi => {
  const v = versionOf(router);
  return (v === 3 ? routerV3Abi : v === 2 ? routerV2Abi : routerV1Abi) as Abi;
};

// The event selectors read from each router (an event a router does not have is left out).
const topicsOf = new Map<string, Hex[]>();
export function routerTopics(router: Address): Hex[] {
  const key = router.toLowerCase();
  let topics = topicsOf.get(key);
  if (!topics) {
    topics = (abiOf(router) as readonly { type: string; name?: string }[])
      .filter((x) => x.type === "event" && ROUTER_EVENTS.includes(x.name as RouterEvent))
      .map((x) => toEventSelector(x as Parameters<typeof toEventSelector>[0]));
    topicsOf.set(key, topics);
  }
  return [...topics];
}
export const NEW_FEEDBACK = toEventSelector(reputationAbi[0]);

// A log as eth_getLogs returns it, numbers already parsed.
export type RawLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: bigint; logIndex: number; transactionHash: Hex };

export type Fill = {
  router: Address;
  version: 1 | 2 | 3;
  fillId: Hex;
  tx: Hex;
  block: bigint;
  logIndex: number;
  time: number | null; // block time, null when it was not read
  account: Address;
  agentId: bigint;
  asset: Asset | undefined;
  stock: Address;
  decimals: number;
  buy: boolean;
  usdg: bigint; // 6 decimals
  amount: bigint; // stock units
  fillFee: bigint; // USDG 6 decimals sent to the burner, outside usdg and cost; 0 on router v1
  cost: bigint; // USDG 6 decimals, positive = worse for the client than the reference price
  shortfallBps: number; // fill price vs reference price, positive = worse
  nav: bigint; // reference price, USDG per whole token, 8 decimals
  navUpdatedAt: number; // when Chainlink last updated that price (the round's updatedAt)
  price: bigint; // fill price, same units
  maxSlipBps: number | null; // the client's slippage limit in force at the fill
  session: number; // 0 closed, 1 extended, 2 regular
};

export type Install = { router: Address; account: Address; agentId: bigint; installed: boolean; expiry: number; maxSlipBps: number; block: bigint };
export type Named = { router: Address; account: Address; agentId: bigint; block: bigint };
export type AgentFee = { account: Address; agentId: bigint; fee: bigint; block: bigint; tx: Hex };
export type Payment = { router: Address; account: Address; agentId: bigint; kind: "settled" | "closed" | "debt"; fee: bigint; paid: bigint; debt: bigint; block: bigint; tx: Hex };
export type Account = { account: Address; owner: Address | null; team: boolean };
export type Agent = { agentId: bigint; name: string | null; summary: string | null; owner: Address | null; wallet: Address | null };
// An ERC-8004 entry a client account wrote about an agent, as the Reputation Registry logged it.
export type Feedback = { agentId: bigint; client: Address; tag1: string; tag2: string; value: bigint; valueDecimals: number; hash: Hex; tx: Hex; block: bigint; logIndex: number };
// An entry the registry refused during a fill (router v3): the fill stood, the entry is missing.
export type FeedbackFail = { account: Address; agentId: bigint; hash: Hex; tag1: string; tx: Hex; block: bigint };

export type ChainRecord = {
  fills: Fill[]; // newest first
  installs: Install[]; // each account's permission now: the newest router installed, else the latest
  named: Named[]; // every Installed event on any router, oldest first
  agentFees: AgentFee[];
  payments: Payment[];
  created: Record<Address, Hex>; // account -> transaction of its first Installed event
  accounts: Account[];
  agents: Agent[]; // in the order the routers first saw them
  feedback: Feedback[];
  feedbackFails: FeedbackFail[];
  block: bigint;
  time: number | null;
};

// What building the record needs besides the logs: reads that are not logs.
export type Reads = {
  block: bigint; // the record covers logs up to and including this block
  times: Map<bigint, number>; // block -> unix time, for any block known
  owners: Map<string, Address | null>; // lowercased account -> owner from the ECDSA validator
  standard: Map<string, boolean>; // lowercased account -> made the standard way (read for team-owned accounts)
  agents: Map<bigint, Agent>;
};

export type Decoded = { router: Address; name: RouterEvent; blockNumber: bigint; logIndex: number; transactionHash: Hex; args: Record<string, unknown> };
const byOrder = (a: { blockNumber: bigint; logIndex: number }, b: { blockNumber: bigint; logIndex: number }) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1;

// Router logs decoded with each router's own ABI; logs of other contracts or events are skipped.
export function decodeRouterLogs(logs: RawLog[]): Decoded[] {
  const out: Decoded[] = [];
  for (const l of logs) {
    let router: Address;
    try {
      router = getAddress(l.address);
      versionOf(router);
    } catch {
      continue;
    }
    if (!routerTopics(router).includes(l.topics[0])) continue;
    const ev = decodeEventLog({ abi: abiOf(router), data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    out.push({ router, name: ev.eventName as unknown as RouterEvent, blockNumber: l.blockNumber, logIndex: l.logIndex, transactionHash: l.transactionHash, args: ev.args as unknown as Record<string, unknown> });
  }
  return out;
}

// NewFeedback logs from the Reputation Registry, decoded.
export function decodeFeedback(logs: RawLog[]): Feedback[] {
  return logs
    .filter((l) => l.address.toLowerCase() === REPUTATION.toLowerCase() && l.topics[0] === NEW_FEEDBACK)
    .map((l) => {
      const a = decodeEventLog({ abi: reputationAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }).args;
      return {
        agentId: a.agentId,
        client: getAddress(a.clientAddress),
        tag1: a.tag1,
        tag2: a.tag2,
        value: a.value,
        valueDecimals: Number(a.valueDecimals),
        hash: a.feedbackHash,
        tx: l.transactionHash,
        block: l.blockNumber,
        logIndex: l.logIndex,
      };
    });
}

// The ERC-8004 entries a router wrote for its fills: in the fill's transaction, with the fill
// id as feedbackHash, from the fill's client account, with the tag and the value the router
// writes (cost and USDG size, "-ext" in the extended session) for the fill's agent, tag2 the
// stock ticker and size bucket, the first of each tag. Anyone
// may write to the registry, so every other entry is left out. Returns "tx:logIndex" keys.
// Raise when fillFeedbackKeys or bucketOf changes what is kept: stored indexes then read again.
export const FEEDBACK_FILTER = 1;
export function fillFeedbackKeys(logs: Decoded[], feedback: Feedback[]): Set<string> {
  // tx:fillId:client -> the fill's agent, its tag2, and tag1 -> value
  const want = new Map<string, { agentId: bigint; tag2: (t: string) => boolean; values: Map<string, bigint> }>();
  for (const l of logs) {
    if (l.name !== "Filled") continue;
    const { fill, prices } = l.args as { fill: { stock: Address; usdgAmount: bigint; session: number }; prices: { cost: bigint } };
    const ext = Number(fill.session) === 1 ? "-ext" : "";
    // The router's tag2 is the feed's ticker for the stock and the size bucket (bucketOf).
    const bucket = `:B${bucketOf(fill.usdgAmount)}`;
    const ticker = assetOf(fill.stock)?.ticker;
    want.set(`${l.transactionHash.toLowerCase()}:${(l.args.fillId as Hex).toLowerCase()}:${(l.args.account as Address).toLowerCase()}`, {
      agentId: l.args.agentId as bigint,
      tag2: (t) => (ticker ? t === `${ticker}${bucket}` : t.endsWith(bucket)),
      values: new Map([
        [`fillmark-cost${ext}`, prices.cost],
        [`fillmark-notional${ext}`, fill.usdgAmount],
      ]),
    });
  }
  const kept = new Set<string>();
  const taken = new Set<string>();
  for (const x of [...feedback].sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1))) {
    const key = `${x.tx.toLowerCase()}:${x.hash.toLowerCase()}:${x.client.toLowerCase()}`;
    const w = want.get(key);
    if (!w || w.agentId !== x.agentId || !w.tag2(x.tag2) || w.values.get(x.tag1) !== x.value || x.valueDecimals !== 6 || taken.has(`${key}:${x.tag1}`)) continue;
    taken.add(`${key}:${x.tag1}`);
    kept.add(`${x.tx.toLowerCase()}:${x.logIndex}`);
  }
  return kept;
}

// The size bucket the routers put in tag2 (the same in v1, v2 and v3).
export function bucketOf(usdg: bigint): number {
  const limits = [10_000_000n, 30_000_000n, 100_000_000n, 300_000_000n, 1_000_000_000n, 3_000_000_000n, 10_000_000_000n];
  const i = limits.findIndex((x) => usdg < x);
  return i === -1 ? 7 : i;
}

// Accounts and agents the reads must cover before buildRecord: every client account in the
// logs, the team-owned ones with the transaction that created them, and every agent id.
export function needs(logs: Decoded[]): { accounts: Address[]; created: Record<Address, Hex>; agentIds: bigint[] } {
  const accounts = new Set<Address>();
  const created: Record<Address, Hex> = {};
  const agentIds: bigint[] = [];
  const seen = new Set<bigint>();
  const relevant = logs.filter((l) => l.name === "Filled" || l.name === "Installed" || l.name === "Uninstalled").sort(byOrder);
  for (const l of relevant) {
    const account = getAddress(l.args.account as Address);
    if (l.name !== "Uninstalled") accounts.add(account);
    if (l.name === "Installed" && !created[account]) created[account] = l.transactionHash;
    if (l.name !== "Uninstalled") {
      const id = l.args.agentId as bigint;
      if (!seen.has(id)) {
        seen.add(id);
        agentIds.push(id);
      }
    }
  }
  return { accounts: [...accounts], created, agentIds };
}

const team = new Set(TEAM_WALLETS.map((a) => a.toLowerCase()));

// The record from decoded router logs, the feedback logs and the reads. Every number comes from
// the logs; the reads only add owners, agent identities and block times.
export function buildRecord(logs: Decoded[], feedbackLogs: Feedback[], r: Reads): ChainRecord {
  const inRange = logs.filter((l) => l.blockNumber <= r.block);
  const of = (name: RouterEvent) => inRange.filter((l) => l.name === name);
  const filled = of("Filled");
  const installed = of("Installed").sort(byOrder);
  const uninstalled = of("Uninstalled");

  // The slippage limit in force at a fill is the one from the account's last install on the
  // same router before it.
  const installsOf = new Map<string, Decoded[]>();
  for (const l of installed) {
    const key = `${l.router}:${l.args.account as Address}`.toLowerCase();
    const list = installsOf.get(key);
    if (list) list.push(l);
    else installsOf.set(key, [l]);
  }
  const slipAt = (router: Address, account: Address, at: bigint): number | null => {
    let slip: number | null = null;
    for (const l of installsOf.get(`${router}:${account}`.toLowerCase()) ?? []) if (l.blockNumber <= at) slip = Number(l.args.maxSlipBps);
    return slip;
  };

  const fills: Fill[] = filled
    .map((l) => {
      const { fill, prices } = l.args as {
        fill: { stock: Address; buy: boolean; usdgAmount: bigint; stockAmount: bigint; fillFee?: bigint; stockDecimals: number; updatedAt: bigint; session: number };
        prices: { cost: bigint; nav: bigint; fill: bigint; shortfall: bigint };
      };
      return {
        router: l.router,
        version: versionOf(l.router),
        fillId: l.args.fillId as Hex,
        tx: l.transactionHash,
        block: l.blockNumber,
        logIndex: l.logIndex,
        time: r.times.get(l.blockNumber) ?? null,
        account: getAddress(l.args.account as Address),
        agentId: l.args.agentId as bigint,
        stock: fill.stock,
        asset: assetOf(fill.stock),
        decimals: Number(fill.stockDecimals),
        buy: fill.buy,
        usdg: fill.usdgAmount,
        amount: fill.stockAmount,
        fillFee: fill.fillFee ?? 0n,
        cost: prices.cost,
        shortfallBps: Number(prices.shortfall) / 100,
        nav: prices.nav,
        navUpdatedAt: Number(fill.updatedAt),
        price: prices.fill,
        maxSlipBps: slipAt(l.router, l.args.account as Address, l.blockNumber),
        session: Number(fill.session),
      };
    })
    .sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1));

  // The latest event per account and router decides whether that router is installed there.
  // An account's permission now is the newest router installed there, else whichever changed last.
  const latest = new Map<string, Install>();
  const ordered = [...installed.map((l) => ({ l, on: true })), ...uninstalled.map((l) => ({ l, on: false }))].sort((a, b) => byOrder(a.l, b.l));
  for (const { l, on } of ordered) {
    const account = getAddress(l.args.account as Address);
    const key = `${l.router}:${account}`;
    const prev = latest.get(key);
    if (on) {
      const a = l.args as { agentId: bigint; expiry: bigint; maxSlipBps: number };
      latest.set(key, { router: l.router, account, agentId: a.agentId, installed: true, expiry: Number(a.expiry), maxSlipBps: Number(a.maxSlipBps), block: l.blockNumber });
    } else if (prev) {
      latest.set(key, { ...prev, installed: false, block: l.blockNumber });
    }
  }
  const perAccount = new Map<Address, Install>();
  const rank = (i: Install) => (i.installed ? (i.router === ROUTER_V3 ? 3 : i.router === ROUTER_V2 ? 2 : 1) : 0);
  for (const i of latest.values()) {
    const prev = perAccount.get(i.account);
    if (!prev || rank(i) > rank(prev) || (rank(i) === rank(prev) && i.block > prev.block)) perAccount.set(i.account, i);
  }
  const installs = [...perAccount.values()];
  const named: Named[] = ordered
    .filter((o) => o.on)
    .map(({ l }) => ({ router: l.router, account: getAddress(l.args.account as Address), agentId: (l.args as { agentId: bigint }).agentId, block: l.blockNumber }));

  const feeRouters = (l: Decoded) => l.router === ROUTER_V2 || l.router === ROUTER_V3;
  const agentFees: AgentFee[] = [...of("Settled"), ...of("ClosedOut")]
    .filter(feeRouters)
    .sort(byOrder)
    .map((l) => ({ account: getAddress(l.args.account as Address), agentId: l.args.agentId as bigint, fee: l.args.fee as bigint, block: l.blockNumber, tx: l.transactionHash }))
    .filter((f) => f.fee > 0n);

  const kindOf: Partial<Record<RouterEvent, Payment["kind"]>> = { Settled: "settled", ClosedOut: "closed", DebtPaid: "debt" };
  // Same order as the website: settled, then closed, then debt payments, each by chain order.
  const payments: Payment[] = (["Settled", "ClosedOut", "DebtPaid"] as const)
    .flatMap((name) => of(name).filter(feeRouters).map((l) => ({ l, kind: kindOf[name]! })))
    .sort((a, b) => byOrder(a.l, b.l))
    .map(({ l, kind }) => {
      const a = l.args as { account: Address; agentId: bigint; fee?: bigint; paid?: bigint; amount?: bigint; debt: bigint };
      return { router: l.router, account: getAddress(a.account), agentId: a.agentId, kind, fee: a.fee ?? 0n, paid: kind === "debt" ? (a.amount ?? 0n) : (a.paid ?? 0n), debt: a.debt, block: l.blockNumber, tx: l.transactionHash };
    })
    .filter((p) => p.fee > 0n || p.paid > 0n);

  const created: Record<Address, Hex> = {};
  for (const { l, on } of ordered) {
    const account = getAddress(l.args.account as Address);
    if (on && !created[account]) created[account] = l.transactionHash;
  }

  const accountSet = [...new Set([...installs.map((i) => i.account), ...fills.map((f) => f.account)])];
  const accounts: Account[] = accountSet.map((account) => {
    const key = account.toLowerCase();
    // An owner not read yet counts as unknown, never as an outside client.
    const owner = r.owners.get(key) ?? null;
    // Any contract can name a team wallet as its owner, so the team label also needs the account
    // to be one the factory created with the standard Fillmark setup. Until that is checked the
    // owner counts as unknown too.
    const named = owner !== null && team.has(owner.toLowerCase());
    if (named && created[account] && !r.standard.has(key)) return { account, owner: null, team: false };
    return { account, owner, team: named && !!created[account] && r.standard.get(key) === true };
  });

  // Agents in the order the router first saw them, through a permission or a fill.
  const firstSeen = new Map<bigint, bigint>();
  for (const e of [...named, ...fills].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))) {
    if (!firstSeen.has(e.agentId)) firstSeen.set(e.agentId, e.block);
  }
  const agents = [...firstSeen.keys()].map((id) => r.agents.get(id) ?? { agentId: id, name: null, summary: null, owner: null, wallet: null });

  // Only the entries the router wrote for fills in this record (see fillFeedbackKeys).
  const keep = fillFeedbackKeys(inRange, feedbackLogs);
  const feedback = feedbackLogs
    .filter((x) => x.block <= r.block && keep.has(`${x.tx.toLowerCase()}:${x.logIndex}`))
    .sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const feedbackFails: FeedbackFail[] = of("FeedbackFailed").filter((l) => l.router === ROUTER_V3).map((l) => ({
    account: getAddress(l.args.account as Address),
    agentId: l.args.agentId as bigint,
    hash: l.args.fillId as Hex,
    tag1: l.args.tag as string,
    tx: l.transactionHash,
    block: l.blockNumber,
  }));

  return { fills, installs, named, agentFees, payments, created, accounts, agents, feedback, feedbackFails, block: r.block, time: r.times.get(r.block) ?? null };
}

export { ROUTER_V1, ROUTER_V2, ROUTER_V3 };
