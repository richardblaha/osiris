import type { RunnableConfig } from "@langchain/core/runnables";
import type { Channel, Role } from "@osiris/shared";

/**
 * Per-run context passed in `config.configurable`. Tools must read user identity and role from here, never from
 * model arguments. The tenant is fixed by the graph itself: each tenant has its own graph over its own database.
 */
export interface RunContext {
  thread_id: string;
  tenant_id: string;
  user_id: string;
  role: Role;
  channel: Channel;
  /** On the `public` channel: which of the tenant's public assistants. */
  assistant?: string;
  /** Display name from PocketID, for the prompt. */
  user_name?: string;
}

export function getRunContext(config: RunnableConfig | undefined): RunContext {
  const c = config?.configurable as Partial<RunContext> | undefined;
  if (!c?.thread_id || !c.tenant_id || !c.user_id || !c.role || !c.channel) {
    throw new Error("Run context missing from config.configurable");
  }
  return c as RunContext;
}
