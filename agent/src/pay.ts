// Fillmark Pay helpers shared by the agent and the client CLI.
import { encodeAbiParameters, encodeFunctionData, erc20Abi, pad, type Address, type Hex } from "viem";
import { payAbi } from "./abi.generated.js";
import { PAY, USDG, kernelAbi } from "./chain.js";

// FillmarkPay.Wait, by its index.
export const WAITS = ["None", "NotOpen", "NothingDue", "NoToken", "BurnThisBlock", "BlockBudget", "Balance", "Allowance"] as const;
export type Wait = (typeof WAITS)[number];

const Q192 = 1n << 192n;
const USDG_UNIT = 1_000_000n;
const BPS = 10_000n;
const BURN_BPS = 1_000n; // FillmarkPay.BURN_SHARE_BPS

/// Token units per 1 USDG (1e6 units) at a v4 pool price, sqrtPriceX96 being
/// sqrt(currency1 / currency0) in raw units.
export function tokenPerUsdg(sqrtPriceX96: bigint, usdgIsCurrency0: boolean): bigint {
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  return usdgIsCurrency0 ? (p2 * USDG_UNIT) / Q192 : (Q192 * USDG_UNIT) / p2;
}

/// The least $FILLMARK the agent accepts per USDG paid (settle's minReceivedPerUsdg): the
/// reference price, less the pool's fee and tax on the output, the 10% burn, and slipBps.
export function minReceivedPerUsdg(refPerUsdg: bigint, feeAndTaxBps: number, slipBps: number): bigint {
  return (refPerUsdg * (BPS - BigInt(feeAndTaxBps)) * (BPS - BURN_BPS) * (BPS - BigInt(slipBps))) / (BPS * BPS * BPS);
}

/// The middle of a set of prices.
export function median(values: bigint[]): bigint {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)]!;
}

/// The USDG allowance an agreement asks for: the rate on twice the daily buy limit (a buy and
/// the later sale of what it bought) for each day until the permission ends and the router's 7
/// days of sales after it; a sale above the buy price counts a little more. At least 0.01 USDG,
/// plus what an earlier agreement with the same agent still owes (carry).
export function payAllowance(rateBps: number, dailyLimit: bigint, expiry: bigint, now: bigint, carry: bigint): bigint {
  const days = expiry > now ? (expiry - now + 86_399n) / 86_400n + 7n : 7n;
  const most = (BigInt(rateBps) * 2n * dailyLimit * days + BPS - 1n) / BPS;
  return (most > 10_000n ? most : 10_000n) + carry;
}

export type Terms = { rateBps: number; minZeroAtBps: number };
export type PayState = { open: boolean; rateBps: number; tokens: Set<Address>; due: bigint; allowance: bigint };

type Step = { target: Address; value: bigint; callData: Hex };
const BATCH: Hex = pad("0x01", { dir: "right", size: 32 });
const batch = (steps: Step[]): Hex =>
  encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [
      BATCH,
      encodeAbiParameters(
        [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
        [steps],
      ),
    ],
  });
const approve = (amount: bigint): Step => ({ target: USDG, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PAY, amount] }) });

/// The account's call that opens an agreement: approve Fillmark Pay for `allowance` USDG, then
/// open on the terms shown, tracking `tokens`. The client app sends the same bytes.
export const payOpenCallData = (agentId: bigint, rateBps: number, zeroAtBps: number, tokens: Address[], allowance: bigint): Hex =>
  batch([approve(allowance), { target: PAY, value: 0n, callData: encodeFunctionData({ abi: payAbi, functionName: "open", args: [agentId, rateBps, zeroAtBps, tokens] }) }]);

/// The account's call that ends an agreement and, unless another agreement of the account still
/// uses it, sets Fillmark Pay's allowance (one for all agreements) to 0.
export const payCloseCallData = (agentId: bigint, zeroAllowance = true): Hex =>
  batch([{ target: PAY, value: 0n, callData: encodeFunctionData({ abi: payAbi, functionName: "close", args: [agentId] }) }, ...(zeroAllowance ? [approve(0n)] : [])]);
