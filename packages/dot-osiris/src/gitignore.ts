import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OSIRIS_TEMP_GITIGNORE_ENTRY } from './layout.js';

const MARKER = '# Osiris — agent scratchpads, never committed';

/** Entries Osiris guarantees are present in the workspace `.gitignore`. */
export const OSIRIS_GITIGNORE_ENTRIES = [OSIRIS_TEMP_GITIGNORE_ENTRY] as const;

/**
 * Compute the `.gitignore` content that has every Osiris entry, given the
 * current content (or `undefined` if the file does not exist). Idempotent:
 * returns `null` when nothing needs to change.
 */
export function withOsirisGitignore(current: string | undefined): string | null {
  const text = current ?? '';
  const lines = text.split('\n');
  const present = new Set(lines.map((l) => l.trim()));
  const missing = OSIRIS_GITIGNORE_ENTRIES.filter((e) => !present.has(e));
  if (missing.length === 0) return null;

  const block = [MARKER, ...missing].join('\n');
  const needsNewline = text.length > 0 && !text.endsWith('\n');
  return `${text}${needsNewline ? '\n' : ''}${text.length ? '\n' : ''}${block}\n`;
}

/**
 * Ensure `<root>/.gitignore` ignores `.osiris/temp/`. Idempotent; returns `true`
 * when it wrote a change.
 */
export async function ensureGitignore(root: string): Promise<boolean> {
  const path = join(root, '.gitignore');
  let current: string | undefined;
  try {
    current = await readFile(path, 'utf8');
  } catch {
    current = undefined;
  }
  const next = withOsirisGitignore(current);
  if (next === null) return false;
  await writeFile(path, next, 'utf8');
  return true;
}
