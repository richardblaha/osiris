import type { ToolModule } from "@osiris/core/tools/module.ts";
import { loadSkillTool } from "./tools.ts";

/** Skills: loads a skill's instructions when the model needs them. */
export function skillsModule(): ToolModule {
  return { name: "skills", feature: "skills", create: (host) => ({ tools: [loadSkillTool(host.skills)] }) };
}

export * from "./tools.ts";
