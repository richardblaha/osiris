import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@richardblaha/shared-core';
import { McpRegistry } from '@richardblaha/mcp';

// Low-level MCP client/transport behaviour is covered in @richardblaha/mcp; this just
// confirms osiris-ai's wiring onto the shared McpRegistry.
const serverPath = fileURLToPath(new URL('./fixtures/mock-mcp-server.mjs', import.meta.url));

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'mock',
    transport: 'stdio',
    command: process.execPath,
    args: [serverPath],
    timeoutMs: 5000,
    ...overrides,
  };
}

describe('McpRegistry (via @richardblaha/mcp)', () => {
  it('namespaces tools and exposes them to the orchestrator', async () => {
    const registry = new McpRegistry();
    await registry.load([config()]);
    try {
      const tools = registry.asTools();
      expect(tools.map((t) => t.name)).toEqual(['mock__echo']);
      await expect(tools[0]!.invoke({ text: 'hi' })).resolves.toBe('echo: hi');
      expect(registry.status()).toEqual([
        { id: 'mock', running: true, toolCount: 1, error: undefined },
      ]);
    } finally {
      await registry.disposeAll();
    }
  });

  it('records an error for a server that fails to start', async () => {
    const registry = new McpRegistry();
    await registry.load([config({ id: 'bad', command: '/definitely/not/a/real/binary' })]);
    const status = registry.status();
    expect(status[0]?.id).toBe('bad');
    expect(status[0]?.error).toBeTruthy();
    expect(status[0]?.running).toBe(false);
    await registry.disposeAll();
  });
});
