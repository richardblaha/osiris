import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/app.js';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };

let app: FastifyInstance;

beforeEach(() => {
  app = buildServer({ token: TOKEN, publicBaseUrl: 'http://osiris.test' });
});
afterEach(async () => {
  await app.close();
});

async function createSession() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    headers: auth,
    payload: { projectName: 'demo' },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { sessionId: string; phase: string };
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

describe('session lifecycle', () => {
  it('creates a session that starts Running', async () => {
    const { sessionId, phase } = await createSession();
    expect(sessionId).toBeTruthy();
    expect(phase).toBe('Running');
  });

  it('validates the request body (400)', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: auth, payload: {} });
    expect(bad.statusCode).toBe(400);
  });

  it('gets a session and 404s for an unknown id', async () => {
    const { sessionId } = await createSession();
    const ok = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}`, headers: auth });
    expect(ok.statusCode).toBe(200);

    const missing = await app.inject({ method: 'GET', url: '/api/v1/sessions/nope', headers: auth });
    expect(missing.statusCode).toBe(404);
  });

  it('suspends and resumes a session', async () => {
    const { sessionId } = await createSession();

    const suspended = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/suspend`,
      headers: auth,
    });
    expect(suspended.statusCode).toBe(200);
    expect((suspended.json() as { phase: string }).phase).toBe('Suspended');

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/resume`,
      headers: auth,
    });
    expect(resumed.statusCode).toBe(200);
    expect((resumed.json() as { phase: string }).phase).toBe('Running');
  });

  it('reports activity (204)', async () => {
    const { sessionId } = await createSession();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/activity`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
  });

  it('deletes a session (204), after which it 404s', async () => {
    const { sessionId } = await createSession();
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/sessions/${sessionId}`, headers: auth });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}`, headers: auth });
    expect(after.statusCode).toBe(404);
  });
});
