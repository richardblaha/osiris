/**
 * A per-key limit of `perMinute` over a sliding minute (two fixed windows, weighted). Per replica: with N gateway
 * replicas a user gets up to N times the limit, which is fine for stopping runaway clients and scripts.
 */
export class RateLimiter {
  private window = 0;
  private current = new Map<string, number>();
  private previous = new Map<string, number>();

  constructor(private readonly perMinute: number) {}

  take(key: string, now = Date.now()): boolean {
    const window = Math.floor(now / 60_000);
    if (window !== this.window) {
      this.previous = window === this.window + 1 ? this.current : new Map();
      this.current = new Map();
      this.window = window;
    }
    const elapsed = (now % 60_000) / 60_000;
    const estimate = (this.previous.get(key) ?? 0) * (1 - elapsed) + (this.current.get(key) ?? 0);
    if (estimate >= this.perMinute) return false;
    this.current.set(key, (this.current.get(key) ?? 0) + 1);
    return true;
  }
}
