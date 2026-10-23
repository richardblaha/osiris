import type { RunnableConfig } from "@langchain/core/runnables";
import type { Channel, Locale, Role } from "@osiris/shared";

/**
 * Per-run context passed in `config.configurable`. Tools must read user identity and role from here, never from
 * model arguments. The project is fixed by the graph itself: each project has its own graph over its own database.
 */
export interface RunContext {
  thread_id: string;
  project_id: string;
  user_id: string;
  role: Role;
  channel: Channel;
  /** On the `public` channel: which of the project's public assistants. */
  assistant?: string;
  /** The user's display name, for the prompt. */
  user_name?: string;
  /** The language of texts the run itself writes for people (quota notices, refusals, answer summaries); absent in runs from before it existed. */
  locale?: Locale;
  /** A step of a workflow (`run_workflow`): runs without asking the user (`ask_user`) or starting another workflow. */
  workflow?: boolean;
  /** The chat whose scratchpad (temp files) the run uses: a workflow step's is its chat's, not its own thread's. */
  scratch_thread?: string;
}

/** The thread whose temp files a run reads and writes. */
export const scratchThread = (ctx: RunContext) => ctx.scratch_thread ?? ctx.thread_id;

export function getRunContext(config: RunnableConfig | undefined): RunContext {
  const c = config?.configurable as Partial<RunContext> | undefined;
  if (!c?.thread_id || !c.project_id || !c.user_id || !c.role || !c.channel) {
    throw new Error("Run context missing from config.configurable");
  }
  return c as RunContext;
}
