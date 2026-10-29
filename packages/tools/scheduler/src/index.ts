import type { ToolModule } from "@osiris/core/tools/module.ts";
import { schedulerTools, type ScheduleClient } from "./tools.ts";

/** Scheduled tasks through control (server mode only). */
export function schedulerModule(control: ScheduleClient): ToolModule {
  return { name: "scheduler", feature: "scheduler", create: (host) => ({ tools: schedulerTools(control, host.timezone) }) };
}

export * from "./tools.ts";
