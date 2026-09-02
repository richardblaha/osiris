import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentOrchestrator, OpenAiCompatibleAdapter, type Tool } from '@osiris/agent-core';
import {
  startLmProxy,
  type LmChatRequest,
  type LmChunk,
  type LmModelBridge,
} from '../src/index.js';

/** A scripted bridge: echoes the last user message, and calls `ping` once if asked. */
function fakeBridge(): LmModelBridge {
  return {
    async listModels() {
      return [{ id: 'copilot/gpt-x', vendor: 'copilot', family: 'gpt-x' }];
    },
    async *chat(request: LmChatRequest): AsyncGenerator<LmChunk> {
      const lastUser =
        [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const justRanTool = request.messages.at(-1)?.role === 'tool';
      if (
        /call ping/i.test(lastUser) &&
        !justRanTool &&
        request.tools?.some((t) => t.name === 'ping')
      ) {
        yield { type: 'tool-call', id: 'c1', name: 'ping', input: { n: 1 } };
        yield { type: 'done', reason: 'tool_calls' };
        return;
      }
      for (const word of `reply: ${lastUser}`.split(/(\s+)/)) yield { type: 'text', text: word };
      yield { type: 'done', reason: 'stop' };
    },
  };
}

let proxy: Awaited<ReturnType<typeof startLmProxy>>;
beforeEach(async () => {
  proxy = await startLmProxy(fakeBridge(), 0);
});
afterEach(async () => {
  await proxy.close();
});

describe('LM proxy ⇄ OpenAiCompatibleAdapter', () => {
  it('serves GET /v1/models', async () => {
    const res = await fetch(`${proxy.origin}/v1/models`);
    const json = (await res.json()) as { data: { id: string }[] };
    expect(json.data[0]!.id).toBe('copilot/gpt-x');
  });

  it('streams a plain completion the agent loop consumes', async () => {
    const agent = new AgentOrchestrator(
      new OpenAiCompatibleAdapter({ endpoint: `${proxy.origin}/v1`, model: 'copilot/gpt-x' }),
    );
    const result = await agent.run({ prompt: 'hello world' });
    expect(result.finishReason).toBe('stop');
    expect(result.text).toContain('reply: hello world');
  });

  it('round-trips a tool call through the proxy', async () => {
    const ping: Tool = {
      name: 'ping',
      description: 'ping',
      inputSchema: { type: 'object' },
      invoke: async () => 'pong',
    };
    const agent = new AgentOrchestrator(
      new OpenAiCompatibleAdapter({ endpoint: `${proxy.origin}/v1`, model: 'x' }),
      new Map([['ping', ping]]),
    );
    const result = await agent.run({ prompt: 'please call ping now' });
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('pong');
    expect(result.finishReason).toBe('stop');
  });
});
