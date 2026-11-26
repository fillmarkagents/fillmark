// Client strategy settings and the proof of which strategy each fill ran under.
// The owner of a client account signs a readable EIP-712 Setting (no transaction). It is checked
// by recovering its signer and comparing it with the account's owner in the ECDSA validator, the
// account's root validator. The reference agent puts the top 128 bits of the setting's hash in the
// top 128 bits of every nonce it uses under that setting, and the router logs
// fillId = keccak256(abi.encode(chainid, router, account, nonce)). So a fill's strategy is proven
// by rebuilding the nonce candidates of its day and matching their fillIds, from the logs alone.
// The agent (agent/src/settings.ts) builds the same hashes and nonces; test/strategy.ts checks both.
import { encodeAbiParameters, getAddress, hashTypedData, isAddress, keccak256, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { ASSETS, CHAIN_ID, ECDSA_VALIDATOR, ROUTER_V3 } from "./config";
import type { Fill } from "./record";

export const STRATEGIES = ["dca", "rebalance"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export type Target = { asset: Address; ticker: string; weightBps: number };
export type Setting = {
  account: Address;
  agentId: bigint;
  strategy: Strategy;
  takeProfitBps: number;
  targets: Target[];
  cashBps: number;
  driftBps: number;
  everyDays: number;
  validFrom: bigint;
  seq: bigint;
};
export type Signed = { setting: Setting; signature: Hex };

export const MAX_TARGETS = 8;
export const SCHEDULES = [0, 7, 30] as const;
export const MIN_DRIFT_BPS = 100;
export const MAX_DRIFT_BPS = 5_000;
export const MIN_TAKE_PROFIT_BPS = 100;

export const SETTING_TYPES = {
  Setting: [
    { name: "account", type: "address" },
    { name: "agentId", type: "uint256" },
    { name: "strategy", type: "string" },
    { name: "takeProfitBps", type: "uint32" },
    { name: "targets", type: "Target[]" },
    { name: "cashBps", type: "uint16" },
    { name: "driftBps", type: "uint16" },
    { name: "everyDays", type: "uint16" },
    { name: "validFrom", type: "uint64" },
    { name: "seq", type: "uint64" },
  ],
  Target: [
    { name: "asset", type: "address" },
    { name: "ticker", type: "string" },
    { name: "weightBps", type: "uint16" },
  ],
} as const;

export const settingDomain = (router: Address = ROUTER_V3) => ({ name: "Fillmark", version: "1", chainId: CHAIN_ID, verifyingContract: router }) as const;

export const settingTypedData = (s: Setting, router: Address = ROUTER_V3) =>
  ({ domain: settingDomain(router), types: SETTING_TYPES, primaryType: "Setting", message: { ...s, targets: s.targets.map((t) => ({ ...t })) } }) as const;

export const settingHash = (s: Setting, router: Address = ROUTER_V3): Hex => hashTypedData(settingTypedData(s, router));
export const fingerprint = (s: Setting, router: Address = ROUTER_V3): bigint => BigInt(settingHash(s, router)) >> 128n;
const LOW = (1n << 128n) - 1n;
export const withFingerprint = (fp: bigint, base: bigint): bigint => (fp << 128n) | (base & LOW);
/// The UTC day a setting takes effect: the first whole day after its validFrom.
export const effectiveDay = (s: Setting): bigint => s.validFrom / 86_400n + 1n;

const tokenOf = new Map(ASSETS.map((a) => [a.ticker, getAddress(a.token)]));

/// Why a setting is not well formed, or null. `allowed` is the account's allowed assets.
export function invalidReason(s: Setting, allowed?: readonly Address[]): string | null {
  if (!isAddress(s.account)) return "account is not an address";
  if (!STRATEGIES.includes(s.strategy)) return "unknown strategy";
  if (s.seq < 1n) return "seq must be at least 1";
  if (s.validFrom < 0n || s.validFrom >= 1n << 64n || s.seq >= 1n << 64n) return "validFrom or seq out of range";
  if (s.strategy === "dca") {
    if (s.targets.length || s.cashBps || s.driftBps || s.everyDays) return "dca takes no rebalance fields";
    if (!Number.isInteger(s.takeProfitBps) || s.takeProfitBps < MIN_TAKE_PROFIT_BPS || s.takeProfitBps > 100_000) {
      return `takeProfitBps must be ${MIN_TAKE_PROFIT_BPS}..100000`;
    }
    return null;
  }
  if (s.takeProfitBps !== 0) return "rebalance takes no takeProfitBps";
  if (s.targets.length < 1 || s.targets.length > MAX_TARGETS) return `rebalance needs 1..${MAX_TARGETS} targets`;
  const seen = new Set<string>();
  let sum = s.cashBps;
  for (const t of s.targets) {
    if (!isAddress(t.asset)) return "target asset is not an address";
    const a = getAddress(t.asset);
    if (seen.has(a)) return "an asset is listed twice";
    if (tokenOf.get(t.ticker) !== a) return "a target's ticker does not match its asset";
    seen.add(a);
    if (allowed && !allowed.includes(a)) return "a target asset is not allowed for this account";
    if (!Number.isInteger(t.weightBps) || t.weightBps < 1 || t.weightBps > 10_000) return "weights must be 1..10000";
    sum += t.weightBps;
  }
  if (!Number.isInteger(s.cashBps) || s.cashBps < 0 || s.cashBps > 9_999) return "cashBps must be 0..9999";
  if (sum !== 10_000) return "weights and cash must add up to 10000";
  if (s.driftBps !== 0 && (!Number.isInteger(s.driftBps) || s.driftBps < MIN_DRIFT_BPS || s.driftBps > MAX_DRIFT_BPS)) {
    return `driftBps must be 0 or ${MIN_DRIFT_BPS}..${MAX_DRIFT_BPS}`;
  }
  if (!(SCHEDULES as readonly number[]).includes(s.everyDays)) return "everyDays must be 0, 7 or 30";
  if (s.driftBps === 0 && s.everyDays === 0) return "rebalance needs a drift threshold, a schedule or both";
  return null;
}

/// A setting from JSON (numbers as strings or numbers), normalized; throws when malformed.
export function parseSetting(raw: any): Setting {
  const big = (v: unknown, name: string) => {
    if (typeof v !== "string" && typeof v !== "number") throw new Error(`${name} missing`);
    const s = String(v);
    if (!/^\d+$/.test(s)) throw new Error(`${name} must be a non-negative integer`);
    return BigInt(s);
  };
  const int = (v: unknown, name: string) => {
    const n = Number(v ?? 0);
    if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
    return n;
  };
  if (!raw || typeof raw !== "object") throw new Error("setting missing");
  if (!isAddress(raw.account)) throw new Error("account is not an address");
  const targets = Array.isArray(raw.targets) ? raw.targets : [];
  return {
    account: getAddress(raw.account),
    agentId: big(raw.agentId, "agentId"),
    strategy: raw.strategy,
    takeProfitBps: int(raw.takeProfitBps, "takeProfitBps"),
    targets: targets.map((t: any, i: number) => {
      if (!t || !isAddress(t.asset)) throw new Error(`targets[${i}].asset is not an address`);
      return { asset: getAddress(t.asset), ticker: String(t.ticker ?? ""), weightBps: int(t.weightBps, `targets[${i}].weightBps`) };
    }),
    cashBps: int(raw.cashBps, "cashBps"),
    driftBps: int(raw.driftBps, "driftBps"),
    everyDays: int(raw.everyDays, "everyDays"),
    validFrom: big(raw.validFrom, "validFrom"),
    seq: big(raw.seq, "seq"),
  };
}

export const settingJson = (s: Setting) => ({ ...s, agentId: s.agentId.toString(), validFrom: s.validFrom.toString(), seq: s.seq.toString() });

/// The value rootValidator() returns when the ECDSA validator is the account's root validator.
export const ROOT_ECDSA = `0x01${ECDSA_VALIDATOR.slice(2).toLowerCase()}` as Hex;

/// The signer of a setting, or null when the signature does not parse.
export async function signerOf(x: Signed, router: Address = ROUTER_V3): Promise<Address | null> {
  try {
    return getAddress(await recoverTypedDataAddress({ ...settingTypedData(x.setting, router), signature: x.signature }));
  } catch {
    return null;
  }
}

// ---- Nonces of the reference agent ----

const nonce = (types: { type: string }[], values: unknown[]) => BigInt(keccak256(encodeAbiParameters(types, values)));
/// A daily plan buy of `amountIn` USDG, slot = UTC day (agent 0.1.0, router v1).
export const planNonce = (account: Address, token: Address, amountIn: bigint, day: bigint) =>
  nonce(
    [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    ["fillmark-dca-v1", account, token, amountIn, 86_400n, day],
  );
/// A dca buy: one per account, asset and UTC day (agent 0.2.0 on).
export const buyNonce = (account: Address, token: Address, day: bigint) =>
  nonce([{ type: "string" }, { type: "address" }, { type: "address" }, { type: "uint256" }], ["fillmark-dca-v2", account, token, day]);
/// A take-profit sale: the n-th of the day for that asset (agent 0.3.0 on).
export const saleNonce = (account: Address, token: Address, day: bigint, n: bigint) =>
  nonce([{ type: "string" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], ["fillmark-tp-v1", account, token, day, n]);
/// A rebalance trade: the n-th buy or sale of the day for that asset (agent 0.6.0 on).
export const rebalanceNonce = (account: Address, token: Address, day: bigint, sell: boolean, n: bigint) =>
  nonce(
    [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bool" }, { type: "uint256" }],
    ["fillmark-rb-v1", account, token, day, sell, n],
  );
/// The id the router logs for a fill under `nonce`.
export const fillIdOf = (router: Address, account: Address, n: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [BigInt(CHAIN_ID), router, account, n])).toLowerCase() as Hex;

// ---- Which strategy each fill ran under ----

/// A fill's proven strategy: the setting it ran under (null: the agent's own dca, no setting).
export type FillTag = { strategy: Strategy; setting: Hex | null };

/// Tags each fill whose fillId matches a nonce the reference agent builds for that fill's account,
/// asset, side and UTC day: its own dca (no setting), or a setting of the account (any of them, so
/// the proof needs no knowledge of which one was in effect). A fill no candidate matches (another
/// agent's software) is left out; buys of agent 0.1.0 count when their plan was daily. A setting is
/// tried only for fills from its effective day on, as the agent never uses it before. `only`, when
/// given, limits the work to those fill ids (lowercased); counts still come from every fill. Sales of an asset on one day
/// are numbered from 0, so a fill's n is below the number of that day's fills on its side.
export function tagFills(fills: readonly Fill[], settings: ReadonlyMap<string, readonly Setting[]>, only?: ReadonlySet<string>): Map<string, FillTag> {
  const out = new Map<string, FillTag>();
  const count = new Map<string, number>();
  const keyOf = (f: Fill, day: bigint) => `${f.router.toLowerCase()}|${f.account.toLowerCase()}|${f.stock.toLowerCase()}|${day}|${f.buy ? "b" : "s"}`;
  for (const f of fills) {
    if (f.time === null) continue;
    const k = keyOf(f, BigInt(f.time) / 86_400n);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const fps = new Map<string, { s: Setting; fp: bigint; digest: Hex; from: bigint }[]>();
  for (const [a, list] of settings) fps.set(a.toLowerCase(), list.map((s) => ({ s, fp: fingerprint(s), digest: settingHash(s), from: effectiveDay(s) })));
  for (const f of fills) {
    if (f.time === null || (only && !only.has(f.fillId.toLowerCase()))) continue;
    const day = BigInt(f.time) / 86_400n;
    const k = BigInt(count.get(keyOf(f, day)) ?? 0);
    const want = f.fillId.toLowerCase();
    const id = (n: bigint) => fillIdOf(f.router, f.account, n);
    const match = (candidates: () => Iterable<bigint>) => {
      for (const n of candidates()) if (id(n) === want) return true;
      return false;
    };
    const dcaNonces = function* (fp: bigint | null) {
      const wrap = (n: bigint) => (fp === null ? n : withFingerprint(fp, n));
      if (f.buy) yield wrap(buyNonce(f.account, f.stock, day));
      else for (let n = 0n; n < k; n++) yield wrap(saleNonce(f.account, f.stock, day, n));
    };
    const own = function* () {
      yield* dcaNonces(null);
      if (f.buy) yield planNonce(f.account, f.stock, f.usdg, day);
    };
    if (match(own)) {
      out.set(want, { strategy: "dca", setting: null });
      continue;
    }
    for (const x of fps.get(f.account.toLowerCase()) ?? []) {
      if (x.s.agentId !== f.agentId || x.from > day) continue;
      const found =
        x.s.strategy === "dca"
          ? match(() => dcaNonces(x.fp))
          : match(function* () {
              for (let n = 0n; n < k; n++) yield withFingerprint(x.fp, rebalanceNonce(f.account, f.stock, day, !f.buy, n));
            });
      if (found) {
        out.set(want, { strategy: x.s.strategy, setting: x.digest });
        break;
      }
    }
  }
  return out;
}

export type StrategyGroup = "dca" | "rebalance" | "mixed" | "unattributed";

/// The group an account's results count in: one strategy when every fill of the account is proven
/// under it, "mixed" when its fills ran under more than one strategy or some cannot be attributed,
/// "unattributed" when none can.
export function accountGroup(fills: readonly Fill[], tags: ReadonlyMap<string, FillTag>): StrategyGroup {
  const seen = new Set<string>();
  let untagged = 0;
  for (const f of fills) {
    const t = tags.get(f.fillId.toLowerCase());
    if (t) seen.add(t.strategy);
    else untagged++;
  }
  if (seen.size === 0) return "unattributed";
  if (seen.size > 1 || untagged > 0) return "mixed";
  return [...seen][0] as Strategy;
}
