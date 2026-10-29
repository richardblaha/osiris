import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { Feature, ProjectFeatures } from "@osiris/shared";
import type { RunContext } from "../agent/context.ts";
import type { AgentGraph } from "../agent/graph.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { QuestionStore } from "../agent/questions.ts";
import type { SkillStore } from "../agent/skills.ts";
import type { UsageStore } from "../agent/usage.ts";
import type { FileSaver } from "../checkpointer/file-saver.ts";
import type { DataStore } from "../database/store.ts";
import type { FileIndex } from "../files/index.ts";
import type { FileStore } from "../files/store.ts";
import type { VitepressClient } from "../files/vitepress.ts";
import type { IntegrationAccounts } from "../integrations/oauth.ts";
import type { StandardAccounts } from "../integrations/standard.ts";
import type { McpServerStore } from "../mcp/store.ts";
import type { McpToolset } from "../mcp/toolset.ts";
import type { FeatureSource } from "../projects/features.ts";
import type { Records } from "../projects/records.ts";
import type { KnowledgeStore } from "../rag/store.ts";
import type { SiteTargetStore } from "../sites/sftp.ts";
import type { SecretVault } from "../vault/vault.ts";

/** What a project lends its tool modules: its stores, models and settings. */
export interface ToolHost {
  projectId: string;
  timezone: string;
  records: Records;
  checkpointer: FileSaver;
  features: FeatureSource;
  usage: UsageStore;
  questions: QuestionStore;
  files: FileStore;
  fileIndex: FileIndex;
  knowledge: KnowledgeStore;
  memory: MemoryStore;
  skills: SkillStore;
  data: DataStore;
  secrets: SecretVault;
  mcp: McpToolset;
  mcpServers: McpServerStore;
  siteTargets: SiteTargetStore;
  integrations: IntegrationAccounts;
  standardAccounts: StandardAccounts;
  vitepress?: VitepressClient;
  /** The model of the first agent step, and the one reasoning over tool results. */
  models: { agent: BaseChatModel; tools: BaseChatModel };
  /** The project's agent graph; exists once the project is open, so call it only when a tool runs. */
  graph(): AgentGraph;
  /** Private addresses allowed (development only). */
  allowPrivate: boolean;
  /** Replaces global fetch (tests). */
  fetch?: typeof fetch;
  /** Replaces global fetch for the Google and Microsoft APIs (tests). */
  integrationsFetch?: typeof fetch;
}

/** A module's tools in one project. */
export interface ToolSet {
  tools: StructuredToolInterface[];
  /** Which of its tools a run may use, beyond the feature and the switched-off tools (e.g. only connected accounts). */
  usable?(run: RunContext, on: ProjectFeatures): Promise<(name: string) => boolean>;
  /** MCP tools the module takes over, hidden from the agent. */
  hidesMcpTool?(name: string): boolean;
  /** Runs at the project's init, after the indexes. */
  init?(): Promise<void>;
}

/**
 * A package of built-in tools of one kind (files, knowledge, integrations…). The runtime loads only the modules
 * its configuration names; the project's features then switch a loaded module's tools on and off per step.
 */
export interface ToolModule {
  /** Short name used in `TOOL_MODULES`. */
  name: string;
  /** The feature a system admin switches the module's tools with. */
  feature: Feature;
  create(host: ToolHost): ToolSet;
}
