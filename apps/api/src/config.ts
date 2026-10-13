import { z } from "zod";
import { fileProvider, tursoProvider, type TenantDbProvider } from "./tenants/provider.ts";

const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().default(3001),
    CORS_ORIGIN: z.string().default("http://localhost:5173"),

    // One database per tenant. Locally a SQLite file per tenant in TENANT_DATA_DIR; with TURSO_* set,
    // a Turso database per tenant, created through the Platform API on first use.
    TENANT_DATA_DIR: z.string().default("./data/tenants"),
    TURSO_ORG: z.string().optional(),
    TURSO_GROUP: z.string().default("default"),
    TURSO_API_TOKEN: z.string().optional(),
    TURSO_DB_TOKEN: z.string().optional(),
    TURSO_DB_PREFIX: z.string().default("osiris-"),

    OIDC_ISSUER: z.url().optional(),
    OIDC_AUDIENCE: z.string().optional(),
    AUTH_DEV_BYPASS: bool,

    LLM_MODEL: z.string().default("mistralai:mistral-small-2603"),
    EMBEDDING_MODEL: z.string().default("mistralai:mistral-embed"),
    TIMEZONE: z.string().default("Europe/Prague"),
    SKILLS_DIR: z.string().default("./skills"),
    // Built web app (apps/web/dist) to serve from the API; unset in development, where Vite serves it.
    STATIC_DIR: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_DEV_BYPASS && env.NODE_ENV === "production") {
      ctx.addIssue({ code: "custom", path: ["AUTH_DEV_BYPASS"], message: "must not be enabled in production" });
    }
    const turso = [env.TURSO_ORG, env.TURSO_API_TOKEN, env.TURSO_DB_TOKEN];
    if (turso.some(Boolean) && !turso.every(Boolean)) {
      ctx.addIssue({ code: "custom", path: ["TURSO_ORG"], message: "TURSO_ORG, TURSO_API_TOKEN and TURSO_DB_TOKEN go together" });
    }
    if (!env.AUTH_DEV_BYPASS && (!env.OIDC_ISSUER || !env.OIDC_AUDIENCE)) {
      ctx.addIssue({ code: "custom", path: ["OIDC_ISSUER"], message: "OIDC_ISSUER and OIDC_AUDIENCE are required" });
    }
  });

export type Config = z.infer<typeof schema>;

export function tenantDbProvider(config: Config): TenantDbProvider {
  return config.TURSO_ORG
    ? tursoProvider({
        org: config.TURSO_ORG,
        group: config.TURSO_GROUP,
        apiToken: config.TURSO_API_TOKEN!,
        dbToken: config.TURSO_DB_TOKEN!,
        prefix: config.TURSO_DB_PREFIX,
      })
    : fileProvider(config.TENANT_DATA_DIR);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
