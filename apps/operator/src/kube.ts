import { readFile } from "node:fs/promises";

export interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string>; [k: string]: unknown };
  [k: string]: unknown;
}

export class KubeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Plural resource paths for the kinds the operator manages. */
const RESOURCES: Record<string, { group: string; plural: string; namespaced: boolean }> = {
  Namespace: { group: "api/v1", plural: "namespaces", namespaced: false },
  ServiceAccount: { group: "api/v1", plural: "serviceaccounts", namespaced: true },
  Secret: { group: "api/v1", plural: "secrets", namespaced: true },
  ConfigMap: { group: "api/v1", plural: "configmaps", namespaced: true },
  Service: { group: "api/v1", plural: "services", namespaced: true },
  ResourceQuota: { group: "api/v1", plural: "resourcequotas", namespaced: true },
  LimitRange: { group: "api/v1", plural: "limitranges", namespaced: true },
  StatefulSet: { group: "apis/apps/v1", plural: "statefulsets", namespaced: true },
  NetworkPolicy: { group: "apis/networking.k8s.io/v1", plural: "networkpolicies", namespaced: true },
  Ingress: { group: "apis/networking.k8s.io/v1", plural: "ingresses", namespaced: true },
  Tenant: { group: "apis/osiris.k6labs.cz/v1alpha1", plural: "tenants", namespaced: true },
};

export function resourcePath(kind: string, namespace: string | undefined, name?: string) {
  const r = RESOURCES[kind];
  if (!r) throw new Error(`Unknown kind ${kind}`);
  const ns = r.namespaced ? `/namespaces/${namespace}` : "";
  return `/${r.group}${ns}/${r.plural}${name ? `/${name}` : ""}`;
}

/**
 * A small Kubernetes API client: server-side apply, get/list/delete, status patches and watches. In the cluster it
 * uses the pod's ServiceAccount token and trusts the API server through NODE_EXTRA_CA_CERTS.
 */
export class Kube {
  constructor(
    private readonly options: { apiServer?: string; tokenPath?: string; fetchFn?: typeof fetch; fieldManager?: string } = {},
  ) {}

  private get base() {
    return this.options.apiServer ?? "https://kubernetes.default.svc";
  }

  private async token() {
    return (await readFile(this.options.tokenPath ?? "/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();
  }

  async request<T>(method: string, path: string, body?: unknown, contentType = "application/json", signal?: AbortSignal): Promise<T> {
    const res = await (this.options.fetchFn ?? fetch)(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, accept: "application/json", ...(body ? { "content-type": contentType } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new KubeError(`${method} ${path.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
    return (await res.json()) as T;
  }

  /** Server-side apply: creates or updates the fields this operator owns, idempotently. */
  apply(obj: KubeObject) {
    const path = resourcePath(obj.kind, obj.metadata.namespace, obj.metadata.name);
    return this.request<KubeObject>("PATCH", `${path}?fieldManager=${this.options.fieldManager ?? "osiris-operator"}&force=true`, obj, "application/apply-patch+yaml");
  }

  async get<T = KubeObject>(kind: string, namespace: string | undefined, name: string): Promise<T | null> {
    try {
      return await this.request<T>("GET", resourcePath(kind, namespace, name));
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) return null;
      throw err;
    }
  }

  async list<T = KubeObject>(kind: string, namespace: string | undefined, labelSelector?: string): Promise<T[]> {
    const q = labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : "";
    return (await this.request<{ items: T[] }>("GET", `${resourcePath(kind, namespace)}${q}`)).items;
  }

  async delete(kind: string, namespace: string | undefined, name: string) {
    try {
      await this.request("DELETE", resourcePath(kind, namespace, name), { propagationPolicy: "Background" });
    } catch (err) {
      if (!(err instanceof KubeError && err.status === 404)) throw err;
    }
  }

  /** JSON merge patch (finalizers, replicas, status subresource). */
  mergePatch(kind: string, namespace: string | undefined, name: string, patch: unknown, subresource = "") {
    return this.request<KubeObject>("PATCH", `${resourcePath(kind, namespace, name)}${subresource}`, patch, "application/merge-patch+json");
  }

  /** Streams watch events until `signal` aborts or the server ends the watch (callers reconnect). */
  async watch(kind: string, namespace: string, onEvent: (type: string, obj: KubeObject) => void, signal: AbortSignal) {
    const res = await (this.options.fetchFn ?? fetch)(`${this.base}${resourcePath(kind, namespace)}?watch=true&timeoutSeconds=300`, {
      headers: { authorization: `Bearer ${await this.token()}` },
      signal,
    });
    if (!res.ok || !res.body) throw new KubeError(`watch ${kind}: ${res.status}`, res.status);
    let buffer = "";
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const event = JSON.parse(line) as { type: string; object: KubeObject };
        onEvent(event.type, event.object);
      }
    }
  }
}
