import { describe, expect, it } from "vitest";
import { ClickHouse, Telemetry } from "../src/telemetry/clickhouse.ts";
import { telemetryRoutes } from "../src/telemetry/routes.ts";

describe("telemetry from ClickHouse", () => {
  it("passes filters as query parameters, never in the SQL", async () => {
    const calls: { url: URL; sql: string; headers: Headers }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url: new URL(url), sql: String(init.body), headers: new Headers(init.headers) });
      return Response.json({ data: [] });
    }) as typeof fetch;
    const t = new Telemetry(new ClickHouse("http://clickhouse:8123", "osiris", "pw", fake));
    const evil = "x') OR 1=1 --";
    await t.logs({ from: 0, to: 1000, q: evil, service: evil, limit: 10 });
    const [call] = calls;
    expect(call!.sql).not.toContain(evil);
    expect(call!.url.searchParams.get("param_q")).toBe(evil);
    expect(call!.url.searchParams.get("param_service")).toBe(evil);
    expect(call!.headers.get("x-clickhouse-user")).toBe("osiris");
  });

  it("says when ClickHouse isn't set up and checks what it's asked", async () => {
    expect((await telemetryRoutes().request("/logs")).status).toBe(503);
    const t = new Telemetry(new ClickHouse("http://x", "u", "p", (async () => Response.json({ data: [] })) as typeof fetch));
    const app = telemetryRoutes(t);
    expect((await app.request("/traces/not-an-id")).status).toBe(400);
    expect((await app.request("/series?name=m&type=nope")).status).toBe(400);
    expect((await app.request("/series?name=m&type=gauge&groupBy=a';b")).status).toBe(400);
    expect(await (await app.request("/series?name=m&type=gauge")).json()).toEqual({ step: 60, series: [] });
  });

  it("reads one of a project's sites' web analytics from the aggregates, the site as a parameter", async () => {
    const calls: { url: URL; sql: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      const sql = String(init.body);
      calls.push({ url: new URL(url), sql });
      // UInt64 comes quoted in ClickHouse's JSON.
      if (sql.includes("DISTINCT site")) return Response.json({ data: [{ site: "k6labs.cz" }, { site: "tras.cz" }] });
      if (sql.includes("FROM web.stats_daily WHERE")) return Response.json({ data: [{ pageviews: "120", visitors: "40", events: "3" }] });
      if (sql.includes("FROM web.stats_hourly")) return Response.json({ data: [{ t: "1761091200000", pageviews: "5", visitors: "2" }] });
      if (sql.includes("FROM web.locations_daily") && sql.includes("city AS key")) return Response.json({ data: [{ key: "Prague", detail: "Prague, CZ", pageviews: "12", visitors: "5" }] });
      if (sql.includes("FROM web.networks_daily")) return Response.json({ data: [{ key: "Example ISP", detail: "AS123", pageviews: "10", visitors: "4" }] });
      if (sql.includes("FROM web.pages_daily")) return Response.json({ data: [{ key: "/", detail: "", pageviews: "80", visitors: "30" }] });
      return Response.json({ data: [] });
    }) as typeof fetch;
    const web = new Telemetry(new ClickHouse("http://clickhouse:8123", "osiris", "pw", fake)).web;
    const now = Date.now();
    const day = { from: now - 86_400_000, to: now };
    // A site the project wasn't given is never read: its own comes instead.
    const stats = await web.stats("tras.cz", day, ["k6labs.cz", "jinde.cz"]);
    expect(stats).toMatchObject({
      sites: ["k6labs.cz"],
      totals: { pageviews: 120, visitors: 40, events: 3 },
      step: "hour",
      series: [{ t: 1761091200000, pageviews: 5, visitors: 2 }],
      pages: [{ key: "/", detail: "", pageviews: 80, visitors: 30 }],
      referrers: [],
      cities: [{ key: "Prague", detail: "Prague, CZ", pageviews: 12, visitors: 5 }],
      networks: [{ key: "Example ISP", detail: "AS123", pageviews: 10, visitors: 4 }],
    });
    expect(calls.every((c) => !c.sql.includes("k6labs.cz"))).toBe(true);
    expect(calls.filter((c) => c.url.searchParams.get("param_site") === "k6labs.cz")).toHaveLength(13);
    // Over two days: by day.
    expect((await web.stats(undefined, { from: now - 30 * 86_400_000, to: now })).step).toBe("day");
  });
});
