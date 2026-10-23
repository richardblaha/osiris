import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { SkillStore } from "../skills.ts";
import { getRunContext } from "../context.ts";

export function loadSkillTool(skills: SkillStore) {
  return tool(async ({ name }, config) => (await skills.get(name, getRunContext(config).user_id))?.instructions ?? `Dovednost „${name}“ neexistuje.`, {
    name: "load_skill",
    description:
      "Načte podrobný postup pro dovednost ze seznamu DOVEDNOSTI. Zavolej ho dřív, než se do takového úkolu pustíš.",
    schema: z.object({ name: z.string().describe("Název dovednosti") }),
  });
}
