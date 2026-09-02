import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { OsirisPaths } from './layout.js';

/**
 * Absolute path of the bundled system template (`packages/dot-osiris/template/`).
 * This is the fallback used when a project has no local `.osiris/<x>` and the
 * skeleton `initWorkspace` writes.
 */
export function templateRoot(): string {
  // dist/resolve.js → ../template
  return fileURLToPath(new URL('../template/', import.meta.url));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

export interface ResolvedFile {
  /** Absolute path that was read. */
  path: string;
  /** `project` if it came from `<root>/.osiris`, `template` if from the bundle. */
  source: 'project' | 'template';
  content: string;
}

/**
 * Read a file relative to `.osiris/` (e.g. `agents/architect.md`, `crew.json`),
 * preferring the project's copy and falling back to the bundled template.
 * Returns `undefined` if neither has it.
 */
export async function resolveOsirisFile(
  paths: OsirisPaths,
  relative: string,
): Promise<ResolvedFile | undefined> {
  const projectPath = paths.resolve(relative);
  if (await fileExists(projectPath)) {
    return { path: projectPath, source: 'project', content: await readFile(projectPath, 'utf8') };
  }
  const templatePath = join(templateRoot(), relative);
  if (await fileExists(templatePath)) {
    return {
      path: templatePath,
      source: 'template',
      content: await readFile(templatePath, 'utf8'),
    };
  }
  return undefined;
}

/**
 * List files inside an `.osiris/` sub-folder, merging the project's entries with
 * the template's (project wins on name collision). Non-recursive unless
 * `recursive` is set; `filter` matches on the entry's path relative to the
 * sub-folder.
 */
export async function listOsirisDir(
  paths: OsirisPaths,
  relativeDir: string,
  options: { recursive?: boolean; filter?: (relPath: string) => boolean } = {},
): Promise<{ relPath: string; path: string; source: 'project' | 'template' }[]> {
  const filter = options.filter ?? (() => true);
  const seen = new Map<string, { relPath: string; path: string; source: 'project' | 'template' }>();

  const scan = async (base: string, source: 'project' | 'template'): Promise<void> => {
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (options.recursive) await walk(join(dir, entry.name), relPath);
          continue;
        }
        if (!filter(relPath)) continue;
        if (source === 'template' && seen.has(relPath)) continue;
        seen.set(relPath, { relPath, path: join(dir, entry.name), source });
      }
    };
    await walk(join(base, relativeDir), '');
  };

  await scan(paths.dir, 'project');
  await scan(templateRoot(), 'template');
  return [...seen.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
}
