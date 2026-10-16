import { createRemoteJWKSet, jwtVerify } from "jose";

/** Everything we know about a user; PocketID is the only source (standard claims, custom claims and groups). */
export interface Identity {
  sub: string;
  email: string | null;
  name: string | null;
  /** PocketID custom claim `phone_number` (E.164), set on the user. */
  phone: string | null;
  groups: string[];
}

export interface TokenVerifier {
  /** Verifies the access token and returns the user's identity. Throws if the token is invalid. */
  identify(token: string): Promise<Identity>;
}

interface Discovery {
  issuer: string;
  jwks_uri: string;
  userinfo_endpoint: string;
}

/** How long a token's userinfo is reused, so role and group changes in PocketID apply within this time. */
const USERINFO_TTL_MS = 60_000;
const USERINFO_CACHE_MAX = 1000;

/**
 * Verifies PocketID access tokens against the issuer's JWKS. PocketID access tokens carry only `sub`;
 * profile, custom claims and groups come from the userinfo endpoint, cached briefly per token.
 * The web client must request the `profile email groups` scopes.
 */
export function createOidcVerifier(issuer: string, audience: string): TokenVerifier {
  let discovery: Promise<{ doc: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> }> | undefined;
  const cache = new Map<string, { identity: Identity; expires: number }>();

  const discover = () =>
    (discovery ??= (async () => {
      const res = await fetch(new URL(".well-known/openid-configuration", issuer.endsWith("/") ? issuer : `${issuer}/`));
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
      const doc = (await res.json()) as Discovery;
      return { doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) };
    })().catch((err) => {
      discovery = undefined;
      throw err;
    }));

  return {
    async identify(token) {
      const { doc, jwks } = await discover();
      const { payload } = await jwtVerify(token, jwks, { issuer: doc.issuer, audience });
      if (!payload.sub) throw new Error("Token has no sub");

      const now = Date.now();
      const hit = cache.get(token);
      if (hit && hit.expires > now) return hit.identity;

      const res = await fetch(doc.userinfo_endpoint, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
      const info = (await res.json()) as Record<string, unknown>;
      if (info.sub !== payload.sub) throw new Error("userinfo sub does not match token");
      const identity = toIdentity(info);

      if (cache.size >= USERINFO_CACHE_MAX) {
        for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
        if (cache.size >= USERINFO_CACHE_MAX) cache.delete(cache.keys().next().value!);
      }
      const tokenExpires = payload.exp ? payload.exp * 1000 : Infinity;
      cache.set(token, { identity, expires: Math.min(now + USERINFO_TTL_MS, tokenExpires) });
      return identity;
    },
  };
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function toIdentity(info: Record<string, unknown>): Identity {
  return {
    sub: String(info.sub),
    email: str(info.email),
    name: str(info.name),
    phone: str(info.phone_number),
    groups: Array.isArray(info.groups) ? info.groups.filter((g): g is string => typeof g === "string") : [],
  };
}

/**
 * Development-only verifier, rejected in production by config. The bearer token is `<user>` or
 * `<user>:<group>,<group>`; without groups the user is admin of their own tenant `<user>`
 * (e.g. `alice:osiris-tenant-acme,osiris-admin`).
 */
export function createDevVerifier(): TokenVerifier {
  return {
    async identify(token) {
      const [user = "", groups] = token.split(":", 2);
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(user)) throw new Error("Dev user must be a lowercase slug");
      return {
        sub: `dev:${user}`,
        email: `${user}@dev.local`,
        name: user,
        phone: null,
        groups: groups ? groups.split(",") : [`osiris-tenant-${user}-admin`],
      };
    },
  };
}
