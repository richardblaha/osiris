import { randomUUID } from "node:crypto";
import type { Memory, Scope } from "@osiris/shared";
import { formatFrontmatter, parseFrontmatter, userDir, type Records } from "../projects/records.ts";

/** Upper bound on memories injected into the system prompt per call. */
export const PROMPT_MEMORY_LIMIT = 100;

const dirOf = (userId: string | null) => (userId ? `${userDir(userId)}/memory` : "memory");
const ID = /^[0-9a-f-]{36}$/;

/** Creation order, also within one millisecond. */
let last = 0;
const tick = () => (last = Math.max(Date.now() * 1000, last + 1));

/**
 * Long-term memory, one Markdown file per memory: the project's in `memory/`, a user's in their private folder. Only
 * admins create or remove the project's; a user may replace one for themselves with a personal memory that `overrides` it.
 */
export class MemoryStore {
  constructor(private readonly records: Records) {}

  private async read(userId: string | null): Promise<(Memory & { order: number })[]> {
    const out: (Memory & { order: number })[] = [];
    for (const name of await this.records.list(dirOf(userId))) {
      const id = name.replace(/\.md$/, "");
      if (!ID.test(id) || !name.endsWith(".md")) continue;
      const text = await this.records.readText(`${dirOf(userId)}/${name}`);
      if (text === undefined) continue;
      const { meta, body } = parseFrontmatter(text);
      out.push({
        id,
        content: body.trim(),
        scope: userId ? "personal" : "project",
        ...(meta.overrides ? { overrides: meta.overrides } : {}),
        createdAt: meta.createdAt ?? "",
        order: Number(meta.order ?? 0),
      });
    }
    return out;
  }

  /**
   * The user's personal memories plus the project's shared ones, newest first. A shared one the user replaced is
   * `overridden`; `effective` leaves those out (what the assistant is told).
   */
  async list(userId: string, limit = PROMPT_MEMORY_LIMIT, { effective = false } = {}): Promise<Memory[]> {
    const own = userId ? await this.read(userId) : [];
    const replaced = new Set(own.flatMap((m) => (m.overrides ? [m.overrides] : [])));
    const all = [...own, ...(await this.read(null)).map((m) => (replaced.has(m.id) ? { ...m, overridden: true } : m))];
    return all
      .sort((a, b) => b.order - a.order)
      .slice(0, limit)
      .filter((m) => !effective || !m.overridden)
      .map(({ order: _, ...m }) => m);
  }

  /** The project's shared memories among these ids (a public assistant's), newest first. */
  async projectByIds(ids: string[]): Promise<Memory[]> {
    if (!ids.length) return [];
    return (await this.read(null))
      .filter((m) => ids.includes(m.id))
      .sort((a, b) => b.order - a.order)
      .slice(0, PROMPT_MEMORY_LIMIT)
      .map(({ order: _, ...m }) => m);
  }

  /** `overrides`: a personal memory replacing that project memory for its owner (one replacement per memory). */
  async add(userId: string, content: string, scope: Scope, overrides?: string): Promise<Memory> {
    const owner = scope === "project" ? null : userId;
    if (overrides) {
      if (scope !== "personal") throw new Error("Only a personal memory replaces a project one");
      if (!ID.test(overrides) || !(await this.records.readText(`${dirOf(null)}/${overrides}.md`))) throw new Error(`No project memory ${overrides}`);
      for (const m of await this.read(userId)) if (m.overrides === overrides) await this.records.remove(`${dirOf(userId)}/${m.id}.md`);
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await this.records.writeText(`${dirOf(owner)}/${id}.md`, formatFrontmatter({ createdAt, order: tick(), overrides }, `${content}\n`));
    return { id, content, scope, ...(overrides ? { overrides } : {}), createdAt };
  }

  /** Deletes a project memory (`scope` project) or one of `userId`'s personal ones. Returns false if there's no such memory. */
  async delete(id: string, scope: Scope, userId: string): Promise<boolean> {
    if (!ID.test(id)) return false;
    if (scope === "personal") return this.records.remove(`${dirOf(userId)}/${id}.md`);
    // A project memory takes its replacements with it.
    const existed = await this.records.remove(`${dirOf(null)}/${id}.md`);
    for (const user of await this.records.list("private/users")) {
      const dir = `private/users/${user}/memory`;
      for (const name of await this.records.list(dir)) {
        const text = await this.records.readText(`${dir}/${name}`);
        if (text && parseFrontmatter(text).meta.overrides === id) await this.records.remove(`${dir}/${name}`);
      }
    }
    return existed;
  }
}
