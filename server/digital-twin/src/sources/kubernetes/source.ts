import type { TwinSource } from "../../twin.ts";
import { clusterGraph, NAMESPACE_ATTR, NODE_ATTR, POD_ATTR, PVC_ATTR } from "./graph.ts";
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

export function kubernetesSource(
  kube: Kube,
  clusterName: string,
  options: { cephManagers?: string[]; fetchFn?: typeof fetch; resolve?: (hosts: string[]) => Promise<Record<string, string[]>> } = {},
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
      return clusterGraph({ clusterName, namespaces, pods, nodes, pvcs, pvs, replicasets, version, ceph, cephIo, services, endpointSlices, ingresses, ingressRoutes, publicAddresses });
    },
  };
}
