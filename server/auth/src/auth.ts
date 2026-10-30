import { createGeoIp, type GeoLocation } from "@osiris/platform/geoip.ts";
import { AuthActivity } from "./activity.ts";
import { createHash, createPrivateKey, generateKeyPairSync, hkdfSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { calculateJwkThumbprint } from "jose";
import type { JWK } from "oidc-provider";
import type { Db } from "@osiris/platform/db.ts";
import { SecretBox } from "@osiris/platform/secrets.ts";
import type { Config } from "./config.ts";
import type { Users } from "./users.ts";
import { Clients } from "./clients.ts";
import { Credentials } from "./credentials.ts";
import { AttemptLimiter } from "./limiter.ts";
import { configuredMailer, type Mailer } from "@osiris/platform/mail.ts";
import { createOidcProvider } from "./oidc.ts";
import { Passkeys } from "./passkeys.ts";
import type { AuthDeps } from "./routes.ts";
import { SocialLogin, type SocialClient, type SocialProviderId } from "./social.ts";

const derive = (secret: string, label: string) => Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64"), Buffer.alloc(0), label, 32)).toString("base64");

/** The ID token signing key as a private JWK, its `kid` the key's thumbprint. */
export async function signingJwk(pem: string): Promise<JWK> {
  const jwk = createPrivateKey(pem).export({ format: "jwk" }) as JWK;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new Error("AUTH_SIGNING_KEY must be an EC P-256 private key");
  return { ...jwk, kid: await calculateJwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }), alg: "ES256", use: "sig" };
}

/** Development without AUTH_SIGNING_KEY: a key kept next to the local database, so sign-ins survive restarts. */
function devSigningKey(dir: string) {
  const path = `${dir}/auth-signing-key.pem`;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  }
  return readFileSync(path, "utf8");
}

export interface AuthOptions {
  db: Db;
  users: Users;
  /** Where browsers reach osiris-auth: the issuer. */
  publicUrl: string;
  /** The name users see (pages, emails, passkeys, authenticator apps). */
  appName?: string;
  /** Members of this group administer the identity provider. */
  adminGroup?: string;
  /** 32 bytes, base64: cookie keys and the TOTP sealing key are derived from it. */
  secret: string;
  signingKeyPem: string;
  socialClients?: Partial<Record<SocialProviderId, SocialClient>>;
  mailer?: Mailer;
  fetchFn?: typeof fetch;
  geo?: (ip: string) => GeoLocation;
}

/** The identity provider: the OIDC provider, registered apps and everything its pages need. */
export async function createAuthDeps(o: AuthOptions): Promise<AuthDeps> {
  const origin = new URL(o.publicUrl).origin;
  const appName = o.appName ?? "Auth";
  const credentials = new Credentials(o.db, new SecretBox(derive(o.secret, "osiris-totp")), appName);
  // oidc-provider validates a client's metadata as it would use it; the provider is made just below.
  const clients = new Clients(o.db, new SecretBox(derive(o.secret, "osiris-clients")), (metadata) => provider.Client.validate(metadata as never));
  const provider = createOidcProvider({
    issuer: origin,
    appName,
    db: o.db,
    users: o.users,
    clients,
    jwks: [await signingJwk(o.signingKeyPem)],
    cookieKeys: [derive(o.secret, "osiris-oidc-cookies")],
  });
  const activity = new AuthActivity(o.db, o.geo);
  provider.use(async (ctx, next) => {
    await next();
    const session = ctx.oidc?.entities.Session;
    if (session?.accountId && session.uid && !session.destroyed) {
      await activity.observe(session.accountId, session.uid, ctx.get("x-forwarded-for"), ctx.get("user-agent"));
    }
  });
  return {
    activity,
    db: o.db,
    provider,
    users: o.users,
    credentials,
    passkeys: new Passkeys(credentials, { id: new URL(origin).hostname, name: appName, origin }),
    social: new SocialLogin(o.socialClients ?? {}, `${origin}/social`, o.fetchFn),
    clients,
    issuer: origin,
    appName,
    adminGroup: o.adminGroup ?? "admin",
    mailer: o.mailer,
    // 10 failures per 15 minutes per account, address or sign-in.
    limiter: new AttemptLimiter(10, 15 * 60_000),
  };
}

/** Sign-in from the configuration; development falls back to local keys and prints emails. */
export async function createAuth(config: Config, db: Db, users: Users): Promise<AuthDeps> {
  if (!config.AUTH_SECRET || !config.AUTH_SIGNING_KEY) console.warn("AUTH_SECRET or AUTH_SIGNING_KEY not set: using development keys.");
  if (!config.EMAILIT_API_KEY && !config.SMTP_URL) console.warn(`EMAILIT_API_KEY or SMTP_URL not set: no sign-in links by email${config.NODE_ENV === "production" ? "" : " (printed to the log instead)"}.`);
  const socialClients: Partial<Record<SocialProviderId, SocialClient>> = {};
  if (config.GOOGLE_CLIENT_ID) socialClients.google = { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET! };
  if (config.FACEBOOK_CLIENT_ID) socialClients.facebook = { clientId: config.FACEBOOK_CLIENT_ID, clientSecret: config.FACEBOOK_CLIENT_SECRET! };
  if (config.MICROSOFT_CLIENT_ID) {
    socialClients.microsoft = { clientId: config.MICROSOFT_CLIENT_ID, clientSecret: config.MICROSOFT_CLIENT_SECRET!, tenant: config.MICROSOFT_TENANT };
  }
  if (config.SEZNAM_CLIENT_ID) socialClients.seznam = { clientId: config.SEZNAM_CLIENT_ID, clientSecret: config.SEZNAM_CLIENT_SECRET! };
  return createAuthDeps({
    db,
    users,
    geo: createGeoIp().lookup,
    publicUrl: config.PUBLIC_URL,
    appName: config.APP_NAME,
    adminGroup: config.ADMIN_GROUP,
    secret: config.AUTH_SECRET ?? createHash("sha256").update("osiris-dev-auth").digest("base64"),
    signingKeyPem: config.AUTH_SIGNING_KEY ?? devSigningKey(config.DATA_DIR),
    socialClients,
    mailer: configuredMailer(config),
  });
}
