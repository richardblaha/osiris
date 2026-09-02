import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace, osirisPaths } from '@osiris/dot-osiris';
import { FakeMcpTransport, McpPool } from '@osiris/mcp';
import { loadCrewSession } from '../src/assemble.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crew-mcp-'));
  await initWorkspace(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadCrewSession + MCP', () => {
  it('exposes MCP tools to an agent that opts in with an `mcp` selector', async () => {
    const paths = osirisPaths(dir);
    // An agent that wants MCP and is told (via echo) to call the tool.
    await writeFile(
      paths.resolve('agents/architect.md'),
      [
        '---',
        'name: architect',
        'role: Lead',
        'model: echo/echo',
        'tools: [mcp]',
        '---',
        'Use MCP tools.',
      ].join('\n'),
      'utf8',
    );

    const pool = await McpPool.start(
      [{ id: 'weather', transport: 'stdio' as const, command: 'x', enabled: true }],
      () => new FakeMcpTransport([{ name: 'today', handler: () => ({ text: 'sunny, 24°C' }) }]),
    );

    const session = await loadCrewSession({
      paths,
      root: dir,
      env: { OSIRIS_CREW_PROVIDER: 'echo' },
      noProjectContext: true,
      mcpPool: pool,
    });
    expect(session.mcpServers).toBe(1);

    const toolsUsed: string[] = [];
    await session.crew.run('use tool weather__today: {}', {
      onEvent: (e) => e.type === 'agent.tool' && toolsUsed.push(e.tool),
    });
    expect(toolsUsed).toContain('weather__today');

    await session.close();
    await pool.close();
  });

  it('does not start a pool when no agent wants MCP and mcp is not forced', async () => {
    const paths = osirisPaths(dir);
    // Strip the `mcp` selector the bundled researcher ships with.
    await writeFile(
      paths.resolve('agents/researcher.md'),
      '---\nname: researcher\nrole: R\nmodel: echo/echo\ntools: [read_file]\n---\nresearch',
      'utf8',
    );
    const session = await loadCrewSession({
      paths,
      root: dir,
      noProjectContext: true,
      env: { OSIRIS_CREW_PROVIDER: 'echo' },
    });
    expect(session.mcpServers).toBe(0);
    await session.close();
  });
});
