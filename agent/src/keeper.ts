// Keeps the router's books current for every account on it, of any agent. Units a client
// moves out of (or back into) its account are booked when someone next syncs that token, at
// the price of that moment, so whoever waits picks the price. The keeper settles such an
// account as soon as every price of its book is live, and closes a book a removal left open.
// Settle needs every token of the book priced, so while one is not, the account's own agent
// can still book a move earlier with a fill of that asset (the router syncs the fill's token).
import { erc20Abi, getAddress, parseAbi, zeroAddress, type Address } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { feedsAbi, routerAbi } from "./abi.generated.js";
import { aggregatorAbi, clients, log, revertName, type PublicClient } from "./chain.js";

const LOG_CHUNK = 5_000_000n;
const RESCAN = 200n;
const BATCH = 32_768;
const MAX_PER_TICK = 10;
const MAX_PER_DAY = 100; // the keeper's gas is bounded, whatever other agents' clients do
const GAS_CAP = 4_000_000n; // settle and closeOut loop over the book's tokens
const RESERVE_X = 3n; // the keeper stops at 3x the agent's ETH reserve, well before trading does
const DUST = 1_000_000n; // a move worth under 1 USDG at cost is left to the next sync
const AGAIN_SEC = 3_600n; // after a send that reverted on chain
const DAY = 86_400n;
const moduleAbi = parseAbi(["function isModuleInstalled(uint256 moduleTypeId, address module, bytes additionalContext) view returns (bool)"]);

type Once = (per: "day" | "hour", key: string, level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
type Wallet = NonNullable<ReturnType<typeof clients>["wallet"]>;
/// value: USDG (6 decimals) at stake, the units the call books at the latest reference price.
export type Due = { account: Address; agentId: bigint; call: "settle" | "closeOut"; state: string; value: bigint };
type Read = { status: "success" | "failure"; result?: unknown };

export class Keeper {
  private readonly accounts: Address[] = [];
  private scanned: bigint;
  private readonly notBefore = new Map<Address, bigint>();
  private readonly sentState = new Map<Address, string>(); // the book state of the last send that went through
  private day = -1n;
  private feeds?: Address;
  private readonly feedOf = new Map<Address, { feed: Address; decimals: number }>();
  private sentToday = 0;

  constructor(
    private readonly pub: PublicClient,
    private readonly wallet: Wallet,
    private readonly key: PrivateKeyAccount,
    private readonly router: Address,
    private readonly deployBlock: bigint,
    private readonly agentId: bigint,
    private readonly minEthWei: bigint,
    private readonly once: Once,
  ) {
    this.scanned = deployBlock - 1n;
  }

  async tick(now: bigint) {
    if (now / DAY !== this.day) {
      this.day = now / DAY;
      this.sentToday = 0;
    }
    await this.discover();
    // Largest value at stake first, whoever the agent: accounts made only to fill the daily
    // limit go last unless they move as much as real clients.
    const due = (await this.due(now)).sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1));
    let sent = 0;
    for (const d of due) {
      if ((this.notBefore.get(d.account) ?? 0n) > now || this.sentState.get(d.account) === d.state) continue;
      if (sent >= MAX_PER_TICK || this.sentToday >= MAX_PER_DAY) {
        this.once("hour", "keepcap", "warn", "moved units wait: the keeper's send limit is reached", { due: due.length, sentToday: this.sentToday });
        return;
      }
      if ((await this.pub.getBalance({ address: this.key.address })) < RESERVE_X * this.minEthWei) {
        this.once("hour", "keepeth", "warn", "moved units wait: agent ETH below the keeper's reserve", { reserve: RESERVE_X * this.minEthWei });
        return;
      }
      try {
        if (await this.send(d, now)) {
          sent++;
          this.sentToday++;
        }
      } catch (err) {
        this.once("hour", `keepfail:${d.account}:${revertName(err)}`, "error", "booking moved units failed", { account: d.account, call: d.call, error: revertName(err) });
      }
    }
  }

  /// Every account that ever installed the router, from its Installed events.
  private async discover() {
    const head = await this.pub.getBlockNumber();
    let from = this.scanned - RESCAN + 1n;
    if (from < this.deployBlock) from = this.deployBlock;
    while (from <= head) {
      const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
      const logs = await this.pub.getContractEvents({ address: this.router, abi: routerAbi, eventName: "Installed", fromBlock: from, toBlock: to, strict: true });
      for (const l of logs) {
        const a = getAddress(l.args.account);
        if (!this.accounts.includes(a)) this.accounts.push(a);
      }
      if (to > this.scanned) this.scanned = to;
      from = to + 1n;
    }
  }

  private async reads(contracts: unknown[]): Promise<Read[]> {
    return (await this.pub.multicall({ batchSize: BATCH, allowFailure: true, contracts: contracts as any[] })) as Read[];
  }

  /// Open books with a token the router would sync (_syncToken, after _mature) now that the
  /// account's balance changed, and books whose router was removed but not closed out.
  async due(now: bigint): Promise<Due[]> {
    const ok = (r: Read | undefined) => r?.status === "success";
    const open = await this.reads(this.accounts.map((a) => ({ address: this.router, abi: routerAbi, functionName: "openBook", args: [a] })));
    const books = this.accounts.flatMap((account, i) => (ok(open[i]) && (open[i].result as bigint) !== 0n ? [{ account, agentId: (open[i].result as bigint) - 1n }] : []));
    const heads = await this.reads(
      books.flatMap((b) => [
        { address: this.router, abi: routerAbi, functionName: "bookOf", args: [b.account, b.agentId] },
        { address: this.router, abi: routerAbi, functionName: "tokensOf", args: [b.account, b.agentId] },
        { address: b.account, abi: moduleAbi, functionName: "isModuleInstalled", args: [2n, this.router, "0x"] },
      ]),
    );
    const rows = books.flatMap((b, i) => {
      const [book, tokens, module] = heads.slice(3 * i, 3 * i + 3);
      if (!ok(book) || !ok(tokens)) return [];
      // A removal whose onUninstall did not run leaves the config installed; closeOut marks it.
      const removed = (book.result as { closing: boolean }).closing || (ok(module) && module.result === false);
      return [{ ...b, removed, tokens: tokens.result as Address[] }];
    });
    const cells = rows.flatMap((r) => r.tokens.map((token) => ({ account: r.account, token, agentId: r.agentId })));
    const reads = await this.reads(
      cells.flatMap((c) => [
        { address: c.token, abi: erc20Abi, functionName: "balanceOf", args: [c.account] },
        { address: this.router, abi: routerAbi, functionName: "positionOf", args: [c.account, c.agentId, c.token] },
      ]),
    );
    const moved = new Set<Address>();
    const state = new Map<Address, string>();
    type Units = { token: Address; qty: bigint; cost: bigint };
    const book = new Map<Address, Units[]>(); // the units a close-out books
    const move = new Map<Address, Units[]>(); // the units moved and not booked
    const add = (m: Map<Address, Units[]>, a: Address, u: Units) => m.set(a, [...(m.get(a) ?? []), u]);
    cells.forEach((c, i) => {
      const [b, p] = [reads[2 * i], reads[2 * i + 1]];
      if (!ok(b) || !ok(p)) return;
      const bal = b.result as bigint;
      const [lot, , , out] = p.result as readonly [{ qty: bigint; cost: bigint }, unknown, unknown, { qty: bigint; until: bigint }];
      const outQty = out.until !== 0n && out.until <= now ? 0n : out.qty; // _mature drops a matured out first
      state.set(c.account, `${state.get(c.account) ?? ""}${c.token}:${bal}:${lot.qty}:${outQty};`);
      const goneCost = bal < lot.qty ? (lot.cost * (lot.qty - bal)) / lot.qty : 0n;
      const back = bal > lot.qty && outQty !== 0n ? (bal - lot.qty < outQty ? bal - lot.qty : outQty) : 0n;
      add(book, c.account, { token: c.token, qty: lot.qty + back, cost: 0n });
      if (bal < lot.qty && goneCost >= DUST) {
        moved.add(c.account);
        add(move, c.account, { token: c.token, qty: lot.qty - bal, cost: goneCost });
      } else if (back !== 0n) {
        moved.add(c.account);
        add(move, c.account, { token: c.token, qty: back, cost: 0n });
      }
    });
    const due = rows.flatMap((r): (Omit<Due, "value"> & { units: Units[] })[] => {
      const s = state.get(r.account) ?? "";
      if (r.removed) return [{ account: r.account, agentId: r.agentId, call: "closeOut", state: `closeOut;${s}`, units: book.get(r.account) ?? [] }];
      if (moved.has(r.account)) return [{ account: r.account, agentId: r.agentId, call: "settle", state: s, units: move.get(r.account) ?? [] }];
      return [];
    });
    if (due.length === 0) return [];
    const price = await this.prices([...new Set(due.flatMap((d) => d.units.map((u) => u.token)))]);
    // A token with no positive answer is valued at the cost of the units moved out, else 0.
    const worth = (u: Units) => {
      const p = price.get(u.token);
      return p ? (u.qty * p.answer) / 10n ** BigInt(p.decimals + 2) : u.cost;
    };
    return due.map(({ units, ...d }): Due => ({ ...d, value: units.reduce((v, u) => v + worth(u), 0n) }));
  }

  /// Each token's latest reference answer (8 decimals) and token decimals, from the router's
  /// feeds; only to rank accounts, so an old answer is fine and a missing one is left out.
  private async prices(tokens: Address[]) {
    const out = new Map<Address, { answer: bigint; decimals: number }>();
    this.feeds ??= await this.pub.readContract({ address: this.router, abi: routerAbi, functionName: "feeds" });
    const feeds = this.feeds;
    const unknown = tokens.filter((t) => !this.feedOf.has(t));
    const meta = await this.reads(
      unknown.flatMap((t) => [
        { address: feeds, abi: feedsAbi, functionName: "feedOf", args: [t] },
        { address: feeds, abi: feedsAbi, functionName: "decimalsOf", args: [t] },
      ]),
    );
    // The feeds contract is add-only, so a token's feed and decimals never change.
    unknown.forEach((t, i) => {
      const [f, d] = [meta[2 * i], meta[2 * i + 1]];
      if (f?.status === "success" && d?.status === "success" && f.result !== zeroAddress) this.feedOf.set(t, { feed: f.result as Address, decimals: Number(d.result) });
    });
    const known = tokens.flatMap((t) => (this.feedOf.has(t) ? [{ token: t, ...this.feedOf.get(t)! }] : []));
    const rounds = await this.reads(known.map((k) => ({ address: k.feed, abi: aggregatorAbi, functionName: "latestRoundData" })));
    known.forEach((k, i) => {
      const r = rounds[i];
      const answer = r?.status === "success" ? (r.result as readonly bigint[])[1] : 0n;
      if (answer > 0n) out.set(k.token, { answer, decimals: k.decimals });
    });
    return out;
  }

  private async send(d: Due, now: bigint): Promise<boolean> {
    const args = d.call === "settle" ? ([d.account] as const) : ([d.account, d.agentId] as const);
    const call = { address: this.router, abi: routerAbi, functionName: d.call, args, account: this.key } as const;
    let request;
    try {
      ({ request } = await this.pub.simulateContract(call as any));
    } catch (err) {
      // Most often a token of the book has no live price (market closed, stale feed).
      this.once("hour", `keep:${d.account}:${revertName(err)}`, "info", "moved units wait for a live price", { account: d.account, agentId: d.agentId, call: d.call, error: revertName(err) });
      return false;
    }
    const gas = await this.pub.estimateContractGas(call as any);
    // A fee that falls due between the estimate and the send makes settle forward 400k gas to
    // the registry (the router's FEEDBACK_GAS), so the limit keeps room for it.
    const room = gas + gas / 5n > gas + 500_000n ? gas + gas / 5n : gas + 500_000n;
    const limit = room > GAS_CAP ? GAS_CAP : room;
    if (gas + gas / 5n > GAS_CAP) {
      this.once("day", `keepgas:${d.account}`, "warn", "booking moved units needs more gas than the cap", { account: d.account, call: d.call, gas, cap: GAS_CAP });
      return false;
    }
    const hash = await this.wallet.writeContract({ ...request, gas: limit });
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      this.notBefore.set(d.account, now + AGAIN_SEC);
      log("error", "booking moved units reverted on chain", { account: d.account, agentId: d.agentId, call: d.call, tx: hash });
      return true;
    }
    this.sentState.set(d.account, d.state);
    log("info", "moved units booked", { account: d.account, agentId: d.agentId, call: d.call, tx: hash });
    return true;
  }
}
