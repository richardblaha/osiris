import { createClient, type RedisClientType } from "redis";

/**
 * A JSON cache for the twin's structure and the telemetry answers. Redis keeps every replica of the service on the
 * same page; when Redis is missing (not configured) or unreachable, everything passes through to the sources —
 * the twin keeps working, just without caching. Values are stored as JSON strings, so any JSON-serialisable value
 * can go in and come back unchanged.
 */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /**
   * Takes or renews a lease: true when `owner` holds `key` for the next `ttlSeconds`. Without Redis there is one
   * replica and it always holds it; with Redis unreachable nobody does (better no record than a doubled one).
   */
  claim(key: string, owner: string, ttlSeconds: number): Promise<boolean>;
}

/** No cache: development without Redis. */
export const noCache: Cache = {
  async get() {
    return undefined;
  },
  async set() {},
  async claim() {
    return true;
  },
};

/** Redis, never throwing: a broken cache must not break the twin. */
export function redisCache(url: string): Cache {
  // The client reconnects on its own; commands sent while disconnected fail fast and are swallowed here.
  const client = createClient({ url }) as RedisClientType;
  const ready = client.connect().catch((err) => console.error("Redis connect failed", err));
  const wrap = async (action: () => Promise<unknown>) => {
    try {
      await ready;
      return await action();
    } catch {
      return undefined;
    }
  };
  return {
    async get<T>(key: string) {
      const raw = (await wrap(() => client.get(key))) as string | undefined | null;
      if (raw == null) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    },
    async set(key: string, value: unknown, ttlSeconds: number) {
      await wrap(() => client.set(key, JSON.stringify(value), { EX: ttlSeconds }));
    },
    async claim(key: string, owner: string, ttlSeconds: number) {
      const held = await wrap(async () => {
        if ((await client.set(key, owner, { NX: true, EX: ttlSeconds })) === "OK") return true;
        if ((await client.get(key)) !== owner) return false;
        await client.expire(key, ttlSeconds);
        return true;
      });
      return held === true;
    },
  };
}
