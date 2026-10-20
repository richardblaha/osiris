import type { Client } from "@libsql/client";

/** The calendar month (UTC) a time falls in, as `YYYY-MM`. */
export const monthOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

/** Tokens the tenant's agent used per calendar month, checked against the tenant's quota. */
export class UsageStore {
  constructor(private readonly db: Client) {}

  /** Counts tokens for the tenant; a public assistant's also for its own quota (row `public:<name>:YYYY-MM`). */
  async add(tokens: number, now = Date.now(), { public: open }: { public?: string } = {}) {
    if (!(tokens > 0)) return;
    const sql = "INSERT INTO usage_months (month, tokens) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET tokens = tokens + excluded.tokens";
    const n = Math.round(tokens);
    await this.db.batch([{ sql, args: [monthOf(now), n] }, ...(open ? [{ sql, args: [`public:${open}:${monthOf(now)}`, n] }] : [])], "write");
  }

  async tokens(now = Date.now(), { public: open }: { public?: string } = {}): Promise<number> {
    const { rows } = await this.db.execute({ sql: "SELECT tokens FROM usage_months WHERE month = ?", args: [`${open ? `public:${open}:` : ""}${monthOf(now)}`] });
    return Number(rows[0]?.tokens ?? 0);
  }
}
