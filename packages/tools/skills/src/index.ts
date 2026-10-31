import type { ToolModule } from "@osiris/core/tools/module.ts";
import { loadSkillTool, saveSkillTool } from "./tools.ts";

/** Skills: loads a skill's instructions when the model needs them, and saves new ones (the bundled skill-creator). */
export function skillsModule(): ToolModule {
  return { name: "skills", feature: "skills", create: (host) => ({ tools: [loadSkillTool(host.skills), saveSkillTool(host.skills)] }) };
}

export * from "./tools.ts";
