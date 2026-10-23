import { isUnreachable, retryUntil } from "./http.ts";

export interface RuntimeLocator {
  /** Base URL of the project's runtime. */
  endpoint(project: string): Promise<string>;
  /** Asks for the runtime to be started; returns before it is up. */
  wake(project: string): Promise<void>;
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
    const base = await this.locator.endpoint(project);
    try {
      const res = await this.fetchFn(base + path, init);
      if (!(res.status === 503 && res.headers.has(SLEEPING_HEADER))) return res;
      await res.body?.cancel();
    } catch (err) {
      if (!isUnreachable(err) || init.signal?.aborted) throw err;
    }
    await this.ready(project, base);
    return this.fetchFn(base + path, init);
  }

  /** Wakes the runtime and resolves once it answers `/health`. */
  async ready(project: string, base?: string): Promise<void> {
    const url = `${base ?? (await this.locator.endpoint(project))}/health`;
    await this.locator.wake(project);
    await retryUntil(
      async () => {
        const res = await this.fetchFn(url, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error(`Runtime of ${project} not ready: ${res.status}`);
      },
      Date.now() + (this.options.wakeTimeoutMs ?? 120_000),
      { minMs: 500, maxMs: 2000 },
    );
  }
}
