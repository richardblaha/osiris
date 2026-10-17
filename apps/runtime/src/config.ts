import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");
const pem = z.string().transform((v) => v.replace(/\\n/g, "\n"));

/** One runtime serves one tenant. In the cluster the operator fills this in (ConfigMap and Secret per tenant). */
const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().default(8080),
    TENANT_ID: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    // The tenant's volume: the database in db/, files in files/.
    DATA_DIR: z.string().default("/data"),

    // Control: features, backups, schedules, site publishing.
    CONTROL_URL: z.url(),
    // Verifies internal tokens from the gateway, control and the operator.
    INTERNAL_JWT_PUBLIC_KEY: pem,
    // Projected ServiceAccount token (audience osiris-control), sent to control.
    RUNTIME_TOKEN_PATH: z.string().default("/var/run/secrets/osiris/token"),
    // Development only: authenticate to control with `dev-runtime:<tenant>`.
    DEV_RUNTIME_AUTH: bool,

    // This tenant's key for sealing secrets (derived by the operator from the master key), 32 bytes base64.
    TENANT_SECRETS_KEY: z.string().optional(),

    LLM_MODEL: z.string().default("mistralai:mistral-small-2603"),
    EMBEDDING_MODEL: z.string().default("mistralai:mistral-embed"),
    TIMEZONE: z.string().default("Europe/Prague"),
    SKILLS_DIR: z.string().default("./skills"),
    FILES_MAX_FILE_MB: z.coerce.number().int().positive().default(25),
    FILES_QUOTA_MB: z.coerce.number().int().positive().default(4096),
    // Gotenberg (HTML and office documents to PDF); without it there is no convert_to_pdf tool.
    GOTENBERG_URL: z.url().optional(),
    // Development only: let MCP servers and http_request use http and private addresses.
    MCP_ALLOW_PRIVATE: bool,
  })
  .superRefine((env, ctx) => {
    const prod = env.NODE_ENV === "production";
    if (prod && !env.TENANT_SECRETS_KEY) ctx.addIssue({ code: "custom", path: ["TENANT_SECRETS_KEY"], message: "is required in production" });
    if (prod && env.MCP_ALLOW_PRIVATE) ctx.addIssue({ code: "custom", path: ["MCP_ALLOW_PRIVATE"], message: "must not be enabled in production" });
    if (prod && env.DEV_RUNTIME_AUTH) ctx.addIssue({ code: "custom", path: ["DEV_RUNTIME_AUTH"], message: "must not be enabled in production" });
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
