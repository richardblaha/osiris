import type { Client } from "@libsql/client";

// WhatsApp state of one user in one tenant (the tenant's own database).

export interface WhatsAppSession {
  threadId: string | null;
  /** When the user last picked this tenant with `/tenant` (epoch ms), or null if never. */
  selectedAt: number | null;
}

export async function getSession(db: Client, userId: string): Promise<WhatsAppSession | null> {
  const { rows } = await db.execute({ sql: "SELECT thread_id, selected_at FROM whatsapp_sessions WHERE user_id = ?", args: [userId] });
  const row = rows[0];
  if (!row) return null;
  return { threadId: (row.thread_id as string | null) ?? null, selectedAt: row.selected_at == null ? null : Number(row.selected_at) };
}

export async function selectTenant(db: Client, userId: string, at: number): Promise<void> {
  await db.execute({
    sql: `INSERT INTO whatsapp_sessions (user_id, selected_at) VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET selected_at = excluded.selected_at`,
    args: [userId, at],
  });
}

/** Sets the thread WhatsApp messages go to; null makes the next message start a new one. */
export async function setThread(db: Client, userId: string, threadId: string | null): Promise<void> {
  await db.execute({
    sql: `INSERT INTO whatsapp_sessions (user_id, thread_id) VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET thread_id = excluded.thread_id`,
    args: [userId, threadId],
  });
}
