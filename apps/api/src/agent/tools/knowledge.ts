import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { KnowledgeStore } from "../../rag/store.ts";

export function searchKnowledgeTool(store: KnowledgeStore) {
  return tool(
    async ({ query }) => {
      const results = await store.search(query, 5);
      if (!results.length) return "Nic nenalezeno.";
      return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`).join("\n\n---\n\n");
    },
    {
      name: "search_knowledge",
      description:
        "Vyhledá ve znalostní bázi firmy (poznámky ke klientům, zakázkám, ceníky, postupy). Vrací nejrelevantnější úryvky.",
      schema: z.object({ query: z.string().min(1).describe("Co hledat, přirozeným jazykem") }),
    },
  );
}
