import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  API_BASE,
  CreateTaskRequest,
  CrewRunRequest,
  MemorySearchRequest,
  MoveTaskRequest,
  type AgentDefinition,
  type CrewEvent,
  type CrewRunResult,
  type MemoryReindexResult,
  type MemorySearchResult,
} from '@osiris/protocol';
import { createLogger } from '@osiris/shared-core';
import { formatSseEvent } from '../sse.js';

const log = createLogger('server:console');

export interface BacklogApi {
  board(): Promise<unknown>;
  list(): Promise<unknown[]>;
  get(id: number): Promise<unknown>;
  create(input: CreateTaskRequest): Promise<unknown>;
  move(id: number, toState: string): Promise<unknown>;
  history(id: number): Promise<unknown[]>;
}

export interface ConsoleDeps {
  /** Backlog repo bound to the workspace (lazily opened). */
  getBacklog(): Promise<BacklogApi>;
  listAgents(): Promise<AgentDefinition[]>;
  searchMemory(req: MemorySearchRequest): Promise<MemorySearchResult>;
  reindexMemory(): Promise<MemoryReindexResult>;
  runCrew(req: CrewRunRequest, onEvent: (e: CrewEvent) => void): Promise<CrewRunResult>;
}

interface CrewRun {
  events: CrewEvent[];
  result?: CrewRunResult;
  subscribers: Set<(e: CrewEvent) => void>;
}

/** Tracks live crew runs so `GET …/runs/:id/events` can replay + stream. */
export class CrewRunManager {
  private readonly runs = new Map<string, CrewRun>();

  start(deps: ConsoleDeps, req: CrewRunRequest): string {
    const runId = randomUUID();
    const run: CrewRun = { events: [], subscribers: new Set() };
    this.runs.set(runId, run);

    const emit = (event: CrewEvent): void => {
      run.events.push(event);
      for (const sub of run.subscribers) sub(event);
    };

    void deps
      .runCrew(req, emit)
      .then((result) => {
        run.result = result;
      })
      .catch((cause: unknown) => {
        log.error('crew run %s failed: %s', runId, (cause as Error).message);
        run.result = {
          runId,
          lead: req.lead ?? 'unknown',
          task: req.task,
          text: '',
          finishReason: 'error',
          delegations: [],
          blackboard: [],
          error: (cause as Error).message,
        };
      });

    return runId;
  }

  get(runId: string): CrewRun | undefined {
    return this.runs.get(runId);
  }
}

export function registerConsoleRoutes(app: FastifyInstance, deps: ConsoleDeps): void {
  const crewRuns = new CrewRunManager();

  // ---- backlog ----------------------------------------------------------
  app.get(`${API_BASE}/backlog`, async () => (await deps.getBacklog()).board());

  app.get(`${API_BASE}/backlog/tasks`, async () => (await deps.getBacklog()).list());

  app.post(`${API_BASE}/backlog/tasks`, async (request, reply) => {
    const body = CreateTaskRequest.parse(request.body);
    const task = await (await deps.getBacklog()).create(body);
    return reply.code(201).send(task);
  });

  app.get(`${API_BASE}/backlog/tasks/:id`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const task = await (await deps.getBacklog()).get(id);
    if (!task) return reply.code(404).send({ error: `no task ${id}` });
    return task;
  });

  app.get(`${API_BASE}/backlog/tasks/:id/history`, async (request) => {
    const id = Number((request.params as { id: string }).id);
    return (await deps.getBacklog()).history(id);
  });

  app.post(`${API_BASE}/backlog/tasks/:id/move`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const body = MoveTaskRequest.parse(request.body);
    try {
      return await (await deps.getBacklog()).move(id, body.toState);
    } catch (cause) {
      return reply.code(400).send({ error: (cause as Error).message });
    }
  });

  // ---- crew -----------------------------------------------------------
  app.get(`${API_BASE}/crew/agents`, async () => deps.listAgents());

  app.post(`${API_BASE}/crew/runs`, async (request, reply) => {
    const body = CrewRunRequest.parse(request.body);
    const runId = crewRuns.start(deps, body);
    return reply.code(202).send({ runId });
  });

  app.get(`${API_BASE}/crew/runs/:id`, async (request, reply) => {
    const run = crewRuns.get((request.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: 'no such run' });
    if (!run.result) return reply.code(202).send({ status: 'running', events: run.events.length });
    return run.result;
  });

  app.get(`${API_BASE}/crew/runs/:id/events`, (request, reply) => {
    const run = crewRuns.get((request.params as { id: string }).id);
    if (!run) {
      void reply.code(404).send({ error: 'no such run' });
      return;
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    for (const event of run.events) reply.raw.write(formatSseEvent(event as never));
    if (run.result) {
      reply.raw.end();
      return;
    }
    const sub = (event: CrewEvent): void => {
      reply.raw.write(formatSseEvent(event as never));
      if (event.type === 'run.finish') reply.raw.end();
    };
    run.subscribers.add(sub);
    request.raw.on('close', () => run.subscribers.delete(sub));
  });

  // ---- memory --------------------------------------------------------
  app.post(`${API_BASE}/memory/search`, async (request) => {
    const body = MemorySearchRequest.parse(request.body);
    return deps.searchMemory(body);
  });

  app.post(`${API_BASE}/memory/reindex`, async () => deps.reindexMemory());

  log.info('console routes registered');
}
