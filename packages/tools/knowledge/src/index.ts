import type { ToolModule } from "@osiris/core/tools/module.ts";
import { saveKnowledgeTool, searchKnowledgeTool } from "./tools.ts";

/** The knowledge base: search and save documents. */
export function knowledgeModule(): ToolModule {
  return { name: "knowledge", feature: "knowledge", create: (host) => ({ tools: [searchKnowledgeTool(host.knowledge), saveKnowledgeTool(host.knowledge)] }) };
}

export * from "./tools.ts";
