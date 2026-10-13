import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Client } from "@libsql/client";
import { createAgentGraph, type AgentGraph } from "../agent/graph.ts";
import { MemoryStore } from "../agent/memory.ts";
import { SkillStore, type Skill } from "../agent/skills.ts";
import { searchKnowledgeTool } from "../agent/tools/knowledge.ts";
import { memoryTools } from "../agent/tools/memory.ts";
import { loadSkillTool } from "../agent/tools/skills.ts";
import { LibSQLSaver } from "../checkpointer/libsql-saver.ts";
import { KnowledgeStore } from "../rag/store.ts";

/** Everything one tenant owns, all on the tenant's own database. */
export interface Tenant {
  id: string;
  db: Client;
  checkpointer: LibSQLSaver;
  knowledge: KnowledgeStore;
  skills: SkillStore;
  memory: MemoryStore;
  graph: AgentGraph;
}

/** Shared, tenant-independent dependencies. */
export interface TenantDeps {
  model: BaseChatModel;
  embeddings: EmbeddingsInterface;
  embeddingModel: string;
  bundledSkills: Skill[];
  timezone: string;
}

export function openTenant(id: string, db: Client, deps: TenantDeps): Tenant {
  const checkpointer = new LibSQLSaver(db);
  const knowledge = new KnowledgeStore(db, deps.embeddings, deps.embeddingModel);
  const skills = new SkillStore(db, deps.bundledSkills);
  const memory = new MemoryStore(db);
  const graph = createAgentGraph({
    tenantId: id,
    model: deps.model,
    tools: [searchKnowledgeTool(knowledge), loadSkillTool(skills), ...memoryTools(memory)],
    checkpointer,
    timezone: deps.timezone,
    skills,
    memory,
  });
  return { id, db, checkpointer, knowledge, skills, memory, graph };
}
