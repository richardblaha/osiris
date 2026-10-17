import { isUnreachable, retryUntil } from "./http.ts";

export interface RuntimeLocator {
  /** Base URL of the tenant's runtime. */
  endpoint(tenant: string): Promise<string>;
  /** Asks for the runtime to be started; returns before it is up. */
  wake(tenant: string): Promise<void>;
}

/** A runtime that is shutting down for sleep answers 503 with this header; the caller wakes it and retries. */
export const SLEEPING_HEADER = "x-osiris-sleeping";

/**
 * Calls a tenant runtime, waking it when it sleeps (scale-to-zero): if it can't be reached, asks for a wake-up, waits
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

  async request(tenant: string, path: string, init: RequestInit = {}): Promise<Response> {
    const base = await this.locator.endpoint(tenant);
    try {
      const res = await this.fetchFn(base + path, init);
      if (!(res.status === 503 && res.headers.has(SLEEPING_HEADER))) return res;
      await res.body?.cancel();
    } catch (err) {
      if (!isUnreachable(err) || init.signal?.aborted) throw err;
    }
    await this.ready(tenant, base);
    return this.fetchFn(base + path, init);
  }

  /** Wakes the runtime and resolves once it answers `/health`. */
  async ready(tenant: string, base?: string): Promise<void> {
    const url = `${base ?? (await this.locator.endpoint(tenant))}/health`;
    await this.locator.wake(tenant);
    await retryUntil(
      async () => {
        const res = await this.fetchFn(url, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error(`Runtime of ${tenant} not ready: ${res.status}`);
      },
      Date.now() + (this.options.wakeTimeoutMs ?? 120_000),
      { minMs: 500, maxMs: 2000 },
    );
  }
}
