/** PocketID admin API (`/api/...` with `X-API-KEY`), used for what OIDC doesn't cover: users by phone, tenant groups. */
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
    const res = await this.fetchFn(new URL(path, this.base), {
      method,
      headers: { "x-api-key": this.apiKey, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new PocketIdError(`PocketID ${method} ${path.split("?")[0]} failed: ${res.status}`, res.status);
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
  ) {
    super(message);
  }
}

export interface PocketIdUser {
  id: string;
  username?: string;
  email?: string | null;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  disabled?: boolean;
  customClaims?: { key: string; value: string }[];
  userGroups?: { name: string }[];
}

export interface PocketIdGroup {
  id: string;
  name: string;
  friendlyName: string;
  userCount?: number;
  users?: PocketIdUser[];
}

export const displayName = (u: PocketIdUser) =>
  u.displayName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || null;
