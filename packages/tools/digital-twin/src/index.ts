import type { ToolModule } from "@osiris/core/tools/module.ts";
import { twinViewTool } from "./twin.ts";

/** Steering the digital twin's view from the chat, for the projects that manage the cluster. */
export function digitalTwinModule(projects: string[]): ToolModule {
  return {
    name: "digital-twin",
    feature: "infrastructure",
    create: (host) => ({
      tools: projects.includes(host.projectId) ? [twinViewTool()] : [],
    }),
  };
}

export * from "./twin.ts";
