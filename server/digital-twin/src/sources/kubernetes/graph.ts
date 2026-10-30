import type { TwinStatus } from "@osiris/shared";
import { CONTAINS, type SourceRelationship, type SourceSnapshot, type SourceTwin } from "../../twin.ts";
import type { CephState } from "./ceph.ts";
import type { EndpointSliceObject, IngressObject, IngressRouteObject, NamespaceObject, NodeObject, PodObject, PvcObject, PvObject, ReplicaSetObject, ServiceObject } from "./kube.ts";
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
  services?: ServiceObject[];
  endpointSlices?: EndpointSliceObject[];
  ingresses?: IngressObject[];
  ingressRoutes?: IngressRouteObject[];
  /** The addresses the internet reaches the cluster at (its Ingress hosts' DNS), host by address. */
  publicAddresses?: Record<string, string[]>;
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

  network(input, { root, cluster, nodeIds, add, link });

  // A claim no pod mounts (or whose pod is gone) is the cluster's.
  const held = new Set(relationships.filter((r) => r.name === CONTAINS).map((r) => r.target));
  for (const id of claimIds.values()) if (!held.has(id)) link(CONTAINS, root, id);
  return { twins, relationships };
}

/** Traefik's match rule's hosts and path prefixes: Host(`a`) && PathPrefix(`/b`). */
function matchOf(match: string | undefined): { hosts: string[]; paths: string[] } {
  const hosts = [...(match ?? "").matchAll(/Host\(([^)]*)\)/g)].flatMap((m) => [...m[1]!.matchAll(/`([^`]+)`/g)].map((h) => h[1]!));
  const paths = [...(match ?? "").matchAll(/Path(?:Prefix)?\(([^)]*)\)/g)].flatMap((m) => [...m[1]!.matchAll(/`([^`]+)`/g)].map((p) => p[1]!));
  return { hosts, paths };
}

/**
 * The cluster's network as twins: each node's network card (its address), its router (Calico routes between pods,
 * no bridge) and VXLAN tunnel to the other nodes; each pod's eth0 to its node's router (a host-network pod straight
 * to the card); the LoadBalancer addresses (MetalLB) announced by the nodes' cards and exposing their Services; the
 * public addresses the Ingress hosts resolve to, forwarded to the LoadBalancers. Services route to the pods of
 * their endpoints, Ingresses and IngressRoutes to Services.
 */
function network(
  input: ClusterInput,
  g: {
    root: string;
    cluster: string;
    nodeIds: Map<string, string>;
    add: (id: string, model: string, name: string, status: TwinStatus, properties: Record<string, unknown>, otelResource?: Record<string, string>) => void;
    link: (name: string, source: string, target: string) => void;
  },
) {
  const { cluster, add, link } = g;
  const iface = (id: string, name: string, kind: string, properties: Record<string, unknown>) => add(id, MODEL.Interface, name, "ok", { kind, ip: "", cidr: "", ports: "", ...properties });

  // Nodes: card, router, tunnel.
  const routerOf = new Map<string, string>();
  const cardOf = new Map<string, string>();
  const tunnels: string[] = [];
  for (const node of input.nodes) {
    const nodeId = g.nodeIds.get(node.metadata.name);
    if (!nodeId) continue;
    const a = node.metadata.annotations ?? {};
    const internal = node.status?.addresses?.find((x) => x.type === "InternalIP")?.address ?? "";
    const withMask = a["projectcalico.org/IPv4Address"] ?? "";
    const card = `${nodeId}/if/nic`;
    const router = `${nodeId}/if/router`;
    iface(card, internal || "nic", "physical", { ip: internal || withMask.split("/")[0] || "", cidr: withMask });
    iface(router, "calico", "router", {});
    link(CONTAINS, nodeId, card);
    link(CONTAINS, nodeId, router);
    link("connectedTo", router, card);
    cardOf.set(node.metadata.name, card);
    routerOf.set(node.metadata.name, router);
    const tunnelIp = a["projectcalico.org/IPv4VXLANTunnelAddr"];
    if (tunnelIp) {
      const tunnel = `${nodeId}/if/vxlan`;
      iface(tunnel, "vxlan.calico", "tunnel", { ip: tunnelIp });
      link(CONTAINS, nodeId, tunnel);
      link("connectedTo", router, tunnel);
      tunnels.push(tunnel);
    }
  }
  // The overlay: every tunnel reaches every other.
  tunnels.forEach((a, i) => tunnels.slice(i + 1).forEach((b) => link("connectedTo", a, b)));

  // Pods: eth0 to the node's router (a host-network pod is the node's card).
  const podIds = new Map<string, string>();
  for (const pod of input.pods) {
    const podId = instanceId(cluster, ["namespace", pod.metadata.namespace], ["pod", pod.metadata.name]);
    podIds.set(`${pod.metadata.namespace}/${pod.metadata.name}`, podId);
    const ip = pod.status?.podIP;
    if (!ip || !pod.spec.nodeName) continue;
    const eth0 = `${podId}/if/eth0`;
    iface(eth0, "eth0", "veth", { ip, ...(pod.spec.hostNetwork ? { cidr: "host network" } : {}) });
    link(CONTAINS, podId, eth0);
    const to = pod.spec.hostNetwork ? cardOf.get(pod.spec.nodeName) : routerOf.get(pod.spec.nodeName);
    if (to) link("connectedTo", eth0, to);
  }

  // Services, their pods, and the LoadBalancer addresses in front of them.
  const serviceIds = new Map<string, string>();
  const ready = new Map<string, Set<string>>();
  for (const slice of input.endpointSlices ?? []) {
    const service = slice.metadata.labels?.["kubernetes.io/service-name"];
    if (!service) continue;
    const key = `${slice.metadata.namespace}/${service}`;
    const set = ready.get(key) ?? ready.set(key, new Set()).get(key)!;
    for (const e of slice.endpoints ?? [])
      if (e.targetRef?.kind === "Pod" && e.targetRef.name && e.conditions?.ready !== false) set.add(`${e.targetRef.namespace ?? slice.metadata.namespace}/${e.targetRef.name}`);
  }
  const lbs: { id: string; service: string; ports: string }[] = [];
  for (const svc of [...(input.services ?? [])].sort((a, b) => `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`))) {
    const { name, namespace } = svc.metadata;
    const key = `${namespace}/${name}`;
    const id = instanceId(cluster, ["namespace", namespace], ["service", name]);
    serviceIds.set(key, id);
    const pods = [...(ready.get(key) ?? [])].map((p) => podIds.get(p)).filter((p): p is string => !!p);
    const ports = (svc.spec?.ports ?? []).map((p) => `${p.port}/${p.protocol ?? "TCP"}${p.targetPort !== undefined && p.targetPort !== p.port ? `→${p.targetPort}` : ""}`).join(", ");
    const external = (svc.status?.loadBalancer?.ingress ?? []).map((i) => i.ip ?? i.hostname ?? "").filter(Boolean);
    const selects = Object.keys(svc.spec?.selector ?? {}).length > 0;
    add(id, MODEL.Service, name, selects && !pods.length ? "warn" : "ok", {
      type: svc.spec?.type ?? "ClusterIP",
      clusterIP: svc.spec?.clusterIP ?? "",
      ports,
      externalIP: external.join(", "),
      readyEndpoints: pods.length,
    });
    link(CONTAINS, g.root, id);
    link("hasService", instanceId(cluster, ["namespace", namespace]), id);
    for (const p of pods) link("routesTo", id, p);
    for (const ip of external) {
      const lb = instanceId(cluster, ["lb", ip]);
      iface(lb, ip, "loadbalancer", { ip, ports });
      link(CONTAINS, g.root, lb);
      link("exposes", lb, id);
      for (const card of cardOf.values()) link("connectedTo", lb, card);
      lbs.push({ id: lb, service: key, ports });
    }
  }

  // Ingresses and IngressRoutes: hosts and paths to Services, served by the ingress controller's LoadBalancer.
  const controller = lbs.find((l) => /(^|\/)(traefik|ingress-nginx-controller|ingress)$/.test(l.service))?.id ?? lbs[0]?.id;
  const ingress = (namespace: string, name: string, kind: string, hosts: string[], routes: { host: string; path: string; service: string; port: string }[], tls: boolean, ingressClass: string) => {
    const id = instanceId(cluster, ["namespace", namespace], [`ingress-${kind.toLowerCase()}`, name]);
    const targets = routes.map((r) => serviceIds.get(`${namespace}/${r.service}`));
    add(id, MODEL.Ingress, name, targets.some((t) => !t) ? "error" : "ok", {
      kind,
      hosts: [...new Set(hosts)].join(", "),
      routes: routes.map((r) => `${r.host || "*"}${r.path || "/"} → ${r.service}${r.port ? `:${r.port}` : ""}`).join("\n"),
      tls,
      ingressClass,
    });
    link(CONTAINS, g.root, id);
    link("hasIngress", instanceId(cluster, ["namespace", namespace]), id);
    for (const t of new Set(targets)) if (t) link("routesTo", id, t);
    if (controller) link("servedBy", id, controller);
  };
  for (const ing of input.ingresses ?? []) {
    const routes = (ing.spec?.rules ?? []).flatMap((r) =>
      (r.http?.paths ?? []).flatMap((p) => (p.backend?.service ? [{ host: r.host ?? "", path: p.path ?? "/", service: p.backend.service.name, port: String(p.backend.service.port?.number ?? p.backend.service.port?.name ?? "") }] : [])),
    );
    ingress(ing.metadata.namespace, ing.metadata.name, "Ingress", (ing.spec?.rules ?? []).map((r) => r.host ?? "").filter(Boolean), routes, !!ing.spec?.tls?.length, ing.spec?.ingressClassName ?? "");
  }
  for (const ir of input.ingressRoutes ?? []) {
    const routes = (ir.spec?.routes ?? []).flatMap((r) => {
      const m = matchOf(r.match);
      return (r.services ?? []).map((s) => ({ host: m.hosts.join(","), path: m.paths[0] ?? "/", service: s.name, port: String(s.port ?? "") }));
    });
    ingress(ir.metadata.namespace, ir.metadata.name, "IngressRoute", routes.flatMap((r) => r.host.split(",")).filter(Boolean), routes, !!ir.spec?.tls, "traefik");
  }

  // The public addresses, forwarded (by the router in front of the cluster) to the LoadBalancers. Hosts behind a CDN
  // (Cloudflare) resolve to the CDN's addresses, not the cluster's: one CDN interface, in front of the cluster's own.
  const byAddress = new Map<string, string[]>();
  const behindCdn = new Map<string, string[]>();
  for (const [host, addresses] of Object.entries(input.publicAddresses ?? {}))
    for (const a of addresses) {
      const into = isCloudflare(a) ? behindCdn : byAddress;
      into.set(a, [...(into.get(a) ?? []), host]);
    }
  const origins: string[] = [];
  for (const [address, hosts] of [...byAddress].sort()) {
    const id = instanceId(cluster, ["public", address]);
    iface(id, address, "public", { ip: address, ports: hosts.sort().join(", ") });
    link(CONTAINS, g.root, id);
    for (const lb of new Set(lbs.map((l) => l.id))) link("connectedTo", id, lb);
    origins.push(id);
  }
  if (behindCdn.size) {
    const id = instanceId(cluster, ["public", "cloudflare"]);
    const hosts = [...new Set([...behindCdn.values()].flat())].sort();
    iface(id, "Cloudflare", "public", { ip: [...behindCdn.keys()].sort().join(", "), cidr: "CDN proxy", ports: hosts.join(", ") });
    link(CONTAINS, g.root, id);
    for (const to of origins.length ? origins : [...new Set(lbs.map((l) => l.id))]) link("connectedTo", id, to);
  }
}

/** Cloudflare's published IPv4 ranges (https://www.cloudflare.com/ips-v4): a host there is proxied by its CDN. */
const CLOUDFLARE = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"];
const ipNumber = (ip: string) => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
export const isCloudflare = (ip: string) =>
  CLOUDFLARE.some((cidr) => {
    const [base, bits] = cidr.split("/");
    const mask = 2 ** (32 - Number(bits));
    return Math.floor(ipNumber(ip) / mask) === Math.floor(ipNumber(base!) / mask);
  });
