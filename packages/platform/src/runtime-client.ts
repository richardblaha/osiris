import { isUnreachable, retryUntil } from "./http.ts";

export interface RuntimeLocator {
  /** Base URL of the project's runtime. */
  endpoint(project: string): Promise<string>;
  /** Asks for the runtime to be started; returns before it is up. */
  wake(project: string): Promise<void>;
  /** Forgets a cached endpoint (the runtime may have moved); the next `endpoint` resolves it again. */
  invalidate?(project: string): void;
}

/** A runtime that is shutting down for sleep answers 503 with this header; the caller wakes it and retries. */
export const SLEEPING_HEADER = "x-osiris-sleeping";

/**
 * Calls a project runtime, waking it when it sleeps (scale-to-zero): if it can't be reached, asks for a wake-up, waits
 * until `/health` answers and sends the request again. The body must therefore be repeatable (string or bytes).
 */
export class RuntimeClient {
  constructor(
    private readonly locator: RuntimeLocator,
    private readonly options: { wakeTimeoutMs?: number; fetchFn?: typeof fetch } = {},
  ) {}

  private get fetchFn() {
    return this.options.fetchFn ?? fetch;
  }

  async request(project: string, path: string, init: RequestInit = {}): Promise<Response> {
    let base = await this.locator.endpoint(project);
    try {
      const res = await this.fetchFn(base + path, init);
      if (!(res.status === 503 && res.headers.has(SLEEPING_HEADER))) return res;
      await res.body?.cancel();
    } catch (err) {
      if (!isUnreachable(err) || init.signal?.aborted) throw err;
    }
    // The runtime slept or moved (restarted on another port, rescheduled): drop the cached endpoint and resolve
    // where it is now before sending the request again.
    this.locator.invalidate?.(project);
    base = await this.ready(project);
    return this.fetchFn(base + path, init);
  }

  /** Wakes the runtime, resolves its current base URL and waits until it answers `/health`; returns that URL. */
  async ready(project: string): Promise<string> {
    await this.locator.wake(project);
    const base = await this.locator.endpoint(project);
    await retryUntil(
      async () => {
        const res = await this.fetchFn(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error(`Runtime of ${project} not ready: ${res.status}`);
      },
      Date.now() + (this.options.wakeTimeoutMs ?? 120_000),
      { minMs: 500, maxMs: 2000 },
    );
    return base;
  }
}
