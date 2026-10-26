import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accessFromClaims, accessibleProjects, isAuthorized, isSystemAdmin, membershipsFromClaims } from "@osiris/platform/claims.ts";
import { CONTROL_AUDIENCE, generateInternalKeys, InternalSigner, InternalVerifier, projectAudience } from "@osiris/platform/internal-auth.ts";
import { RuntimeClient, SLEEPING_HEADER } from "@osiris/platform/runtime-client.ts";
import { createGatewayApp } from "../src/app.ts";
import { ControlDirectory } from "../src/control.ts";
import { createDevVerifier, createTokenVerifier, introspection } from "../src/oidc.ts";
import { RateLimiter } from "../src/rate-limit.ts";

const keys = await generateInternalKeys();
const verifier = new InternalVerifier(keys.publicKey);

/** The gateway in front of a fake control and fake runtimes that echo what they were sent. */
function setup(options: { runsPerMinute?: number; web?: { dir: string; goatcounter?: string } } = {}) {
  const calls: { service: string; path: string; method: string; auth: string | null; projectHeader: string | null; body?: string }[] = [];
  const asleep = new Set<string>(["beta"]);
  const woken: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    if (u.host === "control") {
      if (u.pathname === "/internal/gateway/projects") return Response.json([{ id: "acme", name: "ACME" }, { id: "beta", name: "Beta" }]);
      const wake = /^\/internal\/gateway\/projects\/([^/]+)\/wake$/.exec(u.pathname);
      if (wake) {
        woken.push(wake[1]!);
        asleep.delete(wake[1]!);
        return new Response(null, { status: 204 });
      }
      const endpoint = /^\/internal\/gateway\/projects\/([^/]+)\/endpoint$/.exec(u.pathname);
      if (endpoint) return Response.json({ url: `http://runtime-${endpoint[1]}` });
      if (u.pathname.startsWith("/project-logos/")) return new Response("png", { headers: { "content-type": "image/png", "set-cookie": "x=1", "x-internal": "secret" } });
    }
    const service = u.host === "control" ? "control" : u.host.replace("runtime-", "");
    // What Cilium answers for a Service without endpoints.
    if (asleep.has(service)) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EPERM" } });
    if (u.pathname === "/health") return Response.json({ ok: true });
    calls.push({
      service,
      path: u.pathname + u.search,
      method: init.method ?? "GET",
      auth: headers.get("authorization"),
      projectHeader: headers.get("x-project-id"),
      body: init.body ? Buffer.from(init.body as Uint8Array).toString() : undefined,
    });
    return Response.json({ ok: true, service }, { headers: { "x-internal": "secret", "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const signer = new InternalSigner(keys.privateKey, "gateway");
  const control = new ControlDirectory("http://control", signer, fetchFn);
  const app = createGatewayApp({
    verifier: createDevVerifier(),
    signer,
    control,
    controlUrl: "http://control",
    runtimes: new RuntimeClient(control, { fetchFn, wakeTimeoutMs: 3000 }),
    corsOrigin: "*",
    maxBodyBytes: 1024,
    limits: { requestsPerMinute: 100, runsPerMinute: options.runsPerMinute ?? 10 },
    web: options.web,
    auth: { issuer: "https://auth.example.cz" },
    fetchFn,
  });
  const as = (token: string, project?: string) => (path: string, init: RequestInit = {}) =>
    app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(project ? { "x-project-id": project } : {}), ...(init.headers as Record<string, string>) } });
  return { app, as, calls, woken };
}

describe("access from claims", () => {
  it("maps project to member and project-admin to admin, from single values or comma-separated lists", () => {
    const access = accessFromClaims((key) => ({ role: "osiris-user", project: "acme, novak-stavby,Bad", "project-admin": ["acme", "beta"] })[key]);
    expect(isAuthorized(access)).toBe(true);
    expect(membershipsFromClaims(access)).toEqual([
      { projectId: "acme", role: "admin" },
      { projectId: "beta", role: "admin" },
      { projectId: "novak-stavby", role: "member" },
    ]);
  });

  it("requires the role osiris-user or osiris-admin; a system admin gets every project", () => {
    const without = accessFromClaims((key) => ({ project: "acme", role: "admin" })[key]);
    expect(isAuthorized(without)).toBe(false);
    expect(accessibleProjects(without, ["acme"])).toEqual([]);
    const admin = accessFromClaims((key) => ({ role: "osiris-admin" })[key]);
    expect(isAuthorized(admin) && isSystemAdmin(admin)).toBe(true);
    expect(accessibleProjects(admin, ["x"])).toEqual([{ projectId: "x", role: "admin" }]);
  });

  it("has osiris-auth introspect a token (RFC 7662) and reuses the answer for a minute", async () => {
    const asked: string[] = [];
    let status = 200;
    const fetchFn = (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://auth.example.cz/introspect");
      expect(new Headers(init.headers).get("authorization")).toBe(`Basic ${Buffer.from("osiris-gateway:s%3Acret").toString("base64")}`);
      const token = new URLSearchParams(String(init.body)).get("token")!;
      asked.push(token);
      if (token === "dead") return Response.json({ active: false }, { status });
      return Response.json(
        { active: true, sub: "s", email: "a@b.cz", name: "A", phone_number: "+420777123456", picture: null, groups: ["project:a", "osiris-user"], exp: Math.floor(Date.now() / 1000) + 3600 },
        { status },
      );
    }) as unknown as typeof fetch;
    const verifier = createTokenVerifier(introspection({ url: "https://auth.example.cz", clientSecret: "s:cret", fetchFn }));
    const identity = await verifier.identify("t1");
    expect(identity).toEqual({
      sub: "s",
      email: "a@b.cz",
      name: "A",
      phone: "+420777123456",
      picture: null,
      access: { roles: ["osiris-user"], projects: ["a"], adminProjects: [] },
      claimKeys: ["osiris-user", "project:a"],
    });
    await verifier.identify("t1");
    expect(asked).toEqual(["t1"]);
    await expect(verifier.identify("dead")).rejects.toMatchObject({ status: 401 });
    // osiris-auth refusing the gateway is no bad token: the browser mustn't sign in again.
    status = 401;
    await expect(verifier.identify("t2")).rejects.toMatchObject({ status: 502 });
  });

  it("dev verifier gives a user their own project unless claims are given", async () => {
    const dev = createDevVerifier();
    expect((await dev.identify("alice")).access).toEqual({ roles: ["osiris-user"], projects: [], adminProjects: ["alice"] });
    expect((await dev.identify("bob:project=acme,beta&role=osiris-admin")).access).toEqual({ roles: ["osiris-admin"], projects: ["acme", "beta"], adminProjects: [] });
    await expect(dev.identify("../x")).rejects.toThrow();
  });
});

describe("gateway", () => {
  it("refuses missing tokens and users without a role or a project, saying which claims arrived", async () => {
    const { app, as } = setup();
    expect((await app.request("/api/me")).status).toBe(401);
    const refused = await as("alice:project-admin=&role=osiris-user")("/me");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "This account doesn't belong to any organization yet. Ask an administrator for an invitation.",
      code: "errors.access.noProject",
      user: { sub: "dev:alice", name: "alice", email: "alice@dev.local", role: ["osiris-user"], project: [], "project-admin": [] },
    });
    const czech = await as("alice:project-admin=&role=osiris-user")("/me", { headers: { "accept-language": "sk-SK, en;q=0.5" } });
    expect((await czech.json()).error).toBe("Účet zatím nepatří k žádné firmě. Požádej správce o pozvánku.");
    expect((await as("alice:project=acme&role=")("/me")).status).toBe(403);
    // Claims naming a removed project don't count.
    expect((await as("alice:project=gone")("/me")).status).toBe(403);
  });

  it("sends account and administration calls to control with the user and memberships", async () => {
    const { as, calls } = setup();
    const res = await as("root:role=osiris-admin", "beta")("/admin/projects?x=1", { method: "POST", body: '{"id":"n"}', headers: { "content-type": "application/json" } });
    expect(await res.json()).toEqual({ ok: true, service: "control" });
    // Internal headers of the services don't reach the browser.
    expect(res.headers.get("x-internal")).toBeNull();
    expect(calls[0]).toMatchObject({ service: "control", path: "/api/admin/projects?x=1", method: "POST", projectHeader: "beta", body: '{"id":"n"}' });
    const call = await verifier.verifyHeader(calls[0]!.auth!, CONTROL_AUDIENCE);
    expect(call).toMatchObject({
      issuer: "gateway",
      user: { sub: "dev:root" },
      systemAdmin: true,
      memberships: [{ projectId: "acme", role: "admin" }, { projectId: "beta", role: "admin" }],
    });
  });

  it("sends project calls to the project's runtime with the user's role there", async () => {
    const { as, calls } = setup();
    expect((await as("alice:project=acme,beta")("/threads")).status).toBe(400);
    expect((await as("alice:project=acme", "beta")("/threads")).status).toBe(403);
    expect((await as("alice:project=acme")("/threads")).status).toBe(200);
    expect(calls[0]).toMatchObject({ service: "acme", path: "/api/threads" });
    expect(await verifier.verifyHeader(calls[0]!.auth!, projectAudience("acme"))).toMatchObject({ user: { sub: "dev:alice" }, project: "acme", role: "member", channel: "web" });
    // A token for one project is useless at another.
    await expect(verifier.verifyHeader(calls[0]!.auth!, projectAudience("beta"))).rejects.toThrow();
  });

  it("wakes a sleeping runtime and sends the request again", async () => {
    const { as, calls, woken } = setup();
    const res = await as("bob:project-admin=beta")("/files/content?scope=personal&path=a.txt", { method: "PUT", body: "ahoj" });
    expect(res.status).toBe(200);
    expect(woken).toEqual(["beta"]);
    expect(calls).toMatchObject([{ service: "beta", method: "PUT", body: "ahoj" }]);
  });

  it("limits body size and agent runs per user", async () => {
    const { as } = setup({ runsPerMinute: 2 });
    expect((await as("alice:project=acme")("/files/content?scope=personal&path=a.txt", { method: "PUT", body: "x".repeat(2000) })).status).toBe(413);
    const run = () => as("alice:project=acme")("/threads/t1/runs", { method: "POST", body: "{}" });
    expect((await run()).status).toBe(200);
    expect((await run()).status).toBe(200);
    expect((await run()).status).toBe(429);
    const limiter = new RateLimiter(2);
    expect([limiter.take("a", 0), limiter.take("a", 1), limiter.take("a", 2), limiter.take("b", 2)]).toEqual([true, true, false, true]);
    // Half a minute into the next window, half of the old count still counts: room for one more and a fraction.
    expect([limiter.take("a", 90_000), limiter.take("a", 90_001), limiter.take("a", 90_002)]).toEqual([true, true, false]);
  });

  it("passes Meta's webhook to control as it came", async () => {
    const { app, calls } = setup();
    const body = '{"entry":[]}';
    const sig = `sha256=${createHmac("sha256", "s").update(body).digest("hex")}`;
    await app.request("/webhooks/whatsapp", { method: "POST", body, headers: { "x-hub-signature-256": sig, "content-type": "application/json" } });
    expect(calls[0]).toMatchObject({ service: "control", path: "/webhooks/whatsapp", body, auth: null });
  });

  it("tells clients where to sign in, lets osiris-auth use this host's passkeys and passes project logos on", async () => {
    const { app } = setup();
    expect(await (await app.request("/auth-config.json")).json()).toEqual({ issuer: "https://auth.example.cz", clientId: "osiris-web" });
    expect(await (await app.request("/.well-known/webauthn")).json()).toEqual({ origins: ["https://auth.example.cz"] });
    const logo = await app.request("/project-logos/acme/v1");
    expect([logo.status, logo.headers.get("content-type"), logo.headers.get("set-cookie"), logo.headers.get("x-internal"), await logo.text()]).toEqual([200, "image/png", null, null, "png"]);
  });

  it("serves the web app with a strict CSP and an SPA fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osiris-web-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>app");
    const { app } = setup({ web: { dir } });
    const page = await app.request("/callback?code=x");
    expect(await page.text()).toBe("<!doctype html>app");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self' https://auth.example.cz;");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
  });

  it("passes customers to the public assistant with a visitor id and nothing else, and lets projects embed the chat page", async () => {
    const { app, calls } = setup();
    const visitor = { "x-visitor-id": "anna-visitor-123456" };
    const res = await app.request("/public/acme/threads", { method: "POST", headers: { ...visitor, authorization: "Bearer acme" } });
    expect(res.status).toBe(200);
    const call = calls.at(-1)!;
    expect([call.service, call.path]).toEqual(["acme", "/public/threads"]);
    const claims = await new InternalVerifier(keys.publicKey).verifyHeader(call.auth!, projectAudience("acme"));
    // The visitor's own bearer token is ignored: no user, no role, just the visitor.
    expect(claims).toMatchObject({ project: "acme", visitor: "anna-visitor-123456", channel: "public" });
    expect(claims.user).toBeUndefined();
    expect(claims.role).toBeUndefined();

    expect((await app.request("/public/acme/info")).status).toBe(400);
    expect((await app.request("/public/nope/info", { headers: visitor })).status).toBe(404);
    expect((await app.request("/public/Bad_Slug/info", { headers: visitor })).status).toBe(404);

    const dir = mkdtempSync(join(tmpdir(), "osiris-web-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>app");
    const web = setup({ web: { dir } }).app;
    const page = await web.request("/c/acme");
    expect(page.headers.get("x-frame-options")).toBeNull();
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors *");
    expect((await web.request("/")).headers.get("x-frame-options")).toBe("DENY");
  });

  it("adds GoatCounter's script to the page and its site to the CSP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osiris-web-"));
    writeFileSync(join(dir, "index.html"), "<html><head><title>Osiris</title></head><body></body></html>");
    const { app } = setup({ web: { dir, goatcounter: "https://osiris.stats.example.cz" } });
    for (const path of ["/", "/callback?code=x"]) {
      const page = await app.request(path);
      expect(await page.text()).toContain('<script data-goatcounter="https://osiris.stats.example.cz/count" async src="https://osiris.stats.example.cz/count.js"></script>');
      const csp = page.headers.get("content-security-policy")!;
      expect(csp).toContain("script-src 'self' https://osiris.stats.example.cz;");
      expect(csp).toContain("img-src 'self' data: blob: https://auth.example.cz https://osiris.stats.example.cz;");
      expect(csp).toContain("connect-src 'self' https://auth.example.cz https://osiris.stats.example.cz;");
    }
  });
});
