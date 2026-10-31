import { readFile } from "node:fs/promises";

/** The parts of the k8s API objects the twin is built from (only what the read-only ClusterRole can see). */
export interface NamespaceObject {
  metadata: { name: string; uid?: string };
  status?: { phase?: string };
}

export interface PodObject {
  metadata: { name: string; namespace: string; uid?: string; ownerReferences?: { kind: string; name: string; apiVersion: string }[] };
  spec: {
    nodeName?: string;
    hostNetwork?: boolean;
    volumes?: { name: string; persistentVolumeClaim?: { claimName: string } }[];
    containers?: { name: string; volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[] }[];
  };
  status?: {
    phase?: string;
    podIP?: string;
    containerStatuses?: { name: string; ready: boolean; restartCount: number; image: string; state?: Running | Waiting | Terminated }[];
  };
}
interface Running {}
interface Waiting {
  reason?: string;
}
interface Terminated {
  reason?: string;
  exitCode?: number;
}

export interface NodeObject {
  metadata: { name: string; uid?: string; annotations?: Record<string, string> };
  spec?: { podCIDR?: string };
  status?: {
    nodeInfo?: { kubeletVersion?: string; osImage?: string };
    capacity?: Record<string, string>;
    conditions?: { type: string; status: string }[];
    addresses?: { type: string; address: string }[];
  };
}

/** A claim on storage: its size, class and whether a volume backs it. */
export interface PvcObject {
  metadata: { name: string; namespace: string; uid?: string };
  spec?: { storageClassName?: string; accessModes?: string[]; volumeName?: string; resources?: { requests?: { storage?: string } } };
  status?: { phase?: string; capacity?: { storage?: string } };
}

/** A Service: its virtual address, ports, and (a LoadBalancer) the address it has outside. */
export interface ServiceObject {
  metadata: { name: string; namespace: string };
  spec?: { type?: string; clusterIP?: string; ports?: { name?: string; port: number; protocol?: string; targetPort?: number | string }[]; selector?: Record<string, string> };
  status?: { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } };
}

/** Which pods a Service's traffic reaches (EndpointSlice). */
export interface EndpointSliceObject {
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  endpoints?: { addresses?: string[]; conditions?: { ready?: boolean }; targetRef?: { kind?: string; name?: string; namespace?: string } }[];
}

/** An Ingress: hosts and paths to Services. */
export interface IngressObject {
  metadata: { name: string; namespace: string };
  spec?: {
    ingressClassName?: string;
    tls?: { hosts?: string[]; secretName?: string }[];
    rules?: { host?: string; http?: { paths?: { path?: string; backend?: { service?: { name: string; port?: { number?: number; name?: string } } } }[] } }[];
  };
}

/** Traefik's IngressRoute: matches (Host(`…`) && PathPrefix(`…`)) to Services. */
export interface IngressRouteObject {
  metadata: { name: string; namespace: string };
  spec?: { entryPoints?: string[]; routes?: { match?: string; services?: { name: string; namespace?: string; port?: number | string }[] }[]; tls?: unknown };
}

/** A volume: which CSI pool it is an image in. */
export interface PvObject {
  metadata: { name: string };
  spec?: { csi?: { driver?: string; volumeAttributes?: Record<string, string> } };
}

/** ReplicaSets matter only to find the Deployment a pod's owner belongs to. */
export interface ReplicaSetObject {
  metadata: { name: string; namespace: string; ownerReferences?: { kind: string; name: string }[] };
}

export class KubeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * A small read-only Kubernetes API client: the twin's structure is namespaces, pods and nodes straight from the
 * cluster (workloads group pods by their owner references). In the cluster it uses the pod's ServiceAccount token.
 */
export class Kube {
  constructor(
    private readonly options: { apiServer?: string; tokenPath?: string; token?: string; fetchFn?: typeof fetch } = {},
  ) {}

  private get base() {
    return this.options.apiServer?.replace(/\/$/, "") ?? "https://kubernetes.default.svc";
  }

  private async token() {
    if (this.options.token) return this.options.token;
    return (await readFile(this.options.tokenPath ?? "/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();
  }

  private async request<T>(path: string): Promise<T> {
    const res = await (this.options.fetchFn ?? fetch)(`${this.base}${path}`, {
      headers: { authorization: `Bearer ${await this.token()}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new KubeError(`GET ${path.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
    return (await res.json()) as T;
  }

  private async list<T>(path: string): Promise<T[]> {
    return (await this.request<{ items: T[] }>(path)).items ?? [];
  }

  namespaces() {
    return this.list<NamespaceObject>("/api/v1/namespaces");
  }

  /** Pods of every namespace; the twin has no namespace to focus on. */
  pods() {
    return this.list<PodObject>("/api/v1/pods");
  }

  nodes() {
    return this.list<NodeObject>("/api/v1/nodes");
  }

  persistentVolumeClaims() {
    return this.list<PvcObject>("/api/v1/persistentvolumeclaims");
  }

  services() {
    return this.list<ServiceObject>("/api/v1/services");
  }

  endpointSlices() {
    return this.list<EndpointSliceObject>("/apis/discovery.k8s.io/v1/endpointslices");
  }

  ingresses() {
    return this.list<IngressObject>("/apis/networking.k8s.io/v1/ingresses");
  }

  /** Traefik's IngressRoutes (a cluster without Traefik's CRDs has none). */
  ingressRoutes() {
    return this.list<IngressRouteObject>("/apis/traefik.io/v1alpha1/ingressroutes");
  }

  persistentVolumes() {
    return this.list<PvObject>("/api/v1/persistentvolumes");
  }

  replicasets() {
    return this.list<ReplicaSetObject>("/apis/apps/v1/replicasets");
  }

  /** The cluster's Kubernetes version (the gitVersion of any API server). */
  async version(): Promise<string | null> {
    try {
      const v = await this.request<{ gitVersion?: string }>("/version");
      return v.gitVersion ?? null;
    } catch {
      return null;
    }
  }
}
