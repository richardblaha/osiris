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

function crewWith(
  agents: AgentDefinition[],
  over: Partial<CrewConfig> = {},
  onResolve?: (spec: string) => void,
): Crew {
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
    resolveProvider: (spec) => {
      onResolve?.(spec);
      return new EchoProviderAdapter();
    },
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

  it('resolves an agent model: explicit model > taskModels[taskClass] > defaultModel', async () => {
    const specs: string[] = [];
    const crew = crewWith(
      [
        agent({ name: 'architect', delegateTo: ['implementer', 'reviewer'] }),
        agent({ name: 'implementer', taskClass: 'codegen' }),
        agent({ name: 'reviewer', model: 'echo/pinned' }),
      ],
      {
        taskModels: { planning: 'echo/plan', codegen: 'echo/code' },
      },
      (spec) => specs.push(spec),
    );
    // architect has no model + no taskClass → defaultModel
    // (delegation briefs are ignored by the echo provider; we only assert lead resolution here)
    await crew.run('hello');
    expect(specs).toContain('echo/echo');

    const solo: string[] = [];
    await crewWith([agent({ name: 'architect', taskClass: 'planning' })], {
      taskModels: { planning: 'echo/plan' },
    }, (s) => solo.push(s)).run('hi');
    expect(solo).toEqual(['echo/plan']);

    const pinned: string[] = [];
    await crewWith([agent({ name: 'architect', model: 'echo/pinned', taskClass: 'planning' })], {
      taskModels: { planning: 'echo/plan' },
    }, (s) => pinned.push(s)).run('hi');
    expect(pinned).toEqual(['echo/pinned']);
  });

  it('reports an error for an unknown lead', async () => {
    const crew = crewWith([agent({ name: 'architect' })], { lead: 'nobody' });
    const result = await crew.run('hi');
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('nobody');
  });
});
