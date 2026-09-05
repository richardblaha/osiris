import { describe, expect, it } from 'vitest';
import { CrewConfig } from '@richardblaha/protocol';
import { parseModelSpec, resolveProvider } from '../src/providers.js';

const config = CrewConfig.parse({
  lead: 'architect',
  defaultModel: 'vscode-lm/claude-sonnet-5',
  providers: { 'vscode-lm': { kind: 'vscode-lm' }, echo: { kind: 'echo' } },
});

describe('parseModelSpec', () => {
  it('splits provider/model', () => {
    expect(parseModelSpec('vscode-lm/claude-opus-5')).toEqual({
      provider: 'vscode-lm',
      model: 'claude-opus-5',
    });
    expect(parseModelSpec('echo')).toEqual({ provider: 'echo', model: '' });
  });
});

describe('resolveProvider — vscode-lm resolution chain', () => {
  it('1. uses an in-process editor bridge when present', () => {
    const bridge = {
      createAdapter: () => ({ id: 'vscode-lm-fake', generate: async function* () {} }),
    };
    const adapter = resolveProvider('vscode-lm/x', { config, vscodeLm: bridge, env: {} });
    expect(adapter.id).toBe('vscode-lm-fake');
  });

  it('2. falls back to the LM proxy via OSIRIS_LM_PROXY_URL', () => {
    const adapter = resolveProvider('vscode-lm/x', {
      config,
      env: { OSIRIS_LM_PROXY_URL: 'http://127.0.0.1:9/v1' },
    });
    expect(adapter.id).toBe('openai-compatible');
  });

  it('3. falls back to echo headlessly with no bridge or proxy', () => {
    const adapter = resolveProvider('vscode-lm/x', { config, env: {} });
    expect(adapter.id).toBe('echo');
  });
});
