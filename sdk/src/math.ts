// The router's own arithmetic, done off chain. Prices are USDG per whole token with the
// Chainlink feed's 8 decimals; USDG amounts have 6 decimals.
import type { Address } from "viem";

export const MIN_NOTIONAL = 10_000_000n; // FillmarkRouterV3.MIN_NOTIONAL, 10 USDG
const Q96 = 1n << 96n;

const scale = (decimals: number) => 10n ** BigInt(decimals + 2);

/// FillmarkRouterV3.navValueOf: USDG worth `amount` token units at `price`, rounded down.
export function navValue(amount: bigint, price: bigint, decimals: number): bigint {
  return (amount * price) / scale(decimals);
}

/// FillmarkRouterV3.navValueCeil.
export function navValueCeil(amount: bigint, price: bigint, decimals: number): bigint {
  const s = scale(decimals);
  return (amount * price + s - 1n) / s;
}

/// FillmarkRouterV3.spotPrice: the pool price in the feed's units.
export function spotPrice(sqrtPriceX96: bigint, tokenIsToken0: boolean, decimals: number): bigint {
  const e = BigInt(decimals + 2);
  if (tokenIsToken0) return (((sqrtPriceX96 * sqrtPriceX96) / Q96) * 10n ** e) / Q96;
  return ((((1n << 192n) * 10n ** (e / 2n)) / sqrtPriceX96) * 10n ** (e - e / 2n)) / sqrtPriceX96;
}

/// FillmarkRouterV3.bucketOf.
export function bucketOf(usdgAmount: bigint): number {
  const edges = [10e6, 30e6, 100e6, 300e6, 1_000e6, 3_000e6, 10_000e6].map(BigInt);
  const i = edges.findIndex((e) => usdgAmount < e);
  return i === -1 ? 7 : i;
}

/// Signed distance of a from b in millionths, as the router's Filled event reports it
/// (100 = 1 bps).
export function diffPpm(a: bigint, b: bigint): bigint {
  return ((a - b) * 1_000_000n) / b;
}

function sqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/// The pool price limit `slipBps` past the current price in the trade's direction
/// (sqrtPriceX96 is token1 per token0).
export function priceLimit(sqrtP: bigint, token: Address, usdg: Address, buy: boolean, slipBps: number): bigint {
  const factor = sqrt(((10_000n + (buy ? 1n : -1n) * BigInt(slipBps)) * 10n ** 36n) / 10_000n);
  const tokenIs0 = BigInt(token) < BigInt(usdg);
  return tokenIs0 ? (sqrtP * factor) / 10n ** 18n : (sqrtP * 10n ** 18n) / factor;
}

/// The largest buy whose USDG and fill fee fit both the per-trade limit and what is left of
/// the rolling window; 0 when less than the router's minimum fits.
export function buyRoom(maxPerTrade: bigint, dailyLimit: bigint, spent: bigint, fillFeeBps: bigint): bigint {
  if (spent >= dailyLimit) return 0n;
  const room = ((dailyLimit - spent) * 10_000n) / (10_000n + fillFeeBps);
  const a = room < maxPerTrade ? room : maxPerTrade;
  return a < MIN_NOTIONAL ? 0n : a;
}

/// The gross USDG a sale of `qty` lot units must bring so that, after the fill fee, it covers
/// their share of the lot's cost (rounded up).
export function costFloor(lotQty: bigint, lotCost: bigint, qty: bigint, fillFeeBps: bigint): bigint {
  const cost = (lotCost * qty + lotQty - 1n) / lotQty;
  return (cost * 10_000n + 10_000n - fillFeeBps - 1n) / (10_000n - fillFeeBps);
}
