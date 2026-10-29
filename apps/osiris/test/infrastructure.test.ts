import { describe, expect, it, vi } from "vitest";
import { QuestionStore } from "@osiris/core/agent/questions.ts";
import type { RunContext } from "@osiris/core/agent/context.ts";
import { cephReads, commandLine, infrastructureModule, kubectlReads } from "@osiris/tools-infrastructure";
import { cephTool, kubectlTool } from "@osiris/tools-infrastructure/ops.ts";
import { twinViewTool } from "@osiris/tools-infrastructure/twin.ts";
import { createTestRecords } from "./helpers.ts";

const ctx: RunContext = { thread_id: "t1", project_id: "twin", user_id: "bob", role: "admin", channel: "web", locale: "cs" };

describe("the infrastructure tools' reads and changes", () => {
  it("tell kubectl's reads from its changes", () => {
    for (const read of [["get", "pods", "-A"], ["describe", "node", "n1"], ["logs", "-n", "osiris", "control-0"], ["top", "nodes"], ["auth", "can-i", "list", "pods"], ["rollout", "status", "deploy/x"], ["apply", "-f", "-", "--dry-run=server"], ["get", "--raw", "/apis"]])
      expect(kubectlReads(read), read.join(" ")).toBe(true);
    for (const change of [["apply", "-f", "-"], ["delete", "pod", "x"], ["scale", "deploy/x", "--replicas=0"], ["rollout", "restart", "deploy/x"], ["drain", "n1"], ["exec", "x", "--", "rm", "-rf", "/"], ["cluster-info", "dump"], ["label", "node", "n1", "a=b"]])
      expect(kubectlReads(change), change.join(" ")).toBe(false);
  });

  it("tell ceph's reads from its changes (auth shows keys: a change)", () => {
    for (const read of [["status"], ["osd", "tree"], ["df", "detail"], ["osd", "pool", "ls", "detail"], ["health", "--format", "json"], ["config", "get", "osd", "osd_max_backfills"]]) expect(cephReads(read), read.join(" ")).toBe(true);
    for (const change of [["osd", "out", "7"], ["osd", "pool", "delete", "x", "x", "--yes-i-really-really-mean-it"], ["config", "set", "osd", "a", "b"], ["auth", "ls"], ["auth", "get", "client.admin"], ["mgr", "module", "enable", "x"]])
      expect(cephReads(change), change.join(" ")).toBe(false);
  });

  it("quote a command for people", () => expect(commandLine("kubectl", ["get", "pods", "-l", "app=x y"])).toBe("kubectl get pods -l 'app=x y'"));
});

describe("the kubectl and ceph tools", () => {
  const setup = () => {
    const calls: { url: string; body: { args: string[] } }[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ exitCode: 0, stdout: "NAME READY\nx 1/1\n", stderr: "", truncated: false });
    });
    const questions = new QuestionStore(createTestRecords());
    const client = { url: "http://twin:3004", token: async () => "projected", fetch: fetchFn as unknown as typeof fetch };
    return { calls, questions, kubectl: kubectlTool(client, questions), ceph: cephTool(client, questions) };
  };

  it("run a read at once", async () => {
    const { calls, kubectl } = setup();
    expect(await kubectl.invoke({ args: ["get", "pods"] }, { configurable: ctx })).toContain("x 1/1");
    expect(calls).toEqual([{ url: "http://twin:3004/ops/kubectl", body: { args: ["get", "pods"] } }]);
  });

  it("run a change only after the user's yes to exactly that command, never on the model's word", async () => {
    const { calls, questions, kubectl } = setup();
    const args = ["delete", "pod", "x", "-n", "osiris"];
    const asked = JSON.parse(String(await kubectl.invoke({ args }, { configurable: ctx }))) as { question: { id: string; fields: { label: string }[] } };
    expect(asked.question.fields[0]!.label).toBe("kubectl delete pod x -n osiris");
    // Called again before the answer: still waiting, nothing ran.
    expect(await kubectl.invoke({ args }, { configurable: ctx })).toMatch(/neodpověděl/);
    expect(calls).toHaveLength(0);
    const latest = (await questions.get("bob", "t1"))!;
    await questions.prepare("bob", "t1", `@osiris-answer:${JSON.stringify({ id: latest.id, values: { confirm: true } })}`);
    // A yes to `delete pod x` doesn't approve another command: that asks anew, nothing ran.
    expect(String(await kubectl.invoke({ args: ["delete", "pod", "y"] }, { configurable: ctx }))).toContain("question");
    expect(calls).toHaveLength(0);
    const second = (await questions.get("bob", "t1"))!;
    expect(second.fields[0]!.label).toBe("kubectl delete pod y");
    await questions.prepare("bob", "t1", `@osiris-answer:${JSON.stringify({ id: second.id, values: { confirm: true } })}`);
    expect(await kubectl.invoke({ args: ["delete", "pod", "y"] }, { configurable: ctx })).toContain("exit 0");
    expect(calls.map((c) => c.body.args)).toEqual([["delete", "pod", "y"]]);
    // The yes is used up: running it again asks again.
    expect(String(await kubectl.invoke({ args: ["delete", "pod", "y"] }, { configurable: ctx }))).toContain("question");
    expect(calls).toHaveLength(1);
  });

  it("don't run a change the user said no to", async () => {
    const { calls, questions, ceph } = setup();
    await ceph.invoke({ args: ["osd", "out", "7"] }, { configurable: ctx });
    const q = (await questions.get("bob", "t1"))!;
    await questions.prepare("bob", "t1", `@osiris-answer:${JSON.stringify({ id: q.id, values: { confirm: false } })}`);
    expect(await ceph.invoke({ args: ["osd", "out", "7"] }, { configurable: ctx })).toMatch(/zamítl/);
    expect(calls).toHaveLength(0);
  });
});

describe("the infrastructure module", () => {
  it("gives its tools only to the projects it names", () => {
    const m = infrastructureModule({ projects: ["twin"], ops: { url: "http://t", token: async () => "" } });
    const host = (projectId: string) => ({ projectId, questions: new QuestionStore(createTestRecords()) }) as never;
    expect(m.create(host("twin")).tools.map((t) => t.name)).toEqual(["kubectl", "ceph", "twin_view"]);
    expect(m.create(host("acme")).tools).toEqual([]);
  });

  it("carries the twin's steps to the PWA in the artifact", async () => {
    const out = await twinViewTool().invoke({ id: "c1", name: "twin_view", type: "tool_call", args: { actions: [{ action: "select", target: "osd.7" }, { action: "zoom", factor: 1.5 }] } });
    expect(out.artifact).toEqual({ twin: [{ action: "select", target: "osd.7" }, { action: "zoom", factor: 1.5 }] });
  });
});
