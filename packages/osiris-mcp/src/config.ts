import { createLogger } from '@richardblaha/osiris-core';
import { type OsirisPaths, resolveOsirisFile } from '@richardblaha/osiris-config';

const log = createLogger('mcp:config');

export interface McpServerSpec {
  id: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  enabled: boolean;
}

export interface McpDiscoveryContext {
  /** Absolute path substituted for `${workspaceFolder}`. */
  workspaceFolder?: string;
  env?: NodeJS.ProcessEnv;
}

function expand(value: string, ctx: McpDiscoveryContext): string {
  return value
    .replace(/\$\{workspaceFolder\}/g, ctx.workspaceFolder ?? '.')
    .replace(
      /\$\{env:([A-Z0-9_]+)\}|\$\{([A-Z0-9_]+)\}/gi,
      (_m, a, b) => (ctx.env ?? process.env)[a ?? b] ?? '',
    );
}

function expandDeep<T>(value: T, ctx: McpDiscoveryContext): T {
  if (typeof value === 'string') return expand(value, ctx) as T;
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, ctx)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandDeep(v, ctx)])) as T;
  }
  return value;
}

interface McpJsonFile {
  servers?: Record<string, Omit<McpServerSpec, 'id' | 'enabled'> & { enabled?: boolean }>;
  mcpServers?: Record<string, Omit<McpServerSpec, 'id' | 'enabled'> & { enabled?: boolean }>;
}

/**
 * Parse `.osiris/mcp.json` (accepts both `servers` and the VS Code `mcpServers`
 * key), expanding `${workspaceFolder}` and `${env:VAR}` / `${VAR}`.
 */
export function parseMcpConfig(
  raw: string | undefined,
  ctx: McpDiscoveryContext = {},
): McpServerSpec[] {
  if (!raw) return [];
  let file: McpJsonFile;
  try {
    file = JSON.parse(raw) as McpJsonFile;
  } catch (cause) {
    log.warn('mcp.json is not valid JSON: %s', (cause as Error).message);
    return [];
  }
  const entries = { ...file.mcpServers, ...file.servers };
  return Object.entries(entries).map(([id, spec]) => {
    const expanded = expandDeep(spec, ctx);
    return {
      id,
      transport: expanded.transport ?? (expanded.url ? 'http' : 'stdio'),
      command: expanded.command,
      args: expanded.args,
      env: expanded.env,
      url: expanded.url,
      headers: expanded.headers,
      timeoutMs: expanded.timeoutMs,
      enabled: expanded.enabled ?? true,
    };
  });
}

/** Load `.osiris/mcp.json` (project copy, else bundled template). */
export async function loadMcpConfig(
  paths: OsirisPaths,
  ctx: McpDiscoveryContext = {},
): Promise<McpServerSpec[]> {
  const resolved = await resolveOsirisFile(paths, 'mcp.json');
  return parseMcpConfig(resolved?.content, { workspaceFolder: paths.root, ...ctx });
}
