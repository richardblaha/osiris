/**
 * A cache for the telemetry and history answers, in the process: the twin runs as one replica (its SQLite), so
 * nothing needs sharing. Entries expire after their TTL; the oldest go first past `max` entries. Values are copied
 * through JSON, so a cached answer is never changed by its user.
 */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/** No cache: tests that count the sources' calls. */
export const noCache: Cache = {
  async get() {
    return undefined;
  },
  async set() {},
};

export function memoryCache(max = 2000, now: () => number = Date.now): Cache {
  const entries = new Map<string, { json: string; expires: number }>();
  return {
    async get<T>(key: string) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) {
        entries.delete(key);
        return undefined;
      }
      return JSON.parse(hit.json) as T;
    },
    async set(key: string, value: unknown, ttlSeconds: number) {
      entries.delete(key);
      if (entries.size >= max) entries.delete(entries.keys().next().value!);
      entries.set(key, { json: JSON.stringify(value), expires: now() + ttlSeconds * 1000 });
    },
  };
}
