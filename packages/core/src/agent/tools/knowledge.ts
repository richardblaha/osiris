import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { DOCUMENT_ID, type KnowledgeStore } from "../../rag/store.ts";
import { slug } from "../../files/sync.ts";

export function searchKnowledgeTool(store: KnowledgeStore) {
  return tool(
    async ({ query }) => {
      const results = await store.search(query, "", 5);
      if (!results.length) return "Nic nenalezeno.";
      return results.map((r, i) => `[${i + 1}] ${r.title} (${r.path.replace(/^knowledge\//, "")})\n${r.content}`).join("\n\n---\n\n");
    },
    {
      name: "search_knowledge",
      description:
        "Vyhledá ve znalostní bázi firmy (dokumenty: poznámky ke klientům, zakázkám, ceníky, postupy) podle významu i slov. Vrací nejrelevantnější úryvky s id dokumentu.",
      schema: z.object({ query: z.string().min(1).describe("Co hledat, přirozeným jazykem") }),
    },
  );
}

/** Adds or replaces a document of the knowledge base (it isn't a file any more, so write_file can't). */
export function saveKnowledgeTool(store: KnowledgeStore) {
  return tool(
    async ({ id, title, content }) => {
      const doc = id ?? `${slug(title)}.md`;
      if (!DOCUMENT_ID.test(doc)) return "Neplatné id dokumentu (písmena, číslice, tečky, pomlčky, / mezi složkami).";
      await store.putDocument(doc, content, title);
      return `Uloženo do znalostí jako ${doc}.`;
    },
    {
      name: "save_knowledge",
      description:
        "Uloží dokument do znalostní báze firmy (nový, nebo přepíše dokument se stejným id). Jen na pokyn uživatele; drobné fakty patří do paměti (remember).",
      schema: z.object({
        title: z.string().trim().min(1).max(200),
        content: z.string().min(1).max(200_000).describe("Text dokumentu v Markdownu"),
        id: z.string().max(300).optional().describe("Id existujícího dokumentu k přepsání, např. cenik.md nebo public/cenik.md"),
      }),
    },
  );
}
