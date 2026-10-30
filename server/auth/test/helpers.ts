import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mailer } from "@osiris/platform/mail.ts";
import { FsObjectStore } from "@osiris/platform/objects.ts";
import { LocalDb, migrate } from "@osiris/platform/db.ts";
import { createAuthApp } from "../src/app.ts";
import { createAuthDeps } from "../src/auth.ts";
import { osirisClients } from "../src/clients.ts";
import { createServiceToken } from "../src/scim.ts";
import { authListener } from "../src/server.ts";
import type { SocialClient, SocialProviderId } from "../src/social.ts";
import { Users, type NewUser } from "../src/users.ts";

export const tempDir = (prefix = "osiris-auth-") => mkdtempSync(join(tmpdir(), prefix));
export const MIGRATIONS = join(import.meta.dirname, "../src/db/migrations");
export const SIGNING_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
/** osiris-auth's origin (the issuer) and the web app's. */
export const ISSUER = "http://auth.test";
export const WEB = "http://osiris.test";
export const GATEWAY_SECRET = "gateway-secret-".padEnd(40, "x");

export async function createTestDb() {
  const db = new LocalDb(join(tempDir(), "auth.db"));
  await migrate(db, MIGRATIONS);
  return db;
}

/** osiris-auth over a temp database, with a recording mailer and a SCIM token. */
export async function createTestAuth(options: { users?: NewUser[]; social?: Partial<Record<SocialProviderId, SocialClient>>; socialFetch?: typeof fetch } = {}) {
  const db = await createTestDb();
  const users = new Users(db, { objects: new FsObjectStore(tempDir("osiris-auth-objects-")), publicUrl: ISSUER });
  for (const u of options.users ?? []) await users.create(u);
  const mail: { to: string; subject: string; text: string }[] = [];
  const mailer: Mailer = { send: async (m) => void mail.push(m) };
  const auth = await createAuthDeps({
    db,
    users,
    publicUrl: ISSUER,
    appName: "Test",
    secret: randomBytes(32).toString("base64"),
    signingKeyPem: SIGNING_KEY,
    socialClients: options.social,
    fetchFn: options.socialFetch,
    mailer,
  });
  await auth.clients.ensure(osirisClients([WEB], GATEWAY_SECRET));
  const app = createAuthApp(auth);
  const scimToken = await createServiceToken(db, "control");
  /** The gateway asking who a token belongs to (RFC 7662). */
  const introspect = async (token: string, secret = GATEWAY_SECRET, client = "osiris-gateway") =>
    app.request("/introspect", {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${client}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  const scim = (path: string, init: RequestInit = {}) =>
    app.request(`/scim/v2${path}`, { ...init, headers: { authorization: `Bearer ${scimToken}`, "content-type": "application/scim+json", ...(init.headers as Record<string, string>) } });
  return { app, db, users, auth, mail, scimToken, introspect, scim };
}

const servers: Server[] = [];
export const closeServers = () => {
  for (const s of servers.splice(0)) s.close();
};

/** A browser: follows nothing on its own, keeps cookies by path, and talks to osiris-auth as if through Traefik. */
export async function browser(service: Awaited<ReturnType<typeof createTestAuth>>, network: Record<string, string> = {}) {
  const server = createServer(authListener(service.app, service.auth.provider, { trusted: "127.0.0.1/32,::1/128" }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const jar = new Map<string, { value: string; path: string }>();

  const request = async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, ISSUER);
    const cookie = [...jar].filter(([, c]) => url.pathname.startsWith(c.path)).map(([n, c]) => `${n}=${c.value}`).join("; ");
    const res = await fetch(`${base}${url.pathname}${url.search}`, {
      ...init,
      redirect: "manual",
      headers: { "x-forwarded-host": url.host, "x-forwarded-proto": "http", ...network, ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) },
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const [name, ...rest] = pair!.split("=");
      const path = attrs.map((a) => a.trim().match(/^path=(.*)$/i)?.[1]).find(Boolean) ?? "/";
      const expired = attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a.trim()));
      if (expired) jar.delete(name!.trim());
      else jar.set(name!.trim(), { value: rest.join("="), path });
    }
    return res;
  };
  const post = (path: string, body: unknown) => request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  /** The account page's API, with this browser's session. */
  const me = (path: string, init: RequestInit = {}) =>
    request(`/api/me/security${path}`, { ...init, headers: { origin: ISSUER, "content-type": "application/json", ...(init.headers as Record<string, string>) } });

  /** Follows redirects on osiris-auth until its /login page or another origin (the web app's /callback). */
  const follow = async (path: string) => {
    for (let i = 0; i < 10; i++) {
      const res = await request(path);
      const location = res.headers.get("location");
      if (!location) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
      const url = new URL(location, ISSUER);
      if (url.pathname === "/login" || url.origin !== ISSUER) return url;
      path = `${url.pathname}${url.search}`;
    }
    throw new Error("Too many redirects");
  };

  const verifier = randomBytes(32).toString("base64url");
  const authorize = (extra: Record<string, string> = {}) =>
    follow(
      `/authorize?${new URLSearchParams({
        client_id: "osiris-web",
        redirect_uri: `${WEB}/callback`,
        response_type: "code",
        scope: "openid profile email",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state: "st",
        ...extra,
      })}`,
    );
  const token = async (params: Record<string, string>, origin: string | null = WEB) => {
    const res = await request("/token", {
      method: "POST",
      // As the browser sends it: the token endpoint must accept the web app's origin.
      headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
      body: new URLSearchParams({ client_id: "osiris-web", ...params }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  };
  const exchange = (callback: URL) => token({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: `${WEB}/callback`, code_verifier: verifier });
  /** Signs in with a password all the way to tokens. */
  const signIn = async (email: string, password: string) => {
    const uid = (await authorize()).searchParams.get("uid")!;
    const ok = (await (await post(`/interaction/${uid}/password`, { email, password })).json()) as { redirectTo: string };
    return exchange(await follow(ok.redirectTo));
  };

  return { request, post, me, follow, authorize, token, exchange, signIn, jar, verifier };
}
