/** A failed call between services, with the status and the callee's error message. */
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** JSON call to another Osiris service. Non-2xx answers throw `ServiceError` with the callee's `error` text. */
export async function callJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<T> {
  const { timeoutMs = 30_000, fetchFn = fetch, ...rest } = init;
  const res = await fetchFn(url, {
    ...rest,
    headers: { accept: "application/json", ...(rest.body && typeof rest.body === "string" ? { "content-type": "application/json" } : {}), ...rest.headers },
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ServiceError(body?.error ?? `${init.method ?? "GET"} ${new URL(url).pathname} failed: ${res.status}`, res.status);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Whether an error means the other side isn't there (connection refused, DNS, timeout), as opposed to an answer. */
export function isUnreachable(err: unknown): boolean {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  const code = e?.cause?.code ?? e?.code;
  return (
    e?.name === "TimeoutError" ||
    ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code ?? "")
  );
}

/** Repeats `fn` with exponential backoff until it succeeds or `deadline` (ms timestamp) passes. */
export async function retryUntil<T>(fn: () => Promise<T>, deadline: number, { minMs = 250, maxMs = 3000 } = {}): Promise<T> {
  let delay = minMs;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() + delay > deadline) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(maxMs, delay * 2);
    }
  }
}
