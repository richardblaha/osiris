import Provider, { type Adapter, type AdapterPayload, type Configuration, type JWK, type KoaContextWithOIDC } from "oidc-provider";
import { run, type Db } from "@osiris/platform/rqlite.ts";
import { CLAIMS } from "@osiris/platform/claims.ts";
import { requestLocale, translate } from "@osiris/platform/i18n.ts";
import type { UserDirectory, UserRecord } from "../users.ts";
import { PHONE_CLAIM } from "../whatsapp/phones.ts";

/** The web app's client; first party, so it never asks for consent. */
export const WEB_CLIENT_ID = "osiris-web";

/** Paths under the issuer (`/auth`) answered by oidc-provider; the rest of `/auth` is ours (sign-in screens' API). */
export const OIDC_PATHS = /^\/auth\/(\.well-known\/openid-configuration|authorize|token|userinfo|jwks|logout|revoke)(\/|\?|$)/;

/** oidc-provider's models in the central database, one table for all of them (`oidc_store`). */
class DbAdapter implements Adapter {
  constructor(
    private readonly db: Db,
    private readonly model: string,
  ) {}

  async upsert(id: string, payload: AdapterPayload, expiresIn: number) {
    await this.db.execute([
      run(
        `INSERT INTO oidc_store (model, id, payload, grant_id, uid, user_code, expires_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM auth_session_revocations WHERE uid = ?)
         ON CONFLICT (model, id) DO UPDATE SET payload = excluded.payload, grant_id = excluded.grant_id, uid = excluded.uid,
           user_code = excluded.user_code, expires_at = excluded.expires_at`,
        this.model,
        id,
        JSON.stringify(payload),
        payload.grantId ?? null,
        payload.uid ?? null,
        payload.userCode ?? null,
        expiresIn ? Date.now() + expiresIn * 1000 : null,
        this.model === "Session" ? payload.uid ?? "" : payload.sessionUid ?? "",
      ),
    ]);
  }

  private async findWhere(column: "id" | "uid" | "user_code", value: string): Promise<AdapterPayload | undefined> {
    const [row] = await this.db.query<{ payload: string; expires_at: number | null }>(
      `SELECT payload, expires_at FROM oidc_store WHERE model = ? AND ${column} = ?`,
      [this.model, value],
    );
    if (!row || (row.expires_at !== null && Number(row.expires_at) < Date.now())) return undefined;
    const payload = JSON.parse(row.payload) as AdapterPayload;
    const uid = this.model === "Session" ? payload.uid : payload.sessionUid;
    if (uid && (await this.db.query("SELECT uid FROM auth_session_revocations WHERE uid=?", [uid], { fresh: true })).length) return undefined;
    return payload;
  }

  find = (id: string) => this.findWhere("id", id);
  findByUid = (uid: string) => this.findWhere("uid", uid);
  findByUserCode = (userCode: string) => this.findWhere("user_code", userCode);

  async consume(id: string) {
    await this.db.execute([
      run(
        "UPDATE oidc_store SET payload = json_set(payload, '$.consumed', ?) WHERE model = ? AND id = ?",
        Math.floor(Date.now() / 1000),
        this.model,
        id,
      ),
    ]);
  }

  async destroy(id: string) {
    await this.db.execute([run("DELETE FROM oidc_store WHERE model = ? AND id = ?", this.model, id)]);
  }

  async revokeByGrantId(grantId: string) {
    await this.db.execute([run("DELETE FROM oidc_store WHERE grant_id = ?", grantId)]);
  }
}

/** The claims Osiris puts in ID tokens and userinfo: profile, email, and the custom claims that grant access. */
export function userClaims(user: UserRecord) {
  return {
    sub: user.id,
    name: user.name ?? undefined,
    given_name: user.firstName || undefined,
    family_name: user.lastName || undefined,
    picture: user.picture ?? undefined,
    email: user.email ?? undefined,
    email_verified: user.email ? user.emailVerified : undefined,
    phone_number: user.claims[PHONE_CLAIM],
    [CLAIMS.role]: user.claims[CLAIMS.role],
    [CLAIMS.project]: user.claims[CLAIMS.project],
    [CLAIMS.projectAdmin]: user.claims[CLAIMS.projectAdmin],
  };
}

/** A plain page in the language of the browser's request; `body` is HTML, so every inserted value must be escaped. */
const page = (ctx: KoaContextWithOIDC, titleKey: string, body: (t: (key: string) => string) => string) => {
  const locale = requestLocale(ctx.get("accept-language"));
  const t = (key: string) => escapeHtml(translate(locale, key));
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t(titleKey)}</title><link rel="stylesheet" href="/auth/assets/page.css"></head>
<body><main>${body(t)}</main></body></html>`;
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface OidcOptions {
  issuer: string;
  db: Db;
  users: UserDirectory;
  /** Private signing keys (JWK with `kid`); the first signs. */
  jwks: JWK[];
  cookieKeys: string[];
  /** Where the web app runs: redirect URI `<origin>/callback`, after logout `<origin>`. */
  webOrigins: string[];
}

/**
 * The OpenID Connect provider at `<origin>/auth`: authorization code with PKCE, refresh tokens (rotated), userinfo,
 * RP-initiated logout. Users sign in on the web app's screens (`/login`), which talk to our interaction API; this
 * object holds sessions, grants and tokens.
 */
export function createOidcProvider(options: OidcOptions): Provider {
  const configuration: Configuration = {
    adapter: (model: string) => new DbAdapter(options.db, model),
    clients: [
      {
        client_id: WEB_CLIENT_ID,
        client_name: "Osiris",
        application_type: "web",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: options.webOrigins.map((o) => `${o}/callback`),
        post_logout_redirect_uris: options.webOrigins,
        id_token_signed_response_alg: "ES256",
      },
    ],
    jwks: { keys: options.jwks },
    cookies: {
      keys: options.cookieKeys,
      names: { session: "osiris_session", interaction: "osiris_interaction", resume: "osiris_resume" },
      long: { httpOnly: true, sameSite: "lax" },
      short: { httpOnly: true, sameSite: "lax" },
    },
    scopes: ["openid", "profile", "email"],
    claims: {
      openid: ["sub"],
      profile: ["name", "given_name", "family_name", "picture", "phone_number", CLAIMS.role, CLAIMS.project, CLAIMS.projectAdmin],
      email: ["email", "email_verified"],
    },
    routes: {
      authorization: "/authorize",
      token: "/token",
      userinfo: "/userinfo",
      jwks: "/jwks",
      end_session: "/logout",
      revocation: "/revoke",
    },
    pkce: { required: () => true },
    // Browsers send Origin with every POST, same-origin ones too, so the web app's token requests carry it.
    clientBasedCORS: (_ctx, origin) => options.webOrigins.includes(origin),
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      userinfo: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        // Signing out of Osiris needs no confirmation; the form submits itself (script, as CSP forbids inline ones).
        logoutSource: async (ctx, form) => {
          ctx.body = page(ctx, "pages.logout.title", (t) => `<p>${t("pages.logout.progress")}</p>${form}<button type="submit" form="op.logoutForm" name="logout" value="yes">${t("pages.logout.button")}</button><script src="/auth/assets/logout.js"></script>`);
        },
        postLogoutSuccessSource: async (ctx) => {
          ctx.body = page(ctx, "pages.loggedOut.title", (t) => `<h1>${t("pages.loggedOut.title")}</h1><p><a href="/">${t("pages.loggedOut.back")}</a></p>`);
        },
      },
    },
    findAccount: async (_ctx, sub) => {
      const user = await options.users.get(sub).catch(() => null);
      if (!user || user.disabled) return undefined;
      return { accountId: sub, claims: () => userClaims(user) };
    },
    interactions: { url: (_ctx, interaction) => `/auth/interaction/${interaction.uid}` },
    // The web app is ours: whatever it asks for is granted without a consent screen.
    loadExistingGrant: async (ctx: KoaContextWithOIDC) => {
      const { client, session, params } = ctx.oidc;
      if (!client || !session?.accountId) return undefined;
      const grantId = ctx.oidc.result?.consent?.grantId ?? session.grantIdFor(client.clientId);
      const grant = (grantId && (await ctx.oidc.provider.Grant.find(grantId))) || new ctx.oidc.provider.Grant({ clientId: client.clientId, accountId: session.accountId });
      grant.addOIDCScope(String(params?.scope ?? "openid"));
      await grant.save();
      return grant;
    },
    // Refresh tokens without offline_access: they live as long as the sign-in session and die with a logout.
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    ttl: {
      AccessToken: 30 * 60,
      AuthorizationCode: 60,
      IdToken: 60 * 60,
      Interaction: 60 * 60,
      // Signed in for 30 days; refresh tokens rotate and end with the session's lifetime.
      Session: 30 * 86_400,
      Grant: 30 * 86_400,
      RefreshToken: (ctx) => ctx?.oidc?.entities.RotatedRefreshToken?.remainingTTL ?? 30 * 86_400,
    },
    renderError: async (ctx, out) => {
      ctx.type = "html";
      const detail = typeof out.error_description === "string" ? out.error_description : String(out.error ?? "");
      ctx.body = page(ctx, "pages.signInError.title", (t) => `<h1>${t("pages.signInError.heading")}</h1><p>${escapeHtml(detail)}</p><p><a href="/">${t("pages.signInError.retry")}</a></p>`);
    },
  };

  const provider = new Provider(options.issuer, configuration);
  // Behind the gateway (and Traefik): trust X-Forwarded-Proto/Host for cookies and URLs.
  provider.proxy = true;
  return provider;
}
