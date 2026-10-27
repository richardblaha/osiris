import type { LogRecord, MetricSeries } from "@osiris/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { HttpError, ValidationError } from "@osiris/platform/i18n.ts";
import type { MetricType, Telemetry } from "./clickhouse.ts";

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

/** The data of the Dashboards feature's panels (a system dashboard's logs and metric sources; under /api/admin). */
export function telemetryRoutes(telemetry?: Telemetry) {
  const t = () => {
    if (!telemetry) throw new HttpError(503, "errors.telemetryOff");
    return telemetry;
  };
  const failing = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      if (err instanceof HTTPException || err instanceof HttpError) throw err;
      console.error("Telemetry query failed", err);
      throw new HttpError(502, "errors.telemetry.queryFailed", { detail: (err as Error).message.slice(0, 300) });
    }
  };
  return new Hono()
    .get("/logs", async (c) => {
      const q = c.req.query();
      const f = parse(
        rangeQuery.and(
          z.object({
            service: text,
            namespace: text,
            severity: z.enum(["debug", "info", "warn", "error", "fatal"]).optional(),
            q: text,
            traceId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
            limit: z.coerce.number().int().min(1).max(1000).default(200),
          }),
        ),
        q,
      );
      return c.json<LogRecord[]>(await failing(() => t().logs(f)));
    })
    .get("/series", async (c) => {
      const f = parse(
        rangeQuery.and(
          z.object({
            name: z.string().min(1).max(300),
            type: z.enum(["gauge", "sum", "histogram"]),
            groupBy: z.string().max(100).regex(/^[A-Za-z0-9_.\-/]*$/).optional(),
            service: text,
          }),
        ),
        c.req.query(),
      );
      // About 120 points across the range, at least a minute apart.
      const step = Math.max(60, Math.round((f.to - f.from) / 1000 / 120 / 60) * 60);
      return c.json<{ step: number; series: MetricSeries[] }>({ step, series: await failing(() => t().series({ ...f, type: f.type as MetricType, step })) });
    });
}
