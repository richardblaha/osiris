import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ConsoleClient, type CrewEvent, type CrewRunRequest } from '@osiris/protocol';
import { buildServer } from '../src/app.js';
import type { BacklogApi, ConsoleDeps } from '../src/routes/console.js';

const TOKEN = 't';
const auth = { authorization: `Bearer ${TOKEN}` };

/** A tiny in-memory backlog standing in for the orphan-branch repo. */
function fakeBacklog(): BacklogApi {
  const tasks = [
    {
      id: 1,
      type: 'bug',
      slug: 's',
      title: 'Boom',
      state: 'todo',
      filename: '[bug]-0001-s.md',
      labels: [],
      body: '',
    },
  ];
  return {
    async board() {
      return { branch: 'osiris/backlog', states: ['todo', 'done'], tasks };
    },
    async list() {
      return tasks;
    },
    async get(id) {
      return tasks.find((t) => t.id === id);
    },
    async create(input) {
      const task = {
        id: tasks.length + 1,
        type: input.type,
        slug: 'x',
        title: input.title,
        state: input.state ?? 'todo',
        filename: `[${input.type}]-000${tasks.length + 1}-x.md`,
        labels: [],
        body: '',
      };
      tasks.push(task);
      return task;
    },
    async move(id, toState) {
      const task = tasks.find((t) => t.id === id);
      if (!task) throw new Error(`no task ${id}`);
      if (toState === 'nope') throw new Error('unknown state "nope"');
      task.state = toState;
      return task;
    },
    async history() {
      return [{ hash: 'abcdef0', date: '2026-09-02', subject: 'add: [bug]-0001' }];
    },
    async push() {
      return { ok: true, message: 'pushed' };
    },
    async pull() {
      return { ok: false, diverged: true, message: 'diverged' };
    },
  };
}

function deps(): ConsoleDeps {
  const backlog = fakeBacklog();
  return {
    getBacklog: async () => backlog,
    listAgents: async () => [
      {
        name: 'architect',
        role: 'Lead',
        specialization: '',
        tools: [],
        delegateTo: [],
        instructions: '',
      },
    ],
    searchMemory: async (req) => ({
      hits: [
        { id: 'm#0', document: `re: ${req.query}`, source: 'a.md', headingPath: 'H', score: 0.5 },
      ],
    }),
    reindexMemory: async () => ({
      filesIndexed: 1,
      filesUnchanged: 0,
      filesRemoved: 0,
      chunksUpserted: 2,
      chunksDeleted: 0,
      chunksDeduped: 0,
      embeddingCalls: 2,
    }),
    runCrew: async (req: CrewRunRequest, onEvent: (e: CrewEvent) => void) => {
      onEvent({ type: 'agent.start', agent: 'architect', depth: 0, brief: req.task });
      const result = {
        runId: 'run1',
        lead: 'architect',
        task: req.task,
        text: 'done',
        finishReason: 'stop' as const,
        delegations: [],
        blackboard: [],
      };
      onEvent({ type: 'run.finish', result });
      return result;
    },
  };
}

let app: FastifyInstance;
beforeEach(() => {
  app = buildServer({
    token: TOKEN,
    publicBaseUrl: 'http://osiris.test',
    leaseSweepMs: 0,
    console: deps(),
  });
});
afterEach(async () => {
  await app.close();
});

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: auth, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url, headers: auth });

describe('backlog routes', () => {
  it('serves the board and moves a task', async () => {
    const board = await get('/api/v1/backlog');
    expect(board.json()).toMatchObject({ branch: 'osiris/backlog', states: ['todo', 'done'] });

    const created = await post('/api/v1/backlog/tasks', { type: 'feat', title: 'New thing' });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: number }).id;

    const moved = await post(`/api/v1/backlog/tasks/${id}/move`, { toState: 'done' });
    expect(moved.statusCode).toBe(200);
    expect((moved.json() as { state: string }).state).toBe('done');
  });

  it('400s an invalid move target and a bad body', async () => {
    expect((await post('/api/v1/backlog/tasks/1/move', { toState: 'nope' })).statusCode).toBe(400);
    expect((await post('/api/v1/backlog/tasks', { title: 'no type' })).statusCode).toBe(400);
  });

  it('serves task history and backlog push/pull', async () => {
    const history = await get('/api/v1/backlog/tasks/1/history');
    expect((history.json() as { subject: string }[])[0]!.subject).toContain('[bug]-0001');

    expect(
      (await post('/api/v1/backlog/push', {}).then((r) => r.json())) as { ok: boolean },
    ).toMatchObject({
      ok: true,
      message: 'pushed',
    });
    expect(
      (await post('/api/v1/backlog/pull', {}).then((r) => r.json())) as { diverged: boolean },
    ).toMatchObject({
      ok: false,
      diverged: true,
    });
  });
});

describe('crew routes', () => {
  it('runs a crew task and exposes the result + replayed events', async () => {
    const start = await post('/api/v1/crew/runs', { task: 'summarise' });
    expect(start.statusCode).toBe(202);
    const runId = (start.json() as { runId: string }).runId;

    // The fake resolves synchronously inside start(), so the result is ready.
    const result = await get(`/api/v1/crew/runs/${runId}`);
    expect(result.statusCode).toBe(200);
    expect((result.json() as { text: string }).text).toBe('done');

    const events = await get(`/api/v1/crew/runs/${runId}/events`);
    expect(events.body.indexOf('agent.start')).toBeGreaterThanOrEqual(0);
    expect(events.body.indexOf('agent.start')).toBeLessThan(events.body.indexOf('run.finish'));
  });

  it('streams live events over SSE to a real ConsoleClient', async () => {
    // A crew whose events trickle out with awaits, so the stream is genuinely live.
    const live: ConsoleDeps = {
      ...deps(),
      runCrew: async (req, onEvent) => {
        for (const agent of ['architect', 'implementer']) {
          await new Promise((r) => setTimeout(r, 10));
          onEvent({ type: 'agent.start', agent, depth: 0, brief: req.task });
        }
        const result = {
          runId: 'r',
          lead: 'architect',
          task: req.task,
          text: 'ok',
          finishReason: 'stop' as const,
          delegations: [],
          blackboard: [],
        };
        onEvent({ type: 'run.finish', result });
        return result;
      },
    };
    const srv = buildServer({
      token: '',
      publicBaseUrl: 'http://x',
      leaseSweepMs: 0,
      console: live,
    });
    const address = await srv.listen({ port: 0, host: '127.0.0.1' });
    try {
      const client = new ConsoleClient({ baseUrl: address });
      const seen: string[] = [];
      for await (const e of client.run$({ task: 'go' })) seen.push(e.type);
      expect(seen).toEqual(['agent.start', 'agent.start', 'run.finish']);
    } finally {
      await srv.close();
    }
  });

  it('lists agents', async () => {
    const res = await get('/api/v1/crew/agents');
    expect((res.json() as { name: string }[])[0]!.name).toBe('architect');
  });
});

describe('memory routes', () => {
  it('searches and reindexes', async () => {
    const search = await post('/api/v1/memory/search', { query: 'orphan branch' });
    expect((search.json() as { hits: unknown[] }).hits).toHaveLength(1);

    const reindex = await post('/api/v1/memory/reindex', {});
    expect((reindex.json() as { chunksUpserted: number }).chunksUpserted).toBe(2);
  });
});
