/**
 * The twin's structure in the Digital Twins Definition Language v2 (DTDL, an open JSON-LD standard,
 * https://github.com/Azure/azure-digital-twins): one interface per node kind, the nesting as relationships. The
 * twin's nodes are instances of these interfaces; `/api/twin` carries their `@id` and `model`.
 */

export const MODEL = {
  Cluster: "dtmi:osiris:k8s:Cluster;1",
  Namespace: "dtmi:osiris:k8s:Namespace;1",
  Workload: "dtmi:osiris:k8s:Workload;1",
  Pod: "dtmi:osiris:k8s:Pod;1",
  Container: "dtmi:osiris:k8s:Container;1",
} as const;

const phase = {
  "@type": "Enum",
  name: "phase",
  schema: "string",
  enumValues: ["pending", "running", "succeeded", "failed", "unknown"].map((v) => ({ name: v, enumValue: v })),
};

/** The interface documents (DTDL v2) the twin's nodes instantiate. */
export function dtdlModel() {
  const doc = (id: string, displayName: string, description: string, contents: unknown[]) => ({
    "@context": "dtmi:dtdl:context;2",
    "@id": id,
    "@type": "Interface",
    displayName,
    description,
    contents,
  });
  return [
    doc(
      MODEL.Cluster,
      "Kubernetes cluster",
      "The cluster as a whole: its namespaces and nodes.",
      [
        { "@type": "Property", name: "name", schema: "string", description: "The cluster's name, as configured." },
        { "@type": "Property", name: "version", schema: "string", description: "The API server's Kubernetes version." },
        { "@type": "Telemetry", name: "pods", schema: "long", description: "Pods in the cluster." },
        { "@type": "Telemetry", name: "errorLogs", schema: "long", description: "Error log records of the last 15 minutes (ClickHouse)." },
        { "@type": "Relationship", name: "contains", target: MODEL.Namespace, description: "The cluster's namespaces." },
      ],
    ),
    doc(
      MODEL.Namespace,
      "Namespace",
      "A Kubernetes namespace.",
      [
        { "@type": "Property", name: "name", schema: "string", description: "The namespace's name." },
        phase,
        { "@type": "Telemetry", name: "errorLogs", schema: "long", description: "Error log records of the last 15 minutes (ClickHouse)." },
        { "@type": "Relationship", name: "contains", target: MODEL.Workload, description: "The namespace's workloads, as pods group by owner." },
      ],
    ),
    doc(
      MODEL.Workload,
      "Workload",
      "What a group of pods belongs to: a Deployment (through its ReplicaSet), a StatefulSet, a DaemonSet, a Job or a lone Pod.",
      [
        { "@type": "Property", name: "name", schema: "string", description: "The workload's name." },
        { "@type": "Property", name: "kind", schema: "string", description: "The owning object's kind." },
        { "@type": "Property", name: "ready", schema: "long", description: "Pods ready of all." },
        { "@type": "Telemetry", name: "errorLogs", schema: "long", description: "Error log records of the last 15 minutes (ClickHouse)." },
        { "@type": "Relationship", name: "contains", target: MODEL.Pod, description: "The workload's pods." },
      ],
    ),
    doc(
      MODEL.Pod,
      "Pod",
      "A pod and its containers.",
      [
        { "@type": "Property", name: "name", schema: "string", description: "The pod's name." },
        phase,
        { "@type": "Property", name: "node", schema: "string", description: "The node the pod runs on." },
        { "@type": "Telemetry", name: "restarts", schema: "long", description: "Container restarts, summed over the pod." },
        { "@type": "Telemetry", name: "errorLogs", schema: "long", description: "Error log records of the last 15 minutes (ClickHouse)." },
        { "@type": "Relationship", name: "contains", target: MODEL.Container, description: "The pod's containers." },
      ],
    ),
    doc(
      MODEL.Container,
      "Container",
      "One container of a pod.",
      [
        { "@type": "Property", name: "name", schema: "string", description: "The container's name." },
        { "@type": "Property", name: "image", schema: "string", description: "The image the container runs." },
        { "@type": "Property", name: "ready", schema: "boolean", description: "Whether the container is ready." },
        { "@type": "Telemetry", name: "restarts", schema: "long", description: "The container's restarts." },
        { "@type": "Telemetry", name: "errorLogs", schema: "long", description: "Error log records of the last 15 minutes (ClickHouse)." },
      ],
    ),
  ];
}

/**
 * An instance's id: the path of kinds and names from the cluster down (`k8s:busiris/namespace/osiris/…`). DTDL keeps
 * `dtmi:` for the models; an instance id is any unique string (like Azure Digital Twins' `$dtId`). Names within a
 * parent are unique per kind, and each segment is escaped, so two objects never share an id.
 */
export const instanceId = (cluster: string, ...path: [kind: string, name: string][]) =>
  `k8s:${[cluster, ...path.flatMap(([kind, name]) => [kind, name])].map(encodeURIComponent).join("/")}`;
