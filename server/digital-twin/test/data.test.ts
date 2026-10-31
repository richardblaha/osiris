import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DATA_CONTEXT, dataProfileErrors, dataProfilesOf, interfaceErrors, type DtdlInterface } from "@osiris/shared/dtdl.ts";
import { bindingErrors, CONNECTOR_TYPES } from "../src/data/connectors.ts";
import { DataHub, memoryDataValues } from "../src/data/hub.ts";
import { fill, MissingVariable, pick, safeHost, segment, varsOf } from "../src/data/template.ts";
import { memoryStateStore } from "../src/state.ts";
import { TwinStore } from "../src/store.ts";

const pump: DtdlInterface = {
  "@context": ["dtmi:dtdl:context;3", DATA_CONTEXT],
  "@id": "dtmi:plant:Pump;1",
  "@type": "Interface",
  contents: [
    { "@type": "Telemetry", name: "temperature", schema: "double" },
    { "@type": "Property", name: "line", schema: "string" },
  ],
  dataProfiles: [
    { name: "live", kind: "live", bindings: [{ telemetry: "temperature", connection: "plant", topic: "plant/{twin.line}/{name}/temp", path: "$.value" }] },
    { name: "simulation", kind: "simulation", bindings: [{ telemetry: "temperature", connection: "gen", pattern: "sine", min: 20, max: 80, periodSeconds: 60 }], simulator: { connection: "sim", scenario: { pumps: 3 } } },
  ],
};

describe("data profiles in DTDL", () => {
  it("checks the profiles' shape and that each binding fills one of the model's contents", () => {
    expect(interfaceErrors(pump)).toEqual([]);
    expect(interfaceErrors({ ...pump, "@context": "dtmi:dtdl:context;3" })).toContain(`dtmi:plant:Pump;1: dataProfiles needs ${DATA_CONTEXT} in @context`);
    const bad = interfaceErrors({
      ...pump,
      dataProfiles: [
        { name: "Live!", kind: "live", bindings: [] },
        { name: "x", kind: "live", bindings: [{ telemetry: "t", connection: "c", every: 1 }], simulator: { connection: "s" } },
      ],
    });
    expect(bad.join("\n")).toMatch(/name must be a short id/);
    expect(bad.join("\n")).toMatch(/every must be 5 to 86400/);
    expect(bad.join("\n")).toMatch(/simulator belongs to a simulation profile only/);
    const models = new Map([[pump["@id"], { ...pump, dataProfiles: [{ name: "live", kind: "live" as const, bindings: [{ telemetry: "pressure", connection: "plant" }] }] }]]);
    expect(dataProfileErrors(pump["@id"], models)).toEqual(["dtmi:plant:Pump;1: profile live fills pressure, which is no Telemetry or Property of the model"]);
  });

  it("inherits profiles over extends, a profile of the same name replacing the base's", () => {
    const special: DtdlInterface = { "@context": ["dtmi:dtdl:context;3", DATA_CONTEXT], "@id": "dtmi:plant:BigPump;1", "@type": "Interface", extends: pump["@id"], dataProfiles: [{ name: "live", kind: "live", bindings: [] }] };
    const models = new Map([
      [pump["@id"], pump],
      [special["@id"], special],
    ]);
    const profiles = dataProfilesOf(special["@id"], models);
    expect(profiles.map((p) => [p.name, p.bindings.length])).toEqual([
      ["simulation", 1],
      ["live", 0],
    ]);
  });
});

describe("filling a binding for a twin", () => {
  const twin = { $dtId: "pump-1", $metadata: { $model: pump["@id"] }, name: "P1", line: "A", otelResource: { "service.name": "pumps" } };

  it("fills placeholders from the twin, and refuses what can't stand in a topic or a host", () => {
    const vars = varsOf(twin);
    expect(fill("plant/{twin.line}/{name}/{otel.service.name}", vars, segment)).toBe("plant/A/P1/pumps");
    expect(() => fill("{twin.missing}", vars)).toThrow(MissingVariable);
    // A value can't add a level or a wildcard to a topic.
    expect(() => fill("plant/{name}", { ...vars, name: "a/#" }, segment)).toThrow(MissingVariable);
    expect(pick({ a: { b: [{ c: "21.5" }] } }, "$.a.b[0].c")).toBe(21.5);
    expect(pick({ ok: true }, "ok")).toBe(true);
    expect(pick({ o: {} }, "o")).toBeUndefined();
    for (const host of ["localhost", "127.0.0.1", "169.254.169.254", "::1", "[::1]"]) expect(safeHost(host), host).toBe(false);
    expect(safeHost("broker.plant.lan")).toBe(true);
  });
});

describe("connectors", () => {
  it("asks ClickHouse read-only with the twin's values as typed parameters, never in the SQL", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response('{"value":42.5}\n');
    });
    const ch = CONNECTOR_TYPES.clickhouse!.create({ url: "http://ch:8123", user: "reader", database: "otel" }, { password: "pw" }, { fetchFn: fetchFn as unknown as typeof fetch });
    const binding = CONNECTOR_TYPES.clickhouse!.binding.parse({ telemetry: "t", connection: "ch", query: "SELECT avg(v) AS value FROM m WHERE pod = {pod:String}", params: { pod: "{name}" } });
    expect(await ch.poll!(binding as never, { id: "x", name: "p'); DROP TABLE m; --" })).toBe(42.5);
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("param_pod")).toBe("p'); DROP TABLE m; --");
    expect(u.searchParams.get("readonly")).toBe("1");
    expect(calls[0]!.body).toBe("SELECT avg(v) AS value FROM m WHERE pod = {pod:String}");
    // One SELECT only, and only reachable hosts.
    expect(bindingErrors({ telemetry: "t", connection: "ch", query: "SELECT 1; DROP TABLE m" }, CONNECTOR_TYPES.clickhouse).length).toBeGreaterThan(0);
    expect(bindingErrors({ telemetry: "t", connection: "ch", query: "INSERT INTO m VALUES (1)" }, CONNECTOR_TYPES.clickhouse).length).toBeGreaterThan(0);
    expect(CONNECTOR_TYPES.clickhouse!.settings.safeParse({ url: "http://localhost:8123" }).success).toBe(false);
    expect(CONNECTOR_TYPES.mqtt!.settings.safeParse({ url: "mqtt://169.254.169.254" }).success).toBe(false);
    expect(bindingErrors({ telemetry: "t", connection: "m", topic: "plant/#" }, CONNECTOR_TYPES.mqtt).length).toBeGreaterThan(0);
    expect(bindingErrors({ telemetry: "t", connection: "s" }, CONNECTOR_TYPES["kubernetes-simulation"])).toEqual(["connection s is a simulator, not a data source"]);
  });

  it("quotes a twin's value inside a PromQL label so it can't end the string", async () => {
    let asked = "";
    const fetchFn = vi.fn(async (url: unknown) => {
      asked = new URL(String(url)).searchParams.get("query")!;
      return Response.json({ data: { result: [{ value: [0, "3"] }] } });
    });
    const prom = CONNECTOR_TYPES.prometheus!.create({ url: "http://prom:9090" }, {}, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(await prom.poll!({ telemetry: "t", connection: "p", query: 'up{pod="{name}"}' }, { id: "x", name: 'a"}) or vector(1) #' })).toBe(3);
    expect(asked).toBe('up{pod="a\\"}) or vector(1) #"}');
  });

  it("generates simulation values by a pattern, different per twin, inside their range", async () => {
    let now = 0;
    const gen = CONNECTOR_TYPES.generator!.create({}, {}, { now: () => now });
    const binding = CONNECTOR_TYPES.generator!.binding.parse({ telemetry: "t", connection: "g", pattern: "sine", min: 20, max: 80, periodSeconds: 60 }) as never;
    const a = (await gen.poll!(binding, { id: "a" })) as number;
    const b = (await gen.poll!(binding, { id: "b" })) as number;
    expect(a).not.toBe(b);
    for (const v of [a, b]) expect(v >= 20 && v <= 80).toBe(true);
    now = 15_000;
    expect(await gen.poll!(binding, { id: "a" })).not.toBe(a);
  });
});

describe("the data hub", () => {
  it("runs the active profile: its bindings for each twin of the model, values written, switching profiles", async () => {
    const store = await TwinStore.open(join(tmpdir(), `twin-data-${process.pid}-${Date.now()}.db`));
    await store.putInstance({ id: "plant", name: "Plant", sourceType: "test", settings: {} }, 1);
    const data = store.of("plant");
    await data.putModel(pump, 1);
    await store.putConnection("plant", { id: "gen", name: "Generator", type: "generator", settings: {} }, 1);
    await store.putConnection("plant", { id: "sim", name: "Simulated k8s", type: "kubernetes-simulation", settings: { server: "https://kwok:6443" }, secrets: { token: "t" } }, 1);
    const state = memoryStateStore();
    const twins = ["p1", "p2"].map((id) => ({ $dtId: id, $metadata: { $model: pump["@id"] }, name: id, line: "A" }));
    await state.writeSnapshot("plant", twins, [], { errorLogs: {}, network: {}, storage: {} } as never, 1, 60);
    const values = memoryDataValues();
    let now = 1_000_000;
    const hub = new DataHub({ instance: "plant", store, data, state, values, now: () => now });
    // `live` reads the MQTT connection `plant`, which doesn't exist: nothing is bound.
    await hub.tick();
    expect(hub.status()).toMatchObject({ profile: "live", tasks: 0 });
    await store.setActiveProfile("plant", "simulation", 2);
    hub.reload();
    await hub.tick();
    expect(hub.status()).toMatchObject({ profile: "simulation", tasks: 2, connections: { gen: { tasks: 2 } } });
    const written = await values.read("plant");
    expect(Object.keys(written).sort()).toEqual(["p1", "p2"]);
    expect(written.p1!.temperature).toMatchObject({ profile: "simulation", connection: "gen" });
    // Not due yet: no new value; after `every` (30 s by default) a new one.
    const first = written.p1!.temperature!.ts;
    await hub.tick();
    expect((await values.read("plant", "p1")).p1!.temperature!.ts).toBe(first);
    now += 31_000;
    await hub.tick();
    expect((await values.read("plant", "p1")).p1!.temperature!.ts).toBe(now);
    await hub.stop();
    store.close();
  });
});
