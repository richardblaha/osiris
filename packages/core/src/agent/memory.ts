import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import type { Memory, Scope } from "@osiris/shared";

/** Upper bound on memories injected into the system prompt per call. */
export const PROMPT_MEMORY_LIMIT = 100;

/**
 * Long-term memory in one tenant's database. A memory is either personal (`userId`) or shared with the
 * whole tenant (`userId` null). Only admins may create or remove shared memories.
 */
export class MemoryStore {
  constructor(private readonly db: Client) {}

  /** The user's personal memories plus the tenant's shared ones, newest first. */
  async list(userId: string, limit = PROMPT_MEMORY_LIMIT): Promise<Memory[]> {
    const { rows } = await this.db.execute({
      sql: `SELECT id, user_id, content, created_at FROM memories
            WHERE user_id = ? OR user_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      args: [userId, limit],
    });
    return rows.map((r) => ({
      id: String(r.id),
      content: String(r.content),
      scope: r.user_id === null ? "tenant" : "personal",
      createdAt: String(r.created_at),
    }));
  }

  async add(userId: string, content: string, scope: Scope): Promise<Memory> {
    const id = randomUUID();
    await this.db.execute({
      sql: "INSERT INTO memories (id, user_id, content) VALUES (?, ?, ?)",
      args: [id, scope === "tenant" ? null : userId, content],
    });
    return { id, content, scope, createdAt: new Date().toISOString() };
  }

  /** Deletes a tenant memory (`scope` tenant) or one of `userId`'s personal ones. Returns false if there's no such memory. */
  async delete(id: string, scope: Scope, userId: string): Promise<boolean> {
    const r = await this.db.execute(
      scope === "tenant"
        ? { sql: "DELETE FROM memories WHERE id = ? AND user_id IS NULL", args: [id] }
        : { sql: "DELETE FROM memories WHERE id = ? AND user_id = ?", args: [id, userId] },
    );
    return r.rowsAffected > 0;
  }
}
