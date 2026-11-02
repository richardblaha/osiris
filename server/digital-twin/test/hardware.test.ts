import { describe, expect, it } from "vitest";
import { relationshipErrors, twinErrors, type DigitalTwin, type DtdlInterface } from "@osiris/shared/dtdl.ts";
import type { CephOsd, CephState } from "../src/sources/kubernetes/ceph.ts";
import { clusterGraph, lanIds, type ClusterInput } from "../src/sources/kubernetes/graph.ts";
import { dtdlModel, MODEL } from "../src/sources/kubernetes/models.ts";
import { toRelationship } from "../src/twin.ts";
import { buildScene, layoutRules } from "../web/src/scene.ts";
import { layoutTwin, type Box } from "../web/src/TwinLayout.ts";

const node = (name: string, ip: string, labels: Record<string, string>) => ({
  metadata: { name, labels, annotations: { "projectcalico.org/IPv4Address": `${ip}/24` } },
  status: { addresses: [{ type: "InternalIP", address: ip }], capacity: { cpu: "4", memory: "16Gi" } },
});
const osd = (id: number, host: string, device: string): CephOsd => ({
  id, host, address: "", deviceClass: "hdd", device: `/dev/${device}`, model: "", dbDevice: "", devices: { [device]: `DISK_${id}`, nvme0n1: `NVME_${host}` }, up: true, in: true, size: 1e12, used: 1e11,
});
const ceph: CephState = { fsid: "f", checks: [], monitors: 3, quorum: 3, pgs: { total: 1, clean: 1, degraded: 0 }, readBytes: 0, writeBytes: 0, health: 0, version: "19", size: 3e12, used: 3e11, pools: [], osds: [osd(0, "worker-2", "sdb"), osd(1, "control-1", "sdb"), osd(2, "worker-1", "sdb"), osd(3, "worker-1", "sdc")] };
const pod = (name: string, ns: string, nodeName: string, ip: string) => ({
  metadata: { name, namespace: ns },
  spec: { nodeName },
  status: { phase: "Running", podIP: ip, containerStatuses: [{ name: "app", ready: true, restartCount: 0, image: "x" }] },
});
const input: ClusterInput = {
  clusterName: "c",
  namespaces: [{ metadata: { name: "web" } }, { metadata: { name: "db" } }],
  // Listed out of order: the stack puts the control plane on top, the workers below it by name.
  nodes: [node("worker-2", "192.168.0.242", { "node.kubernetes.io/microk8s-worker": "microk8s-worker" }), node("control-1", "192.168.0.231", { "node.kubernetes.io/microk8s-controlplane": "microk8s-controlplane" }), node("worker-1", "192.168.0.241", {})],
  pods: [pod("site-1", "web", "control-1", "10.1.0.10"), pod("site-2", "web", "worker-1", "10.1.0.11"), pod("pg-0", "db", "worker-2", "10.1.0.12")],
  replicasets: [],
  version: null,
  ceph,
  lan: { routerModel: "Archer C6 R2" },
};
const g = clusterGraph(input);
const models = dtdlModel().map((m) => ({ id: m["@id"], model: m, uploadTime: "", decommissioned: false }));
const scene = buildScene(models, g.twins.map((t) => ({ ...t, $etag: "", $metadata: { $model: t.$metadata.$model } })) as DigitalTwin[], g.relationships.map(toRelationship), {}, {}, {}, null);
const layout = layoutTwin(scene.top, layoutRules(scene));
const box = (id: string) => layout.boxes.find((b) => b.id === id)!;
const nodeId = (name: string) => `k8s:c/node/${name}`;
const min = (b: Box, i: number) => b.center[i]! - b.size[i]! / 2;
const max = (b: Box, i: number) => b.center[i]! + b.size[i]! / 2;
const inside = (inner: Box, outer: Box) => [0, 1, 2].every((i) => min(inner, i) >= min(outer, i) - 1e-6 && max(inner, i) <= max(outer, i) + 1e-6);

describe("the cluster's LAN", () => {
  const lan = lanIds("k8s:c");
  it("plugs every node's card into a port of one switch, the switch into the router, valid against the models", () => {
    expect(g.twins.find((t) => t.$dtId === lan.router)).toMatchObject({ $metadata: { $model: MODEL.Router }, model: "Archer C6 R2" });
    expect(g.twins.find((t) => t.$dtId === lan.switch)).toMatchObject({ $metadata: { $model: MODEL.Switch }, portCount: 4 });
    expect(g.relationships).toContainEqual({ name: "connectedTo", source: lan.switchPort(0), target: lan.routerLan });
    // The ports in the nodes' order by name: control-1, worker-1, worker-2.
    expect(g.relationships).toContainEqual({ name: "connectedTo", source: `${nodeId("control-1")}/if/nic`, target: lan.switchPort(1) });
    expect(g.relationships).toContainEqual({ name: "connectedTo", source: `${nodeId("worker-2")}/if/nic`, target: lan.switchPort(3) });
    expect(g.twins.find((t) => t.$dtId === nodeId("control-1"))).toMatchObject({ role: "control-plane" });
    expect(g.twins.find((t) => t.$dtId === nodeId("worker-1"))).toMatchObject({ role: "worker" });
    const byModel = new Map(dtdlModel().map((m): [string, DtdlInterface] => [m["@id"], m]));
    for (const t of g.twins) expect(twinErrors(t as DigitalTwin, byModel)).toEqual([]);
    const byId = new Map(g.twins.map((t) => [t.$dtId, t as DigitalTwin]));
    for (const r of g.relationships) expect(relationshipErrors(toRelationship(r), byId, byModel)).toEqual([]);
  });

  it("has neither without the setting", () => {
    const without = clusterGraph({ ...input, lan: undefined });
    expect(without.twins.some((t) => t.$metadata.$model === MODEL.Switch || t.$metadata.$model === MODEL.Router)).toBe(false);
  });
});

describe("the machines' layout", () => {
  it("holds only the machines in the cluster's solid: the switch, the router and Ceph stand outside it", () => {
    const cluster = box("k8s:c");
    for (const n of ["control-1", "worker-1", "worker-2"]) expect(inside(box(nodeId(n)), cluster)).toBe(true);
    const lan = lanIds("k8s:c");
    for (const id of [lan.switch, lan.router, "k8s:c/ceph/ceph"]) {
      const b = box(id);
      const apart = [0, 2].some((i) => min(b, i) >= max(cluster, i) - 1e-6 || max(b, i) <= min(cluster, i) + 1e-6);
      expect(apart, id).toBe(true);
    }
  });

  it("stacks the machines lying flat, the control plane on top, the workers below by name", () => {
    const [c1, w1, w2] = ["control-1", "worker-1", "worker-2"].map((n) => box(nodeId(n)));
    expect(c1!.center[1]).toBeGreaterThan(w1!.center[1]);
    expect(w1!.center[1]).toBeGreaterThan(w2!.center[1]);
    // One above another, the same machine each time, wider and deeper than high.
    expect(c1!.center[0]).toBeCloseTo(w2!.center[0]);
    expect(c1!.size).toEqual(w2!.size);
    expect(Math.min(c1!.size[0], c1!.size[2])).toBeGreaterThan(c1!.size[1] * 2);
    expect(min(w1!, 1)).toBeGreaterThan(max(w2!, 1));
  });

  it("covers a machine's floor with its CPU, memory and NVMe, its USB disks outside it and the cluster, cabled to its side", () => {
    const n = box(nodeId("worker-1"));
    const parts = ["cpu", "memory", "disk/nvme0n1"].map((p) => box(`${nodeId("worker-1")}/hw/${p}`));
    for (const p of parts) expect(inside(p, n)).toBe(true);
    const covered = parts.reduce((sum, p) => sum + p.size[0] * p.size[2], 0);
    expect(covered / (n.size[0] * n.size[2])).toBeGreaterThan(0.6);
    // Every part low on the floor, under the pods.
    const pod = box("k8s:c/namespace/web/pod/site-2");
    for (const p of parts) expect(max(p, 1)).toBeLessThan(min(pod, 1));
    const cluster = box("k8s:c");
    for (const d of ["sdb", "sdc"]) {
      const disk = box(`${nodeId("worker-1")}/hw/disk/${d}`);
      expect(min(disk, 0)).toBeGreaterThan(max(cluster, 0));
      const cable = layout.links.find((l) => l.kind === "cable" && l.to === disk.id)!;
      expect(cable.layer).toBe("hardware");
      // From a USB port on the machine's right wall, facing out, into the disk's back where its connector is.
      const port = box(cable.id);
      expect(port.normal).toEqual([1, 0, 0]);
      expect(port.center[0]).toBeCloseTo(max(n, 0));
      expect(cable.path[0]).toEqual(port.center);
      expect(cable.path.at(-1)![0]).toBeCloseTo(disk.center[0]);
      expect(cable.path.at(-1)![2]).toBeCloseTo(min(disk, 2));
    }
  });

  it("cables each card to its switch port behind the stack, the switch to the router, the router's WAN to the internet", () => {
    const lan = lanIds("k8s:c");
    const sw = box(lan.switch);
    const stack = box(nodeId("worker-2"));
    expect(max(sw, 2)).toBeLessThan(min(stack, 2));
    for (const [name, port] of [["control-1", 1], ["worker-1", 2], ["worker-2", 3]] as const) {
      const cable = layout.links.find((l) => l.kind === "ethernet" && l.id === nodeId(name))!;
      expect(cable.to).toBe(lan.switchPort(port));
      expect(cable.path[0]).toEqual(box(`${nodeId(name)}/if/nic`).center);
      expect(cable.path.at(-1)).toEqual(box(lan.switchPort(port)).center);
      expect(box(lan.switchPort(port)).normal).toEqual([0, 0, 1]);
      // Right angles only.
      for (let i = 1; i < cable.path.length; i++) expect(cable.path[i]!.filter((v, k) => Math.abs(v - cable.path[i - 1]![k]!) > 1e-6).length).toBe(1);
    }
    expect(layout.links.some((l) => l.kind === "ethernet" && l.to === lan.routerLan)).toBe(true);
    const wan = box(lan.routerWan);
    expect(layout.links.find((l) => l.kind === "internet" && l.layer === "network")!.path[0]).toEqual(wan.center);
    // The cluster's own hub no longer runs a line to each node: the switch does.
    expect(layout.links.some((l) => l.kind === "network" && l.id === nodeId("worker-1"))).toBe(false);
  });
});
