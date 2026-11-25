/// Where the agent keeps its policy state: pending fills, accounts skipped for the day after a
/// revert, and the day's send count. The default lives in memory and is lost on restart; pass a
/// store that writes to disk (as @fillmark/mcp does) to keep the caps across restarts.
export type Store = {
  get(key: string): string | undefined;
  set(key: string, value: string | undefined): void;
};

export function memoryStore(): Store {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => void (v === undefined ? m.delete(k) : m.set(k, v)),
  };
}
