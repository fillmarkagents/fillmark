// Fillmark client CLI: create a Kernel account with the router installed, check it,
// withdraw from it and uninstall the router. User operations go straight to the
// EntryPoint, so no bundler is needed and the account pays no gas (gas fees in the user
// operation are 0; the key in FILLMARK_KEY_FILE pays the transaction).
//
// The account owner can be that key, or another wallet (--owner at create). Then an
// owner-only command prints the user operation and its hash, sends nothing and exits 2;
// the owner signs the hash (personal_sign) and the command runs again with --signature.
//
// Env: FILLMARK_ROUTER (required), FILLMARK_KEY_FILE (sending key, 0600),
//      FILLMARK_RPC or FILLMARK_RPC_FILE (default /etc/fillmark/rpc_url).
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddress,
  pad,
  parseAbi,
  parseEventLogs,
  parseUnits,
  recoverAddress,
  recoverMessageAddress,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import type { PrivateKeyAccount } from "viem/accounts";
import { routerAbi } from "./abi.generated.js";
import {
  ECDSA_VALIDATOR,
  ENTRY_POINT,
  KERNEL_FACTORY,
  ASSETS,
  ASSET_DECIMALS,
  USDG,
  clients,
  entryPointAbi,
  kernelAbi,
  kernelFactoryAbi,
  checkedNow,
  isTicker,
  kernelAccountAddress,
  loadKey,
  revertName,
} from "./chain.js";

const EXECUTOR = 2n;
const TOKENS: Record<string, { address: Address; decimals: number }> = { USDG: { address: USDG, decimals: 6 } };
for (const [t, address] of Object.entries(ASSETS)) TOKENS[t] = { address, decimals: ASSET_DECIMALS[t]! };

const USAGE = `usage:
  fillmark create    --agent-id N --max-per-trade USDG --daily-limit USDG (--expiry-days N | --expiry UNIX) --max-slip-bps N --assets TSLA,NVDA,WETH,... [--salt N] [--owner ADDRESS]
  fillmark install   <account> (same flags as create, without --salt and --owner) [--signature 0x...]
  fillmark status    <account>
  fillmark withdraw  <account> <USDG|ticker> <amount|all> [--to ADDRESS] [--signature 0x...]
  fillmark uninstall <account> [--signature 0x...]

tickers (assets.json, exact case): ${Object.keys(ASSETS).join(",")}`;

type InstallOpts = { agentId: bigint; maxPerTrade: bigint; dailyLimit: bigint; expiry: bigint; maxSlipBps: number; assets: Address[] };

function installOpts(v: Record<string, string | undefined>, now: bigint): InstallOpts {
  for (const k of ["agent-id", "max-per-trade", "daily-limit", "max-slip-bps", "assets"]) {
    if (!v[k]) throw new Error(`--${k} is required\n${USAGE}`);
  }
  if ((v["expiry-days"] === undefined) === (v.expiry === undefined)) throw new Error(`give --expiry-days or --expiry\n${USAGE}`);
  const assets = v.assets!.split(",").map((t) => {
    if (!isTicker(t)) throw new Error(`unknown asset ${t}`);
    return ASSETS[t] as Address;
  });
  const maxSlipBps = Number(v["max-slip-bps"]);
  if (!Number.isInteger(maxSlipBps) || maxSlipBps < 1 || maxSlipBps > 1000) throw new Error("--max-slip-bps must be 1..1000");
  let expiry: bigint;
  if (v.expiry !== undefined) {
    if (!/^[0-9]{1,12}$/.test(v.expiry)) throw new Error("--expiry must be a unix time in seconds");
    expiry = BigInt(v.expiry);
    if (expiry <= now) throw new Error("--expiry is in the past");
  } else {
    const days = Number(v["expiry-days"]);
    if (!Number.isInteger(days) || days < 1) throw new Error("--expiry-days must be a positive integer");
    expiry = now + BigInt(days) * 86_400n;
  }
  return {
    agentId: BigInt(v["agent-id"]!),
    maxPerTrade: parseUnits(v["max-per-trade"]!, 6),
    dailyLimit: parseUnits(v["daily-limit"]!, 6),
    expiry,
    maxSlipBps,
    assets,
  };
}

/// Kernel v3.1 executor install data: hook address (none), then the router's onInstall data.
function installData(router: Address, o: InstallOpts): Hex {
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }, { type: "uint16" }, { type: "address[]" }],
    [o.agentId, o.maxPerTrade, o.dailyLimit, o.expiry, o.maxSlipBps, o.assets],
  );
  return encodeFunctionData({
    abi: kernelAbi,
    functionName: "installModule",
    args: [EXECUTOR, router, concat([zeroAddress, encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], [data, "0x"])])],
  });
}

function out(obj: Record<string, unknown>) {
  console.log(JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  if (obj.sent === false) process.exitCode = 2; // waiting for the owner's signature
}

function addressArg(a: string | undefined, name: string): Address {
  if (!a || !isAddress(a)) throw new Error(`${name} must be an address\n${USAGE}`);
  return getAddress(a);
}

function senderKey(): PrivateKeyAccount {
  const path = process.env.FILLMARK_KEY_FILE;
  if (!path) throw new Error("FILLMARK_KEY_FILE is not set");
  return loadKey(path);
}

const validatorAbi = parseAbi(["function ecdsaValidatorStorage(address) view returns (address owner)"]);

async function accountOwner(account: Address): Promise<Address> {
  const { pub } = clients();
  const owner = await pub.readContract({ address: ECDSA_VALIDATOR, abi: validatorAbi, functionName: "ecdsaValidatorStorage", args: [account] });
  if (owner === zeroAddress) throw new Error(`${account} has no ECDSA owner`);
  return owner;
}

/// A 65-byte signature with v as 27/28 (some wallets return 0/1, which ecrecover rejects).
function signatureArg(s: string | undefined): Hex | undefined {
  if (s === undefined) return undefined;
  if (!/^0x[0-9a-fA-F]{130}$/.test(s)) throw new Error("--signature must be a 65-byte hex signature");
  const v = parseInt(s.slice(130), 16);
  return (v < 27 ? s.slice(0, 130) + (v + 27).toString(16) : s) as Hex;
}

const VERIFICATION_GAS = 300_000n;
const CALL_GAS = 1_000_000n;

type OpResult =
  | { tx: Hex }
  | { sent: false; owner: Address; userOpHash: Hex; userOp: Record<string, unknown>; next: string };

/// Sends a user operation through EntryPoint.handleOps, signed by the sending key when it
/// is the account owner, or by the owner's signature. Without one, returns the operation
/// and the hash to sign, and sends nothing. The hash is computed here, never taken from
/// the RPC: a signature over a hash the RPC chose could authorize any call from the account.
async function sendUserOp(sender: PrivateKeyAccount, account: Address, owner: Address, callData: Hex, ownerSig?: Hex): Promise<OpResult> {
  const { pub, wallet } = clients(sender);
  const nonce = await pub.readContract({ address: ENTRY_POINT, abi: entryPointAbi, functionName: "getNonce", args: [account, 0n] });
  const opHash = getUserOperationHash({
    chainId: 4663,
    entryPointAddress: ENTRY_POINT,
    entryPointVersion: "0.7",
    userOperation: {
      sender: account,
      nonce,
      callData,
      verificationGasLimit: VERIFICATION_GAS,
      callGasLimit: CALL_GAS,
      preVerificationGas: 0n,
      maxFeePerGas: 0n, // the account pays nothing; the sending key pays the transaction
      maxPriorityFeePerGas: 0n,
      signature: "0x",
    },
  });
  const op = {
    sender: account,
    nonce,
    initCode: "0x" as Hex,
    callData,
    accountGasLimits: pad(toHex((VERIFICATION_GAS << 128n) | CALL_GAS), { size: 32 }),
    preVerificationGas: 0n,
    gasFees: zeroHash,
    paymasterAndData: "0x" as Hex,
    signature: "0x" as Hex,
  };
  if (owner === sender.address) {
    if (ownerSig) throw new Error("--signature is not needed: the sending key is the owner");
    op.signature = await sender.sign({ hash: opHash });
  } else if (!ownerSig) {
    return {
      sent: false,
      owner,
      userOpHash: opHash,
      userOp: { chainId: 4663, entryPoint: ENTRY_POINT, sender: account, nonce, callData, verificationGasLimit: VERIFICATION_GAS, callGasLimit: CALL_GAS, gasFees: 0 },
      next: "sign userOpHash with the owner wallet (personal_sign), then run the same command with --signature",
    };
  } else {
    const raw = await recoverAddress({ hash: opHash, signature: ownerSig }).catch(() => zeroAddress);
    const eth = await recoverMessageAddress({ message: { raw: opHash }, signature: ownerSig }).catch(() => zeroAddress);
    if (raw !== owner && eth !== owner)
      throw new Error(`the signature is not the owner's (${owner}) over user operation ${opHash}; the nonce or amount may have changed, run the command again without --signature`);
    op.signature = ownerSig;
  }
  const { request } = await pub.simulateContract({
    address: ENTRY_POINT,
    abi: entryPointAbi,
    functionName: "handleOps",
    args: [[op], sender.address],
    account: sender,
  });
  const hash = await wallet!.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`handleOps tx ${hash} reverted`);
  const events = parseEventLogs({
    abi: entryPointAbi,
    logs: receipt.logs.filter((l) => getAddress(l.address) === getAddress(ENTRY_POINT)),
  }).filter((e) => "userOpHash" in e.args && e.args.userOpHash === opHash);
  const result = events.find((e) => e.eventName === "UserOperationEvent");
  if (!result || result.eventName !== "UserOperationEvent") throw new Error(`no UserOperationEvent in ${hash}`);
  if (!result.args.success) {
    const reason = events.find((e) => e.eventName === "UserOperationRevertReason");
    const data = reason?.eventName === "UserOperationRevertReason" ? reason.args.revertReason : "0x";
    throw new Error(`user operation failed in ${hash}: ${data}`);
  }
  return { tx: hash };
}

async function create(v: Record<string, string | undefined>) {
  const sender = senderKey();
  const owner = v.owner ? addressArg(v.owner, "--owner") : sender.address;
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const { pub, wallet } = clients(sender);
  if (owner === zeroAddress || (await pub.getCode({ address: owner }))) throw new Error("--owner must be a wallet address (no contract code)");
  const opts = installOpts(v, await checkedNow(pub));
  const root = concat(["0x01", ECDSA_VALIDATOR]);
  const data = encodeFunctionData({
    abi: kernelAbi,
    functionName: "initialize",
    args: [root, "0x0000000000000000000000000000000000000001", owner, "0x", [installData(router, opts)]],
  });
  const salt = pad(toHex(BigInt(v.salt ?? "0")), { size: 32 });
  const account = kernelAccountAddress(data, salt);
  const remote = await pub.readContract({ address: KERNEL_FACTORY, abi: kernelFactoryAbi, functionName: "getAddress", args: [data, salt] });
  if (remote !== account) throw new Error(`RPC says the account is ${remote}, computed ${account}; refusing`);
  if (await pub.getCode({ address: account })) throw new Error(`account ${account} already exists; use another --salt`);
  const { request } = await pub.simulateContract({
    address: KERNEL_FACTORY,
    abi: kernelFactoryAbi,
    functionName: "createAccount",
    args: [data, salt],
    account: sender,
  });
  const hash = await wallet!.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`createAccount tx ${hash} reverted`);
  if ((await accountOwner(account)) !== owner) throw new Error(`account ${account} was created without owner ${owner}`);
  out({ account, owner, paidBy: sender.address, router, tx: hash });
}

async function install(account: Address, v: Record<string, string | undefined>, sig?: Hex) {
  const sender = senderKey();
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const { pub } = clients();
  const opts = installOpts(v, await checkedNow(pub));
  const r = await sendUserOp(sender, account, await accountOwner(account), installData(router, opts), sig);
  // The expiry is part of the signed operation: the signed run must reuse it.
  if ("sent" in r) r.next = `sign userOpHash with the owner wallet (personal_sign), then run the same command with --expiry ${opts.expiry} instead of --expiry-days, and --signature`;
  out({ account, expiry: opts.expiry, ...r });
}

async function uninstall(account: Address, sig?: Hex) {
  const sender = senderKey();
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const callData = encodeFunctionData({ abi: kernelAbi, functionName: "uninstallModule", args: [EXECUTOR, router, "0x"] });
  out({ account, ...(await sendUserOp(sender, account, await accountOwner(account), callData, sig)) });
}

async function withdraw(account: Address, symbol: string | undefined, amount: string | undefined, to: string | undefined, sig?: Hex) {
  const token = symbol && Object.hasOwn(TOKENS, symbol) ? TOKENS[symbol] : undefined;
  if (!token || !amount) throw new Error(USAGE);
  const sender = senderKey();
  const { pub } = clients();
  const value =
    amount === "all"
      ? await pub.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [account] })
      : parseUnits(amount, token.decimals);
  // The owner is read once; with a wallet owner the recipient must be given, so the RPC
  // cannot choose where the tokens go.
  const owner = await accountOwner(account);
  let recipient: Address;
  if (to) recipient = addressArg(to, "--to");
  else if (owner === sender.address) recipient = sender.address;
  else throw new Error("the account owner is a wallet: give --to with the address that receives the tokens");
  const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, value] });
  const callData = encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [zeroHash, encodePacked(["address", "uint256", "bytes"], [token.address, 0n, transfer])],
  });
  const r = await sendUserOp(sender, account, owner, callData, sig);
  if ("sent" in r) r.next = `sign userOpHash with the owner wallet (personal_sign), then run the same command with amount ${formatUnits(value, token.decimals)} and --signature`;
  out({ account, token: symbol, amount: formatUnits(value, token.decimals), to: recipient, ...r });
}

async function status(account: Address) {
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const { pub } = clients();
  const [agentId, wallet, maxSlipBps, expiry, installId, installed, maxPerTrade, dailyLimit, spentToday, day] =
    await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [account] });
  const balances: Record<string, string> = {};
  for (const [sym, t] of Object.entries(TOKENS)) {
    const b = await pub.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account] });
    balances[sym] = formatUnits(b, t.decimals);
  }
  const assets: Record<string, unknown> = {};
  for (const [sym, addr] of Object.entries(ASSETS) as [string, Address][]) {
    const allowed = await pub.readContract({ address: router, abi: routerAbi, functionName: "isAllowed", args: [account, addr] });
    const s = await pub.readContract({ address: router, abi: routerAbi, functionName: "statsOf", args: [agentId, account, addr] });
    assets[sym] = {
      allowed,
      fills: s.fills,
      notionalUsdg: formatUnits(s.notional, 6),
      totalCostUsdg: formatUnits(s.sumCost, 6), // positive = paid over NAV
      costBps: s.notional > 0n ? Number((s.sumCost * 1_000_000n) / s.notional) / 100 : null,
      worstFillBps: s.fills > 0 ? Number(s.worst) / 100 : null,
    };
  }
  out({
    account,
    owner: await accountOwner(account).catch(() => null),
    installed,
    agentId,
    agentWallet: wallet,
    installId,
    maxSlipBps,
    expiry: new Date(Number(expiry) * 1000).toISOString(),
    maxPerTradeUsdg: formatUnits(maxPerTrade, 6),
    dailyLimitUsdg: formatUnits(dailyLimit, 6),
    spentTodayUsdg: day === (await pub.getBlock()).timestamp / 86_400n ? formatUnits(spentToday, 6) : "0",
    balances,
    assets,
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "agent-id": { type: "string" },
      "max-per-trade": { type: "string" },
      "daily-limit": { type: "string" },
      "expiry-days": { type: "string" },
      "max-slip-bps": { type: "string" },
      assets: { type: "string" },
      salt: { type: "string" },
      expiry: { type: "string" },
      owner: { type: "string" },
      to: { type: "string" },
      signature: { type: "string" },
    },
  });
  const [cmd, a1, a2, a3] = positionals;
  const sig = signatureArg(values.signature);
  if (sig && !["install", "withdraw", "uninstall"].includes(cmd ?? "")) throw new Error(`--signature is not used by ${cmd}\n${USAGE}`);
  if (values.owner && cmd !== "create") throw new Error(`--owner is only for create\n${USAGE}`);
  switch (cmd) {
    case "create":
      return create(values);
    case "install":
      return install(addressArg(a1, "account"), values, sig);
    case "status":
      return status(addressArg(a1, "account"));
    case "withdraw":
      return withdraw(addressArg(a1, "account"), a2, a3, values.to, sig);
    case "uninstall":
      return uninstall(addressArg(a1, "account"), sig);
    default:
      throw new Error(USAGE);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(revertName(err));
    process.exit(1);
  });
}
