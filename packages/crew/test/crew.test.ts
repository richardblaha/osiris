import { describe, expect, it } from 'vitest';
import { EchoProviderAdapter } from '@osiris/agent-core';
import { CrewConfig, type AgentDefinition } from '@osiris/protocol';
import { Crew } from '../src/crew.js';
import { AgentRegistry } from '../src/registry.js';
import { memorySearchTool, type MemoryBridge } from '../src/tools.js';

const agent = (over: Partial<AgentDefinition>): AgentDefinition => ({
  name: 'x',
  role: 'r',
  specialization: '',
  tools: [],
  delegateTo: [],
  instructions: 'i',
  ...over,
});

const memory: MemoryBridge = {
  async search() {
    return [
      {
        document: 'orphan branch keeps main clean',
        source: 'm.md',
        headingPath: 'Git',
        score: 0.9,
      },
    ];
  },
};

function crewWith(agents: AgentDefinition[], over: Partial<CrewConfig> = {}): Crew {
  const config = CrewConfig.parse({
    lead: 'architect',
    defaultModel: 'echo/echo',
    providers: { echo: { kind: 'echo' } },
    ...over,
  });
  return new Crew({
    registry: new AgentRegistry(agents),
    config,
    toolbox: new Map([['memory_search', memorySearchTool(memory)]]),
    resolveProvider: () => new EchoProviderAdapter(),
  });
}

describe('Crew.run', () => {
  it('runs a solo lead with no delegation', async () => {
    const crew = crewWith([agent({ name: 'architect', tools: ['memory_search'] })]);
    const result = await crew.run('summarise the repo');
    expect(result.finishReason).toBe('stop');
    expect(result.delegations).toEqual([]);
    expect(result.blackboard.some((e) => e.agent === 'architect' && e.kind === 'result')).toBe(
      true,
    );
  });

  it('delegates from the lead to a specialist and folds the result back', async () => {
    const events: string[] = [];
    const crew = crewWith([
      agent({ name: 'architect', delegateTo: ['implementer'] }),
      agent({ name: 'implementer', tools: ['memory_search'] }),
    ]);
    const result = await crew.run(
      'use tool delegate: {"agent":"implementer","brief":"build the parser"}',
      {
        onEvent: (e) => events.push(e.type),
      },
    );

    expect(result.delegations).toHaveLength(1);
    expect(result.delegations[0]).toMatchObject({ from: 'architect', to: 'implementer', depth: 1 });
    expect(events).toContain('delegate');
    expect(events.filter((t) => t === 'agent.start')).toHaveLength(2);
    expect(result.blackboard.some((e) => e.agent === 'implementer')).toBe(true);
  });

  it('refuses an out-of-policy delegation target without hanging', async () => {
    const crew = crewWith([
      agent({ name: 'architect', delegateTo: ['implementer'] }),
      agent({ name: 'implementer' }),
      agent({ name: 'reviewer' }),
    ]);
    const result = await crew.run('use tool delegate: {"agent":"reviewer","brief":"x"}');
    expect(result.delegations).toHaveLength(0);
    expect(result.finishReason).toBe('stop'); // the tool returned an error string; the run still completes
  });

  it('enforces max delegation depth', async () => {
    const crew = crewWith(
      [
        agent({ name: 'architect', delegateTo: ['implementer'] }),
        agent({ name: 'implementer', delegateTo: ['architect'] }),
      ],
      { coordinator: { maxDepth: 1, maxIterationsPerAgent: 6, maxDelegationsPerRun: 10 } },
    );
    const result = await crew.run(
      'use tool delegate: {"agent":"implementer","brief":"use tool delegate: {\\"agent\\":\\"architect\\",\\"brief\\":\\"loop\\"}"}',
    );
    // architect(0) → implementer(1) is allowed; implementer has no delegate tool at depth 1.
    expect(result.delegations).toHaveLength(1);
    expect(result.delegations[0]!.to).toBe('implementer');
  });

  it('reports an error for an unknown lead', async () => {
    const crew = crewWith([agent({ name: 'architect' })], { lead: 'nobody' });
    const result = await crew.run('hi');
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('nobody');
  });
});
