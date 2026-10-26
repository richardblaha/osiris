import { callJson } from "@osiris/platform/http.ts";
import { CONTROL_AUDIENCE, type InternalSigner } from "@osiris/platform/internal-auth.ts";
import type { RuntimeLocator } from "@osiris/platform/runtime-client.ts";

const PROJECTS_TTL_MS = 30_000;

/** The gateway's own questions to control: which projects exist, where a project's runtime is, and wake it up. */
export class ControlDirectory implements RuntimeLocator {
  private projects?: { at: number; list: Promise<{ id: string; name: string }[]> };
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
   * Active projects, cached briefly; a failed load isn't cached. `refresh` reloads at once (at most every few seconds),
   * for a user whose claims name a project created after the cache was filled.
   */
  list({ refresh = false } = {}): Promise<{ id: string; name: string }[]> {
    const forced = refresh && Date.now() - this.lastForced > 5_000;
    if (forced) this.lastForced = Date.now();
    if (forced || !this.projects || Date.now() - this.projects.at > PROJECTS_TTL_MS) {
      const list = this.call<{ id: string; name: string }[]>("/projects");
      list.catch(() => {
        if (this.projects?.list === list) this.projects = undefined;
      });
      this.projects = { at: Date.now(), list };
    }
    return this.projects.list;
  }

  async endpoint(project: string) {
    let url = this.endpoints.get(project);
    if (!url) {
      url = (await this.call<{ url: string }>(`/projects/${encodeURIComponent(project)}/endpoint`)).url;
      this.endpoints.set(project, url);
    }
    return url;
  }

  async wake(project: string) {
    await this.call<void>(`/projects/${encodeURIComponent(project)}/wake`, { method: "POST" });
  }
}
