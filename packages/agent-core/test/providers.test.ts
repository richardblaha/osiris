import { describe, expect, it } from 'vitest';
import { OllamaAdapter } from '../src/providers/ollama.js';
import {
  mapStopReason,
  splitSystem,
  toAnthropicMessages,
  toAnthropicTools,
} from '../src/providers/mapping.js';
import type { ChatMessage, ProviderEvent } from '../src/types.js';

async function collect(iter: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

function ndjsonResponse(lines: string[]): Response {
  return new Response(lines.map((l) => `${l}\n`).join(''), { status: 200 });
}

describe('Anthropic message mapping', () => {
  it('extracts system messages and keeps order', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ];
    const { system, rest } = splitSystem(messages);
    expect(system).toBe('be terse');
    expect(rest).toHaveLength(1);
  });

  it('turns tool calls and results into Anthropic blocks', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'ls', input: { path: '.' } }] },
      { role: 'tool', toolCallId: 'c1', content: 'a.ts\nb.ts' },
    ];
    const mapped = toAnthropicMessages(messages);
    expect(mapped[0]).toMatchObject({ role: 'assistant', content: [{ type: 'tool_use', id: 'c1' }] });
    expect(mapped[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1' }],
    });
  });

  it('maps tool specs and stop reasons', () => {
    expect(toAnthropicTools([{ name: 'x', description: 'd', inputSchema: undefined }])[0]).toEqual({
      name: 'x',
      description: 'd',
      input_schema: { type: 'object' },
    });
    expect(mapStopReason('tool_use').finishReason).toBe('tool-calls');
    expect(mapStopReason('max_tokens').finishReason).toBe('length');
    expect(mapStopReason('refusal').finishReason).toBe('error');
    expect(mapStopReason('end_turn').finishReason).toBe('stop');
  });
});

describe('OllamaAdapter', () => {
  it('streams text then reports a plain stop', async () => {
    const fetchImpl = (async () =>
      ndjsonResponse([
        JSON.stringify({ message: { content: 'hel' } }),
        JSON.stringify({ message: { content: 'lo' } }),
        JSON.stringify({ done: true }),
      ])) as unknown as typeof fetch;

    const events = await collect(
      new OllamaAdapter({ model: 'llama3', fetchImpl }).generate({ messages: [], tools: [] }),
    );
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe(
      'hello',
    );
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('emits a tool call and reports tool-calls', async () => {
    const fetchImpl = (async () =>
      ndjsonResponse([
        JSON.stringify({
          message: { tool_calls: [{ function: { name: 'search', arguments: { q: 'x' } } }] },
        }),
        JSON.stringify({ done: true }),
      ])) as unknown as typeof fetch;

    const events = await collect(
      new OllamaAdapter({ model: 'llama3', fetchImpl }).generate({
        messages: [],
        tools: [{ name: 'search', description: '', inputSchema: {} }],
      }),
    );
    expect(events.some((e) => e.type === 'tool-call')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool-calls' });
  });
});
