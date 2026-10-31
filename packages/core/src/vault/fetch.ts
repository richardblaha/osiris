import { assertSafePublicUrl } from "../mcp/url.ts";
import { redact, templateHost } from "./template.ts";
import type { SecretVault } from "./vault.ts";

export interface SecretRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface SecretResponse {
  status: number;
  headers: Record<string, string>;
  /** The body, cut at `maxChars`, with the secrets it used masked. */
  text: string;
  truncated: boolean;
}

export interface SecretFetchOptions {
  userId: string;
  /** Development only: allow http and private addresses. */
  allowPrivate?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxChars?: number;
}

/**
 * One https request with `{{secret:NAME}}` in its URL, headers or body filled on the server (only for the secret's
 * allowed hosts, never in the scheme or host), to public addresses only, without following redirects (a token is never
 * bounced elsewhere). The answer has the secrets masked. Throws `SecretUseError` or `UnsafeUrlError` when refused.
 */
export async function fetchWithSecrets(vault: SecretVault, req: SecretRequest, options: SecretFetchOptions): Promise<SecretResponse> {
  const { allowPrivate = false, fetch: f = fetch, timeoutMs = 20_000, maxChars = 20_000 } = options;
  const headers = req.headers ?? {};
  let used: string[] = [];
  try {
    const host = templateHost(req.url);
    const texts: Record<string, string> = { url: req.url, body: req.body ?? "" };
    for (const [k, v] of Object.entries(headers)) texts[`h:${k}`] = v;
    const result = await vault.fill(texts, { userId: options.userId, host });
    used = result.used;
    const target = await assertSafePublicUrl(result.filled.url!, { allowPrivate });
    const res = await f(target, {
      method: req.method,
      headers: Object.fromEntries(Object.keys(headers).map((k) => [k, result.filled[`h:${k}`]!])),
      body: req.body === undefined || req.method === "GET" || req.method === "HEAD" ? undefined : result.filled.body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const full = await res.text();
    const truncated = full.length > maxChars;
    return {
      status: res.status,
      headers: Object.fromEntries([...res.headers].map(([k, v]) => [k, redact(v, used)])),
      text: redact(truncated ? full.slice(0, maxChars) : full, used),
      truncated,
    };
  } catch (err) {
    // A message may quote the filled URL; the secrets in it never leave.
    if (err instanceof Error && used.length) err.message = redact(err.message, used);
    throw err;
  }
}
