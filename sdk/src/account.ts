import { erc20Abi, getAddress, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { ADDRESSES } from "./addresses.js";
import { routerAbi } from "./generated/abi.js";
import { many } from "./multicall.js";

// Solady's ERC1967 proxy: the runtime code of every account the Kernel factory deploys.
const PROXY_CODE: Hex =
  "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const IMPL_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const NO_HOOK: Address = "0x0000000000000000000000000000000000000001";
const kernelAbi = parseAbi(["function executorConfig(address executor) view returns (address hook)"]);
const validatorAbi = parseAbi(["function ecdsaValidatorStorage(address) view returns (address owner)"]);

/// A fill runs through the account, so the account decides its gas. Only a Kernel v3.1 proxy
/// on the known implementation, with no hook on the router, is traded.
export async function isPlainKernel(pub: PublicClient, account: Address): Promise<boolean> {
  if ((await pub.getCode({ address: account })) !== PROXY_CODE) return false;
  const impl = await pub.getStorageAt({ address: account, slot: IMPL_SLOT });
  if (!impl || getAddress(`0x${impl.slice(-40)}`) !== ADDRESSES.kernelImpl) return false;
  const hook = await pub.readContract({
    address: account,
    abi: kernelAbi,
    functionName: "executorConfig",
    args: [ADDRESSES.router],
  });
  return hook === NO_HOOK;
}

/// A client account as the router sees it: owner, permission, USDG and the installed agent's book.
export async function accountStatus(pub: PublicClient, account: Address) {
  account = getAddress(account.toLowerCase());
  const [owner, config, usdg] = await many(pub, [
    { address: ADDRESSES.ecdsaValidator, abi: validatorAbi, functionName: "ecdsaValidatorStorage", args: [account] },
    { address: ADDRESSES.router, abi: routerAbi, functionName: "configs", args: [account] },
    { address: ADDRESSES.usdg, abi: erc20Abi, functionName: "balanceOf", args: [account] },
  ]);
  const [agentId, wallet, maxSlipBps, perfFeeBps, expiry, installId, installed, regularOnly, maxPerTrade, dailyLimit] =
    config as any;
  const book = installed
    ? await pub.readContract({ address: ADDRESSES.router, abi: routerAbi, functionName: "bookOf", args: [account, agentId] })
    : undefined;
  return {
    account,
    owner: owner === zeroAddress ? undefined : (owner as Address),
    plainKernel: await isPlainKernel(pub, account),
    usdg: usdg as bigint,
    permission: installed
      ? {
          agentId: agentId as bigint,
          wallet: wallet as Address,
          maxSlipBps: maxSlipBps as number,
          perfFeeBps: perfFeeBps as number,
          expiry: expiry as bigint,
          installId: installId as bigint,
          regularOnly: regularOnly as boolean,
          maxPerTrade: maxPerTrade as bigint,
          dailyLimit: dailyLimit as bigint,
        }
      : undefined,
    book,
  };
}
