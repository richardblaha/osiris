import type { ToolModule } from "@osiris/core/tools/module.ts";
import { databaseTools } from "./tools.ts";

/** The project's own database: tables, rows and read-only queries. */
export function databaseModule(): ToolModule {
  return { name: "database", feature: "database", create: (host) => ({ tools: databaseTools(host.data) }) };
}

export * from "./tools.ts";
