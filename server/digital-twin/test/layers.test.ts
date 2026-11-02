import { describe, expect, it } from "vitest";
import { clusterGraph, type ClusterInput } from "../src/sources/kubernetes/graph.ts";
import { cephState, parsePrometheus, type CephState } from "../src/sources/kubernetes/ceph.ts";
import { dtdlModel, MODEL } from "../src/sources/kubernetes/models.ts";
import { toRelationship } from "../src/twin.ts";
import { buildScene, layoutRules, type TwinScene } from "../web/src/scene.ts";
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
const layoutOf = (scene: TwinScene) => layoutTwin(scene.top, layoutRules(scene));
const graph = clusterGraph(input);
const scene = sceneOf(graph);
const layout = layoutOf(scene);

describe("the view's layers", () => {
  it("puts each twin in its model's layer: hardware, the low-level network, the network services, storage, the groupings", () => {
    const layerOf = (id: string) => scene.byId.get(id)?.layer;
    expect(layerOf("k8s:c/node/n1/if/router")).toBe("network");
    expect(layerOf("k8s:c/namespace/web/pod/site-1/if/eth0")).toBe("network");
    // The ways in from outside are the services': the LoadBalancer and the public address.
    expect(layerOf("k8s:c/lb/192.168.0.50")).toBe("services");
    expect(layerOf("k8s:c/public/94.230.151.215")).toBe("services");
    expect(layerOf("k8s:c/namespace/web/service/site")).toBe("services");
    expect(layerOf("k8s:c/namespace/web/ingress-ingress/site")).toBe("services");
    expect(layerOf("k8s:c/ceph/ceph")).toBe("storage");
    // A USB disk with its OSD merged in is hardware (the OSD itself is the disk now).
    expect(layerOf("k8s:c/node/n1/hw/disk/sdb")).toBe("hardware");
    expect(scene.bands.every((b) => b.layer === "namespaces")).toBe(true);
    expect(layerOf("k8s:c/node/n1/hw/cpu")).toBe("hardware");
    expect(layerOf("k8s:c/node/n1/if/nic")).toBe("hardware");
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
      expect(["base", "hardware", "network", "services", "storage"]).toContain(l.layer);
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
  it("draws Ceph as a disk array of two columns beside the cluster: the physical disks flat and stacked on the left, the pools as discs on the right", () => {
    const array = layout.boxes.find((b) => b.id === "k8s:c/ceph/ceph")!;
    const cluster = layout.boxes.find((b) => b.id === "k8s:c")!;
    const inside = (inner: { center: number[]; size: number[] }, outer: { center: number[]; size: number[] }) =>
      [0, 1, 2].every((i) => inner.center[i]! - inner.size[i]! / 2 >= outer.center[i]! - outer.size[i]! / 2 - 1e-6 && inner.center[i]! + inner.size[i]! / 2 <= outer.center[i]! + outer.size[i]! / 2 + 1e-6);
    expect(array.shape).toBe("box");
    // Outside the cluster's own solid, beside it.
    expect(array.center[0]! - array.size[0]! / 2).toBeGreaterThan(cluster.center[0]! + cluster.size[0]! / 2 - 1e-6);
    // The left column: the physical USB disks (each with its OSD merged in), lying flat and stacked on one another.
    const disks = ["k8s:c/node/n1/hw/disk/sdb", "k8s:c/node/n2/hw/disk/sdb"].map((id) => layout.boxes.find((b) => b.id === id)!);
    for (const disk of disks) {
      expect(inside(disk, array), disk.id).toBe(true);
      expect(disk.shape, disk.id).toBe("box");
      expect(disk.size[0]!, disk.id).toBeGreaterThan(disk.size[1]!); // lying flat: wider than high
    }
    expect(disks[0]!.center[1]).not.toBeCloseTo(disks[1]!.center[1]); // stacked: one on another
    // The right column: the pools as flat discs — round, so told apart from the disks — no connector.
    const pool = layout.boxes.find((b) => b.id === "k8s:c/ceph/ceph/pool/rbd")!;
    expect(inside(pool, array)).toBe(true);
    expect(pool.shape).toBe("cylinder");
    expect(pool.center[0]).toBeGreaterThan(Math.max(...disks.map((d) => d.center[0]!)));
    // Ceph's OSDs are the disks themselves: the storage lines run straight to them.
    const osds = layout.links.filter((l) => l.kind === "storage" && l.id === "k8s:c/ceph/ceph").map((l) => l.to);
    expect(osds.sort()).toEqual(["k8s:c/node/n1/hw/disk/sdb", "k8s:c/node/n2/hw/disk/sdb"]);
  });

  it("tells what Ceph needs watching for: disks, placement groups, monitors, I/O, raised checks; each disk its own fill", () => {
    const c = graph.twins.find((t) => t.$dtId === "k8s:c/ceph/ceph")!;
    expect(c).toMatchObject({ osdUp: 2, osdIn: 2, monitors: 3, quorum: 3, pgTotal: 64, pgClean: 60, pgDegraded: 4, checks: "PG_DEGRADED (warn)", readRate: 1000, writeRate: 2000 });
    // The OSD's own bytes land on its USB disk (merged): the disk twin carries them.
    expect(graph.twins.find((t) => t.$dtId === "k8s:c/node/n2/hw/disk/sdb")).toMatchObject({ osdId: 1, size: 1.5e12, used: 6e11, fill: 0.4 });
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

describe("the machines' hardware in the view", () => {
  const withHardware: ClusterInput = {
    ...input,
    nodes: input.nodes.map((n) => ({ ...n, status: { ...n.status, capacity: { cpu: "4", memory: "6498908Ki" } } })),
    ceph: { ...ceph, osds: ceph.osds.map((o) => ({ ...o, deviceClass: "hdd", devices: { nvme0n1: "SKHynix_HFS256_AN99", sdb: "ST500LM0_00-1EJ162_18A2" } })) },
  };
  const g = clusterGraph(withHardware);
  const s = sceneOf(g);
  const resources = { "k8s:c/node/n1/hw/cpu/core/0": { load: 0.97 }, "k8s:c/namespace/web/pod/site-1/container/app": { cpu: 0.2, memory: 3e8 } };
  const withReadings = buildScene(
    [...dtdlModel()].map((m) => ({ id: m["@id"], model: m, uploadTime: "", decommissioned: false })),
    g.twins.map((t) => ({ ...t, $etag: "", $metadata: { $model: t.$metadata.$model } })),
    g.relationships.map(toRelationship),
    {},
    {},
    {},
    null,
    undefined,
    resources,
  );
  const l = layoutOf(s);
  const box = (id: string) => l.boxes.find((b) => b.id === id)!;
  const bottom = (id: string) => box(id).center[1] - box(id).size[1] / 2;
  const top = (id: string) => box(id).center[1] + box(id).size[1] / 2;

  it("stands the CPU with its cores, the memory and the disks on the node's floor, its workloads above them", () => {
    const node = box("k8s:c/node/n1");
    const cpu = box("k8s:c/node/n1/hw/cpu");
    const pod = box("k8s:c/namespace/web/pod/site-1");
    // On a board, under the namespaces' bands: every pod is above the deck's top.
    expect(l.boards.some((b) => b.id === "k8s:c/node/n1")).toBe(true);
    expect(bottom("k8s:c/namespace/web/pod/site-1")).toBeGreaterThan(top("k8s:c/node/n1/hw/memory"));
    expect(bottom("k8s:c/node/n1/hw/cpu")).toBeLessThan(pod.center[1]);
    expect(bottom("k8s:c/node/n1/hw/cpu")).toBeGreaterThan(bottom("k8s:c/node/n1"));
    expect(Math.abs(cpu.center[0] - node.center[0])).toBeLessThan(node.size[0] / 2);
    // Four cores as tiles inside the chip.
    for (let i = 0; i < 4; i++) {
      const core = box(`k8s:c/node/n1/hw/cpu/core/${i}`);
      expect(Math.abs(core.center[0] - cpu.center[0])).toBeLessThan(cpu.size[0] / 2);
      expect(Math.abs(core.center[2] - cpu.center[2])).toBeLessThan(cpu.size[2] / 2);
      expect(core.size[1]).toBeLessThan(cpu.size[1]);
    }
  });

  it("merges each OSD into its USB disk (one twin), the disk standing in the array, cabled to a USB port on the node's side", () => {
    const disk = "k8s:c/node/n1/hw/disk/sdb";
    // The OSD is the disk now: its id, state and fill on the disk twin; no separate OSD twin; Ceph links straight to it.
    expect(s.byId.get(disk)!.twin).toMatchObject({ osdId: 0, up: true, in: true, fill: expect.any(Number) });
    expect(s.byId.get("k8s:c/ceph/ceph/osd/0")).toBeUndefined();
    expect(s.byId.get(disk)!.layer).toBe("hardware");
    const cable = l.links.find((x) => x.kind === "cable" && x.to === disk)!;
    expect(cable.layer).toBe("hardware");
    expect(cable.path[0]).toEqual(box("k8s:c/node/n1/hw/usb/1").center);
    // In the array the disk lies flat: wider than high.
    expect(box(disk).size[0]).toBeGreaterThan(box(disk).size[1]);
    // Its DB on the internal NVMe: a storage line from the disk.
    expect(l.links.some((x) => x.kind === "storage" && x.id === disk && x.to === "k8s:c/node/n1/hw/disk/nvme0n1")).toBe(true);
  });

  it("joins each container to its node's CPU and memory, and carries the readings", () => {
    const runs = l.links.filter((x) => x.kind === "resource" && x.id === "k8s:c/namespace/web/pod/site-1/container/app").map((x) => x.to);
    expect(runs.sort()).toEqual(["k8s:c/node/n1/hw/cpu", "k8s:c/node/n1/hw/memory"]);
    expect(withReadings.byId.get("k8s:c/node/n1/hw/cpu/core/0")!.resources).toEqual({ load: 0.97 });
    expect(withReadings.byId.get("k8s:c/namespace/web/pod/site-1/container/app")!.resources).toEqual({ cpu: 0.2, memory: 3e8 });
  });
});
