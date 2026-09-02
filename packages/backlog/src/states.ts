import { readdir } from 'node:fs/promises';

/** Conventional workflow states, in order. Projects may add or rename folders. */
export const DEFAULT_STATES = ['todo', 'in-progress', 'review', 'done'] as const;

const NON_STATE_DIRS = new Set(['.git']);

/**
 * The workflow states for a backlog = the sub-folders of its root. Known states
 * keep their canonical order; unknown folders are appended alphabetically.
 */
export async function discoverStates(backlogRoot: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    const dirents = await readdir(backlogRoot, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory() && !NON_STATE_DIRS.has(d.name)).map((d) => d.name);
  } catch {
    return [...DEFAULT_STATES];
  }
  if (entries.length === 0) return [...DEFAULT_STATES];
  const known = DEFAULT_STATES.filter((s) => entries.includes(s));
  const extra = entries.filter((s) => !DEFAULT_STATES.includes(s as never)).sort();
  return [...known, ...extra];
}
