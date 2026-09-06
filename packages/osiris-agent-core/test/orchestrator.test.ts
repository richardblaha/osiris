import { describe, expect, it } from 'vitest';
import { AgentOrchestrator } from '../src/orchestrator.js';
import { EchoProviderAdapter } from '../src/providers/echo.js';
import type { Tool } from '../src/types.js';

describe('AgentOrchestrator with the echo provider', () => {
  it('returns assembled text and stops', async () => {
    const agent = new AgentOrchestrator(new EchoProviderAdapter());
    const result = await agent.run({ prompt: 'hello there' });
    expect(result.finishReason).toBe('stop');
    expect(result.text).toContain('hello there');
    expect(result.messages.at(-1)?.role).toBe('assistant');
  });

  it('runs a tool the provider requests and feeds the result back', async () => {
    let received: unknown;
    const tool: Tool = {
      name: 'reverse',
      description: 'reverse a string',
      inputSchema: { type: 'object', properties: { s: { type: 'string' } } },
      invoke: async (input) => {
        received = input;
        const { s } = (input ?? {}) as { s?: string };
        return [...(s ?? '')].reverse().join('');
      },
    };
    const agent = new AgentOrchestrator(new EchoProviderAdapter());
    agent.setTools([tool]);

    const result = await agent.run({ prompt: 'use tool reverse: {"s":"abc"}' });

    expect(received).toEqual({ s: 'abc' });
    expect(result.messages.some((m) => m.role === 'tool' && m.content === 'cba')).toBe(true);
  });

  it('stops at maxIterations', async () => {
    const loopingProvider = {
      id: 'looping',
      async *generate() {
        yield { type: 'tool-call' as const, call: { id: '1', name: 'noop', input: {} } };
        yield { type: 'done' as const, finishReason: 'tool-calls' as const };
      },
    };
    const agent = new AgentOrchestrator(loopingProvider);
    agent.setTools([{ name: 'noop', description: '', inputSchema: {}, invoke: async () => 'ok' }]);
    const result = await agent.run({ prompt: 'go', maxIterations: 3 });
    expect(result.finishReason).toBe('max-iterations');
    expect(result.iterations).toBe(3);
  });
});
