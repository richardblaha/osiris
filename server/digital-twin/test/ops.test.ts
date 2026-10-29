import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { devRuntimeVerifier } from "@osiris/platform/runtime-identity.ts";
import { createApp } from "../src/app.ts";
import { noCache } from "../src/cache.ts";
import { loadConfig } from "../src/config.ts";
import { checkCeph, checkKubectl, OpsRefused, run } from "../src/ops.ts";
import type { TwinSource } from "../src/twin.ts";
import { TwinStore } from "../src/store.ts";

describe("ops' checks", () => {
  it("let kubectl talk only as the twin's account, and nothing interactive", () => {
    expect(() => checkKubectl(["get", "pods", "-A", "-o", "wide"])).not.toThrow();
    expect(() => checkKubectl(["exec", "-n", "osiris", "control-0", "--", "ls"])).not.toThrow();
    for (const bad of [["get", "pods", "--kubeconfig=/x"], ["get", "pods", "--as", "admin"], ["get", "-s", "https://evil"], ["edit", "deploy/x"], ["port-forward", "svc/x", "80"], ["exec", "-it", "x", "--", "sh"], ["config", "view"]])
      expect(() => checkKubectl(bad), bad.join(" ")).toThrow(OpsRefused);
  });

  it("let ceph talk only as the configured admin", () => {
    expect(() => checkCeph(["osd", "tree", "--format", "json"])).not.toThrow();
    for (const bad of [["--name", "client.x", "status"], ["-c", "/x", "status"], ["--admin-daemon", "/run/x", "help"]]) expect(() => checkCeph(bad)).toThrow(OpsRefused);
  });

  it("run a program without a shell, with a time limit", async () => {
    expect(await run("echo", ["a; rm -rf /"])).toMatchObject({ exitCode: 0, stdout: "a; rm -rf /\n" });
    const slow = await run("sleep", ["5"], undefined, 200);
    expect(slow.exitCode).not.toBe(0);
    expect(slow.stderr).toContain("stopped");
  });
});

describe("the ops API and the Osiris proxy", async () => {
  const store = await TwinStore.open(join(tmpdir(), `twin-ops-${process.pid}-${Date.now()}.db`));
  const source: TwinSource = { name: "test", models: () => [], snapshot: async () => ({ twins: [], relationships: [] }) };
  const config = loadConfig({ NODE_ENV: "test", OSIRIS_URL: "https://osiris.example", OSIRIS_PROJECT: "twin" });
  const ca = join(tmpdir(), `ca-${process.pid}`);
  await writeFile(ca, "");
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => Response.json({ url, project: new Headers(init?.headers).get("x-project-id"), auth: new Headers(init?.headers).get("authorization") }));
  const app = createApp(config, {
    source,
    store,
    cache: noCache,
    fetchFn: fetchFn as unknown as typeof fetch,
    ops: { projects: ["twin"], identity: devRuntimeVerifier(), tools: { kubectl: { server: "https://k", tokenPath: "/nonexistent", caPath: ca } } },
  });
  const post = (path: string, token: string, body: unknown) => app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("answers only an allowed project's runtime", async () => {
    expect((await post("/ops/kubectl", "nonsense", { args: ["get", "pods"] })).status).toBe(401);
    expect((await post("/ops/kubectl", "dev-runtime:other", { args: ["get", "pods"] })).status).toBe(403);
    const refused = await post("/ops/kubectl", "dev-runtime:twin", { args: ["get", "pods", "--as=root"] });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { refused: string }).refused).toMatch(/--as/);
    expect((await post("/ops/ceph", "dev-runtime:twin", { args: ["status"] })).status).toBe(400);
  });

  it("passes the user's own Osiris calls on, to the twin's project", async () => {
    const res = await app.request("/osiris/api/threads?x=1", { headers: { authorization: "Bearer user-token" } });
    expect(await res.json()).toEqual({ url: "https://osiris.example/api/threads?x=1", project: "twin", auth: "Bearer user-token" });
  });
});
