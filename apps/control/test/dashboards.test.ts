import { describe, expect, it } from "vitest";
import { NO_QUOTAS, type DashboardDefinition, type PanelData } from "@osiris/shared";
import { createTestControl } from "./helpers.ts";

const db: DashboardDefinition = { range: "30d", panels: [{ title: "Obchody", kind: "table", source: { type: "database", sql: "SELECT * FROM deals" } }] };
const sys: DashboardDefinition = { range: "24h", panels: [{ title: "Projekty", kind: "table", source: { type: "cluster", view: "projects" } }] };

describe("dashboards", () => {
  it("keeps a project's own dashboards to its admins, its sources and its quota", async () => {
    const { directory, asUser } = await createTestControl();
    await directory.create("acme", "ACME");
    await directory.update("acme", { quotas: { ...NO_QUOTAS, dashboards: 1 } });
    const admin = asUser("ann", [{ projectId: "acme", role: "admin" }]);
    const member = asUser("bob", [{ projectId: "acme", role: "member" }]);
    const post = (who: typeof admin, name: string, definition: DashboardDefinition) => who("/dashboards", { method: "POST", body: JSON.stringify({ name, definition }) });

    expect((await post(member, "CRM", db)).status).toBe(403);
    // A project can't show what only system admins see.
    expect((await post(admin, "Cluster", sys)).status).toBe(400);
    const created = await post(admin, "CRM", db);
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect((await post(admin, "Druhý", db)).status).toBe(400);

    expect((await (await member("/dashboards")).json()).map((d: { name: string }) => d.name)).toEqual(["CRM"]);
    expect((await admin(`/dashboards/${id}`, { method: "PUT", body: JSON.stringify({ name: "Obchody", definition: db }) })).status).toBe(200);
    // Another project's admin doesn't reach it.
    await directory.create("other", "Other");
    const stranger = asUser("eve", [{ projectId: "other", role: "admin" }]);
    expect((await stranger(`/dashboards/${id}`, { method: "DELETE" })).status).toBe(404);
    expect((await admin(`/dashboards/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(await (await admin("/dashboards")).json()).toEqual([]);
    // Without its domains or sites a project's web analytics are empty, with no ClickHouse needed.
    expect((await (await member("/dashboards/data/web")).json()).sites).toEqual([]);
    // Návštěvnost is the project's (feature sites); without ClickHouse it says so.
    expect((await member("/analytics")).status).toBe(503);
    await directory.update("acme", { features: { sites: false } });
    expect((await member("/analytics")).status).toBe(403);
  });

  it("gives system admins the system's dashboards and every project's state and use", async () => {
    const { directory, asUser, asRuntime, orchestrator } = await createTestControl();
    await directory.create("acme", "ACME");
    await directory.update("acme", { quotas: { ...NO_QUOTAS, tokensPerMonth: 1000 } });
    await orchestrator.wake("acme");
    const root = asUser("root", [], { systemAdmin: true });
    expect((await asUser("ann", [{ projectId: "acme", role: "admin" }])("/admin/dashboards")).status).toBe(403);
    expect((await root("/admin/dashboards", { method: "POST", body: JSON.stringify({ name: "Provoz", definition: sys }) })).status).toBe(201);
    expect((await root("/admin/dashboards", { method: "POST", body: JSON.stringify({ name: "DB", definition: db }) })).status).toBe(400);

    const summary = (await (await root("/admin/dashboards/data/cluster/summary")).json()) as PanelData;
    expect(summary.rows).toEqual([[1, 1, 0, 1]]);

    const month = new Date().toISOString().slice(0, 7);
    expect((await asRuntime("acme")("/usage", { method: "PUT", body: JSON.stringify({ storage: 2048, tokens: 900, month, tables: 2, database: 4096 }) })).status).toBe(204);
    const usage = (await (await root("/admin/dashboards/data/usage")).json()) as PanelData;
    expect(usage.rows[0]!.slice(0, 3)).toEqual(["acme", { used: 900, limit: 1000 }, { used: 2048, limit: null }]);
    // Without ClickHouse the telemetry panels say so.
    expect((await root("/admin/dashboards/data/logs")).status).toBe(503);
  });

  it("lets the runtime count the project's dashboards for its meters", async () => {
    const { directory, asUser, asRuntime } = await createTestControl();
    await directory.create("acme", "ACME");
    await asUser("ann", [{ projectId: "acme", role: "admin" }])("/dashboards", { method: "POST", body: JSON.stringify({ name: "CRM", definition: db }) });
    expect((await (await asRuntime("acme")("/project")).json()).counts).toEqual({ members: 0, schedules: 0, dashboards: 1 });
  });
});
