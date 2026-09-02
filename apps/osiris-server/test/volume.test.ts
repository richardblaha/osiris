import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/app.js';
import { FileVolumeStore, InMemoryVolumeStore } from '../src/executors.js';

const auth = { authorization: 'Bearer t' };
let app: FastifyInstance;

beforeEach(() => {
  app = buildServer({ token: 't', publicBaseUrl: 'http://osiris.test', leaseSweepMs: 0 });
});
afterEach(async () => {
  await app.close();
});

async function newSession() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    headers: auth,
    payload: { workspaceId: 'ws1', devcontainerHash: 'abc123' },
  });
  return (res.json() as { sessionId: string }).sessionId;
}

describe('resumable volume upload', () => {
  it('assembles Content-Range chunks and returns the digest', async () => {
    const id = await newSession();
    const full = Buffer.from('0123456789abcdef'); // 16 bytes
    const digest = `sha256:${createHash('sha256').update(full).digest('hex')}`;

    const c1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${id}/volume`,
      headers: { ...auth, 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-7/*' },
      payload: full.subarray(0, 8),
    });
    expect(c1.statusCode).toBe(308);

    const c2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${id}/volume`,
      headers: { ...auth, 'content-type': 'application/octet-stream', 'content-range': 'bytes 8-15/16' },
      payload: full.subarray(8),
    });
    expect(c2.statusCode).toBe(202);
    expect(c2.json()).toEqual({ sha256: digest, bytes: 16 });

    const download = await app.inject({ method: 'GET', url: `/api/v1/sessions/${id}/volume`, headers: auth });
    expect(download.rawPayload.equals(full)).toBe(true);
  });

  it('still accepts a single whole-object PUT', async () => {
    const id = await newSession();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${id}/volume`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('whole'),
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { bytes: number }).bytes).toBe(5);
  });
});

describe('FileVolumeStore', () => {
  it('writes chunks at their offset and digests the assembled file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'osiris-vol-'));
    const store = new FileVolumeStore(dir);
    await store.write('s1', 4, Buffer.from('EFGH'));
    await store.write('s1', 0, Buffer.from('ABCD'));
    const { sha256, bytes } = await store.finalize('s1');

    expect(bytes).toBe(8);
    expect(sha256).toBe(`sha256:${createHash('sha256').update('ABCDEFGH').digest('hex')}`);
    expect(await readFile(join(dir, 's1.tar'), 'utf8')).toBe('ABCDEFGH');
  });
});

describe('InMemoryVolumeStore', () => {
  it('round-trips through read()', async () => {
    const store = new InMemoryVolumeStore();
    await store.write('s1', 0, Buffer.from('hello'));
    await store.finalize('s1');
    const parts: Buffer[] = [];
    for await (const chunk of await store.read('s1')) parts.push(Buffer.from(chunk));
    expect(Buffer.concat(parts).toString()).toBe('hello');
  });
});
