import type { TwinSource } from "../../twin.ts";
import { clusterGraph, NAMESPACE_ATTR, NODE_ATTR, POD_ATTR, PVC_ATTR } from "./graph.ts";
import { readCeph } from "./ceph.ts";
import type { Kube } from "./kube.ts";
import { dtdlModel } from "./models.ts";

/**
 * The Kubernetes adapter: the cluster's structure straight from its API (namespaces, pods, nodes, ReplicaSets for
 * the Deployments, PersistentVolumeClaims), read-only. Error counts come from the pods' logs and network load from kubeletstats' counters,
 * named by OpenTelemetry's k8s attributes.
 */
export function kubernetesSource(kube: Kube, clusterName: string, options: { cephManagers?: string[]; fetchFn?: typeof fetch } = {}): TwinSource {
  return {
    name: "kubernetes",
    models: dtdlModel,
    errorAttributes: [NAMESPACE_ATTR, POD_ATTR],
    // kubeletstats' network counters: a node's and a pod's.
    networkMetrics: [
      { metric: "k8s.node.network.io", attributes: [NODE_ATTR] },
      { metric: "k8s.pod.network.io", attributes: [NAMESPACE_ATTR, POD_ATTR] },
    ],
    // kubeletstats' volume gauges: the filesystem a claim's volume is on, and how much of it is free.
    storageMetrics: { capacity: "k8s.volume.capacity", available: "k8s.volume.available", attributes: [NAMESPACE_ATTR, PVC_ATTR] },
    async snapshot() {
      const [namespaces, pods, nodes, pvcs, pvs, replicasets, version, ceph] = await Promise.all([
        kube.namespaces(),
        kube.pods(),
        kube.nodes(),
        // Without the right to list claims (an older ClusterRole) the twin goes without them.
        kube.persistentVolumeClaims().catch(() => []),
        kube.persistentVolumes().catch(() => []),
        // Without ReplicaSets a Deployment's pods group under the ReplicaSet: worse, still a twin.
        kube.replicasets().catch(() => []),
        kube.version(),
        options.cephManagers?.length ? readCeph(options.cephManagers, options.fetchFn) : Promise.resolve(undefined),
      ]);
      return clusterGraph({ clusterName, namespaces, pods, nodes, pvcs, pvs, replicasets, version, ceph });
    },
  };
}
