import type { Records } from "../projects/records.ts";

/** The calendar month (UTC) a time falls in, as `YYYY-MM`. */
export const monthOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

/** Whose tokens: a public assistant's or a member's. */
export interface UsageOwner {
  public?: string;
  user?: string;
}

/** One month's tokens: the project's, and by member and by public assistant. */
interface MonthUsage {
  tokens: number;
  users: Record<string, number>;
  assistants: Record<string, number>;
}

const EMPTY: MonthUsage = { tokens: 0, users: {}, assistants: {} };
const file = (month: string) => `private/usage/${month}.json`;

/** Tokens the project's agent used per calendar month (`private/usage/<YYYY-MM>.json`), checked against the quotas. */
export class UsageStore {
  constructor(private readonly records: Records) {}

  private async month(month: string): Promise<MonthUsage> {
    return { ...EMPTY, ...(await this.records.read<MonthUsage>(file(month))) };
  }

  /** Counts tokens for the project, and for the public assistant or the member who ran them. */
  async add(tokens: number, now = Date.now(), owner: UsageOwner = {}) {
    if (!(tokens > 0)) return;
    const n = Math.round(tokens);
    const month = monthOf(now);
    await this.records.update<MonthUsage>(file(month), (current) => {
      const u = { ...EMPTY, ...current, users: { ...current?.users }, assistants: { ...current?.assistants } };
      u.tokens += n;
      if (owner.public) u.assistants[owner.public] = (u.assistants[owner.public] ?? 0) + n;
      else if (owner.user) u.users[owner.user] = (u.users[owner.user] ?? 0) + n;
      return u;
    });
  }

  async tokens(now = Date.now(), owner: UsageOwner = {}): Promise<number> {
    const u = await this.month(monthOf(now));
    return owner.public ? (u.assistants[owner.public] ?? 0) : owner.user ? (u.users[owner.user] ?? 0) : u.tokens;
  }

  /** This month's tokens by member and by public assistant (most first), and the project's of the last 12 months. */
  async breakdown(now = Date.now()): Promise<{ users: { userId: string; tokens: number }[]; assistants: { name: string; tokens: number }[]; months: { month: string; tokens: number }[] }> {
    const u = await this.month(monthOf(now));
    const months = (await this.records.list("private/usage")).filter((n) => /^\d{4}-\d{2}\.json$/.test(n)).slice(-12);
    const most = <T extends { tokens: number }>(a: T[]) => a.sort((x, y) => y.tokens - x.tokens);
    return {
      users: most(Object.entries(u.users).map(([userId, tokens]) => ({ userId, tokens }))),
      assistants: most(Object.entries(u.assistants).map(([name, tokens]) => ({ name, tokens }))),
      months: await Promise.all(months.map(async (n) => ({ month: n.slice(0, 7), tokens: (await this.month(n.slice(0, 7))).tokens }))),
    };
  }

  /** Each member's tokens in a month, by user id. */
  async byUser(now = Date.now()): Promise<Record<string, number>> {
    return (await this.month(monthOf(now))).users;
  }
}
