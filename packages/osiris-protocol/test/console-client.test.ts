import { describe, expect, it } from 'vitest';
import { ConsoleClient, ConsoleHttpError } from '../src/console-client.js';
import type { CrewEvent } from '../src/crew.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('ConsoleClient', () => {
  it('parses typed backlog + memory responses', async () => {
    const client = new ConsoleClient({
      baseUrl: 'http://x',
      fetchImpl: async (url) => {
        if (String(url).endsWith('/backlog')) {
          return jsonResponse(200, { branch: 'osiris/backlog', states: ['todo'], tasks: [] });
        }
        return jsonResponse(200, { hits: [] });
      },
    });
    expect((await client.board()).branch).toBe('osiris/backlog');
    expect((await client.search({ query: 'x', k: 3 })).hits).toEqual([]);
  });

  it('throws ConsoleHttpError with the body on a non-2xx', async () => {
    const client = new ConsoleClient({
      fetchImpl: async () => new Response('nope', { status: 400 }),
    });
    await expect(client.board()).rejects.toBeInstanceOf(ConsoleHttpError);
  });

  it('streams and validates crew events, stopping at run.finish', async () => {
    const events: CrewEvent[] = [
      { type: 'agent.start', agent: 'architect', depth: 0, brief: 'go' },
      { type: 'delegate', from: 'architect', to: 'implementer', brief: 'do it' },
      {
        type: 'run.finish',
        result: {
          runId: 'r1',
          lead: 'architect',
          task: 'go',
          text: 'done',
          finishReason: 'stop',
          delegations: [],
          blackboard: [],
        },
      },
    ];
    const frames = [
      ': hello\n\n',
      `data: ${JSON.stringify(events[0])}\n\n`,
      `data: ${JSON.stringify(events[1])}\n\ndata: ${JSON.stringify(events[2])}\n\n`,
      `data: ${JSON.stringify({ type: 'agent.text', agent: 'x', text: 'ignored after finish' })}\n\n`,
    ];
    const client = new ConsoleClient({ fetchImpl: async () => sseResponse(frames) });

    const seen: string[] = [];
    for await (const e of client.streamRun('r1')) seen.push(e.type);
    expect(seen).toEqual(['agent.start', 'delegate', 'run.finish']);
  });
});
