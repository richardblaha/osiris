import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getRunContext } from "../context.ts";
import type { MemoryStore } from "../memory.ts";

/**
 * The project's memory is the admins' to change; everyone else remembers for themselves, and may replace a project
 * memory with their own version (`replaces`), which only they get.
 */
export function memoryTools(memory: MemoryStore) {
  const remember = tool(
    async ({ content, scope, replaces }, config) => {
      const { user_id, role } = getRunContext(config);
      const target = replaces ? "personal" : (scope ?? (role === "admin" ? "project" : "personal"));
      if (target === "project" && role !== "admin") return "Firemní paměť mění jen správce. Ulož to jako osobní (scope personal).";
      try {
        const m = await memory.add(user_id, content, target, replaces);
        return `Uloženo (${target === "project" ? "firemní" : "osobní"}, id ${m.id}).`;
      } catch {
        return "Záznam k nahrazení nenalezen (replaces musí být id firemního záznamu ze sekce PAMĚŤ).";
      }
    },
    {
      name: "remember",
      description:
        "Trvale si zapamatuje fakt, který se bude hodit i v dalších konverzacích. Ukládej jen to, co uživatel řekl nebo potvrdil, ne obsah dokumentů. " +
        "Správce ukládá standardně pro celou firmu, ostatní jen pro sebe. replaces = id firemního záznamu, který tento osobní záznam uživateli nahradí.",
      schema: z.object({
        content: z.string().trim().min(1).max(500).describe("Stručný fakt jednou větou"),
        scope: z.enum(["project", "personal"]).optional().describe("project = pro celou firmu (jen správce), personal = jen pro tohoto uživatele"),
        replaces: z.string().optional().describe("Id firemního záznamu, který má uživatel místo něj mít ve své verzi"),
      }),
    },
  );

  const forget = tool(
    async ({ id }, config) => {
      const { user_id, role } = getRunContext(config);
      if (await memory.delete(id, "personal", user_id)) return "Zapomenuto.";
      if (role === "admin" && (await memory.delete(id, "project", user_id))) return "Zapomenuto (firemní záznam).";
      return role === "admin" ? "Záznam nenalezen." : "Záznam nenalezen, nebo je firemní (ten maže jen správce; můžeš ho nahradit osobním přes remember s replaces).";
    },
    {
      name: "forget",
      description: "Smaže záznam z paměti podle id (ze sekce PAMĚŤ), když je neplatný nebo o to uživatel požádá.",
      schema: z.object({ id: z.string().describe("id záznamu") }),
    },
  );

  return [remember, forget];
}
