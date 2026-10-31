import type { ToolModule } from "@osiris/core/tools/module.ts";
import type { OpsOptions } from "@osiris/tools-ops";
import { twinEventsTool, twinQueryTool, twinViewTool } from "./twin.ts";

/** The digital twin in the chat, for the projects that watch the cluster: steering its view, reading its objects and its events. */
export function digitalTwinModule(ops: OpsOptions): ToolModule {
  return {
    name: "digital-twin",
    feature: "infrastructure",
    create: (host) => ({
      tools: ops.projects.includes(host.projectId) ? [twinViewTool(), twinQueryTool(ops.ops), twinEventsTool(ops.ops)] : [],
    }),
  };
}

export * from "./twin.ts";
