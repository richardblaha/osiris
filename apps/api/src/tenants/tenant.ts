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
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { Feature } from "@osiris/shared";
import { TenantFeatureStore, TenantProfileStore } from "./features.ts";

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
  features: TenantFeatureStore;
  /** Display name and archived flag, managed by system admins. */
  profile: TenantProfileStore;
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
  /** Replaces global fetch for the http_request tool (tests). */
  fetch?: typeof fetch;
}

export function openTenant(id: string, db: Client, deps: TenantDeps): Tenant {
  const checkpointer = new LibSQLSaver(db);
  const knowledge = new KnowledgeStore(db, deps.embeddings, deps.embeddingModel);
  const skills = new SkillStore(db, deps.bundledSkills);
  const memory = new MemoryStore(db);
  const mcpServers = new McpServerStore(db, deps.secrets);
  const secrets = new SecretVault(db, deps.secrets);
  const mcp = new McpToolset(mcpServers, secrets, deps.mcp);
  const settings = new UserSettingsStore(db);
  const features = new TenantFeatureStore(db);
  const profile = new TenantProfileStore(db);
  // Each built-in tool belongs to a feature a system admin can switch off for the tenant.
  const builtins: [Feature, StructuredToolInterface][] = [
    ["knowledge", searchKnowledgeTool(knowledge)],
    ["skills", loadSkillTool(skills)],
    ...memoryTools(memory).map((t): [Feature, StructuredToolInterface] => ["memory", t]),
    ["http", httpRequestTool(secrets, { allowPrivate: deps.mcp?.allowPrivate, fetch: deps.fetch })],
  ];
  const graph = createAgentGraph({
    tenantId: id,
    model: deps.model,
    tools: [],
    // Resolved on every step, so switching a feature applies from the next step.
    dynamicTools: async (ctx) => {
      const on = await features.get();
      const tools = builtins.filter(([f]) => on[f]).map(([, t]) => t);
      return on.mcp ? [...tools, ...(await mcp.tools(ctx.user_id))] : tools;
    },
    features,
    checkpointer,
    timezone: deps.timezone,
    skills,
    memory,
    settings,
    secrets,
  });
  return { id, db, checkpointer, knowledge, skills, memory, mcpServers, mcp, settings, secrets, features, profile, graph };
}
