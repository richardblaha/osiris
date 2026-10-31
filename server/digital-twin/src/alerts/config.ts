import { z } from "zod";

/**
 * The alerts service's settings. It reads the collector's warn/error stream (the `twin_events` processor's, in the
 * twin's Redis under REDIS_KEY_PREFIX) with a consumer group of its own, keeps its alerts there too, and has Osiris's
 * agent investigate each new one as its own service account: osiris-auth's app ALERTS_CLIENT_ID with its secret, a
 * member of OSIRIS_PROJECT. Only the digital twin's API asks it (its ServiceAccount's token, TokenReview).
 */
const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().default(3006),
    OTEL_SERVICE_NAME: z.string().default("osiris-digital-twin-alerts"),
    // Required in production; without it (development) the stream and the alerts stay in the process.
    REDIS_URL: z.string().optional(),
    REDIS_KEY_PREFIX: z.string().regex(/^[a-z0-9:_-]{1,40}$/).default("osiris"),
    OSIRIS_URL: z.url(),
    OSIRIS_PROJECT: z.string().min(1),
    AUTH_URL: z.url(),
    ALERTS_CLIENT_ID: z.string().min(1).default("osiris-twin-alerts"),
    ALERTS_CLIENT_SECRET: z.string().min(20),
    // Events at least this severe make alerts; repeats within ALERTS_REOPEN_MINUTES of the last one join it; at most
    // ALERTS_MAX_PER_HOUR new investigations an hour; an alert without events for ALERTS_RESOLVE_MINUTES is resolved.
    ALERTS_MIN_SEVERITY: z.enum(["warn", "error", "fatal"]).default("error"),
    ALERTS_REOPEN_MINUTES: z.coerce.number().int().min(1).max(10_080).default(60),
    ALERTS_MAX_PER_HOUR: z.coerce.number().int().min(0).max(120).default(6),
    ALERTS_RESOLVE_MINUTES: z.coerce.number().int().min(1).max(10_080).default(30),
    ALERTS_INVESTIGATION_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
    // Who may ask: the digital twin's ServiceAccount, by its projected token for this audience.
    ALERTS_CALLER: z.string().default("system:serviceaccount:osiris:digital-twin"),
    ALERTS_AUDIENCE: z.string().default("osiris-twin-alerts"),
    KUBE_API_SERVER: z.url().default("https://kubernetes.default.svc"),
    // Development only: a fixed token for the twin's calls instead of TokenReview.
    ALERTS_DEV_TOKEN: z.string().min(16).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    if (env.ALERTS_DEV_TOKEN) ctx.addIssue({ code: "custom", path: ["ALERTS_DEV_TOKEN"], message: "not in production" });
    if (!env.REDIS_URL) ctx.addIssue({ code: "custom", path: ["REDIS_URL"], message: "required in production" });
  });

export type AlertsConfig = z.infer<typeof schema>;
export const loadAlertsConfig = (env: NodeJS.ProcessEnv = process.env): AlertsConfig => schema.parse(env);
