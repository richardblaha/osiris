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
});
