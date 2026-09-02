import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OsirisPaths } from '@osiris/dot-osiris';
import type { ProviderConfig } from '@osiris/protocol';
import { loadCrewConfig } from './crew-config.js';
import { loadAgentRegistry } from './registry.js';
import { Crew } from './crew.js';
import { resolveProvider, type VsCodeLmBridge } from './providers.js';
import { buildToolbox, type BacklogBridge, type MemoryBridge } from './tools.js';

export interface LoadCrewOptions {
  paths: OsirisPaths;
  /** Workspace root (sandbox for `read_file`, source of README context). */
  root: string;
  memory?: MemoryBridge;
  backlog?: BacklogBridge;
  vscodeLm?: VsCodeLmBridge;
  env?: NodeJS.ProcessEnv;
  /** Provider used when a spec names `vscode-lm` outside the editor. */
  headlessFallback?: ProviderConfig;
  /** Skip reading `<root>/README.md` into the system prompt. */
  noProjectContext?: boolean;
}

/** Assemble a ready-to-run `Crew` from a workspace's `.osiris/` folder. */
export async function loadCrew(options: LoadCrewOptions): Promise<Crew> {
  const [config, registry] = await Promise.all([
    loadCrewConfig(options.paths, options.env),
    loadAgentRegistry(options.paths),
  ]);

  let projectContext: string | undefined;
  if (!options.noProjectContext) {
    try {
      projectContext = await readFile(join(options.root, 'README.md'), 'utf8');
    } catch {
      projectContext = undefined;
    }
  }

  return new Crew({
    registry,
    config,
    projectContext,
    toolbox: buildToolbox({ root: options.root, memory: options.memory, backlog: options.backlog }),
    resolveProvider: (spec) =>
      resolveProvider(spec, {
        config,
        vscodeLm: options.vscodeLm,
        env: options.env,
        headlessFallback: options.headlessFallback,
      }),
  });
}
