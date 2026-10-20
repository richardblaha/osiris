import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Client } from "@libsql/client";
import { createAgentGraph, type AgentGraph } from "../agent/graph.ts";
import { MemoryStore } from "../agent/memory.ts";
import { UserSettingsStore } from "../agent/settings.ts";
import { SkillStore, type Skill } from "../agent/skills.ts";
import { searchKnowledgeTool } from "../agent/tools/knowledge.ts";
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
import type { Feature, Inquiry } from "@osiris/shared";
import type { FeatureSource } from "./features.ts";
import { UsageStore } from "../agent/usage.ts";
import { McpOAuthStore } from "../mcp/oauth.ts";
import { FileIndex } from "../files/index.ts";
import { SiteTargetStore } from "../sites/sftp.ts";
import { buildPublicPrompt, InquiryStore, PUBLIC_PROFILE, PublicSettingsStore, publicTools } from "../public/assistant.ts";
import { googleTools } from "../integrations/google.ts";
import { microsoftTools } from "../integrations/microsoft.ts";
import { IntegrationAccounts, type IntegrationClient, type IntegrationProvider } from "../integrations/oauth.ts";
import { publishSiteTool } from "../agent/tools/site.ts";
import { FileIndexer, mergePersonalIntoTenant, moveLegacyToFiles } from "../files/sync.ts";
import { AssistantProfileStore, type GuardRules } from "../agent/assistant.ts";

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
  /** Full-text index of the tenant's and users' text files. */
  fileIndex: FileIndex;
  /** Where the tenant's website is published over SFTP. */
  siteTargets: SiteTargetStore;
  /** Users' Google and Microsoft accounts. */
  integrations: IntegrationAccounts;
  /** The assistant for the tenant's customers, and the inquiries it took. */
  publicSettings: PublicSettingsStore;
  inquiries: InquiryStore;
  /** Run once before serving: moves old database content to files and brings the indexes up to date. */
  init(): Promise<void>;
  /** The built-in tools, each with the feature it belongs to. */
  builtinTools: [Feature, StructuredToolInterface][];
  usage: UsageStore;
  /** Persona and rules, tenant-wide (owner '') and per user. */
  profiles: AssistantProfileStore;
  /** The rules a user's runs keep to: system, tenant and the user's own. */
  rules(userId: string): Promise<GuardRules>;
  model: BaseChatModel;
  graph: AgentGraph;
}

/** Shared, tenant-independent dependencies. */
export interface TenantDeps {
  model: BaseChatModel;
  embeddings: EmbeddingsInterface;
  embeddingModel: string;
  bundledSkills: Skill[];
  timezone: string;
  secrets: SecretBox;
  mcp?: McpOptions;
  /** Where the tenant's files live. */
  files: FileStoreOptions & { dir: string };
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
  const settings = new UserSettingsStore(db);
  const features = deps.features;
  const usage = new UsageStore(db);
  const profiles = new AssistantProfileStore(db);
  const rules = async (userId: string): Promise<GuardRules> => {
    const [system, tenant, user] = await Promise.all([features.systemGuards(), profiles.get(""), profiles.get(userId)]);
    return { system, tenant: tenant.guards, user: user.guards };
  };
  // The public assistant (customers): its own persona and rules after the system's and the tenant's.
  const publicSettings = new PublicSettingsStore(db);
  const publicRules = async (): Promise<GuardRules> => {
    const [system, tenant, open] = await Promise.all([features.systemGuards(), profiles.get(""), profiles.get(PUBLIC_PROFILE)]);
    return { system, tenant: tenant.guards, user: open.guards };
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
  indexer = new FileIndexer(files, fileIndex, knowledge);
  const skills = new SkillStore(files, deps.bundledSkills);
  const siteTargets = new SiteTargetStore(db, deps.secrets);
  const integrations = new IntegrationAccounts(
    db,
    deps.secrets,
    deps.integrations?.clients ?? {},
    deps.integrations?.redirectUrl ?? "http://localhost:5173/integration-callback",
    deps.integrations?.fetch,
  );
  const gotenberg = deps.gotenbergUrl ? new GotenbergClient(deps.gotenbergUrl) : undefined;
  // Each built-in tool belongs to a feature a system admin can switch off for the tenant.
  const builtins: [Feature, StructuredToolInterface][] = [
    ["knowledge", searchKnowledgeTool(knowledge)],
    ["skills", loadSkillTool(skills)],
    ...memoryTools(memory).map((t): [Feature, StructuredToolInterface] => ["memory", t]),
    ...fileTools(files, gotenberg).map((t): [Feature, StructuredToolInterface] => ["files", t]),
    ["files", searchFilesTool(fileIndex)],
    ["sites", publishSiteTool(files, siteTargets)],
    ...googleTools(integrations, deps.integrations?.fetch).map((t): [Feature, StructuredToolInterface] => ["integrations", t]),
    ...microsoftTools(integrations, deps.integrations?.fetch).map((t): [Feature, StructuredToolInterface] => ["integrations", t]),
    ["http", httpRequestTool(secrets, { allowPrivate: deps.mcp?.allowPrivate, fetch: deps.fetch })],
    ...(deps.extraTools?.(files) ?? []),
  ];
  const graph = createAgentGraph({
    tenantId: id,
    model: deps.model,
    tools: [],
    // Resolved on every step, so switching a feature or a tool applies from the next step.
    dynamicTools: async (ctx) => {
      if (ctx.channel === "public") {
        const settings = await publicSettings.get();
        const notify = deps.notifyAdmins
          ? (i: Inquiry) =>
              deps.notifyAdmins!(
                `Nová poptávka: ${i.name}`,
                `Veřejný asistent přijal poptávku.\n\nJméno: ${i.name}\nKontakt: ${i.contact}\n${i.preferredTime ? `Termín: ${i.preferredTime}\n` : ""}\n${i.description}\n\nPoptávky najdete v Osirisu v části Veřejný asistent.`,
              )
          : undefined;
        return publicTools({ knowledge, inquiries, skills, notify }, settings.tools);
      }
      const [on, off] = await Promise.all([features.get(), features.disabledTools()]);
      // Google and Microsoft tools only for accounts the user connected.
      const connected = on.integrations ? await integrations.connected(ctx.user_id) : [];
      const usable = (f: Feature, name: string) => f !== "integrations" || connected.some((p) => name.startsWith(`${p}_`));
      const tools = builtins.filter(([f, t]) => on[f] && !off.includes(t.name) && usable(f, t.name)).map(([, t]) => t);
      return on.mcp ? [...tools, ...(await mcp.tools(ctx.user_id))] : tools;
    },
    features,
    usage,
    rules: (ctx) => (ctx.channel === "public" ? publicRules() : rules(ctx.user_id)),
    persona: async (ctx) =>
      ctx.channel === "public" ? (await profiles.get(PUBLIC_PROFILE)).persona : ((await profiles.get(ctx.user_id)).persona ?? (await profiles.get("")).persona),
    publicPrompt: async () => {
      const [settings, r, profile, open] = await Promise.all([publicSettings.get(), publicRules(), profiles.get(PUBLIC_PROFILE), skills.publicSkills()]);
      return buildPublicPrompt({ title: settings.title || id, timezone: deps.timezone, rules: r, persona: profile.persona, skills: open, tools: settings.tools });
    },
    publicLimit: async () => (await publicSettings.get()).tokensPerMonth,
    checkpointer,
    timezone: deps.timezone,
    skills,
    memory,
    settings,
    secrets,
  });
  // Old tenants' documents and skills move to files once, then the indexes catch up with the files on disk.
  const init = async () => {
    await moveLegacyToFiles(db, files);
    await mergePersonalIntoTenant(db, files);
    await indexer!.reconcile();
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
    fileIndex,
    siteTargets,
    integrations,
    publicSettings,
    inquiries,
    builtinTools: builtins,
    usage,
    profiles,
    rules,
    model: deps.model,
    graph,
    init,
  };
}
