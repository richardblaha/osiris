import { describe, expect, it } from 'vitest';
import { isLeaseExpired, leaseExpiresAt, newLeaseEtag } from '../src/lease.js';
import { formatSseEvent } from '../src/sse.js';

describe('lease helpers', () => {
  it('mints unique etags', () => {
    expect(newLeaseEtag()).not.toBe(newLeaseEtag());
    expect(newLeaseEtag()).toMatch(/^lease-/);
  });

  it('computes and checks expiry', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const expires = leaseExpiresAt(now, 60_000);
    expect(isLeaseExpired(expires, now)).toBe(false);
    expect(isLeaseExpired(expires, now + 60_001)).toBe(true);
    expect(isLeaseExpired('not-a-date')).toBe(true);
  });
});

describe('formatSseEvent', () => {
  it('renders an event frame', () => {
    const frame = formatSseEvent({ type: 'lease.expired', sessionId: 's1' });
    expect(frame).toBe('event: lease.expired\ndata: {"type":"lease.expired","sessionId":"s1"}\n\n');
  });
});
