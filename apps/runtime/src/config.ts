import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");
const pem = z.string().transform((v) => v.replace(/\\n/g, "\n"));

/** One runtime serves one project. In the cluster the operator fills this in (ConfigMap and Secret per project). */
const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().default(8080),
    PROJECT_ID: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    // The project's volume: the project folder in project/ (its files and .osiris/).
    DATA_DIR: z.string().default("/data"),

    // Control: features, backups, schedules, site publishing.
    CONTROL_URL: z.url(),
    // Verifies internal tokens from the gateway, control and the operator.
    INTERNAL_JWT_PUBLIC_KEY: pem,
    // Projected ServiceAccount token (audience osiris-control), sent to control.
    RUNTIME_TOKEN_PATH: z.string().default("/var/run/secrets/osiris/token"),
    // Development only: authenticate to control with `dev-runtime:<project>`.
    DEV_RUNTIME_AUTH: bool,

    // This project's key for sealing secrets (derived by the operator from the master key), 32 bytes base64.
    PROJECT_SECRETS_KEY: z.string().optional(),

    AUDIO_MODEL: z.string().default("voxtral-mini-latest"),
    OCR_MODEL: z.string().default("mistral-ocr-latest"),
    MISTRAL_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().default("mistralai:mistral-small-2603"),
    LLM_AGENT_MODEL: z.string().optional(),
    LLM_TOOLS_MODEL: z.string().optional(),
    LLM_GUARD_MODEL: z.string().optional(),
    LLM_PERSONA_MODEL: z.string().optional(),
    EMBEDDING_MODEL: z.string().default("mistralai:mistral-embed"),
    TIMEZONE: z.string().default("Europe/Prague"),
    SKILLS_DIR: z.string().default("./skills"),
    FILES_MAX_FILE_MB: z.coerce.number().int().positive().default(25),
    FILES_QUOTA_MB: z.coerce.number().int().positive().default(4096),
    // Gotenberg (HTML and office documents to PDF); without it there is no convert_to_pdf tool.
    COMFY_API_KEY: z.string().optional(),
    IMAGE_GENERATION_ENABLED: bool,
    IMAGE_MCP_SERVER: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).default("comfy-cloud"),
    IMAGE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(180_000),
    IMAGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(1),
    IMAGE_MAX_REFINEMENTS: z.coerce.number().int().min(0).max(4).default(0),
    IMAGE_MAX_ESTIMATED_COST: z.coerce.number().nonnegative().optional(),
    IMAGE_MAX_READ_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
    IMAGE_MAX_COUNT: z.coerce.number().int().min(1).max(16).default(16),
    IMAGE_VISUAL_EVALUATION: bool,
    IMAGE_API_UPLOAD_FALLBACK: bool,
    IMAGE_API_KEY_SECRET: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default("COMFY_API_KEY"),
    IMAGE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    IMAGE_DOWNLOAD_HOSTS: z.string().default("cloud.comfy.org,storage.googleapis.com").transform(v => v.split(",").map(h => h.trim()).filter(Boolean)),
    GOTENBERG_URL: z.url().optional(),
    VITEPRESS_URL: z.url().optional(),
    // Development only: let MCP servers and http_request use http and private addresses.
    MCP_ALLOW_PRIVATE: bool,
    // Where the web app runs; OAuth providers of MCP servers send the user back to <PUBLIC_URL>/mcp-callback.
    PUBLIC_URL: z.url().default("http://localhost:5173").transform((v) => v.replace(/\/$/, "")),
    // Osiris's OAuth clients for users' Google and Microsoft accounts (mail, contacts, calendar); redirect URI
    // <PUBLIC_URL>/integration-callback. Each provider is on when both are set.
    GOOGLE_INTEGRATION_CLIENT_ID: z.string().optional(),
    GOOGLE_INTEGRATION_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_INTEGRATION_CLIENT_ID: z.string().optional(),
    MICROSOFT_INTEGRATION_CLIENT_SECRET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const prod = env.NODE_ENV === "production";
    if (prod && !env.PROJECT_SECRETS_KEY) ctx.addIssue({ code: "custom", path: ["PROJECT_SECRETS_KEY"], message: "is required in production" });
    if (prod && env.MCP_ALLOW_PRIVATE) ctx.addIssue({ code: "custom", path: ["MCP_ALLOW_PRIVATE"], message: "must not be enabled in production" });
    if (prod && env.DEV_RUNTIME_AUTH) ctx.addIssue({ code: "custom", path: ["DEV_RUNTIME_AUTH"], message: "must not be enabled in production" });
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
