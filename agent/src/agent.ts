// Fillmark reference agent: dollar-cost averaging for every client account that installed
// this agent on router v2. Clients and their limits are read from chain: once per UTC
// day, for each asset the client allowed, the agent buys the client's per-trade limit in
// USDG, while the daily limit, the USDG balance (per-trade limit plus the router's fill
// fee) and the router allow it. Stocks trade in the regular session only (unless
// allowExtended), crypto at any hour. Every fee tier is quoted with Uniswap's QuoterV2,
// and the best one the router accepts in simulation is sent. The nonce is derived from
// the account, asset and day, and an intent expires at the end of its day, so a restart,
// a retry or a client changing its limits can never buy the same asset twice in one day.
// The agent only buys, so it never realizes a gain and never charges a performance fee.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { feedsAbi, routerAbi } from "./abi.generated.js";
import {
  FEE_TIERS,
  IDENTITY,
  KERNEL_IMPL,
  SESSIONS,
  ASSETS,
  UNISWAP_FACTORY,
  USDG,
  aggregatorAbi,
  checkedNow,
  clients,
  factoryAbi,
  identityAbi,
  loadKey,
  log,
  poolAbi,
  QUOTER_V2,
  quoterAbi,
  revertName,
} from "./chain.js";
import { signIntent, type FillIntent } from "./intent.js";

export const DAY = 86_400n;
const MIN_NOTIONAL = 10_000_000n; // FillmarkRouter.MIN_NOTIONAL, 10 USDG
const LOG_CHUNK = 5_000_000n;
const RESCAN = 200n; // blocks scanned again each tick, for a lagging node or a reorg
const RETRY_SEC = 900n;
const GAS_CAP = 1_200_000n; // v2 fills use about 0.63M (sale) to 0.85M (first buy of a token) in fork tests
const BATCH = 32_768; // multicall calldata bytes per eth_call
// Solady's ERC1967 proxy, the runtime code of every Kernel account the factory deploys.
const PROXY_CODE: Hex = "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const IMPL_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const NO_HOOK = getAddress("0x0000000000000000000000000000000000000001");
const kernelHookAbi = parseAbi(["function executorConfig(address executor) view returns (address hook)"]);
const nonceAbi = parseAbi(["function nonceUsed(address, uint256) view returns (bool)"]);

const CONFIG_KEYS = new Set([
  "router", "agentId", "keyFile", "deployBlock", "maxFillsPerDay", "minEth", "previousRouter",
  "previousRouterUntilDay", "minPerfFeeBps", "tickSec", "maxDevBps", "minOutBufferBps", "deadlineSec", "allowExtended",
]);

export type Config = {
  router: Address;
  agentId: bigint;
  keyFile: string;
  deployBlock: bigint; // the router's deploy block: where client discovery starts
  maxFillsPerDay: number; // across all clients, so one day's gas is bounded
  minEthWei: bigint; // below this the agent stops sending fills
  previousRouter: Address; // the router clients move from (zero if none)
  previousRouterUntilDay: bigint; // up to this UTC day a buy there counts as that day's buy
  minPerfFeeBps: number; // clients who installed with a lower performance fee are not served
  tickSec: number;
  maxDevBps: number; // pool price may move this much between quote and fill
  minOutBufferBps: number; // minOut sits this far below the simulated output
  deadlineSec: number;
  allowExtended: boolean;
};

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  for (const k of Object.keys(raw)) if (!CONFIG_KEYS.has(k)) throw new Error(`config.${k} is not a known setting`);
  if (!isAddress(raw.router)) throw new Error("config.router is not an address");
  const previous = raw.previousRouter ?? zeroAddress;
  if (!isAddress(previous)) throw new Error("config.previousRouter is not an address");
  const uint = (name: string, def?: string) => {
    const v = String(raw[name] ?? def);
    if (!/^\d+$/.test(v)) throw new Error(`config.${name} must be a non-negative integer`);
    return BigInt(v);
  };
  const int = (name: string, def: number, min: number, max: number) => {
    const v = raw[name] ?? def;
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`config.${name} must be an integer in ${min}..${max}`);
    return v as number;
  };
  return {
    router: getAddress(raw.router),
    agentId: uint("agentId"),
    keyFile: raw.keyFile ?? "/etc/fillmark/agent_key",
    deployBlock: uint("deployBlock"),
    maxFillsPerDay: int("maxFillsPerDay", 300, 1, 10_000),
    minEthWei: parseEther(String(raw.minEth ?? "0.0005")),
    previousRouter: getAddress(previous),
    previousRouterUntilDay: uint("previousRouterUntilDay", "0"),
    minPerfFeeBps: int("minPerfFeeBps", 0, 0, 3000),
    tickSec: int("tickSec", 60, 5, 3600),
    maxDevBps: int("maxDevBps", 50, 1, 1000),
    minOutBufferBps: int("minOutBufferBps", 30, 0, 1000),
    deadlineSec: int("deadlineSec", 300, 30, 3600),
    allowExtended: raw.allowExtended === true,
  };
}

/// The pool price a buy may push the asset to: maxSlipBps above the current spot. The
/// router reverts a fill that would cross it (PartialFill), and the quote stops there,
/// so thin pools are never walked tick by tick. sqrtPriceX96 is token1 per token0.
export function buyLimit(sqrtP: bigint, token: Address, maxSlipBps: number): bigint {
  const factor = sqrt(((10_000n + BigInt(maxSlipBps)) * 10n ** 36n) / 10_000n); // sqrt(1 + slip) * 1e18
  const tokenIsToken0 = BigInt(token) < BigInt(USDG);
  return tokenIsToken0 ? (sqrtP * factor) / 10n ** 18n : (sqrtP * 10n ** 18n) / factor;
}

function sqrt(n: bigint): bigint {
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/// One nonce per account, asset and UTC day. The v1 agent used the same nonce on the v1
/// router, so up to previousRouterUntilDay a buy there also counts as that day's buy and
/// the day a client moves to v2 never buys twice.
export function buyNonce(account: Address, token: Address, day: bigint): bigint {
  const encoded = encodeAbiParameters(
    [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
    ["fillmark-dca-v2", account, token, day],
  );
  return BigInt(keccak256(encoded));
}

type Client = {
  account: Address;
  installId: bigint;
  maxSlipBps: number;
  maxPerTrade: bigint;
  fillFee: bigint; // USDG the router sends to the burner on a buy of maxPerTrade
  dailyLimit: bigint;
  spent: bigint; // spent today, as the router counts it
  balance: bigint; // USDG
};

const TICKER: Record<Address, string> = Object.fromEntries(Object.entries(ASSETS).map(([t, a]) => [a, t]));

export class Agent {
  private readonly pub;
  private readonly wallet;
  private feeds: Address = zeroAddress;
  private chainId = 0;
  private readonly candidates: Address[] = []; // accounts installed for this agent, in install order
  private readonly installedAt = new Map<Address, bigint>(); // latest Installed block seen
  private scanned: bigint;
  private fillDay = -1n;
  private fillFirst = 0n; // first block of fillDay
  private fillScanned = 0n;
  private readonly fillsToday = new Set<string>(); // tx:logIndex of this agent's Filled events today
  private revertedToday = 0; // fills that reverted on chain today (not in the logs)
  private readonly allowed = new Map<Address, { installId: bigint; tokens: Address[] }>();
  private readonly proxies = new Set<Address>(); // accounts whose code is the Kernel proxy
  private readonly done = new Set<string>(); // day:account:token, bought or nonce already used
  private readonly banned = new Set<string>(); // day:account or day:account:token, skipped for the day
  private readonly retryAt = new Map<string, bigint>(); // day:account:token -> time of the next try
  private readonly noted = new Set<string>(); // scope|key of log lines already written
  private scope = { day: "", hour: "" };
  private servedKey = "";

  constructor(
    private readonly cfg: Config,
    private readonly key: PrivateKeyAccount,
  ) {
    const c = clients(key);
    this.pub = c.pub;
    this.wallet = c.wallet!;
    this.scanned = cfg.deployBlock - 1n;
  }

  async init() {
    this.chainId = await this.pub.getChainId();
    if (this.chainId !== 4663) throw new Error(`chain id ${this.chainId}, expected 4663`);
    const wallet = await this.pub.readContract({
      address: IDENTITY,
      abi: identityAbi,
      functionName: "getAgentWallet",
      args: [this.cfg.agentId],
    });
    if (wallet !== this.key.address) throw new Error(`agent ${this.cfg.agentId} wallet is ${wallet}, key is ${this.key.address}`);
    this.feeds = await this.pub.readContract({ address: this.cfg.router, abi: routerAbi, functionName: "feeds" });
    log("info", "agent ready", { agentId: this.cfg.agentId, wallet, router: this.cfg.router, maxFillsPerDay: this.cfg.maxFillsPerDay });
  }

  /// Logs a line at most once per UTC day or hour.
  private once(per: "day" | "hour", key: string, level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
    const k = `${this.scope[per]}|${key}`;
    if (this.noted.has(k)) return;
    this.noted.add(k);
    log(level, msg, fields);
  }

  /// New Installed events for this agent since the last scan, with a small overlap.
  /// Events only find accounts; whether one is served is decided from its on-chain config.
  private async discover() {
    const head = await this.pub.getBlockNumber();
    let from = this.scanned - RESCAN + 1n;
    if (from < this.cfg.deployBlock) from = this.cfg.deployBlock;
    while (from <= head) {
      const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
      const logs = await this.pub.getContractEvents({
        address: this.cfg.router,
        abi: routerAbi,
        eventName: "Installed",
        args: { agentId: this.cfg.agentId },
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
      for (const l of logs) {
        const account = getAddress(l.args.account);
        if (!this.candidates.includes(account)) this.candidates.push(account);
        if ((this.installedAt.get(account) ?? -1n) < l.blockNumber) this.installedAt.set(account, l.blockNumber);
      }
      if (to > this.scanned) this.scanned = to;
      from = to + 1n;
    }
  }

  /// The first block of a UTC day, by binary search on block time.
  private async firstBlockOf(day: bigint, head: bigint): Promise<bigint> {
    const start = day * DAY;
    const time = async (n: bigint) => (await this.pub.getBlock({ blockNumber: n })).timestamp;
    let lo = head > 2_000_000n ? head - 2_000_000n : 0n;
    if (lo < this.cfg.deployBlock || (await time(lo)) >= start) lo = this.cfg.deployBlock;
    let hi = head;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if ((await time(mid)) < start) lo = mid + 1n;
      else hi = mid;
    }
    return lo;
  }

  /// This agent's fills today, read from the router's Filled events, so the daily cap
  /// holds across restarts.
  private async countFills(day: bigint): Promise<number> {
    const head = await this.pub.getBlockNumber();
    if (day !== this.fillDay) {
      this.fillFirst = await this.firstBlockOf(day, head);
      this.fillScanned = this.fillFirst - 1n;
      this.fillDay = day;
      this.fillsToday.clear();
      this.revertedToday = 0;
    }
    let from = this.fillScanned - RESCAN + 1n;
    if (from < this.fillFirst) from = this.fillFirst;
    while (from <= head) {
      const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
      const logs = await this.pub.getContractEvents({
        address: this.cfg.router,
        abi: routerAbi,
        eventName: "Filled",
        args: { agentId: this.cfg.agentId },
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
      for (const l of logs) this.fillsToday.add(`${l.transactionHash}:${l.logIndex}`);
      if (to > this.fillScanned) this.fillScanned = to;
      from = to + 1n;
    }
    return this.fillsToday.size + this.revertedToday;
  }

  /// Accounts open to this agent that can buy today. Accounts no longer installed for it
  /// are dropped: installing again emits a new Installed event.
  private async clients(now: bigint): Promise<Client[]> {
    const { router, agentId } = this.cfg;
    if (this.candidates.length === 0) return [];
    const list = [...this.candidates];
    // The fill fee can change (timelock only), so it is read each tick.
    const fillFeeBps = BigInt(await this.pub.readContract({ address: router, abi: routerAbi, functionName: "fillFeeBps" }));
    const reads = await this.pub.multicall({
      allowFailure: false,
      batchSize: BATCH,
      contracts: list.flatMap((account) => [
        { address: router, abi: routerAbi, functionName: "configs", args: [account] } as const,
        { address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [account] } as const,
        { address: router, abi: routerAbi, functionName: "bookOf", args: [account, agentId] } as const,
      ]),
    });
    const day = now / DAY;
    const served: Client[] = [];
    list.forEach((account, i) => {
      const [id, wallet, maxSlipBps, perfFeeBps, expiry, installId, installed, maxPerTrade, dailyLimit, spentToday, cDay] = reads[3 * i] as readonly [
        bigint, Address, number, number, bigint, bigint, boolean, bigint, bigint, bigint, bigint,
      ];
      const balance = reads[3 * i + 1] as bigint;
      const { debt } = reads[3 * i + 2] as { debt: bigint };
      if (!installed || id !== agentId || wallet !== this.key.address || expiry <= now) {
        // A fresh install may not be visible yet on the node that answered: drop only
        // accounts whose last install is older than the rescanned overlap.
        if ((this.installedAt.get(account) ?? 0n) < this.scanned - RESCAN) {
          this.candidates.splice(this.candidates.indexOf(account), 1);
          this.allowed.delete(account);
          this.installedAt.delete(account);
        }
        return;
      }
      const fillFee = (maxPerTrade * fillFeeBps) / 10_000n;
      if (maxPerTrade < MIN_NOTIONAL || dailyLimit < maxPerTrade || balance < maxPerTrade + fillFee) return;
      if (this.banned.has(`${day}:${account}`)) return;
      if (perfFeeBps < this.cfg.minPerfFeeBps) {
        this.once("day", `perf:${account}`, "info", "installed with a lower performance fee than this agent asks, not served", { account, perfFeeBps });
        return;
      }
      if (debt > 0n) {
        // The router rejects every buy (InDebt) until a sale or the client pays it.
        this.once("day", `debt:${account}`, "info", "account owes this agent fees, no buys", { account, debt });
        return;
      }
      served.push({ account, installId, maxSlipBps, maxPerTrade, fillFee, dailyLimit, spent: cDay === day ? spentToday : 0n, balance });
    });
    const key = served.map((c) => c.account).join(",");
    if (key !== this.servedKey) {
      this.servedKey = key;
      log("info", "clients", { served: served.length, installed: this.candidates.length });
    }
    return served;
  }

  /// The assets a client allowed, read once per install.
  private async allowedTokens(c: Client): Promise<Address[]> {
    const hit = this.allowed.get(c.account);
    if (hit && hit.installId === c.installId) return hit.tokens;
    const all = Object.values(ASSETS);
    const res = await this.pub.multicall({
      allowFailure: false,
      batchSize: BATCH,
      contracts: all.map((t) => ({ address: this.cfg.router, abi: routerAbi, functionName: "isAllowed", args: [c.account, t] }) as const),
    });
    const tokens = all.filter((_, i) => res[i] === true);
    this.allowed.set(c.account, { installId: c.installId, tokens });
    return tokens;
  }

  /// A fill runs the account's executeFromExecutor, so the account decides its gas. Only a
  /// Kernel proxy on the known implementation, with no executor hook, is traded.
  private async isPlainKernel(account: Address): Promise<boolean> {
    if (!this.proxies.has(account)) {
      if ((await this.pub.getCode({ address: account })) !== PROXY_CODE) return false;
      this.proxies.add(account);
    }
    const impl = await this.pub.getStorageAt({ address: account, slot: IMPL_SLOT });
    if (!impl || getAddress(`0x${impl.slice(-40)}`) !== KERNEL_IMPL) return false;
    const hook = await this.pub.readContract({ address: account, abi: kernelHookAbi, functionName: "executorConfig", args: [this.cfg.router] });
    return hook === NO_HOOK;
  }

  async tick() {
    const now = await checkedNow(this.pub);
    const day = now / DAY;
    const hour = now / 3600n;
    this.scope = { day: `d${day}`, hour: `h${hour}` };
    for (const k of this.noted) if (!k.startsWith(`${this.scope.day}|`) && !k.startsWith(`${this.scope.hour}|`)) this.noted.delete(k);
    for (const set of [this.done, this.banned]) for (const k of set) if (!k.startsWith(`${day}:`)) set.delete(k);
    for (const k of this.retryAt.keys()) if (!k.startsWith(`${day}:`)) this.retryAt.delete(k);
    if (!(await this.ethAbove())) return;

    try {
      await this.discover();
    } catch (err) {
      this.once("hour", "discover", "error", "client discovery failed, serving known accounts", { error: revertName(err) });
    }
    const served = await this.clients(now);
    // Round robin: every account's first asset, then every account's second, and so on,
    // so no single account can take the whole daily cap.
    const pairs: { c: Client; token: Address; key: string; rank: number; order: number }[] = [];
    for (const [order, c] of served.entries()) {
      for (const [rank, token] of (await this.allowedTokens(c)).entries()) {
        const key = `${day}:${c.account}:${token}`;
        if (this.done.has(key) || this.banned.has(key) || (this.retryAt.get(key) ?? 0n) > now) continue;
        pairs.push({ c, token, key, rank, order });
      }
    }
    pairs.sort((a, b) => a.rank - b.rank || a.order - b.order);
    if (pairs.length === 0) return;

    // Sessions and feed ages first, so nonces are read only for assets that trade now.
    // Stocks follow the market calendar; crypto is Regular unless halted.
    const tokens = [...new Set(pairs.map((t) => t.token))];
    const sources = await this.pub.multicall({
      batchSize: BATCH,
      contracts: tokens.map((t) => ({ address: this.feeds, abi: feedsAbi, functionName: "sourceOf", args: [t, now] }) as const),
    });
    const feedOf = new Map<Address, { feed: Address; maxAge: number }>();
    const open = tokens.filter((token, i) => {
      const s = sources[i];
      if (s.status !== "success") {
        this.once("hour", `source:${token}`, "warn", "price source unreadable, skipping", { asset: TICKER[token], error: revertName(s.error) });
        return false;
      }
      feedOf.set(token, { feed: s.result.feed, maxAge: s.result.maxAge });
      const session = SESSIONS[s.result.session];
      return session === "Regular" || (session === "Extended" && this.cfg.allowExtended);
    });
    const rounds = await this.pub.multicall({
      batchSize: BATCH,
      contracts: open.map((t) => ({ address: feedOf.get(t)!.feed, abi: aggregatorAbi, functionName: "latestRoundData" }) as const),
    });
    const tradable = new Set<Address>();
    open.forEach((token, i) => {
      const r = rounds[i];
      const src = feedOf.get(token)!;
      if (r.status !== "success") {
        this.once("hour", `feed:${token}`, "warn", "feed unreadable, skipping", { asset: TICKER[token], feed: src.feed, error: revertName(r.error) });
        return;
      }
      const age = now - r.result[3];
      if (age > BigInt(src.maxAge)) {
        this.once("hour", `stale:${token}`, "warn", "feed stale, skipping", { asset: TICKER[token], feed: src.feed, ageSec: age, maxAge: src.maxAge });
        return; // the router would reject every tier as StaleFeed
      }
      tradable.add(token);
    });
    const todo = pairs.filter((t) => tradable.has(t.token));
    if (todo.length === 0) return;

    const previous = this.cfg.previousRouter !== zeroAddress && day <= this.cfg.previousRouterUntilDay;
    const per = previous ? 2 : 1;
    const used = await this.pub.multicall({
      allowFailure: false,
      batchSize: BATCH,
      contracts: todo.flatMap((t) => {
        const nonce = buyNonce(t.c.account, t.token, day);
        const calls = [{ address: this.cfg.router, abi: nonceAbi, functionName: "nonceUsed", args: [t.c.account, nonce] } as const];
        if (previous) calls.push({ address: this.cfg.previousRouter, abi: nonceAbi, functionName: "nonceUsed", args: [t.c.account, nonce] } as const);
        return calls;
      }),
    });
    const pending = todo.filter((t, i) => {
      const bought = used.slice(per * i, per * i + per).some(Boolean);
      if (bought) this.done.add(t.key);
      return !bought;
    });

    if (pending.length === 0) return;
    let fills: number;
    try {
      fills = await this.countFills(day);
    } catch (err) {
      // Without today's count the cap cannot be kept: send nothing this tick.
      this.once("hour", "fills", "error", "could not count today's fills, no buys this tick", { error: revertName(err) });
      return;
    }
    const skipped = new Set<Address>(); // accounts left for the next tick after a failed read or send
    const plain = new Map<Address, boolean>();
    for (const t of pending) {
      const { c } = t;
      if (skipped.has(c.account) || this.banned.has(`${day}:${c.account}`)) continue;
      if (fills >= this.cfg.maxFillsPerDay) {
        this.once("day", "cap", "warn", "daily fill cap reached, no more buys today", { maxFillsPerDay: this.cfg.maxFillsPerDay });
        return;
      }
      if (c.spent + c.maxPerTrade > c.dailyLimit) {
        this.once("day", `limit:${t.key}`, "info", "daily limit reached", { account: c.account, asset: TICKER[t.token] });
        continue;
      }
      if (c.balance < c.maxPerTrade + c.fillFee) {
        this.once("day", `funds:${t.key}`, "info", "not enough USDG for another buy today", { account: c.account, asset: TICKER[t.token] });
        continue;
      }
      try {
        if (!plain.has(c.account)) plain.set(c.account, await this.isPlainKernel(c.account));
        if (!plain.get(c.account)) {
          this.banned.add(`${day}:${c.account}`);
          this.once("day", `kernel:${c.account}`, "warn", "account is not a plain Kernel account, skipped today", { account: c.account });
          continue;
        }
        const at = await checkedNow(this.pub);
        if (at / DAY !== day) return; // a new day: its nonces and limits start on the next tick
        if (!(await this.ethAbove())) return;
        const r = await this.buy(c, t.token, day, at, t.key);
        if (r !== "retry") fills = this.fillsToday.size + this.revertedToday;
        if (r === "filled") {
          this.done.add(t.key);
          c.spent += c.maxPerTrade;
          c.balance -= c.maxPerTrade + c.fillFee;
          continue;
        }
        if (r === "skip") continue;
      } catch (err) {
        this.once("hour", `fail:${t.key}:${revertName(err)}`, "error", "buy failed", { account: c.account, asset: TICKER[t.token], error: revertName(err) });
        skipped.add(c.account); // a read failed or a send may be pending: leave the account for the next tick
        fills++; // a send that threw may still mine: count it until the next tick reads the logs
      }
      this.retryAt.set(t.key, now + RETRY_SEC); // no tier filled: try again later, not every tick
    }
  }

  private async ethAbove(): Promise<boolean> {
    const eth = await this.pub.getBalance({ address: this.key.address });
    if (eth < this.cfg.minEthWei) {
      this.once("hour", "eth", "error", "agent ETH below the reserve, no fills until it is topped up", { eth, minEth: this.cfg.minEthWei });
      return false;
    }
    if (eth < 4n * this.cfg.minEthWei) this.once("hour", "ethlow", "warn", "agent ETH low", { eth });
    return true;
  }

  /// Quotes every fee tier and sends the best one the router accepts. "skip" leaves the
  /// pair for the day; "retry" means no tier fills now.
  private async buy(c: Client, token: Address, day: bigint, now: bigint, key: string): Promise<"filled" | "retry" | "skip"> {
    const { router } = this.cfg;
    const asset = TICKER[token];
    const amountIn = c.maxPerTrade;
    // Quotes come from Uniswap's QuoterV2 and need no signature. An intent is signed only
    // for a tier about to be tried, with that tier's minOut and the day's nonce.
    const quotes: { fee: number; pool: Address; out: bigint }[] = [];
    for (const fee of FEE_TIERS) {
      const pool = await this.pub.readContract({ address: UNISWAP_FACTORY, abi: factoryAbi, functionName: "getPool", args: [USDG, token, fee] });
      if (pool === zeroAddress) continue;
      const [sqrtP] = await this.pub.readContract({ address: pool, abi: poolAbi, functionName: "slot0" });
      try {
        const { result } = await this.pub.simulateContract({
          address: QUOTER_V2,
          abi: quoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: USDG, tokenOut: token, amountIn, fee, sqrtPriceLimitX96: buyLimit(sqrtP, token, c.maxSlipBps) }],
        });
        quotes.push({ fee, pool, out: result[0] });
      } catch (err) {
        this.once("day", `quote:${key}:${fee}:${revertName(err)}`, "info", "no quote", { asset, fee, error: revertName(err) });
      }
    }
    quotes.sort((a, b) => (a.out < b.out ? 1 : a.out > b.out ? -1 : 0));

    // Best quote first; a tier the router rejects (e.g. worse than NAV) falls to the next.
    // All intents carry the day's nonce and expire with the day, so at most one executes,
    // and only on that day.
    const endOfDay = (day + 1n) * DAY - 1n;
    for (const q of quotes) {
      const [sqrtP] = await this.pub.readContract({ address: q.pool, abi: poolAbi, functionName: "slot0" });
      const deadline = now + BigInt(this.cfg.deadlineSec);
      const it: FillIntent = {
        agentId: this.cfg.agentId,
        account: c.account,
        installId: c.installId,
        tokenIn: USDG,
        tokenOut: token,
        fee: q.fee,
        amountIn,
        minOut: (q.out * BigInt(10_000 - this.cfg.minOutBufferBps)) / 10_000n,
        refSqrtPriceX96: sqrtP,
        maxDevBps: this.cfg.maxDevBps,
        sqrtPriceLimitX96: buyLimit(sqrtP, token, c.maxSlipBps),
        nonce: buyNonce(c.account, token, day),
        deadline: deadline < endOfDay ? deadline : endOfDay,
      };
      const sig = await signIntent(this.key, router, this.chainId, it);
      let request;
      try {
        ({ request } = await this.pub.simulateContract({ address: router, abi: routerAbi, functionName: "execute", args: [it, sig], account: this.key }));
      } catch (err) {
        this.once("day", `tier:${key}:${q.fee}:${revertName(err)}`, "info", "fee tier rejected", { account: c.account, asset, fee: q.fee, error: revertName(err) });
        continue;
      }
      const gas = await this.pub.estimateContractGas({ address: router, abi: routerAbi, functionName: "execute", args: [it, sig], account: this.key });
      if (gas > GAS_CAP) {
        this.banned.add(key);
        this.once("day", `gas:${key}`, "warn", "fill needs more gas than the cap, skipped today", { account: c.account, asset, gas, cap: GAS_CAP });
        return "skip";
      }
      const hash = await this.wallet.writeContract({ ...request, gas: GAS_CAP });
      const receipt = await this.pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        // It passed simulation and failed on chain: the account is not traded again today.
        this.banned.add(`${day}:${c.account}`);
        this.done.add(key);
        this.revertedToday++; // counts toward the daily cap: it cost gas
        log("error", "fill reverted on chain, account skipped today", { account: c.account, asset, tx: hash, gasUsed: receipt.gasUsed });
        return "skip";
      }
      const [filled] = parseEventLogs({
        abi: routerAbi,
        eventName: "Filled",
        logs: receipt.logs.filter((l) => getAddress(l.address) === router),
      });
      this.fillsToday.add(`${hash}:${filled.logIndex}`);
      log("info", "filled", {
        account: c.account,
        asset,
        fee: it.fee,
        usdg: filled.args.fill.usdgAmount,
        fillFee: filled.args.fill.fillFee,
        assetAmount: filled.args.fill.stockAmount,
        nav: filled.args.prices.nav,
        fillPrice: filled.args.prices.fill,
        costUsdg: filled.args.prices.cost,
        tx: hash,
      });
      return "filled";
    }
    this.once("day", `nofill:${key}`, "warn", "no fee tier can fill", { account: c.account, asset, quotes: quotes.length });
    return "retry";
  }
}

async function main() {
  const { values } = parseArgs({
    options: { config: { type: "string", default: "/etc/fillmark/agent.json" }, once: { type: "boolean", default: false } },
  });
  const cfg = loadConfig(values.config!);
  const agent = new Agent(cfg, loadKey(cfg.keyFile));
  await agent.init();
  let stop = false;
  process.on("SIGTERM", () => (stop = true));
  process.on("SIGINT", () => (stop = true));
  do {
    await agent.tick().catch((err) => log("error", "tick failed", { error: revertName(err) }));
    if (values.once) break;
    for (let i = 0; i < cfg.tickSec && !stop; i++) await new Promise((r) => setTimeout(r, 1000));
  } while (!stop);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    log("error", "agent stopped", { error: revertName(err) });
    process.exit(1);
  });
}
