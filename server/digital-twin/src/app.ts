import type { AlertsClient } from "./alerts-client.ts";
import { createHash } from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { errorResponse, HttpError, requestLocale, ValidationError } from "@osiris/platform/i18n.ts";
import { ServiceError } from "@osiris/platform/http.ts";
import { telemetryMiddleware } from "@osiris/platform/telemetry.ts";
import { isAdmin, maySee, type Identity, type TokenVerifier } from "./auth.ts";
import type { Cache } from "./cache.ts";
import type { Config } from "./config.ts";
import type { Instances, RunningInstance } from "./instances.ts";
import { errorsByTwin, valuesByTwin } from "./twin.ts";
import type { TelemetryKind, TelemetryState, TwinStateStore } from "./state.ts";
import { DATA_ID, dataProfileErrors, dataProfilesOf, interfaceErrors, presentationErrors, type DigitalTwin, type DtdlInterface, type DtdlModelData } from "@osiris/shared/dtdl.ts";
import { bindingErrors, CONNECTOR_TYPES } from "./data/connectors.ts";
import type { DataValueStore } from "./data/hub.ts";
import type { MetricType } from "./telemetry.ts";
import { secretFields } from "./sources/registry.ts";
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
type Env = { Variables: { identity: Identity; twin: RunningInstance } };
/** The signed-in user's id (development without sign-in: `dev`). */
const owner = (c: Context<Env>) => c.get("identity")?.sub ?? "dev";
/** The preferences a user keeps (each a JSON value of at most 32 kB). */
const preferenceKey = z.enum(["layout"]);
const MAX_PREFERENCE_BYTES = 32_768;
const instanceId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value, { reportInput: true });
  if (!r.success) throw new ValidationError(r.error);
  return r.data;
};

// Own scripts and styles only; data and pictures from this origin (the theme's data-URI icons). The PWA signs in
// from the browser (oidc-client-ts reads osiris-auth's discovery and redeems the code there), so it may also call
// osiris-auth's origin.
const csp = (authUrl?: string) =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:${authUrl ? ` ${new URL(authUrl).origin}` : ""}; media-src 'self' blob:; connect-src 'self'${authUrl ? ` ${new URL(authUrl).origin}` : ""}; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'`;

export interface AppOptions {
  /** The digital twins (instances), each with its source, data, telemetry and history. */
  instances: Instances;
  /** The cache the twins' current state, the view's telemetry and the collector's events live in (Redis). */
  state: TwinStateStore;
  verifier?: TokenVerifier;
  cache: Cache;
  staticDir?: string;
  /** kubectl and ceph for the agents of `projects`, whose runtimes `identity` recognizes. */
  ops?: { tools: OpsTools; identity: RuntimeIdentityVerifier; projects: string[] };
  /** Replaces global fetch for the Osiris proxy (tests). */
  fetchFn?: typeof fetch;
  /** The alerts service: each twin's alerts and the conversations that investigated them. */
  alerts?: AlertsClient;
  /** The data hubs' values (each twin's telemetry from its models' data profiles). */
  values?: DataValueStore;
}

/**
 * Osiris Digital Twin's HTTP app. It holds any number of digital twins (instances, `/api/instances`; admins manage
 * them at `/api/admin/instances`), each in the shape of the Azure Digital Twins API, DTDL's de facto instance format,
 * under `/api/instances/{instance}`: `/models` (DTDL v3 interfaces; admins may edit them — PUT/POST/DELETE — and give
 * them a `presentation` section that says how the views draw their twins), `/digitaltwins/{id}`, its relationships and
 * incoming relationships, plus the lists the PWA draws from (`/digitaltwins`, `/relationships`; `?at=` for a past
 * time), each twin's history, the warn/error events the collector caught (`/events`), and the telemetry the view draws.
 * The current state (twins, relationships, view telemetry) comes from the cache (Redis); the definitions (models,
 * instances, dashboards, filters) from SQLite; the time series (telemetry pages, history) from OpenTelemetry's
 * ClickHouse. Sign-in is osiris-auth's: the PWA signs in with OIDC, the API introspects the token; the admin group
 * sees every instance, the group `twin:<id>` that one.
 */
export function createApp(config: Config, options: AppOptions) {
  const { instances, state, verifier, cache, staticDir, ops } = options;
  const store = instances.store;
  const CSP = csp(config.AUTH_URL);
  const page = staticDir ? serveStatic({ root: staticDir, path: "index.html" }) : async (c: Context) => c.notFound();
  const ADMIN = config.AUTH_ADMIN_GROUP;

  /** An endpoint whose answer is cached: the key a hash of the query, the value fresh when the key misses. Epoch
   * times are bucketed to the TTL before hashing, so a repeated question (the pages' `now`-anchored ranges) hits. */
  const cached = async <T>(tw: RunningInstance, name: string, query: Record<string, unknown>, ttlSeconds: number, load: () => Promise<T>): Promise<T> => {
    const key = `twin:${tw.record.id}:${tw.record.updatedAt}:${name}:${createHash("sha256")
      .update(JSON.stringify(query, (_, v) => (typeof v === "number" && v > 1e12 ? Math.floor(v / (ttlSeconds * 1000)) : v)))
      .digest("hex")}`;
    const hit = await cache.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await load();
    await cache.set(key, value, ttlSeconds);
    return value;
  };

  /** The cluster name a twin's telemetry and events carry (its source's setting, else its id). */
  const clusterOf = (tw: RunningInstance) => String(tw.record.settings.clusterName || tw.record.id);
  const h = (tw: RunningInstance) => {
    if (!tw.history) throw new HttpError(503, "errors.digitalTwin.historyOff");
    return tw.history;
  };
  const t = (tw: RunningInstance) => {
    if (!tw.telemetry) throw new HttpError(503, "errors.telemetryOff");
    return tw.telemetry;
  };
  /** The twins and relationships now (the Redis cache the sync writes) or at a past time (the history). */
  const stateAt = async (tw: RunningInstance, at: number | undefined) => {
    if (at === undefined) return { twins: await state.twins(tw.record.id), relationships: await state.relationships(tw.record.id) };
    const past = await failing(() => h(tw).stateAt(Math.min(at, Date.now())));
    if (!past) throw new HttpError(404, "errors.digitalTwin.historyMissing");
    return past;
  };
  /** The telemetry the view draws, now (the cache) or at a past time (ClickHouse). */
  const telemetryAt = async <K extends TelemetryKind>(tw: RunningInstance, kind: K, at: number | undefined): Promise<TelemetryState[K]> => {
    if (at === undefined) return (await state.telemetry(tw.record.id, kind)) as TelemetryState[K];
    return (await cached(tw, kind, { at }, config.CACHE_DATA_TTL_SECONDS, async (): Promise<unknown> => {
      const { source, telemetry } = tw;
      const { twins } = await stateAt(tw, at);
      if (kind === "errorLogs") {
        if (!telemetry || !source?.errorAttributes?.length) return {};
        return errorsByTwin(twins, source.errorAttributes, await failing(() => telemetry.errorCounts(source.errorAttributes!, at)));
      }
      if (kind === "network") {
        const metrics = source?.networkMetrics;
        if (!telemetry || !metrics?.length) return {};
        const rates = await Promise.all(metrics.map((m) => failing(() => telemetry.rates(m.metric, m.attributes, at))));
        const out: Record<string, number> = {};
        metrics.forEach((m, i) => valuesByTwin(twins, m.attributes, rates[i]!, out));
        return out;
      }
      const m = source?.storageMetrics;
      if (!telemetry || !m) return {};
      const [capacity, available] = await Promise.all([failing(() => telemetry.latest(m.capacity, m.attributes, at)), failing(() => telemetry.latest(m.available, m.attributes, at))]);
      const fs = valuesByTwin(twins, m.attributes, capacity);
      const free = valuesByTwin(twins, m.attributes, available);
      return Object.fromEntries(Object.entries(fs).flatMap(([id, size]) => (free[id] === undefined ? [] : [[id, { used: Math.max(0, size - free[id]!), fsCapacity: size }]])));
    })) as TelemetryState[K];
  };
  /** One model as the API lists it, or 404. */
  const modelOf = async (tw: RunningInstance, id: string): Promise<DtdlModelData> => {
    const model = (await tw.data.models()).find((m) => m.id === id);
    if (!model) throw new HttpError(404, "errors.digitalTwin.notFound");
    return model;
  };
  /** A model's errors against the model set (its own document included, so `extends` and `presentation.label` resolve). */
  const modelErrors = (doc: DtdlInterface, existing: DtdlModelData[]): string[] => {
    const models = new Map(existing.map((m) => [m.id, m.model] as [string, DtdlInterface]));
    models.set(doc["@id"], doc);
    return [...presentationErrors(doc["@id"], models), ...dataProfileErrors(doc["@id"], models)];
  };
  /** A model's data bindings against the instance's connections: each names one, with that connector's parameters. */
  const bindingProblems = async (tw: RunningInstance, doc: DtdlInterface): Promise<string[]> => {
    if (!doc.dataProfiles?.length) return [];
    const types = new Map((await store.connections(tw.record.id)).map((c) => [c.id, CONNECTOR_TYPES[c.type]]));
    return doc.dataProfiles.flatMap((p) => [
      ...p.bindings.flatMap((b) => bindingErrors(b, types.get(b.connection)).map((e) => `${doc["@id"]}: profile ${p.name}: ${e}`)),
      ...(p.simulator && types.get(p.simulator.connection)?.mode !== "simulator" ? [`${doc["@id"]}: profile ${p.name}: simulator ${p.simulator.connection} is no simulation connection`] : []),
    ]);
  };
  const T = "/api/instances/:instance";
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

  /** The instance a twin route is about (checked by the middleware). */
  const twinOf = (c: Context<Env>) => c.get("twin");
  /** Admin routes: the admin group only. */
  const adminOnly = (c: Context<Env>) => {
    if (!isAdmin(c.get("identity"), ADMIN)) throw new HttpError(403, "errors.digitalTwin.adminOnly");
  };
  /** An instance as its viewers see it: name, source type and whether it runs. */
  const summary = (r: RunningInstance) => ({ id: r.record.id, name: r.record.name, sourceType: r.record.sourceType, error: r.error ?? null });

  const app = new Hono<Env>()
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
    // The warn/error events the collector's twin/events processor caught (the Redis stream), for the agent of an
    // allowed project: which instance's cluster they are about (the only one by default), how many, how severe.
    .get("/ops/events", async (c) => {
      const q = parse(
        z.object({ instance: instanceId.optional(), limit: z.coerce.number().int().min(1).max(500).default(50), severity: z.enum(["warn", "error", "fatal"]).optional(), cluster: text }),
        c.req.query(),
      );
      const id = q.instance ?? instances.list()[0]?.record.id;
      if (!id || !instances.get(id)) throw new HttpError(404, "errors.digitalTwin.instanceNotFound");
      return c.json({ value: await state.events({ limit: q.limit, severity: q.severity, cluster: q.cluster }) });
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
    .get("/api/me", (c) => {
      const identity = c.get("identity");
      return c.json(identity ? { ...identity, admin: isAdmin(identity, ADMIN) } : null);
    })
    // The signed-in user's own preferences, the same in every twin (the layout of the windows over it).
    .get("/api/me/preferences/:key", async (c) => {
      const key = parse(preferenceKey, c.req.param("key"));
      return c.json({ value: (await store.preference(owner(c), key)) ?? null });
    })
    .put("/api/me/preferences/:key", async (c) => {
      const key = parse(preferenceKey, c.req.param("key"));
      const text = await c.req.text();
      if (text.length > MAX_PREFERENCE_BYTES) throw new HttpError(413, "errors.digitalTwin.preferenceTooLarge");
      const body = parse(z.object({ value: z.unknown() }), (() => { try { return JSON.parse(text); } catch { return null; } })());
      await store.savePreference(owner(c), key, body.value ?? null, Date.now());
      return c.body(null, 204);
    })

    // The twins the user may see (an admin all of them).
    .get("/api/instances", (c) => c.json({ value: instances.list().filter((r) => maySee(c.get("identity"), ADMIN, r.record.id)).map(summary) }))
    // Admins: the kinds of system a twin can mirror (each with its settings form), and the instances themselves.
    .get("/api/source-types", (c) => {
      adminOnly(c);
      return c.json({ value: instances.typeList().map((t) => ({ id: t.id, fields: t.fields })) });
    })
    .get("/api/admin/instances", (c) => {
      adminOnly(c);
      return c.json({ value: instances.list().map((r) => ({ ...r.record, error: r.error ?? null })) });
    })
    .put("/api/admin/instances/:id", async (c) => {
      adminOnly(c);
      const id = parse(instanceId, c.req.param("id"));
      const body = parse(
        z.object({
          name: z.string().trim().min(1).max(80),
          sourceType: z.string().max(40),
          settings: z.record(z.string(), z.string().max(4000)).default({}),
          // A string sets a secret, null removes it, one not named stays.
          secrets: z.record(z.string(), z.string().max(200_000).nullable()).default({}),
        }),
        await c.req.json().catch(() => null),
      );
      const type = instances.type(body.sourceType);
      if (!type) throw new HttpError(400, "errors.digitalTwin.sourceType");
      const settings = parse(type.settings, body.settings);
      const allowed = new Set(secretFields(type));
      const secrets = Object.fromEntries(Object.entries(body.secrets).filter(([k, v]) => allowed.has(k) && v !== ""));
      await store.putInstance({ id, name: body.name, sourceType: type.id, settings, secrets }, Date.now());
      const running = (await instances.restart(id))!;
      return c.json({ ...running.record, error: running.error ?? null });
    })
    .delete("/api/admin/instances/:id", async (c) => {
      adminOnly(c);
      if (!(await instances.delete(c.req.param("id")))) throw new HttpError(404, "errors.digitalTwin.instanceNotFound");
      return c.body(null, 204);
    })

    // Admins: the kinds of data source a twin's models can read (their forms), and each twin's connections to them:
    // settings in the clear, secrets write-only (sealed; only their names come back), every change checked by the
    // connector's own schema.
    .get("/api/connector-types", (c) => {
      adminOnly(c);
      return c.json({ value: Object.values(CONNECTOR_TYPES).map((t) => ({ id: t.id, mode: t.mode, fields: t.fields })) });
    })
    .get("/api/admin/instances/:id/connections", async (c) => {
      adminOnly(c);
      return c.json({ value: await store.connections(c.req.param("id")) });
    })
    .put("/api/admin/instances/:id/connections/:conn", async (c) => {
      adminOnly(c);
      const running = instances.get(c.req.param("id"));
      if (!running) throw new HttpError(404, "errors.digitalTwin.instanceNotFound");
      const conn = parse(z.string().regex(DATA_ID), c.req.param("conn"));
      const body = parse(
        z.object({
          name: z.string().trim().min(1).max(80),
          type: z.string().max(40),
          settings: z.record(z.string(), z.string().max(20_000)).default({}),
          secrets: z.record(z.string(), z.string().max(20_000).nullable()).default({}),
        }),
        await c.req.json().catch(() => null),
      );
      const type = Object.hasOwn(CONNECTOR_TYPES, body.type) ? CONNECTOR_TYPES[body.type] : undefined;
      if (!type) throw new HttpError(400, "errors.digitalTwin.connectorType");
      const settings = parse(type.settings, body.settings);
      const allowed = new Set(type.fields.filter((f) => f.secret).map((f) => f.name));
      const secrets = Object.fromEntries(Object.entries(body.secrets).filter(([k, v]) => allowed.has(k) && v !== ""));
      const saved = await store.putConnection(running.record.id, { id: conn, name: body.name, type: type.id, settings, secrets }, Date.now());
      running.hub?.reload();
      return c.json(saved);
    })
    .delete("/api/admin/instances/:id/connections/:conn", async (c) => {
      adminOnly(c);
      const running = instances.get(c.req.param("id"));
      if (!running) throw new HttpError(404, "errors.digitalTwin.instanceNotFound");
      const conn = c.req.param("conn");
      // A connection a model's profile still reads stays (the models would bind to nothing).
      const users = (await running.data.models()).filter((m) => (m.model.dataProfiles ?? []).some((p) => p.bindings.some((b) => b.connection === conn) || p.simulator?.connection === conn));
      if (users.length) return c.json({ error: "errors.digitalTwin.connectionInUse", detail: users.map((m) => m.id) }, 409);
      if (!(await store.deleteConnection(running.record.id, conn))) throw new HttpError(404, "errors.digitalTwin.notFound");
      running.hub?.reload();
      return c.body(null, 204);
    })
    .post("/api/admin/instances/:id/connections/:conn/check", async (c) => {
      adminOnly(c);
      const record = await store.connection(c.req.param("id"), c.req.param("conn"));
      const type = record && CONNECTOR_TYPES[record.type];
      if (!record || !type) throw new HttpError(404, "errors.digitalTwin.notFound");
      const connector = type.create(record.settings as Record<string, string>, record.secrets, { fetchFn: options.fetchFn });
      try {
        await connector.check();
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      } finally {
        await connector.close?.().catch(() => {});
      }
    })

    // One twin: only its viewers (an admin, or a member of its group) reach it.
    .use("/api/instances/:instance/*", async (c, next) => {
      const id = c.req.param("instance");
      const running = instances.get(id);
      if (!running || !maySee(c.get("identity"), ADMIN, id)) throw new HttpError(404, "errors.digitalTwin.instanceNotFound");
      c.set("twin", running);
      await next();
    })

    // The twin, in the shape of the Azure Digital Twins API: models, twins and their relationships. The models are
    // DTDL v3 and editable: an admin upserts one (PUT/POST) or decommissions it (DELETE, refused while a twin
    // instantiates it); a `presentation` section on a model says how the views draw its twins.
    .get(`${T}/models`, async (c) => c.json({ value: await twinOf(c).data.models() }))
    .get(`${T}/models/:id`, async (c) => {
      const model = (await twinOf(c).data.models()).find((m) => m.id === c.req.param("id"));
      if (!model) throw new HttpError(404, "errors.digitalTwin.notFound");
      return c.json(model);
    })
    .put(`${T}/models/:id`, async (c) => {
      adminOnly(c);
      const tw = twinOf(c);
      const id = c.req.param("id");
      const doc = parse(z.record(z.string(), z.unknown()), await c.req.json().catch(() => null)) as unknown as DtdlInterface;
      if (doc["@id"] !== id) throw new HttpError(400, "errors.digitalTwin.modelIdMismatch");
      const errors = [...interfaceErrors(doc), ...modelErrors(doc, await tw.data.models())];
      if (!errors.length) errors.push(...(await bindingProblems(tw, doc)));
      if (errors.length) return c.json({ error: "errors.digitalTwin.modelInvalid", detail: errors }, 400);
      await tw.data.putModel(doc, Date.now());
      tw.hub?.reload();
      return c.json(await modelOf(tw, id));
    })
    .post(`${T}/models`, async (c) => {
      adminOnly(c);
      const tw = twinOf(c);
      const docs = parse(z.array(z.record(z.string(), z.unknown())).min(1).max(100), await c.req.json().catch(() => null)) as unknown as DtdlInterface[];
      const errors: string[] = [];
      const models = await tw.data.models();
      for (const doc of docs) errors.push(...interfaceErrors(doc), ...modelErrors(doc, models));
      if (!errors.length) for (const doc of docs) errors.push(...(await bindingProblems(tw, doc)));
      if (errors.length) return c.json({ error: "errors.digitalTwin.modelInvalid", detail: errors }, 400);
      for (const doc of docs) await tw.data.putModel(doc, Date.now());
      tw.hub?.reload();
      return c.json({ value: await tw.data.models() });
    })
    .delete(`${T}/models/:id`, async (c) => {
      adminOnly(c);
      const tw = twinOf(c);
      const id = c.req.param("id");
      const used = (await state.twins(tw.record.id)).some((t) => t.$metadata.$model === id);
      if (used) throw new HttpError(409, "errors.digitalTwin.modelInUse");
      if (!(await tw.data.deleteModel(id))) throw new HttpError(404, "errors.digitalTwin.notFound");
      return c.body(null, 204);
    })
    .get(`${T}/digitaltwins`, async (c) => {
      const { at } = parse(atQuery, c.req.query());
      const twins = at === undefined ? (await stateAt(twinOf(c), undefined)).twins : (await cached(twinOf(c), "twins-at", { at }, config.CACHE_DATA_TTL_SECONDS, () => stateAt(twinOf(c), at))).twins;
      return c.json({ value: twins });
    })
    .get(`${T}/relationships`, async (c) => {
      const { at } = parse(atQuery, c.req.query());
      const rels = at === undefined ? (await stateAt(twinOf(c), undefined)).relationships : (await cached(twinOf(c), "twins-at", { at }, config.CACHE_DATA_TTL_SECONDS, () => stateAt(twinOf(c), at))).relationships;
      return c.json({ value: rels });
    })
    .get(`${T}/digitaltwins/:id`, async (c) => {
      const { at } = parse(atQuery, c.req.query());
      const twin = at === undefined ? await state.twin(twinOf(c).record.id, c.req.param("id")) : (await stateAt(twinOf(c), at)).twins.find((t) => t.$dtId === c.req.param("id"));
      if (!twin) throw new HttpError(404, "errors.digitalTwin.notFound");
      return c.json(twin);
    })
    .get(`${T}/digitaltwins/:id/relationships`, async (c) => {
      const { at } = parse(atQuery, c.req.query());
      const rels = at === undefined ? await state.relationships(twinOf(c).record.id, { source: c.req.param("id") }) : (await stateAt(twinOf(c), at)).relationships.filter((r) => r.$sourceId === c.req.param("id"));
      return c.json({ value: rels });
    })
    .get(`${T}/digitaltwins/:id/incomingrelationships`, async (c) => {
      const { at } = parse(atQuery, c.req.query());
      const rels = at === undefined ? await state.relationships(twinOf(c).record.id, { target: c.req.param("id") }) : (await stateAt(twinOf(c), at)).relationships.filter((r) => r.$targetId === c.req.param("id"));
      return c.json({ value: rels.map((r) => ({ $relationshipId: r.$relationshipId, $sourceId: r.$sourceId, $relationshipName: r.$relationshipName })) });
    })
    // The twin's data profiles (from its models), the active one and what its hub does now (connection errors only
    // for admins: they may name hosts); admins switch the profile. Each twin's values under the active profile.
    .get(`${T}/data`, async (c) => {
      const tw = twinOf(c);
      const models = await tw.data.models();
      const map = new Map(models.map((m) => [m.id, m.model] as [string, DtdlInterface]));
      const profiles = new Map<string, { name: string; kind: string; description?: string; models: string[] }>();
      for (const m of models)
        for (const p of dataProfilesOf(m.id, map)) {
          const e = profiles.get(p.name) ?? { name: p.name, kind: p.kind, description: p.description, models: [] };
          e.models.push(m.id);
          profiles.set(p.name, e);
        }
      const status = tw.hub?.status();
      const admin = isAdmin(c.get("identity"), ADMIN);
      return c.json({
        active: await store.activeProfile(tw.record.id),
        profiles: [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name)),
        status: status && { ...status, connections: Object.fromEntries(Object.entries(status.connections).map(([k, v]) => [k, admin ? v : { tasks: v.tasks, lastValueAt: v.lastValueAt }])) },
      });
    })
    .put(`${T}/data/profile`, async (c) => {
      adminOnly(c);
      const tw = twinOf(c);
      const { profile } = parse(z.object({ profile: z.string().regex(DATA_ID) }), await c.req.json().catch(() => null));
      await store.setActiveProfile(tw.record.id, profile, Date.now());
      tw.hub?.reload();
      return c.json({ active: profile });
    })
    .get(`${T}/data/values`, async (c) => {
      const tw = twinOf(c);
      const { twin } = parse(z.object({ twin: z.string().max(500).optional() }), c.req.query());
      if (!options.values) return c.json({ value: {} });
      const active = await store.activeProfile(tw.record.id);
      const all = await options.values.read(tw.record.id, twin);
      // Only the active profile's: a switch leaves no stale values from the other.
      const value = Object.fromEntries(
        Object.entries(all)
          .map(([id, v]) => [id, Object.fromEntries(Object.entries(v).filter(([, p]) => p.profile === active))] as const)
          .filter(([, v]) => Object.keys(v).length),
      );
      return c.json({ value });
    })
    // The twin's alerts (the alerts service's, of the cluster the twin mirrors), and the conversation in which
    // Osiris investigated one, read by the service as its own account: viewers of the twin read it, never write it.
    .get(`${T}/alerts`, async (c) => {
      if (!options.alerts) return c.json({ value: [] });
      const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), c.req.query());
      return c.json({ value: await failing(() => options.alerts!.list(clusterOf(twinOf(c)), limit)) });
    })
    .get(`${T}/alerts/:id/messages`, async (c) => {
      const alert = options.alerts && (await failing(() => options.alerts!.get(c.req.param("id"))));
      if (!alert || alert.cluster !== clusterOf(twinOf(c))) throw new HttpError(404, "errors.digitalTwin.notFound");
      return c.json(await failing(() => options.alerts!.messages(alert.id)));
    })
    // The warn/error log records the collector caught (its `twin/events` processor wrote them to the events stream).
    .get(`${T}/events`, async (c) => {
      const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), cluster: text, severity: z.enum(["warn", "error", "fatal"]).optional() }), c.req.query());
      return c.json({ value: await cached(twinOf(c), "events", q, Math.min(config.CACHE_DATA_TTL_SECONDS, 5), () => state.events(q)) });
    })
    // A twin's changes and its descendants' (newest first), and how far back the history goes.
    .get(`${T}/digitaltwins/:id/history`, async (c) => {
      const f = parse(rangeQuery.and(z.object({ limit: z.coerce.number().int(twinOf(c)).min(1).max(500).default(100) })), c.req.query());
      const dtId = c.req.param("id");
      return c.json({ value: await cached(twinOf(c), "history", { ...f, dtId }, config.CACHE_DATA_TTL_SECONDS, () => failing(() => h(twinOf(c)).changes({ ...f, dtId }))) });
    })
    .get(`${T}/history/range`, async (c) => c.json(await failing(() => h(twinOf(c)).range())))
    // The telemetry the models declare, now from the cache (the sync writes it), at a past time from ClickHouse:
    // `errorLogs`, each twin's error log records of the 15 minutes before `at`.
    .get(`${T}/telemetry/errorLogs`, async (c) => {
      const { at } = parse(atQuery, c.req.query());
      return c.json({ value: await telemetryAt(twinOf(c), "errorLogs", at) });
    })
    // The models' `network` telemetry: each node's and pod's bytes per second over the 5 minutes before `at`.
    .get(`${T}/telemetry/network`, async (c) => {
      const { at } = parse(atQuery, c.req.query());
      return c.json({ value: await telemetryAt(twinOf(c), "network", at) });
    })
    // The models' storage telemetry (`used`, `fsCapacity`): each volume claim's filesystem, its size and used bytes.
    .get(`${T}/telemetry/storage`, async (c) => {
      const { at } = parse(atQuery, c.req.query());
      return c.json({ value: await telemetryAt(twinOf(c), "storage", at) });
    })
    .get(`${T}/facets`, async (c) => {
      const f = parse(rangeQuery.and(z.object({ namespace: text })), c.req.query());
      return c.json(await cached(twinOf(c), "facets", f, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t(twinOf(c)).facets(f))));
    })
    // How many log records match the logs page's filters over time, by severity (about 60 bars across the range).
    .get(`${T}/logs/histogram`, async (c) => {
      const f = parse(rangeQuery.and(logFilters), c.req.query());
      const step = Math.max(10, Math.round((f.to - f.from) / 1000 / 60 / 10) * 10);
      return c.json({ step, buckets: await cached(twinOf(c), "log-histogram", { ...f, step }, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t(twinOf(c)).logHistogram({ ...f, step }))) });
    })
    // Dashboards: named sets of panels over the telemetry, shared by everyone who may see the twin.
    .get(`${T}/dashboards`, async (c) => c.json({ value: await twinOf(c).data.dashboards() }))
    .get(`${T}/dashboards/:id`, async (c) => {
      const d = await twinOf(c).data.dashboard(c.req.param("id"));
      if (!d) throw new HttpError(404, "errors.digitalTwin.dashboardNotFound");
      return c.json(d);
    })
    .put(`${T}/dashboards/:id`, async (c) => {
      const id = parse(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), c.req.param("id"));
      const body = parse(dashboardBody, await c.req.json().catch(() => null));
      if (!(await twinOf(c).data.dashboard(id)) && (await twinOf(c).data.countDashboards()) >= MAX_DASHBOARDS) throw new HttpError(409, "errors.digitalTwin.tooManyDashboards");
      const who = c.get("identity");
      const saved = { id, ...body, updatedAt: Date.now(), updatedBy: who?.name ?? who?.email ?? who?.sub ?? "dev" };
      await twinOf(c).data.saveDashboard(saved);
      return c.json(saved);
    })
    .delete(`${T}/dashboards/:id`, async (c) => {
      if (!(await twinOf(c).data.deleteDashboard(c.req.param("id")))) throw new HttpError(404, "errors.digitalTwin.dashboardNotFound");
      return c.body(null, 204);
    })
    // The signed-in user's saved filters of a telemetry page (their own, never another's).
    .get(`${T}/me/filters`, async (c) => {
      const { kind } = parse(z.object({ kind: filterKind }), c.req.query());
      return c.json({ value: await twinOf(c).data.savedFilters(owner(c), kind) });
    })
    .put(`${T}/me/filters/:id`, async (c) => {
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
      const existing = (await twinOf(c).data.savedFilters(who, body.kind)).find((f) => f.id === id);
      if (!existing && (await twinOf(c).data.countSavedFilters(who)) >= MAX_SAVED_FILTERS) throw new HttpError(409, "errors.digitalTwin.tooManyFilters");
      const saved = { id, ...body, createdAt: existing?.createdAt ?? Date.now() };
      await twinOf(c).data.saveFilter(who, saved);
      return c.json(saved);
    })
    .delete(`${T}/me/filters/:id`, async (c) => {
      if (!(await twinOf(c).data.deleteFilter(owner(c), c.req.param("id")))) throw new HttpError(404, "errors.digitalTwin.filterNotFound");
      return c.body(null, 204);
    })
    .get(`${T}/logs`, async (c) => {
      const f = parse(rangeQuery.and(logFilters).and(z.object({ limit: z.coerce.number().int(twinOf(c)).min(1).max(1000).default(200) })), c.req.query());
      return c.json(await cached(twinOf(c), "logs", f, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t(twinOf(c)).logs(f))));
    })
    .get(`${T}/traces`, async (c) => {
      const f = parse(
        rangeQuery.and(
          z.object({
            service: text,
            ...scope,
            q: text,
            minMs: z.coerce.number().int(twinOf(c)).min(0).optional(),
            errors: z.enum(["true", "false"]).optional(),
            limit: z.coerce.number().int(twinOf(c)).min(1).max(500).default(100),
          }),
        ),
        c.req.query(),
      );
      return c.json(await cached(twinOf(c), "traces", { ...f, errors: f.errors === "true" }, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t(twinOf(c)).traces({ ...f, errors: f.errors === "true" }))));
    })
    .get(`${T}/trace/:id`, async (c) => {
      const id = parse(z.string().regex(/^[0-9a-f]{32}$/), c.req.param("id"));
      return c.json(await cached(twinOf(c), "trace", { id }, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t(twinOf(c)).trace(id))));
    })
    .get(`${T}/metrics`, async (c) => {
      const f = parse(rangeQuery.and(z.object({ q: text })), c.req.query());
      return c.json(await cached(twinOf(c), "metrics", f, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t(twinOf(c)).metrics(f, f.q))));
    })
    .get(`${T}/series`, async (c) => {
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
      const series = await cached(twinOf(c), "series", query, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t(twinOf(c)).series({ ...f, type: f.type as MetricType, step })));
      return c.json({ step, series });
    })

    // The PWA itself: its files, and its index.html for every other path (one page app).
    .use("*", staticDir ? serveStatic({ root: staticDir }) : async (c: Context) => c.notFound())
    .get("*", page);

  return app;
}
