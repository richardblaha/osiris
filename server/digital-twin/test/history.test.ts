import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CHECKPOINT_MS, ENTITY_EVENT, HistoryLog, HistoryReader, RELATIONSHIP_EVENT } from "../src/history.ts";
import { TwinStore } from "../src/store.ts";
import { startSync } from "../src/sync.ts";
import { ClickHouse } from "../src/telemetry.ts";
import type { SourceSnapshot, TwinSource } from "../src/twin.ts";
import { DTDL_CONTEXT } from "@osiris/shared/dtdl.ts";

const tempStore = () => TwinStore.open(join(tmpdir(), `twin-${process.pid}-${Math.random().toString(36).slice(2)}.db`));
const thing = (id: string, over: Record<string, unknown> = {}) => ({ $dtId: id, $metadata: { $model: "dtmi:test:Thing;1" }, name: id, status: "ok", ...over });
const snap = (twins: ReturnType<typeof thing>[], contains: [string, string][]): SourceSnapshot => ({ twins, relationships: contains.map(([source, target]) => ({ name: "contains", source, target })) });
const first = snap([thing("root"), thing("a", { v: 1 }), thing("b")], [["root", "a"], ["a", "b"]]);
const second = snap([thing("root"), thing("a", { v: 2, status: "warn" })], [["root", "a"]]);

describe("TwinStore", () => {
  it("syncs a source's snapshot and tells what changed", async () => {
    const store = await tempStore();
    const one = await store.sync("test", first, 1_000);
    expect(one.added.map((t) => t.$dtId).sort()).toEqual(["a", "b", "root"]);
    expect(one.relationshipsAdded).toHaveLength(2);
    const two = await store.sync("test", second, 2_000);
    expect(two.added).toEqual([]);
    expect(two.changed).toEqual([expect.objectContaining({ changed: ["status", "v"] })]);
    expect(two.removed.map((t) => t.$dtId)).toEqual(["b"]);
    expect(two.relationshipsRemoved).toEqual([expect.objectContaining({ $sourceId: "a", $targetId: "b" })]);
    expect((await store.twin("a"))).toMatchObject({ v: 2, status: "warn", $metadata: { $lastUpdateTime: "1970-01-01T00:00:02.000Z" } });
    // Nothing changed: nothing written, the etag and update time stay.
    const three = await store.sync("test", second, 3_000);
    expect([three.added, three.changed, three.removed, three.relationshipsAdded, three.relationshipsRemoved].flat()).toEqual([]);
    expect((await store.twin("root"))!.$metadata.$lastUpdateTime).toBe("1970-01-01T00:00:01.000Z");
  });

  it("keeps each source's twins its own", async () => {
    const store = await tempStore();
    await store.sync("one", snap([thing("x")], []), 1);
    await store.sync("two", snap([thing("y")], []), 2);
    await store.sync("one", snap([], []), 3);
    expect((await store.twins()).map((t) => t.$dtId)).toEqual(["y"]);
  });
});

describe("HistoryLog", () => {
  it("sends each change as an OpenTelemetry event, with the ancestors and what changed", async () => {
    const store = await tempStore();
    const events: { name: string; a: Record<string, string>; ts: number }[] = [];
    const log = new HistoryLog((name, a, ts) => events.push({ name, a, ts }), "busiris", "test");
    await store.sync("test", first, 1_000);
    const result = await store.sync("test", second, 2_000);
    log.record(result, await store.relationships());
    const entity = events.filter((e) => e.name === ENTITY_EVENT);
    expect(entity.find((e) => e.a["dt.id"] === "a")!.a).toMatchObject({ "twin.id": "busiris", "twin.change": "changed", "dt.status": "warn", "dt.previous_status": "ok", "dt.changed": '["status","v"]', "dt.ancestors": '["root"]' });
    // b is gone, under the ancestors it had.
    expect(entity.find((e) => e.a["dt.id"] === "b")!.a).toMatchObject({ "twin.change": "removed", "dt.ancestors": '["a","root"]' });
    expect(events.filter((e) => e.name === RELATIONSHIP_EVENT).map((e) => e.a["twin.change"])).toEqual(["removed"]);
    expect(events.every((e) => e.ts === 2_000)).toBe(true);
  });
});

describe("startSync", () => {
  it("writes the models, syncs, and checkpoints everything once a day", async () => {
    const store = await tempStore();
    let snapshot = first;
    let now = 1_000;
    const source: TwinSource = {
      name: "test",
      models: () => [{ "@context": DTDL_CONTEXT, "@id": "dtmi:test:Thing;1", "@type": "Interface" }],
      snapshot: async () => snapshot,
    };
    const events: string[] = [];
    const sync = await startSync({ source, store, history: new HistoryLog((_, a) => events.push(a["twin.change"]!), "t", "test"), intervalMs: 1e9, now: () => now, log: () => {} });
    expect((await store.models()).map((m) => m.id)).toEqual(["dtmi:test:Thing;1"]);
    expect(events.filter((e) => e === "checkpoint")).toHaveLength(5); // 3 twins, 2 relationships
    events.length = 0;
    snapshot = second;
    now = 2_000;
    await sync.round();
    expect(events).not.toContain("checkpoint");
    now = 1_000 + CHECKPOINT_MS;
    await sync.round();
    expect(events.filter((e) => e === "checkpoint")).toHaveLength(3); // 2 twins, 1 relationship
    sync.stop();
  });

  it("refuses models that aren't valid DTDL", async () => {
    const source: TwinSource = { name: "bad", models: () => [{ "@context": "x", "@id": "nope", "@type": "Interface" }], snapshot: async () => snap([], []) };
    await expect(startSync({ source, store: await tempStore(), intervalMs: 1e9 })).rejects.toThrow(/not valid/);
  });
});

/** A ClickHouse that answers queries with what a test gives it and remembers them. */
function fakeClickHouse(answer: (sql: string) => unknown[]) {
  const queries: { sql: string; params: Record<string, string> }[] = [];
  const fetchFn = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = new URL(String(input));
    queries.push({ sql: init?.body ?? "", params: Object.fromEntries([...url.searchParams].filter(([k]) => k.startsWith("param_")).map(([k, v]) => [k.slice(6), v])) });
    return Response.json({ data: answer(init?.body ?? "") });
  });
  return { ch: new ClickHouse("http://ch", "osiris", "pw", fetchFn as unknown as typeof fetch), queries };
}

describe("HistoryReader", () => {
  it("rebuilds the state at a time from otel_logs: the newest checkpoint and the changes after it", async () => {
    const { ch, queries } = fakeClickHouse((sql) =>
      sql.includes("count() AS n")
        ? [{ last_ms: "500", n: "1" }]
        : sql.includes("dt.contents")
          ? [{ id: "root", change: "checkpoint", model: "m", contents: '{"name":"root"}', updated_ms: "500" }]
          : [{ source: "root", id: "contains-1", change: "added", name: "contains", target: "a" }],
    );
    const state = (await new HistoryReader(ch, "busiris", "osiris-digital-twin").stateAt(900))!;
    expect(state.twins).toEqual([{ $dtId: "root", $metadata: { $model: "m", $lastUpdateTime: "1970-01-01T00:00:00.500Z" }, name: "root" }]);
    expect(state.relationships).toEqual([{ $relationshipId: "contains-1", $sourceId: "root", $relationshipName: "contains", $targetId: "a" }]);
    for (const q of queries) {
      expect(q.sql).toContain("FROM otel_logs");
      expect(q.params).toMatchObject({ service: "osiris-digital-twin", twin: "busiris" });
    }
    expect(queries.slice(1).every((q) => q.sql.includes("HAVING change != 'removed'") && q.params.from === "500")).toBe(true);
  });

  it("has no state before the first checkpoint", async () => {
    const { ch, queries } = fakeClickHouse(() => [{ last_ms: "0", n: "0" }]);
    expect(await new HistoryReader(ch, "busiris", "s").stateAt(900)).toBeNull();
    expect(queries).toHaveLength(1);
  });

  it("lists a twin's changes with its descendants', never the checkpoints", async () => {
    const { ch, queries } = fakeClickHouse(() => [{ at_ms: "900", id: "a", change: "changed", model: "m", name: "a", status: "warn", previous: "ok", changed: '["status"]' }]);
    const changes = await new HistoryReader(ch, "busiris", "s").changes({ dtId: "root", from: 0, to: 1000, limit: 10 });
    expect(changes).toEqual([{ ts: 900, dtId: "a", model: "m", name: "a", change: "changed", status: "warn", previousStatus: "ok", changed: ["status"] }]);
    expect(queries[0]!.sql).toContain("has(JSONExtract(LogAttributes['dt.ancestors'], 'Array(String)'), {dt:String})");
    expect(queries[0]!.sql).toContain("!= 'checkpoint'");
  });
});
