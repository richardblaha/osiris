import { describe, expect, it } from "vitest";
import { clusterGraph, type ClusterInput } from "../src/sources/kubernetes/graph.ts";
import { cephState, parsePrometheus, type CephState } from "../src/sources/kubernetes/ceph.ts";
import { dtdlModel, MODEL } from "../src/sources/kubernetes/models.ts";
import { toRelationship } from "../src/twin.ts";
import { buildScene, hasNetwork, interfacesOf, isStorage, routingOf, storageLinksOf, wiresOf, type TwinScene } from "../web/src/scene.ts";
import { layoutTwin, orthogonal } from "../web/src/TwinLayout.ts";
import { PRESENTATION_CONTEXT, type DtdlInterface } from "@osiris/shared/dtdl.ts";

const calico = (name: string, ip: string, tunnel: string) => ({
  metadata: { name, annotations: { "projectcalico.org/IPv4Address": `${ip}/24`, "projectcalico.org/IPv4VXLANTunnelAddr": tunnel } },
  status: { addresses: [{ type: "InternalIP", address: ip }] },
});
const pod = (name: string, ns: string, nodeName: string, ip: string, containers = ["app"]) => ({
  metadata: { name, namespace: ns },
  spec: { nodeName, containers: containers.map((c) => ({ name: c })) },
  status: { phase: "Running", podIP: ip, containerStatuses: containers.map((c) => ({ name: c, ready: true, restartCount: 0, image: "x" })) },
});
const ceph: CephState = {
  fsid: "f",
  health: 1,
  version: "18.2.4",
  size: 3e12,
  used: 1e12,
  checks: [{ name: "PG_DEGRADED", severity: "warn" }],
  monitors: 3,
  quorum: 3,
  pgs: { total: 64, clean: 60, degraded: 4 },
  readBytes: 0,
  writeBytes: 0,
  osds: [0, 1].map((id) => ({ id, host: id ? "n2" : "n1", address: `192.168.0.24${id + 1}`, deviceClass: "ssd", device: "/dev/sdb", model: "m", dbDevice: "", up: true, in: true, size: 1.5e12, used: id ? 6e11 : 3e11 })),
  pools: [{ id: 1, name: "rbd", stored: 4e11, maxAvailable: 6e11 }],
};
const input: ClusterInput = {
  clusterName: "c",
  namespaces: [{ metadata: { name: "web" } }, { metadata: { name: "ingress" } }],
  nodes: [calico("n1", "192.168.0.241", "10.1.0.1"), calico("n2", "192.168.0.242", "10.1.0.2")],
  pods: [pod("site-1", "web", "n1", "10.1.0.10", ["app", "sidecar"]), pod("traefik-1", "ingress", "n2", "10.1.0.20")],
  replicasets: [],
  version: null,
  ceph,
  cephIo: { read: 1000, write: 2000 },
  services: [
    { metadata: { name: "site", namespace: "web" }, spec: { type: "ClusterIP", clusterIP: "10.152.0.5", ports: [{ port: 80 }], selector: { app: "site" } } },
    { metadata: { name: "traefik", namespace: "ingress" }, spec: { type: "LoadBalancer", ports: [{ port: 443 }], selector: { app: "traefik" } }, status: { loadBalancer: { ingress: [{ ip: "192.168.0.50" }] } } },
  ],
  endpointSlices: [
    { metadata: { name: "site-x", namespace: "web", labels: { "kubernetes.io/service-name": "site" } }, endpoints: [{ conditions: { ready: true }, targetRef: { kind: "Pod", name: "site-1" } }] },
    { metadata: { name: "traefik-x", namespace: "ingress", labels: { "kubernetes.io/service-name": "traefik" } }, endpoints: [{ conditions: { ready: true }, targetRef: { kind: "Pod", name: "traefik-1" } }] },
  ],
  ingresses: [{ metadata: { name: "site", namespace: "web" }, spec: { tls: [{ hosts: ["k6labs.cz"] }], rules: [{ host: "k6labs.cz", http: { paths: [{ path: "/", backend: { service: { name: "site", port: { number: 80 } } } }] } }] } }],
  publicAddresses: { "k6labs.cz": ["94.230.151.215"] },
};

const sceneOf = (graph: ReturnType<typeof clusterGraph>, extra: DtdlInterface[] = []) => {
  const models = [...dtdlModel(), ...extra].map((m) => ({ id: m["@id"], model: m, uploadTime: "", decommissioned: false }));
  return buildScene(models, graph.twins.map((t) => ({ ...t, $etag: "", $metadata: { $model: t.$metadata.$model } })), graph.relationships.map(toRelationship), {}, {}, {}, null);
};
/** The layout with the rules the 3D view gives it. */
const layoutOf = (scene: TwinScene) => {
  const shapes = { port: "port", hex: "hex", gate: "gate", ceph: "drum" } as const;
  return layoutTwin(scene.top, {
    networked: (n) => hasNetwork(n, scene.models),
    storage: (n) => isStorage(n, scene.models),
    shape: (n) => shapes[n.look as keyof typeof shapes],
    portKind: (n) => String(n.twin.kind ?? "veth"),
    sharesNetwork: (n) => n.look === "container",
    interfaces: interfacesOf(scene),
    wires: wiresOf(scene),
    virtual: routingOf(scene),
    storageLinks: storageLinksOf(scene),
  });
};
const graph = clusterGraph(input);
const scene = sceneOf(graph);
const layout = layoutOf(scene);

describe("the view's layers", () => {
  it("puts each twin in its model's layer: the low-level network, the network services, storage, the groupings", () => {
    const layerOf = (id: string) => scene.byId.get(id)?.layer;
    expect(layerOf("k8s:c/node/n1/if/router")).toBe("network");
    expect(layerOf("k8s:c/namespace/web/pod/site-1/if/eth0")).toBe("network");
    // The ways in from outside are the services': the LoadBalancer and the public address.
    expect(layerOf("k8s:c/lb/192.168.0.50")).toBe("services");
    expect(layerOf("k8s:c/public/94.230.151.215")).toBe("services");
    expect(layerOf("k8s:c/namespace/web/service/site")).toBe("services");
    expect(layerOf("k8s:c/namespace/web/ingress-ingress/site")).toBe("services");
    expect(layerOf("k8s:c/ceph/ceph")).toBe("storage");
    expect(layerOf("k8s:c/ceph/ceph/osd/0")).toBe("storage");
    expect(scene.bands.every((b) => b.layer === "logical")).toBe(true);
    expect(layerOf("k8s:c/namespace/web/pod/site-1")).toBe("base");
    expect(layerOf("k8s:c")).toBe("base");
  });

  it("takes a model's own presentation layer over the built-in one", () => {
    const pod = dtdlModel().find((m) => m["@id"] === MODEL.Pod)!;
    const own = sceneOf(graph, [{ ...pod, "@context": [...[pod["@context"]].flat(), PRESENTATION_CONTEXT], presentation: { layer: "services" } }]);
    expect(own.byId.get("k8s:c/namespace/web/pod/site-1")?.layer).toBe("services");
  });

  it("gives every line a layer and draws each at right angles only", () => {
    expect(layout.links.length).toBeGreaterThan(10);
    for (const l of layout.links) {
      expect(["base", "network", "services", "storage"]).toContain(l.layer);
      expect(l.path.length, `${l.kind} ${l.id}`).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < l.path.length; i++) {
        const moved = [0, 1, 2].filter((k) => Math.abs(l.path[i]![k]! - l.path[i - 1]![k]!) > 1e-6);
        expect(moved.length, `${l.kind} ${l.id} → ${l.to} segment ${i}`).toBe(1);
      }
    }
    const kinds = new Set(layout.links.map((l) => l.kind));
    for (const k of ["network", "lan", "wire", "overlay", "virtual", "internet", "storage"]) expect(kinds, k).toContain(k);
    // A pod's containers are wired to its eth0; a Service's routing ends at the pod's eth0.
    const lan = layout.links.filter((l) => l.kind === "lan" && l.to === "k8s:c/namespace/web/pod/site-1/if/eth0");
    expect(lan).toHaveLength(2);
    const eth0 = layout.boxes.find((b) => b.id === "k8s:c/namespace/web/pod/site-1/if/eth0")!;
    const routed = layout.links.find((l) => l.kind === "virtual" && l.id === "k8s:c/namespace/web/service/site")!;
    expect(routed.path.at(-1)).toEqual(eth0.center);
  });

  it("joins points with right-angled segments in the order given", () => {
    expect(orthogonal([[0, 0, 0], [2, 3, 4]])).toEqual([[0, 0, 0], [2, 0, 0], [2, 0, 4], [2, 3, 4]]);
    // A straight run stays one segment.
    expect(orthogonal([[0, 0, 0], [1, 0, 0], [3, 0, 0]])).toEqual([[0, 0, 0], [3, 0, 0]]);
  });
});

describe("storage in the view", () => {
  it("draws Ceph as a compact drum in the last row, not a column as tall as the nodes, with its disks linked", () => {
    const drum = layout.boxes.find((b) => b.id === "k8s:c/ceph/ceph")!;
    const node = layout.boxes.find((b) => b.id === "k8s:c/node/n1")!;
    expect(drum.shape).toBe("drum");
    expect(drum.size[0]).toBeCloseTo(drum.size[2]);
    expect(drum.size[1]).toBeLessThan(node.size[1]);
    expect(drum.size[2]).toBeLessThan(node.size[2]);
    const disks = layout.links.filter((l) => l.kind === "storage" && l.id === "k8s:c/ceph/ceph").map((l) => l.to);
    expect(disks.sort()).toEqual(["k8s:c/ceph/ceph/osd/0", "k8s:c/ceph/ceph/osd/1"]);
  });

  it("tells what Ceph needs watching for: disks, placement groups, monitors, I/O, raised checks; each disk its own fill", () => {
    const c = graph.twins.find((t) => t.$dtId === "k8s:c/ceph/ceph")!;
    expect(c).toMatchObject({ osdUp: 2, osdIn: 2, monitors: 3, quorum: 3, pgTotal: 64, pgClean: 60, pgDegraded: 4, checks: "PG_DEGRADED (warn)", readRate: 1000, writeRate: 2000 });
    expect(graph.twins.find((t) => t.$dtId === "k8s:c/ceph/ceph/osd/1")).toMatchObject({ size: 1.5e12, used: 6e11, fill: 0.4 });
  });

  it("reads the monitors, placement groups, health checks and I/O counters from the manager", () => {
    const state = cephState(
      parsePrometheus(
        [
          'ceph_health_status{fsid="f"} 1',
          'ceph_health_detail{name="OSD_DOWN",severity="HEALTH_WARN"} 1',
          'ceph_health_detail{name="MON_DOWN",severity="HEALTH_WARN"} 0',
          'ceph_mon_metadata{ceph_daemon="mon.a",ceph_version="ceph version 18.2.4 (x) reef (stable)"} 1',
          'ceph_mon_metadata{ceph_daemon="mon.b"} 1',
          'ceph_mon_quorum_status{ceph_daemon="mon.a"} 1',
          'ceph_mon_quorum_status{ceph_daemon="mon.b"} 0',
          'ceph_pg_total{pool_id="1"} 32',
          'ceph_pg_total{pool_id="2"} 32',
          'ceph_pg_active{pool_id="1"} 32',
          'ceph_pg_active{pool_id="2"} 30',
          'ceph_pg_clean{pool_id="1"} 32',
          'ceph_pg_clean{pool_id="2"} 31',
          'ceph_pg_degraded{pool_id="2"} 2',
          'ceph_pool_rd_bytes{pool_id="1"} 100',
          'ceph_pool_wr_bytes{pool_id="1"} 300',
        ].join("\n"),
      ),
    )!;
    expect(state).toMatchObject({ checks: [{ name: "OSD_DOWN", severity: "warn" }], monitors: 2, quorum: 1, pgs: { total: 64, clean: 62, degraded: 2 }, readBytes: 100, writeBytes: 300 });
  });
});

describe("bridges", () => {
  it("puts the pods of a bridge CNI (flannel) on the node's bridge, which the host routes", () => {
    const g = clusterGraph({
      clusterName: "c",
      namespaces: [{ metadata: { name: "web" } }],
      nodes: [
        {
          metadata: { name: "n1", annotations: { "flannel.alpha.coreos.com/backend-type": "vxlan", "flannel.alpha.coreos.com/public-ip": "192.168.0.241" } },
          spec: { podCIDR: "10.244.0.0/24" },
          status: { addresses: [{ type: "InternalIP", address: "192.168.0.241" }] },
        },
      ],
      pods: [pod("site-1", "web", "n1", "10.244.0.5")],
      replicasets: [],
      version: null,
    });
    const bridge = g.twins.find((t) => t.$dtId === "k8s:c/node/n1/if/cni0");
    expect(bridge).toMatchObject({ kind: "bridge", name: "cni0", cidr: "10.244.0.0/24" });
    expect(g.relationships).toContainEqual({ name: "connectedTo", source: "k8s:c/namespace/web/pod/site-1/if/eth0", target: "k8s:c/node/n1/if/cni0" });
    expect(g.relationships).toContainEqual({ name: "connectedTo", source: "k8s:c/node/n1/if/cni0", target: "k8s:c/node/n1/if/router" });
    // The bridge is the node's hub: its pods' links start at it.
    const s = sceneOf(g);
    const l = layoutOf(s);
    const cni0 = l.boxes.find((b) => b.id === "k8s:c/node/n1/if/cni0")!;
    expect(l.links.find((x) => x.kind === "network" && x.id === "k8s:c/namespace/web/pod/site-1")?.path[0]).toEqual(cni0.center);
  });
});
