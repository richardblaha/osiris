import { createHash, randomBytes } from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { errorResponse, HttpError, requestLocale, ValidationError } from "@osiris/platform/i18n.ts";
import { ClientError, clientInput } from "./clients.ts";
import { telemetryMiddleware } from "@osiris/platform/telemetry.ts";
import { ACCOUNT_CLIENT_ID } from "./oidc.ts";
import { authRoutes, nodePair, securityRoutes, type AuthDeps } from "./routes.ts";
import { createServiceToken, deleteServiceToken, scimRoutes, serviceTokens } from "./scim.ts";
import type { UserRecord } from "./users.ts";

type Env = { Variables: { userId: string; sessionUid: string } };

const PICTURE_MAX_BYTES = 2 * 1024 * 1024;
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value, { reportInput: true });
  if (!r.success) throw new ValidationError(r.error);
  return r.data;
};
const json = (c: Context) =>
  c.req.json().catch(() => {
    throw new HttpError(400, "errors.invalidJson");
  });
const profileBody = z.object({ firstName: z.string().trim().min(1).max(100).optional(), lastName: z.string().trim().max(100).optional(), email: z.email().max(200).optional() });

// Own scripts and styles only; WebAuthn and the sign-in API are on this origin. Pictures may come from anywhere https.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

export interface AppOptions {
  /** The built pages (`index.html` and `assets/`); without it the pages answer 404 (tests). */
  staticDir?: string;
  /** A logo URL for the pages. */
  logo?: string;
}

/**
 * The identity provider's HTTP app: sign-in pages and their API, the user's own account (`/account`, the browser's
 * session), administration (`/admin`, members of the admin group), token introspection for registered resource
 * servers (`/introspect`), and SCIM for other services and the admin pages (`/scim/v2`).
 * oidc-provider's endpoints are mounted next to this app (server.ts).
 */
export function createAuthApp(deps: AuthDeps, options: AppOptions = {}) {
  const { provider, users } = deps;
  const issuer = provider.issuer;

  /** The browser's signed-in user (oidc-provider's session cookie), or null. */
  const sessionUser = async (c: Context): Promise<{ user: UserRecord; sessionUid: string } | null> => {
    const [req, res] = nodePair(c);
    const session = await provider.Session.get(provider.createContext(req, res) as never).catch(() => undefined);
    const user = session?.accountId ? await users.get(session.accountId).catch(() => null) : null;
    return session && user && !user.disabled ? { user, sessionUid: session.uid } : null;
  };
  const isAdmin = (user: UserRecord) => user.groups.includes(deps.adminGroup);

  /** Requires a signed-in browser (an admin with `admin`); changes must come from our own pages. */
  const signedIn = (admin = false) => async (c: Context<Env>, next: () => Promise<void>) => {
    // Cookies go along with requests from other sites' forms too.
    if (c.req.method !== "GET" && c.req.header("origin") !== issuer) throw new HTTPException(403, { message: "Forbidden" });
    const signed = await sessionUser(c);
    if (!signed) throw new HTTPException(401, { message: "Not signed in" });
    if (admin && !isAdmin(signed.user)) throw new HTTPException(403, { message: "Administrators only" });
    c.set("userId", signed.user.id);
    c.set("sessionUid", signed.sessionUid);
    await next();
  };

  // One page app: sign-in, account and administration.
  const page = options.staticDir ? serveStatic({ root: options.staticDir, path: "index.html" }) : async (c: Context) => c.notFound();

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

    // Token introspection (RFC 7662) for registered resource servers: the token's owner with their groups, as they
    // are now, for tokens of the apps the caller accepts (another app's token is inactive to it).
    .post("/introspect", async (c) => {
      const basic = /^Basic (.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
      const [id, secret] = basic ? Buffer.from(basic, "base64").toString().split(/:(.*)/s).map(decodeURIComponent) : [];
      const caller = id && secret ? await deps.clients.checkSecret(id, secret) : null;
      if (!caller) return c.json({ error: "invalid_client" }, 401, { "www-authenticate": 'Basic realm="introspection"' });
      const token = String((await c.req.parseBody()).token ?? "");
      // A user's token, or a service's (client credentials): that one stands for its service account, as long as
      // the client still has it.
      const found = token ? await provider.AccessToken.find(token).catch(() => undefined) : undefined;
      const service = !found && token ? await provider.ClientCredentials.find(token).catch(() => undefined) : undefined;
      const access = found ?? service;
      const accountId = found?.accountId ?? (service?.clientId ? (await deps.clients.get(service.clientId))?.serviceAccount : undefined);
      if (!access || access.isExpired || !caller.acceptsTokensOf.includes(access.clientId ?? "") || !accountId) return c.json({ active: false });
      const user = await users.get(accountId).catch(() => null);
      if (!user || user.disabled) return c.json({ active: false });
      if (found?.sessionUid) await deps.activity.touch(found.sessionUid);
      return c.json({
        active: true,
        iss: issuer,
        sub: user.id,
        client_id: access.clientId,
        scope: access.scope,
        token_type: "Bearer",
        exp: access.exp,
        iat: access.iat,
        sid: found?.sessionUid,
        email: user.email,
        name: user.name,
        phone_number: user.phone,
        picture: user.picture,
        groups: user.groups,
      });
    })

    // What the pages show: the provider's name and logo, and whether the browser's user administers it.
    .get("/api/config", async (c) => {
      const signed = await sessionUser(c);
      return c.json({ name: deps.appName, logo: options.logo ?? null, user: signed ? { id: signed.user.id, name: signed.user.name, email: signed.user.email, picture: signed.user.picture } : null, admin: !!signed && isAdmin(signed.user) });
    })

    // The user's own profile.
    .use("/api/me/*", signedIn())
    .get("/api/me/profile", async (c) => c.json(await users.get(c.get("userId"))))
    .patch("/api/me/profile", async (c) => c.json(await users.update(c.get("userId"), parse(profileBody, await json(c)))))
    .put("/api/me/picture", async (c) => {
      const data = new Uint8Array(await c.req.arrayBuffer());
      const mime = data[0] === 0x89 && data[1] === 0x50 ? "image/png" : data[0] === 0xff && data[1] === 0xd8 ? "image/jpeg" : null;
      if (!mime) throw new HttpError(415, "errors.picture.type");
      if (data.length > PICTURE_MAX_BYTES) throw new HttpError(413, "errors.picture.tooLarge");
      await users.setPicture(c.get("userId"), data, mime);
      return c.body(null, 204);
    })
    .route("/api/me/security", securityRoutes(deps, (c) => (c as Context<Env>).get("userId"), (c) => (c as Context<Env>).get("sessionUid")))

    // Administration (members of the admin group): apps and SCIM tokens; users and groups go through SCIM.
    .use("/api/admin/*", signedIn(true))
    .get("/api/admin/clients", async (c) => c.json(await deps.clients.list()))
    .post("/api/admin/clients", async (c) => {
      const body = parse(clientInput.extend({ id: z.string() }), await json(c));
      const { id, ...input } = body;
      const { client, secret } = await deps.clients.create(id, input);
      return c.json({ client, secret }, 201);
    })
    .put("/api/admin/clients/:id", async (c) => {
      const { client, secret } = await deps.clients.update(c.req.param("id"), parse(clientInput, await json(c)));
      return c.json({ client, secret });
    })
    .post("/api/admin/clients/:id/secret", async (c) => c.json({ secret: await deps.clients.rotateSecret(c.req.param("id")) }))
    .delete("/api/admin/clients/:id", async (c) => {
      if (!(await deps.clients.remove(c.req.param("id")))) throw new HttpError(404, "errors.client.notFound");
      return c.body(null, 204);
    })
    .get("/api/admin/tokens", async (c) => c.json(await serviceTokens(deps.db)))
    .post("/api/admin/tokens", async (c) => {
      const { name } = parse(z.object({ name: z.string().regex(/^[a-z0-9-]{1,40}$/, "errors.validation.slug") }), await json(c));
      return c.json({ name, token: await createServiceToken(deps.db, name) }, 201);
    })
    .delete("/api/admin/tokens/:name", async (c) => {
      if (!(await deleteServiceToken(deps.db, c.req.param("name")))) throw new HttpError(404, "errors.token.notFound");
      return c.body(null, 204);
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
    .get("/account/*", page)
    .get("/admin", page)
    .get("/admin/*", page)
    .use("/assets/*", options.staticDir ? serveStatic({ root: options.staticDir }) : async (c) => c.notFound())
    .get("/favicon.svg", options.staticDir ? serveStatic({ root: options.staticDir, path: "favicon.svg" }) : async (c) => c.notFound())

    .route(
      "/scim/v2",
      scimRoutes({
        db: deps.db,
        users,
        credentials: deps.credentials,
        base: `${issuer}/scim/v2`,
        // The admin pages use SCIM too, with an admin's browser session (and, for changes, our own Origin).
        admin: async (c) => (c.req.method === "GET" || c.req.header("origin") === issuer) && !!(await sessionUser(c).then((s) => s && isAdmin(s.user))),
      }),
    )
    .route("/", authRoutes(deps));

  return app.onError((err, c) => {
    const locale = requestLocale(c.req.header("accept-language"));
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof ClientError) return c.json({ error: err.in(locale), code: err.key }, err.key === "errors.client.notFound" ? 404 : err.key === "errors.client.exists" ? 409 : 400);
    const localized = errorResponse(err, locale);
    if (localized) return c.json(localized.body, localized.status);
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });
}
