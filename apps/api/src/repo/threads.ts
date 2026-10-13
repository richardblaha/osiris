import type { Client } from "@libsql/client";
import type { Channel, ThreadSummary } from "@osiris/shared";

// All functions take the tenant's own database; threads are additionally scoped to the user (OIDC sub).

export async function listThreads(db: Client, userId: string): Promise<ThreadSummary[]> {
  const { rows } = await db.execute({
    sql: "SELECT id, title, channel, updated_at FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100",
    args: [userId],
  });
  return rows.map((r) => ({
    id: String(r.id),
    title: r.title as string | null,
    channel: r.channel as Channel,
    updatedAt: String(r.updated_at),
  }));
}

export async function createThread(db: Client, userId: string, id: string, channel: Channel): Promise<void> {
  await db.execute({ sql: "INSERT INTO threads (id, user_id, channel) VALUES (?, ?, ?)", args: [id, userId, channel] });
}

/** Returns true only if the thread exists and belongs to `userId`. */
export async function ownsThread(db: Client, userId: string, id: string): Promise<boolean> {
  const { rows } = await db.execute({ sql: "SELECT 1 FROM threads WHERE id = ? AND user_id = ?", args: [id, userId] });
  return rows.length > 0;
}

/** Bumps `updated_at` and sets the title from the first message if it has none yet. */
export async function touchThread(db: Client, id: string, firstMessage: string): Promise<void> {
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 80);
  await db.execute({
    sql: "UPDATE threads SET updated_at = datetime('now'), title = COALESCE(title, ?) WHERE id = ?",
    args: [title || null, id],
  });
}

export async function deleteThread(db: Client, id: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM threads WHERE id = ?", args: [id] });
}
