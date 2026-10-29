import type { TwinStatus } from "@osiris/shared";
import { CONTAINS, type SourceRelationship, type SourceSnapshot, type SourceTwin } from "../../twin.ts";
import type { CephState } from "./ceph.ts";
import type { NamespaceObject, NodeObject, PodObject, PvcObject, PvObject, ReplicaSetObject } from "./kube.ts";
import { instanceId, MODEL } from "./models.ts";

/** OpenTelemetry's Kubernetes resource attributes, as the collector's k8sattributes processor sets them. */
export const NAMESPACE_ATTR = "k8s.namespace.name";
export const POD_ATTR = "k8s.pod.name";
export const CONTAINER_ATTR = "k8s.container.name";
export const NODE_ATTR = "k8s.node.name";
export const PVC_ATTR = "k8s.persistentvolumeclaim.name";

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
  pvcs?: PvcObject[];
  /** PersistentVolumes: which pool a claim's volume is an image in. */
  pvs?: PvObject[];
  replicasets: ReplicaSetObject[];
  /** The Ceph cluster the volumes live on, when its manager is known. */
  ceph?: CephState;
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

const STATUSES: TwinStatus[] = ["ok", "warn", "error"];
const worst = (statuses: TwinStatus[]): TwinStatus => statuses.reduce((a, b) => (STATUSES.indexOf(b) > STATUSES.indexOf(a) ? b : a), "ok");

/**
 * The cluster as twins, nested the way the machines are: the cluster contains its nodes, a node the pods scheduled on
 * it (a pod no node runs yet is the cluster's own), a pod its containers and the volume claims it mounts (the first
 * pod's, by name; an unmounted claim is the cluster's), and containers mount claims. Namespaces and workloads (pods grouped by
 * owner) are twins too, related to their pods rather than containing them, with their worst pod's status. Each twin
 * is an instance of its DTDL interface (property values typed as the model says), with the OpenTelemetry attributes
 * that name its telemetry.
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
        ip: node.status?.addresses?.find((a) => a.type === "InternalIP")?.address ?? "",
      },
      { [NODE_ATTR]: node.metadata.name },
    );
    link(CONTAINS, root, id);
  }

  // Volume claims: each a twin, in the first pod (by name) that mounts it, else in the cluster.
  const claimIds = new Map<string, string>();
  const claimHolder = new Map<string, string>();
  for (const pod of [...input.pods].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)))
    for (const v of pod.spec.volumes ?? [])
      if (v.persistentVolumeClaim) {
        const key = `${pod.metadata.namespace}/${v.persistentVolumeClaim.claimName}`;
        if (!claimHolder.has(key)) claimHolder.set(key, instanceId(cluster, ["namespace", pod.metadata.namespace], ["pod", pod.metadata.name]));
      }
  for (const pvc of [...(input.pvcs ?? [])].sort((a, b) => `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`))) {
    const { name, namespace } = pvc.metadata;
    const id = instanceId(cluster, ["namespace", namespace], ["pvc", name]);
    claimIds.set(`${namespace}/${name}`, id);
    const p = (pvc.status?.phase ?? "pending").toLowerCase();
    add(
      id,
      MODEL.PersistentVolumeClaim,
      name,
      p === "lost" ? "error" : p === "bound" ? "ok" : "warn",
      {
        phase: ["pending", "bound", "lost"].includes(p) ? p : "pending",
        capacity: pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage ?? "",
        storageClass: pvc.spec?.storageClassName ?? "",
        accessModes: (pvc.spec?.accessModes ?? []).join(", "),
        volumeName: pvc.spec?.volumeName ?? "",
      },
      { [NAMESPACE_ATTR]: namespace, [PVC_ATTR]: name },
    );
    link("hasClaim", instanceId(cluster, ["namespace", namespace]), id);
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
    const workloads = [...byWorkload.values()].filter((w) => w.namespace === namespace).sort((a, b) => a.owner.name.localeCompare(b.owner.name));
    const nsPods = workloads.flatMap((w) => w.pods);
    add(
      nsId,
      MODEL.Namespace,
      namespace,
      worst(nsPods.map(podStatus)),
      { phase: (ns.status?.phase ?? "active").toLowerCase() === "terminating" ? "terminating" : "active", podCount: nsPods.length },
      { [NAMESPACE_ATTR]: namespace },
    );
    link("hasNamespace", root, nsId);

    for (const { owner: o, pods } of workloads) {
      // `workload-<kind>`: a lone pod is its own workload, and the two must not share an id.
      const workloadId = instanceId(cluster, ["namespace", namespace], [`workload-${o.kind.toLowerCase()}`, o.name]);
      add(
        workloadId,
        MODEL.Workload,
        o.name,
        worst(pods.map(podStatus)),
        { ownerKind: o.kind, podCount: pods.length, readyCount: pods.filter((p) => podStatus(p) === "ok").length },
        { [NAMESPACE_ATTR]: namespace },
      );
      link("hasWorkload", nsId, workloadId);

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
            namespace,
            ip: pod.status?.podIP ?? "",
            readyCount: containers.filter((c) => c.ready).length,
            containerCount: containers.length,
            restarts: containers.reduce((n, c) => n + c.restartCount, 0),
          },
          { [NAMESPACE_ATTR]: namespace, [POD_ATTR]: pod.metadata.name },
        );
        link("hasPod", workloadId, podId);
        link(CONTAINS, (pod.spec.nodeName && nodeIds.get(pod.spec.nodeName)) || root, podId);

        // The pod's volumes that are claims, by volume name.
        const claimOf = new Map((pod.spec.volumes ?? []).flatMap((v) => (v.persistentVolumeClaim ? [[v.name, `${namespace}/${v.persistentVolumeClaim.claimName}`] as const] : [])));
        for (const c of containers) {
          const containerId = instanceId(cluster, ["namespace", namespace], ["pod", pod.metadata.name], ["container", c.name]);
          // A container's log records count for its pod (the error attributes name pods).
          add(containerId, MODEL.Container, c.name, c.ready ? "ok" : "warn", { image: c.image, ready: c.ready, restarts: c.restartCount }, { [NAMESPACE_ATTR]: namespace, [POD_ATTR]: pod.metadata.name, [CONTAINER_ATTR]: c.name });
          link(CONTAINS, podId, containerId);
          const mounted = new Set((pod.spec.containers?.find((s) => s.name === c.name)?.volumeMounts ?? []).flatMap((m) => (claimOf.has(m.name) ? [claimIds.get(claimOf.get(m.name)!)] : [])));
          for (const claim of mounted) if (claim) link("mounts", containerId, claim);
        }
        for (const key of new Set(claimOf.values())) if (claimIds.has(key) && claimHolder.get(key) === podId) link(CONTAINS, podId, claimIds.get(key)!);
      }
    }
  }
  // Ceph: its pools in it, its OSDs in the nodes they're on (a disk of a host the cluster doesn't know: in Ceph).
  if (input.ceph) {
    const c = input.ceph;
    const cephId = instanceId(cluster, ["ceph", "ceph"]);
    add(cephId, MODEL.Ceph, "Ceph", c.health >= 2 ? "error" : c.health === 1 ? "warn" : "ok", {
      health: c.health >= 2 ? "error" : c.health === 1 ? "warn" : "ok",
      version: c.version,
      osdCount: c.osds.length,
      size: c.size,
      used: c.used,
    });
    link(CONTAINS, root, cephId);
    const fill = c.size > 0 ? c.used / c.size : 0;
    for (const o of c.osds) {
      const id = instanceId(cluster, ["ceph", "ceph"], ["osd", String(o.id)]);
      add(id, MODEL.CephOsd, `osd.${o.id}`, !o.up ? "error" : !o.in ? "warn" : "ok", {
        osdId: o.id,
        device: o.device,
        model: o.model,
        dbDevice: o.dbDevice,
        deviceClass: o.deviceClass,
        ip: o.address,
        up: o.up,
        in: o.in,
        fill,
      });
      link(CONTAINS, nodeIds.get(o.host) ?? cephId, id);
      link("hasOsd", cephId, id);
    }
    // A claim's pool: its volume's CSI attribute.
    const poolOfVolume = new Map((input.pvs ?? []).flatMap((pv) => (pv.spec?.csi?.volumeAttributes?.pool ? [[pv.metadata.name, pv.spec.csi.volumeAttributes.pool] as const] : [])));
    for (const p of c.pools) {
      const id = instanceId(cluster, ["ceph", "ceph"], ["pool", p.name]);
      add(id, MODEL.CephPool, p.name, "ok", { poolId: p.id, size: p.stored + p.maxAvailable, used: p.stored });
      link(CONTAINS, cephId, id);
      for (const pvc of input.pvcs ?? [])
        if (pvc.spec?.volumeName && poolOfVolume.get(pvc.spec.volumeName) === p.name) {
          const claim = claimIds.get(`${pvc.metadata.namespace}/${pvc.metadata.name}`);
          if (claim) link("holds", id, claim);
        }
    }
  }

  // A claim no pod mounts (or whose pod is gone) is the cluster's.
  const held = new Set(relationships.filter((r) => r.name === CONTAINS).map((r) => r.target));
  for (const id of claimIds.values()) if (!held.has(id)) link(CONTAINS, root, id);
  return { twins, relationships };
}
