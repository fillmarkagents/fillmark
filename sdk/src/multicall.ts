import type { PublicClient } from "viem";

// Multicall reads. The contract ABIs are large, so results are typed loosely here and narrowed
// where they are used.
export const many = (pub: PublicClient, contracts: readonly unknown[]): Promise<any[]> =>
  pub.multicall({ allowFailure: false, contracts: contracts as any }) as Promise<any[]>;

export const tryMany = (
  pub: PublicClient,
  contracts: readonly unknown[],
): Promise<{ status: "success" | "failure"; result?: any }[]> => pub.multicall({ contracts: contracts as any }) as Promise<any>;
