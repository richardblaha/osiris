import type { TwinEntity, TwinRelationship, TwinStatus } from "@osiris/shared";
import { CONTAINS, type SourceSnapshot } from "../../twin.ts";
import type { NamespaceObject, NodeObject, PodObject, ReplicaSetObject } from "./kube.ts";
import { instanceId, MODEL } from "./models.ts";

/** OpenTelemetry's Kubernetes resource attributes, as the collector's k8sattributes processor sets them. */
export const NAMESPACE_ATTR = "k8s.namespace.name";
export const POD_ATTR = "k8s.pod.name";
export const CONTAINER_ATTR = "k8s.container.name";

/** A pod's phase, lowercased the way the twin's DTDL enum spells it. */
const phase = (pod: PodObject) => (pod.status?.phase ?? "unknown").toLowerCase();

/**
 * A pod's status: failed is an error; a pod that isn't ready (while running) or pending, or a container that died
 * with a non-zero exit code, is a warning; succeeded pods are done and well.
 */
export function podStatus(pod: PodObject): TwinStatus {
  if (phase(pod) === "failed") return "error";
  const containers = pod.status?.containerStatuses ?? [];
  const died = containers.some((c) => {
    const t = (c.state as { terminated?: { exitCode?: number } } | undefined)?.terminated;
    return t?.exitCode !== undefined && t.exitCode !== 0;
  });
  if (died) return "error";
  if (phase(pod) === "pending") return "warn";
  if (containers.length && containers.some((c) => !c.ready)) return "warn";
  return "ok";
}

/** A node's status: not Ready is an error, memory, disk or PID pressure a warning. */
export function nodeStatus(node: NodeObject): TwinStatus {
  const conditions = node.status?.conditions ?? [];
  const ready = conditions.find((c) => c.type === "Ready");
  if (ready && ready.status !== "True") return "error";
  if (conditions.some((c) => c.type.endsWith("Pressure") && c.status === "True")) return "warn";
  return "ok";
}

export interface ClusterInput {
  clusterName: string;
  namespaces: NamespaceObject[];
  pods: PodObject[];
  nodes: NodeObject[];
  replicasets: ReplicaSetObject[];
  version: string | null;
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

/**
 * The cluster as a graph: the cluster contains its namespaces, a namespace its workloads (pods grouped by owner), a
 * workload its pods, a pod its containers; the cluster has its nodes and every pod runs on one. Each entity is an
 * instance of its DTDL interface, with the OpenTelemetry attributes that name its telemetry.
 */
export function clusterGraph(input: ClusterInput): SourceSnapshot {
  const cluster = input.clusterName;
  const entities: TwinEntity[] = [];
  const relationships: TwinRelationship[] = [];
  const add = (e: Omit<TwinEntity, "errors">) => entities.push({ ...e, errors: 0 });
  const link = (name: string, source: string, target: string) => relationships.push({ name, source, target });

  const deploymentOf = new Map(
    input.replicasets.flatMap((rs) => {
      const deployment = rs.metadata.ownerReferences?.find((o) => o.kind === "Deployment");
      return deployment ? [[`${rs.metadata.namespace}/${rs.metadata.name}`, deployment.name] as const] : [];
    }),
  );

  const kubelets = new Set(input.nodes.map((n) => n.status?.nodeInfo?.kubeletVersion).filter(Boolean));
  const root = instanceId(cluster);
  add({
    id: root,
    model: MODEL.Cluster,
    kind: "cluster",
    name: cluster,
    status: "ok",
    properties: {
      version: input.version ?? "",
      nodes: String(input.nodes.length),
      pods: String(input.pods.length),
      ...(kubelets.size === 1 ? { kubelet: [...kubelets][0]! } : {}),
    },
  });

  const nodeIds = new Map<string, string>();
  for (const node of [...input.nodes].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
    const id = instanceId(cluster, ["node", node.metadata.name]);
    nodeIds.set(node.metadata.name, id);
    add({
      id,
      model: MODEL.Node,
      kind: "node",
      name: node.metadata.name,
      status: nodeStatus(node),
      properties: {
        kubelet: node.status?.nodeInfo?.kubeletVersion ?? "",
        os: node.status?.nodeInfo?.osImage ?? "",
        cpu: node.status?.capacity?.cpu ?? "",
        memory: node.status?.capacity?.memory ?? "",
      },
      telemetry: { "k8s.node.name": node.metadata.name },
    });
    link("hasNode", root, id);
  }

  // Pods by workload, so each workload's pods come out together and sorted.
  const byWorkload = new Map<string, { namespace: string; owner: { kind: string; name: string }; pods: PodObject[] }>();
  for (const pod of input.pods) {
    const o = owner(pod, deploymentOf);
    const key = `${pod.metadata.namespace}/${o.kind}/${o.name}`;
    const group = byWorkload.get(key) ?? { namespace: pod.metadata.namespace, owner: o, pods: [] };
    group.pods.push(pod);
    byWorkload.set(key, group);
  }

  for (const ns of [...input.namespaces].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
    const namespace = ns.metadata.name;
    const nsId = instanceId(cluster, ["namespace", namespace]);
    add({
      id: nsId,
      model: MODEL.Namespace,
      kind: "namespace",
      name: namespace,
      status: "ok",
      properties: { phase: (ns.status?.phase ?? "active").toLowerCase() },
      telemetry: { [NAMESPACE_ATTR]: namespace },
    });
    link(CONTAINS, root, nsId);

    const workloads = [...byWorkload.values()].filter((w) => w.namespace === namespace).sort((a, b) => a.owner.name.localeCompare(b.owner.name));
    for (const { owner: o, pods } of workloads) {
      // `workload-<kind>`: a lone pod is its own workload, and the two must not share an id.
      const workloadId = instanceId(cluster, ["namespace", namespace], [`workload-${o.kind.toLowerCase()}`, o.name]);
      add({
        id: workloadId,
        model: MODEL.Workload,
        kind: "workload",
        name: o.name,
        status: "ok",
        properties: { kind: o.kind, pods: String(pods.length), ready: String(pods.filter((p) => podStatus(p) === "ok").length) },
        telemetry: { [NAMESPACE_ATTR]: namespace },
      });
      link(CONTAINS, nsId, workloadId);

      for (const pod of [...pods].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
        const podId = instanceId(cluster, ["namespace", namespace], ["pod", pod.metadata.name]);
        const containers = pod.status?.containerStatuses ?? [];
        add({
          id: podId,
          model: MODEL.Pod,
          kind: "pod",
          name: pod.metadata.name,
          status: podStatus(pod),
          properties: {
            phase: phase(pod),
            node: pod.spec.nodeName ?? "",
            ip: pod.status?.podIP ?? "",
            ready: `${containers.filter((c) => c.ready).length}/${containers.length}`,
            restarts: String(containers.reduce((n, c) => n + c.restartCount, 0)),
          },
          telemetry: { [NAMESPACE_ATTR]: namespace, [POD_ATTR]: pod.metadata.name },
        });
        link(CONTAINS, workloadId, podId);
        const nodeId = pod.spec.nodeName && nodeIds.get(pod.spec.nodeName);
        if (nodeId) link("runsOn", podId, nodeId);

        for (const c of containers) {
          const containerId = instanceId(cluster, ["namespace", namespace], ["pod", pod.metadata.name], ["container", c.name]);
          add({
            id: containerId,
            model: MODEL.Container,
            kind: "container",
            name: c.name,
            status: c.ready ? "ok" : "warn",
            properties: { image: c.image, ready: String(c.ready), restarts: String(c.restartCount) },
            // A container's log records count for its pod (the error attributes name pods).
            telemetry: { [NAMESPACE_ATTR]: namespace, [POD_ATTR]: pod.metadata.name, [CONTAINER_ATTR]: c.name },
          });
          link(CONTAINS, podId, containerId);
        }
      }
    }
  }
  return { root, entities, relationships };
}
