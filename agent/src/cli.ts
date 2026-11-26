// Fillmark client CLI: create a Kernel account with router v3 installed, check it,
// withdraw from it, uninstall the router, and settle, release, close out or pay an agent's
// fees, claim a payout the router could not send, or open, check and end a Fillmark Pay
// agreement with an agent. User operations go straight to the
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
import { payAbi, routerAbi } from "./abi.generated.js";
import {
  ECDSA_VALIDATOR,
  ENTRY_POINT,
  KERNEL_FACTORY,
  PAY,
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
import { WAITS, payAllowance, payCloseCallData, payOpenCallData } from "./pay.js";

const EXECUTOR = 2n;
const TOKENS: Record<string, { address: Address; decimals: number }> = { USDG: { address: USDG, decimals: 6 } };
for (const [t, address] of Object.entries(ASSETS)) TOKENS[t] = { address, decimals: ASSET_DECIMALS[t]! };

const USAGE = `usage:
  fillmark create    --agent-id N --max-per-trade USDG --daily-limit USDG (--expiry-days N | --expiry UNIX) --max-slip-bps N --perf-fee-bps N --assets TSLA,NVDA,WETH,... [--regular-only] [--salt N] [--owner ADDRESS]
  fillmark install   <account> (same flags as create, without --salt and --owner) [--signature 0x...]
  fillmark status    <account> [--agent-id N]
  fillmark withdraw  <account> <USDG|ticker> <amount|all> [--to ADDRESS] [--signature 0x...]
  fillmark uninstall <account> [--signature 0x...]
  fillmark settle    <account>
  fillmark release   <account>
  fillmark close-out <account> --agent-id N
  fillmark pay-debt  <account> --agent-id N [--signature 0x...]
  fillmark claim     <address>
  fillmark pay-open   <account> --agent-id N [--allowance USDG] [--signature 0x...]
  fillmark pay-close  <account> --agent-id N [--keep-allowance] [--signature 0x...]
  fillmark pay-status <account> --agent-id N

--perf-fee-bps is the share of net realized gains the agent earns (0 to 3000, the agent's terms).
--daily-limit counts buys and their fill fees over any 24 hours; sales do not count.
--regular-only: stocks fill only in the regular US session, never in extended hours.
release returns fee escrow no fee can need, without pricing any token (settle prices them all).
claim sends an address the USDG the router could not pay it (for example while USDG froze it).
pay-open approves USDG to Fillmark Pay and opens an agreement with the agent on its current
terms, tracking every asset the account allows. The account has one allowance for all its
agreements; by default pay-open adds the rate on twice the daily buy limit for each day until
the permission ends and 7 days after (--allowance sets the whole allowance instead).
pay-close ends it and sets the allowance to 0; --keep-allowance leaves it for another open
agreement. The agent is paid only by settling, itself.

tickers (assets.json, exact case): ${Object.keys(ASSETS).join(",")}`;

type InstallOpts = {
  agentId: bigint;
  maxPerTrade: bigint;
  dailyLimit: bigint;
  expiry: bigint;
  maxSlipBps: number;
  perfFeeBps: number;
  regularOnly: boolean;
  assets: Address[];
};

function installOpts(v: Record<string, string | undefined>, now: bigint, regularOnly: boolean): InstallOpts {
  for (const k of ["agent-id", "max-per-trade", "daily-limit", "max-slip-bps", "perf-fee-bps", "assets"]) {
    if (!v[k]) throw new Error(`--${k} is required\n${USAGE}`);
  }
  if ((v["expiry-days"] === undefined) === (v.expiry === undefined)) throw new Error(`give --expiry-days or --expiry\n${USAGE}`);
  const assets = v.assets!.split(",").map((t) => {
    if (!isTicker(t)) throw new Error(`unknown asset ${t}`);
    return ASSETS[t] as Address;
  });
  const maxSlipBps = Number(v["max-slip-bps"]);
  if (!Number.isInteger(maxSlipBps) || maxSlipBps < 1 || maxSlipBps > 1000) throw new Error("--max-slip-bps must be 1..1000");
  if (!/^[0-9]{1,4}$/.test(v["perf-fee-bps"]!) || Number(v["perf-fee-bps"]) > 3000) throw new Error("--perf-fee-bps must be 0..3000");
  const perfFeeBps = Number(v["perf-fee-bps"]);
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
    perfFeeBps,
    regularOnly,
    assets,
  };
}

/// Kernel v3.1 executor install data: hook address (none), then the router's onInstall data.
function installData(router: Address, o: InstallOpts): Hex {
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }, { type: "uint16" }, { type: "uint16" }, { type: "bool" }, { type: "address[]" }],
    [o.agentId, o.maxPerTrade, o.dailyLimit, o.expiry, o.maxSlipBps, o.perfFeeBps, o.regularOnly, o.assets],
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
// Removing the router closes the agent's book in the same call, and an install first
// closes a book left open: room for a large book (about 90k gas per token).
const BOOK_GAS = 4_000_000n;

type OpResult =
  | { tx: Hex }
  | { sent: false; owner: Address; userOpHash: Hex; userOp: Record<string, unknown>; next: string };

/// Sends a user operation through EntryPoint.handleOps, signed by the sending key when it
/// is the account owner, or by the owner's signature. Without one, returns the operation
/// and the hash to sign, and sends nothing. The hash is computed here, never taken from
/// the RPC: a signature over a hash the RPC chose could authorize any call from the account.
async function sendUserOp(sender: PrivateKeyAccount, account: Address, owner: Address, callData: Hex, ownerSig?: Hex, callGas = CALL_GAS): Promise<OpResult> {
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
      callGasLimit: callGas,
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
    accountGasLimits: pad(toHex((VERIFICATION_GAS << 128n) | callGas), { size: 32 }),
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
      userOp: { chainId: 4663, entryPoint: ENTRY_POINT, sender: account, nonce, callData, verificationGasLimit: VERIFICATION_GAS, callGasLimit: callGas, gasFees: 0 },
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

async function create(v: Record<string, string | undefined>, regularOnly: boolean) {
  const sender = senderKey();
  const owner = v.owner ? addressArg(v.owner, "--owner") : sender.address;
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const { pub, wallet } = clients(sender);
  if (owner === zeroAddress || (await pub.getCode({ address: owner }))) throw new Error("--owner must be a wallet address (no contract code)");
  const opts = installOpts(v, await checkedNow(pub), regularOnly);
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

async function install(account: Address, v: Record<string, string | undefined>, regularOnly: boolean, sig?: Hex) {
  const sender = senderKey();
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const { pub } = clients();
  const opts = installOpts(v, await checkedNow(pub), regularOnly);
  const r = await sendUserOp(sender, account, await accountOwner(account), installData(router, opts), sig, BOOK_GAS);
  // The expiry is part of the signed operation: the signed run must reuse it.
  if ("sent" in r) r.next = `sign userOpHash with the owner wallet (personal_sign), then run the same command with --expiry ${opts.expiry} instead of --expiry-days, and --signature`;
  out({ account, expiry: opts.expiry, ...r });
}

/// Removing the router closes the agent's book at the NAV of that moment when every
/// token can be priced; otherwise the book stays open until close-out runs.
async function uninstall(account: Address, sig?: Hex) {
  const sender = senderKey();
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const { pub } = clients();
  const [agentId] = await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [account] });
  const callData = encodeFunctionData({ abi: kernelAbi, functionName: "uninstallModule", args: [EXECUTOR, router, "0x"] });
  const r = await sendUserOp(sender, account, await accountOwner(account), callData, sig, BOOK_GAS);
  if ("sent" in r) return out({ account, agentId, ...r });
  const book = await pub.readContract({ address: router, abi: routerAbi, functionName: "bookOf", args: [account, agentId] });
  out({
    account,
    agentId,
    ...r,
    bookClosed: !book.closing,
    debtUsdg: formatUnits(book.debt, 6),
    ...(book.closing ? { next: `close-out did not run (no price for a token now): run close-out ${account} --agent-id ${agentId} once there is one` } : {}),
  });
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

async function status(account: Address, agentIdArg?: string) {
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const { pub } = clients();
  const [cfgAgentId, wallet, maxSlipBps, perfFeeBps, expiry, installId, installed, regularOnly, maxPerTrade, dailyLimit] =
    await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [account] });
  const spent = await pub.readContract({ address: router, abi: routerAbi, functionName: "windowSpent", args: [account] });
  // After uninstall the config is cleared: --agent-id reads that agent's book.
  const agentId = agentIdArg !== undefined ? agentIdOf(agentIdArg) : cfgAgentId;
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
      feedbackRefused: s.feedbackFails, // fills whose record the registry refused
    };
  }
  const book = await pub.readContract({ address: router, abi: routerAbi, functionName: "bookOf", args: [account, agentId] });
  const positions: Record<string, unknown> = {};
  for (const token of await pub.readContract({ address: router, abi: routerAbi, functionName: "tokensOf", args: [account, agentId] })) {
    const sym = Object.keys(TOKENS).find((k) => TOKENS[k]!.address === getAddress(token)) ?? token;
    const dec = TOKENS[sym]?.decimals ?? 18;
    const [lot, pending, later, moved] = await pub.readContract({ address: router, abi: routerAbi, functionName: "positionOf", args: [account, agentId, token] });
    const when = (t: bigint) => (t > 0n ? new Date(Number(t) * 1000).toISOString() : null);
    positions[sym] = {
      qty: formatUnits(lot.qty, dec),
      costUsdg: formatUnits(lot.cost, 6),
      gainInHoldUsdg: formatUnits(pending.gain, 6),
      feeEscrowUsdg: formatUnits(pending.esc, 6), // held by the router until the gain matures
      holdUntil: when(pending.until),
      laterGainInHoldUsdg: formatUnits(later.gain, 6),
      laterFeeEscrowUsdg: formatUnits(later.esc, 6),
      laterHoldUntil: when(later.until),
      movedOutQty: formatUnits(moved.qty, dec),
      movedOutGainUsdg: formatUnits(moved.gain, 6),
      movedOutUntil: when(moved.until),
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
    perfFeeBps,
    fillFeeBps: await pub.readContract({ address: router, abi: routerAbi, functionName: "fillFeeBps" }),
    expiry: new Date(Number(expiry) * 1000).toISOString(),
    regularOnly,
    maxPerTradeUsdg: formatUnits(maxPerTrade, 6),
    dailyLimitUsdg: formatUnits(dailyLimit, 6),
    spentLast24hUsdg: formatUnits(spent, 6), // buys and their fill fees
    claimableUsdg: formatUnits(await pub.readContract({ address: router, abi: routerAbi, functionName: "claimable", args: [account] }), 6),
    balances,
    assets,
    book: {
      realizedUsdg: formatUnits(book.realized, 6), // losses at once, gains after their hold
      peakUsdg: formatUnits(book.peak, 6), // highest gain already charged
      feesPaidUsdg: formatUnits(book.paid, 6),
      debtUsdg: formatUnits(book.debt, 6),
      maturedFeeEscrowUsdg: formatUnits(book.escMatured, 6), // pays the next fee; the rest goes back
      perfFeeBps: book.perfFeeBps,
      closing: book.closing, // removed: close-out books the rest
    },
    positions,
  });
}

function agentIdOf(v: string | undefined): bigint {
  if (!v || !/^[0-9]{1,78}$/.test(v)) throw new Error(`--agent-id must be a number\n${USAGE}`);
  return BigInt(v);
}

/// A plain transaction from the sending key to the router: settle, release, close-out and
/// claim are open to anyone, and move funds only between the router, the client's account
/// and the agent's wallet.
async function routerTx(functionName: "settle" | "closeOut" | "release" | "claim", args: readonly [Address] | readonly [Address, bigint]) {
  const sender = senderKey();
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const { pub, wallet } = clients(sender);
  const { request, result } = await pub.simulateContract({ address: router, abi: routerAbi, functionName, args: args as any, account: sender });
  // A fifth above the estimate, as the app sends: the estimate is exact for one block only.
  const gas = ((await pub.estimateContractGas({ address: router, abi: routerAbi, functionName, args: args as any, account: sender })) * 6n) / 5n;
  const hash = await wallet!.writeContract({ ...request, gas });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} tx ${hash} reverted`);
  return { feeUsdg: formatUnits((result as bigint | undefined) ?? 0n, 6), tx: hash };
}

async function release(account: Address) {
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const { pub } = clients();
  const [agentId] = await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [account] });
  const before = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  const { tx } = await routerTx("release", [account]);
  const after = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  const book = await pub.readContract({ address: router, abi: routerAbi, functionName: "bookOf", args: [account, agentId] });
  out({ account, agentId, tx, accountUsdgChange: formatUnits(after - before, 6), maturedFeeEscrowUsdg: formatUnits(book.escMatured, 6), debtUsdg: formatUnits(book.debt, 6) });
}

async function claim(who: Address) {
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const { pub } = clients();
  const amount = await pub.readContract({ address: router, abi: routerAbi, functionName: "claimable", args: [who] });
  if (amount === 0n) throw new Error(`${who} has nothing to claim`);
  const { tx } = await routerTx("claim", [who]);
  out({ to: who, claimedUsdg: formatUnits(amount, 6), tx });
}

async function settle(account: Address) {
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const { pub } = clients();
  const [agentId] = await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [account] });
  const r = await routerTx("settle", [account]);
  const book = await pub.readContract({ address: router, abi: routerAbi, functionName: "bookOf", args: [account, agentId] });
  out({ account, agentId, ...r, debtUsdg: formatUnits(book.debt, 6) });
}

async function closeOut(account: Address, agentId: bigint) {
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const r = await routerTx("closeOut", [account, agentId]);
  const { pub } = clients();
  const book = await pub.readContract({ address: router, abi: routerAbi, functionName: "bookOf", args: [account, agentId] });
  out({ account, agentId, ...r, debtUsdg: formatUnits(book.debt, 6) });
}

/// Pays the whole debt to an agent: one batch from the account, approve then payDebt.
async function payDebt(account: Address, agentId: bigint, sig?: Hex) {
  const sender = senderKey();
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const { pub } = clients();
  const { debt } = await pub.readContract({ address: router, abi: routerAbi, functionName: "bookOf", args: [account, agentId] });
  if (debt === 0n) throw new Error(`${account} owes agent ${agentId} nothing`);
  const calls = [
    { target: USDG, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, debt] }) },
    { target: router, value: 0n, callData: encodeFunctionData({ abi: routerAbi, functionName: "payDebt", args: [agentId, debt] }) },
  ];
  const batch = encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
    [calls],
  );
  const callData = encodeFunctionData({ abi: kernelAbi, functionName: "execute", args: [pad("0x01", { dir: "right", size: 32 }), batch] });
  const r = await sendUserOp(sender, account, await accountOwner(account), callData, sig);
  out({ account, agentId, debtUsdg: formatUnits(debt, 6), ...r });
}

/// Opens a Fillmark Pay agreement in one batch from the account: approve, then open.
async function payOpen(account: Address, agentId: bigint, allowanceArg: string | undefined, sig?: Hex) {
  const sender = senderKey();
  const router = addressArg(process.env.FILLMARK_ROUTER, "FILLMARK_ROUTER");
  const { pub } = clients();
  const terms = await pub.readContract({ address: PAY, abi: payAbi, functionName: "termsOf", args: [agentId] });
  if (terms.minZeroAtBps === 0) throw new Error(`agent ${agentId} has set no Fillmark Pay terms`);
  const [cfgAgentId, , , , expiry, , installed, , , dailyLimit] = await pub.readContract({ address: router, abi: routerAbi, functionName: "configs", args: [account] });
  if (!installed || cfgAgentId !== agentId) throw new Error(`agent ${agentId} has no permission on this account`);
  const all = Object.values(ASSETS) as Address[];
  const allowed = await Promise.all(all.map((t) => pub.readContract({ address: router, abi: routerAbi, functionName: "isAllowed", args: [account, t] })));
  const tokens = all.filter((_, i) => allowed[i]);
  const { carry } = await pub.readContract({ address: PAY, abi: payAbi, functionName: "agreementOf", args: [account, agentId] });
  const given = await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [account, PAY] });
  const allowance =
    allowanceArg !== undefined ? parseUnits(allowanceArg, 6) : given + payAllowance(terms.rateBps, dailyLimit, expiry, await checkedNow(pub), carry);
  const callData = payOpenCallData(agentId, terms.rateBps, terms.minZeroAtBps, tokens, allowance);
  const r = await sendUserOp(sender, account, await accountOwner(account), callData, sig);
  if ("sent" in r) r.next = `sign userOpHash with the owner wallet (personal_sign), then run the same command with --allowance ${formatUnits(allowance, 6)} and --signature`;
  out({ account, agentId, rateBps: terms.rateBps, zeroAtBps: terms.minZeroAtBps, tokens: tokens.length, allowanceUsdg: formatUnits(allowance, 6), ...r });
}

/// Ends the agreement (what is still owed becomes carry, billed only if the account opens
/// with this agent again) and, unless keepAllowance, sets Fillmark Pay's USDG allowance to 0,
/// in one batch.
async function payClose(account: Address, agentId: bigint, keepAllowance: boolean, sig?: Hex) {
  const sender = senderKey();
  const callData = payCloseCallData(agentId, !keepAllowance);
  const r = await sendUserOp(sender, account, await accountOwner(account), callData, sig);
  out({ account, agentId, ...r });
}

async function payStatus(account: Address, agentId: bigint) {
  const { pub } = clients();
  const [terms, a, d, tokens, allowance] = await Promise.all([
    pub.readContract({ address: PAY, abi: payAbi, functionName: "termsOf", args: [agentId] }),
    pub.readContract({ address: PAY, abi: payAbi, functionName: "agreementOf", args: [account, agentId] }),
    pub.readContract({ address: PAY, abi: payAbi, functionName: "dueOf", args: [account, agentId] }),
    pub.readContract({ address: PAY, abi: payAbi, functionName: "tokensOf", args: [account, agentId] }),
    pub.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [account, PAY] }),
  ]);
  const ticker = (t: Address) => Object.keys(ASSETS).find((k) => ASSETS[k] === getAddress(t)) ?? t;
  out({
    account,
    agentId,
    agentTerms: { rateBps: terms.rateBps, minZeroAtBps: terms.minZeroAtBps },
    open: a.open,
    rateBps: a.rateBps,
    zeroAtBps: a.zeroAtBps,
    tokens: tokens.map((b) => ticker(b.token)),
    earnedUsdg: formatUnits(d.accrued, 6),
    paidUsdg: formatUnits(d.paid, 6),
    carryUsdg: formatUnits(d.carry, 6),
    dueUsdg: formatUnits(d.due, 6),
    payableNowUsdg: formatUnits(d.payNow, 6),
    wait: WAITS[d.wait] ?? d.wait,
    allowanceUsdg: formatUnits(allowance, 6),
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
      "perf-fee-bps": { type: "string" },
      assets: { type: "string" },
      salt: { type: "string" },
      expiry: { type: "string" },
      owner: { type: "string" },
      to: { type: "string" },
      signature: { type: "string" },
      allowance: { type: "string" },
      "keep-allowance": { type: "boolean", default: false },
      "regular-only": { type: "boolean", default: false },
    },
  });
  const [cmd, a1, a2, a3] = positionals;
  const sig = signatureArg(values.signature);
  if (sig && !["install", "withdraw", "uninstall", "pay-debt", "pay-open", "pay-close"].includes(cmd ?? "")) throw new Error(`--signature is not used by ${cmd}\n${USAGE}`);
  if (values.allowance !== undefined && (cmd !== "pay-open" || !/^\d+(\.\d{1,6})?$/.test(values.allowance))) throw new Error(`--allowance is a USDG amount for pay-open\n${USAGE}`);
  if (values["keep-allowance"] && cmd !== "pay-close") throw new Error(`--keep-allowance is only for pay-close\n${USAGE}`);
  if (values.owner && cmd !== "create") throw new Error(`--owner is only for create\n${USAGE}`);
  const regularOnly = values["regular-only"] === true;
  if (regularOnly && cmd !== "create" && cmd !== "install") throw new Error(`--regular-only is only for create and install\n${USAGE}`);
  const { "regular-only": _, "keep-allowance": keepAllowance, ...strings } = values;
  switch (cmd) {
    case "create":
      return create(strings, regularOnly);
    case "install":
      return install(addressArg(a1, "account"), strings, regularOnly, sig);
    case "status":
      return status(addressArg(a1, "account"), values["agent-id"]);
    case "withdraw":
      return withdraw(addressArg(a1, "account"), a2, a3, values.to, sig);
    case "uninstall":
      return uninstall(addressArg(a1, "account"), sig);
    case "settle":
      return settle(addressArg(a1, "account"));
    case "release":
      return release(addressArg(a1, "account"));
    case "claim":
      return claim(addressArg(a1, "address"));
    case "close-out":
      return closeOut(addressArg(a1, "account"), agentIdOf(values["agent-id"]));
    case "pay-debt":
      return payDebt(addressArg(a1, "account"), agentIdOf(values["agent-id"]), sig);
    case "pay-open":
      return payOpen(addressArg(a1, "account"), agentIdOf(values["agent-id"]), values.allowance, sig);
    case "pay-close":
      return payClose(addressArg(a1, "account"), agentIdOf(values["agent-id"]), keepAllowance, sig);
    case "pay-status":
      return payStatus(addressArg(a1, "account"), agentIdOf(values["agent-id"]));
    default:
      throw new Error(USAGE);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    // Our own errors print in full (usage text included); viem errors only by their
    // reason, since their message can carry the RPC URL.
    console.error(err instanceof Error && !("shortMessage" in err) ? err.message : revertName(err));
    process.exit(1);
  });
}
