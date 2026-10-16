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
    // 32 bytes, base64 (`openssl rand -base64 32`). Encrypts MCP server headers at rest; required in production.
    SECRETS_KEY: z.string().optional(),
    // Development only: let MCP servers use http and private addresses (e.g. a server on localhost).
    MCP_ALLOW_PRIVATE: bool,
    // Built web app (apps/web/dist) to serve from the API; unset in development, where Vite serves it.
    STATIC_DIR: z.string().optional(),

    // PocketID admin API at OIDC_ISSUER: tenants are its groups (managed by osiris-admin), WhatsApp finds users by
    // phone. Required in production; in development tenants are kept in memory, seeded from TENANT_DATA_DIR.
    POCKETID_API_KEY: z.string().optional(),

    // WhatsApp channel (webhook /webhooks/whatsapp), on when all three are set (plus POCKETID_API_KEY).
    WHATSAPP_VERIFY_TOKEN: z.string().optional(),
    WHATSAPP_APP_SECRET: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_DEV_BYPASS && env.NODE_ENV === "production") {
      ctx.addIssue({ code: "custom", path: ["AUTH_DEV_BYPASS"], message: "must not be enabled in production" });
    }
    if (env.NODE_ENV === "production" && !env.SECRETS_KEY) {
      ctx.addIssue({ code: "custom", path: ["SECRETS_KEY"], message: "is required in production" });
    }
    if (env.NODE_ENV === "production" && env.MCP_ALLOW_PRIVATE) {
      ctx.addIssue({ code: "custom", path: ["MCP_ALLOW_PRIVATE"], message: "must not be enabled in production" });
    }
    const turso = [env.TURSO_ORG, env.TURSO_API_TOKEN, env.TURSO_DB_TOKEN];
    if (turso.some(Boolean) && !turso.every(Boolean)) {
      ctx.addIssue({ code: "custom", path: ["TURSO_ORG"], message: "TURSO_ORG, TURSO_API_TOKEN and TURSO_DB_TOKEN go together" });
    }
    const whatsapp = [env.WHATSAPP_VERIFY_TOKEN, env.WHATSAPP_APP_SECRET, env.WHATSAPP_ACCESS_TOKEN];
    if (whatsapp.some(Boolean) && !whatsapp.every(Boolean)) {
      ctx.addIssue({
        code: "custom",
        path: ["WHATSAPP_ACCESS_TOKEN"],
        message: "WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET and WHATSAPP_ACCESS_TOKEN go together",
      });
    }
    if (whatsapp.every(Boolean) && !env.POCKETID_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["POCKETID_API_KEY"], message: "is required for WhatsApp" });
    }
    if (env.NODE_ENV === "production" && !env.POCKETID_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["POCKETID_API_KEY"], message: "is required in production (tenants are PocketID groups)" });
    }
    if (env.POCKETID_API_KEY && !env.OIDC_ISSUER) {
      ctx.addIssue({ code: "custom", path: ["OIDC_ISSUER"], message: "is required with POCKETID_API_KEY (PocketID URL)" });
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
