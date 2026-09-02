import { watch } from 'node:fs';
import { createLogger } from '@osiris/shared-core';
import type { WorkspaceServices } from './workspace.js';

const log = createLogger('cli:watch');

/**
 * Watch `.osiris/memory/` and reindex (debounced) whenever a `.md` file changes.
 * Resolves only when `signal` aborts.
 */
export async function watchMemory(
  services: WorkspaceServices,
  options: {
    debounceMs?: number;
    signal?: AbortSignal;
    onReindex?: (summary: string) => void;
  } = {},
): Promise<void> {
  const debounceMs = options.debounceMs ?? 400;
  const dir = services.paths.memory;

  const first = await services.reindexMemory();
  options.onReindex?.(`indexed ${first.filesIndexed} file(s), ${first.chunksUpserted} chunk(s)`);

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let pending = false;

  const reindex = (): void => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    void services
      .reindexMemory()
      .then((r) => {
        options.onReindex?.(
          `${r.filesIndexed} changed, ${r.filesRemoved} removed, ${r.chunksUpserted} chunk(s), ${r.embeddingCalls} embed call(s)`,
        );
      })
      .catch((cause: unknown) => log.error('reindex failed: %s', (cause as Error).message))
      .finally(() => {
        running = false;
        if (pending) {
          pending = false;
          reindex();
        }
      });
  };

  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(dir, { recursive: true }, (_event, filename) => {
      if (filename && !String(filename).endsWith('.md')) return;
      clearTimeout(timer);
      timer = setTimeout(reindex, debounceMs);
    });
  } catch (cause) {
    throw new Error(`cannot watch ${dir}: ${(cause as Error).message}`);
  }

  log.info('watching %s', dir);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      clearTimeout(timer);
      watcher.close();
      resolve();
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
