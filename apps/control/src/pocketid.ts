/** PocketID admin API (`/api/...` with `X-API-KEY`), used only to import its users once (`pnpm users import-pocketid`). */
export class PocketIdClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const form = body instanceof FormData;
    const res = await this.fetchFn(new URL(path, this.base), {
      method,
      headers: { "x-api-key": this.apiKey, accept: "application/json", ...(body && !form ? { "content-type": "application/json" } : {}) },
      body: form ? body : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
      throw new PocketIdError(`PocketID ${method} ${path.split("?")[0]} failed: ${res.status}${detail ? ` (${detail})` : ""}`, res.status, detail);
    }
    return (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
  }

  get = <T>(path: string) => this.request<T>("GET", path);

  /** Every item of a paginated list endpoint. */
  async all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const { data, pagination } = await this.get<{ data: T[]; pagination?: { totalPages?: number } }>(
        `${path}${sep}pagination[page]=${page}&pagination[limit]=100`,
      );
      items.push(...data);
      if (!data.length || page >= (pagination?.totalPages ?? page)) return items;
    }
  }
}

export class PocketIdError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** PocketID's own error text, e.g. that a username or email is taken. */
    readonly detail?: string,
  ) {
    super(message);
  }
}

export interface PocketIdUser {
  id: string;
  username?: string;
  email?: string | null;
  firstName?: string;
  lastName?: string | null;
  locale?: string | null;
  isAdmin?: boolean;
  emailVerified?: boolean;
  displayName?: string;
  disabled?: boolean;
  customClaims?: { key: string; value: string }[];
}

export const displayName = (u: PocketIdUser) =>
  u.displayName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || null;
