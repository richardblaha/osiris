import { randomUUID } from 'node:crypto';

/** How long a transfer lease is valid before the server auto-aborts an incomplete move. */
export const LEASE_TTL_MS = 10 * 60_000;

export function newLeaseEtag(): string {
  return `lease-${randomUUID()}`;
}

export function leaseExpiresAt(now: number = Date.now(), ttlMs: number = LEASE_TTL_MS): string {
  return new Date(now + ttlMs).toISOString();
}

export function isLeaseExpired(expiresAt: string, now: number = Date.now()): boolean {
  const parsed = Date.parse(expiresAt);
  return Number.isNaN(parsed) || parsed <= now;
}
