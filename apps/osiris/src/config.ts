import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");
const pem = z.string().transform((v) => v.replace(/\\n/g, "\n"));

/**
 * One agent serves one project. In the cluster (server mode) the operator fills this in (ConfigMap and Secret per
 * project); run locally (`osiris [dir]`, local mode) the server's settings are absent and the project is a folder.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().default(8080),
    // Server mode: set by the operator. Local mode: the folder's name.
    PROJECT_ID: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).optional(),
    // The project's volume: the project folder in project/ (its files and .osiris/).
    DATA_DIR: z.string().default("/data"),

    // Server mode only. Control: features, backups, schedules, site publishing.
    CONTROL_URL: z.url().optional(),
    // Server mode only. Verifies internal tokens from the gateway, control and the operator.
    INTERNAL_JWT_PUBLIC_KEY: pem.optional(),
    // Local mode: where the agent listens (loopback unless a devcontainer forwards it), and the PWA build it serves.
    OSIRIS_HOST: z.string().default("127.0.0.1"),
    OSIRIS_PORT: z.coerce.number().int().min(0).max(65535).default(7777),
    STATIC_DIR: z.string().optional(),
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
    // Tool modules the runtime loads, comma-separated (files, knowledge, memory, skills, database, http, sites,
    // integrations, images, workflows, scheduler), or "all". A module left out is never imported and has no tools.
    TOOL_MODULES: z.string().default("all").transform((v) => v.split(",").map((m) => m.trim()).filter(Boolean)),
    // Gotenberg (HTML and office documents to PDF); without it there is no convert_to_pdf tool.
    COMFY_API_KEY: z.string().optional(),
    // Mem0 picks the user's facts from every finished conversation turn into their memory (a few model calls per turn).
    MEMORY_LEARN: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
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

/** The server mode's configuration: everything the cluster sets, required. */
export type ServerConfig = Config & { PROJECT_ID: string; CONTROL_URL: string; INTERNAL_JWT_PUBLIC_KEY: string };

export function serverConfig(config: Config): ServerConfig {
  const missing = (["PROJECT_ID", "CONTROL_URL", "INTERNAL_JWT_PUBLIC_KEY"] as const).filter((k) => !config[k]);
  if (missing.length) throw new Error(`Invalid configuration: ${missing.join(", ")} required in server mode`);
  return config as ServerConfig;
}
