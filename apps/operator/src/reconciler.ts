import { tenantAudience, type InternalSigner } from "@osiris/platform/internal-auth.ts";
import { KubeError, type Kube, type KubeObject } from "./kube.ts";
import { namespaceOf, RUNTIME_PORT, SITE_LABEL, siteIngresses, TENANT_LABEL, tenantResources, type OperatorSettings, type TenantResource } from "./resources.ts";

export const FINALIZER = "osiris.k6labs.cz/cleanup";

interface StatefulSetStatus {
  spec?: { replicas?: number };
  status?: { readyReplicas?: number };
}

const ms = (iso?: string) => (iso ? Date.parse(iso) || 0 : 0);

/** Calls a tenant's runtime as the operator (activity, snapshot before sleep). */
export interface RuntimeProbe {
  activity(tenant: string): Promise<{ lastActivity: number; activeRuns: number }>;
  /** Snapshot and stop taking requests; false if runs are in progress. */
  prepareSleep(tenant: string): Promise<boolean>;
}

export function httpRuntimeProbe(signer: InternalSigner, url: (tenant: string) => string, fetchFn: typeof fetch = fetch): RuntimeProbe {
  const call = async (tenant: string, path: string, method: string, timeoutMs: number) =>
    fetchFn(`${url(tenant)}${path}`, {
      method,
      headers: { authorization: await signer.header(tenantAudience(tenant)) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  return {
    async activity(tenant) {
      const res = await call(tenant, "/internal/activity", "GET", 10_000);
      if (!res.ok) throw new Error(`activity ${tenant}: ${res.status}`);
      return (await res.json()) as { lastActivity: number; activeRuns: number };
    },
    async prepareSleep(tenant) {
      const res = await call(tenant, "/internal/snapshot?reason=sleep", "POST", 10 * 60_000);
      if (res.status === 409) return false;
      if (!res.ok) throw new Error(`snapshot ${tenant}: ${res.status} ${await res.text()}`);
      return true;
    },
  };
}

export const runtimeUrl = (tenant: string) => `http://runtime.${namespaceOf(tenant)}.svc.cluster.local:${RUNTIME_PORT}`;

/**
 * Keeps each tenant's namespace as its `Tenant` resource says, and runs it only when needed: a wake request (newer
 * than the last sleep) starts the runtime; after `idleMinutes` without activity and without running work it takes a
 * snapshot (the runtime stops taking requests) and scales to zero. The volume stays, so waking is quick.
 */
export class Reconciler {
  constructor(
    private readonly kube: Kube,
    private readonly settings: OperatorSettings,
    private readonly runtime: RuntimeProbe,
    private readonly log: (msg: string, extra?: unknown) => void = (m, e) => console.log(m, e ?? ""),
  ) {}

  async reconcile(t: TenantResource, now = Date.now()): Promise<void> {
    const id = t.metadata.name;
    const ns = this.settings.namespace;
    if (t.metadata.deletionTimestamp) return this.finalize(t);
    if (!t.metadata.finalizers?.includes(FINALIZER)) {
      await this.kube.mergePatch("Tenant", ns, id, { metadata: { finalizers: [...(t.metadata.finalizers ?? []), FINALIZER] } });
    }

    const sts = await this.kube.get<StatefulSetStatus>("StatefulSet", namespaceOf(id), "runtime");
    const running = (sts?.spec?.replicas ?? 0) > 0;
    const ready = (sts?.status?.readyReplicas ?? 0) > 0;
    const sleptAt = ms(t.status?.sleptAt) || ms(t.metadata.creationTimestamp);
    // Running when woken since the last sleep, when already running, or always (idleMinutes 0).
    const wanted =
      !t.spec.suspended && (t.spec.idleMinutes === 0 || ms(t.spec.wakeRequestedAt) > sleptAt || (running && t.status?.phase === "Running"));

    let replicas: 0 | 1 = wanted ? 1 : 0;
    let status: TenantResource["status"] = { ...t.status, phase: t.spec.suspended ? "Suspended" : wanted ? "Running" : "Sleeping" };

    const idle = t.spec.idleMinutes ?? 30;
    if (wanted && ready && idle > 0 && now - ms(t.spec.wakeRequestedAt) > idle * 60_000) {
      try {
        const { lastActivity, activeRuns } = await this.runtime.activity(id);
        status.lastActivity = new Date(lastActivity).toISOString();
        if (activeRuns === 0 && now - lastActivity > idle * 60_000 && (await this.runtime.prepareSleep(id))) {
          this.log(`Tenant ${id}: idle for ${Math.round((now - lastActivity) / 60_000)} min, sleeping`);
          replicas = 0;
          status = { ...status, phase: "Sleeping", sleptAt: new Date(now).toISOString() };
        }
      } catch (err) {
        // A runtime that can't be asked keeps running; better a wasted pod than a lost snapshot.
        status.message = `Activity check failed: ${(err as Error).message}`;
      }
    }

    for (const obj of tenantResources(t, this.settings, replicas)) await this.kube.apply(obj);
    await this.syncIngresses(t);
    if (JSON.stringify(status) !== JSON.stringify(t.status)) {
      await this.kube.mergePatch("Tenant", ns, id, { status }, "/status");
    }
  }

  /** Creates ingresses for the verified domains and removes the rest (with their certificates). */
  private async syncIngresses(t: TenantResource) {
    const id = t.metadata.name;
    const ns = this.settings.namespace;
    const desired = t.spec.suspended ? [] : siteIngresses(t, this.settings);
    for (const ing of desired) await this.kube.apply(ing);
    const existing = await this.kube.list<KubeObject>("Ingress", ns, `${TENANT_LABEL}=${id},${SITE_LABEL}=true`);
    for (const ing of existing) {
      if (desired.some((d) => d.metadata.name === ing.metadata.name)) continue;
      await this.kube.delete("Ingress", ns, ing.metadata.name);
      const tls = (ing as { spec?: { tls?: { secretName?: string }[] } }).spec?.tls?.[0]?.secretName;
      if (tls) await this.kube.delete("Secret", ns, tls);
    }
  }

  /** A deleted Tenant: a last snapshot if the runtime is up, then the namespace (volume included) and the ingresses. */
  private async finalize(t: TenantResource) {
    const id = t.metadata.name;
    if (!t.metadata.finalizers?.includes(FINALIZER)) return;
    const sts = await this.kube.get<StatefulSetStatus>("StatefulSet", namespaceOf(id), "runtime");
    if ((sts?.status?.readyReplicas ?? 0) > 0) {
      await this.runtime.prepareSleep(id).catch((err) => this.log(`Tenant ${id}: final snapshot failed`, err));
    }
    await this.syncIngresses({ ...t, spec: { ...t.spec, suspended: true } });
    await this.kube.delete("Namespace", undefined, namespaceOf(id));
    await this.kube.mergePatch("Tenant", this.settings.namespace, id, {
      metadata: { finalizers: (t.metadata.finalizers ?? []).filter((f) => f !== FINALIZER) },
    });
    this.log(`Tenant ${id}: removed`);
  }

  /** Reconciles every tenant; one failing tenant doesn't stop the others. */
  async reconcileAll() {
    for (const t of await this.kube.list<TenantResource>("Tenant", this.settings.namespace)) {
      await this.reconcile(t).catch((err) => this.log(`Tenant ${t.metadata.name}: reconcile failed`, err instanceof KubeError ? err.message : err));
    }
  }
}
