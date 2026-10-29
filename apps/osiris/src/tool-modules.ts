import type { ToolModule } from "@osiris/core/tools/module.ts";
import type { ImagesToolOptions } from "@osiris/tools-images";
import type { ScheduleClient } from "@osiris/tools-scheduler";
import type { InfrastructureOptions } from "@osiris/tools-infrastructure";

/** What the tool modules need from the runtime's configuration. */
export interface ToolModuleOptions {
  /** Module names, or "all". */
  enabled: string[];
  gotenbergUrl?: string;
  /** Image generation is on only with these. */
  images?: ImagesToolOptions;
  /** Control's scheduled tasks (server mode); without it there is no scheduler module. */
  schedules?: ScheduleClient;
  /** The digital twin's ops API (server mode); without it there is no infrastructure module. */
  infrastructure?: InfrastructureOptions;
}

/**
 * Each module's package is imported only when the configuration names it, so a module left out costs nothing
 * (not even its dependencies, like sharp or the mail clients). The order is the order of the agent's tool list.
 */
const MODULES: Record<string, (o: ToolModuleOptions) => Promise<ToolModule | undefined>> = {
  images: async (o) => (o.images ? (await import("@osiris/tools-images")).imagesModule(o.images) : undefined),
  knowledge: async () => (await import("@osiris/tools-knowledge")).knowledgeModule(),
  skills: async () => (await import("@osiris/tools-skills")).skillsModule(),
  memory: async () => (await import("@osiris/tools-memory")).memoryModule(),
  files: async (o) => (await import("@osiris/tools-files")).filesModule({ gotenbergUrl: o.gotenbergUrl }),
  sites: async () => (await import("@osiris/tools-sites")).sitesModule(),
  integrations: async () => (await import("@osiris/tools-integrations")).integrationsModule(),
  database: async () => (await import("@osiris/tools-database")).databaseModule(),
  http: async () => (await import("@osiris/tools-http")).httpModule(),
  scheduler: async (o) => (o.schedules ? (await import("@osiris/tools-scheduler")).schedulerModule(o.schedules) : undefined),
  workflows: async () => (await import("@osiris/tools-workflows")).workflowsModule(),
  infrastructure: async (o) => (o.infrastructure ? (await import("@osiris/tools-infrastructure")).infrastructureModule(o.infrastructure) : undefined),
};

export const TOOL_MODULE_NAMES = Object.keys(MODULES);

/** Loads the configured tool modules; an unknown name is a configuration error. */
export async function loadToolModules(options: ToolModuleOptions): Promise<ToolModule[]> {
  const all = options.enabled.includes("all");
  const unknown = options.enabled.filter((n) => n !== "all" && !(n in MODULES));
  if (unknown.length) throw new Error(`TOOL_MODULES: unknown module ${unknown.join(", ")} (known: ${TOOL_MODULE_NAMES.join(", ")})`);
  const names = TOOL_MODULE_NAMES.filter((n) => all || options.enabled.includes(n));
  const loaded = await Promise.all(names.map((n) => MODULES[n]!(options)));
  return loaded.filter((m): m is ToolModule => !!m);
}
