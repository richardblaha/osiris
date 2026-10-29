import { describe, expect, it } from "vitest";
import { clusterGraph, type ClusterInput } from "../src/sources/kubernetes/graph.ts";
import type { PodObject } from "../src/sources/kubernetes/kube.ts";
import { dtdlModel } from "../src/sources/kubernetes/models.ts";
import { toRelationship } from "../src/twin.ts";
import { buildScene, scopeOf, type TwinView } from "../web/src/scene.ts";
import { layoutTwin } from "../web/src/TwinLayout.ts";
import { hasNetwork, interfacesOf, isStorage } from "../web/src/scene.ts";

const pod = (name: string, namespace: string, owner: [string, string] | null, node?: string, claim?: string): PodObject => ({
  metadata: { name, namespace, ...(owner ? { ownerReferences: [{ kind: owner[0], name: owner[1], apiVersion: "v1" }] } : {}) },
  spec: { nodeName: node, ...(claim ? { volumes: [{ name: "d", persistentVolumeClaim: { claimName: claim } }], containers: [{ name: "app", volumeMounts: [{ name: "d", mountPath: "/d" }] }] } : {}) },
  status: { phase: "Running", containerStatuses: [{ name: "app", ready: true, restartCount: 0, image: "x" }] },
});
const input: ClusterInput = {
  clusterName: "c",
  namespaces: [{ metadata: { name: "osiris" } }, { metadata: { name: "obs" } }],
  nodes: [{ metadata: { name: "n1" } }, { metadata: { name: "n2" } }],
  pods: [pod("db-0", "osiris", ["StatefulSet", "db"], "n1", "data-db-0"), pod("db-1", "osiris", ["StatefulSet", "db"], "n2"), pod("lone", "obs", null, "n1"), pod("pend", "obs", ["Job", "j"])],
  pvcs: [{ metadata: { name: "data-db-0", namespace: "osiris" }, status: { phase: "Bound" } }, { metadata: { name: "free", namespace: "obs" }, status: { phase: "Bound" } }],
  replicasets: [],
  version: null,
};
const snapshot = clusterGraph(input);
const models = dtdlModel().map((m) => ({ id: m["@id"], model: m, uploadTime: "", decommissioned: false }));
const scene = buildScene(models, snapshot.twins.map((t) => ({ ...t, $etag: "", $metadata: { $model: t.$metadata.$model } })), snapshot.relationships.map(toRelationship), {}, { "k8s:c/namespace/osiris/pod/db-0": 100 }, {}, null);
/** The tree as lines of names, a projection in parentheses, a band (a namespace) after the name. */
const tree = (v: TwinView, depth = 0): string[] => [
  `${"  ".repeat(depth)}${v.of ? `(${v.name})` : v.name}${v.band ? ` @${scene.byId.get(v.band)?.name}` : ""}`,
  ...v.children.flatMap((c) => tree(c, depth + 1)),
];

describe("the twin's view", () => {
  it("nests as the machines do, workloads projected into each node, namespaces as bands across them", () => {
    expect(scene.top.flatMap((r) => tree(r))).toEqual([
      "c",
      "  free @obs",
      "  (j) @obs",
      "    pend",
      "      app",
      "  n1",
      "    (db) @osiris",
      "      db-0",
      "        app",
      "        data-db-0",
      "    lone @obs",
      "      app",
      "  n2",
      "    (db) @osiris",
      "      db-1",
      "        app",
    ]);
    expect(scene.bands.map((b) => [b.name, b.dashed, b.parent?.name])).toEqual([
      ["obs", true, "c"],
      ["osiris", true, "c"],
    ]);
  });

  it("scopes a projection's telemetry to its group on the node it lies in, a band's to its whole group, and carries traffic", () => {
    const db = scene.byId.get("k8s:c/node/n1>k8s:c/namespace/osiris/workload-statefulset/db")!;
    expect(scopeOf(db)).toMatchObject({ namespace: "osiris", node: "n1" });
    expect(db.network).toBe(100);
    expect(hasNetwork(db, scene.models)).toBe(true);
    const osiris = scene.bands.find((b) => b.name === "osiris")!;
    expect(scopeOf(osiris)).toEqual(expect.objectContaining({ namespace: "osiris", node: undefined }));
    expect(osiris.network).toBe(100);
    // The node's kubelet reports no node network here: it carries its pods'.
    expect(scene.byId.get("k8s:c/node/n1")!.network).toBe(100);
  });

  it("draws each namespace as one solid around all of it, across the nodes, never overlapping another", () => {
    const layout = layoutTwin(scene.top, { networked: (n) => hasNetwork(n, scene.models), storage: (n) => isStorage(n, scene.models), interfaces: interfacesOf(scene) });
    const box = new Map(layout.boxes.map((b) => [b.id, b]));
    const inside = (outer: { center: number[]; size: number[] }, inner: { center: number[]; size: number[] }) =>
      [0, 1, 2].every((i) => inner.center[i]! - inner.size[i]! / 2 >= outer.center[i]! - outer.size[i]! / 2 - 1e-9 && inner.center[i]! + inner.size[i]! / 2 <= outer.center[i]! + outer.size[i]! / 2 + 1e-9);
    const overlap = (a: { center: number[]; size: number[] }, b: { center: number[]; size: number[] }) =>
      [0, 1, 2].every((i) => Math.abs(a.center[i]! - b.center[i]!) < (a.size[i]! + b.size[i]!) / 2);
    for (const band of scene.bands) {
      const solid = box.get(band.id)!;
      expect(solid, band.name).toBeDefined();
      // Everything that belongs to it, in any node or none, is inside it.
      const members = [...scene.byId.values()].filter((v) => v.band === band.of && !v.isBand);
      for (const m of members) expect(inside(solid, box.get(m.id)!), `${m.name} in ${band.name}`).toBe(true);
    }
    const [a, b] = scene.bands.map((x) => box.get(x.id)!);
    expect(overlap(a!, b!)).toBe(false);
    // The osiris band spans both nodes: it reaches from n1's inside into n2's.
    const osiris = box.get(scene.bands.find((x) => x.name === "osiris")!.id)!;
    for (const n of ["k8s:c/node/n1", "k8s:c/node/n2"]) expect(overlap(osiris, box.get(n)!)).toBe(true);
    // Every node is inside the cluster, every pod inside its node.
    for (const n of ["k8s:c/node/n1", "k8s:c/node/n2"]) expect(inside(box.get("k8s:c")!, box.get(n)!)).toBe(true);
    expect(inside(box.get("k8s:c/node/n1")!, box.get("k8s:c/namespace/osiris/pod/db-0")!)).toBe(true);
  });

  it("lays out volume claims as cylinders, mounts as interfaces between siblings", () => {
    const layout = layoutTwin(scene.top, { networked: (n) => hasNetwork(n, scene.models), storage: (n) => isStorage(n, scene.models), interfaces: interfacesOf(scene) });
    expect(layout.boxes.find((b) => b.id.endsWith("pvc/data-db-0"))?.shape).toBe("cylinder");
    expect(layout.links.filter((l) => l.kind === "interface")).toHaveLength(1);
  });
});
