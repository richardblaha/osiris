import type { TwinSource } from "../../twin.ts";
import { clusterGraph, NAMESPACE_ATTR, NODE_ATTR, POD_ATTR } from "./graph.ts";
import type { Kube } from "./kube.ts";
import { dtdlModel } from "./models.ts";

/**
 * The Kubernetes adapter: the cluster's structure straight from its API (namespaces, pods, nodes, ReplicaSets for
 * the Deployments), read-only. Error counts come from the pods' logs and network load from kubeletstats' counters,
 * named by OpenTelemetry's k8s attributes.
 */
export function kubernetesSource(kube: Kube, clusterName: string): TwinSource {
  return {
    name: "kubernetes",
    models: dtdlModel,
    errorAttributes: [NAMESPACE_ATTR, POD_ATTR],
    // kubeletstats' network counters: a node's and a pod's.
    networkMetrics: [
      { metric: "k8s.node.network.io", attributes: [NODE_ATTR] },
      { metric: "k8s.pod.network.io", attributes: [NAMESPACE_ATTR, POD_ATTR] },
    ],
    async snapshot() {
      const [namespaces, pods, nodes, replicasets, version] = await Promise.all([
        kube.namespaces(),
        kube.pods(),
        kube.nodes(),
        // Without ReplicaSets a Deployment's pods group under the ReplicaSet: worse, still a twin.
        kube.replicasets().catch(() => []),
        kube.version(),
      ]);
      return clusterGraph({ clusterName, namespaces, pods, nodes, replicasets, version });
    },
  };
}
