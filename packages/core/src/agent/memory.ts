import type { Memory, Scope } from "@osiris/shared";
import { PROJECT_AGENT } from "../memory/file-vector-store.ts";
import type { MemoryEngine } from "../memory/mem0.ts";

/** Upper bound on memories injected into the system prompt per call. */
export const PROMPT_MEMORY_LIMIT = 100;

type Point = { id: string; payload: Record<string, unknown> };

/** Creation order, also within one millisecond. */
let last = 0;
const tick = () => (last = Math.max(Date.now() * 1000, last + 1));

const scopeOf = (scope: Scope, userId: string): Record<string, string> => (scope === "project" ? { agent_id: PROJECT_AGENT } : { user_id: userId });
const toMemory = (p: Point): Memory & { order: number } => ({
  id: p.id,
  content: String(p.payload.data ?? ""),
  scope: p.payload.user_id ? "personal" : "project",
  ...(typeof p.payload.overrides === "string" ? { overrides: p.payload.overrides } : {}),
  createdAt: String(p.payload.createdAt ?? ""),
  order: Number(p.payload.order ?? 0),
});
const strip = ({ order: _, ...m }: Memory & { order: number }): Memory => m;

/**
 * Long-term memory through Mem0, one Markdown file per memory (the project's in `.osiris/memory/`, a user's in their
 * private folder) with Mem0's entity graph beside them. Only admins create or remove the project's; a user may replace
 * one for themselves with a personal memory that `overrides` it. Memories written on purpose (`remember`, the API) are
 * kept verbatim; `extract` lets Mem0 pick facts from a conversation and merge them with what it knows.
 */
export class MemoryStore {
  constructor(private readonly engine: MemoryEngine) {}

  private async points(filters: Record<string, unknown>): Promise<(Memory & { order: number })[]> {
    const [found] = await (await this.engine.points()).list(filters, 100_000);
    return found.map((p) => toMemory(p as Point));
  }

  /**
   * The user's personal memories plus the project's shared ones, newest first. A shared one the user replaced is
   * `overridden`; `effective` leaves those out (what the assistant is told).
   */
  async list(userId: string, limit = PROMPT_MEMORY_LIMIT, { effective = false } = {}): Promise<Memory[]> {
    const own = userId ? await this.points({ user_id: userId }) : [];
    const replaced = new Set(own.flatMap((m) => (m.overrides ? [m.overrides] : [])));
    const shared = await this.points({ agent_id: PROJECT_AGENT });
    return [...own, ...shared.map((m) => (replaced.has(m.id) ? { ...m, overridden: true } : m))]
      .sort((a, b) => b.order - a.order)
      .slice(0, limit)
      .filter((m) => !effective || !m.overridden)
      .map(strip);
  }

  /** The project's shared memories among these ids (a public assistant's), newest first. */
  async projectByIds(ids: string[]): Promise<Memory[]> {
    if (!ids.length) return [];
    return (await this.points({ agent_id: PROJECT_AGENT }))
      .filter((m) => ids.includes(m.id))
      .sort((a, b) => b.order - a.order)
      .slice(0, PROMPT_MEMORY_LIMIT)
      .map(strip);
  }

  /** `overrides`: a personal memory replacing that project memory for its owner (one replacement per memory). */
  async add(userId: string, content: string, scope: Scope, overrides?: string): Promise<Memory> {
    if (overrides) {
      if (scope !== "personal") throw new Error("Only a personal memory replaces a project one");
      const target = await (await this.engine.points()).get(overrides);
      if (target?.payload.agent_id !== PROJECT_AGENT) throw new Error(`No project memory ${overrides}`);
      for (const m of await this.points({ user_id: userId, overrides })) await this.engine.memory.delete(m.id);
    }
    const filters = scopeOf(scope, userId);
    const { results } = (await this.engine.memory.add(content, {
      ...(scope === "project" ? { agentId: PROJECT_AGENT } : { userId }),
      infer: false,
      metadata: { order: tick(), ...(overrides ? { overrides } : {}) },
    })) as unknown as { results: { id: string }[] };
    const id = results[0]!.id;
    await this.engine.link(id, content, filters);
    const saved = await (await this.engine.points()).get(id);
    return strip(toMemory(saved as Point));
  }

  /** Deletes a project memory (`scope` project) or one of `userId`'s personal ones. Returns false if there's no such memory. */
  async delete(id: string, scope: Scope, userId: string): Promise<boolean> {
    const point = await (await this.engine.points()).get(id);
    const own = scope === "personal" ? point?.payload.user_id === userId : point?.payload.agent_id === PROJECT_AGENT && !point.payload.user_id;
    if (!point || !own) return false;
    await this.engine.memory.delete(id);
    // A project memory takes its replacements with it.
    if (scope === "project") for (const m of await this.points({ overrides: id })) await this.engine.memory.delete(m.id);
    return true;
  }

  /** The user's and the project's memories most relevant to `query` (Mem0's search: meaning, words and entities). */
  async search(userId: string, query: string, limit = 20): Promise<Memory[]> {
    const search = (filters: Record<string, string>) => this.engine.memory.search(query, { filters, topK: limit }).then((r) => r.results);
    const [own, shared] = await Promise.all([search({ user_id: userId }), search({ agent_id: PROJECT_AGENT })]);
    const replaced = new Set(own.flatMap((m) => (typeof m.metadata?.overrides === "string" ? [m.metadata.overrides] : [])));
    return [...own, ...shared.filter((m) => !replaced.has(m.id))]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit)
      .map((m) => ({ id: m.id, content: m.memory, scope: (m as { user_id?: string }).user_id ? "personal" : "project", createdAt: m.createdAt ?? "" }) as Memory);
  }

  /** What the assistant is told: every memory while there are few, else the ones most relevant to the message. */
  async forPrompt(userId: string, message: string): Promise<Memory[]> {
    const all = await this.list(userId, PROMPT_MEMORY_LIMIT + 1, { effective: true });
    return all.length <= PROMPT_MEMORY_LIMIT || !message.trim() ? all.slice(0, PROMPT_MEMORY_LIMIT) : this.search(userId, message, PROMPT_MEMORY_LIMIT);
  }

  /** Lets Mem0 pick the user's facts from a conversation turn and merge them with their memories; its tokens go to `pay`. */
  async extract(userId: string, messages: { role: "user" | "assistant"; content: string }[], pay: (tokens: number) => void): Promise<void> {
    await this.engine.paidBy(pay, () => this.engine.memory.add(messages, { userId, infer: true }));
  }
}
