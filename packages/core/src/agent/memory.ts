import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import type { Memory, Scope } from "@osiris/shared";

/** Upper bound on memories injected into the system prompt per call. */
export const PROMPT_MEMORY_LIMIT = 100;

/**
 * Long-term memory in one tenant's database. A memory is either personal (`userId`) or shared with the
 * whole tenant (`userId` null). Only admins may create or remove shared memories; a user may replace one for
 * themselves with a personal memory that `overrides` it.
 */
export class MemoryStore {
  constructor(private readonly db: Client) {}

  /**
   * The user's personal memories plus the tenant's shared ones, newest first. A shared one the user replaced is
   * `overridden`; `effective` leaves those out (what the assistant is told).
   */
  async list(userId: string, limit = PROMPT_MEMORY_LIMIT, { effective = false } = {}): Promise<Memory[]> {
    const { rows } = await this.db.execute({
      sql: `SELECT m.id, m.user_id, m.content, m.overrides, m.created_at,
              (m.user_id IS NULL AND EXISTS (SELECT 1 FROM memories p WHERE p.user_id = ? AND p.overrides = m.id)) AS overridden
            FROM memories m WHERE m.user_id = ? OR m.user_id IS NULL ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      args: [userId, userId, limit],
    });
    return rows
      .map((r): Memory => ({
        id: String(r.id),
        content: String(r.content),
        scope: r.user_id === null ? "tenant" : "personal",
        ...(r.overrides ? { overrides: String(r.overrides) } : {}),
        ...(Number(r.overridden) ? { overridden: true } : {}),
        createdAt: String(r.created_at),
      }))
      .filter((m) => !effective || !m.overridden);
  }

  /** The tenant's shared memories among these ids (a public assistant's), newest first. */
  async tenantByIds(ids: string[]): Promise<Memory[]> {
    if (!ids.length) return [];
    const { rows } = await this.db.execute({
      sql: `SELECT id, content, created_at FROM memories WHERE user_id IS NULL AND id IN (${ids.map(() => "?").join(", ")})
            ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      args: [...ids, PROMPT_MEMORY_LIMIT],
    });
    return rows.map((r) => ({ id: String(r.id), content: String(r.content), scope: "tenant", createdAt: String(r.created_at) }));
  }

  /** `overrides`: a personal memory replacing that tenant memory for its owner (one replacement per memory). */
  async add(userId: string, content: string, scope: Scope, overrides?: string): Promise<Memory> {
    if (overrides) {
      if (scope !== "personal") throw new Error("Only a personal memory replaces a tenant one");
      const { rows } = await this.db.execute({ sql: "SELECT 1 FROM memories WHERE id = ? AND user_id IS NULL", args: [overrides] });
      if (!rows.length) throw new Error(`No tenant memory ${overrides}`);
      await this.db.execute({ sql: "DELETE FROM memories WHERE user_id = ? AND overrides = ?", args: [userId, overrides] });
    }
    const id = randomUUID();
    await this.db.execute({
      sql: "INSERT INTO memories (id, user_id, content, overrides) VALUES (?, ?, ?, ?)",
      args: [id, scope === "tenant" ? null : userId, content, overrides ?? null],
    });
    return { id, content, scope, ...(overrides ? { overrides } : {}), createdAt: new Date().toISOString() };
  }

  /** Deletes a tenant memory (`scope` tenant) or one of `userId`'s personal ones. Returns false if there's no such memory. */
  async delete(id: string, scope: Scope, userId: string): Promise<boolean> {
    if (scope === "personal") return (await this.db.execute({ sql: "DELETE FROM memories WHERE id = ? AND user_id = ?", args: [id, userId] })).rowsAffected > 0;
    // A tenant memory takes its replacements with it.
    const [r] = await this.db.batch(
      [
        { sql: "DELETE FROM memories WHERE id = ? AND user_id IS NULL", args: [id] },
        { sql: "DELETE FROM memories WHERE overrides = ?", args: [id] },
      ],
      "write",
    );
    return r!.rowsAffected > 0;
  }
}
