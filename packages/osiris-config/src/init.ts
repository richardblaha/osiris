import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createLogger } from '@richardblaha/osiris-core';
import { OSIRIS_SUBDIRS, OsirisPaths } from './layout.js';
import { templateRoot } from './resolve.js';
import { ensureGitignore } from './gitignore.js';

const log = createLogger('dot-osiris:init');

export interface InitOptions {
  /** Overwrite files that already exist in the project. Default: keep them. */
  force?: boolean;
  /** Report what would happen without touching the filesystem. */
  dryRun?: boolean;
}

export interface InitResult {
  /** Files written (relative to the project root). */
  written: string[];
  /** Template files skipped because a project copy already existed. */
  skipped: string[];
  /** `.gitignore` was updated. */
  gitignoreChanged: boolean;
}

async function* walk(dir: string, prefix = ''): AsyncGenerator<{ abs: string; rel: string }> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* walk(abs, rel);
    } else {
      yield { abs, rel };
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scaffold `<root>/.osiris/` from the bundled system template. Existing project
 * files are preserved unless `force`. Always guarantees every sub-folder exists
 * (`temp/` gets a `.gitkeep`) and that `.gitignore` ignores `.osiris/temp/`.
 */
export async function initWorkspace(root: string, options: InitOptions = {}): Promise<InitResult> {
  const paths = new OsirisPaths(root);
  const result: InitResult = { written: [], skipped: [], gitignoreChanged: false };
  const tpl = templateRoot();

  for await (const file of walk(tpl)) {
    const dest = paths.resolve(file.rel);
    const destRel = relative(root, dest);
    if (!options.force && (await exists(dest))) {
      result.skipped.push(destRel);
      continue;
    }
    result.written.push(destRel);
    if (options.dryRun) continue;
    await mkdir(dirname(dest), { recursive: true });
    await cp(file.abs, dest);
  }

  // Guarantee every sub-folder exists even if the template ships it empty.
  for (const sub of OSIRIS_SUBDIRS) {
    const dir = paths.subdir(sub);
    if (options.dryRun) continue;
    await mkdir(dir, { recursive: true });
    if (sub === 'temp') {
      const keep = join(dir, '.gitkeep');
      if (!(await exists(keep))) await writeFile(keep, '');
    }
  }

  if (options.dryRun) {
    result.gitignoreChanged = true; // best-effort signal
  } else {
    result.gitignoreChanged = await ensureGitignore(root);
  }

  log.info(
    'init %s: %d written, %d kept%s',
    root,
    result.written.length,
    result.skipped.length,
    result.gitignoreChanged ? ', .gitignore updated' : '',
  );
  return result;
}
