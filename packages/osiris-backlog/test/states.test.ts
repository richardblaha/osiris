import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverStates } from '../src/states.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'states-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('discoverStates', () => {
  it('keeps known states in canonical order and appends extras alphabetically', async () => {
    for (const s of ['done', 'todo', 'blocked', 'review', 'archive']) {
      await mkdir(join(dir, s));
    }
    expect(await discoverStates(dir)).toEqual(['todo', 'review', 'done', 'archive', 'blocked']);
  });

  it('falls back to the default set when empty', async () => {
    expect(await discoverStates(dir)).toEqual(['todo', 'in-progress', 'review', 'done']);
  });
});
