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
}

export function openTenant(id: string, db: Client, deps: TenantDeps): Tenant {
  const checkpointer = new LibSQLSaver(db);
  const knowledge = new KnowledgeStore(db, deps.embeddings, deps.embeddingModel);
  const skills = new SkillStore(db, deps.bundledSkills);
  const memory = new MemoryStore(db);
  const mcpServers = new McpServerStore(db, deps.secrets);
  const mcp = new McpToolset(mcpServers, deps.mcp);
  const settings = new UserSettingsStore(db);
  const graph = createAgentGraph({
    tenantId: id,
    model: deps.model,
    tools: [searchKnowledgeTool(knowledge), loadSkillTool(skills), ...memoryTools(memory)],
    dynamicTools: (ctx) => mcp.tools(ctx.user_id),
    checkpointer,
    timezone: deps.timezone,
    skills,
    memory,
    settings,
  });
  return { id, db, checkpointer, knowledge, skills, memory, mcpServers, mcp, settings, graph };
}
