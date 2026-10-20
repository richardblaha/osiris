import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getRunContext } from "../context.ts";
import type { MemoryStore } from "../memory.ts";

/** Memory is the tenant's: what the assistant learns in anyone's conversation, everyone's assistant knows. */
export function memoryTools(memory: MemoryStore) {
  const remember = tool(
    async ({ content }, config) => {
      const m = await memory.add(getRunContext(config).user_id, content, "tenant");
      return `Uloženo (id ${m.id}).`;
    },
    {
      name: "remember",
      description:
        "Trvale si zapamatuje fakt o firmě, klientech nebo zakázkách, který se bude hodit i v dalších konverzacích (platí pro celou firmu). " +
        "Ukládej jen to, co uživatel řekl nebo potvrdil, ne obsah dokumentů. Osobní preference uživatele patří do jeho profilu, ne sem.",
      schema: z.object({ content: z.string().trim().min(1).max(500).describe("Stručný fakt jednou větou") }),
    },
  );

  const forget = tool(
    async ({ id }, config) => ((await memory.delete(id, "tenant", getRunContext(config).user_id)) ? "Zapomenuto." : "Záznam nenalezen."),
    {
      name: "forget",
      description: "Smaže záznam z paměti podle id (ze sekce PAMĚŤ), když je neplatný nebo o to uživatel požádá.",
      schema: z.object({ id: z.string().describe("id záznamu") }),
    },
  );

  return [remember, forget];
}
