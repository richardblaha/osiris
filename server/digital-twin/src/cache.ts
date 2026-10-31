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

/** The minimal Redis client the cache needs (node-redis's client satisfies it). */
export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>;
}

/**
 * A cache in Redis: the answers the API gives are shared by every replica of the service (the twins run as several
 * pods), and they expire on their own. Keys are prefixed so they are recognizable in the database.
 */
export function redisCache(client: RedisCacheClient, prefix = "osiris:cache"): Cache {
  return {
    async get<T>(key: string) {
      const hit = await client.get(`${prefix}:${key}`);
      return hit === null ? undefined : (JSON.parse(hit) as T);
    },
    async set(key, value, ttlSeconds) {
      await client.set(`${prefix}:${key}`, JSON.stringify(value), { PX: ttlSeconds * 1000 });
    },
  };
}

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
