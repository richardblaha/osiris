import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace, osirisPaths } from '@richardblaha/dot-osiris';
import { loadAgentRegistry } from '../src/registry.js';
import { loadCrewConfig, expandEnv } from '../src/crew-config.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crew-'));
  await initWorkspace(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadAgentRegistry', () => {
  it('loads the bundled crew and lets a project file shadow it', async () => {
    const paths = osirisPaths(dir);
    let registry = await loadAgentRegistry(paths);
    expect(registry.list().map((a) => a.name)).toEqual([
      'architect',
      'implementer',
      'researcher',
      'reviewer',
    ]);

    await writeFile(
      paths.resolve('agents/architect.md'),
      '---\nname: architect\nrole: Overridden\n---\ncustom',
      'utf8',
    );
    registry = await loadAgentRegistry(paths);
    expect(registry.require('architect').role).toBe('Overridden');
  });

  it('skips an unparseable agent file instead of throwing', async () => {
    const paths = osirisPaths(dir);
    await writeFile(paths.resolve('agents/junk.md'), 'no frontmatter here', 'utf8');
    const registry = await loadAgentRegistry(paths);
    expect(registry.has('architect')).toBe(true);
    expect(registry.list()).toHaveLength(4);
  });
});

describe('loadCrewConfig', () => {
  it('parses the template config with defaults applied', async () => {
    const config = await loadCrewConfig(osirisPaths(dir), {});
    expect(config.lead).toBe('architect');
    expect(config.coordinator.maxDepth).toBe(3);
  });

  it('template taskModels honour OSIRIS_MODEL_* env, else the bundled default', async () => {
    const fallback = await loadCrewConfig(osirisPaths(dir), {});
    expect(fallback.taskModels.planning).toBe('vscode-lm/claude-opus-5');
    expect(fallback.taskModels.chat).toBe('ollama/qwen3:4b');
    expect(fallback.defaultModel).toBe('ollama/qwen3:4b');

    const overridden = await loadCrewConfig(osirisPaths(dir), {
      OSIRIS_MODEL_PLANNING: 'anthropic/claude-opus-5',
      OSIRIS_MODEL_DEFAULT: 'anthropic/claude-sonnet-5',
    });
    expect(overridden.taskModels.planning).toBe('anthropic/claude-opus-5');
    expect(overridden.defaultModel).toBe('anthropic/claude-sonnet-5');
  });

  it('template agents resolve their model by taskClass', async () => {
    const registry = await loadAgentRegistry(osirisPaths(dir));
    expect(registry.require('architect').taskClass).toBe('planning');
    expect(registry.require('implementer').taskClass).toBe('codegen');
    expect(registry.require('reviewer').taskClass).toBe('review');
    expect(registry.require('researcher').taskClass).toBe('research');
    expect(registry.require('architect').model).toBeUndefined();
  });

  it('expands ${ENV:-default}', () => {
    expect(expandEnv('${FOO:-bar}', {})).toBe('bar');
    expect(expandEnv('${FOO:-bar}', { FOO: 'set' })).toBe('set');
  });
});
