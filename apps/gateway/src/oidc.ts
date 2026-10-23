import { accessFromClaims, type Access } from "@osiris/platform/claims.ts";

/** Everything we know about a user, as control (the identity provider) has it. */
export interface Identity {
  sessionUid?: string;
  sub: string;
  email: string | null;
  name: string | null;
  /** Claim `phone_number` (E.164), verified over WhatsApp. */
  phone: string | null;
  /** Profile picture URL. */
  picture: string | null;
  /** Claims `role`, `project` and `project-admin`: whether the user may use Osiris and in which projects. */
  access: Access;
  /** Names of the claims the user has, to tell a missing claim from a wrong value when access is refused. */
  claimKeys?: string[];
}

export interface TokenVerifier {
  /** Verifies the access token and returns the user's identity. Throws if the token is invalid. */
  identify(token: string): Promise<Identity>;
}

/** What control answers for a token: the user and the claims that grant access. */
export interface TokenOwner {
  sessionUid?: string;
  sub: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  picture: string | null;
  claims: Record<string, unknown>;
  /** When the token expires (epoch ms). */
  expiresAt: number;
}

/** How long a token's owner is reused, so role and project changes apply within this time. */
const IDENTITY_TTL_MS = 60_000;
const IDENTITY_CACHE_MAX = 1000;

/**
 * Access tokens are opaque and issued by control's OIDC provider; control says whose a token is (and whether it is
 * still valid), and the answer is cached briefly per token. `identify` throws `ServiceError` 401 for a bad token.
 */
export function createControlVerifier(lookup: (token: string) => Promise<TokenOwner>): TokenVerifier {
  const cache = new Map<string, { identity: Identity; expires: number }>();
  return {
    async identify(token) {
      const now = Date.now();
      const hit = cache.get(token);
      if (hit && hit.expires > now) return hit.identity;
      const owner = await lookup(token);
      const identity: Identity = {
        sub: owner.sub,
        sessionUid: owner.sessionUid,
        email: owner.email,
        name: owner.name,
        phone: owner.phone,
        picture: owner.picture,
        access: accessFromClaims((key) => owner.claims[key]),
        claimKeys: Object.keys(owner.claims).filter((k) => owner.claims[k] !== undefined && owner.claims[k] !== null).sort(),
      };
      if (cache.size >= IDENTITY_CACHE_MAX) {
        for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
        if (cache.size >= IDENTITY_CACHE_MAX) cache.delete(cache.keys().next().value!);
      }
      cache.set(token, { identity, expires: Math.min(now + IDENTITY_TTL_MS, owner.expiresAt) });
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
