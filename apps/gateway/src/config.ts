import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");
const pem = z.string().transform((v) => v.replace(/\\n/g, "\n"));

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    TRUSTED_PROXIES: z.string().default("10.0.0.0/8,127.0.0.1/32,::1/128"),
    CDN_PROXIES: z.string().default(""),
    PORT: z.coerce.number().int().default(3001),
    CORS_ORIGIN: z.string().default("http://localhost:5173"),
    // Built web app (apps/web/dist); unset in development, where Vite serves it.
    STATIC_DIR: z.string().optional(),
    // A GoatCounter site (e.g. https://osiris.stats.k6labs.cz) the web app counts its visits to; unset = no counting.
    GOATCOUNTER_URL: z.url().optional().transform((v) => v?.replace(/\/$/, "")),

    // Development only: the bearer token itself is the user (see CLAUDE.md). Otherwise control identifies tokens.
    AUTH_DEV_BYPASS: bool,

    CONTROL_URL: z.url().default("http://127.0.0.1:3002"),
    // Signs the internal tokens that carry the verified user to control and the runtimes.
    INTERNAL_JWT_PRIVATE_KEY: pem,

    // Largest request body passed on (file uploads).
    MAX_BODY_MB: z.coerce.number().int().positive().default(30),
    // Per user and replica: requests per minute, agent runs per minute.
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
    RUN_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_DEV_BYPASS && env.NODE_ENV === "production") {
      ctx.addIssue({ code: "custom", path: ["AUTH_DEV_BYPASS"], message: "must not be enabled in production" });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
