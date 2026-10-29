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
/** The tree as lines of names, a projection in brackets (dashed: a grouping). */
const tree = (v: TwinView, depth = 0): string[] => [`${"  ".repeat(depth)}${v.of ? (v.dashed ? `[${v.name}]` : `(${v.name})`) : v.name}`, ...v.children.flatMap((c) => tree(c, depth + 1))];

describe("the twin's view", () => {
  it("shows namespaces and workloads inside each node as projections of the pods they hold there", () => {
    expect(scene.top.flatMap((r) => tree(r))).toEqual([
      "c",
      "  n1",
      "    [obs]",
      "      lone",
      "        app",
      "    [osiris]",
      "      (db)",
      "        db-0",
      "          app",
      "          data-db-0",
      "  n2",
      "    [osiris]",
      "      (db)",
      "        db-1",
      "          app",
      "  [obs]",
      "    free",
      "    (j)",
      "      pend",
      "        app",
    ]);
  });

  it("scopes a projection's telemetry to its group on the node it lies in, and carries its pods' traffic", () => {
    const ns = scene.byId.get("k8s:c/node/n1>k8s:c/namespace/osiris")!;
    expect(scopeOf(ns)).toMatchObject({ namespace: "osiris", node: "n1" });
    expect(ns.network).toBe(100);
    expect(hasNetwork(ns, scene.models)).toBe(true);
  });

  it("lays out volume claims as cylinders, mounts as interfaces between siblings", () => {
    const layout = layoutTwin(scene.top, { networked: (n) => hasNetwork(n, scene.models), storage: (n) => isStorage(n, scene.models), interfaces: interfacesOf(scene) });
    expect(layout.boxes.find((b) => b.id.endsWith("pvc/data-db-0"))?.shape).toBe("cylinder");
    expect(layout.links.filter((l) => l.kind === "interface")).toHaveLength(1);
  });
});
