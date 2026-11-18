// Fillmark reference agent: dollar-cost averaging into the tokens in assets.json (stock
// tokens and crypto) for client accounts. Each plan buys a fixed USDG amount of one asset
// at most once per interval; stock plans trade in the regular session only (unless
// allowExtended), crypto at any hour. Every fee tier is quoted with Uniswap's QuoterV2,
// and the best one the router accepts in simulation is sent. The nonce is derived from
// the plan and the interval slot, so a restart or retry can never buy twice in one slot
// (changing a plan's amount or interval starts a new nonce series).
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
  parseEventLogs,
  parseUnits,
  zeroAddress,
  type Address,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { feedsAbi, routerAbi } from "./abi.generated.js";
import {
  FEE_TIERS,
  IDENTITY,
  SESSIONS,
  ASSETS,
  UNISWAP_FACTORY,
  USDG,
  aggregatorAbi,
  checkedNow,
  clients,
  factoryAbi,
  isTicker,
  identityAbi,
  loadKey,
  log,
  poolAbi,
  QUOTER_V2,
  quoterAbi,
  revertName,
  type Ticker,
} from "./chain.js";
import { signIntent, type FillIntent } from "./intent.js";

export type Plan = { account: Address; asset: Ticker; usdgPerBuy: string; intervalSec: number };

export type Config = {
  router: Address;
  agentId: bigint;
  keyFile: string;
  plans: Plan[];
  tickSec: number;
  maxDevBps: number; // pool price may move this much between quote and fill
  minOutBufferBps: number; // minOut sits this far below the simulated output
  deadlineSec: number;
  allowExtended: boolean;
};

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!isAddress(raw.router)) throw new Error("config.router is not an address");
  const plans: Plan[] = (raw.plans ?? []).map((p: any, i: number) => {
    if (!isAddress(p.account)) throw new Error(`plans[${i}].account is not an address`);
    if (typeof p.asset !== "string" || !isTicker(p.asset)) throw new Error(`plans[${i}].asset must be one of ${Object.keys(ASSETS).join(", ")}`);
    if (parseUnits(String(p.usdgPerBuy), 6) < 10_000_000n) throw new Error(`plans[${i}].usdgPerBuy is below 10 USDG`);
    if (!Number.isInteger(p.intervalSec) || p.intervalSec < 600) throw new Error(`plans[${i}].intervalSec must be >= 600`);
    return { account: getAddress(p.account), asset: p.asset, usdgPerBuy: String(p.usdgPerBuy), intervalSec: p.intervalSec };
  });
  const int = (name: string, def: number, min: number, max: number) => {
    const v = raw[name] ?? def;
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`config.${name} must be an integer in ${min}..${max}`);
    return v as number;
  };
  return {
    router: getAddress(raw.router),
    agentId: BigInt(raw.agentId),
    keyFile: raw.keyFile ?? "/etc/fillmark/agent_key",
    plans,
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

/// One nonce per plan and interval slot.
export function planNonce(p: Plan, slot: bigint): bigint {
  const encoded = encodeAbiParameters(
    [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    ["fillmark-dca-v1", p.account, ASSETS[p.asset], parseUnits(p.usdgPerBuy, 6), BigInt(p.intervalSec), slot],
  );
  return BigInt(keccak256(encoded));
}

export class Agent {
  private readonly pub;
  private readonly wallet;
  private feeds: Address = zeroAddress;
  private chainId = 0;

  constructor(
    private readonly cfg: Config,
    private readonly key: PrivateKeyAccount,
  ) {
    const c = clients(key);
    this.pub = c.pub;
    this.wallet = c.wallet!;
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
    log("info", "agent ready", { agentId: this.cfg.agentId, wallet, router: this.cfg.router, plans: this.cfg.plans.length });
  }

  async tick() {
    const now = await checkedNow(this.pub);
    for (const plan of this.cfg.plans) {
      try {
        await this.runPlan(plan, now);
      } catch (err) {
        log("error", "plan failed", { account: plan.account, asset: plan.asset, error: revertName(err) });
      }
    }
  }

  private async runPlan(plan: Plan, now: bigint) {
    const { router } = this.cfg;
    const token = ASSETS[plan.asset];
    const slot = now / BigInt(plan.intervalSec);
    const nonce = planNonce(plan, slot);
    const used = await this.pub.readContract({ address: router, abi: routerAbi, functionName: "nonceUsed", args: [plan.account, nonce] });
    if (used) return;
    // Stocks follow the market calendar; crypto is Regular unless halted.
    const { feed, maxAge, session: s } = await this.pub.readContract({ address: this.feeds, abi: feedsAbi, functionName: "sourceOf", args: [token, now] });
    const session = SESSIONS[s];
    if (session === "Closed" || (session === "Extended" && !this.cfg.allowExtended)) return;
    const [, , , updatedAt] = await this.pub.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" });
    if (now - updatedAt > BigInt(maxAge)) {
      log("warn", "feed stale, skipping", { asset: plan.asset, feed, ageSec: now - updatedAt, maxAge });
      return; // the router would reject every tier as StaleFeed
    }

    const [agentId, , maxSlipBps, expiry, installId, installed] = await this.pub.readContract({
      address: router,
      abi: routerAbi,
      functionName: "configs",
      args: [plan.account],
    });
    if (!installed || agentId !== this.cfg.agentId || expiry < now) {
      log("warn", "account not open to this agent", { account: plan.account, installed, agentId, expiry });
      return;
    }
    const amountIn = parseUnits(plan.usdgPerBuy, 6);
    const balance = await this.pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [plan.account] });
    if (balance < amountIn) {
      log("warn", "not enough USDG", { account: plan.account, balance, need: amountIn });
      return;
    }

    // Quotes come from Uniswap's QuoterV2 and need no signature. An intent is signed only
    // for a tier about to be tried, with that tier's minOut and the slot's nonce.
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
          args: [{ tokenIn: USDG, tokenOut: token, amountIn, fee, sqrtPriceLimitX96: buyLimit(sqrtP, token, maxSlipBps) }],
        });
        quotes.push({ fee, pool, out: result[0] });
      } catch (err) {
        log("info", "no quote", { asset: plan.asset, fee, error: revertName(err) });
      }
    }
    quotes.sort((a, b) => (a.out < b.out ? 1 : a.out > b.out ? -1 : 0));

    // Best quote first; a tier the router rejects (e.g. worse than NAV) falls to the next.
    // All intents carry the slot's nonce, so at most one can ever execute.
    for (const q of quotes) {
      const [sqrtP] = await this.pub.readContract({ address: q.pool, abi: poolAbi, functionName: "slot0" });
      const it: FillIntent = {
        agentId,
        account: plan.account,
        installId,
        tokenIn: USDG,
        tokenOut: token,
        fee: q.fee,
        amountIn,
        minOut: (q.out * BigInt(10_000 - this.cfg.minOutBufferBps)) / 10_000n,
        refSqrtPriceX96: sqrtP,
        maxDevBps: this.cfg.maxDevBps,
        sqrtPriceLimitX96: buyLimit(sqrtP, token, maxSlipBps),
        nonce,
        deadline: (await checkedNow(this.pub)) + BigInt(this.cfg.deadlineSec),
      };
      const sig = await signIntent(this.key, router, this.chainId, it);
      let request;
      try {
        ({ request } = await this.pub.simulateContract({ address: router, abi: routerAbi, functionName: "execute", args: [it, sig], account: this.key }));
      } catch (err) {
        log("info", "fee tier rejected", { account: plan.account, asset: plan.asset, fee: q.fee, error: revertName(err) });
        continue;
      }
      const hash = await this.wallet.writeContract(request);
      const receipt = await this.pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`fill tx ${hash} reverted`);
      const [filled] = parseEventLogs({
        abi: routerAbi,
        eventName: "Filled",
        logs: receipt.logs.filter((l) => getAddress(l.address) === router),
      });
      log("info", "filled", {
        account: plan.account,
        asset: plan.asset,
        fee: it.fee,
        usdg: filled.args.fill.usdgAmount,
        assetAmount: filled.args.fill.stockAmount,
        nav: filled.args.prices.nav,
        fillPrice: filled.args.prices.fill,
        costUsdg: filled.args.prices.cost,
        tx: hash,
      });
      return;
    }
    log("warn", "no fee tier can fill", { account: plan.account, asset: plan.asset, quotes: quotes.length });
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
