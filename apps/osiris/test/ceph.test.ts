import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "@osiris/core/agent/context.ts";
import { cephReads, cephTool, cephModule } from "@osiris/tools-ceph";

const ctx: RunContext = { thread_id: "t1", project_id: "twin", user_id: "bob", role: "admin", channel: "web", locale: "cs" };

describe("the ceph tool's reads and changes", () => {
  it("tells ceph's reads from its changes (auth shows keys: a change)", () => {
    for (const read of [["status"], ["osd", "tree"], ["df", "detail"], ["osd", "pool", "ls", "detail"], ["health", "--format", "json"], ["config", "get", "osd", "osd_max_backfills"]]) expect(cephReads(read), read.join(" ")).toBe(true);
    for (const change of [["osd", "out", "7"], ["osd", "pool", "delete", "x", "x", "--yes-i-really-really-mean-it"], ["config", "set", "osd", "a", "b"], ["auth", "ls"], ["auth", "get", "client.admin"], ["mgr", "module", "enable", "x"]]) expect(cephReads(change), change.join(" ")).toBe(false);
  });
});

describe("the ceph tool", () => {
  it("runs reads and refuses changes without calling the twin", async () => {
    const calls: string[][] = [];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push((JSON.parse(String(init?.body)) as { args: string[] }).args);
      return Response.json({ exitCode: 0, stdout: "HEALTH_OK", stderr: "", truncated: false });
    });
    const ceph = cephTool({ url: "http://twin:3004", token: async () => "projected", fetch: fetchFn as unknown as typeof fetch });
    expect(await ceph.invoke({ args: ["status"] }, { configurable: ctx })).toContain("HEALTH_OK");
    expect(await ceph.invoke({ args: ["osd", "out", "7"] }, { configurable: ctx })).toMatch(/jen pro čtení/);
    expect(calls).toEqual([["status"]]);
  });
});

describe("the ceph module", () => {
  it("gives the ceph tool only to the projects it names", () => {
    const m = cephModule({ projects: ["twin"], ops: { url: "http://t", token: async () => "" } });
    const host = (projectId: string) => ({ projectId }) as never;
    expect(m.create(host("twin")).tools.map((t) => t.name)).toEqual(["ceph"]);
    expect(m.create(host("acme")).tools).toEqual([]);
  });
});
