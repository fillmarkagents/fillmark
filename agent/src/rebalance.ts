// Rebalance planning, pure: from the agent's lots, prices and the account's cash, what to sell
// and what to buy to bring the account back to the client's target weights. Values are USDG
// with 6 decimals at Chainlink prices (the router's NAV).
import type { Address } from "viem";

export const BPS = 10_000n;

export type Holding = {
  token: Address;
  units: bigint; // units of the agent's lot the account still holds: the most it may sell
  value: bigint; // NAV value of everything the account holds of the asset
  sellable: bigint; // NAV value of `units`
  weightBps: number; // target weight (0 for an asset held but no longer a target)
};

export type Plan = {
  total: bigint; // holdings and cash
  cashTarget: bigint;
  driftBps: number; // the largest gap between an asset's share and its target, in bps of the total
  sells: { token: Address; usdg: bigint }[]; // largest first
  buys: { token: Address; usdg: bigint }[]; // largest first
};

/// The gaps to target. `cash` is the account's USDG this agent may use (after anything owed);
/// only trades of at least `minTrade` are listed. A sale is at most what the agent's own units
/// are worth. Buys are limited to the cash above the cash target, counting what the planned
/// sales bring in.
export function planRebalance(holdings: Holding[], cash: bigint, cashBps: number, minTrade: bigint): Plan {
  const total = holdings.reduce((s, h) => s + h.value, cash);
  const cashTarget = (total * BigInt(cashBps)) / BPS;
  let drift = 0n;
  const sells: Plan["sells"] = [];
  const wants: Plan["buys"] = [];
  for (const h of holdings) {
    const target = (total * BigInt(h.weightBps)) / BPS;
    const gap = h.value - target;
    const abs = gap < 0n ? -gap : gap;
    if (total > 0n) {
      const bps = (abs * BPS) / total;
      if (bps > drift) drift = bps;
    }
    if (gap > 0n) {
      const usdg = gap < h.sellable ? gap : h.sellable;
      if (usdg >= minTrade && h.units > 0n) sells.push({ token: h.token, usdg });
    } else if (-gap >= minTrade) wants.push({ token: h.token, usdg: -gap });
  }
  sells.sort((a, b) => (a.usdg > b.usdg ? -1 : a.usdg < b.usdg ? 1 : 0));
  wants.sort((a, b) => (a.usdg > b.usdg ? -1 : a.usdg < b.usdg ? 1 : 0));
  let spendable = cash + sells.reduce((s, x) => s + x.usdg, 0n) - cashTarget;
  const buys: Plan["buys"] = [];
  for (const w of wants) {
    if (spendable < minTrade) break;
    const usdg = w.usdg < spendable ? w.usdg : spendable;
    if (usdg < minTrade) continue;
    buys.push({ token: w.token, usdg });
    spendable -= usdg;
  }
  return { total, cashTarget, driftBps: Number(drift), sells, buys };
}

/// Whether `day` (UTC day index) falls in a scheduled rebalance window: every `everyDays` days
/// counted from `anchorDay`. A window stays open 3 days for a weekly schedule and 7 for a
/// monthly one, so a weekend, a holiday or a closed market does not skip it.
export function scheduleOpen(day: bigint, anchorDay: bigint, everyDays: number): boolean {
  if (everyDays <= 0 || day < anchorDay) return false;
  const open = BigInt(everyDays <= 7 ? Math.min(3, everyDays) : 7);
  return (day - anchorDay) % BigInt(everyDays) < open;
}
