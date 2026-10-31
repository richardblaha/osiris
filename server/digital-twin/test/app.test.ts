import type { AlertsClient } from "../src/alerts-client.ts";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@osiris/platform/http.ts";
import { devRuntimeVerifier } from "@osiris/platform/runtime-identity.ts";
import { createApp } from "../src/app.ts";
import { noCache } from "../src/cache.ts";
import { loadConfig } from "../src/config.ts";
import { Kube } from "../src/sources/kubernetes/kube.ts";
import { kubernetesSource } from "../src/sources/kubernetes/source.ts";
import { ClickHouse, Telemetry } from "../src/telemetry.ts";
import { devVerifier } from "../src/auth.ts";
import type { TokenVerifier } from "../src/auth.ts";
import type { Cache } from "../src/cache.ts";
import { interfaceErrors, relationshipErrors, twinErrors, type DigitalTwin, type DigitalTwinRelationship, type DtdlInterface, type DtdlModelData } from "@osiris/shared/dtdl.ts";
import type { TwinEvent } from "@osiris/shared";
import { TwinStore } from "../src/store.ts";
import { seedDashboards } from "../src/dashboards.ts";
import { Instances } from "../src/instances.ts";
import { memoryStateStore } from "../src/state.ts";
import { kubernetesType, type SourceType } from "../src/sources/registry.ts";
import { bootstrapInstance } from "../src/bootstrap.ts";
import { z } from "zod";

const config = loadConfig({ NODE_ENV: "test", AUTH_URL: "http://localhost:3003", CLICKHOUSE_URL: "http://ch", CLICKHOUSE_PASSWORD: "pw" });

/** A Kubernetes API that answers the twin's five questions from one pod and one namespace. */
const kubeFetch = vi.fn(async (url: string | URL | Request): Promise<Response> => {
  const path = new URL(String(url)).pathname;
  const items = (items: unknown[]) => Response.json({ items });
  if (path === "/api/v1/namespaces") return items([{ metadata: { name: "osiris" }, status: { phase: "Active" } }]);
  if (path === "/api/v1/pods")
    return items([
      {
        metadata: { name: "gateway-abc", namespace: "osiris", ownerReferences: [{ kind: "ReplicaSet", name: "gateway-rs", apiVersion: "apps/v1" }] },
        spec: {
          nodeName: "node1",
          volumes: [{ name: "data", persistentVolumeClaim: { claimName: "gateway-data" } }],
          containers: [{ name: "app", volumeMounts: [{ name: "data", mountPath: "/data" }] }],
        },
        status: { phase: "Running", podIP: "10.0.0.1", containerStatuses: [{ name: "app", ready: true, restartCount: 0, image: "osiris:main" }] },
      },
    ]);
  if (path === "/api/v1/persistentvolumeclaims")
    return items([{ metadata: { name: "gateway-data", namespace: "osiris" }, spec: { storageClassName: "local" }, status: { phase: "Bound", capacity: { storage: "1Gi" } } }]);
  if (path === "/api/v1/nodes") return items([{ metadata: { name: "node1" }, status: { nodeInfo: { kubeletVersion: "v1.33.0" } } }]);
  if (path === "/apis/apps/v1/replicasets")
    return items([{ metadata: { name: "gateway-rs", namespace: "osiris", ownerReferences: [{ kind: "Deployment", name: "gateway" }] } }]);
  if (path === "/version") return Response.json({ gitVersion: "v1.33.0" });
  return Response.json({}, { status: 404 });
});

/** ClickHouse answering one log record, or the pod's error count when the SQL counts errors. */
const chFetch = vi.fn(async (_url: unknown, init?: { body?: string }): Promise<Response> =>
  Response.json({
    data: init?.body?.includes("count() AS count")
      ? [{ k0: "osiris", k1: "gateway-abc", count: "3" }]
      : init?.body?.includes("AS latest")
        ? [{ k0: "osiris", k1: "gateway-data", latest: new URL(String(_url)).searchParams.get("param_metric") === "k8s.volume.capacity" ? "1000" : "250" }]
        : init?.body?.includes("countIf(")
        ? [{ t: "1730000000", error: "2", warn: "1", other: "7" }]
        : init?.body?.includes("AS rate")
        ? new URL(String(_url)).searchParams.get("param_metric") === "k8s.node.network.io"
          ? [{ k0: "node1", rate: "2048" }]
          : [{ k0: "osiris", k1: "gateway-abc", rate: "512.5" }]
        : [
          {
            ts: "1730000000000",
            severity: "ERROR",
            severityNumber: "17",
            service: "gateway",
            namespace: "osiris",
            pod: "gateway-abc",
            body: "boom",
            traceId: "0123456789abcdef0123456789abcdef",
            spanId: "0123456789abcdef",
            attributes: { k: "v" },
            resource: { "k8s.pod.name": "gateway-abc" },
          },
        ],
  }),
);

/** A cache that counts loads and misses on demand. */
function countingCache() {
  const loads: string[] = [];
  const store = new Map<string, unknown>();
  const cache: Cache = {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
      loads.push(key);
    },
  };
  return { loads, cache };
}

const source = kubernetesSource(new Kube({ apiServer: "https://kube", token: "t", fetchFn: kubeFetch }), "k8s");
const telemetry = new Telemetry(new ClickHouse("http://ch", "osiris", "pw", chFetch as unknown as typeof fetch));
/** A source type that hands out the test's Kubernetes source (and refuses a `broken` setting). */
const testType: SourceType = {
  id: "test",
  fields: [{ name: "token", kind: "text", secret: true }],
  settings: z.object({ broken: z.string().default("") }),
  async create({ settings }) {
    if (settings.broken) throw new Error("broken on purpose");
    return { source, telemetry };
  },
};
let store: TwinStore;
let state: ReturnType<typeof memoryStateStore>;
let instances: Instances;
beforeAll(async () => {
  store = await TwinStore.open(join(tmpdir(), `twin-app-${process.pid}-${Date.now()}.db`));
  state = memoryStateStore();
  await store.putInstance({ id: "k8s", name: "k8s", sourceType: "test", settings: {} }, 1);
  instances = new Instances({ store, state, defaults: { kube: { apiServer: "https://kube", tokenPath: "" } }, intervalMs: 1e9, types: { test: testType, kubernetes: kubernetesType } });
  await instances.start();
});

const app = (over: { verifier?: TokenVerifier; cache?: Cache; telemetry?: Telemetry | null; alerts?: AlertsClient } = {}) => {
  instances.get("k8s")!.telemetry = over.telemetry === null ? undefined : (over.telemetry ?? telemetry);
  return createApp(config, { instances, state, verifier: over.verifier ?? devVerifier(), cache: over.cache ?? noCache, alerts: over.alerts });
};

const json = async <T>(path: string) => {
  const res = await app().request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};

describe("the twin API, in the shape of Azure Digital Twins", () => {
  it("serves the models: valid DTDL v3 interfaces, the base Entity among them", async () => {
    const { value } = await json<{ value: DtdlModelData[] }>("/api/instances/k8s/models");
    expect(value.map((m) => m.id)).toContain("dtmi:osiris:twin:Entity;1");
    for (const m of value) {
      expect(interfaceErrors(m.model)).toEqual([]);
      expect(m.uploadTime).toMatch(/^\d{4}-/);
    }
    const pod = await json<DtdlModelData>(`/api/instances/k8s/models/${encodeURIComponent("dtmi:osiris:k8s:Pod;3")}`);
    expect(pod.model.extends).toBe("dtmi:osiris:twin:Entity;1");
  });

  it("serves the twins and relationships, every one valid against its model", async () => {
    const models = new Map((await json<{ value: DtdlModelData[] }>("/api/instances/k8s/models")).value.map((m): [string, DtdlInterface] => [m.id, m.model]));
    const { value: twins } = await json<{ value: DigitalTwin[] }>("/api/instances/k8s/digitaltwins");
    const { value: relationships } = await json<{ value: DigitalTwinRelationship[] }>("/api/instances/k8s/relationships");
    // cluster, node (and its card and router), namespace, workload, pod (and its eth0), container, volume claim
    expect(twins.length).toBe(10);
    for (const t of twins) expect(twinErrors(t, models)).toEqual([]);
    const byId = new Map(twins.map((t) => [t.$dtId, t]));
    for (const r of relationships) expect(relationshipErrors(r, byId, models)).toEqual([]);
    const pod = twins.find((t) => t.$metadata.$model === "dtmi:osiris:k8s:Pod;3")!;
    expect(pod).toMatchObject({ name: "gateway-abc", status: "ok", phase: "running", nodeName: "node1", restarts: 0, otelResource: { "k8s.pod.name": "gateway-abc" } });
    expect(pod.$etag).toMatch(/^W\//);
  });

  it("serves one twin, its relationships and the ones pointing at it", async () => {
    const id = "k8s:k8s/namespace/osiris/pod/gateway-abc";
    const pod = await json<DigitalTwin>(`/api/instances/k8s/digitaltwins/${encodeURIComponent(id)}`);
    expect(pod.$dtId).toBe(id);
    const out = await json<{ value: DigitalTwinRelationship[] }>(`/api/instances/k8s/digitaltwins/${encodeURIComponent(id)}/relationships`);
    // Its container, its claim and its eth0.
    expect(out.value.map((r) => r.$relationshipName).sort()).toEqual(["contains", "contains", "contains"]);
    const incoming = await json<{ value: { $sourceId: string; $relationshipName: string }[] }>(`/api/instances/k8s/digitaltwins/${encodeURIComponent(id)}/incomingrelationships`);
    expect(incoming.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ $relationshipName: "contains", $sourceId: "k8s:k8s/node/node1" }),
        expect.objectContaining({ $relationshipName: "hasPod", $sourceId: "k8s:k8s/namespace/osiris/workload-deployment/gateway" }),
      ]),
    );
    expect((await app().request(`/api/instances/k8s/digitaltwins/${encodeURIComponent("k8s:nope")}`)).status).toBe(404);
  });

  it("answers each twin's error logs from the telemetry: the pod's own", async () => {
    const { value } = await json<{ value: Record<string, number> }>("/api/instances/k8s/telemetry/errorLogs");
    expect(value).toEqual({ "k8s:k8s/namespace/osiris/pod/gateway-abc": 3 });
  });

  it("answers each node's and pod's network load from the kubeletstats counters", async () => {
    const { value } = await json<{ value: Record<string, number> }>("/api/instances/k8s/telemetry/network");
    expect(value).toEqual({ "k8s:k8s/node/node1": 2048, "k8s:k8s/namespace/osiris/pod/gateway-abc": 512.5 });
  });

  it("answers each volume claim's filesystem: its size and the bytes used", async () => {
    const { value } = await json<{ value: Record<string, unknown> }>("/api/instances/k8s/telemetry/storage");
    expect(value).toEqual({ "k8s:k8s/namespace/osiris/pvc/gateway-data": { used: 750, fsCapacity: 1000 } });
  });

  it("answers the history endpoints with 503 while the history is off", async () => {
    for (const path of ["/api/instances/k8s/history/range", "/api/instances/k8s/digitaltwins?at=1730000000000", `/api/instances/k8s/digitaltwins/${encodeURIComponent("k8s:k8s")}/history`]) {
      const res = await app().request(path);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe("errors.digitalTwin.historyOff");
    }
  });

  it("answers the logs page's query and caches it", async () => {
    const { cache, loads } = countingCache();
    const instance = app({ cache });
    const res = await instance.request("/api/instances/k8s/logs?namespace=osiris&pod=gateway-abc&severity=error");
    expect(res.status).toBe(200);
    const logs = (await res.json()) as { body: string; ts: number; severityNumber: number }[];
    expect(logs[0]).toMatchObject({ body: "boom", ts: 1730000000000, severityNumber: 17 });
    const calls = chFetch.mock.calls.length;
    await instance.request("/api/instances/k8s/logs?namespace=osiris&pod=gateway-abc&severity=error");
    expect(chFetch.mock.calls.length).toBe(calls);
    expect(loads.some((k) => k.startsWith("twin:k8s:") && k.includes(":logs:"))).toBe(true);
  });

  it("counts the logs over time by severity, for the logs page's bar chart", async () => {
    const out = await json<{ step: number; buckets: unknown[] }>("/api/instances/k8s/logs/histogram?pod=gateway-abc&from=1729996400000&to=1730000000000");
    expect(out.step).toBe(60);
    expect(out.buckets).toEqual([{ ts: 1730000000000, error: 2, warn: 1, other: 7 }]);
  });

  it("keeps each user's saved filters their own", async () => {
    // The token is the user.
    const users: TokenVerifier = { identify: async (token) => ({ sub: token, name: token, email: null, picture: null, groups: ["admin"] }) };
    const instance = app({ verifier: users });
    const as = (who: string, path: string, init: RequestInit = {}) =>
      instance.request(path, { ...init, headers: { authorization: `Bearer ${who}`, "content-type": "application/json", ...init.headers } });
    const put = await as("alice", "/api/instances/k8s/me/filters/errors-gw", { method: "PUT", body: JSON.stringify({ kind: "logs", name: "Gateway errors", filter: { pod: "gateway-abc", severity: "error" } }) });
    expect(put.status).toBe(200);
    const mine = (await (await as("alice", "/api/instances/k8s/me/filters?kind=logs")).json()) as { value: { id: string; name: string; filter: Record<string, string> }[] };
    expect(mine.value).toEqual([expect.objectContaining({ id: "errors-gw", name: "Gateway errors", filter: { pod: "gateway-abc", severity: "error" } })]);
    expect(((await (await as("bob", "/api/instances/k8s/me/filters?kind=logs")).json()) as { value: unknown[] }).value).toEqual([]);
    expect((await as("bob", "/api/instances/k8s/me/filters/errors-gw", { method: "DELETE" })).status).toBe(404);
    expect((await as("alice", "/api/instances/k8s/me/filters/x", { method: "PUT", body: JSON.stringify({ kind: "logs", name: "", filter: {} }) })).status).toBe(400);
    expect((await as("alice", "/api/instances/k8s/me/filters/errors-gw", { method: "DELETE" })).status).toBe(204);
    expect(((await (await as("alice", "/api/instances/k8s/me/filters?kind=logs")).json()) as { value: unknown[] }).value).toEqual([]);
  });

  it("keeps a twin's data connections (secrets write-only), checks models' bindings against them, runs profiles", async () => {
    const instance = app();
    const put = (path: string, body: unknown) => instance.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await put("/api/admin/instances/k8s/connections/plant", { name: "Plant", type: "mqtt", settings: { url: "mqtt://localhost:1883" } })).status).toBe(400);
    const saved = await put("/api/admin/instances/k8s/connections/plant", { name: "Plant", type: "mqtt", settings: { url: "mqtts://broker.plant.lan:8883", username: "twin" }, secrets: { password: "s3cret", notAField: "x" } });
    expect(saved.status).toBe(200);
    const list = await (await instance.request("/api/admin/instances/k8s/connections")).text();
    expect(list).toContain('"secretNames":["password"]');
    expect(list).not.toContain("s3cret");
    const model = {
      "@context": ["dtmi:dtdl:context;3", "dtmi:osiris:data;1"],
      "@id": "dtmi:test:Sensor;1",
      "@type": "Interface",
      contents: [{ "@type": "Telemetry", name: "temperature", schema: "double" }],
      dataProfiles: [{ name: "live", kind: "live", bindings: [{ telemetry: "temperature", connection: "plant", topic: "s/{name}", path: "v" }] }],
    };
    expect((await put("/api/instances/k8s/models/dtmi:test:Sensor;1", model)).status).toBe(200);
    // A binding the connector doesn't take, or to a connection that isn't there, is refused.
    const wrong = await put("/api/instances/k8s/models/dtmi:test:Sensor;1", { ...model, dataProfiles: [{ name: "live", kind: "live", bindings: [{ telemetry: "temperature", connection: "plant", topic: "s/#" }] }] });
    expect(wrong.status).toBe(400);
    const missing = await put("/api/instances/k8s/models/dtmi:test:Sensor;1", { ...model, dataProfiles: [{ name: "live", kind: "live", bindings: [{ telemetry: "temperature", connection: "nope", topic: "s" }] }] });
    expect(JSON.stringify(await missing.json())).toContain("connection nope doesn't exist");
    // A connection a profile reads stays.
    expect((await instance.request("/api/admin/instances/k8s/connections/plant", { method: "DELETE" })).status).toBe(409);
    const data = (await (await instance.request("/api/instances/k8s/data")).json()) as { active: string; profiles: { name: string; models: string[] }[] };
    expect(data.active).toBe("live");
    expect(data.profiles).toEqual([expect.objectContaining({ name: "live", kind: "live", models: ["dtmi:test:Sensor;1"] })]);
    expect((await put("/api/instances/k8s/data/profile", { profile: "simulation" })).status).toBe(200);
    expect(((await (await instance.request("/api/instances/k8s/data")).json()) as { active: string }).active).toBe("simulation");
    await put("/api/instances/k8s/data/profile", { profile: "live" });
    expect((await instance.request("/api/instances/k8s/models/dtmi:test:Sensor;1", { method: "DELETE" })).status).toBe(204);
    expect((await instance.request("/api/admin/instances/k8s/connections/plant", { method: "DELETE" })).status).toBe(204);
  });

  it("shows a twin its own cluster's alerts and their conversations, never another cluster's", async () => {
    const mine = { id: "a1", cluster: "k8s", message: "boom", thread: "t1" } as never;
    const theirs = { id: "a2", cluster: "elsewhere", message: "bang", thread: "t2" } as never;
    const asked: string[] = [];
    const alerts: AlertsClient = {
      list: async (cluster) => (asked.push(cluster), [mine]),
      get: async (id) => (id === "a1" ? mine : id === "a2" ? theirs : undefined),
      messages: async (id) => [{ id: "m", role: "assistant", text: `of ${id}` } as never],
    };
    const instance = app({ alerts });
    expect(((await (await instance.request("/api/instances/k8s/alerts")).json()) as { value: unknown[] }).value).toEqual([mine]);
    expect(asked).toEqual(["k8s"]);
    expect(await (await instance.request("/api/instances/k8s/alerts/a1/messages")).json()).toEqual([{ id: "m", role: "assistant", text: "of a1" }]);
    expect((await instance.request("/api/instances/k8s/alerts/a2/messages")).status).toBe(404);
    expect((await instance.request("/api/instances/k8s/alerts/nope/messages")).status).toBe(404);
    // Without the service: no alerts.
    expect(((await (await app().request("/api/instances/k8s/alerts")).json()) as { value: unknown[] }).value).toEqual([]);
  });

  it("keeps each user's preferences (the windows' layout) their own, across twins", async () => {
    const users: TokenVerifier = { identify: async (token) => ({ sub: token, name: token, email: null, picture: null, groups: ["admin"] }) };
    const instance = app({ verifier: users });
    const as = (who: string, path: string, init: RequestInit = {}) =>
      instance.request(path, { ...init, headers: { authorization: `Bearer ${who}`, "content-type": "application/json", ...init.headers } });
    const layout = { version: 1, groups: [{ id: "chat", tabs: ["chat"], active: "chat", rect: { x: 0, y: 0, w: 0.5, h: 1 }, z: 1 }], hidden: [] };
    expect(((await (await as("alice", "/api/me/preferences/layout")).json()) as { value: unknown }).value).toBeNull();
    expect((await as("alice", "/api/me/preferences/layout", { method: "PUT", body: JSON.stringify({ value: layout }) })).status).toBe(204);
    expect(((await (await as("alice", "/api/me/preferences/layout")).json()) as { value: unknown }).value).toEqual(layout);
    expect(((await (await as("bob", "/api/me/preferences/layout")).json()) as { value: unknown }).value).toBeNull();
    // Only known keys, and not too large.
    expect((await as("alice", "/api/me/preferences/other")).status).toBe(400);
    expect((await as("alice", "/api/me/preferences/layout", { method: "PUT", body: JSON.stringify({ value: "x".repeat(40_000) }) })).status).toBe(413);
  });

  it("keeps named dashboards everyone shares, their panels validated", async () => {
    const instance = app();
    const put = (id: string, body: unknown) => instance.request(`/api/instances/k8s/dashboards/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const ops = { name: "Provoz", range: 3_600_000, panels: [{ id: "p1", kind: "logBars", title: "Chyby", width: 4, filter: { severity: "error" } }] };
    expect((await put("ops", ops)).status).toBe(200);
    expect((await put("db", { ...ops, name: "Databáze", panels: [] })).status).toBe(200);
    const list = await json<{ value: { id: string; name: string }[] }>("/api/instances/k8s/dashboards");
    expect(list.value.map((d) => d.name)).toEqual(["Databáze", "Provoz"]);
    expect(await json("/api/instances/k8s/dashboards/ops")).toMatchObject({ name: "Provoz", panels: [{ kind: "logBars", filter: { severity: "error" } }], updatedBy: "dev" });
    expect((await put("bad", { ...ops, panels: [{ ...ops.panels[0], kind: "pie" }] })).status).toBe(400);
    expect((await instance.request("/api/instances/k8s/dashboards/db", { method: "DELETE" })).status).toBe(204);
    expect((await instance.request("/api/instances/k8s/dashboards/db")).status).toBe(404);
  });

  it("seeds the Osiris dashboard once: deleted, it stays deleted", async () => {
    const own = (await TwinStore.open(join(tmpdir(), `twin-seed-${process.pid}-${Date.now()}.db`))).of("x");
    await seedDashboards(own);
    expect((await own.dashboard("osiris"))?.panels.length).toBeGreaterThan(5);
    await own.deleteDashboard("osiris");
    await seedDashboards(own);
    expect(await own.dashboard("osiris")).toBeUndefined();
  });

  it("refuses a bad query", async () => {
    const res = await app().request("/api/instances/k8s/logs?limit=9999");
    expect(res.status).toBe(400);
  });
});


describe("the DTDL models are editable", () => {
  const custom = {
    "@context": ["dtmi:dtdl:context;3", "dtmi:osiris:presentation;1"],
    "@id": "dtmi:osiris:test:Custom;1",
    "@type": "Interface",
    displayName: { en: "Custom", cs: "Vlastní" },
    extends: "dtmi:osiris:twin:Entity;1",
    contents: [{ "@type": "Property", name: "level", schema: "integer" }],
    presentation: { look: "hex", label: "name", layer: "logical", color: "#ff00ff" },
  };

  it("lets an admin upsert a model with a presentation, and lists it", async () => {
    const res = await app().request(`/api/instances/k8s/models/${encodeURIComponent(custom["@id"])}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(custom),
    });
    expect(res.status).toBe(200);
    const { value } = await json<{ value: DtdlModelData[] }>("/api/instances/k8s/models");
    const saved = value.find((m) => m.id === custom["@id"])!;
    expect(saved.model.presentation).toEqual(custom.presentation);
    expect(interfaceErrors(saved.model)).toEqual([]);
  });

  it("refuses an invalid model (bad DTDL, bad presentation label) with its errors", async () => {
    const bad = { ...custom, contents: [] , presentation: { label: "nope" } };
    const res = await app().request(`/api/instances/k8s/models/${encodeURIComponent(custom["@id"])}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bad),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string[] }).detail.join()).toContain("nope");
    const notDtdl = await app().request(`/api/instances/k8s/models/${encodeURIComponent("dtmi:bad;1")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "@context": "x", "@id": "dtmi:bad;1", "@type": "Interface" }),
    });
    expect(notDtdl.status).toBe(400);
  });

  it("refuses to delete a model a twin instantiates; deletes a custom one", async () => {
    const inUse = await app().request(`/api/instances/k8s/models/${encodeURIComponent("dtmi:osiris:k8s:Pod;3")}`, { method: "DELETE" });
    expect(inUse.status).toBe(409);
    const gone = await app().request(`/api/instances/k8s/models/${encodeURIComponent(custom["@id"])}`, { method: "DELETE" });
    expect(gone.status).toBe(204);
    const { value } = await json<{ value: DtdlModelData[] }>("/api/instances/k8s/models");
    expect(value.some((m) => m.id === custom["@id"])).toBe(false);
  });

  it("keeps the source's models when an admin edited one (the sync never overwrites it)", async () => {
    const edited = { ...custom, displayName: { en: "Edited", cs: "Upraveno" } };
    await app().request(`/api/instances/k8s/models/${encodeURIComponent(custom["@id"])}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(edited),
    });
    const data = instances.get("k8s")!.data;
    await data.putModels(source.models(), 5); // the sync's write of the source's models
    const models = await data.models();
    expect(models.find((m) => m.id === custom["@id"])?.model.displayName).toEqual({ en: "Edited", cs: "Upraveno" });
    // A source model nobody edited is refreshed by the sync as before.
    expect(models.some((m) => m.id === "dtmi:osiris:k8s:Pod;3")).toBe(true);
    await data.deleteModel(custom["@id"]);
  });
});

describe("the collector's events", () => {
  it("serves the warn/error events from the stream, filtered by cluster and severity", async () => {
    state.addEvent({ ts: "1000", severity: "WARN", severity_number: "13", message: "slow", cluster: "busiris", service: "gateway", pod: "gateway-abc", namespace: "osiris", trace_id: "0123456789abcdef0123456789abcdef" });
    state.addEvent({ ts: "2000", severity: "ERROR", severity_number: "17", message: "boom", cluster: "busiris", service: "gateway", pod: "gateway-abc", namespace: "osiris" });
    state.addEvent({ ts: "3000", severity: "ERROR", severity_number: "17", message: "other cluster", cluster: "other" });
    const { value } = await json<{ value: TwinEvent[] }>("/api/instances/k8s/events");
    expect(value.map((e) => e.message)).toEqual(["other cluster", "boom", "slow"]);
    const errors = await json<{ value: TwinEvent[] }>("/api/instances/k8s/events?severity=error");
    expect(errors.value.map((e) => e.message)).toEqual(["other cluster", "boom"]);
    const ours = await json<{ value: TwinEvent[] }>("/api/instances/k8s/events?cluster=busiris&limit=1");
    expect(ours.value).toEqual([expect.objectContaining({ message: "boom", pod: "gateway-abc", namespace: "osiris" })]);
    const one = await json<{ value: TwinEvent[] }>("/api/instances/k8s/events?limit=1");
    expect(one.value[0]).toMatchObject({ severity: "ERROR", severityNumber: 17, cluster: "other", ts: 3000 });
  });
});

describe("the PWA's static files", () => {
  const dir = join(tmpdir(), "twin-static");
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.html"), "<html><body>twin index</body></html>");
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets", "app.js"), "console.log('twin')");
  });
  afterAll(() => void rm(dir, { recursive: true, force: true }));

  it("serves the app's files, and the index.html for every other path", async () => {
    const instance = createApp(config, { instances, state, verifier: devVerifier(), cache: noCache, staticDir: dir });
    const asset = await instance.request("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toContain("console.log");
    for (const path of ["/", "/logs", "/callback"]) {
      const page = await instance.request(path);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("twin index"); // the fallback, not a missing file
      // The PWA signs in from the browser: its discovery and code redemption go to osiris-auth's origin.
      expect(page.headers.get("content-security-policy")).toContain("connect-src 'self' http://localhost:3003;");
    }
    const svg = await instance.request("/favicon.svg");
    expect(await svg.text()).toContain("twin index"); // a missing file is also the index.html
  });
});

describe("sign-in", () => {
  const refuse: TokenVerifier = {
    async identify() {
      throw new Error("no");
    },
  };
  const allow: TokenVerifier = {
    async identify(token: string) {
      if (token !== "good") throw new ServiceError("bad token", 401);
      return { sub: "u", name: "User", email: null, picture: "https://auth.example/pictures/u/1", groups: ["admin"] };
    },
  };

  it("answers only with a bearer token when a verifier is set", async () => {
    const instance = app({ verifier: allow });
    expect((await instance.request("/api/instances/k8s/digitaltwins")).status).toBe(401);
    expect((await instance.request("/api/instances/k8s/digitaltwins", { headers: { authorization: "Bearer bad" } })).status).toBe(401);
    expect((await instance.request("/api/instances/k8s/digitaltwins", { headers: { authorization: "Bearer good" } })).status).toBe(200);
    const me = await instance.request("/api/me", { headers: { authorization: "Bearer good" } });
    expect(me.status).toBe(200);
    // The avatar: osiris-auth's picture, as its introspection names it.
    expect(((await me.json()) as { picture: string }).picture).toBe("https://auth.example/pictures/u/1");
  });

  it("the public auth config is readable without signing in, the API is not", async () => {
    const instance = app({ verifier: refuse });
    expect((await instance.request("/auth-config.json")).status).toBe(200);
    expect((await instance.request("/api/instances/k8s/models")).status).toBe(401);
  });

  it("tells the PWA where osiris-auth is", async () => {
    const res = await app().request("/auth-config.json");
    expect(await res.json()).toEqual({ issuer: "http://localhost:3003", clientId: "digital-twin" });
  });
});

describe("instances", () => {
  const as = (groups: string[]): TokenVerifier => ({ async identify() { return { sub: "u", name: "U", email: null, picture: null, groups }; } });
  const call = (a: ReturnType<typeof app>, path: string, init: RequestInit = {}) =>
    a.request(path, { ...init, headers: { authorization: "Bearer t", "content-type": "application/json", ...(init.headers ?? {}) } });

  it("shows a twin only to admins and its group's members", async () => {
    const member = app({ verifier: as(["twin:k8s"]) });
    expect(((await (await call(member, "/api/instances")).json()) as { value: { id: string }[] }).value.map((i) => i.id)).toEqual(["k8s"]);
    expect((await call(member, "/api/instances/k8s/digitaltwins")).status).toBe(200);
    expect(((await (await call(member, "/api/me")).json()) as { admin: boolean }).admin).toBe(false);
    const other = app({ verifier: as(["twin:else"]) });
    expect(((await (await call(other, "/api/instances")).json()) as { value: unknown[] }).value).toEqual([]);
    expect((await call(other, "/api/instances/k8s/digitaltwins")).status).toBe(404);
    // Only admins manage instances.
    expect((await call(member, "/api/admin/instances")).status).toBe(403);
    expect((await call(member, "/api/source-types")).status).toBe(403);
    expect((await call(member, "/api/admin/instances/x", { method: "PUT", body: JSON.stringify({ name: "X", sourceType: "test" }) })).status).toBe(403);
  });

  it("lets admins create, change and delete twins, their secrets write-only", async () => {
    const admin = app();
    const types = (await (await call(admin, "/api/source-types")).json()) as { value: { id: string; fields: { name: string; secret?: boolean }[] }[] };
    expect(types.value.find((t) => t.id === "kubernetes")!.fields.find((f) => f.name === "kubeconfig")).toMatchObject({ secret: true });

    const put = (id: string, body: unknown) => call(admin, `/api/admin/instances/${id}`, { method: "PUT", body: JSON.stringify(body) });
    const made = await put("lab", { name: "Lab", sourceType: "test", settings: {}, secrets: { token: "s3cret", unknown: "x" } });
    expect(made.status).toBe(200);
    const record = (await made.json()) as { secretNames: string[]; error: string | null };
    expect(record).toMatchObject({ secretNames: ["token"], error: null });
    expect(JSON.stringify(await (await call(admin, "/api/admin/instances")).json())).not.toContain("s3cret");
    expect((await call(admin, "/api/instances/lab/digitaltwins")).status).toBe(200);
    // A source that can't start: the instance stays, with the reason.
    expect(((await (await put("lab", { name: "Lab", sourceType: "test", settings: { broken: "y" } })).json()) as { error: string }).error).toMatch(/broken/);
    expect(await store.secrets("lab")).toEqual({ token: "s3cret" });
    // Bad input: an unknown type, a bad id, bad settings.
    expect((await put("lab", { name: "Lab", sourceType: "fax" })).status).toBe(400);
    expect((await put("Bad_Id", { name: "x", sourceType: "test" })).status).toBe(400);
    expect((await put("k", { name: "x", sourceType: "kubernetes", settings: { connection: "ssh" } })).status).toBe(400);
    expect((await call(admin, "/api/admin/instances/lab", { method: "DELETE" })).status).toBe(204);
    expect((await call(admin, "/api/instances/lab/digitaltwins")).status).toBe(404);
    expect(await store.instance("lab")).toBeUndefined();
  });

  it("makes the first twin from the service's settings once, with the one twin's dashboards", async () => {
    const own = await TwinStore.open(join(tmpdir(), `twin-boot-${process.pid}-${Date.now()}.db`));
    const cfg = loadConfig({ NODE_ENV: "test", CLUSTER_NAME: "busiris", CLICKHOUSE_CLUSTER: "busiris", CEPH_MANAGERS: "http://a:9283/metrics" });
    await bootstrapInstance(own, cfg, 5);
    expect(await own.instances()).toEqual([
      expect.objectContaining({ id: "busiris", sourceType: "kubernetes", settings: expect.objectContaining({ connection: "inCluster", clickhouseCluster: "busiris", cephManagers: "http://a:9283/metrics" }) }),
    ]);
    expect(await own.of("busiris").dashboard("osiris")).toBeDefined();
    await own.deleteInstance("busiris");
    await bootstrapInstance(own, cfg, 6);
    expect(await own.instances()).toEqual([]);
  });
});

describe("the twin for Osiris's agent (ops)", () => {
  const ops = () => createApp(config, { instances, state, verifier: devVerifier(), cache: noCache, ops: { projects: ["twin"], identity: devRuntimeVerifier(), tools: {} } });
  const get = async <T>(path: string, token = "dev-runtime:twin") => {
    const res = await ops().request(path, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json()) as T };
  };

  it("reads the twins, their models and objects with the runtime's token, read-only", async () => {
    expect((await get("/ops/twin/instances", "nonsense")).status).toBe(401);
    expect((await get("/ops/twin/instances", "dev-runtime:acme")).status).toBe(403);
    expect((await get<{ value: { id: string }[] }>("/ops/twin/instances")).body.value.map((i) => i.id)).toContain("k8s");
    const models = (await get<{ value: { id: string; contents: string[] }[] }>("/ops/twin/models?instance=k8s")).body.value;
    expect(models.some((m) => m.id.startsWith("dtmi:osiris:k8s:Pod;"))).toBe(true);
    const found = (await get<{ total: number; value: { $dtId: string; model: string }[] }>("/ops/twin/digitaltwins?instance=k8s&q=gateway-abc&model=dtmi:osiris:k8s:Pod")).body;
    expect(found.total).toBe(1);
    const pod = found.value[0]!;
    const detail = (await get<{ twin: DigitalTwin; relationships: { name: string; target: string }[]; incoming: { name: string; source: string }[] }>(`/ops/twin/digitaltwins/${encodeURIComponent(pod.$dtId)}?instance=k8s`)).body;
    expect(detail.twin.$dtId).toBe(pod.$dtId);
    expect(detail.relationships.length + detail.incoming.length).toBeGreaterThan(0);
    expect((await get(`/ops/twin/digitaltwins/${encodeURIComponent("k8s:nope")}`)).status).toBe(404);
    // Nothing under /ops/twin changes the twin.
    expect((await ops().request("/ops/twin/models", { method: "POST", headers: { authorization: "Bearer dev-runtime:twin" }, body: "[]" })).status).toBe(404);
  });
});
