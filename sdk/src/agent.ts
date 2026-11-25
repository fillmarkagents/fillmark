import {
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { ADDRESSES, ASSETS, CHAIN_ID, ROUTER_DEPLOY_BLOCK, assetOf } from "./addresses.js";
import { isPlainKernel } from "./account.js";
import { FillmarkError, REASONS, errorName, reasonCode, safely } from "./errors.js";
import { feedsAbi, payAbi, routerAbi } from "./generated/abi.js";
import { MIN_NOTIONAL, buyRoom, costFloor, diffPpm, navValue, priceLimit, spotPrice } from "./math.js";
import { many, tryMany } from "./multicall.js";
import { memoryStore, type Store } from "./store.js";

const DAY = 86_400n;
const GAS_CAP = 1_500_000n; // a fill is sent with this fixed limit, never the bare estimate
const SESSIONS = ["Closed", "Extended", "Regular"] as const;
const PAY_WAITS = ["None", "NotOpen", "NothingDue", "NoToken", "BurnThisBlock", "BlockBudget", "Balance", "Allowance"] as const;

const quoterAbi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16 cardinality, uint16, uint8, bool)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);
const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
const stockAbi = parseAbi([
  "function oraclePaused() view returns (bool)",
  "function effectiveAt() view returns (uint256)",
  "function uiMultiplier() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const identityAbi = parseAbi(["function getAgentWallet(uint256 agentId) view returns (address)"]);

export type Session = (typeof SESSIONS)[number];

/// FillmarkRouterV3.FillIntent.
export type FillIntent = {
  agentId: bigint;
  account: Address;
  installId: bigint;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minOut: bigint;
  sqrtPriceLimitX96: bigint;
  nonce: bigint;
  deadline: bigint;
};

/// Rules the SDK applies to every fill. saleAboveCost and noBuyDuringHold can be turned off and
/// the caps changed; the rest always apply: nonces from the account, asset and day, one send at a
/// time per wallet, standard Kernel accounts only, an account skipped for the day after a fill
/// reverts, and every send counted.
export type Policy = {
  saleAboveCost: boolean; // no sale under the lot's cost after the fill fee
  noBuyDuringHold: boolean; // no buy while a sale's gain waits out the router's hold
  maxFillsPerPairPerDay: number; // per account and asset, 1 to 50
  maxFillsPerDay: number; // sends per UTC day across all accounts, 1 to 100000
  minOutBufferBps: number; // minOut below the quote, 0 to 1000
  deadlineSec: number; // 30 to 3600
  saleMarginBps: number; // room in a sale's size for the pool and the feed to move before it lands, 0 to 1000
  minEth: bigint; // the agent wallet keeps at least this much ETH for gas
};

export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  saleAboveCost: true,
  noBuyDuringHold: true,
  maxFillsPerPairPerDay: 2,
  maxFillsPerDay: 300,
  minOutBufferBps: 30,
  deadlineSec: 300,
  saleMarginBps: 100,
  minEth: parseEther("0.0005"),
});

function policyOf(given: Partial<Policy> = {}): Policy {
  const p: any = { ...DEFAULT_POLICY };
  for (const [k, v] of Object.entries(given)) {
    if (!(k in DEFAULT_POLICY)) throw new Error(`unknown policy field ${k}`);
    if (v !== undefined) p[k] = v;
  }
  const int = (k: keyof Policy, lo: number, hi: number) => {
    if (!Number.isInteger(p[k]) || p[k] < lo || p[k] > hi) throw new Error(`policy.${k} must be an integer from ${lo} to ${hi}`);
  };
  int("maxFillsPerPairPerDay", 1, 50);
  int("maxFillsPerDay", 1, 100_000);
  int("minOutBufferBps", 0, 1000);
  int("deadlineSec", 30, 3600);
  int("saleMarginBps", 0, 1000);
  if (typeof p.saleAboveCost !== "boolean" || typeof p.noBuyDuringHold !== "boolean")
    throw new Error("policy flags must be booleans");
  if (typeof p.minEth !== "bigint" || p.minEth < 0n) throw new Error("policy.minEth must be a non-negative bigint (wei)");
  return Object.freeze(p);
}

export type Client = {
  account: Address;
  installId: bigint;
  maxPerTrade: bigint;
  dailyLimit: bigint;
  maxSlipBps: number;
  perfFeeBps: number;
  expiry: bigint;
  regularOnly: boolean;
  assets: Address[];
  usdg: bigint;
  spent: bigint; // buys and their fill fees in the router's rolling window
  debt: bigint; // fees owed to this agent; buys are refused until paid
  canBuy: boolean;
  sellUntil: bigint;
  plainKernel: boolean;
};

export type Market = {
  token: Address;
  ticker: string | undefined;
  session: Session | undefined;
  price: bigint | undefined; // Chainlink, 8 decimals
  priceAge: bigint | undefined;
  maxAge: number | undefined;
  pool: Address | undefined;
  poolFee: number | undefined;
  capBps: number | undefined;
  twapCapBps: number | undefined;
  spot: bigint | undefined; // pool price, 8 decimals
  premiumPpm: bigint | undefined; // spot over Chainlink, millionths
  tradable: boolean;
  reason: string | undefined;
};

export type Quote =
  | {
      readonly ok: true;
      readonly side: "buy" | "sell";
      readonly token: Address;
      readonly intent: Readonly<FillIntent>;
      readonly expectedOut: bigint;
      readonly minOut: bigint;
      readonly navValue: bigint; // USDG value of the asset side at the Chainlink price
      readonly expectedPpm: bigint; // expected fill price against Chainlink, millionths, positive = worse for the client
      readonly boundBps: number; // the router's NAV bound for this fill: min(client limit - fill fee, pool cap)
      readonly twapBoundBps: number; // and its bound against the pool's TWAP: min(that, pool TWAP cap)
    }
  | { readonly ok: false; readonly reason: string; readonly message: string };

export type FillResult = {
  hash: Hex;
  side: "buy" | "sell";
  token: Address;
  usdg: bigint;
  units: bigint;
  fillFee: bigint;
  nav: bigint;
  fillPrice: bigint;
  shortfallPpm: bigint; // fill price against Chainlink, positive = worse for the client
  costUsdg: bigint; // USDG over (buy) or under (sale) the Chainlink value
  feedbackRefused: number;
};

type Lot = { qty: bigint; cost: bigint };
type Hold = { gain: bigint; qty: bigint; until: bigint; esc: bigint };
export type Position = {
  token: Address;
  lot: Lot;
  pending: Hold;
  later: Hold;
  movedOut: { qty: bigint; gain: bigint; loss: bigint; until: bigint };
};
export type Book = {
  realized: bigint;
  peak: bigint;
  debt: bigint;
  paid: bigint;
  escMatured: bigint;
  outLoss: bigint;
  wallet: Address;
  perfFeeBps: number;
  closing: boolean;
  closingAt: bigint;
  positions: Position[];
};

export type AgentOptions = {
  publicClient: PublicClient; // its chain must know Multicall3 (viem's robinhood chain does)
  walletClient?: WalletClient;
  agentId: bigint;
  policy?: Partial<Policy>;
  store?: Store;
  fromBlock?: bigint;
  extraTokens?: Address[]; // tokens beyond the bundled list, if the feeds add more
  maxClockSkewSec?: number; // the RPC's block time may be this far off the local clock (default 300)
  receiptTimeoutMs?: number; // how long a send waits for its receipt (default 120000)
};

/// An address in any letter case, checksummed. (A mixed-case typo is not refused, since the
/// account it names simply has no Fillmark permission.)
const addr = (a: string): Address => getAddress(a.toLowerCase());

/// A token by ticker or address; an unknown ticker or malformed address is UnknownStock.
function tokenOf(asset: string): Address {
  const a = assetOf(asset);
  if (a) return a.token;
  if (!/^0x[0-9a-fA-F]{40}$/.test(asset)) throw new FillmarkError("UnknownStock", `Unknown asset ${asset}.`);
  return getAddress(asset.toLowerCase());
}

const refuse = (reason: string, message = REASONS[reason] ?? reason): Quote => Object.freeze({ ok: false, reason, message });

// One send at a time per wallet, across every agent instance in this process.
const queues = new Map<Address, Promise<unknown>>();
function serial<T>(wallet: Address, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(wallet) ?? Promise.resolve()).then(fn);
  queues.set(
    wallet,
    run.catch(() => undefined),
  );
  return run;
}

/// A Fillmark agent: finds its clients, sizes and quotes fills, and sends them from the agent
/// wallet pinned at install. The router enforces every client limit; this adds the Policy.
export function fillmarkAgent(opts: AgentOptions) {
  const pub = opts.publicClient;
  const wallet = opts.walletClient;
  const agentId = opts.agentId;
  const policy = policyOf(opts.policy);
  const store = opts.store ?? memoryStore();
  const maxSkew = BigInt(opts.maxClockSkewSec ?? 300);
  const receiptTimeout = opts.receiptTimeoutMs ?? 120_000;
  const router = ADDRESSES.router;
  const usdg = ADDRESSES.usdg;
  const tokens = [
    ...new Set([...ASSETS.map((a) => a.token), ...(opts.extraTokens ?? []).map((t) => getAddress(t.toLowerCase()))]),
  ];
  const sendWallet = wallet?.account?.address ? getAddress(wallet.account.address) : undefined;
  const ns = `${router}:${agentId}:`; // store keys of this agent on this router
  const issued = new WeakSet<object>(); // quotes this instance made

  let scanned = (opts.fromBlock ?? ROUTER_DEPLOY_BLOCK) - 1n;
  let span = 5_000_000n;
  const candidates = new Set<Address>();

  const read = <T>(address: Address, abi: any, functionName: string, args: readonly unknown[] = []) =>
    pub.readContract({ address, abi, functionName, args }) as Promise<T>;

  /// The chain's time, refused when the RPC is far off the local clock.
  async function now(): Promise<bigint> {
    const t = (await pub.getBlock()).timestamp;
    const local = BigInt(Math.floor(Date.now() / 1000));
    if ((t > local ? t - local : local - t) > maxSkew) throw new FillmarkError("ClockSkew");
    return t;
  }

  const agentWallet = () => read<Address>(ADDRESSES.identity, identityAbi, "getAgentWallet", [agentId]);

  async function check() {
    if ((await pub.getChainId()) !== CHAIN_ID) throw new FillmarkError("WrongChain");
    await now();
    const pinned = await agentWallet();
    if (pinned === zeroAddress) throw new FillmarkError("NotAgentWallet", `Agent ${agentId} has no wallet set.`);
    if (sendWallet && sendWallet !== pinned)
      throw new FillmarkError("NotAgentWallet", `The wallet client is ${sendWallet}; agent ${agentId}'s wallet is ${pinned}.`);
    return { agentWallet: pinned, eth: await pub.getBalance({ address: pinned }), canSend: sendWallet === pinned };
  }

  /// New Installed events for this agent. The range shrinks when the RPC refuses it and grows
  /// back after it succeeds.
  async function discover() {
    const head = await pub.getBlockNumber();
    let from = scanned + 1n;
    while (from <= head) {
      const to = from + span - 1n < head ? from + span - 1n : head;
      let logs;
      try {
        logs = await pub.getContractEvents({
          address: router,
          abi: routerAbi,
          eventName: "Installed",
          args: { agentId },
          fromBlock: from,
          toBlock: to,
          strict: true,
        });
      } catch (err) {
        if (span <= 50_000n) throw err;
        span /= 4n;
        continue;
      }
      for (const l of logs) candidates.add(getAddress(l.args.account));
      scanned = to;
      from = to + 1n;
      if (span < 5_000_000n) span *= 2n;
    }
  }

  /// Accounts open to this agent now, with their limits and state.
  async function clients(): Promise<Client[]> {
    await discover();
    const t = await now();
    const list = [...candidates];
    if (list.length === 0) return [];
    const [pinned, grace] = await Promise.all([agentWallet(), read<bigint>(router, routerAbi, "SELL_GRACE")]);
    const reads = await many(
      pub,
      list.flatMap((account) => [
        { address: router, abi: routerAbi, functionName: "configs", args: [account] },
        { address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [account] },
        { address: router, abi: routerAbi, functionName: "bookOf", args: [account, agentId] },
        { address: router, abi: routerAbi, functionName: "windowSpent", args: [account] },
        ...tokens.map((token) => ({ address: router, abi: routerAbi, functionName: "isAllowed", args: [account, token] })),
      ]),
    );
    const per = 4 + tokens.length;
    const open = list
      .map((account, i) => {
        const r = reads.slice(per * i, per * i + per);
        const [id, cWallet, maxSlipBps, perfFeeBps, expiry, installId, installed, regularOnly, maxPerTrade, dailyLimit] = r[0];
        if (!installed || id !== agentId || cWallet !== pinned || expiry + grace < t) return undefined;
        const debt = r[2].debt as bigint;
        return {
          account,
          installId,
          maxPerTrade,
          dailyLimit,
          maxSlipBps,
          perfFeeBps,
          expiry,
          regularOnly,
          assets: tokens.filter((_, k) => r[4 + k] === true),
          usdg: r[1],
          spent: r[3],
          debt,
          canBuy: expiry >= t && debt === 0n && maxPerTrade >= MIN_NOTIONAL,
          sellUntil: expiry + grace,
          plainKernel: false,
        } as Client;
      })
      .filter((c): c is Client => c !== undefined);
    await Promise.all(open.map(async (c) => (c.plainKernel = await isPlainKernel(pub, c.account))));
    return open;
  }

  /// One token's session, prices and pool, checked in the router's order.
  async function marketOf(token: Address, t: bigint, minCard: bigint, twapWindow: number): Promise<Market> {
    const m: Market = {
      token,
      ticker: assetOf(token)?.ticker,
      session: undefined,
      price: undefined,
      priceAge: undefined,
      maxAge: undefined,
      pool: undefined,
      poolFee: undefined,
      capBps: undefined,
      twapCapBps: undefined,
      spot: undefined,
      premiumPpm: undefined,
      tradable: false,
      reason: undefined,
    };
    const no = (reason: string) => ({ ...m, reason });
    try {
      const [src, pc] = await many(pub, [
        { address: ADDRESSES.feeds, abi: feedsAbi, functionName: "sourceOf", args: [token, t] },
        { address: router, abi: routerAbi, functionName: "poolOf", args: [token] },
      ]);
      m.session = SESSIONS[src.session];
      m.maxAge = src.maxAge;
      if (pc.active) Object.assign(m, { pool: pc.pool, poolFee: pc.fee, capBps: pc.capBps, twapCapBps: pc.twapCapBps });
      // _prepare: the pool and its price history first.
      if (!pc.active) return no("NoPool");
      const [sqrtP, , , cardinality] = await read<readonly [bigint, number, number, number]>(pc.pool, poolAbi, "slot0");
      if (BigInt(cardinality) < minCard) return no("NoTwap");
      try {
        await read(pc.pool, poolAbi, "observe", [[twapWindow, 0]]);
      } catch {
        return no("NoTwap");
      }
      // _priced: the feed and the token.
      if (src.feed === zeroAddress) return no("UnknownStock");
      const dec = await tryMany(pub, [{ address: token, abi: stockAbi, functionName: "decimals" }]);
      if (dec[0].status !== "success" || Number(dec[0].result) !== src.decimals) return no("DecimalsChanged");
      if (m.session === "Closed") return no("MarketClosed");
      const round = await tryMany(pub, [
        { address: src.feed, abi: aggregatorAbi, functionName: "latestRoundData" },
        { address: src.feed, abi: aggregatorAbi, functionName: "decimals" },
      ]);
      if (round[0].status !== "success" || round[1].status !== "success") return no("BadFeed");
      const [, answer, startedAt, updatedAt] = round[0].result as readonly [bigint, bigint, bigint, bigint];
      if (answer <= 0n || Number(round[1].result) !== 8) return no("BadFeed");
      m.price = answer;
      m.priceAge = t - updatedAt;
      if (updatedAt > t || t - updatedAt > BigInt(src.maxAge)) return no("StaleFeed");
      m.spot = spotPrice(sqrtP, BigInt(token) < BigInt(usdg), src.decimals);
      m.premiumPpm = diffPpm(m.spot, answer);
      if (!src.crypto) {
        if (await read<boolean>(token, stockAbi, "oraclePaused")) return no("OraclePaused");
        if (src.multiplierInFeed) {
          const at = await read<bigint>(token, stockAbi, "effectiveAt");
          if (at >= startedAt && at <= t) return no("MultiplierNotPriced");
        } else if ((await read<bigint>(token, stockAbi, "uiMultiplier")) !== 10n ** 18n) return no("MultiplierNotPriced");
      }
      return { ...m, tradable: true };
    } catch (err) {
      return no(`Unreadable: ${errorName(err)}`);
    }
  }

  async function market(list: Address[] = tokens): Promise<Market[]> {
    const t = await now();
    const [minCard, twapWindow] = await Promise.all([
      read<bigint>(router, routerAbi, "minCardinality"),
      read<number>(router, routerAbi, "twapWindow"),
    ]);
    return Promise.all(list.map((token) => marketOf(token, t, minCard, twapWindow)));
  }

  const dayOf = (t: bigint) => t / DAY;
  const pendingKey = (account: Address, token: Address) => `${ns}pending:${account}:${token}`;
  const bannedKey = (day: bigint, account: Address) => `${ns}banned:${day}:${account}`;
  const sentKey = (day: bigint) => `${ns}sent:${day}`;

  /// The nonce of the n-th fill of an asset for an account on a UTC day, under one install.
  function nonceOf(installId: bigint, account: Address, token: Address, day: bigint, n: bigint): bigint {
    const types = ["string", "address", "uint256", "uint64", "address", "address", "uint256", "uint256"].map((type) => ({
      type,
    }));
    return BigInt(keccak256(encodeAbiParameters(types, ["fillmark-sdk-v1", router, agentId, installId, account, token, day, n])));
  }

  /// The next unused nonce index for the pair today, or undefined when the pair cap is reached.
  async function nextIndex(installId: bigint, account: Address, token: Address, day: bigint): Promise<bigint | undefined> {
    const used = await many(
      pub,
      Array.from({ length: policy.maxFillsPerPairPerDay }, (_, n) => ({
        address: router,
        abi: routerAbi,
        functionName: "nonceUsed",
        args: [account, nonceOf(installId, account, token, day, BigInt(n))],
      })),
    );
    const n = used.findIndex((u) => u === false);
    return n === -1 ? undefined : BigInt(n);
  }

  const indexKey = (account: Address) => `${ns}pendingTokens:${account}`;
  const pendingTokens = (account: Address): Address[] => JSON.parse(store.get(indexKey(account)) ?? "[]");

  function markPending(account: Address, token: Address, value: { hash?: Hex; deadline: bigint; nonce: bigint }) {
    store.set(
      pendingKey(account, token),
      JSON.stringify({ hash: value.hash, deadline: String(value.deadline), nonce: String(value.nonce) }),
    );
    const list = pendingTokens(account);
    if (!list.includes(token)) store.set(indexKey(account), JSON.stringify([...list, token]));
  }

  function clearPending(account: Address, token: Address) {
    store.set(pendingKey(account, token), undefined);
    const list = pendingTokens(account).filter((x) => x !== token);
    store.set(indexKey(account), list.length ? JSON.stringify(list) : undefined);
  }

  /// Settles every pending fill of an account: one that landed or can no longer land is cleared,
  /// one that reverted skips the account for its day. Returns the tokens still pending.
  async function resolvePending(account: Address, t: bigint): Promise<Set<Address>> {
    const open = new Set<Address>();
    for (const token of pendingTokens(account)) {
      const raw = store.get(pendingKey(account, token));
      if (!raw) {
        clearPending(account, token);
        continue;
      }
      const p = JSON.parse(raw) as { hash?: Hex; deadline: string; nonce: string };
      const receipt = p.hash ? await pub.getTransactionReceipt({ hash: p.hash }).catch(() => undefined) : undefined;
      if (receipt && receipt.status !== "success") store.set(bannedKey(dayOf(BigInt(p.deadline)), account), p.hash);
      const used = await read<boolean>(router, routerAbi, "nonceUsed", [account, BigInt(p.nonce)]);
      // Cleared only if no newer fill replaced the entry while this was being read.
      if (receipt || used || t > BigInt(p.deadline)) {
        if (store.get(pendingKey(account, token)) === raw) clearPending(account, token);
      } else open.add(token);
    }
    return open;
  }

  /// The day's send count; a count that is not a whole number reads as the cap reached.
  function sendsLeft(day: bigint): boolean {
    const raw = store.get(sentKey(day));
    const sent = raw === undefined ? 0 : Number(raw);
    return Number.isInteger(sent) && sent >= 0 && sent < policy.maxFillsPerDay;
  }
  const countSend = (day: bigint) => store.set(sentKey(day), String(Number(store.get(sentKey(day)) ?? "0") + 1));

  type Ctx = {
    t: bigint;
    token: Address;
    decimals: number;
    cfg: {
      agentId: bigint;
      wallet: Address;
      maxSlipBps: number;
      expiry: bigint;
      installId: bigint;
      installed: boolean;
      regularOnly: boolean;
      maxPerTrade: bigint;
      dailyLimit: bigint;
    };
    allowed: boolean;
    usdgBal: bigint;
    unitBal: bigint;
    spent: bigint;
    debt: bigint;
    fee: bigint;
    lot: Lot; // as the router will see it after syncing to the balance
    waiting: boolean; // a sale's gain is still inside the router's hold
    grace: bigint;
    pinned: Address;
  };

  async function context(account: Address, asset: string): Promise<Ctx | Quote> {
    const token = assetOf(asset)?.token ?? (/^0x[0-9a-fA-F]{40}$/.test(asset) ? getAddress(asset.toLowerCase()) : undefined);
    if (!token) return refuse("UnknownStock", `Unknown asset ${asset}.`);
    const t = await now();
    const [config, allowed, usdgBal, unitBal, spent, book, position, fee, grace, pinned, src] = await many(pub, [
      { address: router, abi: routerAbi, functionName: "configs", args: [account] },
      { address: router, abi: routerAbi, functionName: "isAllowed", args: [account, token] },
      { address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [account] },
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] },
      { address: router, abi: routerAbi, functionName: "windowSpent", args: [account] },
      { address: router, abi: routerAbi, functionName: "bookOf", args: [account, agentId] },
      { address: router, abi: routerAbi, functionName: "positionOf", args: [account, agentId, token] },
      { address: router, abi: routerAbi, functionName: "fillFeeBps" },
      { address: router, abi: routerAbi, functionName: "SELL_GRACE" },
      { address: ADDRESSES.identity, abi: identityAbi, functionName: "getAgentWallet", args: [agentId] },
      { address: ADDRESSES.feeds, abi: feedsAbi, functionName: "sourceOf", args: [token, t] },
    ]);
    const [id, cWallet, maxSlipBps, , expiry, installId, installed, regularOnly, maxPerTrade, dailyLimit] = config;
    const [rawLot, pending, later] = position;
    // The router first moves out units the account no longer holds (_syncToken): the lot shrinks
    // to the balance and its cost in proportion, rounded as the router rounds.
    let lot: Lot = { qty: rawLot.qty, cost: rawLot.cost };
    if (unitBal < lot.qty) {
      const out = lot.qty - unitBal;
      lot = { qty: unitBal, cost: lot.cost - (lot.cost * out + lot.qty - 1n) / lot.qty };
    }
    const live = (h: Hold) => h.gain > 0n && h.until > t; // a matured gain no longer waits
    return {
      t,
      token,
      decimals: src.decimals,
      cfg: { agentId: id, wallet: cWallet, maxSlipBps, expiry, installId, installed, regularOnly, maxPerTrade, dailyLimit },
      allowed,
      usdgBal,
      unitBal,
      spent,
      debt: book.debt,
      fee: BigInt(fee),
      lot,
      waiting: live(pending) || live(later),
      grace,
      pinned,
    };
  }

  /// The checks every fill shares, in the router's order.
  async function common(c: Ctx, account: Address, buy: boolean): Promise<Quote | Market> {
    if (!c.cfg.installed) return refuse("NotInstalled");
    if (c.cfg.agentId !== agentId) return refuse("WrongAgent");
    if (sendWallet && sendWallet !== c.cfg.wallet) return refuse("NotAgentWallet");
    if (c.cfg.wallet !== c.pinned) return refuse("WalletChanged");
    if (!c.allowed) return refuse("StockNotAllowed");
    if (c.t > c.cfg.expiry + (buy ? 0n : c.grace)) return refuse("PermissionExpired");
    const [m] = await market([c.token]);
    if (!m.tradable) return refuse(m.reason!.startsWith("Unreadable") ? "Unreadable" : m.reason!, REASONS[m.reason!] ?? m.reason);
    if (c.cfg.regularOnly && m.session !== "Regular") return refuse("RegularHoursOnly");
    if ((await resolvePending(account, c.t)).has(c.token)) return refuse("Pending"); // may record a revert first
    if (store.get(bannedKey(dayOf(c.t), account))) return refuse("RevertedToday");
    if (!(await isPlainKernel(pub, account))) return refuse("NotPlainKernel");
    return m;
  }

  /// The router's bounds on this fill's price against NAV and against the pool's TWAP.
  function bounds(c: Ctx, m: Market) {
    const nav = Math.min(Math.max(c.cfg.maxSlipBps - Number(c.fee), 0), m.capBps!);
    return { boundBps: nav, twapBoundBps: Math.min(nav, m.twapCapBps!) };
  }

  /// An intent's deadline: deadlineSec ahead, never past the day its nonce belongs to, the
  /// client's permission, or the Chainlink price going stale.
  function deadlineOf(c: Ctx, m: Market, buy: boolean): bigint {
    const caps = [
      c.t + BigInt(policy.deadlineSec),
      (dayOf(c.t) + 1n) * DAY - 1n,
      c.cfg.expiry + (buy ? 0n : c.grace),
      c.t + BigInt(m.maxAge!) - m.priceAge!,
    ];
    return caps.reduce((a, b) => (a < b ? a : b));
  }

  function buySize(c: Ctx): bigint {
    const room = buyRoom(c.cfg.maxPerTrade, c.cfg.dailyLimit, c.spent, c.fee);
    const afford = (c.usdgBal * 10_000n) / (10_000n + c.fee);
    const a = room < afford ? room : afford;
    return a < MIN_NOTIONAL ? 0n : a;
  }

  async function quote(fee: number, tokenIn: Address, tokenOut: Address, amountIn: bigint, limit: bigint) {
    const { result } = await pub.simulateContract({
      address: ADDRESSES.quoter,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: limit }],
    });
    return { out: result[0], after: result[1] };
  }

  /// Simulates the fill from the agent wallet: the router has the last word.
  async function simulate(it: FillIntent, t: bigint): Promise<Quote | undefined> {
    try {
      await pub.simulateContract({
        address: router,
        abi: routerAbi,
        functionName: "execute",
        args: [it],
        account: sendWallet ?? (await agentWallet()),
      });
      return undefined;
    } catch (err) {
      return refuse(reasonCode(err, it.deadline, t));
    }
  }

  function issue(q: Extract<Quote, { ok: true }>): Quote {
    Object.freeze(q.intent);
    issued.add(Object.freeze(q));
    return q;
  }

  async function quoteBuy(args: { account: Address; asset: string; usdgIn?: bigint }): Promise<Quote> {
    const account = addr(args.account);
    const c = await context(account, args.asset);
    if ("ok" in c) return c;
    const m = await common(c, account, true);
    if ("ok" in m) return m;
    if (c.debt > 0n) return refuse("InDebt");
    const amount = args.usdgIn ?? buySize(c);
    if (amount === 0n && args.usdgIn === undefined)
      return refuse(buyRoom(c.cfg.maxPerTrade, c.cfg.dailyLimit, c.spent, c.fee) === 0n ? "OverDailyLimit" : "NoUsdg");
    if (amount < MIN_NOTIONAL) return refuse("TooSmall");
    if (amount > c.cfg.maxPerTrade) return refuse("OverTradeLimit");
    const fillFee = (amount * c.fee) / 10_000n;
    if (c.spent + amount + fillFee > c.cfg.dailyLimit) return refuse("OverDailyLimit");
    if (c.usdgBal < amount + fillFee) return refuse("NoUsdg");
    if (policy.noBuyDuringHold && c.waiting) return refuse("HoldPeriod");
    const day = dayOf(c.t);
    const n = await nextIndex(c.cfg.installId, account, c.token, day);
    if (n === undefined) return refuse("PairCap");

    const [sqrtP] = await read<readonly [bigint]>(m.pool!, poolAbi, "slot0");
    const limit = priceLimit(sqrtP, c.token, usdg, true, c.cfg.maxSlipBps);
    let q;
    try {
      q = await quote(m.poolFee!, usdg, c.token, amount, limit);
    } catch {
      return refuse("NoQuote");
    }
    if (q.after === limit || q.out === 0n) return refuse("SizeTooLarge");
    const minOut = (q.out * BigInt(10_000 - policy.minOutBufferBps)) / 10_000n;
    const intent: FillIntent = {
      agentId,
      account,
      installId: c.cfg.installId,
      tokenIn: usdg,
      tokenOut: c.token,
      amountIn: amount,
      minOut,
      sqrtPriceLimitX96: limit,
      nonce: nonceOf(c.cfg.installId, account, c.token, day, n),
      deadline: deadlineOf(c, m, true),
    };
    const bad = await simulate(intent, c.t);
    if (bad) return bad;
    const fillPrice = (amount * 10n ** BigInt(c.decimals + 2)) / q.out;
    return issue({
      ok: true,
      side: "buy",
      token: c.token,
      intent,
      expectedOut: q.out,
      minOut,
      navValue: navValue(q.out, m.price!, c.decimals),
      expectedPpm: diffPpm(fillPrice, m.price!),
      ...bounds(c, m),
    });
  }

  /// The most lot units a sale may carry now: inside the per-trade limit with room for the pool
  /// and the feed to move, never more than the lot or the balance. A lot worth under 10 USDG is
  /// sold whole.
  function sellUnits(c: Ctx, price: bigint): bigint {
    if (c.lot.qty === 0n) return 0n;
    if (navValue(c.lot.qty, price, c.decimals) < MIN_NOTIONAL) return c.lot.qty;
    const capOut = (c.cfg.maxPerTrade * BigInt(10_000 - policy.saleMarginBps)) / 10_000n;
    const capUnits = (capOut * 10n ** BigInt(c.decimals + 2)) / price;
    return c.lot.qty < capUnits ? c.lot.qty : capUnits;
  }

  async function maxSell(account: Address, asset: string): Promise<bigint> {
    const c = await context(addr(account), asset);
    if ("ok" in c) return 0n;
    const [m] = await market([c.token]);
    return m.price ? sellUnits(c, m.price) : 0n;
  }

  async function maxBuy(account: Address, asset: string): Promise<bigint> {
    const c = await context(addr(account), asset);
    return "ok" in c ? 0n : buySize(c);
  }

  async function quoteSell(args: { account: Address; asset: string; units?: bigint }): Promise<Quote> {
    const account = addr(args.account);
    const c = await context(account, args.asset);
    if ("ok" in c) return c;
    const m = await common(c, account, false);
    if ("ok" in m) return m;
    if (c.lot.qty === 0n) return refuse("NotAgentUnits");
    let units = args.units ?? sellUnits(c, m.price!);
    if (units === 0n) return refuse("TooSmall");
    if (units > c.lot.qty) return refuse(units > c.unitBal ? "NoUnits" : "NotAgentUnits");
    const day = dayOf(c.t);
    const n = await nextIndex(c.cfg.installId, account, c.token, day);
    if (n === undefined) return refuse("PairCap");

    const [sqrtP] = await read<readonly [bigint]>(m.pool!, poolAbi, "slot0");
    const limit = priceLimit(sqrtP, c.token, usdg, false, c.cfg.maxSlipBps);
    const capOut = (c.cfg.maxPerTrade * BigInt(10_000 - policy.saleMarginBps)) / 10_000n;
    let q;
    try {
      q = await quote(m.poolFee!, c.token, usdg, units, limit);
      // Sized by the SDK: a pool paying over the Chainlink price takes fewer units.
      for (let i = 0; args.units === undefined && units !== c.lot.qty && i < 4 && q.out > capOut && units > 0n; i++) {
        units = (units * capOut * 9_999n) / (q.out * 10_000n);
        if (units > 0n) q = await quote(m.poolFee!, c.token, usdg, units, limit);
      }
    } catch {
      return refuse("NoQuote");
    }
    if (units === 0n) return refuse("TooSmall");
    if (q.after === limit || q.out === 0n) return refuse("SizeTooLarge");
    const value = navValue(units, m.price!, c.decimals);
    if ((q.out > value ? q.out : value) > c.cfg.maxPerTrade) return refuse("OverTradeLimit");
    const minOut = (q.out * BigInt(10_000 - policy.minOutBufferBps)) / 10_000n;
    if (minOut < MIN_NOTIONAL && units !== c.lot.qty) return refuse("TooSmall");
    if (policy.saleAboveCost && minOut < costFloor(c.lot.qty, c.lot.cost, units, c.fee)) return refuse("BelowCost");
    const intent: FillIntent = {
      agentId,
      account,
      installId: c.cfg.installId,
      tokenIn: c.token,
      tokenOut: usdg,
      amountIn: units,
      minOut,
      sqrtPriceLimitX96: limit,
      nonce: nonceOf(c.cfg.installId, account, c.token, day, n),
      deadline: deadlineOf(c, m, false),
    };
    const bad = await simulate(intent, c.t);
    if (bad) return bad;
    const fillPrice = (q.out * 10n ** BigInt(c.decimals + 2)) / units;
    return issue({
      ok: true,
      side: "sell",
      token: c.token,
      intent,
      expectedOut: q.out,
      minOut,
      navValue: value,
      expectedPpm: -diffPpm(fillPrice, m.price!),
      ...bounds(c, m),
    });
  }

  /// Sends a quote this agent made from the agent wallet. One send at a time per wallet; every
  /// send counts toward the daily cap, and a revert on chain skips the account for the day.
  function fill(q: Quote): Promise<FillResult> {
    if (!q.ok) return Promise.reject(new FillmarkError(q.reason, q.message));
    if (!issued.has(q))
      return Promise.reject(new FillmarkError("UnknownQuote", "Only quotes made by this agent instance can be sent."));
    if (!wallet || !sendWallet) return Promise.reject(new FillmarkError("NoWallet"));
    return serial(sendWallet, () => send(q));
  }

  async function send(q: Extract<Quote, { ok: true }>): Promise<FillResult> {
    const it = q.intent;
    const token = it.tokenIn === usdg ? it.tokenOut : it.tokenIn;
    const t = await now();
    const day = dayOf(t);
    if (t > it.deadline || dayOf(it.deadline) !== day) throw new FillmarkError("DeadlinePassed");
    if (!sendsLeft(day)) throw new FillmarkError("DailyCap");
    if ((await resolvePending(it.account, t)).has(token)) throw new FillmarkError("Pending");
    if (store.get(bannedKey(day, it.account))) throw new FillmarkError("RevertedToday");
    if (!(await isPlainKernel(pub, it.account))) throw new FillmarkError("NotPlainKernel");
    const eth = await pub.getBalance({ address: sendWallet! });
    if (eth < policy.minEth) throw new FillmarkError("LowEth");

    let request;
    try {
      ({ request } = await pub.simulateContract({
        address: router,
        abi: routerAbi,
        functionName: "execute",
        args: [it],
        account: wallet!.account!,
      }));
    } catch (err) {
      throw new FillmarkError(reasonCode(err, it.deadline, t));
    }
    const gas = await pub.estimateContractGas({
      address: router,
      abi: routerAbi,
      functionName: "execute",
      args: [it],
      account: sendWallet!,
    });
    if (gas > GAS_CAP) throw new FillmarkError("GasTooHigh");

    // Counted and marked pending before the broadcast: a send that errors may still land.
    countSend(day);
    const mark = (hash?: Hex) => markPending(it.account, token, { hash, deadline: it.deadline, nonce: it.nonce });
    mark();
    let hash: Hex;
    try {
      hash = await wallet!.writeContract({ ...request, gas: GAS_CAP, chain: pub.chain } as any);
    } catch (err) {
      throw new FillmarkError(
        "SendFailed",
        `The fill could not be sent (${errorName(err)}); it is treated as pending until its deadline.`,
      );
    }
    mark(hash);
    let receipt;
    try {
      receipt = await pub.waitForTransactionReceipt({ hash, timeout: receiptTimeout });
    } catch {
      throw new FillmarkError("Pending", `Fill ${hash} was sent; its receipt is not in yet.`);
    }
    clearPending(it.account, token);
    if (receipt.status !== "success") {
      store.set(bannedKey(day, it.account), hash);
      throw new FillmarkError(
        "RevertedOnChain",
        `Fill ${hash} reverted on chain; the account is skipped for the rest of the day.`,
      );
    }
    const logs = receipt.logs.filter((l) => getAddress(l.address) === router);
    const [filled] = parseEventLogs({ abi: routerAbi, eventName: "Filled", logs });
    const { fill: f, prices: p } = filled.args;
    return {
      hash,
      side: f.buy ? "buy" : "sell",
      token: f.stock,
      usdg: f.usdgAmount,
      units: f.stockAmount,
      fillFee: f.fillFee,
      nav: p.nav,
      fillPrice: p.fill,
      shortfallPpm: p.shortfall,
      costUsdg: p.cost,
      feedbackRefused: parseEventLogs({ abi: routerAbi, eventName: "FeedbackFailed", logs }).length,
    };
  }

  /// The agent's record per account and asset (router statsOf), and the totals. Without accounts,
  /// every account that ever installed the agent.
  async function record(accounts?: Address[]) {
    if (!accounts) await discover();
    const list = accounts?.map(addr) ?? [...candidates];
    const pairs = list.flatMap((account) => tokens.map((token) => ({ account, token })));
    const stats = await many(
      pub,
      pairs.map((p) => ({ address: router, abi: routerAbi, functionName: "statsOf", args: [agentId, p.account, p.token] })),
    );
    const rows = pairs
      .map((p, i) => ({
        ...p,
        ...(stats[i] as { fills: number; feedbackFails: number; notional: bigint; worst: bigint; sumCost: bigint }),
      }))
      .filter((r) => r.fills > 0);
    const total = rows.reduce(
      (s, r) => ({
        fills: s.fills + r.fills,
        notional: s.notional + r.notional,
        sumCost: s.sumCost + r.sumCost,
        worstPpm: s.fills === 0 || r.worst > s.worstPpm ? r.worst : s.worstPpm,
      }),
      { fills: 0, notional: 0n, sumCost: 0n, worstPpm: 0n },
    );
    return { rows, total };
  }

  /// The agent's book with an account: realized result, fees, escrow and each token's lot.
  async function book(account: Address): Promise<Book> {
    account = addr(account);
    const [b, list] = await Promise.all([
      read<Omit<Book, "positions">>(router, routerAbi, "bookOf", [account, agentId]),
      read<readonly Address[]>(router, routerAbi, "tokensOf", [account, agentId]),
    ]);
    const positions = await many(
      pub,
      list.map((token) => ({ address: router, abi: routerAbi, functionName: "positionOf", args: [account, agentId, token] })),
    );
    return {
      ...b,
      positions: list.map((token, i) => {
        const [lot, pending, later, movedOut] = positions[i];
        return { token, lot, pending, later, movedOut };
      }),
    };
  }

  /// A router or Pay call from the agent wallet, in the wallet's send queue: simulated first,
  /// gas estimate plus 20%.
  function call(address: Address, abi: any, functionName: string, args: readonly unknown[]): Promise<Hex> {
    if (!wallet || !sendWallet) return Promise.reject(new FillmarkError("NoWallet"));
    return serial(sendWallet, async () => {
      const day = dayOf(await now());
      if (!sendsLeft(day)) throw new FillmarkError("DailyCap");
      if ((await pub.getBalance({ address: sendWallet })) < policy.minEth) throw new FillmarkError("LowEth");
      let request;
      try {
        ({ request } = await pub.simulateContract({ address, abi, functionName, args, account: wallet.account! }));
      } catch (err) {
        const code = reasonCode(err);
        throw new FillmarkError(code, REASONS[code] ?? `${functionName} was refused: ${errorName(err)}`);
      }
      const gas = await pub.estimateContractGas({ address, abi, functionName, args, account: sendWallet });
      countSend(day); // every send counts toward the daily cap
      const hash = await wallet.writeContract({ ...(request as any), gas: (gas * 12n) / 10n, chain: pub.chain });
      let receipt;
      try {
        receipt = await pub.waitForTransactionReceipt({ hash, timeout: receiptTimeout });
      } catch {
        throw new FillmarkError("Pending", `${functionName} ${hash} was sent; its receipt is not in yet.`);
      }
      if (receipt.status !== "success") throw new FillmarkError("RevertedOnChain", `${functionName} ${hash} reverted on chain.`);
      return hash;
    });
  }

  const pay = {
    terms: () => read<{ rateBps: number; minZeroAtBps: number }>(ADDRESSES.pay, payAbi, "termsOf", [agentId]),
    agreement: (account: Address) =>
      read<{ rateBps: number; zeroAtBps: number; open: boolean; paid: bigint; carry: bigint }>(
        ADDRESSES.pay,
        payAbi,
        "agreementOf",
        [addr(account), agentId],
      ),
    /// What the account owes the agent now and, when it cannot be paid in this block, why.
    async due(account: Address) {
      const d = await read<any>(ADDRESSES.pay, payAbi, "dueOf", [addr(account), agentId]);
      return { ...d, wait: PAY_WAITS[d.wait] } as {
        accrued: bigint;
        paid: bigint;
        carry: bigint;
        due: bigint;
        payNow: bigint;
        wait: (typeof PAY_WAITS)[number];
      };
    },
    /// The agent's rate in bps of filled volume (at most 5), and the lowest cost (bps) at which a
    /// client may set the rate to fall to zero. Applies to agreements opened afterwards.
    setRate: (rateBps: number, minZeroAtBps: number) => call(ADDRESSES.pay, payAbi, "setRate", [agentId, rateBps, minZeroAtBps]),
    /// Bills a token the client allowed after the agreement opened; earlier fills are not billed.
    track: (account: Address, asset: string) => call(ADDRESSES.pay, payAbi, "track", [addr(account), agentId, tokenOf(asset)]),
  };

  return {
    agentId,
    policy,
    check: safely(check),
    clients: safely(clients),
    market: safely((assets?: string[]) => market(assets?.length ? assets.map(tokenOf) : undefined)),
    maxBuy: safely(maxBuy),
    maxSell: safely(maxSell),
    quoteBuy: safely(quoteBuy),
    quoteSell: safely(quoteSell),
    fill: safely(fill),
    record: safely(record),
    book: safely(book),
    settleFees: safely((account: Address) => call(router, routerAbi, "settle", [addr(account)])),
    release: safely((account: Address) => call(router, routerAbi, "release", [addr(account)])),
    closeOut: safely((account: Address) => call(router, routerAbi, "closeOut", [addr(account), agentId])),
    claimable: safely(async () => read<bigint>(router, routerAbi, "claimable", [sendWallet ?? (await agentWallet())])),
    claim: safely(async () => call(router, routerAbi, "claim", [sendWallet ?? (await agentWallet())])),
    pay: {
      terms: safely(pay.terms),
      agreement: safely(pay.agreement),
      due: safely(pay.due),
      setRate: safely(pay.setRate),
      track: safely(pay.track),
    },
  };
}

export type FillmarkAgent = ReturnType<typeof fillmarkAgent>;
