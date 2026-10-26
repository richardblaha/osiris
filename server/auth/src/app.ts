import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorResponse, requestLocale } from "@osiris/platform/i18n.ts";
import { telemetryMiddleware } from "@osiris/platform/telemetry.ts";
import { ACCOUNT_CLIENT_ID, CLIENT_IDS } from "./oidc.ts";
import { authRoutes, nodePair, securityRoutes, type AuthDeps } from "./routes.ts";
import { scimRoutes } from "./scim.ts";

type Env = { Variables: { userId: string; sessionUid: string } };

/** The client id the gateway introspects tokens with (RFC 7662). */
export const GATEWAY_CLIENT_ID = "osiris-gateway";

const digest = (s: string) => createHash("sha256").update(s).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

// Own scripts and styles only; WebAuthn and the sign-in API are on this origin. Pictures may come from anywhere https.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

export interface AppOptions {
  /** The built account pages (`account.html` and `assets/`); without it the pages answer 404 (tests). */
  staticDir?: string;
}

/**
 * osiris-auth: sign-in pages and their API, the user's own account page (`/account`, the browser's session),
 * token introspection for the gateway (`/introspect`), and SCIM for other services (`/scim/v2`).
 * oidc-provider's endpoints are mounted next to this app (server.ts).
 */
export function createAuthApp(deps: AuthDeps, options: AppOptions = {}) {
  const { provider, users } = deps;
  const issuer = provider.issuer;

  /** The browser's signed-in user (oidc-provider's session cookie); 401 without one. */
  const signedIn = async (c: Context<Env>, next: () => Promise<void>) => {
    // Cookies go along with requests from other sites' forms too: changes must come from our own pages.
    if (c.req.method !== "GET" && c.req.header("origin") !== issuer) throw new HTTPException(403, { message: "Forbidden" });
    const [req, res] = nodePair(c);
    const session = await provider.Session.get(provider.createContext(req, res) as never).catch(() => undefined);
    const user = session?.accountId ? await users.get(session.accountId).catch(() => null) : null;
    if (!session || !user || user.disabled) throw new HTTPException(401, { message: "Not signed in" });
    c.set("userId", user.id);
    c.set("sessionUid", session.uid);
    await next();
  };

  const page = options.staticDir ? serveStatic({ root: options.staticDir, path: "account.html" }) : async (c: Context) => c.notFound();

  const app = new Hono<Env>()
    .use(telemetryMiddleware())
    .use(async (c, next) => {
      await next();
      c.header("x-content-type-options", "nosniff");
      c.header("referrer-policy", "strict-origin-when-cross-origin");
      c.header("x-frame-options", "DENY");
      c.header("strict-transport-security", "max-age=31536000");
      if (!c.res.headers.has("content-security-policy") && (c.res.headers.get("content-type") ?? "").includes("text/html")) c.header("content-security-policy", CSP);
    })
    .get("/health", (c) => c.json({ ok: true }))
    .get("/", (c) => c.redirect("/account", 302))

    // Token introspection (RFC 7662) for the gateway: the token's owner with their groups, as they are now.
    .post("/introspect", async (c) => {
      const basic = /^Basic (.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
      const [id, secret] = basic ? Buffer.from(basic, "base64").toString().split(/:(.*)/s).map(decodeURIComponent) : [];
      if (!deps.gatewaySecret || id !== GATEWAY_CLIENT_ID || !secret || !sameSecret(secret, deps.gatewaySecret)) {
        return c.json({ error: "invalid_client" }, 401, { "www-authenticate": 'Basic realm="osiris-auth"' });
      }
      const token = String((await c.req.parseBody()).token ?? "");
      const access = token ? await provider.AccessToken.find(token).catch(() => undefined) : undefined;
      if (!access || access.isExpired || !CLIENT_IDS.includes(access.clientId ?? "") || !access.accountId) return c.json({ active: false });
      const user = await users.get(access.accountId).catch(() => null);
      if (!user || user.disabled) return c.json({ active: false });
      if (access.sessionUid) await deps.activity.touch(access.sessionUid);
      return c.json({
        active: true,
        iss: issuer,
        sub: user.id,
        client_id: access.clientId,
        scope: access.scope,
        token_type: "Bearer",
        exp: access.exp,
        iat: access.iat,
        sid: access.sessionUid,
        email: user.email,
        name: user.name,
        phone_number: user.phone,
        picture: user.picture,
        groups: user.groups,
      });
    })

    // The account page signs in through the provider like any app; that leaves the browser's session, which is all
    // the page needs, so the code is never redeemed.
    .get("/account/signin", (c) =>
      c.redirect(
        `/authorize?${new URLSearchParams({
          client_id: ACCOUNT_CLIENT_ID,
          redirect_uri: `${issuer}/account/callback`,
          response_type: "code",
          scope: "openid",
          code_challenge: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url"),
          code_challenge_method: "S256",
        })}`,
        302,
      ),
    )
    .get("/account/callback", (c) => c.redirect("/account", 302))
    .get("/login", page)
    .get("/account", page)
    .use("/assets/*", options.staticDir ? serveStatic({ root: options.staticDir }) : async (c) => c.notFound())
    .get("/favicon.svg", options.staticDir ? serveStatic({ root: options.staticDir, path: "favicon.svg" }) : async (c) => c.notFound())

    .use("/api/me/security/*", signedIn)
    .use("/api/me/security", signedIn)
    .route("/api/me/security", securityRoutes(deps, (c) => (c as Context<Env>).get("userId"), (c) => (c as Context<Env>).get("sessionUid")))
    .route("/scim/v2", scimRoutes({ db: deps.db, users, credentials: deps.credentials, base: `${issuer}/scim/v2` }))
    .route("/", authRoutes(deps));

  return app.onError((err, c) => {
    const locale = requestLocale(c.req.header("accept-language"));
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    const localized = errorResponse(err, locale);
    if (localized) return c.json(localized.body, localized.status);
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });
}
