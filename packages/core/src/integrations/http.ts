import { NotConnectedError } from "./oauth.ts";

/** A provider's error, with its message for the model. */
export class ProviderError extends Error {}

export interface Api {
  get<T = unknown>(url: string, params?: Record<string, string | string[]>, headers?: Record<string, string>): Promise<T>;
  post<T = unknown>(url: string, body: unknown): Promise<T>;
  patch<T = unknown>(url: string, body: unknown, params?: Record<string, string>): Promise<T>;
}

const withParams = (url: string, params: Record<string, string | string[]> = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const value of Array.isArray(v) ? v : [v]) q.append(k, value);
  const s = q.toString();
  return s ? `${url}${url.includes("?") ? "&" : "?"}${s}` : url;
};

/** JSON calls with the account's bearer token; a provider's error becomes a ProviderError with its message. */
export function api(token: () => Promise<string>, fetchFn: typeof fetch = fetch): Api {
  const send = async <T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> => {
    const res = await fetchFn(url, {
      method,
      headers: {
        authorization: `Bearer ${await token()}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 202 || res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string; error_description?: string };
    if (!res.ok) {
      const message = typeof data.error === "string" ? (data.error_description ?? data.error) : data.error?.message;
      throw new ProviderError(`${res.status}: ${message ?? res.statusText}`);
    }
    return data as T;
  };
  return {
    get: (url, params, headers) => send("GET", withParams(url, params), undefined, headers),
    post: (url, body) => send("POST", url, body),
    patch: (url, body, params) => send("PATCH", withParams(url, params), body),
  };
}

/** Runs a tool's work and turns failures into a sentence for the model instead of failing the run. */
export async function guarded(action: () => Promise<string>): Promise<string> {
  try {
    return await action();
  } catch (err) {
    if (err instanceof NotConnectedError) return err.message;
    if (err instanceof ProviderError) return `Služba odmítla požadavek: ${err.message}`;
    return `Nepodařilo se: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Addresses from a comma- or semicolon-separated list. */
export const addressList = (value: string) =>
  value
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter(Boolean);

/** A header value as RFC 2047 encoded words when it isn't plain ASCII. */
export const encodeHeader = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

/** Readable text from an HTML mail body. */
export const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
