import { getAddress, type Address } from "viem";
import { ASSET_LIST } from "./generated/assets.js";

export const CHAIN_ID = 4663; // Robinhood Chain

/// Robinhood Chain mainnet addresses (deployments/*.json in the Fillmark repo).
export const ADDRESSES = Object.freeze({
  router: "0x6F01e2bE7d1D31E88dF177bEC23392D1905FC8Aa", // FillmarkRouterV3
  feeds: "0xa54584AA004DD9E60522437A96F700d6d283EAA0",
  pay: "0x0f967E8CD8D3C9393DA64023d443b9Af691ED4D8",
  burner: "0x418106F0356E638C3823221FDBd2fBb3e8D7B024",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", // ERC-8004 IdentityRegistry
  reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63", // ERC-8004 ReputationRegistry
  quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7", // Uniswap v3 QuoterV2
  kernelImpl: "0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D", // Kernel v3.1
  ecdsaValidator: "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57",
} as const satisfies Record<string, Address>);

export const ROUTER_DEPLOY_BLOCK = 121_544_597n;

export type Asset = { ticker: string; token: Address; decimals: number; crypto: boolean };

/// Tokens the Fillmark feeds price. A hint only: whether a token trades is read from chain.
export const ASSETS: readonly Readonly<Asset>[] = Object.freeze(
  ASSET_LIST.map((a) => Object.freeze({ ...a, token: getAddress(a.token) })),
);

const byTicker = new Map(ASSETS.map((a) => [a.ticker.toLowerCase(), a]));
const byToken = new Map(ASSETS.map((a) => [a.token.toLowerCase(), a]));

/// An asset by ticker (case-insensitive) or token address.
export function assetOf(tickerOrToken: string): Asset | undefined {
  const k = tickerOrToken.toLowerCase();
  return byTicker.get(k) ?? byToken.get(k);
}
