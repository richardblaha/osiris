import { describe, expect, it, vi } from "vitest";
import { QuestionStore } from "@osiris/core/agent/questions.ts";
import type { RunContext } from "@osiris/core/agent/context.ts";
import { cephReads, cephTool, cephModule } from "@osiris/tools-ceph";
import { createTestRecords } from "./helpers.ts";

const ctx: RunContext = { thread_id: "t1", project_id: "twin", user_id: "bob", role: "admin", channel: "web", locale: "cs" };

describe("the ceph tool's reads and changes", () => {
  it("tells ceph's reads from its changes (auth shows keys: a change)", () => {
    for (const read of [["status"], ["osd", "tree"], ["df", "detail"], ["osd", "pool", "ls", "detail"], ["health", "--format", "json"], ["config", "get", "osd", "osd_max_backfills"]]) expect(cephReads(read), read.join(" ")).toBe(true);
    for (const change of [["osd", "out", "7"], ["osd", "pool", "delete", "x", "x", "--yes-i-really-really-mean-it"], ["config", "set", "osd", "a", "b"], ["auth", "ls"], ["auth", "get", "client.admin"], ["mgr", "module", "enable", "x"]]) expect(cephReads(change), change.join(" ")).toBe(false);
  });
});

describe("the ceph tool", () => {
  const setup = () => {
    const calls: { url: string; body: { args: string[] } }[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ exitCode: 0, stdout: "", stderr: "", truncated: false });
    });
    const questions = new QuestionStore(createTestRecords());
    const client = { url: "http://twin:3004", token: async () => "projected", fetch: fetchFn as unknown as typeof fetch };
    return { calls, questions, ceph: cephTool(client, questions) };
  };

  it("doesn't run a change the user said no to", async () => {
    const { calls, questions, ceph } = setup();
    await ceph.invoke({ args: ["osd", "out", "7"] }, { configurable: ctx });
    const q = (await questions.get("bob", "t1"))!;
    await questions.prepare("bob", "t1", `@osiris-answer:${JSON.stringify({ id: q.id, values: { confirm: false } })}`);
    expect(await ceph.invoke({ args: ["osd", "out", "7"] }, { configurable: ctx })).toMatch(/zamítl/);
    expect(calls).toHaveLength(0);
  });
});

describe("the ceph module", () => {
  it("gives the ceph tool only to the projects it names", () => {
    const m = cephModule({ projects: ["twin"], ops: { url: "http://t", token: async () => "" } });
    const host = (projectId: string) => ({ projectId, questions: new QuestionStore(createTestRecords()) }) as never;
    expect(m.create(host("twin")).tools.map((t) => t.name)).toEqual(["ceph"]);
    expect(m.create(host("acme")).tools).toEqual([]);
  });
});
