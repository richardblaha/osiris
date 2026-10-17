import { randomUUID } from "node:crypto";
import { run, type Db } from "@osiris/platform/rqlite.ts";
import type { InboundMessage } from "./cloud-api.ts";

export interface InboxMessage extends InboundMessage {
  attempts: number;
}

interface Row {
  message_id: string;
  from_number: string;
  phone_number_id: string;
  type: string;
  text: string | null;
  attempts: number;
}

/**
 * WhatsApp messages as Meta delivered them. The webhook stores them and answers at once; workers on any replica take
 * them one at a time per sender, in order. Redeliveries are dropped by the message id.
 */
export class Inbox {
  constructor(
    private readonly db: Db,
    private readonly leaseMs = 10 * 60_000,
  ) {}

  async enqueue(messages: InboundMessage[], now = Date.now()) {
    if (!messages.length) return;
    await this.db.execute(
      messages.map((m) =>
        run(
          `INSERT INTO wa_inbox (message_id, from_number, phone_number_id, type, text, received_at, next_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (message_id) DO NOTHING`,
          m.id,
          m.from,
          m.phoneNumberId,
          m.type,
          m.text ?? null,
          now,
          now,
        ),
      ),
    );
  }

  /**
   * Claims the next message: the oldest pending one of a sender with nothing in progress and nothing older waiting.
   * A message whose worker died gets back in line once its lease expires.
   */
  async claim(now = Date.now()): Promise<InboxMessage | null> {
    const claim = randomUUID();
    await this.db.execute([
      run("UPDATE wa_inbox SET status = 'pending', claim = NULL WHERE status = 'processing' AND lease_until < ?", now),
      run(
        `UPDATE wa_inbox SET status = 'processing', claim = ?, lease_until = ?, attempts = attempts + 1
         WHERE message_id = (
           SELECT m.message_id FROM wa_inbox m
           WHERE m.status = 'pending' AND m.next_at <= ?
             AND NOT EXISTS (SELECT 1 FROM wa_inbox p WHERE p.from_number = m.from_number AND p.status = 'processing')
             AND NOT EXISTS (SELECT 1 FROM wa_inbox e WHERE e.from_number = m.from_number AND e.status = 'pending' AND e.received_at < m.received_at)
           ORDER BY m.received_at LIMIT 1)`,
        claim,
        now + this.leaseMs,
        now,
      ),
    ]);
    const [row] = await this.db.query<Row>("SELECT * FROM wa_inbox WHERE claim = ?", [claim], { fresh: true });
    return row
      ? { id: row.message_id, from: row.from_number, phoneNumberId: row.phone_number_id, type: row.type, text: row.text ?? undefined, attempts: Number(row.attempts) }
      : null;
  }

  async finish(id: string, status: "done" | "failed", error?: string) {
    await this.db.execute([run("UPDATE wa_inbox SET status = ?, claim = NULL, error = ? WHERE message_id = ?", status, error ?? null, id)]);
  }

  /** Puts the message back in line after `delayMs`; later messages of the sender wait for it. */
  async retry(id: string, delayMs: number, error: string, now = Date.now()) {
    await this.db.execute([
      run("UPDATE wa_inbox SET status = 'pending', claim = NULL, next_at = ?, error = ? WHERE message_id = ?", now + delayMs, error, id),
    ]);
  }

  /** The business number a user last wrote to, for messages we start (scheduled results). */
  async lastPhoneNumberId(from: string): Promise<{ phoneNumberId: string; at: number } | null> {
    const [row] = await this.db.query<{ phone_number_id: string; received_at: number }>(
      "SELECT phone_number_id, received_at FROM wa_inbox WHERE from_number = ? ORDER BY received_at DESC LIMIT 1",
      [from],
    );
    return row ? { phoneNumberId: row.phone_number_id, at: Number(row.received_at) } : null;
  }

  async cleanup(olderThanMs = 7 * 24 * 60 * 60_000, now = Date.now()) {
    await this.db.execute([run("DELETE FROM wa_inbox WHERE status IN ('done', 'failed') AND received_at < ?", now - olderThanMs)]);
  }
}
