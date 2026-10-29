import type { ToolModule } from "@osiris/core/tools/module.ts";
import { memoryTools } from "./tools.ts";

/** Long-term memory: remember and forget facts. */
export function memoryModule(): ToolModule {
  return { name: "memory", feature: "memory", create: (host) => ({ tools: memoryTools(host.memory) }) };
}

export * from "./tools.ts";
