import { describe, expect, it } from 'vitest';
import { TASK_CLASSES } from '@osiris/protocol';
import {
  buildExport,
  parseImport,
  parseSpec,
  secretKeysFor,
  taskClassStates,
  taskModelEnv,
  unsetTaskClasses,
  type ModelConfigReader,
} from '../src/model-config.js';

/** Minimal fake of vscode.WorkspaceConfiguration for `osiris.models`. */
function fakeCfg(values: Record<string, { user?: string; workspace?: string }>): ModelConfigReader {
  return {
    get<T>(section: string): T | undefined {
      const v = values[section];
      return ((v?.workspace ?? v?.user) as T) ?? undefined;
    },
    inspect<T>(section: string) {
      const v = values[section];
      return {
        globalValue: v?.user as T | undefined,
        workspaceValue: v?.workspace as T | undefined,
      };
    },
  };
}

describe('model-config', () => {
  it('parseSpec accepts <provider>/<model> and rejects the rest', () => {
    expect(parseSpec('anthropic/claude-sonnet-5')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    expect(parseSpec('ollama/qwen3:4b')?.model).toBe('qwen3:4b');
    expect(parseSpec('nope')).toBeUndefined();
    expect(parseSpec('')).toBeUndefined();
  });

  it('unsetTaskClasses reports classes with no value at any scope', () => {
    const cfg = fakeCfg({
      chat: { user: 'ollama/qwen3:4b' },
      planning: { workspace: 'anthropic/claude-opus-5' },
    });
    const unset = unsetTaskClasses(cfg);
    expect(unset).not.toContain('chat');
    expect(unset).not.toContain('planning');
    expect(unset.length).toBe(TASK_CLASSES.length - 2);
  });

  it('taskClassStates: workspace overrides user overrides default', () => {
    const cfg = fakeCfg({
      defaultProvider: { user: 'ollama/qwen3:1.7b' },
      chat: { user: 'anthropic/claude-haiku-4-5', workspace: 'ollama/qwen3:4b' },
      docs: { user: 'anthropic/claude-sonnet-5' },
    });
    const byId = Object.fromEntries(taskClassStates(cfg).map((s) => [s.id, s]));
    expect(byId.chat).toMatchObject({ spec: 'ollama/qwen3:4b', source: 'workspace' });
    expect(byId.docs).toMatchObject({ spec: 'anthropic/claude-sonnet-5', source: 'user' });
    expect(byId.review).toMatchObject({ spec: 'ollama/qwen3:1.7b', source: 'default' });
  });

  it('taskModelEnv emits OSIRIS_MODEL_* only for set classes', () => {
    const env = taskModelEnv(
      fakeCfg({
        planning: { user: 'anthropic/claude-opus-5' },
        codegen: { workspace: 'anthropic/claude-sonnet-5' },
        defaultProvider: { user: 'ollama/qwen3:4b' },
      }),
    );
    expect(env).toEqual({
      OSIRIS_MODEL_PLANNING: 'anthropic/claude-opus-5',
      OSIRIS_MODEL_CODEGEN: 'anthropic/claude-sonnet-5',
      OSIRIS_MODEL_DEFAULT: 'ollama/qwen3:4b',
    });
  });

  it('secretKeysFor maps specs to keychain env vars', () => {
    expect(
      secretKeysFor(['anthropic/claude-opus-5', 'ollama/qwen3:4b', 'openai-compatible/gpt-x']).sort(),
    ).toEqual(['ANTHROPIC_API_KEY', 'OSIRIS_AI_API_KEY']);
  });

  it('export/import round-trips and validates', () => {
    const cfg = fakeCfg({
      defaultProvider: { user: 'ollama/qwen3:4b' },
      planning: { user: 'anthropic/claude-opus-5' },
      chat: { workspace: 'ollama/qwen3:1.7b' },
    });
    const exported = buildExport(cfg);
    expect(exported).toEqual({
      version: 1,
      defaultProvider: 'ollama/qwen3:4b',
      models: { planning: 'anthropic/claude-opus-5', chat: 'ollama/qwen3:1.7b' },
    });
    expect(parseImport(exported)).toEqual(exported);
    expect(() => parseImport({ version: 2, models: {} })).toThrow(/version/);
    expect(() => parseImport({ version: 1, models: { planning: 'bad' } })).toThrow(/invalid spec/);
    expect(() => parseImport({ version: 1, models: { nope: 'a/b' } })).toThrow(/unknown task class/);
  });
});
