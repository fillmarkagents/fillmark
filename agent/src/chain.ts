import { readFileSync, statSync } from "node:fs";
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodePacked,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { robinhood } from "viem/chains";

// Robinhood Chain mainnet (4663).
export const IDENTITY: Address = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const UNISWAP_FACTORY: Address = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
export const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const ENTRY_POINT: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
export const KERNEL_FACTORY: Address = "0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419";
export const KERNEL_IMPL: Address = "0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D"; // factory.implementation()
export const ECDSA_VALIDATOR: Address = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57";
export const QUOTER_V2: Address = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7"; // Uniswap docs, factory() checked on chain

// Tokens the router can price, by ticker: the list script/Deploy.s.sol registers
// (Robinhood stock tokens, and crypto tokens that trade at any hour).
type AssetEntry = { decimals: number; token: string; ticker: string };
const assetFile = JSON.parse(readFileSync(new URL("../../assets.json", import.meta.url), "utf8")) as {
  stocks: AssetEntry[];
  crypto: AssetEntry[];
};
export const ASSETS: Record<string, Address> = {};
export const ASSET_DECIMALS: Record<string, number> = {};
for (const a of [...assetFile.stocks, ...assetFile.crypto]) {
  if (Object.hasOwn(ASSETS, a.ticker)) throw new Error(`assets.json lists ${a.ticker} twice`);
  ASSETS[a.ticker] = getAddress(a.token);
  ASSET_DECIMALS[a.ticker] = a.decimals;
}
export type Ticker = string;
export const FEE_TIERS = [100, 500, 3000, 10000] as const;
export const SESSIONS = ["Closed", "Extended", "Regular"] as const;

export const factoryAbi = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
export const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
export const quoterAbi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
export const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
]);
export const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);
export const kernelFactoryAbi = parseAbi([
  "function createAccount(bytes data, bytes32 salt) payable returns (address)",
  "function getAddress(bytes data, bytes32 salt) view returns (address)",
]);
export const kernelAbi = parseAbi([
  "function initialize(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)",
  "function installModule(uint256 moduleType, address module, bytes initData) payable",
  "function uninstallModule(uint256 moduleType, address module, bytes deInitData) payable",
  "function execute(bytes32 mode, bytes executionCalldata) payable",
]);
export const entryPointAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
]);

/// Reads a secret file and refuses one that others can read.
export function readSecret(path: string): string {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} must be readable by its owner only (chmod 600)`);
  return readFileSync(path, "utf8").trim();
}

export function loadKey(path: string): PrivateKeyAccount {
  const key = readSecret(path);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${path} does not hold a 0x-prefixed 32-byte private key`);
  return privateKeyToAccount(key as Hex);
}

export function rpcUrl(): string {
  return process.env.FILLMARK_RPC ?? readSecret(process.env.FILLMARK_RPC_FILE ?? "/etc/fillmark/rpc_url");
}

export function clients(account?: PrivateKeyAccount) {
  const transport = http(rpcUrl(), { timeout: 30_000 });
  const pub = createPublicClient({ chain: robinhood, transport });
  const wallet = account ? createWalletClient({ chain: robinhood, transport, account }) : undefined;
  return { pub, wallet };
}

export type PublicClient = ReturnType<typeof clients>["pub"];

export function isTicker(t: string): t is Ticker {
  return Object.hasOwn(ASSETS, t);
}

/// The Kernel v3.1 account address for initialize data and salt, computed here (CREATE2
/// of Solady's ERC1967 proxy, salt keccak256(data ++ salt)) so the RPC cannot pick it.
export function kernelAccountAddress(data: Hex, salt: Hex): Address {
  const initCode = concat([
    "0x603d3d8160223d3973",
    KERNEL_IMPL,
    "0x600951",
    "0x55f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc",
    "0x3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3",
  ]);
  const actualSalt = keccak256(encodePacked(["bytes", "bytes32"], [data, salt]));
  return getContractAddress({ opcode: "CREATE2", from: KERNEL_FACTORY, salt: actualSalt, bytecode: initCode });
}

/// The latest block time, refused if it is more than FILLMARK_MAX_CLOCK_SKEW seconds
/// (default 300) off this machine's clock: expiries, slots and deadlines must not be
/// set by the RPC. The anvil e2e raises it because it moves the chain clock.
export async function checkedNow(pub: PublicClient): Promise<bigint> {
  const block = (await pub.getBlock()).timestamp;
  const local = BigInt(Math.floor(Date.now() / 1000));
  const skew = block > local ? block - local : local - block;
  if (skew > BigInt(process.env.FILLMARK_MAX_CLOCK_SKEW ?? "300")) throw new Error(`RPC block time ${block} is ${skew}s away from the local clock`);
  return block;
}

/// A short reason for a failed call: the decoded custom error with its arguments, the
/// revert string, or the unknown error selector. Never the full viem message, which
/// can carry the RPC URL.
export function revertName(err: unknown): string {
  const plain = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  for (let e: any = err; e; e = e.cause) {
    if (e.data?.errorName) return e.data.args?.length ? `${e.data.errorName}${plain(e.data.args)}` : e.data.errorName;
    if (e.reason) return `reverted: ${e.reason}`;
    if (e.signature) return `unknown error ${e.signature}`;
  }
  const e: any = err;
  return e?.shortMessage ?? (err instanceof Error ? err.message.split("\n")[0] : String(err));
}

export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  (level === "info" ? console.log : console.error)(line);
}
