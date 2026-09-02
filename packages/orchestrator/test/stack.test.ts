import { describe, expect, it } from 'vitest';
import { defaultStack, stackModel } from '../src/stack.js';
import { DEFAULT_LOCAL_MODEL, DEFAULT_OLLAMA_IMAGE } from '../src/ollama.js';
import { toComposeDocument } from '../src/compose.js';
import { topoSort } from '../src/topo.js';

describe('defaultStack', () => {
  it('includes the collector, ollama and the sync worker', () => {
    const names = defaultStack().services.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['otel-collector', 'ollama', 'sync-worker']));
  });

  it('defaults to the Aspire dashboard and swaps to Jaeger on request', () => {
    const aspire = defaultStack().services.find((s) => s.name === 'otel-dashboard');
    const jaeger = defaultStack({ dashboard: 'jaeger' }).services.find(
      (s) => s.name === 'otel-dashboard',
    );
    expect(aspire?.image).toContain('aspire-dashboard');
    expect(jaeger?.image).toContain('jaeger');
  });

  it('produces a spec that topologically sorts (sync-worker after collector)', () => {
    const order = topoSort(defaultStack().services).map((s) => s.name);
    expect(order.indexOf('otel-collector')).toBeLessThan(order.indexOf('sync-worker'));
  });

  it('pins the Ollama image and records the model to pull', () => {
    const ollama = defaultStack().services.find((s) => s.name === 'ollama');
    expect(ollama?.image).toBe(DEFAULT_OLLAMA_IMAGE);
    expect(DEFAULT_OLLAMA_IMAGE).not.toMatch(/:0\.3\./); // predates Qwen3 + streamed tool calls
    expect(ollama?.env?.OSIRIS_LOCAL_MODEL).toBe(DEFAULT_LOCAL_MODEL);
    expect(stackModel(defaultStack())).toBe(DEFAULT_LOCAL_MODEL);
  });

  it('honours a custom model tag', () => {
    expect(stackModel(defaultStack({ model: 'qwen3:1.7b' }))).toBe('qwen3:1.7b');
  });
});

describe('toComposeDocument', () => {
  it('emits one service per spec entry on the shared network', () => {
    const doc = toComposeDocument(defaultStack({ dashboard: 'jaeger' }));
    expect(Object.keys(doc.services)).toContain('ollama');
    expect(doc.services.ollama?.networks).toEqual(['osiris-net']);
    expect(doc.networks['osiris-net']?.driver).toBe('bridge');
  });

  it('collects named volumes', () => {
    const doc = toComposeDocument(defaultStack());
    expect(doc.volumes).toBeDefined();
    expect(Object.keys(doc.volumes ?? {})).toEqual(
      expect.arrayContaining(['osiris-ollama', 'osiris-otelcol']),
    );
  });
});
