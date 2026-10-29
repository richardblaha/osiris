import type { ToolModule } from "@osiris/core/tools/module.ts";
import { buildVitepressTool, publishSiteTool } from "./tools.ts";

/** The project's website: build it (only with the VitePress builder) and publish it over SFTP. */
export function sitesModule(): ToolModule {
  return {
    name: "sites",
    feature: "sites",
    create: (host) => ({
      tools: [publishSiteTool(host.files, host.siteTargets), ...(host.vitepress ? [buildVitepressTool(host.files, host.vitepress)] : [])],
    }),
  };
}

export * from "./tools.ts";
