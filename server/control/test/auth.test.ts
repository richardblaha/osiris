import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_AUDIENCE, InternalSigner } from "@osiris/platform/internal-auth.ts";
import { emailitMailer } from "../src/auth/mail.ts";
import { matchTotp, totpCode, totpStep } from "../src/auth/secrets.ts";
import { controlListener } from "../src/server.ts";
import { createTestControl, keys, PUBLIC_URL } from "./helpers.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A browser: follows nothing on its own, keeps cookies by path, and talks to control as if through the gateway. */
async function browser(control: Awaited<ReturnType<typeof createTestControl>>, network: Record<string, string> = {}) {
  const server = createServer(controlListener(control.app, control.auth.provider));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const jar = new Map<string, { value: string; path: string }>();

  const request = async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, PUBLIC_URL);
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

  /** Follows redirects on our origin until the web app's /login or /callback. */
  const follow = async (path: string) => {
    for (let i = 0; i < 10; i++) {
      const res = await request(path);
      const location = res.headers.get("location");
      if (!location) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
      const url = new URL(location, PUBLIC_URL);
      if (url.pathname === "/login" || url.pathname === "/callback" || url.origin !== PUBLIC_URL) return url;
      path = `${url.pathname}${url.search}`;
    }
    throw new Error("Too many redirects");
  };

  const verifier = randomBytes(32).toString("base64url");
  const authorize = (extra: Record<string, string> = {}) =>
    follow(
      `/auth/authorize?${new URLSearchParams({
        client_id: "osiris-web",
        redirect_uri: `${PUBLIC_URL}/callback`,
        response_type: "code",
        scope: "openid profile email",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state: "st",
        ...extra,
      })}`,
    );
  const token = async (params: Record<string, string>) => {
    const res = await request("/auth/token", {
      method: "POST",
      // As the browser sends it: the token endpoint must accept the web app's own origin.
      headers: { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC_URL },
      body: new URLSearchParams({ client_id: "osiris-web", ...params }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  };
  const exchange = (callback: URL) =>
    token({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: `${PUBLIC_URL}/callback`, code_verifier: verifier });

  return { request, post, follow, authorize, token, exchange, jar, verifier };
}

const gateway = new InternalSigner(keys.privateKey, "gateway");
const identify = async (control: Awaited<ReturnType<typeof createTestControl>>, token: string) =>
  control.app.request("/internal/gateway/identify", {
    method: "POST",
    headers: { authorization: await gateway.header(CONTROL_AUDIENCE), "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });

const alice = { id: "alice", firstName: "Alice", lastName: "Nováková", email: "alice@firma.cz", claims: { role: "osiris-user", project: "acme" } };

describe("TOTP", () => {
  it("matches RFC 6238 and refuses codes it has seen", () => {
    // RFC 6238 test secret "12345678901234567890" at T = 59 s.
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totpCode(secret, totpStep(59_000))).toBe("287082");
    const step = matchTotp(secret, "287082", 0, 59_000);
    expect(step).toBe(1);
    expect(matchTotp(secret, "287082", step!, 59_000)).toBeNull();
  });
});

describe("sign-in", () => {
  it("signs in with a password through the whole authorization code flow", async () => {
    const control = await createTestControl({ users: [alice] });
    await control.auth.credentials.setPassword("alice", "správné-heslo-123");
    const b = await browser(control);

    const login = await b.authorize();
    expect(login.pathname).toBe("/login");
    const uid = login.searchParams.get("uid")!;
    expect(await (await b.request(`/auth/interaction/${uid}/state`)).json()).toEqual({
      step: "login",
      methods: { passkey: true, emailLink: true, social: [] },
    });
    // Without the browser's interaction cookie the step is refused.
    expect((await control.app.request(`/auth/interaction/${uid}/state`)).status).toBe(400);

    expect((await b.post(`/auth/interaction/${uid}/password`, { email: "alice@firma.cz", password: "špatné" })).status).toBe(401);
    const ok = await (await b.post(`/auth/interaction/${uid}/password`, { email: "ALICE@firma.cz", password: "správné-heslo-123" })).json();
    expect(ok.redirectTo).toMatch(new RegExp(`^/auth/authorize/${uid}$`));

    const callback = await b.follow(ok.redirectTo);
    expect([callback.pathname, callback.searchParams.get("state")]).toEqual(["/callback", "st"]);
    const tokens = await b.exchange(callback);
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ access_token: expect.any(String), refresh_token: expect.any(String), id_token: expect.any(String) });
    const who = await identify(control, tokens.body.access_token!);
    expect(await who.json()).toMatchObject({
      sub: "alice",
      email: "alice@firma.cz",
      name: "Alice Nováková",
      claims: { role: "osiris-user", project: "acme" },
    });
    expect((await identify(control, "nonsense")).status).toBe(401);

    const userinfo = await (await b.request("/auth/userinfo", { headers: { authorization: `Bearer ${tokens.body.access_token}` } })).json();
    expect(userinfo).toMatchObject({ sub: "alice", email: "alice@firma.cz", given_name: "Alice", role: "osiris-user", project: "acme" });

    const refreshed = await b.token({ grant_type: "refresh_token", refresh_token: tokens.body.refresh_token! });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(tokens.body.refresh_token);

    // Already signed in: the next authorization goes straight back to the app.
    expect((await b.authorize()).pathname).toBe("/callback");

    // A code works once; replaying it revokes the tokens it gave.
    expect((await b.exchange(callback)).status).toBe(400);
    expect((await identify(control, refreshed.body.access_token!)).status).toBe(401);

    // A disabled user's tokens stop working.
    const again = await b.exchange(await b.authorize());
    expect((await identify(control, again.body.access_token!)).status).toBe(200);
    await control.db.execute([{ sql: "UPDATE users SET disabled = 1 WHERE id = 'alice'" }]);
    expect((await identify(control, again.body.access_token!)).status).toBe(401);
  });

  it("signs the terminal client in through a loopback port of its own, and the gateway accepts its token", async () => {
    const control = await createTestControl({ users: [alice] });
    await control.auth.credentials.setPassword("alice", "správné-heslo-123");
    const b = await browser(control);
    const redirect = "http://127.0.0.1:53123/callback";
    const uid = (await b.authorize({ client_id: "osiris-cli", redirect_uri: redirect })).searchParams.get("uid")!;
    const ok = await (await b.post(`/auth/interaction/${uid}/password`, { email: "alice@firma.cz", password: "správné-heslo-123" })).json();
    const callback = await b.follow(ok.redirectTo);
    expect(`${callback.origin}${callback.pathname}`).toBe(redirect);
    const tokens = await b.token({ client_id: "osiris-cli", grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: redirect, code_verifier: b.verifier });
    expect(tokens.status).toBe(200);
    expect(await (await identify(control, tokens.body.access_token!)).json()).toMatchObject({ sub: "alice" });
    // Another host is no loopback.
    const evil = await b.request(`/auth/authorize?${new URLSearchParams({ client_id: "osiris-cli", redirect_uri: "http://evil.example/callback", response_type: "code", scope: "openid", code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`);
    expect(evil.headers.get("location") ?? "").not.toContain("evil.example");
  });

  it("asks for the authenticator code after the password, once per code, or takes a recovery code", async () => {
    const control = await createTestControl({ users: [alice] });
    await control.auth.credentials.setPassword("alice", "správné-heslo-123");
    const me = control.asUser("alice");
    const { secret } = await (await me("/me/security/totp", { method: "POST" })).json();
    const step = totpStep();
    expect((await me("/me/security/totp/confirm", { method: "POST", body: JSON.stringify({ code: "000000" }) })).status).toBe(400);
    const confirmed = await (await me("/me/security/totp/confirm", { method: "POST", body: JSON.stringify({ code: totpCode(secret, step) }) })).json();
    expect(confirmed.recoveryCodes).toHaveLength(10);
    expect(confirmed.security).toMatchObject({ password: true, totp: true, recoveryCodes: 10 });

    const b = await browser(control);
    const uid = (await b.authorize()).searchParams.get("uid")!;
    expect(await (await b.post(`/auth/interaction/${uid}/password`, { email: "alice@firma.cz", password: "správné-heslo-123" })).json()).toEqual({
      step: "second-factor",
    });
    expect((await (await b.request(`/auth/interaction/${uid}/state`)).json()).step).toBe("second-factor");
    // The code used to confirm the app is spent.
    expect((await b.post(`/auth/interaction/${uid}/second-factor`, { code: totpCode(secret, step) })).status).toBe(401);
    const done = await (await b.post(`/auth/interaction/${uid}/second-factor`, { code: confirmed.recoveryCodes[0] })).json();
    expect((await b.follow(done.redirectTo)).pathname).toBe("/callback");
    expect((await control.auth.credentials.summary("alice")).recoveryCodes).toBe(9);

    // Turning the app off takes a code; then the password alone is enough again.
    expect((await me("/me/security/totp", { method: "DELETE", body: JSON.stringify({ code: confirmed.recoveryCodes[0] }) })).status).toBe(400);
    expect((await me("/me/security/totp", { method: "DELETE", body: JSON.stringify({ code: confirmed.recoveryCodes[1] }) })).status).toBe(200);
    expect(await control.auth.credentials.hasTotp("alice")).toBe(false);
  });

  it("signs in with a one-time link opened in the browser, which works once", async () => {
    const control = await createTestControl({ users: [alice] });
    const link = new URL(await control.users.loginLink("alice", 1, "invite"));
    const b = await browser(control);
    const opened = await b.request(link.pathname);
    // Opening it only remembers it; the app then starts a sign-in.
    expect([opened.status, opened.headers.get("location")]).toEqual([302, "/?signin=link"]);
    expect((await b.authorize({ prompt: "login consent" })).pathname).toBe("/callback");

    const other = await browser(control);
    await other.request(link.pathname);
    const refused = await other.authorize();
    expect([refused.pathname, refused.searchParams.get("error")]).toEqual(["/login", expect.stringContaining("invalid")]);
  });

  it("sends a sign-in link by email without telling whether the address exists", async () => {
    const control = await createTestControl({ users: [alice] });
    const b = await browser(control);
    const uid = (await b.authorize()).searchParams.get("uid")!;
    expect(await (await b.post(`/auth/interaction/${uid}/email-link`, { email: "nikdo@firma.cz" })).json()).toEqual({ sent: true });
    expect(await (await b.post(`/auth/interaction/${uid}/email-link`, { email: "alice@firma.cz" })).json()).toEqual({ sent: true });
    expect(control.mail.map((m) => m.to)).toEqual(["alice@firma.cz"]);
    const link = control.mail[0]!.text.match(/http:\/\/osiris\.test(\/auth\/link\/[\w-]+)/)![1]!;
    await b.request(link);
    expect((await b.authorize({ prompt: "login consent" })).pathname).toBe("/callback");
    // The address is proven by the link.
    expect((await control.users.get("alice")).emailVerified).toBe(true);
  });

  it("signs in with Facebook, matching an existing user by the confirmed email", async () => {
    const calls: string[] = [];
    const socialFetch = (async (url: string) => {
      const u = new URL(url);
      calls.push(u.pathname);
      if (u.pathname.endsWith("/oauth/access_token")) {
        expect(u.searchParams.get("code")).toBe("fb-code");
        return Response.json({ access_token: "fb-token" });
      }
      if (u.pathname.endsWith("/me")) return Response.json({ id: "fb-1", email: "Alice@Firma.cz", first_name: "Alice", last_name: "N" });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const control = await createTestControl({ users: [alice], social: { facebook: { clientId: "app", clientSecret: "secret" } }, socialFetch });
    const b = await browser(control);
    const uid = (await b.authorize()).searchParams.get("uid")!;
    expect((await (await b.request(`/auth/interaction/${uid}/state`)).json()).methods.social).toEqual(["facebook"]);

    const toFacebook = await b.request(`/auth/interaction/${uid}/social/facebook`);
    const fb = new URL(toFacebook.headers.get("location")!);
    expect(fb.origin).toBe("https://www.facebook.com");
    expect(fb.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/auth/social/facebook/callback`);
    const state = fb.searchParams.get("state")!;

    const back = await b.follow(`/auth/social/facebook/callback?code=fb-code&state=${state}`);
    expect(back.pathname).toBe("/callback");
    expect(calls).toEqual(["/v23.0/oauth/access_token", "/v23.0/me"]);
    expect(await control.auth.credentials.identities("alice")).toMatchObject([{ provider: "facebook", subject: "fb-1" }]);
    // The state works once.
    expect((await b.request(`/auth/social/facebook/callback?code=fb-code&state=${state}`)).headers.get("location")).toContain("error=");
  });

  it("signs in with Seznam, matching by email only for Seznam's own mailboxes", async () => {
    let email = "Alice@Firma.cz";
    const socialFetch = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/oauth/token") {
        expect(new URLSearchParams(String(init?.body)).get("code")).toBe("szn-code");
        return Response.json({ access_token: "szn-token" });
      }
      if (u.pathname === "/api/v1/user") {
        expect(new Headers(init?.headers).get("authorization")).toBe("bearer szn-token");
        return Response.json({ oauth_user_id: "szn-1", email, firstname: "Alice", lastname: "N" });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const bob = { ...alice, id: "bob", email: "bob@seznam.cz" };
    const control = await createTestControl({ users: [alice, bob], social: { seznam: { clientId: "app", clientSecret: "secret" } }, socialFetch });
    const b = await browser(control);
    const signIn = async () => {
      const uid = (await b.authorize({ prompt: "login consent" })).searchParams.get("uid")!;
      const szn = new URL((await b.request(`/auth/interaction/${uid}/social/seznam`)).headers.get("location")!);
      expect(szn.origin).toBe("https://login.szn.cz");
      expect(szn.searchParams.get("scope")).toBe("identity");
      return b.follow(`/auth/social/seznam/callback?code=szn-code&state=${szn.searchParams.get("state")}`);
    };

    // An outside address on a Seznam account isn't proven by Seznam.
    expect((await signIn()).pathname).not.toBe("/callback");
    expect(await control.auth.credentials.identities("alice")).toEqual([]);

    email = "Bob@Seznam.cz";
    expect((await signIn()).pathname).toBe("/callback");
    expect(await control.auth.credentials.identities("bob")).toMatchObject([{ provider: "seznam", subject: "szn-1" }]);
  });

  it("keeps at least one way to sign in and checks the current password", async () => {
    const control = await createTestControl({ users: [alice] });
    const me = control.asUser("alice");
    expect((await me("/me/security/password", { method: "PUT", body: JSON.stringify({ password: "krátké" }) })).status).toBe(400);
    expect((await me("/me/security/password", { method: "PUT", body: JSON.stringify({ password: "dlouhé-heslo-1" }) })).status).toBe(200);
    expect((await me("/me/security/password", { method: "PUT", body: JSON.stringify({ current: "jiné", password: "nové-heslo-22" }) })).status).toBe(400);
    expect((await me("/me/security/password", { method: "PUT", body: JSON.stringify({ current: "dlouhé-heslo-1", password: "nové-heslo-22" }) })).status).toBe(200);
    expect(await control.auth.credentials.checkPassword("alice@firma.cz", "nové-heslo-22")).toBe("alice");
    const removed = await me("/me/security/password", { method: "DELETE" });
    expect([removed.status, (await removed.json()).error]).toEqual([400, expect.stringContaining("only way")]);
  });
});

describe("emailitMailer", () => {
  it("sends through Emailit's API without tracking, which would rewrite the sign-in links", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const fetchFn = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Response.json(status === 200 ? { id: "em_1", status: "accepted" } : { error: "Insufficient credits" }, { status });
    }) as unknown as typeof fetch;
    const mailer = emailitMailer("key", "Osiris <auth@k6labs.cz>", fetchFn);

    await mailer.send({ to: "alice@firma.cz", subject: "Přihlášení", text: "https://osiris.test/auth/link/x" });
    expect(sent[0]!.url).toBe("https://api.emailit.com/v2/emails");
    expect(new Headers(sent[0]!.init.headers).get("authorization")).toBe("Bearer key");
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
      from: "Osiris <auth@k6labs.cz>",
      to: "alice@firma.cz",
      subject: "Přihlášení",
      text: "https://osiris.test/auth/link/x",
      tracking: false,
    });

    status = 402;
    await expect(mailer.send({ to: "alice@firma.cz", subject: "x", text: "y" })).rejects.toThrow("402");
  });
});


describe("account activity and sessions", () => {
  it("records successes and failures, isolates users and revokes a whole browser session", async () => {
    const control = await createTestControl({ users: [alice, { ...alice, id: "bob", email: "bob@firma.cz" }] });
    await control.auth.credentials.setPassword("alice", "correct-password-123");
    const first = await browser(control, { "x-forwarded-for": "8.8.8.8", "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/123.0" });
    const second = await browser(control, { "x-forwarded-for": "1.1.1.1", "user-agent": "Mozilla/5.0 (iPhone) Version/17.0 Safari/605.1" });
    const login = async (b: typeof first, fail = false) => {
      const url = await b.authorize();
      const path = `/auth/interaction/${url.searchParams.get("uid")}/password`;
      if (fail) expect((await b.post(path, { email: alice.email, password: "wrong" })).status).toBe(401);
      const result = await (await b.post(path, { email: alice.email, password: "correct-password-123" })).json();
      const tokens = await b.exchange(await b.follow(result.redirectTo));
      expect(tokens.status).toBe(200);
      return tokens.body;
    };
    const a = await login(first, true);
    const b = await login(second);
    const who = await (await identify(control, b.access_token!)).json();
    expect(who.sessionUid).toBeTruthy();
    const me = async (path: string, method = "GET", user = "alice") => control.app.request(`/api/me/security${path}`, {
      method, headers: { authorization: await gateway.header(CONTROL_AUDIENCE, {
        user: { sub: user, name: user, email: null, phone: null, picture: null }, sessionUid: who.sessionUid,
      }) },
    });
    const activity = await (await me("/activity")).json();
    expect(activity.events).toHaveLength(3);
    expect(activity.events.every((e: { country: string }) => e.country === "")).toBe(true);
    expect(activity.events.filter((e: { success: boolean }) => !e.success)).toHaveLength(1);
    expect(activity.events).toEqual(expect.arrayContaining([expect.objectContaining({ ip: "8.8.8.8", browser: "Chrome", success: true })]));
    expect(activity.sessions).toHaveLength(2);
    expect(activity.sessions.filter((e: { current: boolean }) => e.current)).toHaveLength(1);
    const other = activity.sessions.find((e: { current: boolean }) => !e.current);
    expect(other.browser).toBe("Chrome");
    expect(other.ip).toBe("8.8.8.8");
    expect((await me(`/sessions/${other.id}`, "DELETE", "bob")).status).toBe(404);
    expect(await (await me("/activity", "GET", "bob")).json()).toEqual({ events: [], sessions: [] });
    expect((await me(`/sessions/${other.id}`, "DELETE")).status).toBe(204);
    expect((await identify(control, a.access_token!)).status).toBe(401);
    expect((await first.token({ grant_type: "refresh_token", refresh_token: a.refresh_token! })).status).toBe(400);
    expect((await identify(control, b.access_token!)).status).toBe(200);
    expect((await (await me("/activity")).json()).sessions).toHaveLength(1);
    expect((await first.authorize()).pathname).toBe("/login");
    expect((await me(`/sessions/${other.id}`, "DELETE")).status).toBe(404);
    // Revocation tombstones also reject a late write of a session with the same UID.
    const resurrected = new control.auth.provider.Session();
    resurrected.accountId = "alice";
    resurrected.uid = other.id;
    await resurrected.save(3600);
    expect(await control.auth.provider.Session.findByUid(other.id)).toBeUndefined();
    await control.auth.activity.cleanup(Date.now() + 91 * 86_400_000);
    expect(await control.auth.activity.history("alice")).toEqual([]);
    expect(await control.db.query("SELECT * FROM auth_events")).toEqual([]);
  });
});
