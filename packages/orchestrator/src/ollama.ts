import { createLogger } from '@osiris/shared-core';

const log = createLogger('orchestrator:ollama');

/**
 * Ollama server image. Pinned to a release recent enough for Qwen3 and streamed
 * tool-call parsing — the `0.3.x` line predates both. Bump deliberately.
 */
export const DEFAULT_OLLAMA_IMAGE = 'ollama/ollama:0.33.2';

/**
 * Chat model auto-pulled on first `up`. Qwen3 4B (Apache-2.0), ~2.6 GB at
 * Q4_K_M: small enough to ship with the install, capable enough for Osiris
 * orchestration and features like the backlog. Override via `defaultStack({ model })`
 * or the `OSIRIS_LOCAL_MODEL` env var.
 */
export const DEFAULT_LOCAL_MODEL = 'qwen3:4b';

export interface PullProgress {
  /** Ollama status line, e.g. `pulling manifest`, `pulling <digest>`, `verifying sha256 digest`. */
  status: string;
  /** 0–1 while a layer reports byte counts. */
  fraction?: number;
  completed?: number;
  total?: number;
}

export interface EnsureModelOptions {
  /** Ollama base URL (default `http://localhost:11434`). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: PullProgress) => void;
  /** Minimum gap between `onProgress` calls for an unchanged status (default 800 ms). */
  progressIntervalMs?: number;
}

interface OllamaTagsResponse {
  models?: { name?: string; model?: string }[];
}

interface OllamaPullChunk {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

function hasModel(tags: OllamaTagsResponse, model: string): boolean {
  const wanted = model.includes(':') ? model : `${model}:latest`;
  return (tags.models ?? []).some(
    (m) => m.name === wanted || m.model === wanted || m.name === model || m.model === model,
  );
}

/**
 * Ensure `model` is present in the local Ollama library, pulling it if not.
 *
 * Idempotent and cheap when it is already there (a single `GET /api/tags`). The
 * blob cache lives in the `osiris-ollama` volume, so a pull happens once per
 * install and survives container recreation.
 */
export async function ensureOllamaModel(
  model: string,
  options: EnsureModelOptions = {},
): Promise<{ pulled: boolean }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
  const interval = options.progressIntervalMs ?? 800;

  const tagsRes = await fetchImpl(`${baseUrl}/api/tags`, { signal: options.signal });
  if (!tagsRes.ok) {
    throw new Error(`ollama GET /api/tags: HTTP ${tagsRes.status}`);
  }
  const tags = (await tagsRes.json()) as OllamaTagsResponse;
  if (hasModel(tags, model)) {
    log.debug('model %s already present', model);
    return { pulled: false };
  }

  log.info('pulling model %s …', model);
  const response = await fetchImpl(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, name: model, stream: true }),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`ollama POST /api/pull: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastStatus = '';
  let lastEmitAt = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let chunk: OllamaPullChunk;
      try {
        chunk = JSON.parse(trimmed) as OllamaPullChunk;
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(`ollama pull failed: ${chunk.error}`);

      const status = chunk.status ?? '';
      if (!status) continue;
      const fraction =
        chunk.total && chunk.completed !== undefined ? chunk.completed / chunk.total : undefined;
      const now = Date.now();
      if (status !== lastStatus || now - lastEmitAt >= interval) {
        lastStatus = status;
        lastEmitAt = now;
        options.onProgress?.({ status, fraction, completed: chunk.completed, total: chunk.total });
      }
    }
  }

  log.info('model %s ready', model);
  return { pulled: true };
}
