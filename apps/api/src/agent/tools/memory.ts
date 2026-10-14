import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getRunContext } from "../context.ts";
import type { MemoryStore } from "../memory.ts";

export function memoryTools(memory: MemoryStore) {
  const remember = tool(
    async ({ content, shared }, config) => {
      const { user_id, role } = getRunContext(config);
      if (shared && role !== "admin") return "Sdílenou paměť pro celou firmu může ukládat jen správce. Ulož to jako osobní.";
      const m = await memory.add(user_id, content, shared ? "tenant" : "personal");
      return `Uloženo (${shared ? "firemní" : "osobní"}, id ${m.id}).`;
    },
    {
      name: "remember",
      description:
        "Trvale si zapamatuje fakt, který se bude hodit i v dalších konverzacích (preference uživatele, údaje o firmě). " +
        "Ukládej jen to, co uživatel řekl nebo potvrdil, ne obsah dokumentů.",
      schema: z.object({
        content: z.string().trim().min(1).max(500).describe("Stručný fakt jednou větou"),
        shared: z.boolean().default(false).describe("true = platí pro celou firmu (jen správce), false = jen pro tohoto uživatele"),
      }),
    },
  );

  const forget = tool(
    async ({ id }, config) => {
      const { user_id, role } = getRunContext(config);
      const deleted =
        (await memory.delete(id, "personal", user_id)) || (role === "admin" && (await memory.delete(id, "tenant", user_id)));
      return deleted ? "Zapomenuto." : "Záznam nenalezen nebo ho nelze smazat.";
    },
    {
      name: "forget",
      description: "Smaže záznam z paměti podle id (ze sekce PAMĚŤ), když je neplatný nebo o to uživatel požádá.",
      schema: z.object({ id: z.string().describe("id záznamu") }),
    },
  );

  return [remember, forget];
}
