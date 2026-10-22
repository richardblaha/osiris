import { randomUUID } from "node:crypto";
import {
  DASHBOARD_RANGES,
  PANEL_KINDS,
  type Dashboard,
  type DashboardDefinition,
  type PanelData,
  type PanelSource,
  type ReportedUsage,
  type TenantQuotas,
  type WebSummary,
} from "@osiris/shared";
import { run, type Db } from "@osiris/platform/rqlite.ts";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Backups } from "./backups.ts";
import type { Orchestrator } from "./orchestrator/types.ts";
import type { ScheduleStore } from "./scheduler.ts";
import { webSummary, type Telemetry } from "./telemetry/clickhouse.ts";
import { QuotaError, type TenantDirectory, type TenantStore } from "./tenants.ts";

const HOUR = 3_600_000;
const name = z.string().max(200).optional();
const source = z.discriminatedUnion("type", [
  z.object({ type: z.literal("metric"), name: z.string().min(1).max(300), metricType: z.enum(["gauge", "sum", "histogram"]), groupBy: z.string().max(100).regex(/^[A-Za-z0-9_.\-/]*$/).optional(), service: name }),
  z.object({ type: z.literal("logs"), view: z.enum(["by_service", "list"]), severity: z.enum(["warn", "error", "fatal"]).optional(), service: name, namespace: name, q: name }),
  z.object({ type: z.literal("cluster"), view: z.enum(["summary", "tenants", "pods", "events"]) }),
  z.object({ type: z.literal("web"), view: z.enum(["totals", "series", "sites", "pages", "referrers", "countries"]) }),
  z.object({ type: z.literal("usage"), view: z.enum(["quotas", "users", "assistants", "months", "tenants"]) }),
  z.object({ type: z.literal("database"), sql: z.string().min(1).max(10_000) }),
]);
const definition = z.object({
  range: z.enum(DASHBOARD_RANGES),
  panels: z
    .array(
      z.object({
        title: z.string().trim().max(100),
        kind: z.enum(PANEL_KINDS),
        source,
        width: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
      }),
    )
    .max(30),
});
const dashboardBody = z.object({ name: z.string().trim().min(1).max(60), definition });

/** Which sources a dashboard of the system or of a tenant may show; the data endpoints check their callers anyway. */
const SYSTEM_SOURCES = new Set<PanelSource["type"]>(["metric", "logs", "cluster", "web", "usage"]);
const TENANT_SOURCES = new Set<PanelSource["type"]>(["web", "usage", "database"]);
function checkSources(def: DashboardDefinition, system: boolean) {
  for (const p of def.panels) {
    const s = p.source;
    const ok = system ? SYSTEM_SOURCES.has(s.type) && (s.type !== "usage" || s.view === "tenants") : TENANT_SOURCES.has(s.type) && !(s.type === "usage" && s.view === "tenants");
    if (!ok) throw new HTTPException(400, { message: `Zdroj ${s.type}${"view" in s ? `/${s.view}` : ""} na ${system ? "systémovém" : "tenantovém"} dashboardu není` });
  }
}

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success) throw new HTTPException(400, { message: z.prettifyError(r.error) });
  return r.data;
};

interface Row {
  id: string;
  name: string;
  definition: string;
  updated_at: number;
}
const toDashboard = (r: Row): Dashboard => ({ id: r.id, name: r.name, definition: JSON.parse(r.definition) as DashboardDefinition, updatedAt: new Date(Number(r.updated_at)).toISOString() });
/** `tenant_id IS ?` matches NULL (the system's) as well as a tenant. */
const OWNER = "tenant_id IS ?";

/** The system's (tenant null) and tenants' own dashboards; the built-in ones are the web app's. */
export class DashboardStore {
  constructor(private readonly db: Db) {}

  async list(tenant: string | null): Promise<Dashboard[]> {
    return (await this.db.query<Row>(`SELECT * FROM dashboards WHERE ${OWNER} ORDER BY created_at`, [tenant])).map(toDashboard);
  }

  async count(tenant: string): Promise<number> {
    const [r] = await this.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM dashboards WHERE tenant_id = ?", [tenant]);
    return Number(r?.n ?? 0);
  }

  /** Adds one; a tenant's only while under its quota, checked in the same write. */
  async create(tenant: string | null, d: { name: string; definition: DashboardDefinition }, by: string, limit: number | null): Promise<Dashboard> {
    const id = randomUUID();
    const now = Date.now();
    const [r] = await this.db.execute([
      run(
        `INSERT INTO dashboards (id, tenant_id, name, definition, created_by, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ? WHERE ? IS NULL OR (SELECT COUNT(*) FROM dashboards WHERE ${OWNER}) < ?`,
        id,
        tenant,
        d.name,
        JSON.stringify(d.definition),
        by,
        now,
        now,
        limit,
        tenant,
        limit,
      ),
    ]);
    if (!r?.rowsAffected) throw new QuotaError(`Tenant může mít nejvýš ${limit} vlastních dashboardů`);
    return { id, name: d.name, definition: d.definition, updatedAt: new Date(now).toISOString() };
  }

  async update(tenant: string | null, id: string, d: { name: string; definition: DashboardDefinition }): Promise<Dashboard> {
    const now = Date.now();
    const [r] = await this.db.execute([
      run(`UPDATE dashboards SET name = ?, definition = ?, updated_at = ? WHERE id = ? AND ${OWNER}`, d.name, JSON.stringify(d.definition), now, id, tenant),
    ]);
    if (!r?.rowsAffected) throw new HTTPException(404, { message: "Dashboard nenalezen" });
    return { id, ...d, updatedAt: new Date(now).toISOString() };
  }

  async delete(tenant: string | null, id: string) {
    const [r] = await this.db.execute([run(`DELETE FROM dashboards WHERE id = ? AND ${OWNER}`, id, tenant)]);
    if (!r?.rowsAffected) throw new HTTPException(404, { message: "Dashboard nenalezen" });
  }
}

export interface DashboardDeps {
  store: DashboardStore;
  tenants: TenantStore;
  directory: TenantDirectory;
  schedules: ScheduleStore;
  backups: Backups;
  orchestrator: Orchestrator;
  telemetry?: Telemetry;
}

const rangeOf = (c: Context) => {
  const q = parse(z.object({ from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() }), c.req.query());
  const to = q.to ?? Date.now();
  return { from: Math.max(q.from ?? to - 24 * HOUR, to - 731 * 24 * HOUR), to };
};

/** CRUD over one owner's dashboards: the system's (`tenant` null) or the caller's tenant's. */
function crud(deps: DashboardDeps, owner: (c: Context) => { tenant: string | null; canEdit: boolean; limit: number | null; by: string }) {
  const edit = (c: Context) => {
    const o = owner(c);
    if (!o.canEdit) throw new HTTPException(403, { message: "Dashboardy mění jen správce" });
    return o;
  };
  const body = async (c: Context, system: boolean) => {
    const d = parse(dashboardBody, await c.req.json().catch(() => null));
    checkSources(d.definition, system);
    return d;
  };
  return new Hono()
    .get("/", async (c) => c.json<Dashboard[]>(await deps.store.list(owner(c).tenant)))
    .post("/", async (c) => {
      const o = edit(c);
      return c.json<Dashboard>(await deps.store.create(o.tenant, await body(c, o.tenant === null), o.by, o.limit), 201);
    })
    .put("/:id", async (c) => {
      const o = edit(c);
      return c.json<Dashboard>(await deps.store.update(o.tenant, c.req.param("id"), await body(c, o.tenant === null)));
    })
    .delete("/:id", async (c) => {
      await deps.store.delete(edit(c).tenant, c.req.param("id"));
      return c.body(null, 204);
    });
}

const ch = (deps: DashboardDeps) => {
  if (!deps.telemetry) throw new HTTPException(503, { message: "Telemetrie (ClickHouse) tu není nastavená" });
  return deps.telemetry;
};

/** A tenant's dashboards (its admins edit, members see) and its sites' web analytics. Mounted at /api/dashboards. */
export function tenantDashboardRoutes(deps: DashboardDeps, ctx: (c: Context) => { tenant: string; role: string; user: string; quotas: TenantQuotas }) {
  return new Hono()
    .get("/data/web", async (c) => {
      const { tenant } = ctx(c);
      const sites = (await deps.tenants.webSites()).get(tenant) ?? [];
      if (!sites.length) return c.json<WebSummary>({ sites: [], totals: { pageviews: 0, visitors: 0, events: 0 }, step: "day", series: [], pages: [], referrers: [], countries: [] });
      return c.json<WebSummary>(await webSummary(ch(deps).ch, sites, rangeOf(c), () => tenant));
    })
    .route(
      "/",
      crud(deps, (c) => {
        const x = ctx(c);
        return { tenant: x.tenant, canEdit: x.role === "admin", limit: x.quotas.dashboards, by: x.user };
      }),
    );
}

const meter = (used: number, limit: number | null) => ({ used, limit });

/** The system's dashboards and the data only system admins see. Mounted at /api/admin/dashboards. */
export function systemDashboardRoutes(deps: DashboardDeps, user: (c: Context) => string) {
  return new Hono()
    .get("/data/web", async (c) => {
      const owners = new Map<string, string>();
      for (const [tenant, sites] of await deps.tenants.webSites()) for (const s of sites) owners.set(s, tenant);
      return c.json<WebSummary>(await webSummary(ch(deps).ch, null, rangeOf(c), (s) => owners.get(s) ?? null));
    })
    .get("/data/logs", async (c) => {
      const q = parse(z.object({ severity: z.enum(["warn", "error", "fatal"]).optional(), namespace: name }), c.req.query());
      const rows = await ch(deps).logCounts({ ...rangeOf(c), ...q });
      return c.json<PanelData>({ columns: ["Služba", "Záznamů"], rows: rows.map((r) => [r.service, r.count]), formats: ["text", "number"] });
    })
    .get("/data/cluster/:view", async (c) => {
      const view = c.req.param("view");
      if (view === "pods") {
        const rows = await ch(deps).podProblems(rangeOf(c));
        const phase = (p: number | null) => (p === null ? "běží" : ({ 1: "čeká", 4: "selhal", 5: "neznámý" } as Record<number, string>)[p] ?? String(p));
        return c.json<PanelData>({ columns: ["Namespace", "Pod", "Stav", "Restartů"], rows: rows.map((r) => [r.namespace, r.pod, phase(r.phase), r.restarts]), formats: ["text", "text", "text", "number"] });
      }
      if (view === "events") {
        const rows = await ch(deps).warningEvents(rangeOf(c));
        return c.json<PanelData>({
          columns: ["Čas", "Namespace", "Objekt", "Důvod", "Zpráva", "Počet"],
          rows: rows.map((r) => [r.ts, r.namespace, r.object, r.reason, r.note, r.count]),
          formats: ["time", "text", "text", "text", "text", "number"],
        });
      }
      const [tenants, statuses, backups] = await Promise.all([deps.tenants.list(), deps.orchestrator.statuses().catch(() => new Map()), deps.backups.newest()]);
      const label = { Running: "běží", Sleeping: "spí", Suspended: "pozastaven", Unknown: "neznámý" } as const;
      if (view === "summary") {
        const phases = tenants.map((t) => statuses.get(t.id)?.phase ?? "Unknown");
        const stale = tenants.filter((t) => (backups.get(t.id)?.createdAt ?? 0) < Date.now() - 48 * HOUR).length;
        return c.json<PanelData>({
          columns: ["Tenantů", "Běží", "Spí", "Bez zálohy 48 h"],
          rows: [[tenants.length, phases.filter((p) => p === "Running").length, phases.filter((p) => p === "Sleeping").length, stale]],
          formats: ["number", "number", "number", "number"],
        });
      }
      if (view === "tenants") {
        return c.json<PanelData>({
          columns: ["Tenant", "Stav", "Poslední aktivita", "Poslední záloha", "Velikost zálohy", "Hlášení"],
          rows: tenants.map((t) => {
            const s = statuses.get(t.id);
            const b = backups.get(t.id);
            return [t.id, label[(s?.phase ?? "Unknown") as keyof typeof label], s?.lastActivity ? Date.parse(s.lastActivity) : null, b?.createdAt ?? null, b?.bytes ?? null, s?.message ?? ""];
          }),
          formats: ["text", "text", "time", "time", "bytes", "text"],
        });
      }
      throw new HTTPException(404, { message: "Neznámý pohled" });
    })
    // Every tenant's quotas and how full they are: control's own counts, the runtimes' last reports for the rest.
    .get("/data/usage", async (c) => {
      const tenants = await deps.tenants.list();
      const month = new Date().toISOString().slice(0, 7);
      const rows = await Promise.all(
        tenants.map(async (t) => {
          const u: Partial<ReportedUsage> = t.usage ?? {};
          const q = t.quotas;
          const [members, schedules, dashboards] = await Promise.all([deps.directory.memberCount(t.id), deps.schedules.list(t.id), deps.store.count(t.id)]);
          return [
            t.id,
            meter(u.month === month ? (u.tokens ?? 0) : 0, q.tokensPerMonth),
            meter(u.storage ?? 0, q.storageMb === null ? null : q.storageMb * 1024 * 1024),
            meter(members, q.members),
            meter(schedules.length, q.schedules),
            meter(u.tables ?? 0, q.tables),
            meter(u.database ?? 0, q.databaseMb === null ? null : q.databaseMb * 1024 * 1024),
            meter(dashboards, q.dashboards),
            t.usage?.at ?? null,
          ];
        }),
      );
      return c.json<PanelData>({
        columns: ["Tenant", "Tokeny tento měsíc", "Soubory", "Uživatelé", "Úlohy", "Tabulky", "Databáze", "Dashboardy", "Nahlášeno"],
        rows,
        formats: ["text", "meter", "meterBytes", "meter", "meter", "meter", "meterBytes", "meter", "time"],
      });
    })
    .route("/", crud(deps, (c) => ({ tenant: null, canEdit: true, limit: null, by: user(c) })));
}
