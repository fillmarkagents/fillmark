// Fillmark reference agent for every client account that installed this agent on router v3.
// Clients and their limits are read from chain. Each account follows the strategy its owner
// chose in a signed setting (settings.ts): "dca" or "rebalance" (rebalance.ts). An account with
// no setting in effect gets dca exactly as agent 0.5.0 ran it. Under dca, each UTC day, for each
// asset the client allowed:
// - when the Chainlink price is at least takeProfitBps above the average cost of the units
//   this agent bought for the account (the router's lot), the agent sells, again and again
//   that day, each sale about the client's per-trade limit, until the lot is sold. Sales do
//   not use the daily limit (router v3 counts buys only). It never sells more than the lot, and never receives less,
//   after the fill fee, than the cost of the units sold. That day it does not buy the asset;
//   it buys instead only when not even one sale fits between the router's 10 USDG minimum
//   and the per-trade limit;
// - otherwise it buys once: the client's per-trade limit in USDG, or less so that the buy and
//   its fill fee fit what is left of the router's rolling 24-hour limit (windowSpent), and at
//   least the router's 10 USDG minimum, while the USDG balance and the router allow it.
// After a day with a sale of an asset it buys none of it for the router's hold in whole days
// (7): a buy within the hold would take the sale's waiting gain off the units' cost.
// Stocks trade in the regular session only (unless allowExtended and the client did not ask
// for regular hours only), crypto at any hour. Router v3 trades each token in one official
// pool and bounds its price itself; the agent quotes that pool with Uniswap's QuoterV2,
// simulates, and sends the fill from its own wallet (v3 takes no signature). After expiry the
// router allows sales for 7 more days, so the agent still takes profit then, and buys nothing.
// Nonces come from the account, asset and day (and the sale's number),
// and an intent expires at the end of its day, so a restart, a retry or a client changing
// its limits can never buy an asset twice in one day or repeat a sale.
// Rebalance: the account's allowed assets and its USDG are valued at the router's prices and
// brought back to the client's target weights when one drifts past the threshold or on the
// schedule: sales of the agent's own units first, then buys within the daily limit.
// Fillmark Pay: with payRateBps set, the agent keeps those terms on the Pay contract. Before a
// fill it tracks the token in the client's open agreement, and once a UTC day it settles what
// is due, only at a price near the median it saw over the last hour. With payRequired, once
// the burner has its token, it buys only for accounts whose open agreement can pay what is
// due and what the buy adds; sales of what it bought go on either way.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { burnerAbi, feedsAbi, payAbi, ponsHookAbi, routerAbi } from "./abi.generated.js";
import {
  ECDSA_VALIDATOR,
  IDENTITY,
  KERNEL_IMPL,
  SESSIONS,
  ASSETS,
  PAY,
  USDG,
  aggregatorAbi,
  checkedNow,
  clients,
  identityAbi,
  loadKey,
  log,
  poolAbi,
  QUOTER_V2,
  quoterAbi,
  revertName,
} from "./chain.js";
import type { FillIntent } from "./intent.js";
import { WAITS, median, minReceivedPerUsdg, tokenPerUsdg, type PayState, type Terms } from "./pay.js";
import { BPS, planRebalance, scheduleOpen } from "./rebalance.js";
import { Keeper } from "./keeper.js";
import { ROOT_ECDSA, SettingsBook, StoreError, effectiveDay, kernelRootAbi, validatorAbi, withFingerprint, type Mode, type Setting } from "./settings.js";

export const DAY = 86_400n;
const MIN_NOTIONAL = 10_000_000n; // FillmarkRouter.MIN_NOTIONAL, 10 USDG
const LOG_CHUNK = 5_000_000n;
const RESCAN = 200n; // blocks scanned again each tick, for a lagging node or a reorg
const RETRY_SEC = 900n;
const FEED_MARGIN_BPS = 50; // room left in a sale's size for a Chainlink update before it lands
// v3 fills use about 0.70M (sale) to 0.92M (first buy of a token) in fork tests. A fill is sent
// with this fixed limit, never the bare estimate: its gas changes with the block time, and one
// second later the estimate can leave too little for the feedback call (LowGas).
export const GAS_CAP = 1_500_000n;
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
  "takeProfitBps", "payRateBps", "payMinZeroAtBps", "payRequired", "paySlipBps", "paySamples", "payMinUsdg",
  "settingsUrl", "settingsFile", "settingsStore", "maxRebalanceTradesPerDay",
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
  maxDevBps: number; // room for the pool to move between quote and fill when a sale is sized
  minOutBufferBps: number; // minOut sits this far below the simulated output
  deadlineSec: number;
  allowExtended: boolean;
  takeProfitBps: number; // sell when the price is this far above the lot's average cost
  payRateBps: number | null; // Fillmark Pay terms kept on chain (null: leave them as they are)
  payMinZeroAtBps: number;
  payRequired: boolean; // buy only for accounts with an open Fillmark Pay agreement
  paySlipBps: number; // a settle takes at least the hour's median price less this
  paySamples: number; // pool prices seen in the last hour before a settle
  payMinUsdg: bigint; // no settle for less: below it the gas costs more than the pay
  settingsUrl: string; // where clients' signed settings are read
  settingsFile: string | null; // read settings from this file instead (fork tests, self-hosting)
  settingsStore: string; // every setting seen, kept on disk
  maxRebalanceTradesPerDay: number; // per account
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
  const bool = (name: string) => {
    const v = raw[name] ?? false;
    if (typeof v !== "boolean") throw new Error(`config.${name} must be true or false`);
    return v;
  };
  const int = (name: string, def: number, min: number, max: number) => {
    const v = raw[name] ?? def;
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`config.${name} must be an integer in ${min}..${max}`);
    return v as number;
  };
  const tickSec = int("tickSec", 60, 5, 3600);
  // By default 30 prices, or as many as the ticks of an hour hold.
  const paySamples = int("paySamples", Math.min(30, Math.floor(3600 / tickSec)), 1, 3600);
  if (paySamples * tickSec > 3600) throw new Error("config.paySamples ticks must fit in one hour (paySamples x tickSec <= 3600)");
  const payMin = String(raw.payMinUsdg ?? "0.01");
  if (!/^\d+(\.\d{1,6})?$/.test(payMin)) throw new Error("config.payMinUsdg must be a USDG amount with at most 6 decimals");
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
    tickSec,
    maxDevBps: int("maxDevBps", 50, 1, 1000),
    minOutBufferBps: int("minOutBufferBps", 30, 0, 1000),
    deadlineSec: int("deadlineSec", 300, 30, 3600),
    allowExtended: raw.allowExtended === true,
    // Below 1 a "take-profit" sells at a loss: only fork tests may ask for it.
    takeProfitBps: int("takeProfitBps", 500, process.env.FILLMARK_E2E_LOW_TAKE_PROFIT === "1" ? -9_000 : 1, 100_000),
    payRateBps: raw.payRateBps === undefined ? null : int("payRateBps", 0, 0, 5),
    payMinZeroAtBps: int("payMinZeroAtBps", 100, 1, 1000),
    payRequired: bool("payRequired"),
    paySlipBps: int("paySlipBps", 300, 10, 2000),
    paySamples,
    payMinUsdg: parseUnits(payMin, 6),
    settingsUrl: String(raw.settingsUrl ?? "https://api.fillmark.trade/v1/settings"),
    settingsFile: raw.settingsFile === undefined ? null : String(raw.settingsFile),
    settingsStore: String(raw.settingsStore ?? "/var/lib/fillmark-agent/settings.json"),
    maxRebalanceTradesPerDay: int("maxRebalanceTradesPerDay", 20, 1, 200),
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

/// The pool price a sale may push the asset down to: maxSlipBps below the current spot.
export function sellLimit(sqrtP: bigint, token: Address, maxSlipBps: number): bigint {
  const factor = sqrt(((10_000n - BigInt(maxSlipBps)) * 10n ** 36n) / 10_000n); // sqrt(1 - slip) * 1e18
  const tokenIsToken0 = BigInt(token) < BigInt(USDG);
  return tokenIsToken0 ? (sqrtP * factor) / 10n ** 18n : (sqrtP * 10n ** 18n) / factor;
}

/// FillmarkRouterV2.navValueOf: USDG (6 decimals) worth `amount` units at a feed answer
/// with 8 decimals.
export function navValue(amount: bigint, answer: bigint, decimals: number): bigint {
  return (amount * answer) / 10n ** BigInt(decimals + 2);
}

/// Whether the feed answer is at least takeProfitBps above the lot's average cost.
export function takeProfit(qty: bigint, cost: bigint, answer: bigint, decimals: number, takeProfitBps: number): boolean {
  if (qty === 0n || cost === 0n) return false;
  return qty * answer * 10_000n >= cost * 10n ** BigInt(decimals + 2) * BigInt(10_000 + takeProfitBps);
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

/// One buy nonce per account, asset and UTC day, so an asset is bought at most once a day.
/// The v1 agent used the same nonce on the v1 router, so up to previousRouterUntilDay a buy
/// there also counts as that day's buy and the day a client moves to v2 never buys twice.
export function buyNonce(account: Address, token: Address, day: bigint): bigint {
  const encoded = encodeAbiParameters(
    [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
    ["fillmark-dca-v2", account, token, day],
  );
  return BigInt(keccak256(encoded));
}

/// The nonce of the n-th take-profit sale of an asset for an account on a UTC day. A day
/// with a sale has no buy of that asset, and sales go on that day until the lot is sold or
/// the daily limit is reached.
export function saleNonce(account: Address, token: Address, day: bigint, n: bigint): bigint {
  const encoded = encodeAbiParameters(
    [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
    ["fillmark-tp-v1", account, token, day, n],
  );
  return BigInt(keccak256(encoded));
}

/// The base of the n-th rebalance trade of an asset for an account on a UTC day, one counter
/// per side. A rebalance nonce always carries the setting's fingerprint on top.
export function rebalanceNonce(account: Address, token: Address, day: bigint, sell: boolean, n: bigint): bigint {
  const encoded = encodeAbiParameters(
    [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bool" }, { type: "uint256" }],
    ["fillmark-rb-v1", account, token, day, sell, n],
  );
  return BigInt(keccak256(encoded));
}

const MAX_SALES_PER_TICK = 25; // per pair; the daily limit stops them well before
const MAX_REBALANCE_PER_TICK = 10; // trades per account per tick

type Client = {
  account: Address;
  installId: bigint;
  maxSlipBps: number;
  maxPerTrade: bigint;
  fillFeeBps: bigint;
  dailyLimit: bigint;
  spent: bigint; // the router's windowSpent: buys and their fill fees in the last 24 hours
  balance: bigint; // USDG
  debt: bigint; // fees owed to this agent: the router rejects buys until it is paid
  buys: boolean; // false after expiry: the router allows sales only, for SELL_GRACE
  regularOnly: boolean; // the client allowed fills in the regular session only
  pay: PayState | null; // the Fillmark Pay agreement with this agent, when the agent has terms
  mode: Mode; // the strategy this account follows today
};

/// The largest buy whose USDG and fill fee fit both the per-trade limit and what is left of
/// the rolling limit; 0 when less than the router's 10 USDG minimum fits.
export function buyAmount(maxPerTrade: bigint, dailyLimit: bigint, spent: bigint, fillFeeBps: bigint): bigint {
  if (spent >= dailyLimit) return 0n;
  const room = ((dailyLimit - spent) * 10_000n) / (10_000n + fillFeeBps);
  const a = room < maxPerTrade ? room : maxPerTrade;
  return a < MIN_NOTIONAL ? 0n : a;
}

type Pool = { pool: Address; fee: number }; // the router's official pool of a token
type Price = { answer: bigint; decimals: number }; // Chainlink answer (8 decimals) and the token's decimals
type Lot = { qty: bigint; cost: bigint }; // the router's lot: units this agent bought for the account, and their cost
type Result = "filled" | "retry" | "skip" | "small"; // small: no sale fits the limits, buy instead

const TICKER: Record<Address, string> = Object.fromEntries(Object.entries(ASSETS).map(([t, a]) => [a, t]));

export class Agent {
  private readonly pub;
  private readonly wallet;
  private feeds: Address = zeroAddress;
  private pauseDays = 0n; // days without a buy of an asset after a sale of it: the router's hold, rounded up
  private sellGrace = 0n; // seconds after expiry in which the router still allows sales
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
  private readonly saleNext = new Map<string, bigint>(); // day:account:token -> index of the next sale nonce to try
  private readonly noted = new Set<string>(); // scope|key of log lines already written
  private scope = { day: "", hour: "" };
  private servedKey = "";
  private terms: Terms = { rateBps: 0, minZeroAtBps: 0 }; // this agent's Fillmark Pay terms
  private burner: Address = zeroAddress; // the burner whose $FILLMARK pool Fillmark Pay buys in
  private payPool: { feeAndTaxBps: number; usdgIs0: boolean } | null = null; // read once the burner has its token
  private readonly samples: { t: bigint; rate: bigint }[] = []; // $FILLMARK per USDG, one per tick, last hour
  private readonly settledDay = new Map<Address, bigint>(); // account -> UTC day of its last settle
  private readonly settleAfter = new Map<Address, bigint>(); // account -> no settle before this time
  private readonly payOthers = new Set<Address>(); // open agreements of accounts no longer served: settled until closed or paid
  private readonly payChecked = new Map<Address, bigint>(); // account not served -> UTC day its agreement was last read
  private payLive = false; // the burner has its token: Fillmark Pay pays out
  private payKnown = false; // payLive was read this tick; with payRequired, no buys when not
  private book!: SettingsBook; // clients' signed settings
  private settingsReadAt = 0n;
  private readonly salesToday = new Map<Address, bigint>(); // USDG of this agent's sales today, per account
  private readonly rbNext = new Map<string, bigint>(); // day:account:token:side -> next rebalance nonce index
  private readonly modeKey = new Map<Address, string>(); // the mode last logged per account
  private keeper!: Keeper; // books units clients moved, for every account on the router

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
    const hold = BigInt(await this.pub.readContract({ address: this.cfg.router, abi: routerAbi, functionName: "hold" }));
    this.pauseDays = (hold + DAY - 1n) / DAY;
    this.sellGrace = BigInt(await this.pub.readContract({ address: this.cfg.router, abi: routerAbi, functionName: "SELL_GRACE" }));
    await this.payTerms();
    this.keeper = new Keeper(this.pub, this.wallet, this.key, this.cfg.router, this.cfg.deployBlock, this.cfg.agentId, this.cfg.minEthWei, this.once.bind(this));
    const write = (p: string, text: string) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(`${p}.tmp`, text);
      renameSync(`${p}.tmp`, p);
    };
    this.book = new SettingsBook(
      this.cfg.router,
      this.cfg.agentId,
      this.cfg.settingsStore,
      { url: this.cfg.settingsUrl, file: this.cfg.settingsFile ?? undefined },
      { exists: existsSync, read: (p) => readFileSync(p, "utf8"), write },
    );
    this.book.load();
    await this.refreshSettings(0n);
    log("info", "agent ready", { agentId: this.cfg.agentId, wallet, router: this.cfg.router, maxFillsPerDay: this.cfg.maxFillsPerDay, pay: this.terms });
  }

  /// Keeps this agent's Fillmark Pay terms as configured. New terms apply to agreements
  /// opened after them only.
  private async payTerms() {
    const read = () => this.pub.readContract({ address: PAY, abi: payAbi, functionName: "termsOf", args: [this.cfg.agentId] });
    let t = await read();
    const { payRateBps: rate, payMinZeroAtBps: zero } = this.cfg;
    if (rate !== null && (t.rateBps !== rate || t.minZeroAtBps !== zero)) {
      const { request } = await this.pub.simulateContract({ address: PAY, abi: payAbi, functionName: "setRate", args: [this.cfg.agentId, rate, zero], account: this.key });
      const hash = await this.wallet.writeContract(request);
      const receipt = await this.pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`setRate ${hash} reverted`);
      t = await read();
      log("info", "Fillmark Pay terms set", { rateBps: t.rateBps, minZeroAtBps: t.minZeroAtBps, tx: hash });
    }
    this.terms = { rateBps: t.rateBps, minZeroAtBps: t.minZeroAtBps };
    this.burner = await this.pub.readContract({ address: PAY, abi: payAbi, functionName: "burner" });
    if (this.cfg.payRequired && t.minZeroAtBps === 0) throw new Error("payRequired needs Fillmark Pay terms: set payRateBps");
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
      this.salesToday.clear();
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
      for (const l of logs) this.noteFill(`${l.transactionHash}:${l.logIndex}`, getAddress(l.args.account), l.args.fill.buy, l.args.fill.usdgAmount);
      if (to > this.fillScanned) this.fillScanned = to;
      from = to + 1n;
    }
    return this.fillsToday.size + this.revertedToday;
  }

  /// Counts a fill of today once, and the USDG of a sale against its account.
  private noteFill(key: string, account: Address, buy: boolean, usdg: bigint) {
    if (this.fillsToday.has(key)) return;
    this.fillsToday.add(key);
    if (!buy) this.salesToday.set(account, (this.salesToday.get(account) ?? 0n) + usdg);
  }

  /// Reads clients' signed settings, at most every two minutes.
  private async refreshSettings(now: bigint) {
    if (now !== 0n && now < this.settingsReadAt + 120n) return;
    this.settingsReadAt = now;
    try {
      const today = (now === 0n ? await checkedNow(this.pub) : now) / DAY;
      const added = await this.book.refresh(async (url) => {
        const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
        if (!r.ok) throw new Error(`the settings source answered ${r.status}`);
        return r.text();
      }, today);
      if (added > 0) log("info", "new client settings", { added });
    } catch (err) {
      if (err instanceof StoreError) {
        this.once("hour", "settingsstore", "error", "could not write the settings store: new client settings wait until it can", { store: this.cfg.settingsStore, error: err.message });
        return;
      }
      const msg = this.book.known ? "could not read client settings, using those on disk" : "could not read client settings and none are on disk: no trades";
      this.once("hour", "settings", this.book.known ? "warn" : "error", msg, { error: revertName(err) });
    }
  }

  /// The strategy each account follows today. Unknown settings stop every account: an account
  /// that chose a strategy must never be traded with another one.
  private async setModes(served: Client[], day: bigint) {
    if (!this.book.known) {
      for (const c of served) c.mode = { kind: "blocked", reason: "client settings unknown" };
    } else {
      const withSettings = served.filter((c) => this.book.hasSettings(c.account));
      if (withSettings.length > 0) {
        const reads = await this.pub.multicall({
          batchSize: BATCH,
          contracts: withSettings.flatMap((c) => [
            { address: ECDSA_VALIDATOR, abi: validatorAbi, functionName: "ecdsaValidatorStorage", args: [c.account] } as const,
            { address: c.account, abi: kernelRootAbi, functionName: "rootValidator" } as const,
          ]),
        });
        for (const [i, c] of withSettings.entries()) {
          const o = reads[2 * i]!;
          const r = reads[2 * i + 1]!;
          const owner = o.status === "success" && o.result !== zeroAddress ? getAddress(o.result as Address) : null;
          const root = r.status === "success" && String(r.result).toLowerCase() === ROOT_ECDSA;
          c.mode = this.book.mode(c.account, day, owner, root, await this.allowedTokens(c));
        }
      }
    }
    for (const c of served) {
      const m = c.mode;
      const k = m.kind === "dca" || m.kind === "rebalance" ? `${m.kind}:${m.digest}` : m.kind === "blocked" ? `blocked:${m.reason}` : "legacy";
      if (this.modeKey.get(c.account) === k) continue;
      this.modeKey.set(c.account, k);
      if (m.kind === "blocked") log("warn", "account blocked: no trades", { account: c.account, reason: m.reason });
      else log("info", "strategy", { account: c.account, strategy: m.kind === "legacy" ? "dca" : m.kind, setting: m.kind === "legacy" ? null : m.digest });
    }
  }

  /// Accounts open to this agent now, for a buy or a sale. Accounts no longer installed for
  /// it, or past expiry and its sale grace, are dropped: installing again emits Installed.
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
        { address: router, abi: routerAbi, functionName: "windowSpent", args: [account] } as const,
      ]),
    });
    const day = now / DAY;
    const served: Client[] = [];
    const unserved: Address[] = [];
    list.forEach((account, i) => {
      const [id, wallet, maxSlipBps, perfFeeBps, expiry, installId, installed, regularOnly, maxPerTrade, dailyLimit] = reads[4 * i] as readonly [
        bigint, Address, number, number, bigint, bigint, boolean, boolean, bigint, bigint,
      ];
      const balance = reads[4 * i + 1] as bigint;
      const { debt } = reads[4 * i + 2] as { debt: bigint };
      const spent = reads[4 * i + 3] as bigint;
      unserved.push(account); // taken out again below once served
      if (!installed || id !== agentId || wallet !== this.key.address || expiry + this.sellGrace < now) {
        // A fresh install may not be visible yet on the node that answered: drop only
        // accounts whose last install is older than the rescanned overlap.
        if ((this.installedAt.get(account) ?? 0n) < this.scanned - RESCAN) {
          this.candidates.splice(this.candidates.indexOf(account), 1);
          this.allowed.delete(account);
          this.installedAt.delete(account);
        }
        return;
      }
      if (maxPerTrade < MIN_NOTIONAL) return;
      if (this.banned.has(`${day}:${account}`)) return;
      if (perfFeeBps < this.cfg.minPerfFeeBps) {
        this.once("day", `perf:${account}`, "info", "installed with a lower performance fee than this agent asks, not served", { account, perfFeeBps });
        return;
      }
      if (debt > 0n) {
        // The router rejects every buy (InDebt) until a sale or the client pays it.
        this.once("day", `debt:${account}`, "info", "account owes this agent fees, sales only", { account, debt });
      }
      const buys = expiry >= now;
      if (!buys) this.once("day", `expired:${account}`, "info", "permission expired, sales only until the router's grace ends", { account, expiry });
      unserved.pop();
      served.push({ account, installId, maxSlipBps, maxPerTrade, fillFeeBps, dailyLimit, spent, balance, debt, buys, regularOnly, pay: null, mode: { kind: "legacy" } });
    });
    if (this.terms.minZeroAtBps > 0 && served.length > 0) {
      const pay = await this.pub.multicall({
        allowFailure: false,
        batchSize: BATCH,
        contracts: served.flatMap((c) => [
          { address: PAY, abi: payAbi, functionName: "agreementOf", args: [c.account, agentId] } as const,
          { address: PAY, abi: payAbi, functionName: "tokensOf", args: [c.account, agentId] } as const,
          { address: PAY, abi: payAbi, functionName: "dueOf", args: [c.account, agentId] } as const,
          { address: USDG, abi: erc20Abi, functionName: "allowance", args: [c.account, PAY] } as const,
        ]),
      });
      served.forEach((c, i) => {
        const a = pay[4 * i] as { open: boolean; rateBps: number };
        const tokens = pay[4 * i + 1] as readonly { token: Address }[];
        const d = pay[4 * i + 2] as { due: bigint };
        c.pay = { open: a.open, rateBps: a.rateBps, tokens: new Set(tokens.map((b) => getAddress(b.token))), due: d.due, allowance: pay[4 * i + 3] as bigint };
      });
    }
    // Accounts this agent no longer serves (removed, expired, or skipped) may still owe it on
    // an open agreement: read once a day, and settled with the others until closed or paid.
    const unread = unserved.filter((a) => this.payChecked.get(a) !== day && !this.payOthers.has(a));
    if (this.terms.minZeroAtBps > 0 && unread.length > 0) {
      const open = await this.pub.multicall({
        allowFailure: false,
        batchSize: BATCH,
        contracts: unread.map((account) => ({ address: PAY, abi: payAbi, functionName: "agreementOf", args: [account, agentId] }) as const),
      });
      unread.forEach((a, i) => {
        this.payChecked.set(a, day);
        if ((open[i] as { open: boolean }).open) this.payOthers.add(a);
      });
    }
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
    for (const map of [this.retryAt, this.saleNext, this.rbNext]) for (const k of map.keys()) if (!k.startsWith(`${day}:`)) map.delete(k);
    if (!(await this.ethAbove())) return;
    await this.keeper.tick(now).catch((err) => this.once("hour", `keeper:${revertName(err)}`, "error", "booking moved units failed", { error: revertName(err) }));

    try {
      await this.discover();
    } catch (err) {
      this.once("hour", "discover", "error", "client discovery failed, serving known accounts", { error: revertName(err) });
    }
    const served = await this.clients(now);
    this.payKnown = false;
    if (this.terms.minZeroAtBps > 0) {
      await this.payTick(served, now).catch((err) => this.once("hour", `pay:${revertName(err)}`, "error", "Fillmark Pay step failed", { error: revertName(err) }));
    }
    await this.refreshSettings(now);
    await this.setModes(served, day);
    await this.dcaTick(served.filter((c) => c.mode.kind === "legacy" || c.mode.kind === "dca"), now, day);
    await this.rebalanceTick(served.filter((c) => c.mode.kind === "rebalance"), now, day);
  }

  /// Dollar-cost averaging with take-profit, for accounts with no setting in effect (0.5.0
  /// nonces) and accounts whose setting chose dca (nonces with the setting's fingerprint).
  private async dcaTick(served: Client[], now: bigint, day: bigint) {
    const fpOf = (c: Client) => (c.mode.kind === "dca" ? c.mode.fp : null);
    const buyN = (c: Client, token: Address) => {
      const fp = fpOf(c);
      return fp === null ? buyNonce(c.account, token, day) : withFingerprint(fp, buyNonce(c.account, token, day));
    };
    const saleN = (c: Client, token: Address, d: bigint, n: bigint) => {
      const fp = fpOf(c);
      return fp === null ? saleNonce(c.account, token, d, n) : withFingerprint(fp, saleNonce(c.account, token, d, n));
    };
    const tpOf = (c: Client) => (c.mode.kind === "dca" ? c.mode.setting.takeProfitBps : this.cfg.takeProfitBps);
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
    const feedOf = new Map<Address, { feed: Address; maxAge: number; decimals: number }>();
    const extended = new Set<Address>(); // tokens in the extended session now
    const open = tokens.filter((token, i) => {
      const s = sources[i];
      if (s.status !== "success") {
        this.once("hour", `source:${token}`, "warn", "price source unreadable, skipping", { asset: TICKER[token], error: revertName(s.error) });
        return false;
      }
      feedOf.set(token, { feed: s.result.feed, maxAge: s.result.maxAge, decimals: s.result.decimals });
      const session = SESSIONS[s.result.session];
      if (session === "Extended") extended.add(token);
      return session === "Regular" || (session === "Extended" && this.cfg.allowExtended);
    });
    const [rounds, pools] = await Promise.all([
      this.pub.multicall({
        batchSize: BATCH,
        contracts: open.map((t) => ({ address: feedOf.get(t)!.feed, abi: aggregatorAbi, functionName: "latestRoundData" }) as const),
      }),
      this.pub.multicall({
        allowFailure: false,
        batchSize: BATCH,
        contracts: open.map((t) => ({ address: this.cfg.router, abi: routerAbi, functionName: "poolOf", args: [t] }) as const),
      }),
    ]);
    const poolOf = new Map<Address, Pool>(); // the router's official pool, when switched on
    open.forEach((token, i) => {
      const p = pools[i] as { pool: Address; fee: number; active: boolean };
      if (p.active) poolOf.set(token, { pool: p.pool, fee: p.fee });
      else this.once("day", `pool:${token}`, "info", "the router has no active pool for this asset, skipping", { asset: TICKER[token] });
    });
    const priceOf = new Map<Address, Price>();
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
      if (r.result[1] <= 0n) return;
      priceOf.set(token, { answer: r.result[1], decimals: src.decimals });
    });
    // A client that asked for regular hours only is not traded in the extended session.
    const todo = pairs.filter((t) => priceOf.has(t.token) && poolOf.has(t.token) && !(t.c.regularOnly && extended.has(t.token)));
    if (todo.length === 0) return;

    const previous = this.cfg.previousRouter !== zeroAddress && day <= this.cfg.previousRouterUntilDay;
    // A buy within the router's hold after a sale would take that sale's waiting gain off its cost,
    // so the agent could buy one day and sell the next at a flat price: no buy of an asset for
    // pauseDays after a day with a sale of it.
    // Accounts with a dca setting read the pause from the router's held gains instead (below):
    // their earlier days' nonces carry other fingerprints.
    const back = Number(this.pauseDays);
    const layout: { start: number; buys: number; back: number }[] = [];
    const calls: { address: Address; abi: typeof nonceAbi; functionName: "nonceUsed"; args: readonly [Address, bigint] }[] = [];
    const used1 = (router: Address, account: Address, nonce: bigint) => calls.push({ address: router, abi: nonceAbi, functionName: "nonceUsed", args: [account, nonce] } as const);
    for (const t of todo) {
      const legacy = t.c.mode.kind === "legacy";
      const start = calls.length;
      used1(this.cfg.router, t.c.account, saleN(t.c, t.token, day, 0n));
      used1(this.cfg.router, t.c.account, buyN(t.c, t.token));
      let buys = 1;
      if (legacy && previous) {
        used1(this.cfg.previousRouter, t.c.account, buyNonce(t.c.account, t.token, day));
        buys++;
      }
      const b = legacy ? back : 0;
      for (let k = 1; k <= b; k++) used1(this.cfg.router, t.c.account, saleNonce(t.c.account, t.token, day - BigInt(k), 0n));
      layout.push({ start, buys, back: b });
    }
    const used = await this.pub.multicall({ allowFailure: false, batchSize: BATCH, contracts: calls });
    const soldToday = new Set<string>();
    const soldRecently = new Set<string>(); // a sale in the last pauseDays days: no buy
    const pending = todo.filter((t, i) => {
      const { start, buys, back: b } = layout[i]!;
      const row = used.slice(start, start + 1 + buys + b);
      if (row[0]) soldToday.add(t.key);
      if (row.slice(1 + buys).some(Boolean)) soldRecently.add(t.key);
      const bought = row.slice(1, 1 + buys).some(Boolean);
      if (bought) this.done.add(t.key);
      return !bought;
    });

    if (pending.length === 0) return;
    let fills: number;
    try {
      fills = await this.countFills(day);
    } catch (err) {
      // Without today's count the cap cannot be kept: send nothing this tick.
      this.once("hour", "fills", "error", "could not count today's fills, no trades this tick", { error: revertName(err) });
      return;
    }
    const skipped = new Set<Address>(); // accounts left for the next tick after a failed read or send
    const plain = new Map<Address, boolean>();
    // The router's lot (units this agent bought, and their cost) and the account's balance
    // decide a sale; both are read once per tick.
    const held = await this.pub.multicall({
      allowFailure: false,
      batchSize: BATCH,
      contracts: pending.flatMap((t) => [
        { address: this.cfg.router, abi: routerAbi, functionName: "positionOf", args: [t.c.account, this.cfg.agentId, t.token] } as const,
        { address: t.token, abi: erc20Abi, functionName: "balanceOf", args: [t.c.account] } as const,
      ]),
    });
    for (const [i, t] of pending.entries()) {
      const { c } = t;
      if (skipped.has(c.account) || this.banned.has(`${day}:${c.account}`)) continue;
      if (fills >= this.cfg.maxFillsPerDay) {
        this.once("day", "cap", "warn", "daily fill cap reached, no more trades today", { maxFillsPerDay: this.cfg.maxFillsPerDay });
        return;
      }
      let [lot, waiting, later] = held[2 * i] as readonly [Lot, { until: bigint }, { until: bigint }, ...unknown[]];
      let balance = held[2 * i + 1] as bigint;
      const price = priceOf.get(t.token)!;
      let units = lot.qty < balance ? lot.qty : balance; // never more than the lot: the client's own units stay
      const tp = tpOf(c);
      // With a dca setting, the pause holds while a sale's gain waits in the router.
      if (c.mode.kind === "dca" && (waiting.until > now || later.until > now)) soldRecently.add(t.key);
      const sell = takeProfit(lot.qty, lot.cost, price.answer, price.decimals, tp) && units > 0n;
      if (!sell && soldToday.has(t.key)) {
        this.done.add(t.key); // a day with a sale has no buy of that asset
        continue;
      }
      if (!sell && soldRecently.has(t.key)) {
        // not done for the day: a take-profit sale may still come, checked every RETRY_SEC
        this.retryAt.set(t.key, now + RETRY_SEC);
        this.once("day", `pause:${t.key}`, "info", "sold in the last days: no buy until the router's hold ends", { account: c.account, asset: TICKER[t.token], pauseDays: this.pauseDays });
        continue;
      }
      const amount = c.buys ? buyAmount(c.maxPerTrade, c.dailyLimit, c.spent, c.fillFeeBps) : 0n;
      const fee = (amount * c.fillFeeBps) / 10_000n;
      const paid = this.payable(c, amount, fee);
      if (!sell && !paid) {
        this.retryAt.set(t.key, now + RETRY_SEC); // an agreement or allowance may come later today
        continue;
      }
      if (!sell && !c.buys) continue;
      if (!sell && c.debt > 0n) continue;
      if (!sell && amount === 0n) {
        this.once("day", `limit:${t.key}`, "info", "daily limit reached", { account: c.account, asset: TICKER[t.token] });
        this.retryAt.set(t.key, now + RETRY_SEC); // the rolling window frees room over time
        continue;
      }
      if (!sell && c.balance < amount + fee) {
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
        let r: Result = "small";
        let sales = 0;
        if (sell) {
          // Take-profit: sell again and again this day, each sale inside the per-trade limit,
          // until the lot is sold, the daily limit is reached or no sale fits.
          let n = this.saleNext.get(t.key) ?? 0n;
          while (sales < MAX_SALES_PER_TICK) {
            while (await this.pub.readContract({ address: this.cfg.router, abi: nonceAbi, functionName: "nonceUsed", args: [c.account, saleN(c, t.token, day, n)] })) n++;
            this.saleNext.set(t.key, n);
            r = await this.sell(c, t.token, poolOf.get(t.token)!, units, lot, price, day, at, t.key, saleN(c, t.token, day, n), { floor: true, wholeLot: false });
            if (r !== "filled") break;
            sales++;
            n++;
            this.saleNext.set(t.key, n);
            fills = this.fillsToday.size + this.revertedToday;
            if (fills >= this.cfg.maxFillsPerDay) break;
            const [pos, bal] = await this.pub.multicall({
              allowFailure: false,
              contracts: [
                { address: this.cfg.router, abi: routerAbi, functionName: "positionOf", args: [c.account, this.cfg.agentId, t.token] } as const,
                { address: t.token, abi: erc20Abi, functionName: "balanceOf", args: [c.account] } as const,
              ],
            });
            [lot] = pos as readonly [Lot, ...unknown[]];
            balance = bal as bigint;
            units = lot.qty < balance ? lot.qty : balance;
            if (units === 0n || !takeProfit(lot.qty, lot.cost, price.answer, price.decimals, tp)) break;
          }
          if (sales > 0 || soldToday.has(t.key)) {
            // A sale day: no buy. "small" now means the rest of the lot is under 10 USDG.
            if (r === "filled" || r === "small" || r === "skip") this.done.add(t.key);
            if (r === "retry") this.retryAt.set(t.key, now + RETRY_SEC);
            continue;
          }
        }
        if (r === "small") {
          if (soldRecently.has(t.key)) {
            this.done.add(t.key); // no sale fits, and a sale in the last days rules out a buy
            this.once("day", `small:${t.key}`, "info", "take-profit reached but no sale fits, and sold in the last days: no buy", {
              account: c.account, asset: TICKER[t.token], units,
            });
            continue;
          }
          if (!paid) {
            this.retryAt.set(t.key, now + RETRY_SEC);
            continue;
          }
          if (sell) {
            this.once("day", `small:${t.key}`, "info", "take-profit reached but no sale fits between 10 USDG and the per-trade limit", {
              account: c.account, asset: TICKER[t.token], units,
            });
            if (c.debt > 0n || amount === 0n) {
              this.banned.add(t.key); // no sale fits and no buy is possible: nothing to do today
              continue;
            }
            if (c.balance < amount + fee) {
              this.once("day", `funds:${t.key}`, "info", "not enough USDG for another buy today", { account: c.account, asset: TICKER[t.token] });
              this.retryAt.set(t.key, now + RETRY_SEC);
              continue;
            }
          }
          r = await this.buy(c, t.token, poolOf.get(t.token)!, amount, day, at, t.key, buyN(c, t.token));
          if (r === "filled") {
            c.balance -= amount + fee;
            c.spent += amount + fee;
            // What this buy adds to the agreement, so the next buy this tick checks against it.
            if (c.pay?.open) c.pay.due += (BigInt(c.pay.rateBps) * amount + 9_999n) / 10_000n;
          }
        }
        if (r !== "retry") fills = this.fillsToday.size + this.revertedToday;
        if (r === "filled") {
          this.done.add(t.key);
          continue;
        }
        if (r === "skip") continue;
      } catch (err) {
        this.once("hour", `fail:${t.key}:${revertName(err)}`, "error", "trade failed", { account: c.account, asset: TICKER[t.token], error: revertName(err) });
        skipped.add(c.account); // a read failed or a send may be pending: leave the account for the next tick
        fills++; // a send that threw may still mine: count it until the next tick reads the logs
      }
      this.retryAt.set(t.key, now + RETRY_SEC); // no tier filled: try again later, not every tick
    }
  }

  /// Rebalance, for accounts whose setting chose it: one account at a time, one trade at a
  /// time, each decided from a fresh read of the account.
  private async rebalanceTick(list: Client[], now: bigint, day: bigint) {
    if (list.length === 0) return;
    let fills: number;
    try {
      fills = await this.countFills(day);
    } catch (err) {
      this.once("hour", "fills", "error", "could not count today's fills, no trades this tick", { error: revertName(err) });
      return;
    }
    for (const c of list) {
      if (fills >= this.cfg.maxFillsPerDay) {
        this.once("day", "cap", "warn", "daily fill cap reached, no more trades today", { maxFillsPerDay: this.cfg.maxFillsPerDay });
        return;
      }
      const key = `${day}:${c.account}:rebalance`;
      if (this.banned.has(`${day}:${c.account}`) || (this.retryAt.get(key) ?? 0n) > now) continue;
      try {
        if (!(await this.isPlainKernel(c.account))) {
          this.banned.add(`${day}:${c.account}`);
          this.once("day", `kernel:${c.account}`, "warn", "account is not a plain Kernel account, skipped today", { account: c.account });
          continue;
        }
        const wait = await this.rebalanceOne(c, now, day);
        if (wait) this.retryAt.set(key, now + RETRY_SEC);
      } catch (err) {
        this.once("hour", `rbfail:${c.account}:${revertName(err)}`, "error", "rebalance failed", { account: c.account, error: revertName(err) });
        this.retryAt.set(key, now + RETRY_SEC);
      }
      fills = this.fillsToday.size + this.revertedToday;
    }
  }

  /// Trades one account toward its targets. Returns true when it should wait before the next try.
  private async rebalanceOne(c: Client, now: bigint, day: bigint): Promise<boolean> {
    const m = c.mode;
    if (m.kind !== "rebalance") return true;
    const s: Setting = m.setting;
    const { router, agentId } = this.cfg;
    if (!c.buys) {
      this.once("day", `rbexpired:${c.account}`, "info", "rebalance: permission expired, no rebalance trades", { account: c.account });
      return true;
    }
    const tokens = await this.allowedTokens(c);
    const weight = new Map(s.targets.map((t) => [t.asset, t.weightBps]));
    const tolBps = s.driftBps > 0 ? s.driftBps / 2 : 50;
    const scheduled = s.everyDays > 0 && scheduleOpen(day, effectiveDay(s), s.everyDays);
    const rbN = (token: Address, d: bigint, sell: boolean, n: bigint) => withFingerprint(m.fp, rebalanceNonce(c.account, token, d, sell, n));

    // Under way: a rebalance trade today or yesterday under this setting.
    const started = await this.pub.multicall({
      allowFailure: false,
      batchSize: BATCH,
      contracts: tokens.flatMap((t) =>
        [day, day - 1n].flatMap((d) => [false, true].map((sell) => ({ address: router, abi: nonceAbi, functionName: "nonceUsed", args: [c.account, rbN(t, d, sell, 0n)] }) as const)),
      ),
    });
    let underway = started.some(Boolean);
    // Today's rebalance trades so far, from the nonce counters.
    let tradesToday = 0n;
    for (const t of tokens) {
      for (const sell of [false, true]) {
        const k = `${day}:${c.account}:${t}:${sell ? "s" : "b"}`;
        let n = this.rbNext.get(k) ?? 0n;
        while (await this.pub.readContract({ address: router, abi: nonceAbi, functionName: "nonceUsed", args: [c.account, rbN(t, day, sell, n)] })) n++;
        this.rbNext.set(k, n);
        tradesToday += n;
      }
    }

    const skip = new Set<Address>(); // assets whose sale cannot go this tick: planned as if not sellable
    for (let step = 0; step < MAX_REBALANCE_PER_TICK; step++) {
      if (tradesToday >= BigInt(this.cfg.maxRebalanceTradesPerDay)) {
        this.once("day", `rbcap:${c.account}`, "info", "rebalance: the account's trades for today are used up", { account: c.account });
        return true;
      }
      if (this.fillsToday.size + this.revertedToday >= this.cfg.maxFillsPerDay || this.banned.has(`${day}:${c.account}`)) return true;
      const at = await checkedNow(this.pub);
      if (at / DAY !== day) return false;
      if (!(await this.ethAbove())) return true;

      // The account now: balances, the agent's lots, prices the router accepts, sessions, pools.
      // One batch of mixed reads; each result is checked and typed where it is used.
      const contracts: unknown[] = [
          { address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [c.account] } as const,
          { address: router, abi: routerAbi, functionName: "windowSpent", args: [c.account] } as const,
          { address: router, abi: routerAbi, functionName: "bookOf", args: [c.account, agentId] } as const,
          { address: PAY, abi: payAbi, functionName: "dueOf", args: [c.account, agentId] } as const,
          ...tokens.flatMap((t) => [
            { address: t, abi: erc20Abi, functionName: "balanceOf", args: [c.account] } as const,
            { address: router, abi: routerAbi, functionName: "positionOf", args: [c.account, agentId, t] } as const,
            { address: router, abi: routerAbi, functionName: "priceOf", args: [t] } as const,
            { address: this.feeds, abi: feedsAbi, functionName: "sourceOf", args: [t, at] } as const,
            { address: router, abi: routerAbi, functionName: "poolOf", args: [t] } as const,
          ]),
      ];
      const reads = (await this.pub.multicall({ batchSize: BATCH, contracts: contracts as any[] })) as { status: "success" | "failure"; result?: unknown; error?: unknown }[];
      const ok = <T>(i: number) => {
        const r = reads[i]!;
        if (r.status !== "success") throw new Error(`read ${i} failed: ${revertName(r.error)}`);
        return r.result as T;
      };
      const usdg = ok<bigint>(0);
      const spent = ok<bigint>(1);
      const debt = ok<{ debt: bigint }>(2).debt;
      const payDue = ok<{ due: bigint }>(3).due; // owed to this agent on an agreement, open or closed
      type Row = { token: Address; balance: bigint; lot: Lot; price: Price | null; tradable: boolean; pool: Pool | null };
      const rows: Row[] = tokens.map((token, j) => {
        const b = 4 + 5 * j;
        const balance = ok<bigint>(b);
        const [lot] = ok<readonly [Lot, ...unknown[]]>(b + 1);
        const pr = reads[b + 2]!;
        const src = reads[b + 3]!;
        const pl = ok<{ pool: Address; fee: number; active: boolean }>(b + 4);
        const price = pr.status === "success" ? { answer: (pr.result as readonly [bigint, number])[0], decimals: (pr.result as readonly [bigint, number])[1] } : null;
        const session = src.status === "success" ? SESSIONS[(src.result as { session: number }).session] : "Closed";
        const tradable = session === "Regular" || (session === "Extended" && this.cfg.allowExtended && !c.regularOnly);
        return { token, balance, lot, price, tradable, pool: pl.active ? { pool: pl.pool, fee: pl.fee } : null };
      });
      const book = rows.filter((r) => r.balance > 0n || (weight.get(r.token) ?? 0) > 0);
      const unpriced = book.filter((r) => !r.price);
      if (unpriced.length > 0) {
        this.once("hour", `rbprice:${c.account}`, "info", "rebalance waits: an asset cannot be priced now", { account: c.account, assets: unpriced.map((r) => TICKER[r.token]) });
        return true;
      }
      const cash = usdg > payDue + debt ? usdg - payDue - debt : 0n;
      const holdings = book.map((r) => {
        const own = r.lot.qty < r.balance ? r.lot.qty : r.balance; // only the agent's own units are sold
        const units = skip.has(r.token) ? 0n : own;
        const p = r.price!;
        return { token: r.token, units, value: navValue(r.balance, p.answer, p.decimals), sellable: navValue(units, p.answer, p.decimals), weightBps: weight.get(r.token) ?? 0 };
      });
      const probe = planRebalance(holdings, cash, s.cashBps, MIN_NOTIONAL);
      if (probe.total === 0n) return true;
      const triggered = underway || scheduled || (s.driftBps > 0 && probe.driftBps >= s.driftBps);
      if (!triggered) {
        this.once("day", `rbquiet:${c.account}`, "info", "rebalance: within the threshold", { account: c.account, driftBps: probe.driftBps, thresholdBps: s.driftBps });
        return true;
      }
      const tol = (probe.total * BigInt(Math.floor(tolBps))) / BPS;
      const minTrade = tol > MIN_NOTIONAL ? tol : MIN_NOTIONAL;
      const plan = planRebalance(holdings, cash, s.cashBps, minTrade);
      // An asset whose target is 0: every unit the agent bought is sold, the last of them even
      // under 10 USDG when that is the whole lot (the router allows a whole-lot sale below it).
      const sales = plan.sells.map((x) => ({ ...x, all: false }));
      for (const h of holdings) {
        if (h.weightBps === 0 && h.units > 0n && !sales.some((x) => x.token === h.token)) sales.push({ token: h.token, usdg: h.sellable, all: true });
      }
      if (sales.length === 0 && plan.buys.length === 0) {
        if (underway || scheduled) this.once("day", `rbdone:${c.account}`, "info", "rebalance: on target", { account: c.account, driftBps: probe.driftBps });
        return true;
      }
      // Every asset the plan trades must trade now, so a rebalance is never left half done
      // because one leg cannot go.
      const legs = [...sales, ...plan.buys].map((x) => rows.find((r) => r.token === x.token)!);
      const stuck = legs.filter((r) => !r.tradable || !r.pool);
      if (stuck.length > 0) {
        this.once("hour", `rbstuck:${c.account}`, "info", "rebalance waits: an asset it must trade cannot trade now", { account: c.account, assets: stuck.map((r) => TICKER[r.token]) });
        return true;
      }
      underway = true;

      if (sales.length > 0) {
        const x = sales[0]!;
        const r = rows.find((y) => y.token === x.token)!;
        const price = r.price!;
        const units = r.lot.qty < r.balance ? r.lot.qty : r.balance;
        const sold = this.salesToday.get(c.account) ?? 0n;
        const room = c.dailyLimit > sold ? c.dailyLimit - sold : 0n; // keeps a day's sales within the daily limit, as Fillmark Pay's allowance assumes
        const scale = 10n ** BigInt(price.decimals + 2);
        let want = x.all ? units : (x.usdg * scale) / price.answer;
        const roomUnits = (room * scale) / price.answer;
        if (want > roomUnits) want = roomUnits;
        if (want > units) want = units;
        // Under 10 USDG only as the whole lot; anything else waits for the next tick, and the rest
        // of the plan goes on without it.
        const wholeLot = x.all && want === r.lot.qty;
        if (want === 0n || (!wholeLot && navValue(want, price.answer, price.decimals) < MIN_NOTIONAL)) {
          if (room < MIN_NOTIONAL) this.once("day", `rbsales:${c.account}`, "info", "rebalance: today's sales reached the daily limit", { account: c.account });
          else this.once("hour", `rbsmall:${c.account}:${x.token}`, "info", "rebalance: this sale is under 10 USDG, buys go on", { account: c.account, asset: TICKER[x.token] });
          skip.add(x.token);
          continue;
        }
        const k = `${day}:${c.account}:${x.token}:s`;
        const n = this.rbNext.get(k) ?? 0n;
        const res = await this.sell(c, x.token, r.pool!, want, r.lot, price, day, at, `${day}:${c.account}:${x.token}`, rbN(x.token, day, true, n), { floor: false, wholeLot, maxOut: room });
        if (res !== "filled") {
          skip.add(x.token);
          continue;
        }
        this.rbNext.set(k, n + 1n);
        tradesToday++;
        continue;
      }

      const x = plan.buys[0]!;
      const r = rows.find((y) => y.token === x.token)!;
      if (debt > 0n) {
        this.once("day", `debt:${c.account}`, "info", "account owes this agent fees, sales only", { account: c.account, debt });
        return true;
      }
      let amount = buyAmount(c.maxPerTrade, c.dailyLimit, spent, c.fillFeeBps);
      if (amount > x.usdg) amount = x.usdg;
      if (amount < MIN_NOTIONAL) {
        this.once("day", `limit:${c.account}`, "info", "rebalance: daily limit reached, buys go on later", { account: c.account });
        return true;
      }
      if (amount + (amount * c.fillFeeBps) / 10_000n > cash) amount = (cash * 10_000n) / (10_000n + c.fillFeeBps);
      if (amount < MIN_NOTIONAL) return true;
      const fee = (amount * c.fillFeeBps) / 10_000n;
      c.balance = usdg;
      if (c.pay) c.pay.due = payDue;
      if (!this.payable(c, amount, fee)) return true;
      const k = `${day}:${c.account}:${x.token}:b`;
      const n = this.rbNext.get(k) ?? 0n;
      const res = await this.buy(c, x.token, r.pool!, amount, day, at, `${day}:${c.account}:${x.token}`, rbN(x.token, day, false, n));
      if (res !== "filled") return true;
      this.rbNext.set(k, n + 1n);
      tradesToday++;
    }
    return false;
  }

  /// Adds a token to the client's open Fillmark Pay agreement, so fills of it are paid for.
  private async track(c: Client, token: Address, key: string, asset: string): Promise<boolean> {
    try {
      const { request } = await this.pub.simulateContract({ address: PAY, abi: payAbi, functionName: "track", args: [c.account, this.cfg.agentId, token], account: this.key });
      const hash = await this.wallet.writeContract(request);
      const receipt = await this.pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`track ${hash} reverted`);
      c.pay!.tokens.add(token);
      log("info", "token added to the Fillmark Pay agreement", { account: c.account, asset, tx: hash });
      return true;
    } catch (err) {
      this.once("hour", `track:${key}:${revertName(err)}`, "warn", "could not add the token to the Fillmark Pay agreement, no fill now", { account: c.account, asset, error: revertName(err) });
      return false;
    }
  }

  /// With payRequired, once Fillmark Pay pays out: whether a buy of `amount` for this account
  /// would be paid for. Its open agreement must allow and hold what is due plus what the buy
  /// adds at the agreement's rate; the buy's USDG and fill fee come on top of what is due.
  private payable(c: Client, amount: bigint, fee: bigint): boolean {
    if (!this.cfg.payRequired) return true;
    if (!this.payKnown) {
      this.once("hour", "payunknown", "warn", "could not read whether Fillmark Pay pays out: no buys this tick");
      return false;
    }
    if (!this.payLive) return true;
    const p = c.pay;
    if (!p?.open) {
      this.once("day", `nopay:${c.account}`, "info", "no open Fillmark Pay agreement with this agent: no buys", { account: c.account });
      return false;
    }
    const adds = (BigInt(p.rateBps) * amount + 9_999n) / 10_000n;
    if (p.allowance < p.due + adds || c.balance < amount + fee + p.due) {
      this.once("day", `payshort:${c.account}`, "info", "Fillmark Pay allowance or USDG below what is due and what a buy adds: no buys", {
        account: c.account, due: p.due, allowance: p.allowance, balance: c.balance,
      });
      return false;
    }
    return true;
  }

  /// One pool price sample per tick, then once a UTC day per account a settle of what is due.
  /// The agent bears the pool price, so it pays only at a price near the hour's median: a
  /// price pushed up against it makes the settle wait, never pay less.
  private async payTick(served: Client[], now: bigint) {
    // The burner's token is set once; until then nothing can be paid.
    if (!this.payLive) this.payLive = (await this.pub.readContract({ address: this.burner, abi: burnerAbi, functionName: "token" })) !== zeroAddress;
    this.payKnown = true;
    if (!this.payLive) return;
    if (!this.payPool) {
      const key = await this.pub.readContract({ address: this.burner, abi: burnerAbi, functionName: "poolKey" });
      // Pons pools take no LP fee; the minimum below counts only the hook's fees on the output.
      if (key.fee !== 0) throw new Error(`the burner's pool has an LP fee (${key.fee}): settles need a minimum that counts it`);
      const id = await this.pub.readContract({ address: this.burner, abi: burnerAbi, functionName: "poolId" });
      const l = await this.pub.readContract({ address: key.hooks, abi: ponsHookAbi, functionName: "launches", args: [id] });
      if (!l.registered) throw new Error("the burner's pool is not a registered Pons launch");
      // Fixed when the pool was registered (the hook's launch record holds static fields only).
      this.payPool = { feeAndTaxBps: l.hookFeeBps + l.creatorTaxBps, usdgIs0: getAddress(key.currency0) === USDG };
    }
    const sqrtP = await this.pub.readContract({ address: this.burner, abi: burnerAbi, functionName: "sqrtPriceX96" });
    const rate = tokenPerUsdg(sqrtP, this.payPool.usdgIs0);
    this.samples.push({ t: now, rate });
    while (this.samples.length > 0 && this.samples[0]!.t + 3600n < now) this.samples.shift();

    const day = now / DAY;
    const servedOpen = served.filter((c) => c.pay?.open).map((c) => c.account);
    const accounts = [...new Set([...servedOpen, ...this.payOthers])].filter(
      (a) => this.settledDay.get(a) !== day && (this.settleAfter.get(a) ?? 0n) <= now,
    );
    if (accounts.length === 0) return;
    if (this.samples.length < this.cfg.paySamples) {
      this.once("hour", "paysamples", "info", "Fillmark Pay: not enough pool prices seen yet to settle", { seen: this.samples.length, need: this.cfg.paySamples });
      return;
    }
    const ref = median(this.samples.map((x) => x.rate));
    const slip = BigInt(this.cfg.paySlipBps);
    if (rate * 10_000n < ref * (10_000n - slip) || rate * 10_000n > ref * (10_000n + slip)) {
      this.once("hour", "payprice", "info", "Fillmark Pay: the pool price is away from the hour's median, settles wait", { rate, median: ref });
      return;
    }
    const minOut = minReceivedPerUsdg(ref, this.payPool.feeAndTaxBps, this.cfg.paySlipBps);
    for (const account of accounts) {
      const d = await this.pub.readContract({ address: PAY, abi: payAbi, functionName: "dueOf", args: [account, this.cfg.agentId] });
      const wait = WAITS[d.wait] ?? String(d.wait);
      if (wait === "NotOpen") {
        this.payOthers.delete(account);
        continue;
      }
      if (d.payNow === 0n || d.payNow < this.cfg.payMinUsdg) {
        // Nothing, or too little to be worth the gas: looked at again tomorrow, unless the
        // block budget or the burner's buy held it back.
        if (wait !== "BlockBudget" && wait !== "BurnThisBlock") this.settledDay.set(account, day);
        if (wait === "NothingDue" && !servedOpen.includes(account)) this.payOthers.delete(account);
        if (d.payNow === 0n && wait !== "NothingDue") this.once("day", `paywait:${account}:${wait}`, "info", "Fillmark Pay: nothing can be paid now", { account, due: d.due, wait });
        continue;
      }
      if (!(await this.ethAbove())) return;
      const args = [account, this.cfg.agentId, minOut] as const;
      let request;
      try {
        ({ request } = await this.pub.simulateContract({ address: PAY, abi: payAbi, functionName: "settle", args, account: this.key }));
      } catch (err) {
        this.once("hour", `settle:${account}:${revertName(err)}`, "info", "Fillmark Pay: settle refused now", { account, error: revertName(err) });
        this.settleAfter.set(account, now + RETRY_SEC);
        continue;
      }
      const gas = ((await this.pub.estimateContractGas({ address: PAY, abi: payAbi, functionName: "settle", args, account: this.key })) * 13n) / 10n;
      const hash = await this.wallet.writeContract({ ...request, gas });
      const receipt = await this.pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        this.settledDay.set(account, day); // it cost gas: not again today
        log("error", "Fillmark Pay settle reverted on chain", { account, tx: hash });
        continue;
      }
      const [ev] = parseEventLogs({ abi: payAbi, eventName: "Settled", logs: receipt.logs.filter((l) => getAddress(l.address) === PAY) });
      if (!ev) {
        // Nothing was payable by the time it landed (the burner bought, or the block's budget
        // went to others): tried again later.
        this.settleAfter.set(account, now + RETRY_SEC);
        log("info", "Fillmark Pay settle paid nothing", { account, tx: hash });
        continue;
      }
      // Paid in full, or as much as the account's balance or allowance let it: done today. A
      // part held back by the block budget is paid on a later tick.
      if (ev.args.unpaid === 0n || wait === "Balance" || wait === "Allowance") this.settledDay.set(account, day);
      log("info", "Fillmark Pay settled", {
        account,
        usdgPaid: ev.args.usdgPaid,
        fillmarkToAgent: ev.args.fillmarkToAgent,
        fillmarkBurned: ev.args.fillmarkBurned,
        unpaid: ev.args.unpaid,
        wait,
        tx: hash,
      });
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

  /// Quotes the router's official pool for `amountIn` USDG and sends the buy. The router
  /// bounds the pool price after the swap against NAV and the pool's TWAP; a buy it would
  /// refuse fails in simulation and is tried again later ("retry").
  private async buy(c: Client, token: Address, { pool, fee }: Pool, amountIn: bigint, day: bigint, now: bigint, key: string, nonce: bigint): Promise<Result> {
    const asset = TICKER[token];
    const [sqrtP] = await this.pub.readContract({ address: pool, abi: poolAbi, functionName: "slot0" });
    const limit = buyLimit(sqrtP, token, c.maxSlipBps);
    let out: bigint;
    try {
      ({ result: [out] } = await this.pub.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: USDG, tokenOut: token, amountIn, fee, sqrtPriceLimitX96: limit }],
      }));
    } catch (err) {
      this.once("day", `quote:${key}:${revertName(err)}`, "info", "no quote", { asset, error: revertName(err) });
      return "retry";
    }
    const r = await this.send(c, key, asset, {
      agentId: this.cfg.agentId,
      account: c.account,
      installId: c.installId,
      tokenIn: USDG,
      tokenOut: token,
      amountIn,
      minOut: (out * BigInt(10_000 - this.cfg.minOutBufferBps)) / 10_000n,
      sqrtPriceLimitX96: limit,
      nonce,
      deadline: this.deadline(now, day),
    });
    return r === "rejected" ? "retry" : r;
  }

  /// Sells up to `units` of the lot in the router's official pool. The sale is sized so the
  /// router's per-trade count, the larger of the USDG received and the NAV value, stays inside
  /// the limit even if the pool moves by maxDevBps or the feed by FEED_MARGIN_BPS before it
  /// lands, and so its minOut is at least the router's 10 USDG minimum and, after the fill fee,
  /// the cost of the units sold: a take-profit sale never sells below cost. "small": no amount
  /// in that range can be sold, so the agent buys instead. "retry": the pool pays too little
  /// now, or the router refuses the sale.
  private async sell(
    c: Client, token: Address, { pool, fee }: Pool, units: bigint, lot: Lot, price: Price, day: bigint, now: bigint, key: string, nonce: bigint,
    opts: { floor: boolean; wholeLot: boolean; maxOut?: bigint },
  ): Promise<Result> {
    const asset = TICKER[token];
    const perTrade = (c.maxPerTrade * BigInt(10_000 - this.cfg.maxDevBps - FEED_MARGIN_BPS)) / 10_000n;
    // A rebalance sale also stays within what is left of the day's sales.
    const capOut = opts.maxOut !== undefined && opts.maxOut < perTrade ? opts.maxOut : perTrade;
    const capUnits = (capOut * 10n ** BigInt(price.decimals + 2)) / price.answer; // units worth capOut at NAV
    const want = units < capUnits ? units : capUnits;
    const floorFor = (qty: bigint) => {
      if (!opts.floor || this.cfg.takeProfitBps < 1) return 0n; // rebalance sales; and fork tests only: loadConfig refuses it otherwise
      const cost = (lot.cost * qty + lot.qty - 1n) / lot.qty; // the lot's cost of qty units, rounded up
      return (cost * 10_000n + 10_000n - c.fillFeeBps - 1n) / (10_000n - c.fillFeeBps); // gross whose net covers it
    };
    const [sqrtP] = await this.pub.readContract({ address: pool, abi: poolAbi, functionName: "slot0" });
    const limit = sellLimit(sqrtP, token, c.maxSlipBps);
    const quote = async (qty: bigint) =>
      (await this.pub.simulateContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: token, tokenOut: USDG, amountIn: qty, fee, sqrtPriceLimitX96: limit }],
      })).result[0];
    let qty = want;
    let out: bigint;
    try {
      out = await quote(qty);
      // The pool pays more than NAV: sell fewer units. A smaller sale gets a slightly better
      // average price, so shrink a little more than in proportion, a few times at most.
      for (let i = 0; i < 4 && out > capOut && qty > 0n; i++) {
        qty = (qty * capOut * 9_999n) / (out * 10_000n);
        if (qty > 0n) out = await quote(qty);
      }
    } catch (err) {
      this.once("day", `squote:${key}:${revertName(err)}`, "info", "no sale quote", { asset, error: revertName(err) });
      return "retry";
    }
    const minOut = (out * BigInt(10_000 - this.cfg.minOutBufferBps)) / 10_000n;
    // A sale of the whole lot may be under the router's 10 USDG minimum (rebalance, target 0 only).
    const whole = opts.wholeLot && qty === units && qty === want;
    if (qty === 0n || out > capOut || (minOut < MIN_NOTIONAL && !whole) || navValue(qty, price.answer, price.decimals) > capOut) return "small";
    const floor = floorFor(qty);
    if (minOut < floor) {
      this.once("hour", `cost:${key}`, "info", "sale would not cover the lot's cost, not sold", { account: c.account, asset, minOut, floor });
      return "retry";
    }
    const r = await this.send(c, key, asset, {
      agentId: this.cfg.agentId,
      account: c.account,
      installId: c.installId,
      tokenIn: token,
      tokenOut: USDG,
      amountIn: qty,
      minOut,
      sqrtPriceLimitX96: limit,
      nonce,
      deadline: this.deadline(now, day),
    });
    return r === "rejected" ? "retry" : r;
  }

  /// An intent's deadline: deadlineSec from now, and never after its day ends.
  private deadline(now: bigint, day: bigint): bigint {
    const end = (day + 1n) * DAY - 1n;
    const d = now + BigInt(this.cfg.deadlineSec);
    return d < end ? d : end;
  }

  /// Simulates and sends one intent from the agent wallet. "rejected": the router refuses it
  /// in simulation (a price bound, for example); it is tried again later. All intents of a
  /// pair carry the day's nonce and expire with the day, so at most one executes, and only
  /// on that day.
  private async send(c: Client, key: string, asset: string, it: FillIntent): Promise<"filled" | "skip" | "rejected"> {
    const { router } = this.cfg;
    const side = it.tokenIn === USDG ? "buy" : "sell";
    let request;
    try {
      ({ request } = await this.pub.simulateContract({ address: router, abi: routerAbi, functionName: "execute", args: [it], account: this.key }));
    } catch (err) {
      this.once("hour", `rejected:${key}:${side}:${revertName(err)}`, "info", "router refused the fill now", { account: c.account, asset, side, error: revertName(err) });
      return "rejected";
    }
    // A fill of a token the open agreement does not track is never paid for: no buy without
    // it, while a sale goes on, as it is the client's exit.
    const stock = side === "buy" ? it.tokenOut : it.tokenIn;
    if (c.pay?.open && !c.pay.tokens.has(stock) && !(await this.track(c, stock, key, asset)) && side === "buy") return "rejected";
    const gas = await this.pub.estimateContractGas({ address: router, abi: routerAbi, functionName: "execute", args: [it], account: this.key });
    if (gas > GAS_CAP) {
      this.banned.add(key);
      this.once("day", `gas:${key}`, "warn", "fill needs more gas than the cap, skipped today", { account: c.account, asset, side, gas, cap: GAS_CAP });
      return "skip";
    }
    const hash = await this.wallet.writeContract({ ...request, gas: GAS_CAP });
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      // It passed simulation and failed on chain: the account is not traded again today.
      const day = key.slice(0, key.indexOf(":"));
      this.banned.add(`${day}:${c.account}`);
      this.done.add(key);
      this.revertedToday++; // counts toward the daily cap: it cost gas
      log("error", "fill reverted on chain, account skipped today", { account: c.account, asset, side, tx: hash, gasUsed: receipt.gasUsed });
      return "skip";
    }
    const logs = receipt.logs.filter((l) => getAddress(l.address) === router);
    const [filled] = parseEventLogs({ abi: routerAbi, eventName: "Filled", logs });
    this.noteFill(`${hash}:${filled.logIndex}`, c.account, side === "buy", filled.args.fill.usdgAmount);
    const refused = parseEventLogs({ abi: routerAbi, eventName: "FeedbackFailed", logs }).length;
    if (refused > 0) log("warn", "the registry refused this fill's feedback", { account: c.account, asset, tx: hash, refused });
    log("info", "filled", {
      account: c.account,
      strategy: c.mode.kind === "legacy" ? "dca" : c.mode.kind,
      setting: c.mode.kind === "dca" || c.mode.kind === "rebalance" ? c.mode.digest : null,
      asset,
      side,
      pool: filled.args.pool,
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
