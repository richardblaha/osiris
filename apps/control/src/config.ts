import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");
// Sent in HTTP headers, which take printable ASCII only.
const headerToken = z.string().regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces").optional();
const pem = z.string().transform((v) => v.replace(/\\n/g, "\n"));

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().default(3002),
    TIMEZONE: z.string().default("Europe/Prague"),

    // rqlite (any node); without it a local SQLite file (development only).
    RQLITE_URL: z.url().optional(),
    RQLITE_USERNAME: z.string().optional(),
    RQLITE_PASSWORD: z.string().optional(),
    LOCAL_DB_PATH: z.string().default("./data/control.db"),

    // Internal JWT: control signs calls to runtimes and verifies the gateway's calls.
    INTERNAL_JWT_PRIVATE_KEY: pem,
    INTERNAL_JWT_PUBLIC_KEY: pem,

    // PocketID: the issuer URL and its admin API key. Without the key (development) users are kept in memory.
    OIDC_ISSUER: z.url().optional(),
    POCKETID_API_KEY: headerToken,

    // How tenant runtimes run: Kubernetes (Tenant custom resources, operator) or local child processes (development).
    ORCHESTRATOR: z.enum(["kubernetes", "local"]).default("local"),
    K8S_NAMESPACE: z.string().default("osiris"),
    RUNTIME_PORT: z.coerce.number().int().default(8080),
    // Local orchestrator: the runtime entry point and where runtimes keep their data.
    LOCAL_RUNTIME_ENTRY: z.string().default("../runtime/src/index.ts"),
    LOCAL_RUNTIME_DATA_DIR: z.string().default("./data/runtimes"),
    LOCAL_RUNTIME_BASE_PORT: z.coerce.number().int().default(4100),
    // Where runtimes reach control (local orchestrator passes it on).
    PUBLIC_CONTROL_URL: z.url().default("http://127.0.0.1:3002"),
    // Development only: runtimes authenticate with `dev-runtime:<tenant>` instead of ServiceAccount tokens.
    DEV_RUNTIME_AUTH: bool,

    // Object storage (sites, backups). Without S3 settings, a local folder.
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default("fra1"),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    LOCAL_OBJECTS_DIR: z.string().default("./data/objects"),
    BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

    // WhatsApp (Meta Cloud API), on when all three are set (plus POCKETID_API_KEY).
    WHATSAPP_VERIFY_TOKEN: z.string().optional(),
    WHATSAPP_APP_SECRET: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: headerToken,
    // Shown to users who verify their number ("send the code to …").
    WHATSAPP_DISPLAY_NUMBER: z.string().optional(),

    // Tenant sites: custom domains must resolve to these addresses (A/AAAA) or CNAME to SITES_CNAME_TARGET.
    SITES_INGRESS_IPS: z
      .string()
      .default("")
      .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
    SITES_CNAME_TARGET: z.string().optional(),
    MAX_DOMAINS_PER_TENANT: z.coerce.number().int().positive().default(5),
  })
  .superRefine((env, ctx) => {
    const prod = env.NODE_ENV === "production";
    if (prod && !env.RQLITE_URL) ctx.addIssue({ code: "custom", path: ["RQLITE_URL"], message: "is required in production" });
    if (prod && !env.POCKETID_API_KEY) ctx.addIssue({ code: "custom", path: ["POCKETID_API_KEY"], message: "is required in production" });
    if (prod && !env.S3_BUCKET) ctx.addIssue({ code: "custom", path: ["S3_BUCKET"], message: "is required in production" });
    if (prod && env.DEV_RUNTIME_AUTH) ctx.addIssue({ code: "custom", path: ["DEV_RUNTIME_AUTH"], message: "must not be enabled in production" });
    if (prod && env.ORCHESTRATOR !== "kubernetes") ctx.addIssue({ code: "custom", path: ["ORCHESTRATOR"], message: "must be kubernetes in production" });
    if (env.POCKETID_API_KEY && !env.OIDC_ISSUER) ctx.addIssue({ code: "custom", path: ["OIDC_ISSUER"], message: "is required with POCKETID_API_KEY" });
    if (env.S3_BUCKET && !(env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({ code: "custom", path: ["S3_BUCKET"], message: "needs S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY" });
    }
    const whatsapp = [env.WHATSAPP_VERIFY_TOKEN, env.WHATSAPP_APP_SECRET, env.WHATSAPP_ACCESS_TOKEN];
    if (whatsapp.some(Boolean) && !whatsapp.every(Boolean)) {
      ctx.addIssue({ code: "custom", path: ["WHATSAPP_ACCESS_TOKEN"], message: "WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET and WHATSAPP_ACCESS_TOKEN go together" });
    }
    if (whatsapp.every(Boolean) && !env.POCKETID_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["POCKETID_API_KEY"], message: "is required for WhatsApp" });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
