import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { DOCUMENT_ID, type KnowledgeStore } from "@osiris/core/rag/store.ts";
import { slug } from "@osiris/core/files/sync.ts";
import { getRunContext } from "@osiris/core/agent/context.ts";

export function searchKnowledgeTool(store: KnowledgeStore) {
  return tool(
    async ({ query }, config) => {
      const results = await store.search(query, getRunContext(config).user_id, 5);
      if (!results.length) return "Nic nenalezeno.";
      return results.map((r, i) => `[${i + 1}] ${r.title} (${r.path.replace(/^knowledge\//, "")})\n${r.content}`).join("\n\n---\n\n");
    },
    {
      name: "search_knowledge",
      description:
        "Vyhledá ve znalostní bázi firmy a ve vlastních dokumentech uživatele (poznámky ke klientům, zakázkám, ceníky, postupy) podle významu i slov. Vrací nejrelevantnější úryvky s id dokumentu.",
      schema: z.object({ query: z.string().min(1).describe("Co hledat, přirozeným jazykem") }),
    },
  );
}

/** Adds or replaces a document of the knowledge base (it isn't a file any more, so write_file can't). */
export function saveKnowledgeTool(store: KnowledgeStore) {
  return tool(
    async ({ id, title, content, scope }, config) => {
      const { user_id, role } = getRunContext(config);
      const target = scope ?? (role === "admin" ? "project" : "personal");
      if (target === "project" && role !== "admin") return "Do znalostí firmy zapisuje jen správce. Ulož to jako vlastní dokument (scope personal); se stejným id firemní dokument uživateli nahradí.";
      const doc = id ?? `${slug(title)}.md`;
      if (!DOCUMENT_ID.test(doc)) return "Neplatné id dokumentu (písmena, číslice, tečky, pomlčky, / mezi složkami).";
      await store.putDocument(doc, content, title, target === "project" ? "" : user_id);
      return `Uloženo do ${target === "project" ? "znalostí firmy" : "vlastních znalostí"} jako ${doc}.`;
    },
    {
      name: "save_knowledge",
      description:
        "Uloží dokument do znalostní báze (nový, nebo přepíše dokument se stejným id). Správce ukládá standardně pro firmu, ostatní jen pro sebe; vlastní dokument se stejným id jako firemní ho uživateli nahradí. Jen na pokyn uživatele; drobné fakty patří do paměti (remember).",
      schema: z.object({
        title: z.string().trim().min(1).max(200),
        content: z.string().min(1).max(200_000).describe("Text dokumentu v Markdownu"),
        id: z.string().max(300).optional().describe("Id existujícího dokumentu k přepsání, např. cenik.md nebo public/cenik.md"),
        scope: z.enum(["project", "personal"]).optional().describe("project = znalosti firmy (jen správce), personal = vlastní dokument uživatele"),
      }),
    },
  );
}
