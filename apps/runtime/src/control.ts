import { Readable } from "node:stream";
import { NO_QUOTAS, type Feature, type Schedule, type ScheduleInput, type SiteDomain, type SiteRelease, type TenantFeatures, type TenantQuotas } from "@osiris/shared";
import type { FeatureSource } from "@osiris/core/tenants/features.ts";
import { callJson, ServiceError } from "@osiris/platform/http.ts";

const FEATURES_TTL_MS = 30_000;

/**
 * The runtime's calls to control, authenticated with the runtime's ServiceAccount token: control learns the tenant
 * from the token, so a runtime can only ever act for its own tenant.
 */
export class ControlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: () => Promise<string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${await this.token()}`, ...extra };
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    return callJson<T>(`${this.baseUrl}/internal/runtime${path}`, {
      ...init,
      headers: await this.headers(init.headers as Record<string, string>),
      fetchFn: this.fetchFn,
    });
  }

  tenant() {
    return this.json<{
      id: string;
      name: string;
      status: string;
      features: TenantFeatures;
      disabledTools: string[];
      quotas: TenantQuotas;
      counts: { members: number; schedules: number };
    }>("/tenant");
  }

  /** Streams a snapshot to object storage through control. */
  async uploadBackup(body: Readable, reason: string): Promise<{ key: string; bytes: number }> {
    const res = await this.fetchFn(`${this.baseUrl}/internal/runtime/backups?reason=${encodeURIComponent(reason)}`, {
      method: "PUT",
      headers: await this.headers({ "content-type": "application/gzip" }),
      body: Readable.toWeb(body) as ReadableStream,
      duplex: "half",
    } as RequestInit);
    if (!res.ok) throw new ServiceError(`Backup upload failed: ${res.status} ${await res.text()}`, res.status);
    return (await res.json()) as { key: string; bytes: number };
  }

  /** The newest snapshot of this tenant, or null for a new tenant. */
  async latestBackup(): Promise<{ key: string; body: Readable } | null> {
    const res = await this.fetchFn(`${this.baseUrl}/internal/runtime/backups/latest`, { headers: await this.headers() });
    if (res.status === 404) return null;
    if (!res.ok || !res.body) throw new ServiceError(`Backup download failed: ${res.status}`, res.status);
    return { key: res.headers.get("x-backup-key") ?? "?", body: Readable.fromWeb(res.body as never) };
  }

  schedules(ownerId: string) {
    return this.json<Schedule[]>(`/schedules?owner=${encodeURIComponent(ownerId)}`);
  }

  createSchedule(owner: { id: string; name: string | null }, input: ScheduleInput) {
    return this.json<Schedule>("/schedules", { method: "POST", body: JSON.stringify({ ...input, owner }) });
  }

  deleteSchedule(ownerId: string, id: string) {
    return this.json<void>(`/schedules/${encodeURIComponent(id)}?owner=${encodeURIComponent(ownerId)}`, { method: "DELETE" });
  }

  domains() {
    return this.json<SiteDomain[]>("/domains");
  }

  async publishSite(domain: string, archive: Readable, userId: string): Promise<SiteRelease> {
    const res = await this.fetchFn(
      `${this.baseUrl}/internal/runtime/sites/publish?domain=${encodeURIComponent(domain)}&user=${encodeURIComponent(userId)}`,
      {
        method: "POST",
        headers: await this.headers({ "content-type": "application/gzip" }),
        body: Readable.toWeb(archive) as ReadableStream,
        duplex: "half",
        signal: AbortSignal.timeout(5 * 60_000),
      } as RequestInit,
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ServiceError(body?.error ?? `Publishing failed: ${res.status}`, res.status);
    }
    return (await res.json()) as SiteRelease;
  }
}

/** Features and switched-off tools from control, cached briefly; if control is unreachable, the last known ones stay in force. */
export class RemoteFeatures implements FeatureSource {
  private cached?: TenantPolicy & { at: number };
  private loading?: Promise<TenantPolicy>;

  constructor(private readonly control: ControlClient) {}

  private async load() {
    if (this.cached && Date.now() - this.cached.at < FEATURES_TTL_MS) return this.cached;
    this.loading ??= this.control
      .tenant()
      .then(
        (t) =>
          (this.cached = {
            at: Date.now(),
            features: t.features,
            disabledTools: t.disabledTools ?? [],
            quotas: { ...NO_QUOTAS, ...t.quotas },
            counts: t.counts ?? { members: 0, schedules: 0 },
          }),
      )
      .catch((err) => {
        if (this.cached) return this.cached;
        throw err;
      })
      .finally(() => (this.loading = undefined));
    return this.loading;
  }

  async get(): Promise<TenantFeatures> {
    return (await this.load()).features;
  }

  async enabled(feature: Feature) {
    return (await this.get())[feature];
  }

  async disabledTools() {
    return (await this.load()).disabledTools;
  }

  async quotas() {
    return (await this.load()).quotas;
  }

  /** Members and scheduled tasks, counted by control (as of the last fetch). */
  async counts() {
    return (await this.load()).counts;
  }
}

interface TenantPolicy {
  features: TenantFeatures;
  disabledTools: string[];
  quotas: TenantQuotas;
  counts: { members: number; schedules: number };
}
