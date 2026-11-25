// Client accounts are Kernel v3.1 smart accounts owned by a wallet through the ECDSA validator,
// with a Fillmark router installed as an executor. This checks that an account was made the
// standard way: the creating call hashes into the account address (CREATE2), so an RPC cannot
// fake it, and after creation only the owner can change the account's modules.
import {
  concat,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { ECDSA_VALIDATOR, KERNEL_FACTORY, KERNEL_IMPL, ROUTER_V1, ROUTER_V2, ROUTER_V3 } from "./config";

export const kernelAbi = parseAbi([
  "function initialize(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)",
  "function installModule(uint256 moduleType, address module, bytes initData) payable",
]);
export const factoryAbi = parseAbi(["function createAccount(bytes data, bytes32 salt) payable returns (address)"]);

const EXECUTOR = 2n;

export type Limits = {
  agentId: bigint;
  maxPerTrade: bigint; // USDG, 6 decimals
  dailyLimit: bigint; // USDG, 6 decimals
  expiry: bigint; // unix seconds
  maxSlipBps: number;
  perfFeeBps: number; // v2 and v3
  regularOnly: boolean; // v3 only
  assets: Address[];
};

const HEAD = [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }, { type: "uint16" }] as const;

function routerInitData(l: Limits, router: Address): Hex {
  const head = [l.agentId, l.maxPerTrade, l.dailyLimit, l.expiry, l.maxSlipBps] as const;
  const data =
    router === ROUTER_V1
      ? encodeAbiParameters([...HEAD, { type: "address[]" }], [...head, l.assets])
      : router === ROUTER_V2
        ? encodeAbiParameters([...HEAD, { type: "uint16" }, { type: "address[]" }], [...head, l.perfFeeBps, l.assets])
        : encodeAbiParameters([...HEAD, { type: "uint16" }, { type: "bool" }, { type: "address[]" }], [...head, l.perfFeeBps, l.regularOnly, l.assets]);
  return concat([zeroAddress, encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [data, "0x"])]);
}

// The factory's initialize data for a new account owned by `owner`, with the router installed.
export function accountInitData(owner: Address, l: Limits, router: Address): Hex {
  const install = encodeFunctionData({ abi: kernelAbi, functionName: "installModule", args: [EXECUTOR, router, routerInitData(l, router)] });
  return encodeFunctionData({
    abi: kernelAbi,
    functionName: "initialize",
    args: [concat(["0x01", ECDSA_VALIDATOR]), "0x0000000000000000000000000000000000000001", owner, "0x", [install]],
  });
}

// The account address for initialize data and salt: CREATE2 of Solady's ERC1967 proxy from the
// Kernel factory, salt keccak256(data ++ salt).
export function accountAddress(data: Hex, salt: Hex): Address {
  const initCode = concat([
    "0x603d3d8160223d3973",
    KERNEL_IMPL,
    "0x600951",
    "0x55f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc",
    "0x3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3",
  ]);
  return getContractAddress({ opcode: "CREATE2", from: KERNEL_FACTORY, salt: keccak256(encodePacked(["bytes", "bytes32"], [data, salt])), bytecode: initCode });
}

export type Creation = { owner: Address; router: Address; limits: Limits };

// The transaction that created the account, as the chain returns it.
export type CreationTx = { to: Address | null; input: Hex };

// Whether the account was made the standard way, from the transaction of its first Installed
// event. Returns the setup, or null when it is anything else.
export function standardCreation(account: Address, tx: CreationTx): Creation | null {
  if (!tx.to || getAddress(tx.to) !== KERNEL_FACTORY) return null;
  try {
    const call = decodeFunctionData({ abi: factoryAbi, data: tx.input });
    if (call.functionName !== "createAccount") return null;
    const [data, salt] = call.args as [Hex, Hex];
    if (accountAddress(data, salt) !== getAddress(account)) return null;
    const init = decodeFunctionData({ abi: kernelAbi, data });
    if (init.functionName !== "initialize") return null;
    const [, , validatorData, , initConfig] = init.args as [Hex, Address, Hex, Hex, readonly Hex[]];
    if (validatorData.length !== 42 || initConfig.length !== 1) return null;
    const owner = getAddress(validatorData);
    const install = decodeFunctionData({ abi: kernelAbi, data: initConfig[0] });
    if (install.functionName !== "installModule") return null;
    const router = getAddress(install.args[1] as Address);
    if (router !== ROUTER_V3 && router !== ROUTER_V2 && router !== ROUTER_V1) return null;
    const [routerData] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], `0x${(install.args[2] as Hex).slice(42)}`);
    let limits: Limits;
    if (router === ROUTER_V1) {
      const [agentId, maxPerTrade, dailyLimit, expiry, maxSlipBps, assets] = decodeAbiParameters([...HEAD, { type: "address[]" }], routerData);
      limits = { agentId, maxPerTrade, dailyLimit, expiry, maxSlipBps, perfFeeBps: 0, regularOnly: false, assets: [...assets] };
    } else if (router === ROUTER_V2) {
      const [agentId, maxPerTrade, dailyLimit, expiry, maxSlipBps, perfFeeBps, assets] = decodeAbiParameters([...HEAD, { type: "uint16" }, { type: "address[]" }], routerData);
      limits = { agentId, maxPerTrade, dailyLimit, expiry, maxSlipBps, perfFeeBps, regularOnly: false, assets: [...assets] };
    } else {
      const [agentId, maxPerTrade, dailyLimit, expiry, maxSlipBps, perfFeeBps, regularOnly, assets] = decodeAbiParameters(
        [...HEAD, { type: "uint16" }, { type: "bool" }, { type: "address[]" }],
        routerData,
      );
      limits = { agentId, maxPerTrade, dailyLimit, expiry, maxSlipBps, perfFeeBps, regularOnly, assets: [...assets] };
    }
    // Byte for byte the data the client app and the CLI build: any other root, hook or module fails.
    if (accountInitData(owner, limits, router).toLowerCase() !== data.toLowerCase()) return null;
    return { owner, router, limits };
  } catch {
    return null;
  }
}
