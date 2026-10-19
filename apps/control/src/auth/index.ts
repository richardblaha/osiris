import { createHash, createPrivateKey, generateKeyPairSync, hkdfSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { calculateJwkThumbprint } from "jose";
import type { JWK } from "oidc-provider";
import type { Db } from "@osiris/platform/rqlite.ts";
import { SecretBox } from "@osiris/platform/secrets.ts";
import type { Config } from "../config.ts";
import type { UserDirectory } from "../users.ts";
import { Credentials } from "./credentials.ts";
import { AttemptLimiter } from "./limiter.ts";
import { consoleMailer, emailitMailer, smtpMailer, type Mailer } from "./mail.ts";
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
  users: UserDirectory;
  /** Where the browser reaches Osiris; the issuer is `<origin>/auth`. */
  publicUrl: string;
  extraOrigins?: string[];
  /** 32 bytes, base64: cookie keys and the TOTP sealing key are derived from it. */
  secret: string;
  signingKeyPem: string;
  socialClients?: Partial<Record<SocialProviderId, SocialClient>>;
  mailer?: Mailer;
  fetchFn?: typeof fetch;
}

/** Sign-in for Osiris: the OIDC provider and everything its screens need. */
export async function createAuthDeps(o: AuthOptions): Promise<AuthDeps> {
  const origin = new URL(o.publicUrl).origin;
  const credentials = new Credentials(o.db, new SecretBox(derive(o.secret, "osiris-totp")));
  const provider = createOidcProvider({
    issuer: `${origin}/auth`,
    db: o.db,
    users: o.users,
    jwks: [await signingJwk(o.signingKeyPem)],
    cookieKeys: [derive(o.secret, "osiris-oidc-cookies")],
    webOrigins: [origin, ...(o.extraOrigins ?? [])],
  });
  return {
    db: o.db,
    provider,
    users: o.users,
    credentials,
    passkeys: new Passkeys(credentials, { id: new URL(origin).hostname, name: "Osiris", origin }),
    social: new SocialLogin(o.socialClients ?? {}, `${origin}/auth/social`, o.fetchFn),
    mailer: o.mailer,
    // 10 failures per 15 minutes per account, address or sign-in.
    limiter: new AttemptLimiter(10, 15 * 60_000),
  };
}

/** Sign-in from the configuration; development falls back to local keys and prints emails. */
export async function createAuth(config: Config, db: Db, users: UserDirectory): Promise<AuthDeps> {
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
    publicUrl: config.PUBLIC_URL,
    extraOrigins: config.AUTH_EXTRA_ORIGINS,
    secret: config.AUTH_SECRET ?? createHash("sha256").update("osiris-dev-auth").digest("base64"),
    signingKeyPem: config.AUTH_SIGNING_KEY ?? devSigningKey(dirname(config.LOCAL_DB_PATH)),
    socialClients,
    mailer: config.EMAILIT_API_KEY
      ? emailitMailer(config.EMAILIT_API_KEY, config.MAIL_FROM)
      : config.SMTP_URL
        ? smtpMailer(config.SMTP_URL, config.MAIL_FROM)
        : config.NODE_ENV === "production"
          ? undefined
          : consoleMailer,
  });
}
