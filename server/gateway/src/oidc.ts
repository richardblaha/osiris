import { accessFromClaims, accessFromGroups, type Access } from "@osiris/platform/claims.ts";
import { ServiceError } from "@osiris/platform/http.ts";

/** Everything we know about a user, as osiris-auth (the identity provider) has it. */
export interface Identity {
  sub: string;
  email: string | null;
  name: string | null;
  /** E.164, verified over WhatsApp. */
  phone: string | null;
  /** Profile picture URL. */
  picture: string | null;
  /** From the groups `osiris-user`, `osiris-admin`, `project:<slug>` and `project-admin:<slug>`. */
  access: Access;
  /** The user's groups, to tell a missing group from a wrong one when access is refused. */
  claimKeys?: string[];
}

export interface TokenVerifier {
  /** Verifies the access token and returns the user's identity. Throws if the token is invalid. */
  identify(token: string): Promise<Identity>;
}

/** What osiris-auth's token introspection (RFC 7662) answers for an active token. */
export interface TokenOwner {
  sub: string;
  email: string | null;
  name: string | null;
  phone_number: string | null;
  picture: string | null;
  groups: string[];
  /** When the token expires (epoch seconds). */
  exp: number;
}

/** How long a token's owner is reused, so group changes apply within this time. */
const IDENTITY_TTL_MS = 60_000;
const IDENTITY_CACHE_MAX = 1000;

/**
 * Asks osiris-auth whose an access token is (RFC 7662, as client `osiris-gateway`). An inactive token is a
 * `ServiceError` 401; osiris-auth refusing the gateway itself is a 502, so browsers don't start signing in again.
 */
export function introspection(options: { url: string; clientSecret: string; fetchFn?: typeof fetch }) {
  const authorization = `Basic ${Buffer.from(`osiris-gateway:${encodeURIComponent(options.clientSecret)}`).toString("base64")}`;
  return async (token: string): Promise<TokenOwner> => {
    const res = await (options.fetchFn ?? fetch)(`${options.url}/introspect`, {
      method: "POST",
      headers: { authorization, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new ServiceError(`osiris-auth refused the introspection: ${res.status}`, 502);
    const answer = (await res.json()) as Partial<TokenOwner> & { active?: boolean };
    if (!answer.active || !answer.sub) throw new ServiceError("Inactive token", 401);
    return answer as TokenOwner;
  };
}

/**
 * Access tokens are opaque and issued by osiris-auth; it says whose a token is (and whether it is still valid), and
 * the answer is cached briefly per token. `identify` throws `ServiceError` 401 for a bad token.
 */
export function createTokenVerifier(lookup: (token: string) => Promise<TokenOwner>): TokenVerifier {
  const cache = new Map<string, { identity: Identity; expires: number }>();
  return {
    async identify(token) {
      const now = Date.now();
      const hit = cache.get(token);
      if (hit && hit.expires > now) return hit.identity;
      const owner = await lookup(token);
      const identity: Identity = {
        sub: owner.sub,
        email: owner.email ?? null,
        name: owner.name ?? null,
        phone: owner.phone_number ?? null,
        picture: owner.picture ?? null,
        access: accessFromGroups(owner.groups),
        claimKeys: [...(owner.groups ?? [])].sort(),
      };
      if (cache.size >= IDENTITY_CACHE_MAX) {
        for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
        if (cache.size >= IDENTITY_CACHE_MAX) cache.delete(cache.keys().next().value!);
      }
      cache.set(token, { identity, expires: Math.min(now + IDENTITY_TTL_MS, owner.exp * 1000) });
      return identity;
    },
  };
}

/**
 * Development-only verifier, rejected in production by config. The bearer token is `<user>` or `<user>:<claims>`,
 * the claims written like a query string: `alice:project=acme,beta&project-admin=gamma&role=osiris-admin`.
 * `role` defaults to `osiris-user` (`role=` for none); a bare `<user>` is admin of their own project `<user>`.
 */
export function createDevVerifier(): TokenVerifier {
  return {
    async identify(token) {
      const [user = "", query] = token.split(":", 2);
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(user)) throw new Error("Dev user must be a lowercase slug");
      const claims = new URLSearchParams(query ?? `project-admin=${user}`);
      if (!claims.has("role")) claims.set("role", "osiris-user");
      return {
        sub: `dev:${user}`,
        email: `${user}@dev.local`,
        name: user,
        phone: null,
        picture: null,
        access: accessFromClaims((key) => claims.get(key) ?? undefined),
      };
    },
  };
}
