import { describe, expect, it } from 'vitest';
import { OSIRIS_SUBDIRS, OsirisPaths, osirisPaths } from '../src/layout.js';

describe('OsirisPaths', () => {
  const p = osirisPaths('/work/proj');

  it('roots everything at <root>/.osiris', () => {
    expect(p.dir).toBe('/work/proj/.osiris');
    expect(p.agents).toBe('/work/proj/.osiris/agents');
    expect(p.backlog).toBe('/work/proj/.osiris/backlog');
    expect(p.temp).toBe('/work/proj/.osiris/temp');
  });

  it('resolves config files and arbitrary relatives', () => {
    expect(p.configFile('crew.json')).toBe('/work/proj/.osiris/crew.json');
    expect(p.resolve('agents/architect.md')).toBe('/work/proj/.osiris/agents/architect.md');
    expect(p.tempFile('backlog-worktree', 'x')).toBe(
      '/work/proj/.osiris/temp/backlog-worktree/x',
    );
  });

  it('exposes every declared subdir', () => {
    for (const sub of OSIRIS_SUBDIRS) {
      expect(new OsirisPaths('/r').subdir(sub)).toBe(`/r/.osiris/${sub}`);
    }
  });
});
