import type { TwinStatus } from "@osiris/shared";
import { CONTAINS, type SourceRelationship, type SourceSnapshot, type SourceTwin } from "../../twin.ts";
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
 * The cluster as twins: the cluster contains its namespaces, a namespace its workloads (pods grouped by owner), a
 * workload its pods, a pod its containers; the cluster has its nodes and every pod runs on one. Each twin is an
 * instance of its DTDL interface (property values typed as the model says), with the OpenTelemetry attributes that
 * name its telemetry.
 */
export function clusterGraph(input: ClusterInput): SourceSnapshot {
  const cluster = input.clusterName;
  const twins: SourceTwin[] = [];
  const relationships: SourceRelationship[] = [];
  const add = (id: string, model: string, name: string, status: TwinStatus, properties: Record<string, unknown>, otelResource?: Record<string, string>) =>
    twins.push({ $dtId: id, $metadata: { $model: model }, name, status, ...properties, ...(otelResource ? { otelResource } : {}) });
  const link = (name: string, source: string, target: string) => relationships.push({ name, source, target });

  const deploymentOf = new Map(
    input.replicasets.flatMap((rs) => {
      const deployment = rs.metadata.ownerReferences?.find((o) => o.kind === "Deployment");
      return deployment ? [[`${rs.metadata.namespace}/${rs.metadata.name}`, deployment.name] as const] : [];
    }),
  );

  const kubelets = new Set(input.nodes.map((n) => n.status?.nodeInfo?.kubeletVersion).filter(Boolean));
  const root = instanceId(cluster);
  add(root, MODEL.Cluster, cluster, "ok", {
    version: input.version ?? "",
    kubelet: kubelets.size === 1 ? [...kubelets][0]! : "",
    nodeCount: input.nodes.length,
    podCount: input.pods.length,
  });

  const nodeIds = new Map<string, string>();
  for (const node of [...input.nodes].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
    const id = instanceId(cluster, ["node", node.metadata.name]);
    nodeIds.set(node.metadata.name, id);
    add(
      id,
      MODEL.Node,
      node.metadata.name,
      nodeStatus(node),
      {
        kubelet: node.status?.nodeInfo?.kubeletVersion ?? "",
        os: node.status?.nodeInfo?.osImage ?? "",
        cpu: node.status?.capacity?.cpu ?? "",
        memory: node.status?.capacity?.memory ?? "",
      },
      { "k8s.node.name": node.metadata.name },
    );
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
    add(nsId, MODEL.Namespace, namespace, "ok", { phase: (ns.status?.phase ?? "active").toLowerCase() === "terminating" ? "terminating" : "active" }, { [NAMESPACE_ATTR]: namespace });
    link(CONTAINS, root, nsId);

    const workloads = [...byWorkload.values()].filter((w) => w.namespace === namespace).sort((a, b) => a.owner.name.localeCompare(b.owner.name));
    for (const { owner: o, pods } of workloads) {
      // `workload-<kind>`: a lone pod is its own workload, and the two must not share an id.
      const workloadId = instanceId(cluster, ["namespace", namespace], [`workload-${o.kind.toLowerCase()}`, o.name]);
      add(workloadId, MODEL.Workload, o.name, "ok", { ownerKind: o.kind, podCount: pods.length, readyCount: pods.filter((p) => podStatus(p) === "ok").length }, { [NAMESPACE_ATTR]: namespace });
      link(CONTAINS, nsId, workloadId);

      for (const pod of [...pods].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
        const podId = instanceId(cluster, ["namespace", namespace], ["pod", pod.metadata.name]);
        const containers = pod.status?.containerStatuses ?? [];
        const p = phase(pod);
        add(
          podId,
          MODEL.Pod,
          pod.metadata.name,
          podStatus(pod),
          {
            phase: ["pending", "running", "succeeded", "failed"].includes(p) ? p : "unknown",
            nodeName: pod.spec.nodeName ?? "",
            ip: pod.status?.podIP ?? "",
            readyCount: containers.filter((c) => c.ready).length,
            containerCount: containers.length,
            restarts: containers.reduce((n, c) => n + c.restartCount, 0),
          },
          { [NAMESPACE_ATTR]: namespace, [POD_ATTR]: pod.metadata.name },
        );
        link(CONTAINS, workloadId, podId);
        const nodeId = pod.spec.nodeName && nodeIds.get(pod.spec.nodeName);
        if (nodeId) link("runsOn", podId, nodeId);

        for (const c of containers) {
          const containerId = instanceId(cluster, ["namespace", namespace], ["pod", pod.metadata.name], ["container", c.name]);
          // A container's log records count for its pod (the error attributes name pods).
          add(containerId, MODEL.Container, c.name, c.ready ? "ok" : "warn", { image: c.image, ready: c.ready, restarts: c.restartCount }, { [NAMESPACE_ATTR]: namespace, [POD_ATTR]: pod.metadata.name, [CONTAINER_ATTR]: c.name });
          link(CONTAINS, podId, containerId);
        }
      }
    }
  }
  return { twins, relationships };
}
