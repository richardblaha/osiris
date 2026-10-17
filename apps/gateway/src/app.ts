import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { accessibleTenants, isAuthorized, isSystemAdmin, membershipsFromClaims, type Membership } from "@osiris/platform/claims.ts";
import { isUnreachable, retryUntil } from "@osiris/platform/http.ts";
import { CONTROL_AUDIENCE, tenantAudience, type InternalSigner, type InternalUser } from "@osiris/platform/internal-auth.ts";
import type { RuntimeClient } from "@osiris/platform/runtime-client.ts";
import type { ControlDirectory } from "./control.ts";
import type { Identity, TokenVerifier } from "./oidc.ts";
import { RateLimiter } from "./rate-limit.ts";

export interface GatewayDeps {
  verifier: TokenVerifier;
  signer: InternalSigner;
  control: ControlDirectory;
  controlUrl: string;
  runtimes: RuntimeClient;
  corsOrigin: string;
  maxBodyBytes: number;
  limits: { requestsPerMinute: number; runsPerMinute: number };
  /** In production the gateway also serves the built web app from `dir`, plus its runtime config at `/config.js`. */
  web?: { dir: string; oidcAuthority?: string; oidcClientId?: string };
  fetchFn?: typeof fetch;
}

interface Authenticated {
  user: Identity;
  memberships: Membership[];
  systemAdmin: boolean;
}

type Env = { Variables: { auth: Authenticated } };

/** API paths answered by control; everything else under /api belongs to the active tenant's runtime. */
const CONTROL_PATHS = /^\/api\/(me|admin|tenant|members|schedules|domains|sites)(\/|$)/;

/** Request headers passed on to the services; credentials and hop-by-hop headers are not. */
const FORWARD_REQUEST = ["content-type", "accept", "x-tenant-id", "x-hub-signature-256"];
/** Response headers passed back to the browser. */
const FORWARD_RESPONSE = ["content-type", "content-disposition", "cache-control", "content-security-policy", "x-content-type-options", "retry-after"];

/** A 403 that tells the user who they are signed in as and which claims arrived, so a misconfigured account is easy to fix. */
class AccessDeniedError extends HTTPException {
  constructor(
    message: string,
    readonly user: Record<string, unknown>,
  ) {
    super(403, { message });
  }
}

const describeUser = (user: Identity) => ({
  sub: user.sub,
  name: user.name,
  email: user.email,
  role: user.access.roles,
  tenant: user.access.tenants,
  "tenant-admin": user.access.adminTenants,
  ...(user.claimKeys ? { claims: user.claimKeys } : {}),
});

const plainUser = (u: Identity): InternalUser => ({ sub: u.sub, name: u.name, email: u.email, phone: u.phone, picture: u.picture });

/**
 * The only entry point from the internet for osiris.k6labs.cz. Verifies the PocketID token, works out the user's
 * tenants from their claims, and passes each call on with a short internal token: account, administration, schedules
 * and sites to control; the rest to the active tenant's runtime, which is woken up first if it sleeps. Services
 * behind it never see a PocketID token, and network policies let only the gateway reach them.
 */
export function createGatewayApp(deps: GatewayDeps) {
  const { verifier, signer, control, runtimes, web } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const requests = new RateLimiter(deps.limits.requestsPerMinute);
  const runs = new RateLimiter(deps.limits.runsPerMinute);

  const authenticate = createMiddleware<Env>(async (c, next) => {
    const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) throw new HTTPException(401, { message: "Missing bearer token" });
    let user: Identity;
    try {
      user = await verifier.identify(token);
    } catch {
      throw new HTTPException(401, { message: "Invalid token" });
    }
    const deny = (message: string) => {
      const details = describeUser(user);
      console.warn(`Access denied: ${message}`, details);
      return new AccessDeniedError(message, details);
    };
    if (!isAuthorized(user.access)) throw deny("User has no Osiris role (claim role=osiris-user or osiris-admin)");
    const systemAdmin = isSystemAdmin(user.access);
    // Claims may name tenants that were removed; only active ones count. A tenant just created may be missing from
    // the cached list, so an unknown one triggers a reload.
    let active = (await control.list()).map((t) => t.id);
    if (membershipsFromClaims(user.access).some((m) => !active.includes(m.tenantId))) {
      active = (await control.list({ refresh: true })).map((t) => t.id);
    }
    const memberships = accessibleTenants(user.access, active).filter((m) => active.includes(m.tenantId));
    if (!memberships.length && !systemAdmin) throw deny("User is not assigned to any tenant (claim tenant or tenant-admin)");
    if (!requests.take(user.sub)) throw new HTTPException(429, { message: "Příliš mnoho požadavků, zkus to za chvíli" });
    c.set("auth", { user, memberships, systemAdmin });
    await next();
  });

  const forwardHeaders = (c: Context, authorization: string) => {
    const headers: Record<string, string> = authorization ? { authorization } : {};
    for (const h of FORWARD_REQUEST) {
      const v = c.req.header(h);
      if (v) headers[h] = v;
    }
    return headers;
  };

  const relay = (res: Response) => {
    const headers = new Headers();
    for (const h of FORWARD_RESPONSE) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers });
  };

  const body = async (c: Context) => (["GET", "HEAD"].includes(c.req.method) ? undefined : new Uint8Array(await c.req.arrayBuffer()));

  const toControl = async (c: Context<Env>) => {
    const { user, memberships, systemAdmin } = c.get("auth");
    const authorization = await signer.header(CONTROL_AUDIENCE, { user: plainUser(user), memberships, systemAdmin, claimKeys: user.claimKeys });
    const url = new URL(c.req.url);
    const res = await fetchFn(`${deps.controlUrl}${url.pathname}${url.search}`, {
      method: c.req.method,
      headers: forwardHeaders(c, authorization),
      body: await body(c),
      signal: c.req.raw.signal,
    });
    return relay(res);
  };

  const toRuntime = async (c: Context<Env>) => {
    const { user, memberships } = c.get("auth");
    const requested = c.req.header("x-tenant-id");
    const membership = requested ? memberships.find((m) => m.tenantId === requested) : memberships.length === 1 ? memberships[0] : undefined;
    if (!membership) {
      throw new HTTPException(requested ? 403 : 400, { message: requested ? "Not a member of this tenant" : "X-Tenant-Id header required" });
    }
    if (c.req.method === "POST" && /^\/api\/threads\/[^/]+\/runs$/.test(c.req.path) && !runs.take(user.sub)) {
      throw new HTTPException(429, { message: "Příliš mnoho zpráv za minutu, zkus to za chvíli" });
    }
    const authorization = await signer.header(tenantAudience(membership.tenantId), {
      user: plainUser(user),
      tenant: membership.tenantId,
      role: membership.role,
      channel: "web",
    });
    const url = new URL(c.req.url);
    // The body is buffered, so the request can be sent again after waking a sleeping runtime.
    const res = await runtimes.request(membership.tenantId, `${url.pathname}${url.search}`, {
      method: c.req.method,
      headers: forwardHeaders(c, authorization),
      body: await body(c),
      signal: c.req.raw.signal,
    });
    return relay(res);
  };

  const api = new Hono<Env>()
    .use(bodyLimit({ maxSize: deps.maxBodyBytes, onError: (c) => c.json({ error: "Požadavek je příliš velký" }, 413) }))
    .use(authenticate)
    .all("*", (c) => (CONTROL_PATHS.test(c.req.path) ? toControl(c) : toRuntime(c)));

  const app = new Hono()
    .use(async (c, next) => {
      await next();
      c.header("x-content-type-options", "nosniff");
      c.header("referrer-policy", "strict-origin-when-cross-origin");
      c.header("x-frame-options", "DENY");
      c.header("strict-transport-security", "max-age=31536000");
      // The SPA itself: own scripts only; PocketID for login, silent renew and avatars.
      if (!c.res.headers.has("content-security-policy") && (c.res.headers.get("content-type") ?? "").includes("text/html")) {
        const idp = web?.oidcAuthority ? new URL(web.oidcAuthority).origin : "";
        c.header(
          "content-security-policy",
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${idp}; connect-src 'self' ${idp}; frame-src ${idp || "'none'"}; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${idp}`,
        );
      }
    })
    .use("/api/*", cors({ origin: deps.corsOrigin, allowHeaders: ["authorization", "content-type", "x-tenant-id"] }))
    .get("/health", (c) => c.json({ ok: true }))
    .route("/api", api)
    // Meta's webhook goes to control as it came; control checks Meta's signature.
    .all("/webhooks/whatsapp", bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
      const url = new URL(c.req.url);
      const payload = c.req.method === "POST" ? new Uint8Array(await c.req.arrayBuffer()) : undefined;
      const res = await retryUntil(
        () =>
          fetchFn(`${deps.controlUrl}/webhooks/whatsapp${url.search}`, {
            method: c.req.method,
            headers: forwardHeaders(c, ""),
            body: payload,
          }),
        Date.now() + 5_000,
      ).catch((err) => {
        if (isUnreachable(err)) throw new HTTPException(503, { message: "Control unavailable" });
        throw err;
      });
      return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "text/plain" } });
    })
    // Runtime config for the web client, so one image works with any PocketID client. Loaded before the app bundle.
    .get("/config.js", (c) => {
      const config = { oidcAuthority: web?.oidcAuthority, oidcClientId: web?.oidcClientId };
      c.header("cache-control", "no-cache");
      return c.body(`window.__OSIRIS_CONFIG__ = ${JSON.stringify(config)};\n`, 200, { "content-type": "text/javascript" });
    });

  if (web) {
    app
      .use("/assets/*", async (c, next) => {
        await next();
        // Vite puts a content hash in asset file names.
        if (c.res.ok) c.header("cache-control", "public, max-age=31536000, immutable");
      })
      .use("*", serveStatic({ root: web.dir }))
      // SPA fallback: client-side routes such as /callback get index.html.
      .get("*", serveStatic({ root: web.dir, path: "index.html" }));
  }

  return app.onError((err, c) => {
    if (err instanceof AccessDeniedError) return c.json({ error: err.message, user: err.user }, err.status);
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (isUnreachable(err)) {
      console.error("Service unreachable", err);
      return c.json({ error: "Služba je dočasně nedostupná, zkus to za chvíli" }, 503);
    }
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });
}
