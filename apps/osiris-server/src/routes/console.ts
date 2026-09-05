import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
} from '@richardblaha/protocol';
import { createLogger } from '@richardblaha/shared-core';
import { formatSseEvent } from '../sse.js';

const log = createLogger('server:console');

export interface BacklogApi {
  board(): Promise<unknown>;
  list(): Promise<unknown[]>;
  get(id: number): Promise<unknown>;
  create(input: CreateTaskRequest): Promise<unknown>;
  move(id: number, toState: string): Promise<unknown>;
  history(id: number): Promise<unknown[]>;
  push?(): Promise<{ ok: boolean; diverged?: boolean; message: string }>;
  pull?(): Promise<{ ok: boolean; diverged?: boolean; message: string }>;
}

export interface ConsoleDeps {
  /** Backlog repo bound to the workspace (lazily opened). */
  getBacklog(): Promise<BacklogApi>;
  listAgents(): Promise<AgentDefinition[]>;
  searchMemory(req: MemorySearchRequest): Promise<MemorySearchResult>;
  reindexMemory(): Promise<MemoryReindexResult>;
  runCrew(req: CrewRunRequest, onEvent: (e: CrewEvent) => void): Promise<CrewRunResult>;
  /** Directory to persist finished crew runs into (survives a restart). */
  crewRunsDir?: string;
}

interface CrewRun {
  events: CrewEvent[];
  result?: CrewRunResult;
  startedAt: string;
  subscribers: Set<(e: CrewEvent) => void>;
}

export interface CrewRunSummary {
  runId: string;
  task: string;
  lead: string;
  startedAt: string;
  finishReason?: CrewRunResult['finishReason'];
}

/**
 * Tracks live crew runs so `GET …/runs/:id/events` can replay + stream, and —
 * when `persistDir` is given — writes each finished run to
 * `<persistDir>/<runId>.json` so it survives a restart and can be listed.
 */
export class CrewRunManager {
  private readonly runs = new Map<string, CrewRun>();

  constructor(private readonly persistDir?: string) {
    if (persistDir) {
      try {
        mkdirSync(persistDir, { recursive: true });
      } catch {
        /* best effort */
      }
    }
  }

  start(deps: ConsoleDeps, req: CrewRunRequest): string {
    const runId = randomUUID();
    const run: CrewRun = {
      events: [],
      startedAt: new Date().toISOString(),
      subscribers: new Set(),
    };
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
      })
      .finally(() => this.persist(runId, run));

    return runId;
  }

  private persist(runId: string, run: CrewRun): void {
    if (!this.persistDir || !run.result) return;
    try {
      writeFileSync(
        join(this.persistDir, `${runId}.json`),
        JSON.stringify({ runId, startedAt: run.startedAt, result: run.result }, null, 2),
      );
    } catch (cause) {
      log.warn('could not persist crew run %s: %s', runId, (cause as Error).message);
    }
  }

  get(runId: string): CrewRun | undefined {
    const live = this.runs.get(runId);
    if (live) return live;
    if (!this.persistDir) return undefined;
    try {
      const raw = JSON.parse(readFileSync(join(this.persistDir, `${runId}.json`), 'utf8')) as {
        startedAt: string;
        result: CrewRunResult;
      };
      return { events: [], result: raw.result, startedAt: raw.startedAt, subscribers: new Set() };
    } catch {
      return undefined;
    }
  }

  /** Every run this process has seen plus any persisted on disk, newest first. */
  list(): CrewRunSummary[] {
    const seen = new Map<string, CrewRunSummary>();
    for (const [runId, run] of this.runs) {
      seen.set(runId, {
        runId,
        task: run.result?.task ?? '',
        lead: run.result?.lead ?? '',
        startedAt: run.startedAt,
        finishReason: run.result?.finishReason,
      });
    }
    if (this.persistDir) {
      let files: string[] = [];
      try {
        files = readdirSync(this.persistDir).filter((f) => f.endsWith('.json'));
      } catch {
        /* none */
      }
      for (const file of files) {
        const runId = file.replace(/\.json$/, '');
        if (seen.has(runId)) continue;
        try {
          const raw = JSON.parse(readFileSync(join(this.persistDir, file), 'utf8')) as {
            startedAt: string;
            result: CrewRunResult;
          };
          seen.set(runId, {
            runId,
            task: raw.result.task,
            lead: raw.result.lead,
            startedAt: raw.startedAt,
            finishReason: raw.result.finishReason,
          });
        } catch {
          /* skip a corrupt file */
        }
      }
    }
    return [...seen.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}

export function registerConsoleRoutes(app: FastifyInstance, deps: ConsoleDeps): void {
  const crewRuns = new CrewRunManager(deps.crewRunsDir);

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

  for (const dir of ['push', 'pull'] as const) {
    app.post(`${API_BASE}/backlog/${dir}`, async (_request, reply) => {
      const backlog = await deps.getBacklog();
      const fn = backlog[dir];
      if (!fn) return reply.code(501).send({ ok: false, message: `${dir} not supported here` });
      return fn.call(backlog);
    });
  }

  // ---- crew -----------------------------------------------------------
  app.get(`${API_BASE}/crew/agents`, async () => deps.listAgents());

  app.get(`${API_BASE}/crew/runs`, async () => crewRuns.list());

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
