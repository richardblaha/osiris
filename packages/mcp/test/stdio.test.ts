import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@richardblaha/shared-core';
import { McpClient } from '../src/client.js';
import { McpRegistry } from '../src/registry.js';
import { StdioTransport } from '../src/transport.js';

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

describe('StdioTransport + McpClient (real child process)', () => {
  const open: McpClient[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((c) => c.close()));
  });

  it('initializes, lists and calls a tool over stdio', async () => {
    const client = new McpClient(
      'mock',
      new StdioTransport({ command: process.execPath, args: [serverPath] }),
    );
    open.push(client);
    await client.initialize();
    expect((await client.listTools()).map((t) => t.name)).toEqual(['echo']);
    const result = await client.callTool('echo', { text: 'ping' });
    expect(result.content[0]).toEqual({ type: 'text', text: 'echo: ping' });
  });

  it('rejects an unknown tool', async () => {
    const client = new McpClient(
      'mock',
      new StdioTransport({ command: process.execPath, args: [serverPath] }),
    );
    open.push(client);
    await client.initialize();
    await expect(client.callTool('nope', {})).rejects.toThrow(/Unknown tool/);
  });

  it('times out a command that never responds', async () => {
    const client = new McpClient(
      'stuck',
      new StdioTransport({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      }),
      300,
    );
    open.push(client);
    await expect(client.initialize()).rejects.toThrow(/timed out/);
  });
});

describe('McpRegistry (real stdio)', () => {
  it('namespaces tools, exposes them, and reports status', async () => {
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

  it('reload swaps the server set', async () => {
    const registry = new McpRegistry();
    await registry.load([config()]);
    expect(registry.status()).toHaveLength(1);
    await registry.load([]);
    expect(registry.asTools()).toEqual([]);
    expect(registry.status()).toEqual([]);
    await registry.disposeAll();
  });
});
