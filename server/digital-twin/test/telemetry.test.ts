import { describe, expect, it, vi } from "vitest";
import { ClickHouse, Telemetry } from "../src/telemetry.ts";

/** A ClickHouse that answers one empty row and remembers the SQL and its parameters. */
function spy() {
  const calls: { sql: string; params: Record<string, string | number> }[] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const url = new URL(String(_url));
    const params: Record<string, string | number> = {};
    for (const [k, v] of url.searchParams) if (k.startsWith("param_")) params[k.slice("param_".length)] = v;
    calls.push({ sql: init?.body ?? "", params });
    return Response.json({ data: [] });
  });
  return { calls, ch: new ClickHouse("http://ch", "osiris", "pw", fetchFn as unknown as typeof fetch) };
}

const RANGE = { from: 1730000000000, to: 1730003600000 };

describe("Telemetry's cluster filter", () => {
  it("adds k8s.cluster.name to every query when a cluster is given", async () => {
    const { calls, ch } = spy();
    const t = new Telemetry(ch, "busiris");
    await t.facets(RANGE);
    await t.podErrors();
    await t.logs({ ...RANGE, limit: 10 });
    await t.traces({ ...RANGE, limit: 10 });
    await t.trace("0123456789abcdef0123456789abcdef");
    await t.metrics(RANGE);
    await t.series({ ...RANGE, name: "k8s.pod.phase", type: "gauge", step: 60 });
    // facets asks twice (services and namespaces); every call carries the cluster.
    expect(calls).toHaveLength(8);
    for (const { sql, params } of calls) {
      expect(sql).toContain("k8s.cluster.name");
      expect(params.cluster).toBe("busiris");
    }
    // The trace count subquery qualifies the outer table too.
    const traces = calls[4]!;
    expect(traces.sql).toContain("t.ResourceAttributes['k8s.cluster.name'] = {cluster:String}");
  });

  it("sees every cluster in the database without one", async () => {
    const { calls, ch } = spy();
    const t = new Telemetry(ch);
    await t.facets(RANGE);
    await t.podErrors();
    await t.logs({ ...RANGE, limit: 10 });
    await t.traces({ ...RANGE, limit: 10 });
    await t.trace("0123456789abcdef0123456789abcdef");
    await t.metrics(RANGE);
    await t.series({ ...RANGE, name: "k8s.pod.phase", type: "gauge", step: 60 });
    for (const { sql, params } of calls) {
      expect(sql).not.toContain("k8s.cluster.name");
      expect(params.cluster).toBeUndefined();
    }
    // The filters still work without the cluster one.
    const logs = calls[3]!;
    expect(logs.sql).toContain("otel_logs");
    expect(logs.params).toMatchObject({ from: "1730000000", to: "1730003600" });
  });
});
