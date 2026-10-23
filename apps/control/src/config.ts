import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");
// Sent in HTTP headers, which take printable ASCII only.
const headerToken = z.string().regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces").optional();
const pem = z.string().transform((v) => v.replace(/\\n/g, "\n"));
const list = z
  .string()
  .default("")
  .transform((v) => v.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean));

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().default(3002),
    WHATSAPP_FLOWS_JSON: z.string().default("[]").transform((raw, ctx) => {
      try { return z.array(z.object({ id: z.string().regex(/^\d+$/), screen: z.string().min(1), fields: z.array(z.object({ name: z.string(), type: z.enum(["text", "number", "date", "select", "multiselect", "boolean"]) })).min(1).max(12) })).parse(JSON.parse(raw)); }
      catch { ctx.addIssue({ code: "custom", message: "Invalid WhatsApp Flow mappings JSON" }); return z.NEVER; }
    }),
    WHATSAPP_NOTIFICATION_TEMPLATE: z.string().optional(),
    WHATSAPP_TEMPLATE_LANGUAGE: z.string().default("cs"),
    TIMEZONE: z.string().default("Europe/Prague"),

    // rqlite (any node); without it a local SQLite file (development only).
    RQLITE_URL: z.url().optional(),
    RQLITE_USERNAME: z.string().optional(),
    RQLITE_PASSWORD: z.string().optional(),
    LOCAL_DB_PATH: z.string().default("./data/control.db"),

    // Internal JWT: control signs calls to runtimes and verifies the gateway's calls.
    INTERNAL_JWT_PRIVATE_KEY: pem,
    INTERNAL_JWT_PUBLIC_KEY: pem,

    // Sign-in: control is the OpenID Connect provider at <PUBLIC_URL>/auth; the web app runs at PUBLIC_URL.
    PUBLIC_URL: z.url().default("http://localhost:5173").transform((v) => v.replace(/\/$/, "")),
    // More origins the web app may run at (comma-separated), e.g. a preview; each gets <origin>/callback.
    AUTH_EXTRA_ORIGINS: list,
    // Signs ID tokens: an EC P-256 private key (PEM). `pnpm --filter @osiris/platform gen-keys` makes one.
    AUTH_SIGNING_KEY: pem.optional(),
    // 32 bytes, base64: signs the provider's cookies and seals TOTP secrets.
    AUTH_SECRET: z.string().optional(),
    // Social sign-in, each on when its client ID and secret are set. Redirect URI <PUBLIC_URL>/auth/social/<name>/callback.
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    FACEBOOK_CLIENT_ID: z.string().optional(),
    FACEBOOK_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    // common (personal and work accounts), consumers, organizations, or one directory's id.
    MICROSOFT_TENANT: z.string().default("common"),
    SEZNAM_CLIENT_ID: z.string().optional(),
    SEZNAM_CLIENT_SECRET: z.string().optional(),
    // Email (sign-in links): smtp(s)://user:pass@host:port. Without it there are no links by email (development prints them).
    SMTP_URL: z.string().optional(),
    // Or Emailit's HTTP API (https://emailit.com), which wins over SMTP_URL: the cluster's provider blocks outgoing SMTP.
    EMAILIT_API_KEY: z.string().optional(),
    MAIL_FROM: z.string().default("Osiris <auth@k6labs.cz>"),

    // PocketID admin API, only for the one-off import of its users (`pnpm users import-pocketid`).
    POCKETID_URL: z.url().optional(),
    // The cluster's telemetry (System > Logy, Metriky, Trasy): ClickHouse's HTTP interface with a read-only user.
    CLICKHOUSE_URL: z.url().optional(),
    CLICKHOUSE_USER: z.string().default("osiris"),
    CLICKHOUSE_PASSWORD: z.string().optional(),
    POCKETID_API_KEY: headerToken,

    // How project runtimes run: Kubernetes (Project custom resources, operator) or local child processes (development).
    ORCHESTRATOR: z.enum(["kubernetes", "local"]).default("local"),
    K8S_NAMESPACE: z.string().default("osiris"),
    RUNTIME_PORT: z.coerce.number().int().default(8080),
    // Local orchestrator: the runtime entry point and where runtimes keep their data.
    LOCAL_RUNTIME_ENTRY: z.string().default("../runtime/src/index.ts"),
    LOCAL_RUNTIME_DATA_DIR: z.string().default("./data/runtimes"),
    LOCAL_RUNTIME_BASE_PORT: z.coerce.number().int().default(4100),
    // Where runtimes reach control (local orchestrator passes it on).
    PUBLIC_CONTROL_URL: z.url().default("http://127.0.0.1:3002"),
    // Development only: runtimes authenticate with `dev-runtime:<project>` instead of ServiceAccount tokens.
    DEV_RUNTIME_AUTH: bool,

    // Object storage (sites, backups). Without S3 settings, a local folder.
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default("fra1"),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    LOCAL_OBJECTS_DIR: z.string().default("./data/objects"),
    BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

    // WhatsApp (Meta Cloud API), on when all three are set.
    WHATSAPP_VERIFY_TOKEN: z.string().optional(),
    WHATSAPP_APP_SECRET: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: headerToken,
    // Shown to users who verify their number ("send the code to …").
    WHATSAPP_DISPLAY_NUMBER: z.string().optional(),

    // Project sites: custom domains must resolve to these addresses (A/AAAA) or CNAME to SITES_CNAME_TARGET.
    SITES_INGRESS_IPS: z
      .string()
      .default("")
      .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
    SITES_CNAME_TARGET: z.string().optional(),
    MAX_DOMAINS_PER_PROJECT: z.coerce.number().int().positive().default(5),
  })
  .superRefine((env, ctx) => {
    const prod = env.NODE_ENV === "production";
    if (prod && !env.RQLITE_URL) ctx.addIssue({ code: "custom", path: ["RQLITE_URL"], message: "is required in production" });
    if (prod && !env.AUTH_SIGNING_KEY) ctx.addIssue({ code: "custom", path: ["AUTH_SIGNING_KEY"], message: "is required in production" });
    if (prod && !env.AUTH_SECRET) ctx.addIssue({ code: "custom", path: ["AUTH_SECRET"], message: "is required in production" });
    if (env.AUTH_SECRET && Buffer.from(env.AUTH_SECRET, "base64").length !== 32) {
      ctx.addIssue({ code: "custom", path: ["AUTH_SECRET"], message: "must be 32 bytes, base64-encoded" });
    }
    if (prod && !env.PUBLIC_URL.startsWith("https://")) ctx.addIssue({ code: "custom", path: ["PUBLIC_URL"], message: "must be https in production" });
    for (const p of ["GOOGLE", "FACEBOOK", "MICROSOFT", "SEZNAM"] as const) {
      if (!env[`${p}_CLIENT_ID`] !== !env[`${p}_CLIENT_SECRET`]) {
        ctx.addIssue({ code: "custom", path: [`${p}_CLIENT_SECRET`], message: `${p}_CLIENT_ID and ${p}_CLIENT_SECRET go together` });
      }
    }
    if (prod && !env.S3_BUCKET) ctx.addIssue({ code: "custom", path: ["S3_BUCKET"], message: "is required in production" });
    if (prod && env.DEV_RUNTIME_AUTH) ctx.addIssue({ code: "custom", path: ["DEV_RUNTIME_AUTH"], message: "must not be enabled in production" });
    if (prod && env.ORCHESTRATOR !== "kubernetes") ctx.addIssue({ code: "custom", path: ["ORCHESTRATOR"], message: "must be kubernetes in production" });
    if (env.S3_BUCKET && !(env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY)) {
      ctx.addIssue({ code: "custom", path: ["S3_BUCKET"], message: "needs S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY" });
    }
    const whatsapp = [env.WHATSAPP_VERIFY_TOKEN, env.WHATSAPP_APP_SECRET, env.WHATSAPP_ACCESS_TOKEN];
    if (whatsapp.some(Boolean) && !whatsapp.every(Boolean)) {
      ctx.addIssue({ code: "custom", path: ["WHATSAPP_ACCESS_TOKEN"], message: "WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET and WHATSAPP_ACCESS_TOKEN go together" });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
