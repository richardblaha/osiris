import type {
  AgentDefinition,
  BacklogBoard,
  BacklogTask,
  CreateTaskRequest,
  CrewRunResult,
  MemorySearchResult,
} from '@osiris/protocol';

const BASE = '/api/v1';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  board: () => fetch(`${BASE}/backlog`).then((r) => json<BacklogBoard>(r)),

  createTask: (body: CreateTaskRequest) =>
    fetch(`${BASE}/backlog/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<BacklogTask>(r)),

  moveTask: (id: number, toState: string) =>
    fetch(`${BASE}/backlog/tasks/${id}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toState }),
    }).then((r) => json<BacklogTask>(r)),

  agents: () => fetch(`${BASE}/crew/agents`).then((r) => json<AgentDefinition[]>(r)),

  startRun: (task: string, lead?: string) =>
    fetch(`${BASE}/crew/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task, lead }),
    }).then((r) => json<{ runId: string }>(r)),

  run: (id: string) =>
    fetch(`${BASE}/crew/runs/${id}`).then((r) => json<CrewRunResult | { status: string }>(r)),

  search: (query: string, k = 6) =>
    fetch(`${BASE}/memory/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, k }),
    }).then((r) => json<MemorySearchResult>(r)),

  reindex: () =>
    fetch(`${BASE}/memory/reindex`, { method: 'POST' }).then((r) =>
      json<Record<string, number>>(r),
    ),
};
