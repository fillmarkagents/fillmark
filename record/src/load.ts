// Reads everything the record needs from chain with any viem client, then builds it.
import { getAddress, parseAbi, toHex, type Address, type Hex, type PublicClient } from "viem";
import { DEPLOY_BLOCK_V1, DEPLOY_BLOCK_V2, DEPLOY_BLOCK_V3, ECDSA_VALIDATOR, IDENTITY, REPUTATION, ROUTER_V1, ROUTER_V2, ROUTER_V3, TEAM_WALLETS } from "./config";
import { agentFrom, identityAbi } from "./identity";
import { standardCreation } from "./kernel";
import { NEW_FEEDBACK, buildRecord, decodeFeedback, decodeRouterLogs, needs, routerTopics, type Agent, type ChainRecord, type Decoded, type Feedback, type RawLog } from "./record";

const validatorAbi = parseAbi(["function ecdsaValidatorStorage(address) view returns (address owner)"]);
const ZERO = "0x0000000000000000000000000000000000000000";

export type LoadOptions = {
  toBlock?: bigint; // default: the head rounded down to `snap`
  snap?: bigint; // default 600 (about a minute), like fillmark.trade
  span?: bigint; // blocks per eth_getLogs, default 5,000,000
};

type RpcLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex };
const parse = (l: RpcLog): RawLog => ({ address: getAddress(l.address), topics: l.topics, data: l.data, blockNumber: BigInt(l.blockNumber), logIndex: Number(l.logIndex), transactionHash: l.transactionHash });

// eth_getLogs over [from, to] in pieces of at most `span` blocks.
export async function getLogs(client: PublicClient, filter: { address: Address; topics: (Hex | Hex[] | null)[] }, from: bigint, to: bigint, span: bigint): Promise<RawLog[]> {
  const parts: Promise<RawLog[]>[] = [];
  for (let a = from; a <= to; a += span) {
    const b = a + span - 1n < to ? a + span - 1n : to;
    parts.push(
      client
        .request({ method: "eth_getLogs", params: [{ address: filter.address, topics: filter.topics, fromBlock: toHex(a), toBlock: toHex(b) }] } as never)
        .then((logs) => (logs as RpcLog[]).map(parse)),
    );
  }
  return (await Promise.all(parts)).flat();
}

// Every reads buildRecord needs for these logs. A failed owner or setup read throws: an unknown
// owner must never be counted as an outside client. A failed identity read leaves that field null.
export async function readFor(client: PublicClient, decoded: ReturnType<typeof decodeRouterLogs>, block: bigint, timesFor: bigint[]) {
  const { accounts, created, agentIds } = needs(decoded);
  const team = new Set(TEAM_WALLETS.map((a) => a.toLowerCase()));
  const owners = new Map<string, Address | null>();
  await Promise.all(
    accounts.map(async (account) => {
      const owner = await client.readContract({ address: ECDSA_VALIDATOR, abi: validatorAbi, functionName: "ecdsaValidatorStorage", args: [account] });
      owners.set(account.toLowerCase(), owner !== ZERO ? getAddress(owner) : null);
    }),
  );
  const standard = new Map<string, boolean>();
  await Promise.all(
    accounts
      .filter((a) => {
        const o = owners.get(a.toLowerCase());
        return o && team.has(o.toLowerCase()) && created[a];
      })
      .map(async (account) => {
        const tx = await client.getTransaction({ hash: created[account] });
        standard.set(account.toLowerCase(), standardCreation(account, { to: tx.to ?? null, input: tx.input }) !== null);
      }),
  );
  const agents = new Map<bigint, Agent>();
  await Promise.all(
    agentIds.map(async (id) => {
      const read = <T>(functionName: "tokenURI" | "ownerOf" | "getAgentWallet") =>
        client.readContract({ address: IDENTITY, abi: identityAbi, functionName, args: [id] }).then((v) => v as T).catch(() => null);
      const [uri, owner, wallet] = await Promise.all([read<string>("tokenURI"), read<Address>("ownerOf"), read<Address>("getAgentWallet")]);
      agents.set(id, agentFrom(id, uri, owner, wallet));
    }),
  );
  const times = new Map<bigint, number>();
  await Promise.all(
    [...new Set([block, ...timesFor])].map(async (b) => {
      const t = await client.getBlock({ blockNumber: b }).then((x) => Number(x.timestamp)).catch(() => null);
      if (t !== null) times.set(b, t);
    }),
  );
  return { owners, standard, agents, times };
}

// The whole record up to a block, read from chain.
export async function loadRecord(client: PublicClient, opts: LoadOptions = {}): Promise<ChainRecord> {
  const { decoded, feedback, block } = await loadLogs(client, opts);
  const fillBlocks = decoded.filter((l) => l.name === "Filled").map((l) => l.blockNumber);
  const reads = await readFor(client, decoded, block, fillBlocks);
  return buildRecord(decoded, feedback, { block, ...reads });
}

// The router logs up to the snapshot block and the ERC-8004 entries in the fill transactions.
export async function loadLogs(client: PublicClient, opts: LoadOptions = {}): Promise<{ decoded: Decoded[]; feedback: Feedback[]; block: bigint }> {
  const snap = opts.snap ?? 600n;
  const span = opts.span ?? 5_000_000n;
  const head = opts.toBlock ?? (await client.getBlockNumber());
  const block = opts.toBlock ?? head - (head % snap);
  const routerLogs = (
    await Promise.all(
      (
        [
          [ROUTER_V1, DEPLOY_BLOCK_V1],
          [ROUTER_V2, DEPLOY_BLOCK_V2],
          [ROUTER_V3, DEPLOY_BLOCK_V3],
        ] as const
      ).flatMap(([router, from]) =>
        // One value per topic position: the public RPC refuses wide ranges with OR lists.
        routerTopics(router).map((topic) => getLogs(client, { address: router, topics: [topic] }, from, block, span)),
      ),
    )
  ).flat();
  const decoded = decodeRouterLogs(routerLogs);
  // The ERC-8004 entries are read from the fill transactions' receipts: entries anyone writes
  // elsewhere in the registry never need reading.
  const fillTxs = [...new Set(decoded.filter((l) => l.name === "Filled").map((l) => l.transactionHash))];
  const receipts = await Promise.all(fillTxs.map((hash) => client.getTransactionReceipt({ hash })));
  const feedbackLogs: RawLog[] = receipts.flatMap((rc) =>
    rc.logs
      .filter((l) => l.address.toLowerCase() === REPUTATION.toLowerCase() && l.topics[0] === NEW_FEEDBACK)
      .map((l) => ({ address: getAddress(l.address), topics: l.topics as Hex[], data: l.data, blockNumber: l.blockNumber, logIndex: l.logIndex, transactionHash: l.transactionHash })),
  );
  return { decoded, feedback: decodeFeedback(feedbackLogs), block };
}
