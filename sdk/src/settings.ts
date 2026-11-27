// Client strategy settings: a readable EIP-712 Setting the owner of a client account signs for one
// agent (no transaction). The same types, hashes and checks as the Fillmark app, the record API
// and the reference agent. A fill sent under a setting carries the top 128 bits of the setting's
// hash in the top 128 bits of its nonce, so anyone can match the fill to the client's signature.
import { getAddress, hashTypedData, isAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { ADDRESSES, ASSETS, CHAIN_ID } from "./addresses.js";

export const STRATEGIES = ["dca", "rebalance"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export type Target = { asset: Address; ticker: string; weightBps: number };
export type Setting = {
  account: Address;
  agentId: bigint;
  strategy: Strategy;
  takeProfitBps: number; // dca: sell a lot this far above its average cost
  targets: Target[]; // rebalance: weight per asset
  cashBps: number; // rebalance: the share kept in USDG
  driftBps: number; // rebalance: trade when an asset's share is this far off target (0: off)
  everyDays: number; // rebalance: trade back to target this often (0: off)
  validFrom: bigint; // unix seconds
  seq: bigint; // a later setting has a higher seq
};
export type Signed = { setting: Setting; signature: Hex };

export const MAX_TARGETS = 8;
export const SCHEDULES = [0, 7, 30] as const; // days
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

/// The domain binds a setting to Robinhood Chain and to router v3.
export const settingDomain = () =>
  ({ name: "Fillmark", version: "1", chainId: CHAIN_ID, verifyingContract: ADDRESSES.router }) as const;

/// The EIP-712 typed data a wallet signs for a setting.
export const settingTypedData = (s: Setting) =>
  ({
    domain: settingDomain(),
    types: SETTING_TYPES,
    primaryType: "Setting",
    message: { ...s, targets: s.targets.map((t) => ({ ...t })) },
  }) as const;

export const settingHash = (s: Setting): Hex => hashTypedData(settingTypedData(s));

/// The top 128 bits of the setting's hash: what a fill's nonce carries.
export const fingerprint = (s: Setting): bigint => BigInt(settingHash(s)) >> 128n;

const LOW = (1n << 128n) - 1n;
/// A nonce under a setting: its fingerprint on top, the low 128 bits of the base nonce below.
export const withFingerprint = (fp: bigint, base: bigint): bigint => (fp << 128n) | (base & LOW);

/// The UTC day a setting takes effect: the first whole day after its validFrom.
export const effectiveDay = (s: Setting): bigint => s.validFrom / 86_400n + 1n;

const tickerToken = new Map(ASSETS.map((a) => [a.ticker, a.token]));

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
    if (tickerToken.get(t.ticker) !== a) return "a target's ticker does not match its asset";
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

/// JSON-safe form of a setting (bigints as strings).
export const settingJson = (s: Setting) => ({
  ...s,
  agentId: s.agentId.toString(),
  validFrom: s.validFrom.toString(),
  seq: s.seq.toString(),
});

/// The signer of a setting, or null when the signature does not parse.
export async function signerOf(x: Signed): Promise<Address | null> {
  try {
    return getAddress(await recoverTypedDataAddress({ ...settingTypedData(x.setting), signature: x.signature }));
  } catch {
    return null;
  }
}
