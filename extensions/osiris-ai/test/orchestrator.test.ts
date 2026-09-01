import { describe, expect, it } from 'vitest';
import { AgentOrchestrator } from '../src/agent/orchestrator.js';
import { EchoProviderAdapter } from '../src/agent/providers.js';
import type { ProviderAdapter, Tool } from '../src/agent/types.js';

const clockTool: Tool = {
  name: 'clock.now',
  description: 'Return a fixed timestamp.',
  inputSchema: { type: 'object' },
  invoke: async () => '2026-09-01T00:00:00Z',
};

describe('AgentOrchestrator with the echo provider', () => {
  it('streams text and stops when no tool is requested', async () => {
    const orchestrator = new AgentOrchestrator(new EchoProviderAdapter());
    const tokens: string[] = [];
    const result = await orchestrator.run({
      prompt: 'hello there',
      events: { onText: (t) => tokens.push(t) },
    });
    expect(result.finishReason).toBe('stop');
    expect(result.iterations).toBe(1);
    expect(tokens.join('')).toContain('hello there');
  });

  it('runs a requested tool then continues to completion', async () => {
    const orchestrator = new AgentOrchestrator(new EchoProviderAdapter());
    orchestrator.setTools([clockTool]);
    const calls: string[] = [];
    const result = await orchestrator.run({
      prompt: 'please use tool clock.now: {}',
      events: { onToolResult: (c) => calls.push(c.name) },
    });
    expect(calls).toEqual(['clock.now']);
    expect(result.finishReason).toBe('stop');
    expect(result.messages.some((m) => m.role === 'tool' && m.content.includes('2026'))).toBe(true);
  });

  it('reports an error result when a tool throws', async () => {
    const orchestrator = new AgentOrchestrator(new EchoProviderAdapter());
    orchestrator.setTools([
      {
        name: 'boom',
        description: 'x',
        inputSchema: {},
        invoke: async () => {
          throw new Error('kaboom');
        },
      },
    ]);
    const seen: boolean[] = [];
    await orchestrator.run({
      prompt: 'use tool boom: {}',
      events: { onToolResult: (_c, _r, isError) => seen.push(isError) },
    });
    expect(seen).toEqual([true]);
  });

  it('stops at maxIterations for a provider that always calls a tool', async () => {
    const loopingProvider: ProviderAdapter = {
      id: 'looping',
      async *generate() {
        yield { type: 'tool-call', call: { id: 'c', name: 'noop', input: {} } };
        yield { type: 'done', finishReason: 'tool-calls' };
      },
    };
    const orchestrator = new AgentOrchestrator(loopingProvider);
    orchestrator.setTools([
      { name: 'noop', description: '', inputSchema: {}, invoke: async () => 'ok' },
    ]);
    const result = await orchestrator.run({ prompt: 'go', maxIterations: 3 });
    expect(result.finishReason).toBe('max-iterations');
    expect(result.iterations).toBe(3);
  });

  it('aborts when the signal is already aborted', async () => {
    const orchestrator = new AgentOrchestrator(new EchoProviderAdapter());
    const result = await orchestrator.run({ prompt: 'hi', signal: AbortSignal.abort() });
    expect(result.finishReason).toBe('aborted');
  });

  it('surfaces provider errors', async () => {
    const failing: ProviderAdapter = {
      id: 'failing',
      // eslint-disable-next-line require-yield
      async *generate() {
        throw new Error('network down');
      },
    };
    const result = await new AgentOrchestrator(failing).run({ prompt: 'hi' });
    expect(result.finishReason).toBe('error');
    expect(result.error).toBe('network down');
  });
});

describe('EchoProviderAdapter', () => {
  it('does not re-request a tool immediately after a tool result', async () => {
    const provider = new EchoProviderAdapter();
    const events = [];
    for await (const e of provider.generate({
      messages: [
        { role: 'user', content: 'use tool x: {}' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'x', input: {} }] },
        { role: 'tool', toolCallId: 'c', content: 'result' },
      ],
      tools: [{ name: 'x', description: '', inputSchema: {} }],
    })) {
      events.push(e);
    }
    expect(events.some((e) => e.type === 'tool-call')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });
});
