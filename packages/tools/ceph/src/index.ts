import type { ToolModule } from "@osiris/core/tools/module.ts";
import type { OpsOptions } from "@osiris/tools-ops";
import { cephTool } from "./tools.ts";

/** Managing the Ceph storage from the chat: ceph through the digital twin's ops API. */
export function cephModule(options: OpsOptions): ToolModule {
  return {
    name: "ceph",
    feature: "infrastructure",
    create: (host) => ({
      tools: options.projects.includes(host.projectId) ? [cephTool(options.ops, host.questions)] : [],
    }),
  };
}

export * from "./tools.ts";
