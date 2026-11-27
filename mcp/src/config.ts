import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { STRATEGIES, type Store, type Strategy } from "@fillmark/sdk";

export type Config = {
  agentId: bigint;
  rpc: string | undefined; // undefined: the chain's public RPC, read mode only
  keyFile: string | undefined;
  fills: boolean;
  maxFillsPerDay: number;
  minEth: string;
  stateDir: string;
  strategies: Strategy[];
  settingsUrl: string | undefined;
};

/// A secret file must be readable by its owner only.
export function readSecret(path: string): string {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} must be readable by its owner only (chmod 600)`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid())
    throw new Error(`${path} must belong to the user running the server`);
  return readFileSync(path, "utf8").trim();
}

export function loadConfig(env = process.env): Config {
  const id = env.FILLMARK_AGENT_ID ?? "";
  if (!/^[0-9]{1,30}$/.test(id)) throw new Error("set FILLMARK_AGENT_ID to the agent's ERC-8004 id (digits only)");
  const rpc = env.FILLMARK_RPC || (env.FILLMARK_RPC_FILE ? readSecret(env.FILLMARK_RPC_FILE) : undefined);
  if (rpc !== undefined && !/^https?:\/\//.test(rpc)) throw new Error("the RPC must be an http(s) URL");
  const keyFile = env.FILLMARK_KEY_FILE || undefined;
  const fills = env.FILLMARK_ENABLE_FILLS === "1";
  if (fills && !keyFile) throw new Error("FILLMARK_ENABLE_FILLS=1 needs FILLMARK_KEY_FILE");
  if (fills && !rpc) throw new Error("sending fills needs your own RPC: set FILLMARK_RPC or FILLMARK_RPC_FILE");
  const maxFillsPerDay = Number(env.FILLMARK_MAX_FILLS_PER_DAY ?? "50");
  if (!Number.isInteger(maxFillsPerDay) || maxFillsPerDay < 1 || maxFillsPerDay > 1000)
    throw new Error("FILLMARK_MAX_FILLS_PER_DAY must be 1 to 1000");
  const minEth = env.FILLMARK_MIN_ETH ?? "0.0005";
  if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(minEth)) throw new Error("FILLMARK_MIN_ETH must be an ETH amount");
  const strategies = (env.FILLMARK_STRATEGIES ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  for (const x of strategies)
    if (!(STRATEGIES as readonly string[]).includes(x)) throw new Error(`FILLMARK_STRATEGIES: unknown strategy ${x} (known: ${STRATEGIES.join(", ")})`);
  const settingsUrl = env.FILLMARK_SETTINGS_URL || undefined;
  if (settingsUrl !== undefined && !/^https?:\/\//.test(settingsUrl)) throw new Error("FILLMARK_SETTINGS_URL must be an http(s) URL");
  return {
    agentId: BigInt(id),
    rpc,
    keyFile: fills ? keyFile : undefined,
    fills,
    maxFillsPerDay,
    minEth,
    stateDir: env.FILLMARK_STATE_DIR || join(homedir(), ".fillmark-mcp"),
    strategies: [...new Set(strategies)] as Strategy[],
    settingsUrl,
  };
}

/// A directory only the server's user can enter.
export function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} must be private to its owner (chmod 700)`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid())
    throw new Error(`${dir} must belong to the user running the server`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    return err?.code === "EPERM";
  }
  // A reused pid belongs to some other program: only a running fillmark server holds the lock.
  const cmd = `/proc/${pid}/cmdline`;
  try {
    if (!existsSync(cmd)) return true;
    const line = readFileSync(cmd, "utf8");
    return line.includes("fillmark") || (process.argv[1] !== undefined && line.includes(process.argv[1]));
  } catch {
    return false; // it exited meanwhile
  }
}

/// An exclusive lock file holding this process's pid, created whole (written to a temporary file,
/// then hard-linked into place) so no one ever reads it half written. A lock left by a process
/// that is gone, by this process's own pid, or with no valid pid is stale and taken over. Returns
/// the release.
export function takeLock(path: string, what: string): () => void {
  const mine = `${process.pid}\n`;
  for (let i = 0; i < 3; i++) {
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
    writeFileSync(tmp, mine, { mode: 0o600, flag: "wx" });
    try {
      linkSync(tmp, path);
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      let held = "";
      try {
        held = readFileSync(path, "utf8");
      } catch {}
      const pid = Number(held.trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid))
        throw new Error(`another fillmark-mcp (pid ${pid}) already sends for ${what}; run one sending server per agent wallet`);
      // Stale: remove it only if it still holds what was read.
      try {
        if (readFileSync(path, "utf8") === held) unlinkSync(path);
      } catch {}
      continue;
    } finally {
      unlinkSync(tmp);
    }
    if (readFileSync(path, "utf8") !== mine) continue;
    return () => {
      try {
        if (readFileSync(path, "utf8") === mine) unlinkSync(path);
      } catch {}
    };
  }
  throw new Error(`could not take the lock ${path}`);
}

/// The SDK's policy state in a 0600 JSON file, so the daily caps, pending fills and skipped
/// accounts survive a restart. Days older than yesterday are dropped on load. Only the sending
/// server (which holds the agent's lock) writes it.
export function fileStore(dir: string, agentId: bigint): Store {
  privateDir(dir);
  const path = join(dir, `agent-${agentId}.json`);
  let data: Record<string, string> = {};
  try {
    data = JSON.parse(readSecret(path));
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  const today = BigInt(Math.floor(Date.now() / 86_400_000));
  for (const k of Object.keys(data)) {
    const day = k.match(/:(?:sent|banned|settle):([0-9]+)/)?.[1];
    if (day !== undefined && BigInt(day) < today - 1n) delete data[k];
  }
  const save = () => {
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  };
  save();
  return {
    get: (k) => data[k],
    set: (k, v) => {
      if (v === undefined) delete data[k];
      else data[k] = v;
      save();
    },
  };
}
