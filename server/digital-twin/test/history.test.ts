import { describe, expect, it, vi } from "vitest";
import type { TwinEntity, TwinGraph } from "@osiris/shared";
import { CHECKPOINT_MS, HistoryStore, startRecorder, stateOf, type RecordedState } from "../src/history.ts";
import { ClickHouse } from "../src/telemetry.ts";

/** A ClickHouse that keeps the inserted rows per table and answers queries with what a test gives it. */
function fakeClickHouse(answer: (sql: string) => unknown[] = () => []) {
  const inserted: Record<string, Record<string, unknown>[]> = {};
  const queries: { sql: string; params: Record<string, string> }[] = [];
  const fetchFn = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = new URL(String(input));
    const insert = url.searchParams.get("query");
    if (insert) {
      const table = /INSERT INTO (\S+)/.exec(insert)![1]!;
      (inserted[table] ??= []).push(...(init?.body ?? "").split("\n").map((l) => JSON.parse(l) as Record<string, unknown>));
      return new Response("");
    }
    const params = Object.fromEntries([...url.searchParams].filter(([k]) => k.startsWith("param_")).map(([k, v]) => [k.slice(6), v]));
    queries.push({ sql: init?.body ?? "", params });
    return Response.json({ data: answer(init?.body ?? "") });
  });
  return { ch: new ClickHouse("http://ch", "twin", "pw", fetchFn as unknown as typeof fetch), inserted, queries };
}

const entity = (id: string, over: Partial<TwinEntity> = {}): TwinEntity => ({ id, model: "dtmi:x:Thing;1", kind: "thing", name: id, status: "ok", errors: 0, properties: {}, ...over });
const graph = (entities: TwinEntity[], contains: [string, string][], ts = 1_000): TwinGraph => ({
  source: "test",
  root: "root",
  entities,
  relationships: contains.map(([source, target]) => ({ name: "contains", source, target })),
  ts,
});
const empty: RecordedState = { entities: new Map(), relationships: new Map(), checkpoint: null };

describe("HistoryStore.write", () => {
  const first = graph([entity("root"), entity("a", { properties: { v: "1" } }), entity("b")], [["root", "a"], ["a", "b"]]);

  it("writes a checkpoint of everything, with the changes of that round beside it", async () => {
    const { ch, inserted } = fakeClickHouse();
    await new HistoryStore(ch, "busiris", "test").write(first, empty, true);
    const rows = inserted["twin.entity_events"]!;
    expect(rows.filter((r) => r.change === "checkpoint")).toHaveLength(3);
    expect(rows.filter((r) => r.change === "added")).toHaveLength(3);
    expect(rows.find((r) => r.entity_id === "b" && r.change === "added")).toMatchObject({ twin: "busiris", source: "test", ancestors: ["a", "root"], ts: "1970-01-01 00:00:01.000" });
    expect(inserted["twin.relationship_events"]!.map((r) => r.change).sort()).toEqual(["added", "added", "checkpoint", "checkpoint"]);
  });

  it("writes only what changed: properties and status, removed entities and relationships; error counts are no change", async () => {
    const { ch, inserted } = fakeClickHouse();
    const next = graph([entity("root", { errors: 7 }), entity("a", { properties: { v: "2" }, status: "warn" })], [["root", "a"]], 2_000);
    await new HistoryStore(ch, "busiris", "test").write(next, stateOf(first, 1_000), false);
    const rows = inserted["twin.entity_events"]!;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ entity_id: "a", change: "changed", status: "warn", previous_status: "ok", changed: ["status", "v"], ancestors: ["root"] });
    // b is gone, written as it was, under the ancestors it had.
    expect(rows[1]).toMatchObject({ entity_id: "b", change: "removed", ancestors: ["a", "root"] });
    expect(inserted["twin.relationship_events"]).toEqual([expect.objectContaining({ change: "removed", source_id: "a", target_id: "b" })]);
  });

  it("writes nothing when nothing changed", async () => {
    const { ch, inserted } = fakeClickHouse();
    expect(await new HistoryStore(ch, "busiris", "test").write({ ...first, ts: 5_000 }, stateOf(first, 1_000), false)).toBe(0);
    expect(inserted).toEqual({});
  });
});

describe("HistoryStore's queries", () => {
  it("rebuild the state from the newest checkpoint and the changes after it, per twin", async () => {
    const { ch, queries } = fakeClickHouse((sql) =>
      sql.includes("count() AS n")
        ? [{ ts: "500", n: "1" }]
        : sql.includes("entity_events")
          ? [{ entity_id: "root", change: "checkpoint", model: "m", kind: "thing", name: "root", status: "ok", properties: {}, telemetry: {} }]
          : [{ name: "contains", source_id: "root", target_id: "a", change: "added" }],
    );
    const state = await new HistoryStore(ch, "busiris", "test").stateAt(900);
    expect(state.checkpoint).toBe(500);
    expect([...state.entities.keys()]).toEqual(["root"]);
    expect([...state.relationships.values()]).toEqual([{ name: "contains", source: "root", target: "a" }]);
    const window = queries.slice(1);
    for (const q of window) {
      expect(q.sql).toContain("HAVING change != 'removed'");
      expect(q.params).toMatchObject({ twin: "busiris", from: "500", at: "900" });
    }
  });

  it("know there is no state before the first checkpoint", async () => {
    const { ch, queries } = fakeClickHouse(() => [{ ts: "0", n: "0" }]);
    expect((await new HistoryStore(ch, "busiris", "test").stateAt(900)).checkpoint).toBeNull();
    expect(queries).toHaveLength(1);
  });

  it("list an entity's changes with its descendants', never the checkpoints", async () => {
    const { ch, queries } = fakeClickHouse(() => [
      { ts: "900", entity_id: "a", change: "changed", kind: "thing", name: "a", status: "warn", previous_status: "ok", changed: ["status"], properties: {} },
    ]);
    const changes = await new HistoryStore(ch, "busiris", "test").changes({ entity: "root", from: 0, to: 1000, limit: 10 });
    expect(changes).toEqual([{ ts: 900, entityId: "a", kind: "thing", name: "a", change: "changed", status: "warn", previousStatus: "ok", changed: ["status"], properties: {} }]);
    expect(queries[0]!.sql).toContain("has(ancestors, {entity:String})");
    expect(queries[0]!.sql).toContain("change != 'checkpoint'");
  });
});

describe("the recorder", () => {
  it("records only while it holds the lease, and checkpoints once a day", async () => {
    vi.useFakeTimers();
    try {
      const { ch, inserted } = fakeClickHouse((sql) => (sql.includes("count() AS n") ? [{ ts: "0", n: "0" }] : []));
      let held = false;
      let ts = 1_000;
      const r = startRecorder({
        history: new HistoryStore(ch, "busiris", "test"),
        graph: async () => graph([entity("root")], [], ts),
        lease: { hold: async () => held },
        intervalMs: 1_000_000,
        log: () => {},
      });
      await r.round();
      expect(inserted).toEqual({});
      held = true;
      expect(await r.round()).toBeGreaterThan(0); // the first checkpoint
      ts = 2_000;
      expect(await r.round()).toBe(0); // no change, no checkpoint due
      ts = 1_000 + CHECKPOINT_MS;
      await r.round();
      expect(inserted["twin.entity_events"]!.filter((e) => e.change === "checkpoint")).toHaveLength(2);
      r.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
