import { createHash } from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { errorResponse, HttpError, requestLocale, ValidationError } from "@osiris/platform/i18n.ts";
import { ServiceError } from "@osiris/platform/http.ts";
import { telemetryMiddleware } from "@osiris/platform/telemetry.ts";
import type { Identity, TokenVerifier } from "./auth.ts";
import type { Cache } from "./cache.ts";
import type { Config } from "./config.ts";
import type { HistoryReader } from "./history.ts";
import type { TwinStore } from "./store.ts";
import { errorsByTwin, valuesByTwin, type TwinSource } from "./twin.ts";
import type { MetricType, Telemetry } from "./telemetry.ts";
import { availableTools, ceph, kubectl, OpsRefused, type CommandResult, type OpsTools } from "./ops.ts";
import { RuntimeIdentityError, type RuntimeIdentityVerifier } from "@osiris/platform/runtime-identity.ts";

const HOUR = 3_600_000;
/** At most 31 days back (the data's retention is 30). */
const rangeQuery = z
  .object({ from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() })
  .transform(({ from, to }) => {
    const end = to ?? Date.now();
    return { from: Math.max(from ?? end - HOUR, end - 31 * 24 * HOUR), to: end };
  });
const text = z.string().trim().max(200).optional();
/** Whose telemetry: OpenTelemetry's k8s namespace, pod, node or container. */
const scope = { namespace: text, pod: text, node: text, container: text, claim: text };
/** The logs page's filters. */
const logFilters = z.object({
  service: text,
  ...scope,
  severity: z.enum(["debug", "info", "warn", "error", "fatal"]).optional(),
  q: text,
  traceId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
});
/** A filter's values: the pages' query parameters by name. */
const filterValues = z.record(z.string().regex(/^[A-Za-z]{1,32}$/), z.string().max(300)).refine((f) => Object.keys(f).length <= 20);
/** A dashboard as the PWA saves it. */
const dashboardBody = z.object({
  name: z.string().trim().min(1).max(80),
  range: z.number().int().min(60_000).max(31 * 24 * 3_600_000),
  panels: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        kind: z.enum(["logs", "logBars", "metric", "traces"]),
        title: z.string().trim().max(120),
        width: z.number().int().min(1).max(4),
        filter: filterValues,
      }),
    )
    .max(40),
});
/** How many dashboards the twin keeps. */
const MAX_DASHBOARDS = 50;
/** The pages a filter can be saved for. */
const filterKind = z.enum(["logs"]);
/** How many filters one user may keep. */
const MAX_SAVED_FILTERS = 100;
/** The signed-in user's id (development without sign-in: `dev`). */
const owner = (c: Context<{ Variables: { identity: Identity } }>) => c.get("identity")?.sub ?? "dev";
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value, { reportInput: true });
  if (!r.success) throw new ValidationError(r.error);
  return r.data;
};

// Own scripts and styles only; data and pictures from this origin (the theme's data-URI icons). The PWA signs in
// from the browser (oidc-client-ts reads osiris-auth's discovery and redeems the code there), so it may also call
// osiris-auth's origin.
const csp = (authUrl?: string) =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:${authUrl ? ` ${new URL(authUrl).origin}` : ""}; connect-src 'self'${authUrl ? ` ${new URL(authUrl).origin}` : ""}; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'`;

export interface AppOptions {
  /** The adapter the twin mirrors (Kubernetes): its error attributes name the twins' logs. */
  source: TwinSource;
  /** The twin's structure (SQLite), kept in step with the source by the sync. */
  store: TwinStore;
  telemetry?: Telemetry;
  verifier?: TokenVerifier;
  cache: Cache;
  staticDir?: string;
  /** The twin's history in OpenTelemetry's logs; without it the history endpoints answer 503. */
  history?: HistoryReader;
  /** kubectl and ceph for the agents of `projects`, whose runtimes `identity` recognizes. */
  ops?: { tools: OpsTools; identity: RuntimeIdentityVerifier; projects: string[] };
  /** Replaces global fetch for the Osiris proxy (tests). */
  fetchFn?: typeof fetch;
}

/**
 * Osiris Digital Twin's HTTP app. The twin in the shape of the Azure Digital Twins API, DTDL's de facto instance
 * format: `/api/models` (DTDL v3 interfaces), `/api/digitaltwins/{id}`, its relationships and incoming relationships,
 * plus the lists the PWA draws from (`/api/digitaltwins`, `/api/relationships`; `?at=` for a past time) and each
 * twin's history. Structure from SQLite; telemetry and history from OpenTelemetry's ClickHouse; the telemetry
 * pages' data (logs, metrics, traces) and the PWA itself. Sign-in is osiris-auth's: the PWA signs in with OIDC, the
 * API introspects the token and answers members of the configured group.
 */
export function createApp(config: Config, options: AppOptions) {
  const { source, store, telemetry, verifier, cache, staticDir, history, ops } = options;
  const CSP = csp(config.AUTH_URL);
  const page = staticDir ? serveStatic({ root: staticDir, path: "index.html" }) : async (c: Context) => c.notFound();
  const prefix = `twin:${config.CLUSTER_NAME}`;

  /** An endpoint whose answer is cached: the key a hash of the query, the value fresh when the key misses. Epoch
   * times are bucketed to the TTL before hashing, so a repeated question (the pages' `now`-anchored ranges) hits. */
  const cached = async <T>(name: string, query: Record<string, unknown>, ttlSeconds: number, load: () => Promise<T>): Promise<T> => {
    const key = `${prefix}:${name}:${createHash("sha256")
      .update(JSON.stringify(query, (_, v) => (typeof v === "number" && v > 1e12 ? Math.floor(v / (ttlSeconds * 1000)) : v)))
      .digest("hex")}`;
    const hit = await cache.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await load();
    await cache.set(key, value, ttlSeconds);
    return value;
  };

  const h = () => {
    if (!history) throw new HttpError(503, "errors.digitalTwin.historyOff");
    return history;
  };
  const t = () => {
    if (!telemetry) throw new HttpError(503, "errors.telemetryOff");
    return telemetry;
  };
  /** The twins and relationships now (SQLite) or at a past time (the history). */
  const stateAt = async (at: number | undefined) => {
    if (at === undefined) return { twins: await store.twins(), relationships: await store.relationships() };
    const state = await failing(() => h().stateAt(Math.min(at, Date.now())));
    if (!state) throw new HttpError(404, "errors.digitalTwin.historyMissing");
    return state;
  };
  const atQuery = z.object({ at: z.coerce.number().int().positive().optional() });
  const failing = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      console.error("Telemetry query failed", err);
      throw new HttpError(502, "errors.telemetry.queryFailed", { detail: (err as Error).message.slice(0, 300) });
    }
  };

  const app = new Hono<{ Variables: { identity: Identity } }>()
    .use(telemetryMiddleware())
    .use(async (c, next) => {
      await next();
      c.header("x-content-type-options", "nosniff");
      c.header("referrer-policy", "strict-origin-when-cross-origin");
      c.header("x-frame-options", "DENY");
      c.header("strict-transport-security", "max-age=31536000");
      if (!c.res.headers.has("content-security-policy") && (c.res.headers.get("content-type") ?? "").includes("text/html")) c.header("content-security-policy", CSP);
    })
    .onError((err, c) => {
      const response = errorResponse(err, requestLocale(c.req.header("accept-language")));
      if (response) return c.json(response.body, response.status);
      if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as ContentfulStatusCode); // e.g. a refused token
      console.error(err);
      return c.json({ error: "Internal server error" }, 500);
    })
    .get("/healthz", (c) => c.json({ ok: true }))

    // Ops for Osiris's agent: only a runtime of an allowed project (its projected token, by TokenReview) may run
    // kubectl and ceph here; every command is logged with the project.
    .use("/ops/*", async (c, next) => {
      if (!ops?.projects.length) throw new HttpError(404, "errors.digitalTwin.notFound");
      const token = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
      let project: string;
      try {
        if (!token) throw new RuntimeIdentityError("no token");
        project = (await ops.identity.verify(token)).project;
      } catch (err) {
        if (err instanceof RuntimeIdentityError) throw new HttpError(401, "errors.digitalTwin.signedIn");
        throw err;
      }
      if (!ops.projects.includes(project)) throw new HttpError(403, "errors.digitalTwin.opsProject");
      c.set("project" as never, project as never);
      await next();
    })
    .get("/ops/tools", async (c) => c.json(await availableTools(ops!.tools)))
    .post("/ops/:tool{kubectl|ceph}", async (c) => {
      const body = parse(
        z.object({ args: z.array(z.string().max(4000)).min(1).max(80), stdin: z.string().max(1_000_000).optional() }),
        await c.req.json().catch(() => null),
      );
      const tool = c.req.param("tool") as "kubectl" | "ceph";
      const project = c.get("project" as never) as string;
      let result: CommandResult;
      try {
        result = await (tool === "kubectl" ? kubectl : ceph)(ops!.tools, body.args, body.stdin);
      } catch (err) {
        if (err instanceof OpsRefused) return c.json({ refused: err.message }, 400);
        throw err;
      }
      // The audit: who ran what, and how it ended (the input itself may hold secrets: only its size).
      console.log(JSON.stringify({ event: "ops.command", project, tool, args: body.args, stdinBytes: body.stdin?.length ?? 0, exitCode: result.exitCode, durationMs: result.durationMs }));
      return c.json(result);
    })

    // Osiris's API for the twin's chat: the signed-in user's own calls, passed on to Osiris's gateway (which checks
    // the token itself) with the twin's project unless the PWA names one.
    .all("/osiris/api/*", async (c) => {
      if (!config.OSIRIS_URL) throw new HttpError(404, "errors.digitalTwin.notFound");
      const url = new URL(c.req.url);
      const headers = new Headers();
      for (const name of ["authorization", "content-type", "accept", "accept-language", "x-project-id"]) {
        const value = c.req.header(name);
        if (value) headers.set(name, value);
      }
      if (!headers.has("x-project-id") && config.OSIRIS_PROJECT) headers.set("x-project-id", config.OSIRIS_PROJECT);
      const res = await (options.fetchFn ?? fetch)(`${config.OSIRIS_URL}${url.pathname.slice("/osiris".length)}${url.search}`, {
        method: c.req.method,
        headers,
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
        // @ts-expect-error Node's fetch streams a request body only half-duplex.
        duplex: "half",
        signal: c.req.raw.signal,
      });
      const out = new Headers();
      for (const name of ["content-type", "content-disposition", "cache-control", "x-osiris-sleeping"]) {
        const value = res.headers.get(name);
        if (value) out.set(name, value);
      }
      return new Response(res.body, { status: res.status, headers: out });
    })

    // The PWA reads this before signing in (oidc-client-ts): where osiris-auth is and who to sign in as.
    .get("/auth-config.json", (c) => c.json(config.AUTH_URL ? { issuer: config.AUTH_URL, clientId: config.WEB_CLIENT_ID } : null))

    .use("/api/*", async (c, next) => {
      if (!verifier) return next(); // No AUTH_URL: development without sign-in.
      const token = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
      if (!token && verifier.optional) {
        c.set("identity", await verifier.identify(""));
        return next();
      }
      if (!token) throw new HttpError(401, "errors.digitalTwin.signedIn");
      c.set("identity", await verifier.identify(token));
      await next();
    })
    .get("/api/me", (c) => c.json(c.get("identity") ?? null))

    // The twin, in the shape of the Azure Digital Twins API: models, twins and their relationships.
    .get("/api/models", async (c) => c.json({ value: await store.models() }))
    .get("/api/models/:id", async (c) => {
      const model = (await store.models()).find((m) => m.id === c.req.param("id"));
      if (!model) throw new HttpError(404, "errors.digitalTwin.notFound");
      return c.json(model);
    })
    .get("/api/digitaltwins", async (c) => {
      const { at } = parse(atQuery, c.req.query());
      const state = at === undefined ? { twins: await store.twins() } : await cached("twins-at", { at }, config.CACHE_DATA_TTL_SECONDS, () => stateAt(at));
      return c.json({ value: state.twins });
    })
    .get("/api/relationships", async (c) => {
      const { at } = parse(atQuery, c.req.query());
      const state = at === undefined ? { relationships: await store.relationships() } : await cached("twins-at", { at }, config.CACHE_DATA_TTL_SECONDS, () => stateAt(at));
      return c.json({ value: state.relationships });
    })
    .get("/api/digitaltwins/:id", async (c) => {
      const twin = await store.twin(c.req.param("id"));
      if (!twin) throw new HttpError(404, "errors.digitalTwin.notFound");
      return c.json(twin);
    })
    .get("/api/digitaltwins/:id/relationships", async (c) => c.json({ value: await store.relationships({ source: c.req.param("id") }) }))
    .get("/api/digitaltwins/:id/incomingrelationships", async (c) =>
      c.json({ value: (await store.relationships({ target: c.req.param("id") })).map((r) => ({ $relationshipId: r.$relationshipId, $sourceId: r.$sourceId, $relationshipName: r.$relationshipName })) }),
    )
    // A twin's changes and its descendants' (newest first), and how far back the history goes.
    .get("/api/digitaltwins/:id/history", async (c) => {
      const f = parse(rangeQuery.and(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) })), c.req.query());
      const dtId = c.req.param("id");
      return c.json({ value: await cached("history", { ...f, dtId }, config.CACHE_DATA_TTL_SECONDS, () => failing(() => h().changes({ ...f, dtId }))) });
    })
    .get("/api/history/range", async (c) => c.json(await failing(() => h().range())))
    // The telemetry the models declare: `errorLogs`, each twin's error log records of the 15 minutes before `at`.
    .get("/api/telemetry/errorLogs", async (c) => {
      const { at } = parse(atQuery, c.req.query());
      const value = await cached("errorLogs", { at: at ?? Date.now() }, config.CACHE_DATA_TTL_SECONDS, async () => {
        if (!telemetry || !source.errorAttributes?.length) return {};
        const [{ twins }, counts] = await Promise.all([stateAt(at), failing(() => telemetry.errorCounts(source.errorAttributes!, at))]);
        return errorsByTwin(twins, source.errorAttributes, counts);
      });
      return c.json({ value });
    })
    // The models' `network` telemetry: each node's and pod's bytes per second over the 5 minutes before `at`.
    .get("/api/telemetry/network", async (c) => {
      const { at } = parse(atQuery, c.req.query());
      const value = await cached("network", { at: at ?? Date.now() }, config.CACHE_DATA_TTL_SECONDS, async () => {
        if (!telemetry || !source.networkMetrics?.length) return {};
        const [{ twins }, ...rates] = await Promise.all([stateAt(at), ...source.networkMetrics.map((m) => failing(() => telemetry.rates(m.metric, m.attributes, at)))]);
        const out: Record<string, number> = {};
        source.networkMetrics.forEach((m, i) => valuesByTwin(twins, m.attributes, rates[i]!, out));
        return out;
      });
      return c.json({ value });
    })
    // The models' storage telemetry (`used`, `fsCapacity`): each volume claim's filesystem, its size and used bytes.
    .get("/api/telemetry/storage", async (c) => {
      const { at } = parse(atQuery, c.req.query());
      const value = await cached("storage", { at: at ?? Date.now() }, config.CACHE_DATA_TTL_SECONDS, async () => {
        const m = source.storageMetrics;
        if (!telemetry || !m) return {};
        const [{ twins }, capacity, available] = await Promise.all([
          stateAt(at),
          failing(() => telemetry.latest(m.capacity, m.attributes, at)),
          failing(() => telemetry.latest(m.available, m.attributes, at)),
        ]);
        const fs = valuesByTwin(twins, m.attributes, capacity);
        const free = valuesByTwin(twins, m.attributes, available);
        return Object.fromEntries(
          Object.entries(fs).flatMap(([id, size]) => (free[id] === undefined ? [] : [[id, { used: Math.max(0, size - free[id]), fsCapacity: size }]])),
        );
      });
      return c.json({ value });
    })
    .get("/api/facets", async (c) => {
      const f = parse(rangeQuery.and(z.object({ namespace: text })), c.req.query());
      return c.json(await cached("facets", f, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t().facets(f))));
    })
    // How many log records match the logs page's filters over time, by severity (about 60 bars across the range).
    .get("/api/logs/histogram", async (c) => {
      const f = parse(rangeQuery.and(logFilters), c.req.query());
      const step = Math.max(10, Math.round((f.to - f.from) / 1000 / 60 / 10) * 10);
      return c.json({ step, buckets: await cached("log-histogram", { ...f, step }, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t().logHistogram({ ...f, step }))) });
    })
    // Dashboards: named sets of panels over the telemetry, shared by everyone who may see the twin.
    .get("/api/dashboards", async (c) => c.json({ value: await store.dashboards() }))
    .get("/api/dashboards/:id", async (c) => {
      const d = await store.dashboard(c.req.param("id"));
      if (!d) throw new HttpError(404, "errors.digitalTwin.dashboardNotFound");
      return c.json(d);
    })
    .put("/api/dashboards/:id", async (c) => {
      const id = parse(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), c.req.param("id"));
      const body = parse(dashboardBody, await c.req.json().catch(() => null));
      if (!(await store.dashboard(id)) && (await store.countDashboards()) >= MAX_DASHBOARDS) throw new HttpError(409, "errors.digitalTwin.tooManyDashboards");
      const who = c.get("identity");
      const saved = { id, ...body, updatedAt: Date.now(), updatedBy: who?.name ?? who?.email ?? who?.sub ?? "dev" };
      await store.saveDashboard(saved);
      return c.json(saved);
    })
    .delete("/api/dashboards/:id", async (c) => {
      if (!(await store.deleteDashboard(c.req.param("id")))) throw new HttpError(404, "errors.digitalTwin.dashboardNotFound");
      return c.body(null, 204);
    })
    // The signed-in user's saved filters of a telemetry page (their own, never another's).
    .get("/api/me/filters", async (c) => {
      const { kind } = parse(z.object({ kind: filterKind }), c.req.query());
      return c.json({ value: await store.savedFilters(owner(c), kind) });
    })
    .put("/api/me/filters/:id", async (c) => {
      const id = parse(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), c.req.param("id"));
      const body = parse(
        z.object({
          kind: filterKind,
          name: z.string().trim().min(1).max(80),
          filter: filterValues,
        }),
        await c.req.json().catch(() => null),
      );
      const who = owner(c);
      const existing = (await store.savedFilters(who, body.kind)).find((f) => f.id === id);
      if (!existing && (await store.countSavedFilters(who)) >= MAX_SAVED_FILTERS) throw new HttpError(409, "errors.digitalTwin.tooManyFilters");
      const saved = { id, ...body, createdAt: existing?.createdAt ?? Date.now() };
      await store.saveFilter(who, saved);
      return c.json(saved);
    })
    .delete("/api/me/filters/:id", async (c) => {
      if (!(await store.deleteFilter(owner(c), c.req.param("id")))) throw new HttpError(404, "errors.digitalTwin.filterNotFound");
      return c.body(null, 204);
    })
    .get("/api/logs", async (c) => {
      const f = parse(rangeQuery.and(logFilters).and(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) })), c.req.query());
      return c.json(await cached("logs", f, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t().logs(f))));
    })
    .get("/api/traces", async (c) => {
      const f = parse(
        rangeQuery.and(
          z.object({
            service: text,
            ...scope,
            q: text,
            minMs: z.coerce.number().int().min(0).optional(),
            errors: z.enum(["true", "false"]).optional(),
            limit: z.coerce.number().int().min(1).max(500).default(100),
          }),
        ),
        c.req.query(),
      );
      return c.json(await cached("traces", { ...f, errors: f.errors === "true" }, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t().traces({ ...f, errors: f.errors === "true" }))));
    })
    .get("/api/trace/:id", async (c) => {
      const id = parse(z.string().regex(/^[0-9a-f]{32}$/), c.req.param("id"));
      return c.json(await cached("trace", { id }, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t().trace(id))));
    })
    .get("/api/metrics", async (c) => {
      const f = parse(rangeQuery.and(z.object({ q: text })), c.req.query());
      return c.json(await cached("metrics", f, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t().metrics(f, f.q))));
    })
    .get("/api/series", async (c) => {
      const f = parse(
        rangeQuery.and(
          z.object({
            name: z.string().min(1).max(300),
            type: z.enum(["gauge", "sum", "histogram"]),
            groupBy: z.string().max(100).regex(/^[A-Za-z0-9_.\-/]*$/).optional(),
            service: text,
            ...scope,
          }),
        ),
        c.req.query(),
      );
      // About 120 points across the range, at least a minute apart.
      const step = Math.max(60, Math.round((f.to - f.from) / 1000 / 120 / 60) * 60);
      const query = { ...f, step };
      const series = await cached("series", query, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t().series({ ...f, type: f.type as MetricType, step })));
      return c.json({ step, series });
    })

    // The PWA itself: its files, and its index.html for every other path (one page app).
    .use("*", staticDir ? serveStatic({ root: staticDir }) : async (c: Context) => c.notFound())
    .get("*", page);

  return app;
}
