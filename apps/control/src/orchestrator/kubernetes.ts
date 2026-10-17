import { readFile } from "node:fs/promises";
import { TENANT_NAMESPACE_PREFIX } from "@osiris/platform/runtime-identity.ts";
import type { Orchestrator, TenantSpec } from "./types.ts";

export const TENANT_GROUP = "osiris.k6labs.cz";
export const TENANT_VERSION = "v1alpha1";

/**
 * Writes `Tenant` resources (server-side apply) for the operator to reconcile. Control may only touch Tenant objects
 * in its own namespace (Role), never pods or volumes. Waking uses a separate field manager, so applying the spec
 * doesn't remove the wake request and vice versa.
 */
export class KubernetesOrchestrator implements Orchestrator {
  constructor(
    private readonly options: {
      namespace: string;
      runtimePort: number;
      apiServer?: string;
      tokenPath?: string;
      fetchFn?: typeof fetch;
    },
  ) {}

  private url(name: string, manager: string) {
    const api = this.options.apiServer ?? "https://kubernetes.default.svc";
    return `${api}/apis/${TENANT_GROUP}/${TENANT_VERSION}/namespaces/${this.options.namespace}/tenants/${name}?fieldManager=${manager}&force=true`;
  }

  private async serverSideApply(name: string, manager: string, spec: Record<string, unknown>) {
    const token = (await readFile(this.options.tokenPath ?? "/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();
    const res = await (this.options.fetchFn ?? fetch)(this.url(name, manager), {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/apply-patch+yaml" },
      // JSON is valid YAML.
      body: JSON.stringify({ apiVersion: `${TENANT_GROUP}/${TENANT_VERSION}`, kind: "Tenant", metadata: { name }, spec }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Applying Tenant ${name} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  apply(spec: TenantSpec) {
    return this.serverSideApply(spec.id, "osiris-control", {
      displayName: spec.name,
      suspended: spec.suspended,
      idleMinutes: spec.idleMinutes,
      storageGi: spec.storageGb,
      domains: spec.domains,
    });
  }

  wake(id: string) {
    return this.serverSideApply(id, "osiris-control-wake", { wakeRequestedAt: new Date().toISOString() });
  }

  endpoint(id: string) {
    return `http://runtime.${TENANT_NAMESPACE_PREFIX}${id}.svc.cluster.local:${this.options.runtimePort}`;
  }
}
