import { ServiceError } from "@osiris/platform/http.ts";

/** Everything the app knows about a signed-in user (osiris-auth's introspection answer). */
export interface Identity {
  sub: string;
  name: string | null;
  email: string | null;
  groups: string[];
}

export interface TokenVerifier {
  /** Development only: a missing bearer token is fine (signed in as `dev`); production always demands one. */
  optional?: boolean;
  /** Whose the access token is; throws `ServiceError` 401 when the token is bad, 403 without the required group. */
  identify(token: string): Promise<Identity>;
}

/** How long a token's owner is reused, so group changes apply within this time. */
const IDENTITY_TTL_MS = 60_000;
const IDENTITY_CACHE_MAX = 1000;

interface Introspected {
  sub?: string;
  email?: string | null;
  name?: string | null;
  groups?: string[];
  exp?: number;
  active?: boolean;
}

/**
 * Asks osiris-auth whose an access token is (RFC 7662, as the app's registered client), like the gateway does. An
 * inactive token is a `ServiceError` 401; osiris-auth refusing the app itself is a 502, so browsers don't start
 * signing in again. Members of no required group get a 403.
 */
export function introspection(options: { url: string; clientId: string; clientSecret: string; requiredGroup: string; fetchFn?: typeof fetch }): TokenVerifier {
  const authorization = `Basic ${Buffer.from(`${options.clientId}:${encodeURIComponent(options.clientSecret)}`).toString("base64")}`;
  const cache = new Map<string, { identity: Identity; expires: number }>();
  return {
    async identify(token) {
      const now = Date.now();
      const hit = cache.get(token);
      if (hit && hit.expires > now) return hit.identity;
      const res = await (options.fetchFn ?? fetch)(`${options.url}/introspect`, {
        method: "POST",
        headers: { authorization, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new ServiceError(`osiris-auth refused the introspection: ${res.status}`, 502);
      const answer = (await res.json()) as Introspected;
      if (!answer.active || !answer.sub) throw new ServiceError("Inactive token", 401);
      const identity: Identity = { sub: answer.sub, name: answer.name ?? null, email: answer.email ?? null, groups: answer.groups ?? [] };
      if (!identity.groups.includes(options.requiredGroup))
        throw new ServiceError(`Not a member of ${options.requiredGroup}`, 403);
      if (cache.size >= IDENTITY_CACHE_MAX) {
        for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
        if (cache.size >= IDENTITY_CACHE_MAX) cache.delete(cache.keys().next().value!);
      }
      cache.set(token, { identity, expires: Math.min(now + IDENTITY_TTL_MS, (answer.exp ?? now / 1000 + 60) * 1000) });
      return identity;
    },
  };
}

/** Development only: every request is signed in as `dev` (config refuses this in production). */
export function devVerifier(): TokenVerifier {
  return {
    optional: true,
    async identify() {
      return { sub: "dev", name: "dev", email: null, groups: ["admin"] };
    },
  };
}
