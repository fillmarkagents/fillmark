import type { Address } from "viem";

/// FillmarkRouterV3.FillIntent. Router v3 takes no signature: the agent wallet pinned at
/// install sends execute itself, and the router uses each token's official pool.
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
