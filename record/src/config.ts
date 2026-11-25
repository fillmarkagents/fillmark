import type { Address } from "viem";
import assets from "./assets.json";

export const CHAIN_ID = 4663;

// The current router (v3) and the two before it; the record covers all three.
export const ROUTER_V3: Address = "0x6F01e2bE7d1D31E88dF177bEC23392D1905FC8Aa";
export const ROUTER_V2: Address = "0x15A172CAA75AB7de22E9Bb3Cd981eA8c76cBe366";
export const ROUTER_V1: Address = "0xe542a7c8779962b8f819c4352d1436e08bc2d388";
export const ROUTERS: Address[] = [ROUTER_V3, ROUTER_V2, ROUTER_V1];

export const OWNER_SAFE: Address = "0x6C3a19517e5c1cff510BC163DCA4a46C7a969261";
export const GUARDIAN: Address = "0x534eeE806911FF49529e49A6cb94A5B3A6e9cBc3";
export const IDENTITY: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const REPUTATION: Address = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
export const ECDSA_VALIDATOR: Address = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57";
export const KERNEL_FACTORY: Address = "0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419";
export const KERNEL_IMPL: Address = "0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D";

// Deploy blocks: no Fillmark event exists before router v1's.
export const DEPLOY_BLOCK_V1 = 117181502n;
export const DEPLOY_BLOCK_V2 = 120230051n;
export const DEPLOY_BLOCK_V3 = 121544597n;

// Router version by address, lowercased.
export function versionOf(router: Address): 1 | 2 | 3 {
  const r = router.toLowerCase();
  if (r === ROUTER_V3.toLowerCase()) return 3;
  if (r === ROUTER_V2.toLowerCase()) return 2;
  if (r === ROUTER_V1.toLowerCase()) return 1;
  throw new Error(`not a Fillmark router: ${router}`);
}

// Wallets run by the Fillmark team. Client accounts they own are labelled "team", so the record
// can be read without them.
export const TEAM_WALLETS: Address[] = [
  "0xbf096238DbC1b38e92BA779a06C9Dff16FEE8d10",
  "0xFbB4F3C60E740603698f63a2Df5Dc32f5C31a5d4",
  "0xB127722f492712378727fAfbfBfa46cCf0caa91E",
  "0x60b94E9613b2A541e6B417D98e66E04ECc8d48a6",
  OWNER_SAFE,
  GUARDIAN,
  "0xDCe0AAc0A8E6629A0ae3c739ced29B8B31c960B8",
  "0x0c45BA239961efeedc8FDaD460CC4Bec6A12b4F1",
];

export type Asset = { ticker: string; token: Address; decimals: number; kind: "stock" | "crypto" };

export const ASSETS: Asset[] = [
  ...assets.stocks.map((a) => ({ ticker: a.ticker, token: a.token as Address, decimals: a.decimals, kind: "stock" as const })),
  ...assets.crypto.map((a) => ({ ticker: a.ticker, token: a.token as Address, decimals: a.decimals, kind: "crypto" as const })),
];

const byToken = new Map(ASSETS.map((a) => [a.token.toLowerCase(), a]));
export const assetOf = (token: Address) => byToken.get(token.toLowerCase());
