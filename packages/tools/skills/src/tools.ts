import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SKILL_NAME, type SkillStore } from "@osiris/core/agent/skills.ts";
import { getRunContext } from "@osiris/core/agent/context.ts";

export function loadSkillTool(skills: SkillStore) {
  return tool(async ({ name }, config) => (await skills.get(name, getRunContext(config).user_id))?.instructions ?? `Dovednost „${name}“ neexistuje.`, {
    name: "load_skill",
    description:
      "Načte podrobný postup pro dovednost ze seznamu DOVEDNOSTI. Zavolej ho dřív, než se do takového úkolu pustíš.",
    schema: z.object({ name: z.string().describe("Název dovednosti") }),
  });
}

/** Writes a skill: the project's for admins, the user's own otherwise (a user's skill replaces the project's of the same name for them). */
export function saveSkillTool(skills: SkillStore) {
  return tool(
    async ({ name, description, instructions, scope }, config) => {
      const { user_id, role } = getRunContext(config);
      const target = scope ?? (role === "admin" ? "project" : "personal");
      if (target === "project" && role !== "admin") return "Dovednosti projektu zapisuje jen správce. Ulož ji jako vlastní (scope personal); se stejným názvem uživateli nahradí tu projektovou.";
      if (!SKILL_NAME.test(name)) return `Název „${name}“ není platný: jen malá písmena bez diakritiky, číslice a pomlčky (např. vystaveni-faktury).`;
      const existed = (await skills.get(name, user_id, target)) !== undefined;
      await skills.put({ name, description: description.trim(), instructions: instructions.trim() }, target, user_id);
      return `Dovednost „${name}“ ${existed ? "upravena" : "uložena"} (${target === "project" ? "projekt" : "vlastní"}). Od dalšího kroku je v seznamu DOVEDNOSTI.`;
    },
    {
      name: "save_skill",
      description:
        "Uloží novou dovednost nebo přepíše existující se stejným názvem. Dovednost je postup, který si pak kdokoli načte přes load_skill. " +
        "Ukládej jen to, co uživatel schválil.",
      schema: z.object({
        name: z.string().describe("Název v kebab-case bez diakritiky, např. vystaveni-faktury"),
        description: z.string().min(1).max(300).describe("Jedna věta: co dovednost dělá a kdy ji použít (podle toho ji model vybírá)"),
        instructions: z.string().min(1).max(50_000).describe("Postup v Markdownu: kroky, pravidla, příklady"),
        scope: z.enum(["project", "personal"]).optional().describe("project = pro celý projekt (jen správce), personal = jen pro uživatele"),
      }),
    },
  );
}
