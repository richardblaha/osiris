import { DTDL_CONTEXT, type DtdlContent, type DtdlInterface, type DtdlSchema, type Localized } from "@osiris/shared/dtdl.ts";
import { TWIN_CONTAINS, TWIN_ENTITY_MODEL } from "@osiris/shared";

/**
 * The Kubernetes adapter's models in DTDL v3 (https://github.com/Azure/opendigitaltwins-dtdl): one interface per kind
 * of object, each extending the twin's base Entity. Containment is physical: the cluster contains its nodes, a node
 * the pods scheduled on it, a pod its containers and the claims it mounts (a claim mounted by several pods sits in the
 * first; one no pod mounts, in the cluster). Namespaces and workloads group pods by relationships instead.
 */
export const MODEL = {
  Entity: TWIN_ENTITY_MODEL,
  Cluster: "dtmi:osiris:k8s:Cluster;3",
  Namespace: "dtmi:osiris:k8s:Namespace;3",
  Workload: "dtmi:osiris:k8s:Workload;3",
  Pod: "dtmi:osiris:k8s:Pod;3",
  Container: "dtmi:osiris:k8s:Container;3",
  Node: "dtmi:osiris:k8s:Node;3",
  PersistentVolumeClaim: "dtmi:osiris:k8s:PersistentVolumeClaim;1",
} as const;

const enumOf = (...values: string[]): DtdlSchema => ({ "@type": "Enum", valueSchema: "string", enumValues: values.map((v) => ({ name: v, enumValue: v })) });
/** English and Czech, the languages of the views. */
const l = (en: string, cs: string): Localized => ({ en, cs });
const property = (name: string, schema: DtdlSchema, displayName: Localized, description?: string): DtdlContent => ({
  "@type": "Property",
  name,
  schema,
  displayName,
  ...(description ? { description } : {}),
});
const contains = (target: string | undefined, description: string): DtdlContent => ({
  "@type": "Relationship",
  name: TWIN_CONTAINS,
  ...(target ? { target } : {}),
  displayName: l("contains", "obsahuje"),
  description,
});
const relationship = (name: string, target: string, displayName: Localized, description: string): DtdlContent => ({ "@type": "Relationship", name, target, displayName, description });
/** Bytes per second through a node's or a pod's network interfaces, the load the view animates. */
const network: DtdlContent = {
  "@type": "Telemetry",
  name: "network",
  schema: "double",
  displayName: l("Network", "Síť"),
  description: "Bytes per second received and sent, averaged over the last 5 minutes.",
};
const iface = (id: string, displayName: Localized, description: string, contents: DtdlContent[], base = true): DtdlInterface => ({
  "@context": DTDL_CONTEXT,
  "@id": id,
  "@type": "Interface",
  displayName,
  description,
  ...(base ? { extends: MODEL.Entity } : {}),
  contents,
});

/** The DTDL v3 interfaces the Kubernetes twins instantiate, the base Entity first. */
export function dtdlModel(): DtdlInterface[] {
  return [
    iface(
      MODEL.Entity,
      l("Entity", "Entita"),
      "Anything the twin mirrors: its name, its status and where its telemetry is.",
      [
        property("name", "string", l("Name", "Název")),
        property("status", enumOf("ok", "warn", "error"), l("Status", "Stav"), "The entity's own status; the views roll its children's up."),
        property(
          "otelResource",
          { "@type": "Map", mapKey: { name: "attribute", schema: "string" }, mapValue: { name: "value", schema: "string" } },
          l("Telemetry", "Telemetrie"),
          "The OpenTelemetry resource attributes naming the entity's logs, metrics and traces.",
        ),
        { "@type": "Telemetry", name: "errorLogs", schema: "integer", displayName: l("Error logs", "Chybové logy"), description: "Error log records of the last 15 minutes." },
      ],
      false,
    ),
    iface(MODEL.Cluster, l("Cluster", "Klastr"), "A Kubernetes cluster: its nodes (and the pods not scheduled yet) and its namespaces.", [
      property("version", "string", l("Kubernetes version", "Verze Kubernetes")),
      property("kubelet", "string", l("Kubelet version", "Verze kubeletu")),
      property("nodeCount", "integer", l("Nodes", "Nody")),
      property("podCount", "integer", l("Pods", "Pody")),
      contains(undefined, "The cluster's nodes, and the pods no node runs yet."),
      relationship("hasNamespace", MODEL.Namespace, l("has namespace", "má namespace"), "The cluster's namespaces."),
    ]),
    iface(MODEL.Namespace, l("Namespace", "Namespace"), "A Kubernetes namespace: its status is its worst pod's.", [
      property("phase", enumOf("active", "terminating"), l("Phase", "Fáze")),
      property("podCount", "integer", l("Pods", "Pody")),
      relationship("hasWorkload", MODEL.Workload, l("has workload", "má workload"), "The namespace's workloads, as its pods group by owner."),
      relationship("hasClaim", MODEL.PersistentVolumeClaim, l("has volume claim", "má svazek"), "The namespace's PersistentVolumeClaims."),
    ]),
    iface(MODEL.Workload, l("Workload", "Workload"), "What a group of pods belongs to: a Deployment (through its ReplicaSet), a StatefulSet, a DaemonSet, a Job or a lone Pod. Its status is its worst pod's.", [
      property("ownerKind", "string", l("Kind", "Druh")),
      property("podCount", "integer", l("Pods", "Pody")),
      property("readyCount", "integer", l("Pods ready", "Připravené pody")),
      relationship("hasPod", MODEL.Pod, l("has pod", "má pod"), "The workload's pods."),
    ]),
    iface(MODEL.Pod, l("Pod", "Pod"), "A pod and its containers.", [
      property("phase", enumOf("pending", "running", "succeeded", "failed", "unknown"), l("Phase", "Fáze")),
      property("nodeName", "string", l("Node", "Node")),
      property("ip", "string", l("IP address", "IP adresa")),
      property("readyCount", "integer", l("Containers ready", "Připravené kontejnery")),
      property("containerCount", "integer", l("Containers", "Kontejnery")),
      property("restarts", "integer", l("Restarts", "Restarty"), "Container restarts, summed over the pod."),
      property("namespace", "string", l("Namespace", "Namespace")),
      contains(undefined, "The pod's containers, and the volume claims it mounts."),
      network,
    ]),
    iface(MODEL.Container, l("Container", "Kontejner"), "One container of a pod.", [
      property("image", "string", l("Image", "Image")),
      property("ready", "boolean", l("Ready", "Připraven")),
      property("restarts", "integer", l("Restarts", "Restarty")),
      relationship("mounts", MODEL.PersistentVolumeClaim, l("mounts", "připojuje"), "The volume claims the container mounts."),
    ]),
    iface(MODEL.PersistentVolumeClaim, l("Volume claim", "Svazek (PVC)"), "A PersistentVolumeClaim: storage a pod mounts; pending is a warning, lost an error.", [
      property("phase", enumOf("pending", "bound", "lost"), l("Phase", "Fáze")),
      property("capacity", "string", l("Capacity", "Kapacita"), "The bound volume's size as Kubernetes states it (else the request), e.g. 10Gi."),
      property("storageClass", "string", l("Storage class", "Třída úložiště")),
      property("accessModes", "string", l("Access modes", "Režimy přístupu")),
      property("volumeName", "string", l("Volume", "Svazek")),
      {
        "@type": "Telemetry",
        name: "used",
        schema: "double",
        displayName: l("Used", "Obsazeno"),
        description: "Bytes used on the filesystem the volume is on (kubeletstats).",
      },
      {
        "@type": "Telemetry",
        name: "fsCapacity",
        schema: "double",
        displayName: l("Filesystem size", "Velikost souborového systému"),
        description: "Bytes of the filesystem the volume is on (kubeletstats); with local volumes, the node's disk.",
      },
    ]),
    iface(MODEL.Node, l("Node", "Node"), "A machine of the cluster: not Ready is an error, memory, disk or PID pressure a warning.", [
      property("kubelet", "string", l("Kubelet version", "Verze kubeletu")),
      property("os", "string", l("Operating system", "Operační systém")),
      property("cpu", "string", l("CPU capacity", "Kapacita CPU")),
      property("memory", "string", l("Memory capacity", "Kapacita paměti")),
      contains(MODEL.Pod, "The pods scheduled on the node."),
      network,
    ]),
  ];
}

/**
 * A twin's id (ADT's `$dtId`, any unique string): the path of kinds and names from the cluster down
 * (`k8s:busiris/namespace/osiris/…`). Names within a parent are unique per kind, and each segment is escaped, so two
 * objects never share an id.
 */
export const instanceId = (cluster: string, ...path: [kind: string, name: string][]) =>
  `k8s:${[cluster, ...path.flatMap(([kind, name]) => [kind, name])].map(encodeURIComponent).join("/")}`;
