import type { ToolModule } from "@osiris/core/tools/module.ts";
import type { OpsOptions } from "@osiris/tools-ops";
import { kubectlTool } from "./tools.ts";

/** Reading the Kubernetes cluster from the chat: kubectl through the digital twin's ops API, read-only. */
export function kubernetesModule(options: OpsOptions): ToolModule {
  return {
    name: "kubernetes",
    feature: "infrastructure",
    create: (host) => ({
      tools: options.projects.includes(host.projectId) ? [kubectlTool(options.ops)] : [],
    }),
  };
}

export * from "./tools.ts";
