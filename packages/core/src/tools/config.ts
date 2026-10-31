import { z } from "zod";
import type { Records } from "../projects/records.ts";

/** The project's tool settings, `.osiris/tools.json` (versioned with the project, edited in the folder or the repository). */
export const TOOLS_CONFIG = "tools.json";

/** The module name of the project's own tools (`.osiris/tools/`) in `modules`. */
export const CUSTOM_MODULE = "custom";

const toolsConfig = z
  .object({
    /** Whether a tool neither `tools` nor `modules` names is on (default true: everything on). */
    default: z.boolean().optional(),
    /** Whole tool modules by name (`files`, `http`, `integrations`, …, `custom`). */
    modules: z.record(z.string(), z.boolean()).optional(),
    /** Single tools by name; wins over its module. */
    tools: z.record(z.string(), z.boolean()).optional(),
  })
  .strict();

export type ToolsConfig = z.infer<typeof toolsConfig>;

/** Which of the project's tools `.osiris/tools.json` lets the agent use. */
export interface ToolPolicy {
  allows(tool: string, module: string): boolean;
  /** The file's problem when it isn't valid (then every tool but ask_user is off). */
  error?: string;
}

/** A tool's own entry wins, then its module's, then `default`. */
export function toolPolicy(config: ToolsConfig): ToolPolicy {
  return { allows: (tool, module) => config.tools?.[tool] ?? config.modules?.[module] ?? config.default ?? true };
}

/**
 * Reads `.osiris/tools.json` on every call, so an edit applies from the next step. No file: everything on. A file that
 * isn't valid switches every tool off (it fails closed: a typo must never switch on what the file meant to keep off).
 */
export async function readToolPolicy(records: Records): Promise<ToolPolicy> {
  let raw: unknown;
  try {
    raw = await records.read(TOOLS_CONFIG);
  } catch (err) {
    return closed(`.osiris/${TOOLS_CONFIG}: ${(err as Error).message}`);
  }
  if (raw === undefined) return toolPolicy({});
  const parsed = toolsConfig.safeParse(raw);
  if (!parsed.success) return closed(`.osiris/${TOOLS_CONFIG}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return toolPolicy(parsed.data);
}

const warned = new Set<string>();
function closed(error: string): ToolPolicy {
  if (!warned.has(error)) (warned.add(error), console.warn(`${error} — every tool is off until it is fixed`));
  return { allows: () => false, error };
}
