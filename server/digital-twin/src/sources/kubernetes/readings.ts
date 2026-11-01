import { SOURCE_CONNECTION, type DataBinding, type DataProfile } from "@osiris/shared/dtdl.ts";
import { readingQuery, type Reading } from "../../telemetry.ts";
import { CONTAINER_ATTR, CPU_ATTR, DEVICE_ATTR, NAMESPACE_ATTR, NODE_ATTR, POD_ATTR, PVC_ATTR } from "./attrs.ts";

/**
 * Every reading the Kubernetes adapter takes from the cluster's telemetry in ClickHouse (what the OpenTelemetry
 * Collector's kubeletstats, hostmetrics and k8sattributes write), by name. The adapter reads these and nothing else,
 * and its models show them (`SOURCE_PROFILES`) as where each telemetry comes from, with the very query it runs.
 */
export const READINGS = {
  nodeNetwork: { read: "rate", metric: "k8s.node.network.io", attributes: [NODE_ATTR] },
  podNetwork: { read: "rate", metric: "k8s.pod.network.io", attributes: [NAMESPACE_ATTR, POD_ATTR] },
  errors: { read: "errors", attributes: [NAMESPACE_ATTR, POD_ATTR] },
  volumeCapacity: { read: "latest", metric: "k8s.volume.capacity", attributes: [NAMESPACE_ATTR, PVC_ATTR] },
  volumeAvailable: { read: "latest", metric: "k8s.volume.available", attributes: [NAMESPACE_ATTR, PVC_ATTR] },
  nodeCpu: { read: "latest", metric: "k8s.node.cpu.usage", attributes: [NODE_ATTR] },
  coreIdle: { read: "latest", metric: "system.cpu.utilization", attributes: [NODE_ATTR], points: [CPU_ATTR], where: { state: "idle" } },
  nodeMemory: { read: "latest", metric: "k8s.node.memory.working_set", attributes: [NODE_ATTR] },
  fsUsage: { read: "latest", metric: "k8s.node.filesystem.usage", attributes: [NODE_ATTR] },
  fsCapacity: { read: "latest", metric: "k8s.node.filesystem.capacity", attributes: [NODE_ATTR] },
  diskIo: { read: "rate", metric: "system.disk.io", attributes: [NODE_ATTR], points: [DEVICE_ATTR] },
  containerCpu: { read: "latest", metric: "container.cpu.usage", attributes: [NAMESPACE_ATTR, POD_ATTR, CONTAINER_ATTR] },
  containerMemory: { read: "latest", metric: "container.memory.working_set", attributes: [NAMESPACE_ATTR, POD_ATTR, CONTAINER_ATTR] },
  podCpu: { read: "latest", metric: "k8s.pod.cpu.usage", attributes: [NAMESPACE_ATTR, POD_ATTR] },
  podMemory: { read: "latest", metric: "k8s.pod.memory.working_set", attributes: [NAMESPACE_ATTR, POD_ATTR] },
} as const satisfies Record<string, Reading>;
export type ReadingName = keyof typeof READINGS;

/**
 * Where one telemetry or property of a model comes from: one of the readings (or two, with how they combine), the
 * cluster's API (`api`: the object and field), or the Ceph manager's Prometheus page (`ceph`: its metrics).
 */
type Origin =
  | { reading: ReadingName | ReadingName[]; formula?: string }
  | { api: string }
  | { ceph: string | string[]; formula?: string };

/** A binding to the source that tells where a value comes from: reading, metric, attributes and the query itself. */
function binding(telemetry: string, o: Origin): DataBinding {
  if ("api" in o) return { telemetry, connection: SOURCE_CONNECTION, reads: "kubernetes", path: o.api };
  if ("ceph" in o) return { telemetry, connection: SOURCE_CONNECTION, reads: "ceph", from: "CEPH_MANAGERS /metrics", metric: [o.ceph].flat().join(", "), ...(o.formula ? { formula: o.formula } : {}) };
  const names = [o.reading].flat();
  const readings = names.map((n) => READINGS[n] as Reading);
  return {
    telemetry,
    connection: SOURCE_CONNECTION,
    reads: "clickhouse",
    metric: readings.map((r) => r.metric ?? "otel_logs (severity ≥ error)").join(", "),
    by: [...new Set(readings.flatMap((r) => [...r.attributes, ...(r.points ?? [])]))].join(", "),
    ...(o.formula ? { formula: o.formula } : {}),
    // The query as the twin runs it (`{cluster:String}` only when the instance names its cluster).
    query: readings.map((r) => readingQuery(r, { cluster: "cluster" }).sql.replace(/\n\s+/g, "\n  ")).join("\n\n"),
  };
}

/** Each Kubernetes model's origins, by its telemetry or property name. */
const ORIGINS: Record<string, Record<string, Origin>> = {
  "dtmi:osiris:k8s:Node;3": {
    network: { reading: "nodeNetwork" },
    kubelet: { api: "GET /api/v1/nodes → status.nodeInfo.kubeletVersion" },
    os: { api: "GET /api/v1/nodes → status.nodeInfo.osImage" },
    cpu: { api: "GET /api/v1/nodes → status.capacity.cpu" },
    memory: { api: "GET /api/v1/nodes → status.capacity.memory" },
    ip: { api: "GET /api/v1/nodes → status.addresses[InternalIP]" },
    role: { api: "GET /api/v1/nodes → metadata.labels (node-role.kubernetes.io/control-plane, node.kubernetes.io/microk8s-controlplane)" },
  },
  "dtmi:osiris:k8s:Pod;3": {
    network: { reading: "podNetwork" },
    cpu: { reading: "podCpu" },
    memory: { reading: "podMemory" },
    errorLogs: { reading: "errors" },
    phase: { api: "GET /api/v1/pods → status.phase" },
    ip: { api: "GET /api/v1/pods → status.podIP" },
    restarts: { api: "GET /api/v1/pods → Σ status.containerStatuses[].restartCount" },
  },
  "dtmi:osiris:k8s:Container;3": {
    cpu: { reading: "containerCpu" },
    memory: { reading: "containerMemory" },
    errorLogs: { reading: "errors" },
    image: { api: "GET /api/v1/pods → spec.containers[].image" },
    ready: { api: "GET /api/v1/pods → status.containerStatuses[].ready" },
  },
  "dtmi:osiris:k8s:PersistentVolumeClaim;1": {
    used: { reading: ["volumeCapacity", "volumeAvailable"], formula: "capacity − available" },
    fsCapacity: { reading: "volumeCapacity" },
    phase: { api: "GET /api/v1/persistentvolumeclaims → status.phase" },
  },
  "dtmi:osiris:hw:Cpu;1": {
    load: { reading: "nodeCpu", formula: "k8s.node.cpu.usage ÷ cores" },
    cores: { api: "GET /api/v1/nodes → status.capacity.cpu" },
  },
  "dtmi:osiris:hw:CpuCore;1": { load: { reading: "coreIdle", formula: "1 − idle of the core (cpu = cpuN); without it the CPU's average, marked estimated" } },
  "dtmi:osiris:hw:Memory;1": {
    load: { reading: "nodeMemory", formula: "working set ÷ capacity" },
    bytesUsed: { reading: "nodeMemory" },
    capacity: { api: "GET /api/v1/nodes → status.capacity.memory" },
  },
  "dtmi:osiris:hw:Disk;1": {
    load: { reading: ["fsUsage", "fsCapacity"], formula: "usage ÷ capacity of the node's root filesystem, on the disk holding it" },
    io: { reading: "diskIo", formula: "bytes read and written per second of the device" },
    device: { ceph: "ceph_disk_occupation" },
    model: { ceph: "ceph_disk_occupation (device_ids)" },
    size: { ceph: "ceph_osd_stat_bytes" },
  },
  "dtmi:osiris:ceph:Cluster;1": {
    health: { ceph: "ceph_health_status" },
    checks: { ceph: "ceph_health_detail" },
    osdUp: { ceph: "ceph_osd_up", formula: "sum" },
    osdIn: { ceph: "ceph_osd_in", formula: "sum" },
    quorum: { ceph: "ceph_mon_quorum_status", formula: "sum" },
    pgClean: { ceph: ["ceph_pg_active", "ceph_pg_clean"] },
    pgDegraded: { ceph: "ceph_pg_degraded" },
    readRate: { ceph: "ceph_pool_rd_bytes", formula: "change of the sum over all pools since the last sync ÷ seconds" },
    writeRate: { ceph: "ceph_pool_wr_bytes", formula: "change of the sum over all pools since the last sync ÷ seconds" },
    size: { ceph: "ceph_cluster_total_bytes" },
    used: { ceph: "ceph_cluster_total_used_bytes" },
  },
  "dtmi:osiris:ceph:Pool;1": {
    size: { ceph: ["ceph_pool_stored", "ceph_pool_max_avail"], formula: "stored + max available" },
    used: { ceph: "ceph_pool_stored" },
  },
  "dtmi:osiris:ceph:Osd;1": {
    up: { ceph: "ceph_osd_up" },
    in: { ceph: "ceph_osd_in" },
    size: { ceph: "ceph_osd_stat_bytes" },
    used: { ceph: "ceph_osd_stat_bytes_used" },
  },
};

/** The profile name of the source's own readings: never a hub's active profile, so only shown, never run by it. */
export const SOURCE_PROFILE = "source";

/** A model's profile of where its values come from (undefined for a model the adapter reads nothing extra for). */
export function sourceProfile(model: string): DataProfile | undefined {
  const origins = ORIGINS[model];
  if (!origins) return undefined;
  return {
    name: SOURCE_PROFILE,
    kind: "live",
    description: "Read by the instance's Kubernetes source at every sync: the cluster's API, its telemetry in ClickHouse (OpenTelemetry Collector) and the Ceph manager's metrics.",
    bindings: Object.entries(origins).map(([name, o]) => binding(name, o)),
  };
}
