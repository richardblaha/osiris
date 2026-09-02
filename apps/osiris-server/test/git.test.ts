import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/app.js';
import { repoDirName } from '../src/git.js';

const run = promisify(execFile);
let app: FastifyInstance;
let reposDir: string;

beforeEach(async () => {
  reposDir = await mkdtemp(join(tmpdir(), 'osiris-git-'));
  await run('git', ['init', '--bare', join(reposDir, 'demo.git')]);
  app = buildServer({ token: 't', publicBaseUrl: 'http://osiris.test', leaseSweepMs: 0, gitReposDir: reposDir });
});
afterEach(async () => {
  await app.close();
});

describe('repoDirName', () => {
  it('normalises and rejects traversal', () => {
    expect(repoDirName('demo')).toBe('demo.git');
    expect(repoDirName('demo.git')).toBe('demo.git');
    expect(() => repoDirName('../etc')).toThrow();
    expect(() => repoDirName('a/b')).toThrow();
  });
});

describe('git smart-HTTP', () => {
  it('advertises refs for an existing repo without a bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/git/demo.git/info/refs?service=git-upload-pack',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-git-upload-pack-advertisement');
    expect(res.body).toContain('service=git-upload-pack');
  });

  it('404s an unknown repo on fetch', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/git/missing.git/info/refs?service=git-upload-pack',
    });
    expect(res.statusCode).toBe(404);
  });
});
