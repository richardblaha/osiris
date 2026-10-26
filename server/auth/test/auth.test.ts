import { afterEach, describe, expect, it } from "vitest";
import { emailitMailer } from "@osiris/platform/mail.ts";
import { matchTotp, totpCode, totpStep } from "../src/secrets.ts";
import { browser, closeServers, createTestAuth, ISSUER, WEB } from "./helpers.ts";

afterEach(closeServers);

const alice = { id: "alice", firstName: "Alice", lastName: "Nováková", email: "alice@firma.cz", groups: ["osiris-user", "project:acme"] };

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
  it("signs in with a password through the whole authorization code flow, and the gateway introspects the token", async () => {
    const auth = await createTestAuth({ users: [alice] });
    await auth.auth.credentials.setPassword("alice", "správné-heslo-123");
    const b = await browser(auth);

    const login = await b.authorize();
    expect(`${login.origin}${login.pathname}`).toBe(`${ISSUER}/login`);
    const uid = login.searchParams.get("uid")!;
    expect(await (await b.request(`/interaction/${uid}/state`)).json()).toEqual({
      step: "login",
      methods: { passkey: true, emailLink: true, social: [] },
    });
    // Without the browser's interaction cookie the step is refused.
    expect((await auth.app.request(`/interaction/${uid}/state`)).status).toBe(400);

    expect((await b.post(`/interaction/${uid}/password`, { email: "alice@firma.cz", password: "špatné" })).status).toBe(401);
    const ok = await (await b.post(`/interaction/${uid}/password`, { email: "ALICE@firma.cz", password: "správné-heslo-123" })).json();
    expect(ok.redirectTo).toMatch(new RegExp(`^/authorize/${uid}$`));

    const callback = await b.follow(ok.redirectTo);
    expect([`${callback.origin}${callback.pathname}`, callback.searchParams.get("state")]).toEqual([`${WEB}/callback`, "st"]);
    const tokens = await b.exchange(callback);
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ access_token: expect.any(String), refresh_token: expect.any(String), id_token: expect.any(String) });
    const who = await auth.introspect(tokens.body.access_token!);
    expect(await who.json()).toMatchObject({
      active: true,
      iss: ISSUER,
      sub: "alice",
      client_id: "osiris-web",
      email: "alice@firma.cz",
      name: "Alice Nováková",
      groups: ["osiris-user", "project:acme"],
      sid: expect.any(String),
    });
    expect(await (await auth.introspect("nonsense")).json()).toEqual({ active: false });
    // Only the gateway introspects.
    expect((await auth.introspect(tokens.body.access_token!, "wrong-secret")).status).toBe(401);

    // Group changes show at once, not after the token is renewed.
    await auth.users.createGroup("project-admin:acme", ["alice"]);
    expect((await (await auth.introspect(tokens.body.access_token!)).json()).groups).toEqual(["osiris-user", "project-admin:acme", "project:acme"]);

    const userinfo = await (await b.request("/userinfo", { headers: { authorization: `Bearer ${tokens.body.access_token}` } })).json();
    expect(userinfo).toMatchObject({ sub: "alice", email: "alice@firma.cz", given_name: "Alice", groups: expect.arrayContaining(["osiris-user"]) });

    const refreshed = await b.token({ grant_type: "refresh_token", refresh_token: tokens.body.refresh_token! });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(tokens.body.refresh_token);

    // Already signed in: the next authorization goes straight back to the app.
    expect((await b.authorize()).pathname).toBe("/callback");

    // A code works once; replaying it revokes the tokens it gave.
    expect((await b.exchange(callback)).status).toBe(400);
    expect((await (await auth.introspect(refreshed.body.access_token!)).json()).active).toBe(false);

    // A disabled user's tokens stop working.
    const again = await b.exchange(await b.authorize());
    expect((await (await auth.introspect(again.body.access_token!)).json()).active).toBe(true);
    await auth.users.update("alice", { disabled: true });
    expect((await (await auth.introspect(again.body.access_token!)).json()).active).toBe(false);
  });

  it("signs the terminal client in through a loopback port of its own, and the gateway accepts its token", async () => {
    const auth = await createTestAuth({ users: [alice] });
    await auth.auth.credentials.setPassword("alice", "správné-heslo-123");
    const b = await browser(auth);
    const redirect = "http://127.0.0.1:53123/callback";
    const uid = (await b.authorize({ client_id: "osiris-cli", redirect_uri: redirect })).searchParams.get("uid")!;
    const ok = await (await b.post(`/interaction/${uid}/password`, { email: "alice@firma.cz", password: "správné-heslo-123" })).json();
    const callback = await b.follow(ok.redirectTo);
    expect(`${callback.origin}${callback.pathname}`).toBe(redirect);
    const tokens = await b.token({ client_id: "osiris-cli", grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: redirect, code_verifier: b.verifier });
    expect(tokens.status).toBe(200);
    expect(await (await auth.introspect(tokens.body.access_token!)).json()).toMatchObject({ active: true, sub: "alice" });
    // Another host is no loopback.
    const evil = await b.request(`/authorize?${new URLSearchParams({ client_id: "osiris-cli", redirect_uri: "http://evil.example/callback", response_type: "code", scope: "openid", code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`);
    expect(evil.headers.get("location") ?? "").not.toContain("evil.example");
  });

  it("asks for the authenticator code after the password, once per code, or takes a recovery code", async () => {
    const auth = await createTestAuth({ users: [alice] });
    await auth.auth.credentials.setPassword("alice", "správné-heslo-123");
    const signedIn = await browser(auth);
    expect((await signedIn.signIn("alice@firma.cz", "správné-heslo-123")).status).toBe(200);
    const { secret } = await (await signedIn.me("/totp", { method: "POST" })).json();
    const step = totpStep();
    expect((await signedIn.me("/totp/confirm", { method: "POST", body: JSON.stringify({ code: "000000" }) })).status).toBe(400);
    const confirmed = await (await signedIn.me("/totp/confirm", { method: "POST", body: JSON.stringify({ code: totpCode(secret, step) }) })).json();
    expect(confirmed.recoveryCodes).toHaveLength(10);
    expect(confirmed.security).toMatchObject({ password: true, totp: true, recoveryCodes: 10 });

    const b = await browser(auth);
    const uid = (await b.authorize()).searchParams.get("uid")!;
    expect(await (await b.post(`/interaction/${uid}/password`, { email: "alice@firma.cz", password: "správné-heslo-123" })).json()).toEqual({
      step: "second-factor",
    });
    expect((await (await b.request(`/interaction/${uid}/state`)).json()).step).toBe("second-factor");
    // The code used to confirm the app is spent.
    expect((await b.post(`/interaction/${uid}/second-factor`, { code: totpCode(secret, step) })).status).toBe(401);
    const done = await (await b.post(`/interaction/${uid}/second-factor`, { code: confirmed.recoveryCodes[0] })).json();
    expect((await b.follow(done.redirectTo)).pathname).toBe("/callback");
    expect((await auth.auth.credentials.summary("alice")).recoveryCodes).toBe(9);

    // Turning the app off takes a code; then the password alone is enough again.
    expect((await signedIn.me("/totp", { method: "DELETE", body: JSON.stringify({ code: confirmed.recoveryCodes[0] }) })).status).toBe(400);
    expect((await signedIn.me("/totp", { method: "DELETE", body: JSON.stringify({ code: confirmed.recoveryCodes[1] }) })).status).toBe(200);
    expect(await auth.auth.credentials.hasTotp("alice")).toBe(false);
  });

  it("signs in with a one-time link opened in the browser, which works once", async () => {
    const auth = await createTestAuth({ users: [alice] });
    const link = new URL(await auth.users.loginLink("alice", 1, "invite"));
    expect(link.origin).toBe(ISSUER);
    const b = await browser(auth);
    const opened = await b.request(link.pathname);
    // Opening it only remembers it; the web app then starts a sign-in.
    expect([opened.status, opened.headers.get("location")]).toEqual([302, `${WEB}/?signin=link`]);
    expect((await b.authorize({ prompt: "login consent" })).pathname).toBe("/callback");

    const other = await browser(auth);
    await other.request(link.pathname);
    const refused = await other.authorize();
    expect([refused.pathname, refused.searchParams.get("error")]).toEqual(["/login", expect.stringContaining("invalid")]);
  });

  it("sends a sign-in link by email without telling whether the address exists", async () => {
    const auth = await createTestAuth({ users: [alice] });
    const b = await browser(auth);
    const uid = (await b.authorize()).searchParams.get("uid")!;
    expect(await (await b.post(`/interaction/${uid}/email-link`, { email: "nikdo@firma.cz" })).json()).toEqual({ sent: true });
    expect(await (await b.post(`/interaction/${uid}/email-link`, { email: "alice@firma.cz" })).json()).toEqual({ sent: true });
    expect(auth.mail.map((m) => m.to)).toEqual(["alice@firma.cz"]);
    const link = auth.mail[0]!.text.match(/http:\/\/auth\.test(\/link\/[\w-]+)/)![1]!;
    await b.request(link);
    expect((await b.authorize({ prompt: "login consent" })).pathname).toBe("/callback");
    // The address is proven by the link.
    expect((await auth.users.get("alice")).emailVerified).toBe(true);
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
    const auth = await createTestAuth({ users: [alice], social: { facebook: { clientId: "app", clientSecret: "secret" } }, socialFetch });
    const b = await browser(auth);
    const uid = (await b.authorize()).searchParams.get("uid")!;
    expect((await (await b.request(`/interaction/${uid}/state`)).json()).methods.social).toEqual(["facebook"]);

    const toFacebook = await b.request(`/interaction/${uid}/social/facebook`);
    const fb = new URL(toFacebook.headers.get("location")!);
    expect(fb.origin).toBe("https://www.facebook.com");
    expect(fb.searchParams.get("redirect_uri")).toBe(`${ISSUER}/social/facebook/callback`);
    const state = fb.searchParams.get("state")!;

    const back = await b.follow(`/social/facebook/callback?code=fb-code&state=${state}`);
    expect(back.pathname).toBe("/callback");
    expect(calls).toEqual(["/v23.0/oauth/access_token", "/v23.0/me"]);
    expect(await auth.auth.credentials.identities("alice")).toMatchObject([{ provider: "facebook", subject: "fb-1" }]);
    // The state works once.
    expect((await b.request(`/social/facebook/callback?code=fb-code&state=${state}`)).headers.get("location")).toContain("error=");
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
    const auth = await createTestAuth({ users: [alice, bob], social: { seznam: { clientId: "app", clientSecret: "secret" } }, socialFetch });
    const b = await browser(auth);
    const signIn = async () => {
      const uid = (await b.authorize({ prompt: "login consent" })).searchParams.get("uid")!;
      const szn = new URL((await b.request(`/interaction/${uid}/social/seznam`)).headers.get("location")!);
      expect(szn.origin).toBe("https://login.szn.cz");
      expect(szn.searchParams.get("scope")).toBe("identity");
      return b.follow(`/social/seznam/callback?code=szn-code&state=${szn.searchParams.get("state")}`);
    };

    // An outside address on a Seznam account isn't proven by Seznam.
    expect((await signIn()).pathname).not.toBe("/callback");
    expect(await auth.auth.credentials.identities("alice")).toEqual([]);

    email = "Bob@Seznam.cz";
    expect((await signIn()).pathname).toBe("/callback");
    expect(await auth.auth.credentials.identities("bob")).toMatchObject([{ provider: "seznam", subject: "szn-1" }]);
  });

  it("keeps at least one way to sign in and checks the current password", async () => {
    const auth = await createTestAuth({ users: [alice] });
    await auth.auth.credentials.setPassword("alice", "dlouhé-heslo-1");
    const b = await browser(auth);
    await b.signIn("alice@firma.cz", "dlouhé-heslo-1");
    expect((await b.me("/password", { method: "PUT", body: JSON.stringify({ current: "dlouhé-heslo-1", password: "krátké" }) })).status).toBe(400);
    expect((await b.me("/password", { method: "PUT", body: JSON.stringify({ current: "jiné", password: "nové-heslo-22" }) })).status).toBe(400);
    expect((await b.me("/password", { method: "PUT", body: JSON.stringify({ current: "dlouhé-heslo-1", password: "nové-heslo-22" }) })).status).toBe(200);
    expect(await auth.auth.credentials.checkPassword("alice@firma.cz", "nové-heslo-22")).toBe("alice");
    const removed = await b.me("/password", { method: "DELETE" });
    expect([removed.status, (await removed.json()).error]).toEqual([400, expect.stringContaining("only way")]);
  });

  it("serves the account API only to a signed-in browser, and changes only from its own pages", async () => {
    const auth = await createTestAuth({ users: [alice] });
    await auth.auth.credentials.setPassword("alice", "dlouhé-heslo-1");
    const b = await browser(auth);
    expect((await b.me("")).status).toBe(401);
    await b.signIn("alice@firma.cz", "dlouhé-heslo-1");
    expect(await (await b.me("")).json()).toMatchObject({ password: true, totp: false });
    // Another site's form or script carries the cookie but not our origin.
    expect((await b.me("/password", { method: "DELETE", headers: { origin: "http://evil.example" } })).status).toBe(403);
    // The account page's own sign-in goes through the provider and lands back on /account.
    const start = await b.request("/account/signin");
    expect(new URL(start.headers.get("location")!, ISSUER).pathname).toBe("/authorize");
    let location = start.headers.get("location")!;
    while (!location.includes("/account/callback")) location = (await b.request(location)).headers.get("location")!;
    expect(location).toContain("/account/callback?code=");
    expect((await b.request(location)).headers.get("location")).toBe("/account");
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

    await mailer.send({ to: "alice@firma.cz", subject: "Přihlášení", text: "https://auth.test/link/x" });
    expect(sent[0]!.url).toBe("https://api.emailit.com/v2/emails");
    expect(new Headers(sent[0]!.init.headers).get("authorization")).toBe("Bearer key");
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
      from: "Osiris <auth@k6labs.cz>",
      to: "alice@firma.cz",
      subject: "Přihlášení",
      text: "https://auth.test/link/x",
      tracking: false,
    });

    status = 402;
    await expect(mailer.send({ to: "alice@firma.cz", subject: "x", text: "y" })).rejects.toThrow("402");
  });
});

describe("account activity and sessions", () => {
  it("records successes and failures, isolates users and revokes a whole browser session", async () => {
    const auth = await createTestAuth({ users: [alice, { ...alice, id: "bob", email: "bob@firma.cz" }] });
    await auth.auth.credentials.setPassword("alice", "correct-password-123");
    await auth.auth.credentials.setPassword("bob", "correct-password-123");
    const first = await browser(auth, { "x-forwarded-for": "8.8.8.8", "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/123.0" });
    const second = await browser(auth, { "x-forwarded-for": "1.1.1.1", "user-agent": "Mozilla/5.0 (iPhone) Version/17.0 Safari/605.1" });
    const login = async (b: typeof first, fail = false) => {
      const url = await b.authorize();
      const path = `/interaction/${url.searchParams.get("uid")}/password`;
      if (fail) expect((await b.post(path, { email: alice.email, password: "wrong" })).status).toBe(401);
      const result = await (await b.post(path, { email: alice.email, password: "correct-password-123" })).json();
      const tokens = await b.exchange(await b.follow(result.redirectTo));
      expect(tokens.status).toBe(200);
      return tokens.body;
    };
    const a = await login(first, true);
    const b = await login(second);
    const activity = await (await second.me("/activity")).json();
    expect(activity.events).toHaveLength(3);
    expect(activity.events.every((e: { country: string }) => e.country === "")).toBe(true);
    expect(activity.events.filter((e: { success: boolean }) => !e.success)).toHaveLength(1);
    expect(activity.events).toEqual(expect.arrayContaining([expect.objectContaining({ ip: "8.8.8.8", browser: "Chrome", success: true })]));
    expect(activity.sessions).toHaveLength(2);
    expect(activity.sessions.filter((e: { current: boolean }) => e.current)).toHaveLength(1);
    const other = activity.sessions.find((e: { current: boolean }) => !e.current);
    expect(other.browser).toBe("Chrome");
    expect(other.ip).toBe("8.8.8.8");

    const bob = await browser(auth);
    await bob.signIn("bob@firma.cz", "correct-password-123");
    expect((await bob.me(`/sessions/${other.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await (await bob.me("/activity")).json()).sessions).toHaveLength(1);

    expect((await second.me(`/sessions/${other.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await (await auth.introspect(a.access_token!)).json()).active).toBe(false);
    expect((await first.token({ grant_type: "refresh_token", refresh_token: a.refresh_token! })).status).toBe(400);
    expect((await (await auth.introspect(b.access_token!)).json()).active).toBe(true);
    expect((await (await second.me("/activity")).json()).sessions).toHaveLength(1);
    expect((await first.authorize()).pathname).toBe("/login");
    expect((await second.me(`/sessions/${other.id}`, { method: "DELETE" })).status).toBe(404);
    // Revocation tombstones also reject a late write of a session with the same UID.
    const resurrected = new auth.auth.provider.Session();
    resurrected.accountId = "alice";
    resurrected.uid = other.id;
    await resurrected.save(3600);
    expect(await auth.auth.provider.Session.findByUid(other.id)).toBeUndefined();
    await auth.auth.activity.cleanup(Date.now() + 91 * 86_400_000);
    expect(await auth.auth.activity.history("alice")).toEqual([]);
    expect(await auth.db.query("SELECT * FROM auth_events")).toEqual([]);
  });
});
