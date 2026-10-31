import { describe, expect, it } from "vitest";
import { clusterGraph, type ClusterInput } from "../src/sources/kubernetes/graph.ts";
import type { PodObject } from "../src/sources/kubernetes/kube.ts";
import { dtdlModel } from "../src/sources/kubernetes/models.ts";
import { toRelationship } from "../src/twin.ts";
import { buildScene, passes, scopeOf, type TwinView } from "../web/src/scene.ts";
import { layoutTwin } from "../web/src/TwinLayout.ts";
import { hasNetwork, interfacesOf, isStorage, routingOf, wiresOf } from "../web/src/scene.ts";
import { PRESENTATION_CONTEXT, type DtdlInterface } from "@osiris/shared/dtdl.ts";

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
      "    calico",
      "    (db) @osiris",
      "      db-0",
      "        app",
      "        data-db-0",
      "    lone @obs",
      "      app",
      "    nic",
      "  n2",
      "    calico",
      "    (db) @osiris",
      "      db-1",
      "        app",
      "    nic",
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
    const layout = layoutTwin(scene.top, {
      networked: (n) => hasNetwork(n, scene.models),
      storage: (n) => isStorage(n, scene.models),
      shape: (n) => (n.model.startsWith("dtmi:osiris:net:Interface") ? "port" : undefined),
      portKind: (n) => String(n.twin.kind),
      interfaces: interfacesOf(scene),
      wires: wiresOf(scene),
      virtual: routingOf(scene),
    });
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
    const layout = layoutTwin(scene.top, {
      networked: (n) => hasNetwork(n, scene.models),
      storage: (n) => isStorage(n, scene.models),
      shape: (n) => (n.model.startsWith("dtmi:osiris:net:Interface") ? "port" : undefined),
      portKind: (n) => String(n.twin.kind),
      interfaces: interfacesOf(scene),
      wires: wiresOf(scene),
      virtual: routingOf(scene),
    });
    expect(layout.boxes.find((b) => b.id.endsWith("pvc/data-db-0"))?.shape).toBe("cylinder");
    expect(layout.links.filter((l) => l.kind === "interface")).toHaveLength(1);
    // The node's card and router are ports on its back wall, wired together, not cells inside it.
    const n1 = layout.boxes.find((b) => b.id === "k8s:c/node/n1")!;
    for (const id of ["k8s:c/node/n1/if/nic", "k8s:c/node/n1/if/router"]) {
      const p = layout.boxes.find((b) => b.id === id)!;
      expect(p.shape).toBe("port");
      expect(p.center[2]).toBeCloseTo(n1.center[2] - n1.size[2] / 2);
    }
    expect(layout.links.filter((l) => l.kind === "wire").map((l) => [l.id, l.to])).toContainEqual(["k8s:c/node/n1/if/router", "k8s:c/node/n1/if/nic"]);
  });
});

describe("the view's presentation and filters", () => {
  it("draws each twin as its model's presentation says, else the built-in look of its DTMI", () => {
    // The built-ins: a pod is a pod, an interface a port, a claim a cylinder.
    const byModel = new Map([...scene.byId.values()].filter((v) => !v.of).map((v) => [v.model, v]));
    expect(byModel.get("dtmi:osiris:k8s:Pod;3")!.look).toBe("pod");
    expect(byModel.get("dtmi:osiris:net:Interface;1")!.look).toBe("port");
    expect(byModel.get("dtmi:osiris:k8s:PersistentVolumeClaim;1")!.look).toBe("cylinder");
    // A model with a presentation overrides it (and extends is resolved through the base).
    const custom: DtdlInterface = {
      "@context": [ "dtmi:dtdl:context;3", PRESENTATION_CONTEXT ],
      "@id": "dtmi:osiris:k8s:Pod;3",
      "@type": "Interface",
      extends: "dtmi:osiris:twin:Entity;1",
      contents: [{ "@type": "Property", name: "name", schema: "string" }],
      presentation: { look: "hex", color: "#ff00ff", label: "name", layer: "logical", visible: true },
    };
    const withCustom = buildScene([...models.filter((m) => m.id !== custom["@id"]), { id: custom["@id"], model: custom, uploadTime: "", decommissioned: false }], snapshot.twins.map((t) => ({ ...t, $etag: "", $metadata: { $model: t.$metadata.$model } })), snapshot.relationships.map(toRelationship), {}, {}, {}, null);
    const pod = [...withCustom.byId.values()].find((v) => !v.of && v.model === custom["@id"])!;
    expect([pod.look, pod.color, pod.labelProp, pod.layer, pod.visible]).toEqual(["hex", "#ff00ff", "name", "logical", true]);
  });

  it("filters: a hidden model hides its twins and their children, a status and a search filter the rest", () => {
    const all = [...scene.byId.values()].filter((v) => !v.of && !v.isBand);
    const none = { hiddenModels: new Set<string>() };
    expect(all.every((v) => passes(v, none))).toBe(true);
    // Hiding the pod model hides the pods and their containers, not the node.
    const noPods = { hiddenModels: new Set(["dtmi:osiris:k8s:Pod;3"]) };
    const pods = all.filter((v) => v.model === "dtmi:osiris:k8s:Pod;3");
    const containers = all.filter((v) => v.model === "dtmi:osiris:k8s:Container;3");
    expect(pods.length).toBeGreaterThan(0);
    expect(pods.every((v) => !passes(v, noPods))).toBe(true);
    expect(containers.every((v) => !passes(v, noPods))).toBe(true);
    expect(passes(scene.byId.get("k8s:c/node/n1")!, noPods)).toBe(true);
    // A search matches a name or a descendant's.
    const db = all.filter((v) => passes(v, { hiddenModels: new Set(), query: "db-0" }));
    expect(db.map((v) => v.name)).toEqual(expect.arrayContaining(["db-0", "app"]));
    expect(db.some((v) => v.name === "n2")).toBe(false);
    // The presentation's visible=false hides the model too.
    const invisible: DtdlInterface = { ...models.find((m) => m.id === "dtmi:osiris:k8s:Node;3")!.model, presentation: { visible: false } };
    invisible["@context"] = ["dtmi:dtdl:context;3", PRESENTATION_CONTEXT];
    const noNodes = buildScene([...models.filter((m) => m.id !== invisible["@id"]), { id: invisible["@id"], model: invisible, uploadTime: "", decommissioned: false }], snapshot.twins.map((t) => ({ ...t, $etag: "", $metadata: { $model: t.$metadata.$model } })), snapshot.relationships.map(toRelationship), {}, {}, {}, null);
    expect(passes(noNodes.byId.get("k8s:c/node/n1")!, none)).toBe(false);
  });
});
