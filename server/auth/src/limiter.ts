/**
 * Counts failed sign-in attempts per key (account, client address, interaction) in a sliding window and blocks a key
 * after too many. Per replica by design, like the gateway's rate limits.
 */
export class AttemptLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private recent(key: string, now: number) {
    const list = (this.failures.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  blocked(keys: string[], now = Date.now()) {
    return keys.some((k) => this.recent(k, now).length >= this.max);
  }

  fail(keys: string[], now = Date.now()) {
    for (const k of keys) this.failures.set(k, [...this.recent(k, now), now]);
    if (this.failures.size > 10_000) {
      for (const k of [...this.failures.keys()].slice(0, 1_000)) this.failures.delete(k);
    }
  }

  reset(keys: string[]) {
    for (const k of keys) this.failures.delete(k);
  }
}
