import { describe, expect, it } from 'vitest';
import { SessionClient, SessionHttpError } from '../src/client.js';

interface Route {
  status?: number;
  json?: unknown;
  text?: string;
}

function stubFetch(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(String(url)).pathname}`;
    calls.push({ url: String(url), init });
    const route = routes[key] ?? { status: 404, text: 'no stub' };
    const status = route.status ?? 200;
    const bodyAllowed = status !== 204 && status !== 205 && status !== 304;
    const body = bodyAllowed
      ? route.json === undefined
        ? (route.text ?? '')
        : JSON.stringify(route.json)
      : null;
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const descriptor = {
  sessionId: 's1',
  schemaVersion: 2,
  projectName: 'demo',
  phase: 'Running',
  idleTimeoutSeconds: 300,
  lastActivityAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('SessionClient', () => {
  it('creates a session and parses the descriptor', async () => {
    const { impl } = stubFetch({ 'POST /api/v1/sessions': { json: descriptor } });
    const client = new SessionClient({
      baseUrl: 'https://osiris.test/',
      token: 't',
      fetchImpl: impl,
    });
    const session = await client.createSession({ projectName: 'demo' });
    expect(session.sessionId).toBe('s1');
    expect(session.phase).toBe('Running');
  });

  it('suspends and resumes a session', async () => {
    const { impl, calls } = stubFetch({
      'POST /api/v1/sessions/s1/suspend': { json: { ...descriptor, phase: 'Suspended' } },
      'POST /api/v1/sessions/s1/resume': { json: { ...descriptor, phase: 'Resuming' } },
    });
    const client = new SessionClient({
      baseUrl: 'https://osiris.test',
      token: 't',
      fetchImpl: impl,
    });

    const suspended = await client.suspendSession('s1');
    expect(suspended.phase).toBe('Suspended');

    const resumed = await client.resumeSession('s1');
    expect(resumed.phase).toBe('Resuming');

    expect(calls.map((c) => c.url)).toEqual([
      'https://osiris.test/api/v1/sessions/s1/suspend',
      'https://osiris.test/api/v1/sessions/s1/resume',
    ]);
  });

  it('reports activity and deletes a session', async () => {
    const { impl, calls } = stubFetch({
      'POST /api/v1/sessions/s1/activity': { status: 204 },
      'DELETE /api/v1/sessions/s1': { status: 204 },
    });
    const client = new SessionClient({
      baseUrl: 'https://osiris.test',
      token: 't',
      fetchImpl: impl,
    });

    await client.reportActivity('s1');
    await client.deleteSession('s1');

    expect(calls[0].init.method).toBe('POST');
    expect(calls[1].init.method).toBe('DELETE');
  });

  it('throws SessionHttpError with the status on failure', async () => {
    const { impl } = stubFetch({ 'GET /api/v1/sessions/s1': { status: 404, text: 'not found' } });
    const client = new SessionClient({
      baseUrl: 'https://osiris.test',
      token: 't',
      fetchImpl: impl,
    });
    await expect(client.getSession('s1')).rejects.toMatchObject({ status: 404 });
    await expect(client.getSession('s1')).rejects.toBeInstanceOf(SessionHttpError);
  });
});
