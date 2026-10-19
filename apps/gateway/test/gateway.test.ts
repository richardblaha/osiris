import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accessFromClaims, accessibleTenants, isAuthorized, isSystemAdmin, membershipsFromClaims } from "@osiris/platform/claims.ts";
import { CONTROL_AUDIENCE, generateInternalKeys, InternalSigner, InternalVerifier, tenantAudience } from "@osiris/platform/internal-auth.ts";
import { RuntimeClient, SLEEPING_HEADER } from "@osiris/platform/runtime-client.ts";
import { createGatewayApp } from "../src/app.ts";
import { ControlDirectory } from "../src/control.ts";
import { createControlVerifier, createDevVerifier } from "../src/oidc.ts";
import { RateLimiter } from "../src/rate-limit.ts";

const keys = await generateInternalKeys();
const verifier = new InternalVerifier(keys.publicKey);

/** The gateway in front of a fake control and fake runtimes that echo what they were sent. */
function setup(options: { runsPerMinute?: number; web?: { dir: string } } = {}) {
  const calls: { service: string; path: string; method: string; auth: string | null; tenantHeader: string | null; body?: string }[] = [];
  const asleep = new Set<string>(["beta"]);
  const woken: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    if (u.host === "control") {
      if (u.pathname === "/internal/gateway/tenants") return Response.json([{ id: "acme", name: "ACME" }, { id: "beta", name: "Beta" }]);
      const wake = /^\/internal\/gateway\/tenants\/([^/]+)\/wake$/.exec(u.pathname);
      if (wake) {
        woken.push(wake[1]!);
        asleep.delete(wake[1]!);
        return new Response(null, { status: 204 });
      }
      const endpoint = /^\/internal\/gateway\/tenants\/([^/]+)\/endpoint$/.exec(u.pathname);
      if (endpoint) return Response.json({ url: `http://runtime-${endpoint[1]}` });
      if (u.pathname.startsWith("/auth/")) {
        calls.push({ service: "auth", path: u.pathname + u.search, method: init.method ?? "GET", auth: headers.get("cookie"), tenantHeader: headers.get("x-forwarded-host") });
        const res = new Response(null, { status: 303, headers: { location: "/login?uid=1", "x-internal": "secret" } });
        res.headers.append("set-cookie", "a=1; path=/auth/interaction/1; httponly");
        res.headers.append("set-cookie", "b=2; path=/; httponly");
        return res;
      }
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
      tenantHeader: headers.get("x-tenant-id"),
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
    fetchFn,
  });
  const as = (token: string, tenant?: string) => (path: string, init: RequestInit = {}) =>
    app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(tenant ? { "x-tenant-id": tenant } : {}), ...(init.headers as Record<string, string>) } });
  return { app, as, calls, woken };
}

describe("access from claims", () => {
  it("maps tenant to member and tenant-admin to admin, from single values or comma-separated lists", () => {
    const access = accessFromClaims((key) => ({ role: "osiris-user", tenant: "acme, novak-stavby,Bad", "tenant-admin": ["acme", "beta"] })[key]);
    expect(isAuthorized(access)).toBe(true);
    expect(membershipsFromClaims(access)).toEqual([
      { tenantId: "acme", role: "admin" },
      { tenantId: "beta", role: "admin" },
      { tenantId: "novak-stavby", role: "member" },
    ]);
  });

  it("requires the role osiris-user or osiris-admin; a system admin gets every tenant", () => {
    const without = accessFromClaims((key) => ({ tenant: "acme", role: "admin" })[key]);
    expect(isAuthorized(without)).toBe(false);
    expect(accessibleTenants(without, ["acme"])).toEqual([]);
    const admin = accessFromClaims((key) => ({ role: "osiris-admin" })[key]);
    expect(isAuthorized(admin) && isSystemAdmin(admin)).toBe(true);
    expect(accessibleTenants(admin, ["x"])).toEqual([{ tenantId: "x", role: "admin" }]);
  });

  it("asks control whose a token is and reuses the answer for a minute", async () => {
    const asked: string[] = [];
    const verifier = createControlVerifier(async (token) => {
      asked.push(token);
      return {
        sub: "s",
        email: "a@b.cz",
        name: "A",
        phone: "+420777123456",
        picture: null,
        claims: { role: "osiris-user", tenant: "a", "tenant-admin": undefined },
        expiresAt: Date.now() + 3_600_000,
      };
    });
    const identity = await verifier.identify("t1");
    expect(identity).toEqual({
      sub: "s",
      email: "a@b.cz",
      name: "A",
      phone: "+420777123456",
      picture: null,
      access: { roles: ["osiris-user"], tenants: ["a"], adminTenants: [] },
      claimKeys: ["role", "tenant"],
    });
    await verifier.identify("t1");
    expect(asked).toEqual(["t1"]);
  });

  it("dev verifier gives a user their own tenant unless claims are given", async () => {
    const dev = createDevVerifier();
    expect((await dev.identify("alice")).access).toEqual({ roles: ["osiris-user"], tenants: [], adminTenants: ["alice"] });
    expect((await dev.identify("bob:tenant=acme,beta&role=osiris-admin")).access).toEqual({ roles: ["osiris-admin"], tenants: ["acme", "beta"], adminTenants: [] });
    await expect(dev.identify("../x")).rejects.toThrow();
  });
});

describe("gateway", () => {
  it("refuses missing tokens and users without a role or a tenant, saying which claims arrived", async () => {
    const { app, as } = setup();
    expect((await app.request("/api/me")).status).toBe(401);
    const refused = await as("alice:tenant-admin=&role=osiris-user")("/me");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Účet zatím nepatří k žádné firmě. Požádej správce o pozvánku.",
      user: { sub: "dev:alice", name: "alice", email: "alice@dev.local", role: ["osiris-user"], tenant: [], "tenant-admin": [] },
    });
    expect((await as("alice:tenant=acme&role=")("/me")).status).toBe(403);
    // Claims naming a removed tenant don't count.
    expect((await as("alice:tenant=gone")("/me")).status).toBe(403);
  });

  it("sends account and administration calls to control with the user and memberships", async () => {
    const { as, calls } = setup();
    const res = await as("root:role=osiris-admin", "beta")("/admin/tenants?x=1", { method: "POST", body: '{"id":"n"}', headers: { "content-type": "application/json" } });
    expect(await res.json()).toEqual({ ok: true, service: "control" });
    // Internal headers of the services don't reach the browser.
    expect(res.headers.get("x-internal")).toBeNull();
    expect(calls[0]).toMatchObject({ service: "control", path: "/api/admin/tenants?x=1", method: "POST", tenantHeader: "beta", body: '{"id":"n"}' });
    const call = await verifier.verifyHeader(calls[0]!.auth!, CONTROL_AUDIENCE);
    expect(call).toMatchObject({
      issuer: "gateway",
      user: { sub: "dev:root" },
      systemAdmin: true,
      memberships: [{ tenantId: "acme", role: "admin" }, { tenantId: "beta", role: "admin" }],
    });
  });

  it("sends tenant calls to the tenant's runtime with the user's role there", async () => {
    const { as, calls } = setup();
    expect((await as("alice:tenant=acme,beta")("/threads")).status).toBe(400);
    expect((await as("alice:tenant=acme", "beta")("/threads")).status).toBe(403);
    expect((await as("alice:tenant=acme")("/threads")).status).toBe(200);
    expect(calls[0]).toMatchObject({ service: "acme", path: "/api/threads" });
    expect(await verifier.verifyHeader(calls[0]!.auth!, tenantAudience("acme"))).toMatchObject({ user: { sub: "dev:alice" }, tenant: "acme", role: "member", channel: "web" });
    // A token for one tenant is useless at another.
    await expect(verifier.verifyHeader(calls[0]!.auth!, tenantAudience("beta"))).rejects.toThrow();
  });

  it("wakes a sleeping runtime and sends the request again", async () => {
    const { as, calls, woken } = setup();
    const res = await as("bob:tenant-admin=beta")("/files/content?scope=personal&path=a.txt", { method: "PUT", body: "ahoj" });
    expect(res.status).toBe(200);
    expect(woken).toEqual(["beta"]);
    expect(calls).toMatchObject([{ service: "beta", method: "PUT", body: "ahoj" }]);
  });

  it("limits body size and agent runs per user", async () => {
    const { as } = setup({ runsPerMinute: 2 });
    expect((await as("alice:tenant=acme")("/files/content?scope=personal&path=a.txt", { method: "PUT", body: "x".repeat(2000) })).status).toBe(413);
    const run = () => as("alice:tenant=acme")("/threads/t1/runs", { method: "POST", body: "{}" });
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

  it("passes sign-in to control with its cookies and hands back redirects and cookies", async () => {
    const { app, calls } = setup();
    const res = await app.request("https://osiris.example.cz/auth/authorize?client_id=osiris-web", {
      headers: { cookie: "osiris_session=x", authorization: "Bearer should-pass", "x-forwarded-for": "198.51.100.7, 10.0.0.1" },
    });
    expect([res.status, res.headers.get("location"), res.headers.get("x-internal")]).toEqual([303, "/login?uid=1", null]);
    expect(res.headers.getSetCookie()).toEqual(["a=1; path=/auth/interaction/1; httponly", "b=2; path=/; httponly"]);
    expect(calls).toEqual([
      { service: "auth", path: "/auth/authorize?client_id=osiris-web", method: "GET", auth: "osiris_session=x", tenantHeader: "osiris.example.cz" },
    ]);
  });

  it("serves the web app with a strict CSP and an SPA fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osiris-web-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>app");
    const { app } = setup({ web: { dir } });
    const page = await app.request("/callback?code=x");
    expect(await page.text()).toBe("<!doctype html>app");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self';");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
  });
});
