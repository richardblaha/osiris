import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseContentRange, uploadVolumeResumable } from '../src/resumable.js';

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield Buffer.from(p);
}

describe('parseContentRange', () => {
  it('parses a known and an open-ended total', () => {
    expect(parseContentRange('bytes 0-511/1024')).toEqual({ start: 0, end: 511, total: 1024 });
    expect(parseContentRange('bytes 512-1023/*')).toEqual({ start: 512, end: 1023, total: undefined });
  });
  it('rejects junk', () => {
    expect(parseContentRange('nonsense')).toBeUndefined();
    expect(parseContentRange(undefined)).toBeUndefined();
  });
});

describe('uploadVolumeResumable', () => {
  it('splits into Content-Range chunks and hashes the whole stream', async () => {
    const seen: { range: string; len: number }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const body = init.body as Buffer;
      seen.push({ range: headers.get('content-range') ?? '', len: body.length });
      const isFinal = !(headers.get('content-range') ?? '').endsWith('/*');
      return new Response(null, { status: isFinal ? 202 : 308 });
    }) as unknown as typeof fetch;

    const payload = 'abcdefghij'; // 10 bytes
    const result = await uploadVolumeResumable('http://s/up', chunks('abcde', 'fghij'), {
      token: 't',
      chunkSize: 4,
      fetchImpl,
    });

    expect(result).toEqual({
      sha256: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
      bytes: 10,
    });
    // 4 + 4 + 2, last one carries the real total
    expect(seen.map((s) => s.len)).toEqual([4, 4, 2]);
    expect(seen[0]?.range).toBe('bytes 0-3/*');
    expect(seen[2]?.range).toBe('bytes 8-9/10');
  });

  it('throws on a non-2xx/308 status', async () => {
    const fetchImpl = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    await expect(
      uploadVolumeResumable('http://s/up', chunks('x'), { token: 't', fetchImpl }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
