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
import { errorsByTwin, type TwinSource } from "./twin.ts";
import type { MetricType, Telemetry } from "./telemetry.ts";

const HOUR = 3_600_000;
/** At most 31 days back (the data's retention is 30). */
const rangeQuery = z
  .object({ from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() })
  .transform(({ from, to }) => {
    const end = to ?? Date.now();
    return { from: Math.max(from ?? end - HOUR, end - 31 * 24 * HOUR), to: end };
  });
const text = z.string().trim().max(200).optional();
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value, { reportInput: true });
  if (!r.success) throw new ValidationError(r.error);
  return r.data;
};

// Own scripts and styles only; data and pictures from this origin (the theme's data-URI icons). The PWA signs in
// from the browser (oidc-client-ts reads osiris-auth's discovery and redeems the code there), so it may also call
// osiris-auth's origin.
const csp = (authUrl?: string) =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${authUrl ? ` ${new URL(authUrl).origin}` : ""}; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'`;

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
  const { source, store, telemetry, verifier, cache, staticDir, history } = options;
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
    .get("/api/facets", async (c) => {
      const f = parse(rangeQuery, c.req.query());
      return c.json(await cached("facets", f, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t().facets(f))));
    })
    .get("/api/logs", async (c) => {
      const f = parse(
        rangeQuery.and(
          z.object({
            service: text,
            namespace: text,
            pod: text,
            severity: z.enum(["debug", "info", "warn", "error", "fatal"]).optional(),
            q: text,
            traceId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
            limit: z.coerce.number().int().min(1).max(1000).default(200),
          }),
        ),
        c.req.query(),
      );
      return c.json(await cached("logs", f, config.CACHE_DATA_TTL_SECONDS, () => failing(() => t().logs(f))));
    })
    .get("/api/traces", async (c) => {
      const f = parse(
        rangeQuery.and(
          z.object({
            service: text,
            namespace: text,
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
            namespace: text,
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
