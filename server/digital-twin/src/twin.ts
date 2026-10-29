import type { Twin, TwinNode, TwinStatus } from "@osiris/shared";
import { instanceId, MODEL } from "./dtdl.ts";
import type { NodeObject, PodObject } from "./kube.ts";

/** Error log records of the last 15 minutes per pod (namespace + pod name), 0 for the rest. */
export type PodErrors = Map<string, number>;
const errorsKey = (namespace: string, pod: string) => `${namespace}/${pod}`;

const worse = (a: TwinStatus, b: TwinStatus): TwinStatus => (a === "error" || b === "error" ? "error" : a === "warn" || b === "warn" ? "warn" : "ok");

/** A pod's phase, lowercased the way the twin's DTDL enum spells it. */
const phase = (pod: PodObject) => (pod.status?.phase ?? "unknown").toLowerCase();

/**
 * A pod's status: failed is an error; a pod that isn't ready (while running) or pending, or a container that died
 * with a non-zero exit code, is a warning; succeeded pods are done and well.
 */
export function podStatus(pod: PodObject): TwinStatus {
  if (phase(pod) === "failed") return "error";
  const containers = pod.status?.containerStatuses ?? [];
  const ready = containers.filter((c) => c.ready).length;
  if (containers.some((c) => c.state && "terminated" in c.state && (c.state as { exitCode?: number }).exitCode)) {
    const died = containers.some((c) => {
      const t = c.state as { terminated?: { exitCode?: number } } | undefined;
      return t?.terminated && t.terminated.exitCode !== 0 && t.terminated.exitCode !== undefined;
    });
    if (died) return "error";
  }
  if (phase(pod) === "pending") return "warn";
  if (containers.length && ready < containers.length) return "warn";
  return "ok";
}

/** Containers of a pod as twin nodes (a container has no children; log records belong to the pod). */
function containerNodes(cluster: string, pod: PodObject): TwinNode[] {
  return (pod.status?.containerStatuses ?? []).map((c) => ({
    id: instanceId(cluster, ["namespace", pod.metadata.namespace], ["pod", pod.metadata.name], ["container", c.name]),
    model: MODEL.Container,
    kind: "container",
    name: c.name,
    status: c.ready ? "ok" : "warn",
    errors: 0,
    properties: { image: c.image, ready: String(c.ready), restarts: String(c.restartCount) },
    children: [],
  }));
}

/** Pods as twin nodes, under their workload (owner references; a ReplicaSet resolves to its Deployment). */
function podNode(cluster: string, pod: PodObject, errors: PodErrors): TwinNode {
  const status = podStatus(pod);
  const containers = pod.status?.containerStatuses ?? [];
  const children = containerNodes(cluster, pod);
  return {
    id: instanceId(cluster, ["namespace", pod.metadata.namespace], ["pod", pod.metadata.name]),
    model: MODEL.Pod,
    kind: "pod",
    name: pod.metadata.name,
    status,
    errors: errors.get(errorsKey(pod.metadata.namespace, pod.metadata.name)) ?? 0,
    properties: {
      phase: phase(pod),
      node: pod.spec.nodeName ?? "",
      ip: pod.status?.podIP ?? "",
      ready: `${containers.filter((c) => c.ready).length}/${containers.length}`,
      restarts: String(containers.reduce((n, c) => n + c.restartCount, 0)),
    },
    children,
  };
}

export interface TwinInput {
  clusterName: string;
  namespaces: { metadata: { name: string }; status?: { phase?: string } }[];
  pods: PodObject[];
  nodes: NodeObject[];
  version: string | null;
  /** Deployment owners: ReplicaSet names → Deployment names (pods name their ReplicaSet). */
  deploymentOf: Map<string, string>;
  podErrors: PodErrors;
}

/** What a pod belongs to: a Deployment (through its ReplicaSet), another owning kind, or itself when ownerless. */
function owner(pod: PodObject, deploymentOf: Map<string, string>): { kind: string; name: string } {
  const ownerRef = pod.metadata.ownerReferences?.find((o) => o.kind && o.name);
  if (!ownerRef) return { kind: "Pod", name: pod.metadata.name };
  if (ownerRef.kind === "ReplicaSet") {
    const deployment = deploymentOf.get(`${pod.metadata.namespace}/${ownerRef.name}`);
    if (deployment) return { kind: "Deployment", name: deployment };
  }
  return { kind: ownerRef.kind, name: ownerRef.name };
}

/** Status and error counts roll up the tree: a node is as bad as its worst child. */
function rollUp(node: TwinNode): TwinNode {
  for (const child of node.children) rollUp(child);
  node.errors += node.children.reduce((n, c) => n + c.errors, 0);
  node.status = node.children.reduce((s, c) => worse(s, c.status), node.status);
  return node;
}

/**
 * The cluster's twin in one tree: cluster → namespaces → workloads → pods → containers, each node a DTDL instance
 * of its interface. The k8s API gives the structure and status; ClickHouse the error counts.
 */
export function buildTwin(input: TwinInput): Twin {
  const byWorkload = new Map<string, { owner: { kind: string; name: string }; pods: TwinNode[] }>();
  for (const pod of input.pods) {
    const o = owner(pod, input.deploymentOf);
    const key = `${pod.metadata.namespace}/${o.kind}/${o.name}`;
    const group = byWorkload.get(key) ?? { owner: o, pods: [] };
    group.pods.push(podNode(input.clusterName, pod, input.podErrors));
    byWorkload.set(key, group);
  }

  const namespaces: TwinNode[] = [...input.namespaces]
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
    .map((ns) => {
      const workloads = [...byWorkload.entries()]
        .filter(([key]) => key.startsWith(`${ns.metadata.name}/`))
        .map(([_, { owner: o, pods }]): TwinNode => {
          pods.sort((a, b) => a.name.localeCompare(b.name));
          return {
            id: instanceId(input.clusterName, ["namespace", ns.metadata.name], [o.kind.toLowerCase(), o.name]),
            model: MODEL.Workload,
            kind: "workload",
            name: o.name,
            status: pods.reduce((s, p) => worse(s, p.status), "ok" as TwinStatus),
            errors: 0,
            properties: {
              kind: o.kind,
              pods: String(pods.length),
              ready: String(pods.filter((p) => p.status === "ok").length),
            },
            children: pods,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        id: instanceId(input.clusterName, ["namespace", ns.metadata.name]),
        model: MODEL.Namespace,
        kind: "namespace",
        name: ns.metadata.name,
        status: "ok",
        errors: 0,
        properties: { phase: (ns.status?.phase ?? "active").toLowerCase() },
        children: workloads,
      };
    });

  const kubelets = new Set(input.nodes.map((n) => n.status?.nodeInfo?.kubeletVersion).filter(Boolean));
  const cluster: TwinNode = {
    id: instanceId(input.clusterName),
    model: MODEL.Cluster,
    kind: "cluster",
    name: input.clusterName,
    status: "ok",
    errors: 0,
    properties: {
      version: input.version ?? "",
      nodes: String(input.nodes.length),
      pods: String(input.pods.length),
      ...(kubelets.size === 1 ? { kubelet: [...kubelets][0]! } : {}),
    },
    children: namespaces,
  };
  return { cluster: rollUp(cluster), ts: Date.now() };
}
