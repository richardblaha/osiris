import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/app.js';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };

let app: FastifyInstance;

beforeEach(() => {
  app = buildServer({ token: TOKEN, publicBaseUrl: 'http://osiris.test', leaseSweepMs: 0 });
});
afterEach(async () => {
  await app.close();
});

async function createSession() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    headers: auth,
    payload: { workspaceId: 'ws1', devcontainerHash: 'abc123' },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { sessionId: string; location: string };
}

describe('auth', () => {
  it('rejects requests without the bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sessions/x' });
    expect(res.statusCode).toBe(401);
  });
  it('allows /healthz unauthenticated', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});

describe('handover flow', () => {
  it('prepare → upload volume → commit → server', async () => {
    const { sessionId } = await createSession();

    const prep = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/handover/prepare`,
      headers: auth,
    });
    expect(prep.statusCode).toBe(200);
    const prepBody = prep.json() as { leaseEtag: string; volumeUploadUrl: string; registry: unknown };
    expect(prepBody.registry).toBeTruthy();
    expect(prep.headers.etag).toBe(prepBody.leaseEtag);

    const tar = Buffer.from('workspace-volume-bytes');
    const volumeDigest = `sha256:${createHash('sha256').update(tar).digest('hex')}`;
    const upload = await app.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${sessionId}/volume`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: tar,
    });
    expect(upload.statusCode).toBe(202);
    expect((upload.json() as { sha256: string }).sha256).toBe(volumeDigest);

    const digest = `sha256:${'a'.repeat(64)}`;
    const commit = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/handover/commit`,
      headers: { ...auth, 'if-match': prepBody.leaseEtag, 'idempotency-key': 'k1' },
      payload: {
        imageRef: 'registry.osiris.internal/workspaces/ws1:s1',
        imageDigest: digest,
        volumeDigest,
        agentStateDigest: digest,
        sha256: 'deadbeef',
      },
    });
    expect(commit.statusCode).toBe(200);
    expect(commit.json()).toEqual({ webUrl: `http://osiris.test/ide/${sessionId}`, location: 'server' });

    const after = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}`, headers: auth });
    const desc = after.json() as { location: string; lease: unknown; webUrl: string };
    expect(desc.location).toBe('server');
    expect(desc.lease).toBeNull();
    expect(desc.webUrl).toContain('/ide/');
  });

  it('rejects commit with a stale If-Match (409)', async () => {
    const { sessionId } = await createSession();
    await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/handover/prepare`,
      headers: auth,
    });
    const digest = `sha256:${'a'.repeat(64)}`;
    const commit = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/handover/commit`,
      headers: { ...auth, 'if-match': 'lease-stale' },
      payload: {
        imageRef: 'r/x:1',
        imageDigest: digest,
        volumeDigest: digest,
        agentStateDigest: digest,
        sha256: 'x',
      },
    });
    expect(commit.statusCode).toBe(409);
  });

  it('rejects a second concurrent prepare (409) and unknown sessions (404)', async () => {
    const { sessionId } = await createSession();
    await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/handover/prepare`, headers: auth });
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/handover/prepare`,
      headers: auth,
    });
    expect(again.statusCode).toBe(409);

    const missing = await app.inject({ method: 'GET', url: '/api/v1/sessions/nope', headers: auth });
    expect(missing.statusCode).toBe(404);
  });

  it('validates the request body (400)', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: auth,
      payload: { devcontainerHash: 'abc123' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('fetch flow', () => {
  it('moves a server session back to local', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: auth,
      payload: { workspaceId: 'ws1', devcontainerHash: 'abc123', origin: 'server' },
    });
    const { sessionId } = res.json() as { sessionId: string };

    const prep = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/fetch/prepare`,
      headers: auth,
    });
    expect(prep.statusCode).toBe(200);
    const { leaseEtag } = prep.json() as { leaseEtag: string; imageRef: string };

    const commit = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/fetch/commit`,
      headers: { ...auth, 'if-match': leaseEtag },
      payload: { volumeDigest: `sha256:${'a'.repeat(64)}`, agentStateDigest: `sha256:${'b'.repeat(64)}` },
    });
    expect(commit.statusCode).toBe(200);
    expect((commit.json() as { location: string }).location).toBe('local');
  });
});
