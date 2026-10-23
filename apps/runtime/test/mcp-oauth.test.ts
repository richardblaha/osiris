import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { McpOAuthStore } from "@osiris/core/mcp/oauth.ts";
import { McpServerStore } from "@osiris/core/mcp/store.ts";
import { McpToolset, type McpConnector } from "@osiris/core/mcp/toolset.ts";
import { SecretBox } from "@osiris/core/secrets.ts";
import { SecretVault } from "@osiris/core/vault/vault.ts";
import { allText, createTestRecords } from "./helpers.ts";

let server: Server | undefined;
afterEach(() => server?.close());

/** An MCP provider's OAuth side as vas-hosting.cz runs it: protected resource metadata, DCR, PKCE, tokens. */
async function fakeProvider() {
  const seen = { registered: 0, challenge: "", tokenRequests: [] as URLSearchParams[] };
  server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const path = new URL(req.url!, base).pathname;
      if (path.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (path === "/.well-known/oauth-authorization-server") {
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (path === "/register") {
        seen.registered++;
        return json(201, { ...JSON.parse(body), client_id: "client-1" });
      }
      if (path === "/token") {
        const form = new URLSearchParams(body);
        seen.tokenRequests.push(form);
        const verifier = form.get("code_verifier") ?? "";
        if (form.get("code") !== "the-code" || createHash("sha256").update(verifier).digest("base64url") !== seen.challenge) {
          return json(400, { error: "invalid_grant" });
        }
        return json(200, { access_token: "access-1", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1" });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("MCP servers signed in with OAuth", () => {
  it("registers, sends the user to the provider, exchanges the code with PKCE and connects with the token", async () => {
    const { base, seen } = await fakeProvider();
    const db = createTestRecords();
    const box = SecretBox.insecureDev();
    const store = new McpServerStore(db, box);
    let connectedWith: string | undefined;
    const connect: McpConnector = async ({ authProvider }) => {
      connectedWith = (await authProvider?.tokens())?.access_token;
      return { tools: [], close: async () => {} };
    };
    const mcp = new McpToolset(store, new SecretVault(db, box), new McpOAuthStore(db, box), {
      allowPrivate: true,
      connect,
      oauthRedirectUrl: "https://osiris.test/mcp-callback",
    });
    await store.put("vas-hosting", "", { url: `${base}/mcp`, enabled: true, auth: "oauth" });
    const config = (await store.get("vas-hosting", ""))!;

    // Not signed in: the server is skipped with a clear reason, without trying to connect.
    expect(await mcp.test(config, "")).toEqual({ ok: false, error: "Not signed in: sign in to the server in its settings." });
    expect(connectedWith).toBeUndefined();

    const url = new URL((await mcp.startSignIn(config, ""))!);
    expect(url.origin + url.pathname).toBe(`${base}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-1",
      response_type: "code",
      code_challenge_method: "S256",
      redirect_uri: "https://osiris.test/mcp-callback",
    });
    seen.challenge = url.searchParams.get("code_challenge")!;
    const state = url.searchParams.get("state")!;
    expect(await mcp.pendingSignIn(state)).toEqual({ owner: "", name: "vas-hosting" });

    await expect(mcp.finishSignIn(state, "wrong-code")).rejects.toThrow();
    expect(await mcp.finishSignIn(state, "the-code")).toEqual({ owner: "", name: "vas-hosting" });
    expect(seen.registered).toBe(1);
    expect(await mcp.signedIn("", "vas-hosting")).toBe(true);
    // The state works once, and the tokens are sealed in the database.
    expect(await mcp.pendingSignIn(state)).toBeUndefined();
    const stored = await allText(db);
    expect(stored).not.toContain("access-1");

    expect(await mcp.test(config, "")).toEqual({ ok: true, tools: [] });
    expect(connectedWith).toBe("access-1");

    // Deleting the server forgets the sign-in.
    await store.delete("vas-hosting", "");
    expect(await mcp.signedIn("", "vas-hosting")).toBe(false);
  });
});
