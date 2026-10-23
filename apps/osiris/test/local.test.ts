import { describe, expect, it } from "vitest";
import { createRuntimeApp } from "../src/app.ts";
import { Activity } from "../src/activity.ts";
import { LocalFeatures } from "../src/local.ts";
import { createTestProjects } from "./helpers.ts";

describe("the agent in local mode", () => {
  it("lets in only its own token, answers who and which project, and refuses the server's parts", async () => {
    const project = await createTestProjects().projects.get("moje");
    const user = { sub: "local:bob", name: "Bob", email: null, phone: null, picture: null };
    const app = createRuntimeApp({ project, local: { token: "tajny-token", user, name: "Moje" }, activity: new Activity(), snapshot: async () => ({ key: "", bytes: 0 }) });
    const call = (path: string, token?: string, init: RequestInit = {}) =>
      app.request(path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", origin: "vscode-webview://x" } });

    expect((await call("/api/me")).status).toBe(401);
    expect((await call("/api/me", "tajny-tokeN")).status).toBe(401);
    const me = await call("/api/me", "tajny-token");
    expect(me.headers.get("access-control-allow-origin")).toBe("vscode-webview://x");
    expect(await me.json()).toEqual({ user: { id: "local:bob", email: null, name: "Bob", phone: null, picture: null }, systemAdmin: false, projects: [{ id: "moje", name: "Moje", role: "admin", logo: null }], mode: "local" });
    // The user is the project's admin: they change the project's knowledge.
    expect((await call("/api/knowledge/documents", "tajny-token", { method: "POST", body: JSON.stringify({ title: "Ceník", content: "x", scope: "project" }) })).status).toBe(201);
    expect(await (await call("/api/members", "tajny-token")).json()).toMatchObject({ code: "errors.local.serverOnly" });
    // No public chat and no calls of the server's services.
    expect((await call("/public/web/info")).status).toBe(404);
    expect((await call("/internal/activity")).status).toBe(404);
  });

  it("has every feature but those needing a server, and no quotas", async () => {
    const on = await new LocalFeatures().get();
    expect(on.knowledge && on.files && on.mcp && on.memory).toBe(true);
    expect(on.whatsapp || on.scheduler || on.public).toBe(false);
  });
});
