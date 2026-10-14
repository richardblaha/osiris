import type {
  DocumentSummary,
  McpServer,
  McpServerStatus,
  Memory,
  MeResponse,
  RunEvent,
  Scope,
  Skill,
  SkillSummary,
  ThreadMessage,
  ThreadSummary,
  UserSettings,
} from "@osiris/shared";
import { getAccessToken, login } from "./auth.ts";

const BASE = (import.meta.env.VITE_API_URL ?? "") + "/api";
let tenantId: string | undefined;

export const setTenant = (id: string) => {
  tenantId = id;
};

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  if (!token) {
    await login();
    throw new Error("Not logged in");
  }
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(tenantId ? { "x-tenant-id": tenantId } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401) await login();
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  return res;
}

const json = async <T>(path: string, init?: RequestInit) => (await request(path, init)).json() as Promise<T>;

export const api = {
  me: () => json<MeResponse>("/me"),
  threads: () => json<ThreadSummary[]>("/threads"),
  createThread: () => json<{ id: string }>("/threads", { method: "POST" }),
  deleteThread: (id: string) => request(`/threads/${id}`, { method: "DELETE" }),
  messages: (id: string) => json<ThreadMessage[]>(`/threads/${id}/messages`),
  documents: () => json<DocumentSummary[]>("/knowledge/documents"),
  addDocument: (title: string, content: string, scope: Scope) =>
    json<DocumentSummary>("/knowledge/documents", { method: "POST", body: JSON.stringify({ title, content, scope }) }),
  deleteDocument: (id: string, scope: Scope) => request(`/knowledge/documents/${id}?scope=${scope}`, { method: "DELETE" }),
  skills: () => json<SkillSummary[]>("/skills"),
  skill: (name: string) => json<Skill>(`/skills/${name}`),
  saveSkill: (name: string, description: string, instructions: string, scope: Scope) =>
    json<Skill>(`/skills/${name}`, { method: "PUT", body: JSON.stringify({ description, instructions, scope }) }),
  deleteSkill: (name: string, scope: Scope) => request(`/skills/${name}?scope=${scope}`, { method: "DELETE" }),
  mcpServers: () => json<McpServer[]>("/mcp-servers"),
  saveMcpServer: (name: string, body: { url: string; enabled: boolean; headers?: Record<string, string>; scope: Scope }) =>
    request(`/mcp-servers/${name}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteMcpServer: (name: string, scope: Scope) => request(`/mcp-servers/${name}?scope=${scope}`, { method: "DELETE" }),
  testMcpServer: (name: string, scope: Scope) =>
    json<McpServerStatus>(`/mcp-servers/${name}/test?scope=${scope}`, { method: "POST" }),
  settings: () => json<UserSettings>("/settings"),
  saveSettings: (settings: UserSettings) => json<UserSettings>("/settings", { method: "PUT", body: JSON.stringify(settings) }),
  memories: () => json<Memory[]>("/memories"),
  addMemory: (content: string, shared: boolean) =>
    json<Memory>("/memories", { method: "POST", body: JSON.stringify({ content, shared }) }),
  deleteMemory: (id: string) => request(`/memories/${id}`, { method: "DELETE" }),

  /** Starts a run and yields its server-sent events. */
  async *run(threadId: string, message: string, signal: AbortSignal): AsyncGenerator<RunEvent> {
    const res = await request(`/threads/${threadId}/runs`, { method: "POST", body: JSON.stringify({ message }), signal });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      const events = buffer.split("\n\n");
      buffer = events.pop()!;
      for (const event of events) {
        const data = event
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) yield JSON.parse(data) as RunEvent;
      }
    }
  },
};
