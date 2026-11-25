// Reads the live record and checks it against itself across contracts: every fill's ERC-8004
// entries (written by the client account to the Reputation Registry) must carry the same cost
// and size as the router's Filled event, and the totals must add up.
// RPC=<Robinhood Chain RPC> npm test
import { createPublicClient, http } from "viem";
import { PAGE, agentFillsPage, agentRecord, agentsList, costPer100, loadRecord, totals } from "../src/index";

const rpc = process.env.RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const client = createPublicClient({ transport: http(rpc, { batch: { batchSize: 10 }, retryCount: 3, timeout: 30_000 }) });
let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};

const r = await loadRecord(client as never);
console.log(`record at block ${r.block}: ${r.fills.length} fills, ${r.agents.length} agents, ${r.accounts.length} client accounts`);

for (const f of r.fills) {
  const entries = r.feedback.filter((x) => x.tx === f.tx && x.hash.toLowerCase() === f.fillId.toLowerCase());
  const failed = r.feedbackFails.filter((x) => x.tx === f.tx && x.hash.toLowerCase() === f.fillId.toLowerCase()).length;
  const ext = f.session === 1 ? "-ext" : "";
  const cost = entries.find((x) => x.tag1 === `fillmark-cost${ext}`);
  const size = entries.find((x) => x.tag1 === `fillmark-notional${ext}`);
  const name = `${f.tx.slice(0, 10)} (${f.asset?.ticker ?? f.stock})`;
  if (failed) {
    check(`${name}: registry refused ${failed} entr${failed === 1 ? "y" : "ies"}, the rest match`, entries.length + failed === 2);
    continue;
  }
  check(`${name}: two ERC-8004 entries from the client account`, entries.length === 2 && entries.every((x) => x.client === f.account && x.agentId === f.agentId));
  check(`${name}: entry cost ${cost?.value} = Filled cost ${f.cost}`, cost?.value === f.cost && cost?.valueDecimals === 6);
  check(`${name}: entry size ${size?.value} = Filled USDG ${f.usdg}`, size?.value === f.usdg && size?.valueDecimals === 6);
  check(`${name}: has a block time`, f.time !== null);
}

const now = Math.floor(Date.now() / 1000);
check("agents list matches the record", agentsList(r).agents.length === r.agents.length);
for (const a of r.agents) {
  const rec = agentRecord(r, a.agentId, now)!;
  const fills = r.fills.filter((f) => f.agentId === a.agentId);
  const t = totals(fills);
  check(`agent ${a.agentId}: fill count`, rec.totals.fills === fills.length && rec.totals.buys + rec.totals.sells === fills.length);
  check(`agent ${a.agentId}: assets add up`, rec.assets.reduce((s, x) => s + x.fills, 0) === fills.length);
  check(`agent ${a.agentId}: routers add up`, rec.routers.v1 + rec.routers.v2 + rec.routers.v3 === fills.length);
  const per = costPer100(t);
  check(`agent ${a.agentId}: cost per 100 USDG`, per === null || rec.totals.costPer100Usdg !== null);
  const c = rec.clients;
  check(`agent ${a.agentId}: client kinds add up`, c.independent + c.linkedToAgent + c.team + c.unknown === c.total && c.active <= c.total);
  const last = agentFillsPage(r, a.agentId, null)!;
  let seen = 0;
  for (let p = 1; p <= last.pages; p++) seen += agentFillsPage(r, a.agentId, p)!.fills.length;
  check(`agent ${a.agentId}: ${last.pages} page(s) of ${PAGE} hold every fill once`, seen === fills.length);
}

console.log(failures ? `FAILED: ${failures}` : "ALL OK");
process.exit(failures ? 1 : 0);
