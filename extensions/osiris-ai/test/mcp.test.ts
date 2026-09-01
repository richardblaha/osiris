import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import type { McpServerConfig } from '@osiris/shared-core';
import { McpStdioClient } from '../src/mcp/client.js';
import { McpRegistry } from '../src/mcp/registry.js';

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

describe('McpStdioClient', () => {
  const clients: McpStdioClient[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.stop()));
  });

  it('initializes and lists tools from the mock server', async () => {
    const client = new McpStdioClient(config());
    clients.push(client);
    await client.start();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ serverId: 'mock', name: 'echo' });
  });

  it('calls a tool and returns its text content', async () => {
    const client = new McpStdioClient(config());
    clients.push(client);
    await client.start();
    const result = await client.callTool('echo', { text: 'ping' });
    expect(result.content[0]).toEqual({ type: 'text', text: 'echo: ping' });
  });

  it('rejects with McpError for an unknown tool', async () => {
    const client = new McpStdioClient(config());
    clients.push(client);
    await client.start();
    await expect(client.callTool('nope', {})).rejects.toThrow(/Unknown tool/);
  });

  it('times out when the command never responds', async () => {
    const client = new McpStdioClient(
      config({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: 300,
      }),
    );
    clients.push(client);
    await expect(client.start()).rejects.toThrow(/timed out/);
  });
});

describe('McpRegistry', () => {
  it('namespaces tools and exposes them to the orchestrator', async () => {
    const registry = new McpRegistry();
    await registry.load([config()]);
    try {
      const tools = registry.asTools();
      expect(tools.map((t) => t.name)).toEqual(['mock.echo']);
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
