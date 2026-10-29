import type { ToolModule } from "@osiris/core/tools/module.ts";
import { cephTool, kubectlTool, type OpsClient } from "./ops.ts";
import { twinViewTool } from "./twin.ts";

export interface InfrastructureOptions {
  /** The digital twin's ops API (kubectl, ceph); it answers only the projects it is told to. */
  ops: OpsClient;
  /** The projects whose agents have these tools. */
  projects: string[];
}

/**
 * Managing the infrastructure from the chat: kubectl and ceph through the digital twin's service (reads at once,
 * changes after the user's yes), and steering the twin's view. Only the configured projects' agents have them.
 */
export function infrastructureModule(options: InfrastructureOptions): ToolModule {
  return {
    name: "infrastructure",
    feature: "infrastructure",
    create: (host) => {
      if (!options.projects.includes(host.projectId)) return { tools: [] };
      return { tools: [kubectlTool(options.ops, host.questions), cephTool(options.ops, host.questions), twinViewTool()] };
    },
  };
}

export * from "./commands.ts";
export type { TwinAction } from "./twin.ts";
