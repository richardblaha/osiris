import { DATA_CONTEXT, DTDL_CONTEXT, type DtdlContent, type DtdlInterface, type DtdlSchema, type Localized } from "@osiris/shared/dtdl.ts";
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
  Ceph: "dtmi:osiris:ceph:Cluster;1",
  CephPool: "dtmi:osiris:ceph:Pool;1",
  CephOsd: "dtmi:osiris:ceph:Osd;1",
  Interface: "dtmi:osiris:net:Interface;1",
  Service: "dtmi:osiris:k8s:Service;1",
  Ingress: "dtmi:osiris:k8s:Ingress;1",
  Cpu: "dtmi:osiris:hw:Cpu;1",
  CpuCore: "dtmi:osiris:hw:CpuCore;1",
  Memory: "dtmi:osiris:hw:Memory;1",
  Disk: "dtmi:osiris:hw:Disk;1",
  Port: "dtmi:osiris:hw:Port;1",
  Switch: "dtmi:osiris:net:Switch;1",
  Router: "dtmi:osiris:net:Router;1",
  Firewall: "dtmi:osiris:net:Firewall;1",
  AccessPoint: "dtmi:osiris:net:AccessPoint;1",
} as const;
import { sourceProfile } from "./readings.ts";

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
const relationship = (name: string, target: string | undefined, displayName: Localized, description: string): DtdlContent => ({
  "@type": "Relationship",
  name,
  ...(target ? { target } : {}),
  displayName,
  description,
});
/** Bytes per second through a node's or a pod's network interfaces, the load the view animates. */
const network: DtdlContent = {
  "@type": "Telemetry",
  name: "network",
  schema: "double",
  displayName: l("Network", "Síť"),
  description: "Bytes per second received and sent, averaged over the last 5 minutes.",
};
/** A share from 0 to 1: a CPU's or a core's busy time, memory or a filesystem used. */
const load = (description: string): DtdlContent => ({ "@type": "Telemetry", name: "load", schema: "double", displayName: l("Load", "Zatížení"), description });
/** What a container or a pod uses of its node: CPU in cores, memory in bytes (kubeletstats). */
const usage: DtdlContent[] = [
  { "@type": "Telemetry", name: "cpu", schema: "double", displayName: l("CPU (cores)", "CPU (jádra)"), description: "CPU used, in cores, averaged by the kubelet." },
  { "@type": "Telemetry", name: "memory", schema: "double", displayName: l("Memory", "Paměť"), description: "The working set, in bytes." },
];
/** A part's temperature in degrees Celsius (node-exporter's hwmon sensors). */
const temperature: DtdlContent = {
  "@type": "Telemetry",
  name: "temperature",
  schema: "double",
  displayName: l("Temperature", "Teplota"),
  description: "Degrees Celsius (node-exporter's node_hwmon_temp_celsius), the hottest of the part's sensors.",
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
  return withSources([
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
      relationship("hasService", MODEL.Service, l("has service", "má službu"), "The namespace's Services."),
      relationship("hasIngress", MODEL.Ingress, l("has ingress", "má ingress"), "The namespace's Ingresses and IngressRoutes."),
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
      ...usage,
    ]),
    iface(MODEL.Container, l("Container", "Kontejner"), "One container of a pod.", [
      property("image", "string", l("Image", "Image")),
      property("ready", "boolean", l("Ready", "Připraven")),
      property("restarts", "integer", l("Restarts", "Restarty")),
      relationship("mounts", MODEL.PersistentVolumeClaim, l("mounts", "připojuje"), "The volume claims the container mounts."),
      { "@type": "Relationship", name: "runsOn", displayName: l("runs on", "běží na"), description: "The CPU and the memory of the node the container runs on." },
      ...usage,
    ]),
    iface(MODEL.Interface, l("Network interface", "Síťové rozhraní"), "A point where traffic enters or leaves: a node's network card, its router (Calico routes, no bridge), the bridge of a bridge CNI (flannel's cni0), its VXLAN tunnel, a pod's eth0, a LoadBalancer address (MetalLB), the public address the internet reaches, an external service reached through the internet, a Wi-Fi network of an access point.", [
      property("kind", enumOf("physical", "router", "bridge", "tunnel", "veth", "loadbalancer", "public", "external", "wifi"), l("Kind", "Druh")),
      property("ip", "string", l("IP address", "IP adresa")),
      property("cidr", "string", l("Network", "Síť")),
      property("ports", "string", l("Ports", "Porty")),
      property("url", "string", l("URL", "URL"), "An external service's address on the internet."),
      relationship("connectedTo", MODEL.Interface, l("connected to", "propojeno s"), "The interfaces traffic goes on to."),
      relationship("exposes", MODEL.Service, l("exposes", "zpřístupňuje"), "The Service a LoadBalancer address belongs to."),
    ]),
    iface(MODEL.Service, l("Service", "Služba"), "A Service: a virtual address in front of pods. No ready endpoint while it selects pods is a warning.", [
      property("type", "string", l("Type", "Typ")),
      property("clusterIP", "string", l("Cluster IP", "Cluster IP")),
      property("ports", "string", l("Ports", "Porty")),
      property("externalIP", "string", l("External address", "Vnější adresa")),
      property("readyEndpoints", "integer", l("Ready endpoints", "Připravené cíle")),
      relationship("routesTo", MODEL.Pod, l("routes to", "směruje na"), "The pods its endpoints are."),
    ]),
    iface(MODEL.Ingress, l("Ingress", "Ingress"), "An Ingress or Traefik IngressRoute: hosts and paths from outside to Services. A route to a Service that doesn't exist is an error.", [
      property("kind", "string", l("Kind", "Druh")),
      property("hosts", "string", l("Hosts", "Hostitelé")),
      property("routes", "string", l("Routes", "Trasy"), "One line per route: host and path → service:port."),
      property("tls", "boolean", l("TLS", "TLS")),
      property("ingressClass", "string", l("Ingress class", "Třída ingressu")),
      relationship("routesTo", MODEL.Service, l("routes to", "směruje na"), "The Services its routes end at."),
      relationship("servedBy", MODEL.Interface, l("served by", "obsluhuje"), "The LoadBalancer address its traffic comes in at."),
    ]),
    iface(MODEL.Ceph, l("Ceph cluster", "Ceph cluster"), "The Ceph storage the cluster's volumes live on, as its active manager reports it: its pools, and its OSDs (disks) in the nodes they're in.", [
      property("health", enumOf("ok", "warn", "error"), l("Health", "Zdraví")),
      property("version", "string", l("Version", "Verze")),
      property("osdCount", "integer", l("OSDs", "OSD")),
      property("osdUp", "integer", l("OSDs up", "OSD běží")),
      property("osdIn", "integer", l("OSDs in", "OSD v clusteru")),
      property("monitors", "integer", l("Monitors", "Monitory")),
      property("quorum", "integer", l("Monitors in quorum", "Monitory v kvóru")),
      property("pgTotal", "integer", l("Placement groups", "Placement groups")),
      property("pgClean", "integer", l("PGs active+clean", "PG active+clean")),
      property("pgDegraded", "integer", l("PGs degraded", "PG degradované")),
      property("checks", "string", l("Health checks", "Kontroly zdraví"), "The raised health checks, with their severity."),
      property("readRate", "double", l("Client reads (B/s)", "Čtení klientů (B/s)")),
      property("writeRate", "double", l("Client writes (B/s)", "Zápis klientů (B/s)")),
      property("size", "double", l("Raw capacity", "Hrubá kapacita"), "Bytes of all OSDs."),
      property("used", "double", l("Raw used", "Hrubě obsazeno"), "Bytes used on all OSDs."),
      contains(undefined, "The cluster's pools, and the disks of hosts the Kubernetes cluster doesn't know."),
      relationship("hasOsd", undefined, l("has OSD", "má OSD"), "The cluster's OSDs — on a USB data disk the disk twin itself carries the OSD (merged), else a Ceph OSD twin."),
    ]),
    iface(MODEL.CephPool, l("Ceph pool", "Ceph pool"), "A pool: what it stores and what it may still take.", [
      property("poolId", "integer", l("Pool id", "ID poolu")),
      property("size", "double", l("Usable size", "Využitelná velikost"), "Stored bytes plus the bytes it may still take."),
      property("used", "double", l("Stored", "Uloženo")),
      relationship("holds", MODEL.PersistentVolumeClaim, l("holds", "drží"), "The volume claims whose volumes are images in the pool."),
    ]),
    iface(MODEL.CephOsd, l("Disk (OSD)", "Disk (OSD)"), "A disk Ceph stores data on, in the node it is in: down is an error, out a warning.", [
      property("osdId", "integer", l("OSD id", "ID OSD")),
      property("device", "string", l("Device", "Zařízení")),
      property("model", "string", l("Model", "Model")),
      property("dbDevice", "string", l("DB device", "Zařízení DB")),
      property("deviceClass", "string", l("Device class", "Třída zařízení")),
      property("ip", "string", l("IP address", "IP adresa"), "The OSD's public address."),
      property("up", "boolean", l("Up", "Běží")),
      property("in", "boolean", l("In", "V clusteru")),
      property("size", "double", l("Size", "Velikost"), "The disk's bytes, where the manager reports them."),
      property("used", "double", l("Used", "Obsazeno"), "The disk's used bytes, where the manager reports them."),
      property("fill", "double", l("Fill", "Zaplnění"), "Used of size; where the manager reports no per-OSD bytes, the cluster's raw fill (Ceph spreads data by weight)."),
      relationship("dbOn", MODEL.Disk, l("keeps its DB on", "má DB na"), "The disk holding the OSD's RocksDB and WAL (an LVM volume on the node's internal disk)."),
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
      property("ip", "string", l("IP address", "IP adresa"), "The node's InternalIP."),
      property("role", { "@type": "Enum", valueSchema: "string", enumValues: [{ name: "controlPlane", enumValue: "control-plane" }, { name: "worker", enumValue: "worker" }] }, l("Role", "Role"), "A control plane (its labels say so) or a worker."),
      contains(undefined, "The pods scheduled on the node, and its hardware: CPU, memory, disks and USB ports."),
      network,
    ]),
    iface(MODEL.Cpu, l("CPU", "CPU"), "The node's processor: its cores, how busy they are together and how hot it is.", [
      property("cores", "integer", l("Cores", "Jádra"), "Logical CPUs the kubelet reports."),
      load("Busy share of all cores (kubeletstats' k8s.node.cpu.usage over the cores)."),
      temperature,
      contains(MODEL.CpuCore, "The CPU's cores."),
    ]),
    iface(MODEL.CpuCore, l("CPU core", "Jádro CPU"), "One logical CPU.", [
      property("core", "integer", l("Core", "Jádro"), "Its number, from 0."),
      property("estimated", "boolean", l("Estimated", "Odhad"), "No per-core metric: the CPU's average stands in."),
      load("Busy share (hostmetrics' system.cpu.utilization: all but idle), else the CPU's average."),
    ]),
    iface(MODEL.Memory, l("Memory", "Paměť"), "The node's RAM: how full it is and how hot it is.", [
      property("capacity", "double", l("Capacity", "Kapacita"), "Bytes."),
      load("Working set of the capacity."),
      { "@type": "Telemetry", name: "bytesUsed", schema: "double", displayName: l("Used", "Využito"), description: "The node's working set, in bytes (kubeletstats)." },
      temperature,
    ]),
    iface(MODEL.Disk, l("Disk", "Disk"), "A physical disk of the node: internal (NVMe, SATA, eMMC) or attached over USB. A USB data disk carries only its Ceph OSD, so the two are one twin here: the disk also holds the OSD's id, state and fill. An OSD on an internal disk is inside it.", [
      property("device", "string", l("Device", "Zařízení")),
      property("model", "string", l("Model", "Model")),
      property("serial", "string", l("Serial number", "Sériové číslo")),
      property("bus", enumOf("nvme", "sata", "usb", "mmc", "unknown"), l("Bus", "Sběrnice")),
      property("internal", "boolean", l("Internal", "Interní")),
      property("size", "double", l("Size", "Velikost"), "Bytes, where known (an OSD's disk: the OSD's)."),
      property("osdId", "integer", l("OSD id", "ID OSD"), "The Ceph OSD this USB disk carries (merged with the disk), when it does."),
      property("up", "boolean", l("OSD up", "OSD běží")),
      property("in", "boolean", l("OSD in", "OSD v clusteru")),
      property("deviceClass", "string", l("Device class", "Třída zařízení")),
      property("dbDevice", "string", l("DB device", "Zařízení DB")),
      property("used", "double", l("Used", "Obsazeno"), "Bytes used on the disk (a Ceph OSD's data)."),
      property("fill", "double", l("Fill", "Zaplnění"), "Used of size."),
      load("The node's root filesystem used of its size (kubeletstats), for the disk it is on."),
      { "@type": "Telemetry", name: "io", schema: "double", displayName: l("I/O", "I/O"), description: "Bytes per second read and written (hostmetrics' system.disk.io)." },
      temperature,
      contains(MODEL.CephOsd, "The Ceph OSD storing its data on an internal disk."),
      relationship("dbOn", MODEL.Disk, l("keeps its DB on", "má DB na"), "The disk holding the OSD's RocksDB and WAL (an LVM volume on the node's internal disk)."),
    ]),
    iface(MODEL.Port, l("Port", "Port"), "A physical port of the node: USB with what is attached to it.", [
      property("kind", enumOf("usb", "lan"), l("Kind", "Druh")),
      relationship("attaches", MODEL.Disk, l("attaches", "připojuje"), "The disk plugged into the port."),
    ]),
    iface(MODEL.Switch, l("Switch", "Switch"), "The Ethernet switch the nodes' network cards are plugged into: a port per node and its uplink to the router.", [
      property("model", "string", l("Make and model", "Výrobce a model")),
      property("portCount", "integer", l("Ports used", "Použité porty")),
      contains(MODEL.Interface, "Its Ethernet ports."),
    ]),
    iface(MODEL.Router, l("Router", "Router"), "The router between the LAN and the internet: the switch on its LAN port, the internet on its WAN port.", [
      property("model", "string", l("Make and model", "Výrobce a model")),
      contains(MODEL.Interface, "Its LAN and WAN ports."),
    ]),
    iface(MODEL.Firewall, l("Firewall", "Firewall"), "The one box as big as a machine, on top of the stack, holding the cluster's whole virtual network: the Ingresses and IngressRoutes, the Services with their endpoints, and the LoadBalancer addresses — the wall between the internet and the cluster.", [
      property("model", "string", l("Make and model", "Výrobce a model")),
      contains(undefined, "The cluster's Ingresses, Services and LoadBalancer addresses."),
    ]),
    iface(MODEL.AccessPoint, l("Access point", "Přístupový bod"), "A Wi-Fi access point of the LAN: its uplink on a switch port, its Wi-Fi network on a wireless port.", [
      property("model", "string", l("Make and model", "Výrobce a model")),
      property("ssid", "string", l("Wi-Fi network", "Wi-Fi síť")),
      contains(MODEL.Interface, "Its Ethernet uplink and its Wi-Fi port."),
    ]),
  ]);
}

/** Each model with where its values come from (`sourceProfile`): a data profile of the source's own readings. */
const withSources = (models: DtdlInterface[]): DtdlInterface[] =>
  models.map((m) => {
    const profile = sourceProfile(m["@id"]);
    return profile ? { ...m, "@context": [DTDL_CONTEXT, DATA_CONTEXT], dataProfiles: [profile] } : m;
  });

/**
 * A twin's id (ADT's `$dtId`, any unique string): the path of kinds and names from the cluster down
 * (`k8s:busiris/namespace/osiris/…`). Names within a parent are unique per kind, and each segment is escaped, so two
 * objects never share an id.
 */
export const instanceId = (cluster: string, ...path: [kind: string, name: string][]) =>
  `k8s:${[cluster, ...path.flatMap(([kind, name]) => [kind, name])].map(encodeURIComponent).join("/")}`;
