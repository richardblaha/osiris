import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshToken, requestTokens, signInUrl, type OidcTokens } from "../src/oidc.ts";

const SERVER = "https://osiris.example.cz";
const discovery = (url: string): Response => {
  if (url === `${SERVER}/auth-config.json`) return Response.json({ issuer: "https://auth.example.cz" });
  if (url === "https://auth.example.cz/.well-known/openid-configuration") {
    return Response.json({ authorization_endpoint: "https://auth.example.cz/authorize", token_endpoint: "https://auth.example.cz/token" });
  }
  throw new Error(`unexpected fetch ${url}`);
};
const stubFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => vi.stubGlobal("fetch", vi.fn(handler));
afterEach(() => vi.unstubAllGlobals());

describe("signInUrl", () => {
  it("sends the S256 challenge of a fresh verifier and a random state", async () => {
    stubFetch(discovery);
    const a = await signInUrl(SERVER, "osiris-cli", "http://127.0.0.1:8080/callback");
    const b = await signInUrl(SERVER, "osiris-cli", "http://127.0.0.1:8080/callback");
    const url = new URL(a.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://auth.example.cz/authorize");
    expect(url.searchParams.get("client_id")).toBe("osiris-cli");
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(a.state).toBe(url.searchParams.get("state"));
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe("requestTokens", () => {
  it("posts the grant as a form and keeps the old refresh token when the server doesn't rotate it", async () => {
    let body = "";
    stubFetch(async (url, init = {}) => {
      if (url.includes("auth-config") || url.includes("openid-configuration")) return discovery(url);
      expect(url).toBe("https://auth.example.cz/token");
      body = String(init.body);
      return Response.json({ access_token: "at", expires_in: 1800 });
    });
    const t = await requestTokens(SERVER, "osiris-cli", { grant_type: "authorization_code", code: "c", code_verifier: "v" }, "old-refresh");
    expect(new URLSearchParams(body).get("code_verifier")).toBe("v");
    expect(t).toMatchObject({ accessToken: "at", refreshToken: "old-refresh" });
    expect(t.expiresAt).toBeGreaterThan(Date.now() + 1700_000);
  });

  it("fails with the server's error description", async () => {
    stubFetch((url) => (url.includes("auth-config") || url.includes("openid-configuration") ? discovery(url) : Response.json({ error: "invalid_grant", error_description: "Code expired" }, { status: 400 })));
    await expect(requestTokens(SERVER, "osiris-cli", { grant_type: "authorization_code", code: "x" })).rejects.toThrow("Code expired");
  });
});

describe("freshToken", () => {
  it("returns the access token while it is good for another minute", async () => {
    stubFetch(discovery);
    const good: OidcTokens = { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000 };
    expect(await freshToken(SERVER, "osiris-cli", good, () => {})).toBe("a");
  });

  it("refreshes an expiring token and saves the rotated one", async () => {
    stubFetch(async (url, init = {}) => {
      if (url.includes("auth-config") || url.includes("openid-configuration")) return discovery(url);
      expect(new URLSearchParams(String(init.body)).get("grant_type")).toBe("refresh_token");
      return Response.json({ access_token: "new", refresh_token: "r2", expires_in: 1800 });
    });
    let saved: OidcTokens | undefined;
    const expiring: OidcTokens = { accessToken: "old", refreshToken: "r", expiresAt: Date.now() + 30_000 };
    expect(await freshToken(SERVER, "osiris-cli", expiring, (t) => void (saved = t))).toBe("new");
    expect(saved?.refreshToken).toBe("r2");
  });

  it("gives up without tokens or when the refresh fails", async () => {
    expect(await freshToken(SERVER, "osiris-cli", undefined, () => {})).toBeUndefined();
    stubFetch((url) => (url.includes("auth-config") || url.includes("openid-configuration") ? discovery(url) : Response.json({ error: "invalid_grant" }, { status: 400 })));
    const expired: OidcTokens = { accessToken: "old", refreshToken: "r", expiresAt: Date.now() - 1 };
    expect(await freshToken(SERVER, "osiris-cli", expired, () => {})).toBeUndefined();
  });
});
