import { describe, expect, it, vi } from 'vitest';
import { ensureOllamaModel, type PullProgress } from '../src/ollama.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ndjsonResponse(lines: unknown[], status = 200): Response {
  return new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(''), { status });
}

describe('ensureOllamaModel', () => {
  it('is a no-op when the model is already present', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/tags');
      return jsonResponse({ models: [{ name: 'qwen3:4b' }, { name: 'nomic-embed-text:latest' }] });
    }) as unknown as typeof fetch;

    const result = await ensureOllamaModel('qwen3:4b', { fetchImpl });
    expect(result).toEqual({ pulled: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('matches an implicit :latest tag', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ models: [{ name: 'nomic-embed-text:latest' }] }),
    ) as unknown as typeof fetch;

    expect(await ensureOllamaModel('nomic-embed-text', { fetchImpl })).toEqual({ pulled: false });
  });

  it('pulls the model and reports progress when missing', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [] });
      expect(url).toContain('/api/pull');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'qwen3:4b', stream: true });
      return ndjsonResponse([
        { status: 'pulling manifest' },
        { status: 'pulling 2af3b81862c6', total: 1000, completed: 250 },
        { status: 'pulling 2af3b81862c6', total: 1000, completed: 1000 },
        { status: 'verifying sha256 digest' },
        { status: 'success' },
      ]);
    }) as unknown as typeof fetch;

    const progress: PullProgress[] = [];
    const result = await ensureOllamaModel('qwen3:4b', {
      fetchImpl,
      progressIntervalMs: 0,
      onProgress: (p) => progress.push(p),
    });

    expect(result).toEqual({ pulled: true });
    expect(calls).toEqual([
      'http://localhost:11434/api/tags',
      'http://localhost:11434/api/pull',
    ]);
    expect(progress.map((p) => p.status)).toEqual([
      'pulling manifest',
      'pulling 2af3b81862c6',
      'pulling 2af3b81862c6',
      'verifying sha256 digest',
      'success',
    ]);
    expect(progress[2]?.fraction).toBe(1);
  });

  it('honours a custom base URL', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url.startsWith('http://host.docker.internal:11434/')).toBe(true);
      return jsonResponse({ models: [{ name: 'qwen3:4b' }] });
    }) as unknown as typeof fetch;

    await ensureOllamaModel('qwen3:4b', { fetchImpl, baseUrl: 'http://host.docker.internal:11434/' });
  });

  it('throws when /api/tags is unreachable', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503)) as unknown as typeof fetch;
    await expect(ensureOllamaModel('qwen3:4b', { fetchImpl })).rejects.toThrow(/HTTP 503/);
  });

  it('surfaces an error chunk from the pull stream', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [] });
      return ndjsonResponse([{ status: 'pulling manifest' }, { error: 'file does not exist' }]);
    }) as unknown as typeof fetch;

    await expect(ensureOllamaModel('bogus:model', { fetchImpl })).rejects.toThrow(
      /file does not exist/,
    );
  });
});
