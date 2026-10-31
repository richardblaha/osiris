import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "@osiris/core/agent/context.ts";
import { commandLine } from "@osiris/tools-ops";
import { kubectlReads, kubectlTool, kubernetesModule } from "@osiris/tools-kubernetes";

const ctx: RunContext = { thread_id: "t1", project_id: "twin", user_id: "bob", role: "admin", channel: "web", locale: "cs" };

describe("the kubectl tool's reads and changes", () => {
  it("tells kubectl's reads from its changes", () => {
    for (const read of [["get", "pods", "-A"], ["describe", "node", "n1"], ["logs", "-n", "osiris", "control-0"], ["top", "nodes"], ["auth", "can-i", "list", "pods"], ["rollout", "status", "deploy/x"], ["apply", "-f", "-", "--dry-run=server"], ["get", "--raw", "/apis"]])
      expect(kubectlReads(read), read.join(" ")).toBe(true);
    for (const change of [["apply", "-f", "-"], ["delete", "pod", "x"], ["scale", "deploy/x", "--replicas=0"], ["rollout", "restart", "deploy/x"], ["drain", "n1"], ["exec", "x", "--", "rm", "-rf", "/"], ["cluster-info", "dump"], ["label", "node", "n1", "a=b"]])
      expect(kubectlReads(change), change.join(" ")).toBe(false);
  });

  it("quotes a command for people", () => expect(commandLine("kubectl", ["get", "pods", "-l", "app=x y"])).toBe("kubectl get pods -l 'app=x y'"));
});

describe("the kubectl tool", () => {
  const setup = () => {
    const calls: { url: string; body: { args: string[] } }[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ exitCode: 0, stdout: "NAME READY\nx 1/1\n", stderr: "", truncated: false });
    });
    const client = { url: "http://twin:3004", token: async () => "projected", fetch: fetchFn as unknown as typeof fetch };
    return { calls, kubectl: kubectlTool(client) };
  };

  it("runs a read at once", async () => {
    const { calls, kubectl } = setup();
    expect(await kubectl.invoke({ args: ["get", "pods"] }, { configurable: ctx })).toContain("x 1/1");
    expect(calls).toEqual([{ url: "http://twin:3004/ops/kubectl", body: { args: ["get", "pods"] } }]);
  });

  it("refuses every change without asking or calling the twin: the access is read-only", async () => {
    const { calls, kubectl } = setup();
    for (const args of [["delete", "pod", "x", "-n", "osiris"], ["apply", "-f", "-"], ["exec", "x", "--", "ls"], ["rollout", "restart", "deploy/x"]]) {
      const answer = String(await kubectl.invoke({ args }, { configurable: ctx }));
      expect(answer).toMatch(/jen pro čtení/);
      expect(answer).not.toContain("question");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("the kubernetes module", () => {
  it("gives the kubectl tool only to the projects it names", () => {
    const m = kubernetesModule({ projects: ["twin"], ops: { url: "http://t", token: async () => "" } });
    const host = (projectId: string) => ({ projectId }) as never;
    expect(m.create(host("twin")).tools.map((t) => t.name)).toEqual(["kubectl"]);
    expect(m.create(host("acme")).tools).toEqual([]);
  });
});
