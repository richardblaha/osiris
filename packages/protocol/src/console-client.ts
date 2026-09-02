/**
 * A thin typed client for the Osiris console API (backlog / crew / memory).
 * Pure `fetch` + zod, no framework — used by the SPA, the CLI and tests.
 */
import {
  BacklogBoard,
  BacklogSyncResult,
  BacklogTask,
  CreateTaskRequest,
  MoveTaskRequest,
  TaskHistoryEntry,
} from './backlog.js';
import { AgentDefinition, CrewEvent, CrewRunRequest, CrewRunResult } from './crew.js';
import { MemoryReindexResult, MemorySearchRequest, MemorySearchResult } from './memory.js';
import { routes } from './routes.js';

export class ConsoleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`console request failed: HTTP ${status}`);
    this.name = 'ConsoleHttpError';
  }
}

export interface ConsoleClientOptions {
  /** Server origin. Default `''` (same-origin — the SPA case). */
  baseUrl?: string;
  /** Bearer token, when the server enforces one. */
  token?: string;
  fetchImpl?: typeof fetch;
}

/** One Server-Sent Event parsed from a stream: `event:` name + JSON `data:`. */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (data) {
        try {
          yield JSON.parse(data);
        } catch {
          /* keep-alive / comment frame */
        }
      }
    }
  }
}

export class ConsoleClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ConsoleClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) throw new ConsoleHttpError(res.status, await res.text().catch(() => ''));
    return res;
  }

  // ---- backlog ------------------------------------------------------
  async board(): Promise<BacklogBoard> {
    return BacklogBoard.parse(await (await this.send(routes.backlog())).json());
  }

  async createTask(input: CreateTaskRequest): Promise<BacklogTask> {
    const res = await this.send(routes.backlogTasks(), {
      method: 'POST',
      body: JSON.stringify(CreateTaskRequest.parse(input)),
    });
    return BacklogTask.parse(await res.json());
  }

  async moveTask(id: number, toState: string): Promise<BacklogTask> {
    const res = await this.send(routes.backlogTaskMove(id), {
      method: 'POST',
      body: JSON.stringify(MoveTaskRequest.parse({ toState })),
    });
    return BacklogTask.parse(await res.json());
  }

  async taskHistory(id: number): Promise<TaskHistoryEntry[]> {
    const res = await this.send(routes.backlogTaskHistory(id));
    return TaskHistoryEntry.array().parse(await res.json());
  }

  async pushBacklog(): Promise<BacklogSyncResult> {
    return BacklogSyncResult.parse(
      await (await this.send(routes.backlogPush(), { method: 'POST' })).json(),
    );
  }

  async pullBacklog(): Promise<BacklogSyncResult> {
    return BacklogSyncResult.parse(
      await (await this.send(routes.backlogPull(), { method: 'POST' })).json(),
    );
  }

  // ---- crew --------------------------------------------------------
  async agents(): Promise<AgentDefinition[]> {
    const json = await (await this.send(routes.crewAgents())).json();
    return AgentDefinition.array().parse(json);
  }

  async startRun(input: CrewRunRequest): Promise<string> {
    const res = await this.send(routes.crewRuns(), {
      method: 'POST',
      body: JSON.stringify(CrewRunRequest.parse(input)),
    });
    return ((await res.json()) as { runId: string }).runId;
  }

  async run(id: string): Promise<CrewRunResult | { status: 'running'; events: number }> {
    const res = await this.send(routes.crewRun(id));
    const json = await res.json();
    return res.status === 202
      ? (json as { status: 'running'; events: number })
      : CrewRunResult.parse(json);
  }

  /** Live event stream for a run. Replays past events, then streams to `run.finish`. */
  async *streamRun(id: string): AsyncGenerator<CrewEvent> {
    const res = await this.send(routes.crewRunEvents(id), {
      headers: { accept: 'text/event-stream' },
    });
    if (!res.body) return;
    for await (const frame of parseSse(res.body)) {
      const parsed = CrewEvent.safeParse(frame);
      if (parsed.success) yield parsed.data;
      if (parsed.success && parsed.data.type === 'run.finish') return;
    }
  }

  /** Convenience: start a run and yield its events. */
  async *run$(input: CrewRunRequest): AsyncGenerator<CrewEvent> {
    yield* this.streamRun(await this.startRun(input));
  }

  // ---- memory -----------------------------------------------------
  async search(input: MemorySearchRequest): Promise<MemorySearchResult> {
    const res = await this.send(routes.memorySearch(), {
      method: 'POST',
      body: JSON.stringify(MemorySearchRequest.parse(input)),
    });
    return MemorySearchResult.parse(await res.json());
  }

  async reindex(): Promise<MemoryReindexResult> {
    const res = await this.send(routes.memoryReindex(), { method: 'POST' });
    return MemoryReindexResult.parse(await res.json());
  }
}
