/**
 * Canonical route table. Kept here so the server and the `osiris-workspace`
 * extension build their URLs from one source.
 */
export const API_BASE = '/api/v1' as const;

export const routes = {
  createSession: () => `${API_BASE}/sessions`,
  session: (id: string) => `${API_BASE}/sessions/${id}`,
  events: (id: string) => `${API_BASE}/sessions/${id}/events`,
  suspendSession: (id: string) => `${API_BASE}/sessions/${id}/suspend`,
  resumeSession: (id: string) => `${API_BASE}/sessions/${id}/resume`,
  sessionActivity: (id: string) => `${API_BASE}/sessions/${id}/activity`,

  // Crew + backlog + memory (the Osiris console API).
  backlog: () => `${API_BASE}/backlog`,
  backlogTasks: () => `${API_BASE}/backlog/tasks`,
  backlogTask: (id: number | string) => `${API_BASE}/backlog/tasks/${id}`,
  backlogTaskMove: (id: number | string) => `${API_BASE}/backlog/tasks/${id}/move`,
  backlogTaskHistory: (id: number | string) => `${API_BASE}/backlog/tasks/${id}/history`,
  backlogPush: () => `${API_BASE}/backlog/push`,
  backlogPull: () => `${API_BASE}/backlog/pull`,
  crewAgents: () => `${API_BASE}/crew/agents`,
  crewRuns: () => `${API_BASE}/crew/runs`,
  crewRun: (id: string) => `${API_BASE}/crew/runs/${id}`,
  crewRunEvents: (id: string) => `${API_BASE}/crew/runs/${id}/events`,
  memorySearch: () => `${API_BASE}/memory/search`,
  memoryReindex: () => `${API_BASE}/memory/reindex`,
} as const;
