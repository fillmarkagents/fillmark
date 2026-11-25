// Errors carry a short code and a plain sentence, never a raw RPC message: viem's messages
// can include the RPC URL, and with it an API key.

/// Why a trade or call cannot go ahead. Router errors keep their contract names; the rest are
/// the SDK's own checks.
export const REASONS: Readonly<Record<string, string>> = Object.freeze({
  // router v3
  NotInstalled: "The account has no Fillmark permission installed.",
  WrongInstall: "The account installed a new permission since the quote; quote again.",
  WrongAgent: "The account's permission is for another agent.",
  DeadlinePassed: "The quote's deadline passed; quote again.",
  PermissionExpired: "The client's permission expired (sales stay open for 7 days after it).",
  NotAgentWallet: "Only the agent wallet pinned at install may send fills.",
  NonceUsed: "This fill was already sent.",
  WalletChanged: "The agent's ERC-8004 wallet changed since the client installed it.",
  BadPair: "A fill swaps USDG for an asset or an asset for USDG.",
  StockNotAllowed: "The client did not allow this asset.",
  NoPool: "The router has no active pool for this asset.",
  NoTwap: "The asset's pool does not keep enough price history.",
  UnknownStock: "The Fillmark feeds do not price this asset.",
  DecimalsChanged: "The token's decimals changed; the router will not price it.",
  MarketClosed: "The market for this asset is closed now.",
  BadFeed: "The asset's Chainlink feed returned an unusable answer.",
  StaleFeed: "The asset's Chainlink price is too old.",
  OraclePaused: "The stock token's oracle is paused.",
  MultiplierNotPriced: "A stock split or similar change is not yet in the Chainlink price.",
  RegularHoursOnly: "The client allows fills in the regular US session only.",
  InDebt: "The account owes this agent fees; buys are refused until it is paid.",
  NotAgentUnits: "An agent sells only units it bought for the account.",
  PartialFill: "The pool could not fill the whole amount inside the price limit.",
  TooLittleOut: "The pool paid less than the minimum.",
  PriceOutOfRange: "The trade would move the pool price past the router's bound.",
  WorseThanNav: "The fill would be worse than the client's limit against the Chainlink price.",
  TooSmall: "A fill must be at least 10 USDG (except a sale of the whole lot).",
  OverTradeLimit: "Over the client's per-trade limit.",
  OverDailyLimit: "Over the client's rolling 24-hour buy limit.",
  PaymentFailed: "A USDG payment failed (USDG may be paused or the address frozen).",
  LowGas: "The transaction had too little gas.",
  // the SDK's own checks
  NoUsdg: "The account does not hold the USDG plus the fill fee.",
  NoUnits: "The account holds none of the agent's units of this asset.",
  SizeTooLarge: "The pool is too thin for this size inside the client's slippage; trade less.",
  NoQuote: "The pool gave no quote.",
  NotPlainKernel: "Only standard Kernel accounts without hooks are traded.",
  GasTooHigh: "The fill needs more gas than the 1,500,000 cap.",
  BelowCost: "The sale would not cover the lot's cost after the fill fee (policy).",
  HoldPeriod: "A sale's gain is still waiting; a buy now would cancel it (policy).",
  PairCap: "The daily fill cap for this account and asset is reached (policy).",
  Pending: "An earlier fill for this account and asset is still pending.",
  RevertedToday: "A fill for this account reverted on chain today; skipped until tomorrow.",
  DailyCap: "The agent's daily fill cap is reached.",
  NoWallet: "A wallet client with the agent wallet is needed to send.",
  WrongChain: "The RPC is not Robinhood Chain (4663).",
  LowEth: "The agent wallet's ETH is under its gas reserve.",
  SendFailed: "The fill could not be sent.",
  RevertedOnChain: "The transaction reverted on chain.",
  ClockSkew: "The RPC's block time is too far off the local clock.",
  RpcError: "A read or send through the RPC failed.",
  UnknownQuote: "This quote was not made by this agent instance.",
  Unreadable: "The asset's state could not be read.",
});

export class FillmarkError extends Error {
  constructor(
    readonly code: string,
    message = REASONS[code] ?? code,
  ) {
    super(message);
    this.name = "FillmarkError";
  }
}

/// A short, safe name for a failed call: the contract error with its arguments, a revert
/// string, or the error selector. Never the full viem message.
export function errorName(err: unknown): string {
  if (err instanceof FillmarkError) return err.code;
  const plain = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  for (let e: any = err; e; e = e.cause) {
    if (e.data?.errorName) return e.data.args?.length ? `${e.data.errorName}${plain(e.data.args)}` : e.data.errorName;
    if (e.reason) return `reverted: ${String(e.reason).slice(0, 200)}`;
    if (e.signature) return `unknown error ${e.signature}`;
  }
  for (let e: any = err; e; e = e.cause) {
    const n = e?.name;
    if (typeof n === "string" && /^[A-Za-z]+Error$/.test(n) && n !== "Error") return n;
  }
  return "Error";
}

/// The error name without arguments, mapped to the SDK's codes where the router reuses one.
export function reasonCode(err: unknown, deadline?: bigint, now?: bigint): string {
  const name = errorName(err).replace(/\[.*$/, "");
  if (name === "Expired")
    return deadline !== undefined && now !== undefined && now > deadline ? "DeadlinePassed" : "PermissionExpired";
  return name;
}

/// Wraps an SDK function so that nothing but a FillmarkError leaves it: any other error becomes
/// "RpcError" with its short name, and its cause (which may hold the RPC URL) is dropped.
export function safely<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof FillmarkError) throw err;
      throw new FillmarkError("RpcError", `${REASONS.RpcError} (${errorName(err)})`);
    }
  };
}
