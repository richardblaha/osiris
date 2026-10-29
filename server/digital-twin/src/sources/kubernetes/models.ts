import { DTDL_CONTEXT, type DtdlContent, type DtdlInterface, type DtdlSchema, type Localized } from "@osiris/shared/dtdl.ts";
import { TWIN_CONTAINS, TWIN_ENTITY_MODEL } from "@osiris/shared";

/**
 * The Kubernetes adapter's models in DTDL v3 (https://github.com/Azure/opendigitaltwins-dtdl): one interface per kind
 * of object, each extending the twin's base Entity; containment and placement as relationships.
 */
export const MODEL = {
  Entity: TWIN_ENTITY_MODEL,
  Cluster: "dtmi:osiris:k8s:Cluster;2",
  Namespace: "dtmi:osiris:k8s:Namespace;2",
  Workload: "dtmi:osiris:k8s:Workload;2",
  Pod: "dtmi:osiris:k8s:Pod;2",
  Container: "dtmi:osiris:k8s:Container;2",
  Node: "dtmi:osiris:k8s:Node;2",
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
const contains = (target: string, description: string): DtdlContent => ({ "@type": "Relationship", name: TWIN_CONTAINS, target, displayName: l("contains", "obsahuje"), description });
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
    iface(MODEL.Cluster, l("Cluster", "Klastr"), "A Kubernetes cluster: its namespaces and nodes.", [
      property("version", "string", l("Kubernetes version", "Verze Kubernetes")),
      property("kubelet", "string", l("Kubelet version", "Verze kubeletu")),
      property("nodeCount", "integer", l("Nodes", "Nody")),
      property("podCount", "integer", l("Pods", "Pody")),
      contains(MODEL.Namespace, "The cluster's namespaces."),
      { "@type": "Relationship", name: "hasNode", target: MODEL.Node, displayName: l("has node", "má node"), description: "The machines the cluster runs on." },
    ]),
    iface(MODEL.Namespace, l("Namespace", "Namespace"), "A Kubernetes namespace.", [
      property("phase", enumOf("active", "terminating"), l("Phase", "Fáze")),
      contains(MODEL.Workload, "The namespace's workloads, as its pods group by owner."),
    ]),
    iface(MODEL.Workload, l("Workload", "Workload"), "What a group of pods belongs to: a Deployment (through its ReplicaSet), a StatefulSet, a DaemonSet, a Job or a lone Pod.", [
      property("ownerKind", "string", l("Kind", "Druh")),
      property("podCount", "integer", l("Pods", "Pody")),
      property("readyCount", "integer", l("Pods ready", "Připravené pody")),
      contains(MODEL.Pod, "The workload's pods."),
    ]),
    iface(MODEL.Pod, l("Pod", "Pod"), "A pod and its containers.", [
      property("phase", enumOf("pending", "running", "succeeded", "failed", "unknown"), l("Phase", "Fáze")),
      property("nodeName", "string", l("Node", "Node")),
      property("ip", "string", l("IP address", "IP adresa")),
      property("readyCount", "integer", l("Containers ready", "Připravené kontejnery")),
      property("containerCount", "integer", l("Containers", "Kontejnery")),
      property("restarts", "integer", l("Restarts", "Restarty"), "Container restarts, summed over the pod."),
      contains(MODEL.Container, "The pod's containers."),
      { "@type": "Relationship", name: "runsOn", target: MODEL.Node, displayName: l("runs on", "běží na"), description: "The node the pod is scheduled on." },
    ]),
    iface(MODEL.Container, l("Container", "Kontejner"), "One container of a pod.", [
      property("image", "string", l("Image", "Image")),
      property("ready", "boolean", l("Ready", "Připraven")),
      property("restarts", "integer", l("Restarts", "Restarty")),
    ]),
    iface(MODEL.Node, l("Node", "Node"), "A machine of the cluster: not Ready is an error, memory, disk or PID pressure a warning.", [
      property("kubelet", "string", l("Kubelet version", "Verze kubeletu")),
      property("os", "string", l("Operating system", "Operační systém")),
      property("cpu", "string", l("CPU capacity", "Kapacita CPU")),
      property("memory", "string", l("Memory capacity", "Kapacita paměti")),
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
