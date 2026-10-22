import type { Client } from "@libsql/client";

/** The calendar month (UTC) a time falls in, as `YYYY-MM`. */
export const monthOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

/** Whose tokens: a public assistant's (row `public:<name>:YYYY-MM`) or a member's (`user:<sub>:YYYY-MM`). */
export interface UsageOwner {
  public?: string;
  user?: string;
}

const key = (month: string, { public: open, user }: UsageOwner) => (open ? `public:${open}:${month}` : user ? `user:${user}:${month}` : month);

/** Tokens the tenant's agent used per calendar month, checked against the tenant's, its members' and its public assistants' quotas. */
export class UsageStore {
  constructor(private readonly db: Client) {}

  /** Counts tokens for the tenant, and for the public assistant or the member who ran them. */
  async add(tokens: number, now = Date.now(), owner: UsageOwner = {}) {
    if (!(tokens > 0)) return;
    const sql = "INSERT INTO usage_months (month, tokens) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET tokens = tokens + excluded.tokens";
    const n = Math.round(tokens);
    const month = monthOf(now);
    const own = owner.public || owner.user ? [{ sql, args: [key(month, owner), n] }] : [];
    await this.db.batch([{ sql, args: [month, n] }, ...own], "write");
  }

  async tokens(now = Date.now(), owner: UsageOwner = {}): Promise<number> {
    const { rows } = await this.db.execute({ sql: "SELECT tokens FROM usage_months WHERE month = ?", args: [key(monthOf(now), owner)] });
    return Number(rows[0]?.tokens ?? 0);
  }

  /** This month's tokens by member and by public assistant (most first), and the tenant's of the last 12 months. */
  async breakdown(now = Date.now()): Promise<{ users: { userId: string; tokens: number }[]; assistants: { name: string; tokens: number }[]; months: { month: string; tokens: number }[] }> {
    const month = monthOf(now);
    const { rows } = await this.db.execute("SELECT month, tokens FROM usage_months");
    const all = rows.map((r) => ({ key: String(r.month), tokens: Number(r.tokens) }));
    const own = (prefix: string) =>
      all
        .filter((r) => r.key.startsWith(prefix) && r.key.endsWith(`:${month}`))
        .map((r) => ({ id: r.key.slice(prefix.length, -month.length - 1), tokens: r.tokens }))
        .sort((a, b) => b.tokens - a.tokens);
    return {
      users: own("user:").map((u) => ({ userId: u.id, tokens: u.tokens })),
      assistants: own("public:").map((a) => ({ name: a.id, tokens: a.tokens })),
      months: all
        .filter((r) => /^\d{4}-\d{2}$/.test(r.key))
        .sort((a, b) => a.key.localeCompare(b.key))
        .slice(-12)
        .map((r) => ({ month: r.key, tokens: r.tokens })),
    };
  }

  /** Each member's tokens in a month, by user id. */
  async byUser(now = Date.now()): Promise<Record<string, number>> {
    const month = monthOf(now);
    const { rows } = await this.db.execute({ sql: "SELECT month, tokens FROM usage_months WHERE month LIKE 'user:%' AND month LIKE ?", args: [`%:${month}`] });
    return Object.fromEntries(rows.map((r) => [String(r.month).slice(5, -month.length - 1), Number(r.tokens)]));
  }
}
