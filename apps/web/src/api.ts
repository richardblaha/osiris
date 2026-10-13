import type { McpServer, McpServerStatus, Memory, MeResponse, RunEvent, Skill, SkillSummary, ThreadMessage, ThreadSummary } from "@osiris/shared";
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

export interface DocumentSummary {
  id: string;
  title: string;
  chunks: number;
  createdAt: string;
}

export const api = {
  me: () => json<MeResponse>("/me"),
  threads: () => json<ThreadSummary[]>("/threads"),
  createThread: () => json<{ id: string }>("/threads", { method: "POST" }),
  deleteThread: (id: string) => request(`/threads/${id}`, { method: "DELETE" }),
  messages: (id: string) => json<ThreadMessage[]>(`/threads/${id}/messages`),
  documents: () => json<DocumentSummary[]>("/knowledge/documents"),
  addDocument: (title: string, content: string) =>
    json<DocumentSummary>("/knowledge/documents", { method: "POST", body: JSON.stringify({ title, content }) }),
  deleteDocument: (id: string) => request(`/knowledge/documents/${id}`, { method: "DELETE" }),
  skills: () => json<SkillSummary[]>("/skills"),
  skill: (name: string) => json<Skill>(`/skills/${name}`),
  saveSkill: (name: string, description: string, instructions: string) =>
    json<Skill>(`/skills/${name}`, { method: "PUT", body: JSON.stringify({ description, instructions }) }),
  deleteSkill: (name: string) => request(`/skills/${name}`, { method: "DELETE" }),
  mcpServers: () => json<McpServer[]>("/mcp-servers"),
  saveMcpServer: (name: string, body: { url: string; enabled: boolean; headers?: Record<string, string> }) =>
    request(`/mcp-servers/${name}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteMcpServer: (name: string) => request(`/mcp-servers/${name}`, { method: "DELETE" }),
  testMcpServer: (name: string) => json<McpServerStatus>(`/mcp-servers/${name}/test`, { method: "POST" }),
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
