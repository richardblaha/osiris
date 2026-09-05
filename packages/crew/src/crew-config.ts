import { createLogger } from '@richardblaha/shared-core';
import { type OsirisPaths, resolveOsirisFile } from '@richardblaha/dot-osiris';
import { CrewConfig } from '@richardblaha/protocol';

const log = createLogger('crew:config');

/** Expand `${VAR}` / `${VAR:-default}` against `env`. */
export function expandEnv(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_m, name: string, fallback = '') =>
    env[name] && env[name] !== '' ? (env[name] as string) : fallback,
  );
}

/**
 * Load `.osiris/crew.json` (project copy, else the bundled template), expanding
 * `${ENV}` references and applying schema defaults.
 */
export async function loadCrewConfig(
  paths: OsirisPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CrewConfig> {
  const resolved = await resolveOsirisFile(paths, 'crew.json');
  if (!resolved) {
    log.warn('no crew.json found — using built-in defaults with lead "architect"');
    return CrewConfig.parse({ lead: 'architect' });
  }
  const json = JSON.parse(expandEnv(resolved.content, env)) as unknown;
  return CrewConfig.parse(json);
}
