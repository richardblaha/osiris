import { describe, expect, it, vi } from "vitest";
import type { TwinEvent } from "@osiris/shared";
import { alertsApp } from "../src/alerts/app.ts";
import { devCaller } from "../src/alerts/caller.ts";
import { AlertEngine, fingerprintOf, memoryAlertStore, normalizeMessage, workloadOf, type Alert, type Investigator } from "../src/alerts/engine.ts";
import { alertPrompt, OsirisClient, osirisInvestigator } from "../src/alerts/osiris.ts";
import { alertsClient } from "../src/alerts-client.ts";

const event = (over: Partial<TwinEvent> = {}): TwinEvent => ({
  id: "1-0",
  ts: 1_000,
  severity: "ERROR",
  severityNumber: 17,
  message: "connection to 10.1.0.5:5432 refused after 3 retries",
  cluster: "busiris",
  namespace: "osiris",
  pod: "control-7d9f8c6b5-x2kqp",
  container: "control",
  ...over,
});

/** An investigator that starts at once and finishes when told. */
function fakeInvestigator() {
  const started: Alert[] = [];
  let finish: (o: { summary?: string; error?: string }) => void = () => {};
  const investigator: Investigator = {
    async start(alert) {
      started.push(alert);
      return { thread: `thread-${started.length}`, done: new Promise((r) => (finish = r)) };
    },
  };
  return { investigator, started, finish: (o: { summary?: string; error?: string }) => finish(o) };
}

describe("alerts from the collector's events", () => {
  it("tells a workload by its pod's name and a message's shape without what changes", () => {
    expect(workloadOf("control-7d9f8c6b5-x2kqp")).toBe("control");
    expect(workloadOf("node-agent-ab12c")).toBe("node-agent");
    expect(workloadOf("clickhouse-0")).toBe("clickhouse");
    expect(normalizeMessage("connection to 10.1.0.5:5432 refused after 3 retries")).toBe("connection to <ip> refused after # retries");
    expect(fingerprintOf(event({ pod: "control-7d9f8c6b5-abcde", message: "connection to 10.1.0.9:5432 refused after 5 retries" }))).toBe(fingerprintOf(event()));
  });

  it("makes one alert of repeats, investigates each new one once, and writes the outcome back", async () => {
    let now = 1_000;
    const store = memoryAlertStore(() => now);
    const fake = fakeInvestigator();
    const engine = new AlertEngine({ store, investigator: fake.investigator, minSeverity: "error", reopenMs: 60_000, maxPerHour: 5, now: () => now, newId: () => `a${fake.started.length + 1}` });
    expect(await engine.handle(event({ severity: "WARN", severityNumber: 13 }))).toBeUndefined();
    const first = await engine.handle(event());
    expect(first).toMatchObject({ id: "a1", thread: "thread-1", state: "investigating", count: 1, workload: "control" });
    now = 2_000;
    const repeat = await engine.handle(event({ ts: 2_000, severity: "FATAL", severityNumber: 21, message: "connection to 10.1.0.6:5432 refused after 4 retries" }));
    expect(repeat).toMatchObject({ id: "a1", count: 2, lastSeen: 2_000, severity: "FATAL" });
    expect(fake.started).toHaveLength(1);
    fake.finish({ summary: "Databáze neběží; restartujte ji." });
    await Promise.all(engine.pending);
    expect(await store.get("a1")).toMatchObject({ state: "answered", summary: "Databáze neběží; restartujte ji.", count: 2 });
    // After the reopen window the same problem is a new alert.
    now = 200_000;
    expect(await engine.handle(event({ ts: 200_000 }))).toMatchObject({ id: "a2", thread: "thread-2" });
  });

  it("keeps alerts over the hourly limit without a conversation, and a failed start as failed", async () => {
    const store = memoryAlertStore();
    const fake = fakeInvestigator();
    const engine = new AlertEngine({ store, investigator: fake.investigator, minSeverity: "error", reopenMs: 60_000, maxPerHour: 1, now: () => 1_000 });
    await engine.handle(event());
    const skipped = await engine.handle(event({ namespace: "other" }));
    expect(skipped?.state).toBe("skipped");
    expect(skipped?.thread).toBeUndefined();
    const broken = new AlertEngine({ store, investigator: { start: async () => Promise.reject(new Error("Osiris down")) }, minSeverity: "error", reopenMs: 60_000, maxPerHour: 5 });
    expect(await broken.handle(event({ namespace: "third" }))).toMatchObject({ state: "failed", error: "Osiris down" });
  });

  it("asks the agent to investigate and propose, never to change anything", () => {
    const prompt = alertPrompt({ ...event(), id: "a", fingerprint: "f", lastMessage: "", workload: "control", firstSeen: 0, lastSeen: 0, count: 1, state: "investigating", resolved: false });
    expect(prompt).toContain("namespace osiris");
    expect(prompt).toContain("connection to 10.1.0.5:5432 refused");
    expect(prompt).toContain("Nic neměň");
  });
});

describe("the alerts service and Osiris", () => {
  it("talks to Osiris as its service account: a client-credentials token, a new conversation, the run to its end", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const sse = ['data: {"type":"text-delta","delta":"Hledám…"}', 'data: {"type":"tool-call-start","toolCallId":"1","toolName":"kubectl"}', 'data: {"type":"text-delta","delta":"Pod "}', 'data: {"type":"text-delta","delta":"padá."}', 'data: {"type":"done"}', ""].join("\n\n");
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.endsWith("/token")) return Response.json({ access_token: "svc-token", expires_in: 600 });
      if (u.endsWith("/api/threads")) return Response.json({ id: "t1" }, { status: 201 });
      if (u.endsWith("/runs")) return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      return new Response("nope", { status: 404 });
    });
    const osiris = new OsirisClient({ url: "https://osiris.test", project: "twin", authUrl: "https://auth.test", clientId: "osiris-twin-alerts", clientSecret: "s".repeat(32), fetchFn: fetchFn as unknown as typeof fetch });
    const { thread, done } = await osiris.createThread().then(async (t) => ({ thread: t, done: osiris.run(t, "x") }));
    expect(thread).toBe("t1");
    expect(await done).toBe("Pod padá.");
    const token = calls.find((c) => c.url.endsWith("/token"))!;
    expect(String(token.init?.body)).toBe("grant_type=client_credentials");
    expect((token.init?.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from(`osiris-twin-alerts:${"s".repeat(32)}`).toString("base64")}`);
    // One token for every call while it is valid; each call names the project.
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
    expect((calls.find((c) => c.url.endsWith("/runs"))!.init?.headers as Record<string, string>)["x-project-id"]).toBe("twin");
    expect(osirisInvestigator).toBeTypeOf("function");
  });

  it("answers only the twin, an alert's conversation through the service, a cluster's alerts", async () => {
    const store = memoryAlertStore();
    const fake = fakeInvestigator();
    const engine = new AlertEngine({ store, investigator: fake.investigator, minSeverity: "error", reopenMs: 60_000, maxPerHour: 5, now: () => 1_000, newId: () => `a${fake.started.length + 1}` });
    await engine.handle(event());
    await engine.handle(event({ cluster: "other" }));
    const app = alertsApp({ store, caller: devCaller("twin-token-0123456789"), messages: async (thread) => [{ id: "m", role: "assistant", text: `answer of ${thread}` } as never], resolveMs: 60_000, now: () => 100_000 });
    expect((await app.request("/alerts")).status).toBe(401);
    expect((await app.request("/alerts", { headers: { authorization: "Bearer wrong-token-0123456789" } })).status).toBe(401);
    expect((await app.request("/healthz")).status).toBe(200);
    // The twin's API through its client.
    const client = alertsClient({ url: "http://alerts", token: "twin-token-0123456789", fetchFn: ((url: string, init: RequestInit) => app.request(new URL(url).pathname + new URL(url).search, init)) as unknown as typeof fetch });
    const list = await client.list("busiris", 10);
    expect(list.map((a) => a.id)).toEqual(["a1"]);
    expect(list[0]).not.toHaveProperty("fingerprint");
    // No event for longer than resolveMs: resolved.
    expect(list[0]!.resolved).toBe(true);
    expect(await client.messages("a1")).toEqual([{ id: "m", role: "assistant", text: "answer of thread-1" }]);
    expect(await client.get("nope")).toBeUndefined();
  });
});
