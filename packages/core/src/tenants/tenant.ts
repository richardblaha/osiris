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
import type { Feature } from "@osiris/shared";
import type { FeatureSource } from "./features.ts";
import { UsageStore } from "../agent/usage.ts";
import { McpOAuthStore } from "../mcp/oauth.ts";
import { FileIndex } from "../files/index.ts";
import { SiteTargetStore } from "../sites/sftp.ts";
import { publishSiteTool } from "../agent/tools/site.ts";
import { FileIndexer, moveLegacyToFiles } from "../files/sync.ts";
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
  const gotenberg = deps.gotenbergUrl ? new GotenbergClient(deps.gotenbergUrl) : undefined;
  // Each built-in tool belongs to a feature a system admin can switch off for the tenant.
  const builtins: [Feature, StructuredToolInterface][] = [
    ["knowledge", searchKnowledgeTool(knowledge)],
    ["skills", loadSkillTool(skills)],
    ...memoryTools(memory).map((t): [Feature, StructuredToolInterface] => ["memory", t]),
    ...fileTools(files, gotenberg).map((t): [Feature, StructuredToolInterface] => ["files", t]),
    ["files", searchFilesTool(fileIndex)],
    ["sites", publishSiteTool(files, siteTargets)],
    ["http", httpRequestTool(secrets, { allowPrivate: deps.mcp?.allowPrivate, fetch: deps.fetch })],
    ...(deps.extraTools?.(files) ?? []),
  ];
  const graph = createAgentGraph({
    tenantId: id,
    model: deps.model,
    tools: [],
    // Resolved on every step, so switching a feature or a tool applies from the next step.
    dynamicTools: async (ctx) => {
      const [on, off] = await Promise.all([features.get(), features.disabledTools()]);
      const tools = builtins.filter(([f, t]) => on[f] && !off.includes(t.name)).map(([, t]) => t);
      return on.mcp ? [...tools, ...(await mcp.tools(ctx.user_id))] : tools;
    },
    features,
    usage,
    rules: (ctx) => rules(ctx.user_id),
    persona: async (ctx) => (await profiles.get(ctx.user_id)).persona ?? (await profiles.get("")).persona,
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
    builtinTools: builtins,
    usage,
    profiles,
    rules,
    model: deps.model,
    graph,
    init,
  };
}
