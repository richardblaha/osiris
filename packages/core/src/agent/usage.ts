import type { Client } from "@libsql/client";

/** The calendar month (UTC) a time falls in, as `YYYY-MM`. */
export const monthOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

/** Tokens the tenant's agent used per calendar month, checked against the tenant's quota. */
export class UsageStore {
  constructor(private readonly db: Client) {}

  async add(tokens: number, now = Date.now()) {
    if (!(tokens > 0)) return;
    await this.db.execute({
      sql: "INSERT INTO usage_months (month, tokens) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET tokens = tokens + excluded.tokens",
      args: [monthOf(now), Math.round(tokens)],
    });
  }

  async tokens(now = Date.now()): Promise<number> {
    const { rows } = await this.db.execute({ sql: "SELECT tokens FROM usage_months WHERE month = ?", args: [monthOf(now)] });
    return Number(rows[0]?.tokens ?? 0);
  }
}
