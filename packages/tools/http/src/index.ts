import type { ToolModule } from "@osiris/core/tools/module.ts";
import { httpRequestTool } from "./tools.ts";

/** HTTP requests to public APIs, with the project's and user's secrets filled in on the server. */
export function httpModule(): ToolModule {
  return { name: "http", feature: "http", create: (host) => ({ tools: [httpRequestTool(host.secrets, { allowPrivate: host.allowPrivate, fetch: host.fetch })] }) };
}

export * from "./tools.ts";
