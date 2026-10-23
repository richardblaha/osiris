import { readFile } from "node:fs/promises";
import { PROJECT_NAMESPACE_PREFIX } from "@osiris/platform/runtime-identity.ts";
import type { Orchestrator, ProjectSpec, ProjectStatus } from "./types.ts";

export const PROJECT_GROUP = "osiris.k6labs.cz";
export const PROJECT_VERSION = "v1alpha1";

/**
 * Writes `Project` resources (server-side apply) for the operator to reconcile. Control may only touch Project objects
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
    return `${api}/apis/${PROJECT_GROUP}/${PROJECT_VERSION}/namespaces/${this.options.namespace}/projects/${name}?fieldManager=${manager}&force=true`;
  }

  private async serverSideApply(name: string, manager: string, spec: Record<string, unknown>) {
    const token = (await readFile(this.options.tokenPath ?? "/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();
    const res = await (this.options.fetchFn ?? fetch)(this.url(name, manager), {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/apply-patch+yaml" },
      // JSON is valid YAML.
      body: JSON.stringify({ apiVersion: `${PROJECT_GROUP}/${PROJECT_VERSION}`, kind: "Project", metadata: { name }, spec }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Applying Project ${name} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  apply(spec: ProjectSpec) {
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

  async statuses() {
    const token = (await readFile(this.options.tokenPath ?? "/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();
    const api = this.options.apiServer ?? "https://kubernetes.default.svc";
    const res = await (this.options.fetchFn ?? fetch)(`${api}/apis/${PROJECT_GROUP}/${PROJECT_VERSION}/namespaces/${this.options.namespace}/projects`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Listing Projects failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const { items } = (await res.json()) as { items: { metadata: { name: string }; status?: { phase?: string; lastActivity?: string; message?: string } }[] };
    return new Map(
      items.map((t): [string, ProjectStatus] => [
        t.metadata.name,
        { phase: (["Running", "Sleeping", "Suspended"].includes(t.status?.phase ?? "") ? t.status!.phase : "Unknown") as ProjectStatus["phase"], lastActivity: t.status?.lastActivity, message: t.status?.message },
      ]),
    );
  }

  endpoint(id: string) {
    return `http://runtime.${PROJECT_NAMESPACE_PREFIX}${id}.svc.cluster.local:${this.options.runtimePort}`;
  }
}
