// Client strategy settings. The owner of a client account signs a readable EIP-712 Setting in
// its wallet (no transaction, no gas). Kernel v3.1's isValidSignature only takes signatures over
// its own wrapped hash, which a wallet would show as an opaque hash, so a setting is checked
// by recovering its signer and comparing it with the account's owner in the ECDSA validator,
// after checking that validator is the account's root validator.
// A setting takes effect at the first 00:00 UTC after its validFrom, so one day's fills never
// mix two settings. Each fill sent under a setting carries the setting's fingerprint, the top
// 128 bits of its EIP-712 hash, in the top 128 bits of its nonce.
import { getAddress, hashTypedData, isAddress, parseAbi, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { ASSETS, ECDSA_VALIDATOR } from "./chain.js";

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
export const MIN_TAKE_PROFIT_BPS = 100;
export const MAX_DRIFT_BPS = 5_000;

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

/// The domain binds a setting to Robinhood Chain and to the router whose agents follow it.
export const settingDomain = (router: Address) => ({ name: "Fillmark", version: "1", chainId: 4663, verifyingContract: router }) as const;

const typed = (router: Address, s: Setting) =>
  ({ domain: settingDomain(router), types: SETTING_TYPES, primaryType: "Setting", message: { ...s, targets: s.targets.map((t) => ({ ...t })) } }) as const;

export const settingHash = (router: Address, s: Setting): Hex => hashTypedData(typed(router, s));

/// The top 128 bits of the setting's hash: what a fill's nonce carries.
export const fingerprint = (router: Address, s: Setting): bigint => BigInt(settingHash(router, s)) >> 128n;

const LOW = (1n << 128n) - 1n;
/// A nonce for a fill under a setting: its fingerprint on top, the old derivation below.
export const withFingerprint = (fp: bigint, base: bigint): bigint => (fp << 128n) | (base & LOW);

/// The UTC day a setting takes effect: the first whole day after its validFrom.
export const effectiveDay = (s: Setting): bigint => s.validFrom / 86_400n + 1n;

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
    if (ASSETS[t.ticker] !== a) return "a target's ticker does not match its asset";
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
export const settingJson = (s: Setting) => ({ ...s, agentId: s.agentId.toString(), validFrom: s.validFrom.toString(), seq: s.seq.toString() });

export const kernelRootAbi = parseAbi(["function rootValidator() view returns (bytes21)"]);
export const validatorAbi = parseAbi(["function ecdsaValidatorStorage(address) view returns (address owner)"]);
export const ROOT_ECDSA = `0x01${ECDSA_VALIDATOR.slice(2).toLowerCase()}` as Hex;

/// The signer of a setting, or null when the signature does not parse.
export async function signerOf(router: Address, x: Signed): Promise<Address | null> {
  try {
    return getAddress(await recoverTypedDataAddress({ ...typed(router, x.setting), signature: x.signature }));
  } catch {
    return null;
  }
}

/// Signs a setting with the account owner's key (the app does the same in the owner's wallet).
export async function signSetting(router: Address, s: Setting, signer: { signTypedData: (a: any) => Promise<Hex> }): Promise<Signed> {
  return { setting: s, signature: await signer.signTypedData(typed(router, s)) };
}

/// The settings store on disk could not be written.
export class StoreError extends Error {}

/// How the agent trades an account on a day.
export type Mode =
  | { kind: "legacy" } // no setting has taken effect: the agent's own dca, with the 0.5.0 nonces
  | { kind: "dca" | "rebalance"; setting: Setting; fp: bigint; digest: Hex }
  | { kind: "blocked"; reason: string }; // a setting took effect and none is valid now: no trades

// seenDay: the UTC day the agent first saw the setting. A setting is used from the later of its
// effective day and the day after it was seen, so a setting dated in the past cannot change a
// day already under way.
type Stored = { setting: ReturnType<typeof settingJson>; signature: Hex; digest: Hex; signer: Address; seenDay: string };

/// Every setting the agent has seen for its accounts, kept on disk and never forgotten, so an
/// answer that leaves a setting out (an outage, an old copy) can never take the account back to
/// an earlier strategy. Signatures are checked here; owners are checked when a setting is used.
export class SettingsBook {
  private readonly byAccount = new Map<Address, Stored[]>();
  private haveStore = false;
  private fetched = false;
  private since: bigint | null = null; // the UTC day the store was started, null when unknown

  constructor(
    private readonly router: Address,
    private readonly agentId: bigint,
    private readonly storePath: string,
    private readonly source: { url?: string; file?: string },
    private readonly fs: { exists: (p: string) => boolean; read: (p: string) => string; write: (p: string, s: string) => void },
  ) {}

  /// Whether the agent knows which accounts have settings: a store on disk or a successful fetch.
  get known(): boolean {
    return this.haveStore || this.fetched;
  }

  load() {
    if (!this.fs.exists(this.storePath)) return;
    const raw = JSON.parse(this.fs.read(this.storePath)) as { agentId: string; router: Address; since?: string; settings: Stored[] };
    if (BigInt(raw.agentId) !== this.agentId || getAddress(raw.router) !== this.router) throw new Error(`${this.storePath} belongs to another agent or router`);
    this.since = typeof raw.since === "string" && /^\d+$/.test(raw.since) ? BigInt(raw.since) : null;
    for (const x of raw.settings) this.add(x);
    this.haveStore = true;
  }

  private add(x: Stored): boolean {
    const a = getAddress(x.setting.account);
    const list = this.byAccount.get(a) ?? [];
    if (list.some((y) => y.digest === x.digest)) return false;
    list.push(x);
    this.byAccount.set(a, list);
    return true;
  }

  /// Reads the source and keeps every new, well formed setting for this agent whose signature
  /// recovers. New settings reach memory only after the store holds them, so one the agent acts on
  /// is never seen again on a later day after a restart. Returns how many were added; throws when
  /// the source cannot be read, or StoreError when the store cannot be written.
  async refresh(fetcher: (url: string) => Promise<string>, today: bigint): Promise<number> {
    const text = this.source.file ? this.fs.read(this.source.file) : await fetcher(`${this.source.url}?agent=${this.agentId}`);
    const body = JSON.parse(text) as { settings?: { setting: unknown; signature: Hex }[] };
    if (!Array.isArray(body.settings)) throw new Error("the settings source answered without a settings list");
    const known = new Set([...this.byAccount.values()].flat().map((x) => x.digest));
    const fresh: Stored[] = [];
    for (const item of body.settings) {
      let s: Setting;
      try {
        s = parseSetting(item.setting);
      } catch {
        continue;
      }
      if (s.agentId !== this.agentId || invalidReason(s) !== null) continue;
      const digest = settingHash(this.router, s);
      if (known.has(digest)) continue; // already checked and kept
      const signer = await signerOf(this.router, { setting: s, signature: item.signature });
      if (!signer) continue;
      known.add(digest);
      fresh.push({ setting: settingJson(s), signature: item.signature, digest, signer, seenDay: today.toString() });
    }
    if (fresh.length > 0 || !this.haveStore) {
      const since = this.haveStore ? this.since : today;
      const all = [...[...this.byAccount.values()].flat(), ...fresh];
      try {
        this.fs.write(this.storePath, JSON.stringify({ agentId: this.agentId.toString(), router: this.router, since: since === null ? undefined : since.toString(), settings: all }, null, 1));
      } catch (err) {
        throw new StoreError(err instanceof Error ? err.message : String(err));
      }
      this.since = since;
      this.haveStore = true;
    }
    for (const x of fresh) this.add(x);
    this.fetched = true;
    return fresh.length;
  }

  hasSettings(account: Address): boolean {
    return (this.byAccount.get(account)?.length ?? 0) > 0;
  }

  /// The account's mode on `day`, given its owner and root validator now and its allowed assets.
  mode(account: Address, day: bigint, owner: Address | null, rootIsEcdsa: boolean, allowed: readonly Address[]): Mode {
    const all = this.byAccount.get(account) ?? [];
    if (all.length === 0) return { kind: "legacy" };
    const usableFrom = (x: Stored) => {
      const e = effectiveDay(parseSetting(x.setting));
      const seen = BigInt(x.seenDay) + 1n;
      return e > seen ? e : seen;
    };
    const list = all.filter((x) => usableFrom(x) <= day);
    if (list.length === 0) {
      // None of the account's settings was seen before today (or one starts later): the account
      // keeps the agent's own dca today, as it had it. That is known when the store already held
      // every setting seen before today, or when every setting is dated today or later. A setting
      // dated before today with a store started today (a lost store, a new machine) may have been
      // in effect already, so the account is not traded until it is.
      const startOfDay = day * 86_400n;
      const knownNew = (this.since !== null && this.since < day) || all.every((x) => BigInt(x.setting.validFrom) >= startOfDay);
      return knownNew ? { kind: "legacy" } : { kind: "blocked", reason: "a setting waits to take effect" };
    }
    let top = list[0]!;
    for (const x of list) if (BigInt(x.setting.seq) > BigInt(top.setting.seq)) top = x;
    if (list.some((x) => x.setting.seq === top.setting.seq && x.digest !== top.digest)) return { kind: "blocked", reason: "two settings share the latest seq" };
    const s = parseSetting(top.setting);
    if (!rootIsEcdsa) return { kind: "blocked", reason: "the account's root validator is not the ECDSA validator" };
    if (!owner || owner !== top.signer) return { kind: "blocked", reason: "the latest setting was not signed by the account's owner now" };
    const why = invalidReason(s, allowed);
    if (why) return { kind: "blocked", reason: why };
    return { kind: s.strategy, setting: s, fp: BigInt(top.digest) >> 128n, digest: top.digest };
  }
}
