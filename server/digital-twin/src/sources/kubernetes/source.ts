import type { ResourceReading } from "../../state.ts";
import type { TelemetryReader } from "../../telemetry.ts";
import { errorKey, otelResourceOf, type SourceTwin, type TwinSource } from "../../twin.ts";
import { clusterGraph, CONTAINER_ATTR, CPU_ATTR, DEVICE_ATTR, NAMESPACE_ATTR, NODE_ATTR, POD_ATTR, PVC_ATTR, ROOT_FS_ATTR } from "./graph.ts";
import { MODEL } from "./models.ts";
import { resolve4 } from "node:dns/promises";
import { readCeph } from "./ceph.ts";
import type { Kube } from "./kube.ts";
import { dtdlModel } from "./models.ts";

/**
 * The Kubernetes adapter: the cluster's structure straight from its API (namespaces, pods, nodes, ReplicaSets for
 * the Deployments, PersistentVolumeClaims), read-only. Error counts come from the pods' logs and network load from kubeletstats' counters,
 * named by OpenTelemetry's k8s attributes.
 */
/** Private, loopback, link-local and shared ranges: not where the internet reaches the cluster. */
const PRIVATE = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** The public IPv4 addresses each host name resolves to (a name that doesn't resolve has none). */
export async function publicAddressesOf(hosts: string[]): Promise<Record<string, string[]>> {
  const unique = [...new Set(hosts.filter((h) => /^[a-z0-9.-]+$/i.test(h) && !h.startsWith("*")))].slice(0, 100);
  const resolved = await Promise.all(
    unique.map(async (host) => [host, (await Promise.race([resolve4(host), new Promise<string[]>((r) => setTimeout(() => r([]), 3000))]).catch(() => [])).filter((a) => !PRIVATE.test(a))] as const),
  );
  return Object.fromEntries(resolved.filter(([, a]) => a.length));
}

/**
 * The hardware's and the workloads' readings from the cluster's metrics: kubeletstats for a node's CPU (cores busy),
 * memory (working set) and root filesystem, and each container's and pod's CPU and memory; the node agents'
 * hostmetrics for each core (`system.cpu.utilization`, all but idle) and each disk's I/O (`system.disk.io`). Without
 * per-core metrics a core shows its CPU's average, marked estimated. A metric that fails or is missing leaves its
 * readings out.
 */
export async function kubernetesResources(telemetry: TelemetryReader, twins: SourceTwin[], at?: number): Promise<Record<string, ResourceReading>> {
  const none = () => new Map<string, number>();
  const node = [NODE_ATTR];
  const pod = [NAMESPACE_ATTR, POD_ATTR];
  const container = [NAMESPACE_ATTR, POD_ATTR, CONTAINER_ATTR];
  const [cpu, idle, memory, fsUsed, fsSize, io, cCpu, cMemory, pCpu, pMemory] = await Promise.all([
    telemetry.latest("k8s.node.cpu.usage", node, at).catch(none),
    telemetry.latest("system.cpu.utilization", node, at, { points: [CPU_ATTR], where: { state: "idle" } }).catch(none),
    telemetry.latest("k8s.node.memory.working_set", node, at).catch(none),
    telemetry.latest("k8s.node.filesystem.usage", node, at).catch(none),
    telemetry.latest("k8s.node.filesystem.capacity", node, at).catch(none),
    telemetry.rates("system.disk.io", node, at, { points: [DEVICE_ATTR] }).catch(none),
    telemetry.latest("container.cpu.usage", container, at).catch(none),
    telemetry.latest("container.memory.working_set", container, at).catch(none),
    telemetry.latest("k8s.pod.cpu.usage", pod, at).catch(none),
    telemetry.latest("k8s.pod.memory.working_set", pod, at).catch(none),
  ]);
  const share = (used: number | undefined, size: number | undefined) => (used !== undefined && size ? Math.min(1, Math.max(0, used / size)) : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const out: Record<string, ResourceReading> = {};
  const put = (id: string, r: ResourceReading) => {
    const kept = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as ResourceReading;
    if (Object.keys(kept).some((k) => k !== "estimated")) out[id] = kept;
  };
  // A CPU's average, for its cores without their own metric.
  const cpuLoad = new Map<string, number>();
  for (const t of twins) {
    const model = t.$metadata.$model;
    const r = otelResourceOf(t as { otelResource?: unknown });
    const n = r[NODE_ATTR] ?? "";
    if (model === MODEL.Cpu) {
      const load = share(cpu.get(errorKey([n])), num(t.cores));
      if (load !== undefined) cpuLoad.set(n, load);
      put(t.$dtId, { load, used: cpu.get(errorKey([n])), size: num(t.cores) });
    }
  }
  for (const t of twins) {
    const model = t.$metadata.$model;
    const r = otelResourceOf(t as { otelResource?: unknown });
    const n = r[NODE_ATTR] ?? "";
    if (model === MODEL.CpuCore) {
      const own = idle.get(errorKey([n, r[CPU_ATTR] ?? ""]));
      put(t.$dtId, own !== undefined ? { load: Math.min(1, Math.max(0, 1 - own)) } : { load: cpuLoad.get(n), estimated: true });
    } else if (model === MODEL.Memory) {
      const used = memory.get(errorKey([n]));
      put(t.$dtId, { load: share(used, num(t.capacity)), used, size: num(t.capacity) });
    } else if (model === MODEL.Disk) {
      const root = r[ROOT_FS_ATTR] === "true";
      const used = root ? fsUsed.get(errorKey([n])) : undefined;
      const size = root ? fsSize.get(errorKey([n])) : undefined;
      put(t.$dtId, { load: share(used, size), used, size, io: io.get(errorKey([n, r[DEVICE_ATTR] ?? ""])) });
    } else if (model === MODEL.Container) {
      const k = errorKey([r[NAMESPACE_ATTR] ?? "", r[POD_ATTR] ?? "", r[CONTAINER_ATTR] ?? ""]);
      put(t.$dtId, { cpu: cCpu.get(k), memory: cMemory.get(k) });
    } else if (model === MODEL.Pod) {
      const k = errorKey([r[NAMESPACE_ATTR] ?? "", r[POD_ATTR] ?? ""]);
      put(t.$dtId, { cpu: pCpu.get(k), memory: pMemory.get(k) });
    }
  }
  return out;
}

export function kubernetesSource(
  kube: Kube,
  clusterName: string,
  options: { cephManagers?: string[]; externalBus?: "usb" | "sata"; fetchFn?: typeof fetch; resolve?: (hosts: string[]) => Promise<Record<string, string[]>> } = {},
): TwinSource {
  /** Ceph's client I/O counters at the last sync, for its read and write rates. */
  let cephBefore: { at: number; read: number; write: number } | undefined;
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
    resources: kubernetesResources,
    async snapshot() {
      const [namespaces, pods, nodes, pvcs, pvs, replicasets, version, ceph, services, endpointSlices, ingresses, ingressRoutes] = await Promise.all([
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
        // The network's objects; a cluster that doesn't have them (or doesn't let us list them) goes without.
        kube.services().catch(() => []),
        kube.endpointSlices().catch(() => []),
        kube.ingresses().catch(() => []),
        kube.ingressRoutes().catch(() => []),
      ]);
      const hosts = [
        ...ingresses.flatMap((i) => (i.spec?.rules ?? []).map((r) => r.host ?? "")),
        ...ingressRoutes.flatMap((r) => (r.spec?.routes ?? []).flatMap((x) => [...(x.match ?? "").matchAll(/Host\(`([^`]+)`/g)].map((m) => m[1]!))),
      ];
      const publicAddresses = await (options.resolve ?? publicAddressesOf)(hosts);
      // Ceph's client I/O: its counters' change since the last sync (none on the first, or after a restart).
      let cephIo: { read: number; write: number } | undefined;
      if (ceph) {
        const now = Date.now();
        const b = cephBefore;
        if (b && now > b.at && ceph.readBytes >= b.read && ceph.writeBytes >= b.write)
          cephIo = { read: ((ceph.readBytes - b.read) * 1000) / (now - b.at), write: ((ceph.writeBytes - b.write) * 1000) / (now - b.at) };
        cephBefore = { at: now, read: ceph.readBytes, write: ceph.writeBytes };
      }
      return clusterGraph({ clusterName, namespaces, pods, nodes, pvcs, pvs, replicasets, version, ceph, cephIo, services, endpointSlices, ingresses, ingressRoutes, publicAddresses, externalBus: options.externalBus });
    },
  };
}
