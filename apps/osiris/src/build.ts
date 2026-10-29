import { MediaReader } from "@osiris/core/agent/attachments.ts";
import { createAgentModels } from "@osiris/core/agent/model.ts";
import { loadSkills } from "@osiris/core/agent/skills.ts";
import { createEmbeddings } from "@osiris/core/rag/embeddings.ts";
import type { SecretBox } from "@osiris/core/secrets.ts";
import { openProject, type Project, type ProjectDeps } from "@osiris/core/projects/project.ts";
import type { FeatureSource } from "@osiris/core/projects/features.ts";
import type { Config } from "./config.ts";
import { loadToolModules, type ToolModuleOptions } from "./tool-modules.ts";

/** Opens the project in `root` with the models and settings of `config`; server and local mode differ in `mode`. */
export async function buildProject(
  config: Config,
  id: string,
  root: string,
  mode: { features: FeatureSource; secrets: SecretBox; schedules?: ToolModuleOptions["schedules"]; notifyAdmins?: ProjectDeps["notifyAdmins"] },
): Promise<Project> {
  const models = await createAgentModels({
    agent: config.LLM_AGENT_MODEL ?? config.LLM_MODEL,
    tools: config.LLM_TOOLS_MODEL ?? config.LLM_MODEL,
    guard: config.LLM_GUARD_MODEL ?? config.LLM_MODEL,
    persona: config.LLM_PERSONA_MODEL ?? config.LLM_MODEL,
  });
  const tools = await loadToolModules({
    enabled: config.TOOL_MODULES,
    schedules: mode.schedules,
    images: config.IMAGE_GENERATION_ENABLED
      ? {
          comfyApiKey: config.COMFY_API_KEY,
          server: config.IMAGE_MCP_SERVER,
          maxExecutionTimeMs: config.IMAGE_TIMEOUT_MS,
          maxAttempts: config.IMAGE_MAX_ATTEMPTS,
          maxRefinements: config.IMAGE_MAX_REFINEMENTS,
          maxEstimatedCost: config.IMAGE_MAX_ESTIMATED_COST,
          maxReadAttempts: config.IMAGE_MAX_READ_ATTEMPTS,
          maxImages: config.IMAGE_MAX_COUNT,
          visualEvaluation: config.IMAGE_VISUAL_EVALUATION,
          apiUploadFallback: config.IMAGE_API_UPLOAD_FALLBACK,
          uploadApiKeySecret: config.IMAGE_API_KEY_SECRET,
          retentionDays: config.IMAGE_RETENTION_DAYS,
          downloadHosts: config.IMAGE_DOWNLOAD_HOSTS,
        }
      : undefined,
  });
  return openProject(id, root, {
    model: models.agent,
    models,
    media: new MediaReader(config.MISTRAL_API_KEY, config.AUDIO_MODEL, config.OCR_MODEL),
    embeddings: createEmbeddings(config.EMBEDDING_MODEL),
    embeddingModel: config.EMBEDDING_MODEL,
    bundledSkills: loadSkills(config.SKILLS_DIR),
    timezone: config.TIMEZONE,
    secrets: mode.secrets,
    mcp: { allowPrivate: config.MCP_ALLOW_PRIVATE, oauthRedirectUrl: `${config.PUBLIC_URL}/mcp-callback` },
    integrations: {
      redirectUrl: `${config.PUBLIC_URL}/integration-callback`,
      clients: {
        ...(config.GOOGLE_INTEGRATION_CLIENT_ID && config.GOOGLE_INTEGRATION_CLIENT_SECRET
          ? { google: { clientId: config.GOOGLE_INTEGRATION_CLIENT_ID, clientSecret: config.GOOGLE_INTEGRATION_CLIENT_SECRET } }
          : {}),
        ...(config.MICROSOFT_INTEGRATION_CLIENT_ID && config.MICROSOFT_INTEGRATION_CLIENT_SECRET
          ? { microsoft: { clientId: config.MICROSOFT_INTEGRATION_CLIENT_ID, clientSecret: config.MICROSOFT_INTEGRATION_CLIENT_SECRET } }
          : {}),
      },
    },
    files: { maxFileBytes: config.FILES_MAX_FILE_MB * 1024 * 1024, quotaBytes: config.FILES_QUOTA_MB * 1024 * 1024 },
    vitepressUrl: config.VITEPRESS_URL,
    learnMemories: config.MEMORY_LEARN,
    features: mode.features,
    tools,
    notifyAdmins: mode.notifyAdmins,
  });
}
