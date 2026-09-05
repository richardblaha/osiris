import { describe, expect, it } from 'vitest';
import { AgentOrchestrator, EchoProviderAdapter } from '@richardblaha/agent-core';
import { McpClient, flattenMcpResult } from '../src/client.js';
import { McpPool } from '../src/pool.js';
import { parseMcpConfig } from '../src/config.js';
import { mcpToolNamesFor, mcpToolsForCrew } from '../src/crew-tools.js';
import { FakeMcpTransport, type FakeMcpTool } from '../src/testing.js';

const echoTool: FakeMcpTool = {
  name: 'echo',
  description: 'echo the message',
  handler: (args) => ({ text: `echo: ${(args as { message?: string }).message ?? ''}` }),
};
const failTool: FakeMcpTool = {
  name: 'boom',
  handler: () => ({ text: 'kaboom', isError: true }),
};

describe('McpClient', () => {
  it('initializes, lists and calls tools', async () => {
    const client = new McpClient('fs', new FakeMcpTransport([echoTool]));
    await client.initialize();
    expect((await client.listTools()).map((t) => t.name)).toEqual(['echo']);
    const result = await client.callTool('echo', { message: 'hi' });
    expect(flattenMcpResult(result)).toBe('echo: hi');
  });

  it('surfaces a JSON-RPC error as McpError', async () => {
    const client = new McpClient('fs', new FakeMcpTransport([echoTool]));
    await client.initialize();
    await expect(client.callTool('missing', {})).rejects.toThrow(/no such tool/);
  });
});

describe('McpPool', () => {
  it('namespaces tools by server and routes calls', async () => {
    const specs = [
      { id: 'alpha', transport: 'stdio' as const, command: 'x', enabled: true },
      { id: 'beta', transport: 'stdio' as const, command: 'y', enabled: true },
      { id: 'off', transport: 'stdio' as const, command: 'z', enabled: false },
    ];
    const pool = await McpPool.start(
      specs,
      (spec) => new FakeMcpTransport(spec.id === 'alpha' ? [echoTool, failTool] : [echoTool]),
    );
    expect(pool.size).toBe(2);
    expect(
      pool
        .tools()
        .map((t) => t.qualifiedName)
        .sort(),
    ).toEqual(['alpha__boom', 'alpha__echo', 'beta__echo']);
    expect(flattenMcpResult(await pool.call('beta__echo', { message: 'yo' }))).toBe('echo: yo');
    await pool.close();
  });

  it('skips a server that fails to start instead of throwing', async () => {
    const pool = await McpPool.start(
      [
        { id: 'good', transport: 'stdio' as const, command: 'x', enabled: true },
        { id: 'bad', transport: 'stdio' as const, command: 'x', enabled: true },
      ],
      (spec) => {
        if (spec.id === 'bad') throw new Error('cannot spawn');
        return new FakeMcpTransport([echoTool]);
      },
    );
    expect(pool.size).toBe(1);
  });
});

describe('crew integration', () => {
  it('mcpToolNamesFor resolves mcp / mcp:<server> selectors', async () => {
    const pool = await McpPool.start(
      [
        { id: 'alpha', transport: 'stdio' as const, command: 'x', enabled: true },
        { id: 'beta', transport: 'stdio' as const, command: 'y', enabled: true },
      ],
      () => new FakeMcpTransport([echoTool]),
    );
    expect(mcpToolNamesFor(['read_file', 'mcp'], pool).sort()).toEqual([
      'alpha__echo',
      'beta__echo',
    ]);
    expect(mcpToolNamesFor(['mcp:beta'], pool)).toEqual(['beta__echo']);
    await pool.close();
  });

  it('an agent loop can call an MCP tool via mcpToolsForCrew', async () => {
    const pool = await McpPool.start(
      [{ id: 'alpha', transport: 'stdio' as const, command: 'x', enabled: true }],
      () => new FakeMcpTransport([echoTool]),
    );
    const tools = mcpToolsForCrew(pool);
    const agent = new AgentOrchestrator(new EchoProviderAdapter());
    agent.setTools(tools);
    const result = await agent.run({
      prompt: 'use tool alpha__echo: {"message":"from the crew"}',
    });
    expect(result.messages.find((m) => m.role === 'tool')?.content).toBe('echo: from the crew');
    await pool.close();
  });
});

describe('parseMcpConfig', () => {
  it('reads both `servers` and `mcpServers`, expands ${workspaceFolder} and ${env}', () => {
    const raw = JSON.stringify({
      servers: {
        fs: { transport: 'stdio', command: 'npx', args: ['-y', 'server', '${workspaceFolder}'] },
      },
      mcpServers: { api: { url: 'https://x/${env:MCP_PATH}' } },
    });
    const specs = parseMcpConfig(raw, { workspaceFolder: '/work/proj', env: { MCP_PATH: 'mcp' } });
    expect(specs.find((s) => s.id === 'fs')?.args).toEqual(['-y', 'server', '/work/proj']);
    const api = specs.find((s) => s.id === 'api');
    expect(api?.transport).toBe('http');
    expect(api?.url).toBe('https://x/mcp');
  });

  it('is empty and quiet for missing or invalid JSON', () => {
    expect(parseMcpConfig(undefined)).toEqual([]);
    expect(parseMcpConfig('{ not json')).toEqual([]);
  });
});
