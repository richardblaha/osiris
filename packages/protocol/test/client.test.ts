import { describe, expect, it } from 'vitest';
import { HandoverClient, HandoverHttpError } from '../src/client.js';

const digest = `sha256:${'a'.repeat(64)}`;

interface Route {
  status?: number;
  json?: unknown;
  text?: string;
  etag?: string;
}

function stubFetch(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    const key = `${(init.method ?? 'GET')} ${new URL(String(url)).pathname}`;
    calls.push({ url: String(url), init });
    const route = routes[key] ?? { status: 404, text: 'no stub' };
    const headers = new Headers();
    if (route.etag) headers.set('ETag', route.etag);
    return new Response(route.json === undefined ? (route.text ?? '') : JSON.stringify(route.json), {
      status: route.status ?? 200,
      headers,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('HandoverClient', () => {
  it('creates a session and parses the descriptor', async () => {
    const { impl } = stubFetch({
      'POST /api/v1/sessions': {
        json: {
          sessionId: 's1',
          schemaVersion: 1,
          location: 'local',
          origin: 'desktop',
          workspaceId: 'ws1',
          devcontainerHash: 'abc123',
          lease: null,
        },
      },
    });
    const client = new HandoverClient({ baseUrl: 'https://osiris.test/', token: 't', fetchImpl: impl });
    const session = await client.createSession({ workspaceId: 'ws1', devcontainerHash: 'abc123' });
    expect(session.sessionId).toBe('s1');
  });

  it('captures the lease from prepare and sends it as If-Match on commit', async () => {
    const { impl, calls } = stubFetch({
      'POST /api/v1/sessions/s1/handover/prepare': {
        json: {
          leaseEtag: 'lease-1',
          registry: { url: 'r', repository: 'workspaces/ws1', token: 'rt' },
          volumeUploadUrl: 'https://osiris.test/upload/1',
          expiresAt: '2026-01-01T00:00:00Z',
        },
        etag: 'lease-1',
      },
      'POST /api/v1/sessions/s1/handover/commit': {
        json: { webUrl: 'https://osiris.test/ide/s1', location: 'server' },
      },
    });
    const client = new HandoverClient({ baseUrl: 'https://osiris.test', token: 't', fetchImpl: impl });

    const prep = await client.prepareHandover('s1');
    expect(prep.registry.repository).toBe('workspaces/ws1');
    expect(client.leaseEtag).toBe('lease-1');

    const commit = await client.commitHandover(
      's1',
      { imageRef: 'r/x:1', imageDigest: digest, volumeDigest: digest, agentStateDigest: digest, sha256: 'x' },
      'idem-1',
    );
    expect(commit.webUrl).toContain('/ide/s1');

    const commitCall = calls.find((c) => c.url.endsWith('handover/commit'));
    const sent = new Headers(commitCall?.init.headers);
    expect(sent.get('If-Match')).toBe('lease-1');
    expect(sent.get('Idempotency-Key')).toBe('idem-1');
  });

  it('throws HandoverHttpError with the status on failure', async () => {
    const { impl } = stubFetch({
      'POST /api/v1/sessions/s1/handover/prepare': { status: 409, text: 'stale lease' },
    });
    const client = new HandoverClient({ baseUrl: 'https://osiris.test', token: 't', fetchImpl: impl });
    await expect(client.prepareHandover('s1')).rejects.toMatchObject({ status: 409 });
    await expect(client.prepareHandover('s1')).rejects.toBeInstanceOf(HandoverHttpError);
  });
});
