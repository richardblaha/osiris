import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/app.js';

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spa-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>t</title>APP', 'utf8');
  await writeFile(join(dir, 'app.css'), 'body{}', 'utf8');
  app = buildServer({ token: '', publicBaseUrl: 'http://x', leaseSweepMs: 0, spaDir: dir });
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('SPA serving', () => {
  it('the server still becomes ready with a SPA dir', async () => {
    await expect(app.ready()).resolves.toBeDefined();
  });

  it('serves index.html at / and a real asset with its mime type', async () => {
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('APP');

    const css = await app.inject({ method: 'GET', url: '/app.css' });
    expect(css.headers['content-type']).toContain('text/css');
  });

  it('falls back to index.html for an unknown client route', async () => {
    const res = await app.inject({ method: 'GET', url: '/board/deep/link' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('APP');
  });

  it('does not shadow /healthz or the API', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/sessions/nope' })).statusCode).toBe(
      404,
    );
  });
});
