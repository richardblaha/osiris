import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OsirisPaths } from '@richardblaha/dot-osiris';
import type { ProviderConfig } from '@richardblaha/protocol';
import type { Tool } from '@richardblaha/agent-core';
import { createLogger } from '@richardblaha/shared-core';
import {
  McpPool,
  loadMcpConfig,
  mcpToolNamesFor,
  mcpToolsForCrew,
  type McpServerSpec,
} from '@richardblaha/mcp';
import { loadCrewConfig } from './crew-config.js';
import { loadAgentRegistry, type AgentRegistry } from './registry.js';
import { Crew } from './crew.js';
import { resolveProvider, type VsCodeLmBridge } from './providers.js';
import { buildToolbox, type BacklogBridge, type MemoryBridge } from './tools.js';

const log = createLogger('crew:assemble');

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
  /** Extra tools to merge into the toolbox (e.g. from `mcpToolsForCrew(pool)`). */
  extraTools?: Tool[];
  /** Expand agent `tools:` selectors like `mcp` / `mcp:<server>` (see `@richardblaha/mcp`). */
  expandToolNames?: (agentTools: string[]) => string[];
}

function anyAgentWantsMcp(registry: AgentRegistry): boolean {
  return registry
    .list()
    .some((a) => a.tools.some((t) => t === 'mcp' || t === 'mcp:*' || t.startsWith('mcp:')));
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

  const toolbox = buildToolbox({
    root: options.root,
    memory: options.memory,
    backlog: options.backlog,
  });
  for (const tool of options.extraTools ?? []) toolbox.set(tool.name, tool);

  return new Crew({
    registry,
    config,
    projectContext,
    toolbox,
    expandToolNames: options.expandToolNames,
    resolveProvider: (spec) =>
      resolveProvider(spec, {
        config,
        vscodeLm: options.vscodeLm,
        env: options.env,
        headlessFallback: options.headlessFallback,
      }),
  });
}

export interface CrewSessionOptions extends LoadCrewOptions {
  /**
   * Start MCP servers from `.osiris/mcp.json` and expose their tools to agents
   * that opt in with an `mcp` / `mcp:<server>` selector. `true` forces it even
   * when no agent asks; the default only starts the pool when one does.
   */
  mcp?: boolean;
  /** Override the discovered MCP servers (tests). */
  mcpSpecs?: McpServerSpec[];
  /** Inject an already-started pool (tests / a shared pool); `close()` won't touch it. */
  mcpPool?: McpPool;
}

export interface CrewSession {
  crew: Crew;
  /** MCP servers started for this session (0 when none). */
  mcpServers: number;
  close(): Promise<void>;
}

/**
 * Like {@link loadCrew} but also wires MCP: discovers servers from
 * `.osiris/mcp.json`, starts them (when wanted), and returns a `close()` that
 * shuts them down.
 */
export async function loadCrewSession(options: CrewSessionOptions): Promise<CrewSession> {
  const registry = await loadAgentRegistry(options.paths);
  const wantMcp = options.mcp === true || anyAgentWantsMcp(registry);

  if (!wantMcp && !options.mcpPool) {
    return { crew: await loadCrew(options), mcpServers: 0, close: async () => {} };
  }

  const injected = Boolean(options.mcpPool);
  let pool = options.mcpPool;
  if (!pool) {
    const specs = options.mcpSpecs ?? (await loadMcpConfig(options.paths, { env: options.env }));
    pool = await McpPool.start(specs.filter((s) => s.enabled));
  }
  log.info('MCP: %d server(s) connected', pool.size);

  const crew = await loadCrew({
    ...options,
    extraTools: [...(options.extraTools ?? []), ...mcpToolsForCrew(pool)],
    expandToolNames: (names) => [...names, ...mcpToolNamesFor(names, pool!)],
  });

  return { crew, mcpServers: pool.size, close: injected ? async () => {} : () => pool!.close() };
}
