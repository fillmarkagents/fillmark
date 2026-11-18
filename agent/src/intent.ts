import type { Address, Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

export type FillIntent = {
  agentId: bigint;
  account: Address;
  installId: bigint;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
  minOut: bigint;
  refSqrtPriceX96: bigint;
  maxDevBps: number;
  sqrtPriceLimitX96: bigint;
  nonce: bigint;
  deadline: bigint;
};

// Must match FillmarkRouter.INTENT_TYPEHASH.
export const intentTypes = {
  FillIntent: [
    { name: "agentId", type: "uint256" },
    { name: "account", type: "address" },
    { name: "installId", type: "uint64" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "amountIn", type: "uint256" },
    { name: "minOut", type: "uint256" },
    { name: "refSqrtPriceX96", type: "uint160" },
    { name: "maxDevBps", type: "uint16" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export function intentDomain(router: Address, chainId: number) {
  return { name: "Fillmark", version: "1", chainId, verifyingContract: router } as const;
}

export function signIntent(agent: PrivateKeyAccount, router: Address, chainId: number, it: FillIntent): Promise<Hex> {
  return agent.signTypedData({
    domain: intentDomain(router, chainId),
    types: intentTypes,
    primaryType: "FillIntent",
    message: it,
  });
}
