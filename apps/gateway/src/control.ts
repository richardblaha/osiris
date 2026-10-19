import { callJson } from "@osiris/platform/http.ts";
import { CONTROL_AUDIENCE, type InternalSigner } from "@osiris/platform/internal-auth.ts";
import type { RuntimeLocator } from "@osiris/platform/runtime-client.ts";
import type { TokenOwner } from "./oidc.ts";

const TENANTS_TTL_MS = 30_000;

/** The gateway's own questions to control: whose a token is, which tenants exist, where a tenant's runtime is, and wake it up. */
export class ControlDirectory implements RuntimeLocator {
  private tenants?: { at: number; list: Promise<{ id: string; name: string }[]> };
  private lastForced = 0;
  private readonly endpoints = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly signer: InternalSigner,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
    return callJson<T>(`${this.baseUrl}/internal/gateway${path}`, {
      ...init,
      headers: { authorization: await this.signer.header(CONTROL_AUDIENCE) },
      fetchFn: this.fetchFn,
    });
  }

  /**
   * Active tenants, cached briefly; a failed load isn't cached. `refresh` reloads at once (at most every few seconds),
   * for a user whose claims name a tenant created after the cache was filled.
   */
  list({ refresh = false } = {}): Promise<{ id: string; name: string }[]> {
    const forced = refresh && Date.now() - this.lastForced > 5_000;
    if (forced) this.lastForced = Date.now();
    if (forced || !this.tenants || Date.now() - this.tenants.at > TENANTS_TTL_MS) {
      const list = this.call<{ id: string; name: string }[]>("/tenants");
      list.catch(() => {
        if (this.tenants?.list === list) this.tenants = undefined;
      });
      this.tenants = { at: Date.now(), list };
    }
    return this.tenants.list;
  }

  /** The user an access token belongs to; `ServiceError` 401 for an unknown or expired token. */
  identify = (token: string) => this.call<TokenOwner>("/identify", { method: "POST", body: JSON.stringify({ token }), timeoutMs: 10_000 });

  async endpoint(tenant: string) {
    let url = this.endpoints.get(tenant);
    if (!url) {
      url = (await this.call<{ url: string }>(`/tenants/${encodeURIComponent(tenant)}/endpoint`)).url;
      this.endpoints.set(tenant, url);
    }
    return url;
  }

  async wake(tenant: string) {
    await this.call<void>(`/tenants/${encodeURIComponent(tenant)}/wake`, { method: "POST" });
  }
}
