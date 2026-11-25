// An agent's ERC-8004 identity: name and first sentence of its description from the
// registration file, cleaned so one agent's text cannot read as another's.
import { parseAbi, type Address } from "viem";
import type { Agent } from "./record";

export const identityAbi = parseAbi([
  "function tokenURI(uint256 agentId) view returns (string)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);

// Control, zero-width, direction and tag characters.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\u{e0000}-\u{e007f}]/gu;
const clean = (s: string) => s.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
// At most n characters, never splitting a character outside the basic plane.
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");

export function cleanName(name: string): string | null {
  const s = clean(name);
  return s ? cut(s, 48) : null;
}

// The registration file of a data URI, decoded as UTF-8.
function registration(uri: string): { name?: unknown; description?: unknown } | null {
  const prefix = "data:application/json;base64,";
  if (!uri.startsWith(prefix)) return null;
  try {
    const bytes = Uint8Array.from(atob(uri.slice(prefix.length)), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as { name?: unknown; description?: unknown };
  } catch {
    return null;
  }
}

export function agentName(uri: string): string | null {
  const json = registration(uri);
  return json && typeof json.name === "string" ? cleanName(json.name) : null;
}

// The first sentence of the agent's description, cleaned like a name, at most 160 characters.
export function agentSummary(uri: string): string | null {
  const json = registration(uri);
  if (!json || typeof json.description !== "string") return null;
  const s = clean(json.description);
  if (!s) return null;
  // A sentence ends at . ! or ? followed by a capital letter or the end, so "e.g. the" does not end it.
  const first = s.match(/^.+?[.!?](?=\s+\p{Lu}|$)/u)?.[0] ?? s;
  return Array.from(first).length > 160 ? `${cut(first, 159).trimEnd()}…` : first;
}

const ZERO = "0x0000000000000000000000000000000000000000";

// An agent from the three registry reads; a read that failed is null.
export function agentFrom(agentId: bigint, uri: string | null, owner: Address | null, wallet: Address | null): Agent {
  // A transferred agent NFT clears its wallet to the zero address.
  return { agentId, name: uri ? agentName(uri) : null, summary: uri ? agentSummary(uri) : null, owner, wallet: wallet && wallet !== ZERO ? wallet : null };
}
