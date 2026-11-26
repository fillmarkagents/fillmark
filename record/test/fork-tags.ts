// Run by agent/e2e/strategy.ts: the fills the reference agent made on a fork, with the strategy
// and setting the agent logged for each, must get the same tags from their fillIds alone.
// tsx test/fork-tags.ts <file>
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";
import type { Fill } from "../src/record";
import { parseSetting, tagFills, type Setting } from "../src/strategy";

type In = {
  settings: unknown[];
  fills: { router: string; fillId: Hex; account: string; agentId: string; stock: string; buy: boolean; usdg: string; time: number; strategy: string; setting: Hex | null }[];
};
const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as In;
const settings = new Map<string, Setting[]>();
for (const raw of input.settings) {
  const s = parseSetting(raw);
  const k = s.account.toLowerCase();
  settings.set(k, [...(settings.get(k) ?? []), s]);
}
const fills = input.fills.map(
  (f) => ({ ...f, router: getAddress(f.router), account: getAddress(f.account), stock: getAddress(f.stock), agentId: BigInt(f.agentId), usdg: BigInt(f.usdg) }) as unknown as Fill,
);
const tags = tagFills(fills, settings);
for (const f of input.fills) assert.deepEqual(tags.get(f.fillId.toLowerCase()), { strategy: f.strategy, setting: f.setting }, `fill ${f.fillId}`);
assert.ok(input.fills.length > 0);
console.log(`FORK TAGS OK (${input.fills.length} fills)`);
