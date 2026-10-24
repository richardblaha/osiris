import { getConnInfo } from "@hono/node-server/conninfo";
import { blockList, clientIp as resolveClientIp } from "@osiris/platform/client-ip.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { accessibleProjects, isAuthorized, isSystemAdmin, membershipsFromClaims, PROJECT_SLUG, type Membership } from "@osiris/platform/claims.ts";
import { isUnreachable, retryUntil, ServiceError } from "@osiris/platform/http.ts";
import { CONTROL_AUDIENCE, projectAudience, type InternalSigner, type InternalUser } from "@osiris/platform/internal-auth.ts";
import type { RuntimeClient } from "@osiris/platform/runtime-client.ts";
import type { ControlDirectory } from "./control.ts";
import type { Identity, TokenVerifier } from "./oidc.ts";
import { RateLimiter } from "./rate-limit.ts";
import { telemetryMiddleware } from "@osiris/platform/telemetry.ts";
import { errorBody, HttpError, requestLocale, translate } from "@osiris/platform/i18n.ts";

export interface GatewayDeps {
  verifier: TokenVerifier;
  trustedProxies?: string;
  cdnProxies?: string;
  signer: InternalSigner;
  control: ControlDirectory;
  controlUrl: string;
  runtimes: RuntimeClient;
  corsOrigin: string;
  maxBodyBytes: number;
  limits: { requestsPerMinute: number; runsPerMinute: number };
  /**
   * In production the gateway also serves the built web app from `dir`. With `goatcounter` (a GoatCounter site's
   * URL, e.g. https://osiris.stats.k6labs.cz) the page loads its count.js, allowed by the CSP.
   */
  web?: { dir: string; goatcounter?: string };
  fetchFn?: typeof fetch;
}

interface Authenticated {
  user: Identity;
  memberships: Membership[];
  systemAdmin: boolean;
}

type Env = { Variables: { auth: Authenticated } };

/** API paths answered by control; everything else under /api belongs to the active project's runtime. */
const CONTROL_PATHS = /^\/api\/(me|admin|project|members|schedules|dashboards|analytics)(\/|$)/;

/** Request headers passed on to the services; credentials and hop-by-hop headers are not. */
const FORWARD_REQUEST = ["content-type", "accept", "accept-language", "x-project-id", "x-hub-signature-256"];
/** Response headers passed back to the browser. */
const FORWARD_RESPONSE = ["content-type", "content-disposition", "cache-control", "content-security-policy", "x-content-type-options", "retry-after"];
/** Sign-in (`/auth`, control's OIDC provider and the sign-in screens' API) takes cookies and answers with redirects. */
const AUTH_REQUEST = ["content-type", "accept", "accept-language", "cookie", "user-agent", "origin", "authorization", "dpop"];
const AUTH_RESPONSE = [...FORWARD_RESPONSE, "location", "pragma", "www-authenticate", "dpop-nonce", "access-control-allow-origin", "vary"];
const AUTH_BODY_BYTES = 64 * 1024;

/** A 403 that tells the user who they are signed in as and which claims arrived, so a misconfigured account is easy to fix. */
class AccessDeniedError extends HttpError {
  constructor(
    key: string,
    readonly user: Record<string, unknown>,
  ) {
    super(403, key);
  }
}

const describeUser = (user: Identity) => ({
  sub: user.sub,
  name: user.name,
  email: user.email,
  role: user.access.roles,
  project: user.access.projects,
  "project-admin": user.access.adminProjects,
  ...(user.claimKeys ? { claims: user.claimKeys } : {}),
});

const tooLarge = (key: string) => (c: Context) => c.json({ error: translate(requestLocale(c.req.header("accept-language")), key), code: key }, 413);

const plainUser = (u: Identity): InternalUser => ({ sub: u.sub, name: u.name, email: u.email, phone: u.phone, picture: u.picture });

/**
 * The only entry point from the internet for osiris.k6labs.cz. Passes sign-in (`/auth`) to control, which is the
 * OpenID Connect provider. For the API it has control identify the access token, works out the user's projects from
 * their claims, and passes each call on with a short internal token: account, administration, schedules and dashboards to
 * control; the rest to the active project's runtime, which is woken up first if it sleeps. Services behind it never see
 * an access token, and network policies let only the gateway reach them.
 */
export function createGatewayApp(deps: GatewayDeps) {
  const trusted = blockList(deps.trustedProxies ?? "");
  const cdn = blockList(deps.cdnProxies ?? "");
  const clientIp = (c: Context) => {
    let peer = "";
    try { peer = getConnInfo(c).remote.address ?? ""; } catch { /* In-memory tests have no socket. */ }
    return resolveClientIp(peer, { realIp: c.req.header("x-real-ip"), forwardedFor: c.req.header("x-forwarded-for"), cdnClientIp: c.req.header("cf-connecting-ip") }, trusted, cdn) || "unknown";
  };
  const { verifier, signer, control, runtimes, web } = deps;
  const stats = web?.goatcounter ? new URL(web.goatcounter).origin : "";
  const csp = [
    "default-src 'self'",
    `script-src 'self'${stats ? ` ${stats}` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${stats ? ` ${stats}` : ""}`,
    `connect-src 'self'${stats ? ` ${stats}` : ""}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
  const fetchFn = deps.fetchFn ?? fetch;
  const requests = new RateLimiter(deps.limits.requestsPerMinute);
  const signIns = new RateLimiter(deps.limits.requestsPerMinute);
  const runs = new RateLimiter(deps.limits.runsPerMinute);
  // The public chat (anonymous customers): per address, tighter for messages.
  const publicRequests = new RateLimiter(60);
  const publicRuns = new RateLimiter(10);

  const authenticate = createMiddleware<Env>(async (c, next) => {
    const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) throw new HTTPException(401, { message: "Missing bearer token" });
    let user: Identity;
    try {
      user = await verifier.identify(token);
    } catch (err) {
      // Control down is not a bad token: the browser must not start signing in again.
      if (isUnreachable(err) || (err instanceof ServiceError && err.status >= 500)) throw err;
      throw new HTTPException(401, { message: "Invalid token" });
    }
    const deny = (key: string) => {
      const details = describeUser(user);
      const err = new AccessDeniedError(key, details);
      console.warn(`Access denied: ${err.message}`, details);
      return err;
    };
    if (!isAuthorized(user.access)) throw deny("errors.access.noRole");
    const systemAdmin = isSystemAdmin(user.access);
    // Claims may name projects that were removed; only active ones count. A project just created may be missing from
    // the cached list, so an unknown one triggers a reload.
    let active = (await control.list()).map((t) => t.id);
    if (membershipsFromClaims(user.access).some((m) => !active.includes(m.projectId))) {
      active = (await control.list({ refresh: true })).map((t) => t.id);
    }
    const memberships = accessibleProjects(user.access, active).filter((m) => active.includes(m.projectId));
    if (!memberships.length && !systemAdmin) throw deny("errors.access.noProject");
    if (!requests.take(user.sub)) throw new HttpError(429, "errors.tooManyRequests");
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
    const authorization = await signer.header(CONTROL_AUDIENCE, { user: plainUser(user), memberships, systemAdmin, claimKeys: user.claimKeys, sessionUid: user.sessionUid });
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
    const requested = c.req.header("x-project-id");
    const membership = requested ? memberships.find((m) => m.projectId === requested) : memberships.length === 1 ? memberships[0] : undefined;
    if (!membership) {
      throw requested ? new HttpError(403, "errors.access.notMember") : new HttpError(400, "errors.projectRequired");
    }
    if (c.req.method === "POST" && /^\/api\/threads\/[^/]+\/runs$/.test(c.req.path) && !runs.take(user.sub)) {
      throw new HttpError(429, "errors.tooManyMessages");
    }
    const authorization = await signer.header(projectAudience(membership.projectId), {
      user: plainUser(user),
      project: membership.projectId,
      role: membership.role,
      channel: "web",
    });
    const url = new URL(c.req.url);
    // The body is buffered, so the request can be sent again after waking a sleeping runtime.
    const res = await runtimes.request(membership.projectId, `${url.pathname}${url.search}`, {
      method: c.req.method,
      headers: forwardHeaders(c, authorization),
      body: await body(c),
      signal: c.req.raw.signal,
    });
    return relay(res);
  };

  /** Sign-in goes to control as it came, cookies and all; redirects go back to the browser. */
  const toAuth = async (c: Context) => {
    const url = new URL(c.req.url);
    if (!signIns.take(clientIp(c))) throw new HttpError(429, "errors.tooManyRequests");
    const headers: Record<string, string> = {
      // Control builds its URLs and cookie flags from these (the gateway sits behind Traefik, which sets them).
      "x-forwarded-proto": c.req.header("x-forwarded-proto") ?? url.protocol.slice(0, -1),
      "x-forwarded-host": c.req.header("x-forwarded-host") ?? url.host,
      "x-forwarded-for": clientIp(c),
    };
    for (const h of AUTH_REQUEST) {
      const v = c.req.header(h);
      if (v) headers[h] = v;
    }
    const res = await fetchFn(`${deps.controlUrl}${url.pathname}${url.search}`, {
      method: c.req.method,
      headers,
      body: await body(c),
      redirect: "manual",
      signal: c.req.raw.signal,
    });
    const out = new Headers();
    for (const h of AUTH_RESPONSE) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    for (const cookie of res.headers.getSetCookie()) out.append("set-cookie", cookie);
    return new Response(res.body, { status: res.status, headers: out });
  };

  const api = new Hono<Env>()
    .use(bodyLimit({ maxSize: deps.maxBodyBytes, onError: tooLarge("errors.requestTooLarge") }))
    .use(authenticate)
    .all("*", (c) => (CONTROL_PATHS.test(c.req.path) ? toControl(c) : toRuntime(c)));

  const app = new Hono()
    .use(telemetryMiddleware())
    .use(async (c, next) => {
      await next();
      c.header("x-content-type-options", "nosniff");
      c.header("referrer-policy", "strict-origin-when-cross-origin");
      // The public chat page (/c/<project>) is embedded by projects' websites (widget.js); it signs nobody in.
      const embeddable = c.req.path.startsWith("/c/");
      if (!embeddable) c.header("x-frame-options", "DENY");
      c.header("strict-transport-security", "max-age=31536000");
      // The SPA and the sign-in pages: own scripts only; sign-in is on this origin too (/auth).
      if (!c.res.headers.has("content-security-policy") && (c.res.headers.get("content-type") ?? "").includes("text/html")) {
        c.header("content-security-policy", embeddable ? csp.replace("frame-ancestors 'none'", "frame-ancestors *") : csp);
      }
    })
    .use("/api/*", cors({ origin: deps.corsOrigin, allowHeaders: ["authorization", "content-type", "x-project-id"] }))
    .get("/health", (c) => c.json({ ok: true }))
    // A project's customers: no sign-in, a visitor id from their browser, the public assistant only.
    .all("/public/:project/*", bodyLimit({ maxSize: 16 * 1024, onError: tooLarge("errors.public.messageTooLong") }), async (c) => {
      const project = c.req.param("project");
      const ip = clientIp(c);
      if (!PROJECT_SLUG.test(project)) throw new HTTPException(404, { message: "Not found" });
      if (!publicRequests.take(ip)) throw new HttpError(429, "errors.public.tooManyRequests");
      if (c.req.method === "POST" && c.req.path.endsWith("/runs") && !publicRuns.take(ip)) {
        throw new HttpError(429, "errors.public.tooManyMessages");
      }
      const visitor = c.req.header("x-visitor-id") ?? "";
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(visitor)) throw new HttpError(400, "errors.public.visitorMissing");
      if (!(await control.list()).some((t) => t.id === project)) throw new HTTPException(404, { message: "Not found" });
      const authorization = await signer.header(projectAudience(project), { project, visitor, channel: "public" });
      const url = new URL(c.req.url);
      const res = await runtimes.request(project, `${url.pathname.replace(`/public/${project}`, "/public")}${url.search}`, {
        method: c.req.method,
        headers: forwardHeaders(c, authorization),
        body: await body(c),
        signal: c.req.raw.signal,
      });
      return relay(res);
    })
    .all("/auth/*", bodyLimit({ maxSize: AUTH_BODY_BYTES, onError: tooLarge("errors.requestTooLarge") }), toAuth)
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
    });

  if (web) {
    // The page with GoatCounter's script, when there's a site to count to (read once, the build doesn't change).
    let page: Promise<string> | undefined;
    const indexHtml = (c: Context) => {
      page ??= readFile(join(web.dir, "index.html"), "utf8").then((html) =>
        html.replace("</head>", `  <script data-goatcounter="${web.goatcounter}/count" async src="${web.goatcounter}/count.js"></script>\n  </head>`),
      );
      return page.then((html) => c.html(html, 200, { "cache-control": "no-cache" }));
    };
    app.use("/assets/*", async (c, next) => {
      await next();
      // Vite puts a content hash in asset file names.
      if (c.res.ok) c.header("cache-control", "public, max-age=31536000, immutable");
    });
    if (web.goatcounter) app.get("/", indexHtml).get("/index.html", indexHtml);
    app
      .use("*", serveStatic({ root: web.dir }))
      // SPA fallback: client-side routes such as /callback get index.html.
      .get("*", web.goatcounter ? indexHtml : serveStatic({ root: web.dir, path: "index.html" }));
  }

  return app.onError((err, c) => {
    const locale = requestLocale(c.req.header("accept-language"));
    if (err instanceof AccessDeniedError) return c.json({ ...errorBody(err, locale), user: err.user }, err.status);
    if (err instanceof HttpError) return c.json(errorBody(err, locale), err.status);
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (isUnreachable(err)) {
      console.error("Service unreachable", err);
      return c.json(errorBody(new HttpError(503, "errors.serviceUnavailable"), locale), 503);
    }
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });
}
