import { createHmac } from "node:crypto";

/**
 * A visitor without a cookie or a stored IP: a keyed hash of the site, IP and browser, with a salt that changes every
 * day. The same person counts once per day; the next day they can't be linked. The salt is derived from a seed in a
 * Secret (so every replica agrees) and the date, and only today's is kept in memory.
 */
export class VisitorHasher {
  private salt?: { day: string; key: Buffer };

  constructor(
    private readonly seed: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (seed.length < 32) throw new Error("SALT_SEED must have at least 32 characters");
  }

  /** UInt64 as a decimal string (ClickHouse `toUInt64`). */
  hash(site: string, ip: string, userAgent: string): string {
    const day = this.now().toISOString().slice(0, 10);
    if (this.salt?.day !== day) this.salt = { day, key: createHmac("sha256", this.seed).update(day).digest() };
    const digest = createHmac("sha256", this.salt.key).update(`${site}\n${ip}\n${userAgent}`).digest();
    return digest.readBigUInt64BE(0).toString();
  }
}
