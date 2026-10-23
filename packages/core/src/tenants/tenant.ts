import { ComfyUploadApi } from "../images/http.ts";
import { ImageError } from "../images/errors.ts";
import { imageTools } from "../agent/tools/images.ts";
import { ImageService, type ImageOptions } from "../images/service.ts";
import { ImageJobStore } from "../images/store.ts";
import { chatFileTool } from "../agent/tools/chat-file.ts";
import { MediaReader } from "../agent/attachments.ts";
import { QuestionStore } from "../agent/questions.ts";
import { StandardAccounts } from "../integrations/standard.ts";
import { mailTools } from "../integrations/mail.ts";
import { davTools } from "../integrations/dav.ts";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getRunContext } from "../agent/context.ts";
import type { AgentModels } from "../agent/model.ts";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Client } from "@libsql/client";
import { createAgentGraph, type AgentGraph } from "../agent/graph.ts";
import { createOrchestratorGraph, reactFromAgentGraph } from "../agent/orchestrator/graph.ts";
import { WORKFLOW_TOOL, workflowTool } from "../agent/orchestrator/tool.ts";
import { MemoryStore } from "../agent/memory.ts";
import { UserSettingsStore } from "../agent/settings.ts";
import { SkillStore, type Skill } from "../agent/skills.ts";
import { saveKnowledgeTool, searchKnowledgeTool } from "../agent/tools/knowledge.ts";
import { memoryTools } from "../agent/tools/memory.ts";
import { loadSkillTool } from "../agent/tools/skills.ts";
import { LibSQLSaver } from "../checkpointer/libsql-saver.ts";
import { McpServerStore } from "../mcp/store.ts";
import { McpToolset, type McpOptions } from "../mcp/toolset.ts";
import { KnowledgeStore } from "../rag/store.ts";
import type { SecretBox } from "../secrets.ts";
import { SecretVault } from "../vault/vault.ts";
import { httpRequestTool } from "../agent/tools/http.ts";
import { fileTools, searchFilesTool } from "../agent/tools/files.ts";
import { GotenbergClient } from "../files/gotenberg.ts";
import { FileStore, type FileStoreOptions } from "../files/store.ts";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { fileType } from "@osiris/shared";
import type { Feature, Inquiry } from "@osiris/shared";
import type { FeatureSource } from "./features.ts";
import { UsageStore } from "../agent/usage.ts";
import { McpOAuthStore } from "../mcp/oauth.ts";
import { FileIndex } from "../files/index.ts";
import { SiteTargetStore } from "../sites/sftp.ts";
import { GuardStore, guardsText } from "../agent/guards.ts";
import { buildPublicPrompt, InquiryStore, PublicAssistantStore, publicProfile, publicTools } from "../public/assistant.ts";
import { googleTools } from "../integrations/google.ts";
import { microsoftTools } from "../integrations/microsoft.ts";
import { IntegrationAccounts, type IntegrationClient, type IntegrationProvider } from "../integrations/oauth.ts";
import { buildVitepressTool, publishSiteTool } from "../agent/tools/site.ts";
import { VitepressClient } from "../files/vitepress.ts";
import { FileIndexer, moveKnowledgeToDb, moveLegacyToFiles } from "../files/sync.ts";
import { AssistantProfileStore, type GuardRules } from "../agent/assistant.ts";
import { databaseTools } from "../agent/tools/database.ts";
import { DataStore } from "../database/store.ts";
import { createDb } from "../db/client.ts";
import { configuredLocale, translate } from "@osiris/platform/i18n.ts";

/** Everything one tenant owns, all on the tenant's own database. */
export interface Tenant {
  id: string;
  db: Client;
  checkpointer: LibSQLSaver;
  knowledge: KnowledgeStore;
  skills: SkillStore;
  memory: MemoryStore;
  mcpServers: McpServerStore;
  mcp: McpToolset;
  settings: UserSettingsStore;
  secrets: SecretVault;
  features: FeatureSource;
  files: FileStore;
  /** The tenant's own database of the assistant's tables (contacts, deals…). */
  data: DataStore;
  /** Full-text index of the tenant's and users' text files. */
  fileIndex: FileIndex;
  /** Where the tenant's website is published over SFTP. */
  siteTargets: SiteTargetStore;
  /** Users' Google and Microsoft accounts. */
  integrations: IntegrationAccounts;
  standardAccounts: StandardAccounts;
  /** The assistant for the tenant's customers, and the inquiries it took. */
  publicAssistants: PublicAssistantStore;
  /** The VitePress builder, when there is one. */
  vitepress?: VitepressClient;
  inquiries: InquiryStore;
  /** Run once before serving: moves old database content to files and brings the indexes up to date. */
  init(): Promise<void>;
  /** The built-in tools, each with the feature it belongs to. */
  builtinTools: [Feature, StructuredToolInterface][];
  usage: UsageStore;
  /** Persona and rules, tenant-wide (owner '') and per user. */
  profiles: AssistantProfileStore;
  guards: GuardStore;
  /** The rules a user's runs keep to: system, tenant and the user's own. */
  rules(userId: string): Promise<GuardRules>;
  model: BaseChatModel;
  personaModel: BaseChatModel;
  graph: AgentGraph;
  questions: QuestionStore;
  media: MediaReader;
}

/** Shared, tenant-independent dependencies. */
export interface TenantDeps {
  images?: ImageOptions;
  /** Optional runtime bootstrap credential; sealed into the existing tenant vault, never sent to the model. */
  comfyApiKey?: string;
  media?: MediaReader;
  model: BaseChatModel;
  models?: AgentModels;
  embeddings: EmbeddingsInterface;
  embeddingModel: string;
  bundledSkills: Skill[];
  timezone: string;
  secrets: SecretBox;
  mcp?: McpOptions;
  /** Where the tenant's files live. */
  files: FileStoreOptions & { dir: string };
  /** The file of the tenant's database (feature `database`), next to the tenant's own. */
  database: { path: string };
  /** Which features the tenant may use (from control). */
  features: FeatureSource;
  /** Tools beyond the built-in ones (the runtime's schedule and site tools), each tied to a feature. */
  extraTools?: (files: FileStore) => [Feature, StructuredToolInterface][];
  /** Emails the tenant's admins (a new inquiry from the public assistant); through control. */
  notifyAdmins?: (subject: string, text: string) => Promise<void>;
  /** Osiris's OAuth clients at Google and Microsoft, for users' mail, contacts and calendar (none: no such tools). */
  integrations?: { clients: Partial<Record<IntegrationProvider, IntegrationClient>>; redirectUrl: string; fetch?: typeof fetch };
  /** Gotenberg for converting files to PDF; without it there is no convert_to_pdf tool. */
  gotenbergUrl?: string;
  /** The VitePress builder; without it there is no build_vitepress_site tool. */
  vitepressUrl?: string;
  /** Replaces global fetch for the http_request tool (tests). */
  fetch?: typeof fetch;
}

export function openTenant(id: string, db: Client, deps: TenantDeps): Tenant {
  const checkpointer = new LibSQLSaver(db);
  const knowledge = new KnowledgeStore(db, deps.embeddings, deps.embeddingModel);
  const memory = new MemoryStore(db);
  const mcpServers = new McpServerStore(db, deps.secrets);
  const secrets = new SecretVault(db, deps.secrets);
  const mcp = new McpToolset(mcpServers, secrets, new McpOAuthStore(db, deps.secrets), deps.mcp);
  const userDefaults = async () => (await deps.features.userDefaults?.()) ?? {};
  const settings = new UserSettingsStore(db, async () => {
    const { persona: _, ...defaults } = await userDefaults();
    return defaults;
  });
  const features = deps.features;
  const usage = new UsageStore(db);
  const profiles = new AssistantProfileStore(db);
  // Guards are files, so the store comes after the file store; rules() runs only in runs, long after.
  let guards!: GuardStore;
  const rules = async (userId: string): Promise<GuardRules> => {
    const [system, tenant, user] = await Promise.all([features.systemGuards(), guards.list({ level: "tenant" }), guards.list({ level: "user", userId })]);
    return { system: guardsText(system), tenant: guardsText(tenant), user: guardsText(user) };
  };
  // The public assistants (customers): each its own persona and rules after the system's and the tenant's.
  const publicAssistants = new PublicAssistantStore(db);
  const publicRules = async (name = ""): Promise<GuardRules> => {
    const [system, tenant, open] = await Promise.all([
      features.systemGuards(),
      guards.list({ level: "tenant" }),
      name ? guards.list({ level: "assistant", assistant: name }) : [],
    ]);
    return { system: guardsText(system), tenant: guardsText(tenant), user: guardsText(open) };
  };
  const inquiries = new InquiryStore(db);
  const fileIndex = new FileIndex(db);
  // The files are the truth for the knowledge base and skills; the indexes follow every change.
  let indexer: FileIndexer | undefined;
  const files = new FileStore(deps.files.dir, {
    ...deps.files,
    quota: async () => {
      const mb = (await features.quotas()).storageMb;
      return mb === null ? null : mb * 1024 * 1024;
    },
    onChange: (change) => indexer!.apply(change),
  });
  indexer = new FileIndexer(files, fileIndex);
  const data = new DataStore(createDb(`file:${deps.database.path}`), deps.database.path, async () => {
    const q = await features.quotas();
    return { tables: q.tables, bytes: q.databaseMb === null ? null : q.databaseMb * 1024 * 1024 };
  });
  const skills = new SkillStore(files, deps.bundledSkills);
  guards = new GuardStore(files);
  const siteTargets = new SiteTargetStore(db, deps.secrets);
  const integrations = new IntegrationAccounts(
    db,
    deps.secrets,
    deps.integrations?.clients ?? {},
    deps.integrations?.redirectUrl ?? "http://localhost:5173/integration-callback",
    deps.integrations?.fetch,
  );
  const standardAccounts = new StandardAccounts(db, deps.secrets);
  const gotenberg = deps.gotenbergUrl ? new GotenbergClient(deps.gotenbergUrl) : undefined;
  const vitepress = deps.vitepressUrl ? new VitepressClient(deps.vitepressUrl, deps.fetch) : undefined;
  // Each built-in tool belongs to a feature a system admin can switch off for the tenant.
  const images = deps.images ? new ImageService(new ImageJobStore(db), files, mcp, deps.models?.tools ?? deps.model, { ...deps.images,
    uploadApi: deps.images.uploadApi ?? (deps.images.apiUploadFallback ? new ComfyUploadApi(secrets, deps.images.uploadApiKeySecret, deps.fetch) : undefined),
    authorize: async ctx => {
      const on = await features.get(), q = await features.quotas();
      if (!on.files || !on.mcp || ctx.channel === "public") throw new ImageError("IMAGE_ACCESS_DISABLED");
      if ((q.tokensPerMonth !== null && await usage.tokens() >= q.tokensPerMonth) || (q.tokensPerUserMonth !== null && await usage.tokens(Date.now(), { user: ctx.user_id }) >= q.tokensPerUserMonth)) throw new ImageError("TOKEN_QUOTA_EXHAUSTED");
      await deps.images?.authorize?.(ctx);
    },
  }, (ctx, tokens) => usage.add(tokens, Date.now(), { user: ctx.user_id })) : undefined;
  const questions = new QuestionStore(db);
  // Workflow steps run as the tenant's agent itself, declared below (the graph exists before any tool runs).
  const orchestrator = createOrchestratorGraph({
    model: deps.models?.agent ?? deps.model,
    react: (goal, config, key) => reactFromAgentGraph(graph)(goal, config, key),
    checkpointer,
    usage: (config, tokens) => usage.add(tokens, Date.now(), { user: getRunContext(config).user_id }),
  });
  const builtins: [Feature, StructuredToolInterface][] = [
    ...(images ? imageTools(images, files).map((t): [Feature, StructuredToolInterface] => ["files", t]) : []),
    ["knowledge", searchKnowledgeTool(knowledge)],
    ["knowledge", saveKnowledgeTool(knowledge)],
    ["skills", loadSkillTool(skills)],
    ...memoryTools(memory).map((t): [Feature, StructuredToolInterface] => ["memory", t]),
    ...fileTools(files, gotenberg).map((t): [Feature, StructuredToolInterface] => ["files", t]),
    ["files", searchFilesTool(fileIndex)],
    ["files", chatFileTool(files)],
    ["sites", publishSiteTool(files, siteTargets)],
    ...(vitepress ? [["sites", buildVitepressTool(files, vitepress)] as [Feature, StructuredToolInterface]] : []),
    ["integrations", tool(async (_, config) => JSON.stringify(await standardAccounts.list(getRunContext(config).user_id)), {
      name: "standard_accounts", description: "Seznam mých propojených účtů pro poštu (SMTP/IMAP/POP3), CalDAV kalendář a CardDAV kontakty. Vrací názvy účtů pro ostatní nástroje.", schema: z.object({}),
    })],
    ...[...mailTools(standardAccounts, deps.mcp?.allowPrivate), ...davTools(standardAccounts, deps.mcp?.allowPrivate)].map((t): [Feature, StructuredToolInterface] => ["integrations", t]),
    ...googleTools(integrations, deps.integrations?.fetch).map((t): [Feature, StructuredToolInterface] => ["integrations", t]),
    ...microsoftTools(integrations, deps.integrations?.fetch).map((t): [Feature, StructuredToolInterface] => ["integrations", t]),
    ...databaseTools(data).map((t): [Feature, StructuredToolInterface] => ["database", t]),
    ["http", httpRequestTool(secrets, { allowPrivate: deps.mcp?.allowPrivate, fetch: deps.fetch })],
    ...(deps.extraTools?.(files) ?? []),
    ["workflows", workflowTool(orchestrator, questions)],
  ];
  const graph = createAgentGraph({
    questions,
    images: async (threadId, paths) => {
      if (!(await features.get()).files) return [];
      return Promise.all(paths.map(async path => {
        const { data } = await files.read({ scope: "temp", threadId }, path);
        return { type: "image_url" as const, image_url: { url: `data:${fileType(path)!.mime};base64,${data.toString("base64")}` } };
      }));
    },
    tenantId: id,
    model: deps.model,
    models: deps.models,
    tools: [questions.tool()],
    // Resolved on every step, so switching a feature or a tool applies from the next step.
    dynamicTools: async (ctx) => {
      if (ctx.channel === "public") {
        const assistant = await publicAssistants.get(ctx.assistant);
        if (!assistant) return [];
        const notify = deps.notifyAdmins
          ? (i: Inquiry) =>
              deps.notifyAdmins!(
                translate(configuredLocale(), "email.inquiry.subject", { name: i.name }),
                translate(configuredLocale(), "email.inquiry.text", {
                  assistant: assistant.title || assistant.name,
                  name: i.name,
                  contact: i.contact,
                  time: i.preferredTime ? `${translate(configuredLocale(), "email.inquiry.time", { time: i.preferredTime })}\n` : "",
                  description: i.description,
                }),
              )
          : undefined;
        return publicTools({ knowledge, inquiries, skills, notify }, assistant);
      }
      const [on, off] = await Promise.all([features.get(), features.disabledTools()]);
      // Integration tools only for accounts the user connected.
      const connected = on.integrations ? await integrations.connected(ctx.user_id) : [];
      const standard = on.integrations ? await standardAccounts.list(ctx.user_id) : [];
      const usable = (f: Feature, name: string) =>
        f !== "integrations" ||
        (name === "standard_accounts" && standard.length > 0) ||
        connected.some((p) => name.startsWith(`${p}_`)) ||
        standard.some((a) => name.startsWith(`${a.kind}_`));
      const tools = builtins.filter(([f, t]) => on[f] && !(ctx.workflow && t.name === WORKFLOW_TOOL) && (!t.name.startsWith("image_") || on.mcp) && !off.includes(t.name) && usable(f, t.name)).map(([, t]) => t);
      return on.mcp ? [...tools, ...(await mcp.tools(ctx.user_id)).filter(t => !images || !t.name.startsWith(`${deps.images?.server ?? "comfy-cloud"}_`))] : tools;
    },
    features,
    usage,
    rules: (ctx) => (ctx.channel === "public" ? publicRules(ctx.assistant) : rules(ctx.user_id)),
    persona: async (ctx) =>
      ctx.channel === "public"
        ? (await profiles.get(publicProfile(ctx.assistant ?? ""))).persona
        : ((await profiles.get(ctx.user_id)).persona ?? (await userDefaults()).persona ?? null),
    publicPrompt: async (ctx) => {
      const a = await publicAssistants.get(ctx.assistant);
      if (!a) throw new Error(`No public assistant ${ctx.assistant}`);
      const [r, profile, own, facts] = await Promise.all([
        publicRules(a.name),
        profiles.get(publicProfile(a.name)),
        skills.tenantSkills(),
        memory.tenantByIds(a.memories),
      ]);
      return buildPublicPrompt({
        title: a.title || id,
        timezone: deps.timezone,
        rules: r,
        persona: profile.persona,
        skills: own.filter((s) => a.skills.includes(s.name)),
        memories: facts,
        knowledge: a.knowledge.length > 0,
        tools: a.tools,
      });
    },
    publicLimit: async (ctx) => (await publicAssistants.get(ctx.assistant))?.tokensPerMonth ?? null,
    checkpointer,
    timezone: deps.timezone,
    skills,
    memory,
    settings,
    secrets,
    database: () => data.tables(),
  });
  // Old tenants' documents and skills move to files once, then the indexes catch up with the files on disk.
  const init = async () => {
    if (images && deps.comfyApiKey) {
      const name = deps.images?.server ?? "comfy-cloud", keyName = deps.images?.uploadApiKeySecret ?? "COMFY_API_KEY";
      if (!(await secrets.list("")).some(secret => secret.name === keyName)) await secrets.put(keyName, "", { value: deps.comfyApiKey, allowedHosts: ["cloud.comfy.org"], description: "Comfy Cloud runtime credential" });
      if (!await mcpServers.get(name, "")) {
        await mcpServers.put(name, "", { url: "https://cloud.comfy.org/mcp", auth: "headers", enabled: true, headers: { "X-API-Key": `{{secret:${keyName}}}` } });
        mcp.invalidate("");
      }
    }
    await moveLegacyToFiles(db, files);
    await moveKnowledgeToDb(db, files, knowledge);
    await publicAssistants.migrateLegacy(skills);
    await guards.migrateProfiles(db);
    await indexer!.reconcile();
    // A chat's scratchpad lives as long as the chat; one whose chat is gone (from before it did) goes now.
    for (const thread of await files.tempThreads()) {
      if (!(await db.execute({ sql: "SELECT 1 FROM threads WHERE id = ?", args: [thread] })).rows.length) await files.removeTemp(thread);
    }
    await images?.cleanup();
  };
  return {
    id,
    db,
    checkpointer,
    knowledge,
    skills,
    memory,
    mcpServers,
    mcp,
    settings,
    secrets,
    features,
    files,
    data,
    fileIndex,
    siteTargets,
    integrations,
    standardAccounts,
    publicAssistants,
    inquiries,
    vitepress,
    builtinTools: builtins,
    usage,
    profiles,
    guards,
    rules,
    model: deps.models?.agent ?? deps.model,
    personaModel: deps.models?.persona ?? deps.model,
    graph,
    questions,
    media: deps.media ?? new MediaReader(undefined),
    init,
  };
}
