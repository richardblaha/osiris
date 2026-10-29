import { describe, expect, it } from "vitest";
import type { TwinGraph } from "@osiris/shared";
import { clusterGraph, nodeStatus, podStatus, type ClusterInput } from "../src/sources/kubernetes/graph.ts";
import type { PodObject } from "../src/sources/kubernetes/kube.ts";
import { dtdlModel, instanceId, MODEL } from "../src/sources/kubernetes/models.ts";
import { kubernetesSource } from "../src/sources/kubernetes/source.ts";
import { errorKey, graphOf, treeOf, type TwinSource } from "../src/twin.ts";

const pod = (over: Partial<PodObject> & { metadata: { name: string; namespace: string } }): PodObject => ({
  spec: {},
  status: { phase: "Running", containerStatuses: [{ name: "app", ready: true, restartCount: 0, image: "nginx:1" }] },
  ...over,
});

const input: ClusterInput = {
  clusterName: "busiris",
  namespaces: [{ metadata: { name: "osiris" }, status: { phase: "Active" } }, { metadata: { name: "observability" } }],
  pods: [
    pod({
      metadata: { name: "gateway-abc", namespace: "osiris", ownerReferences: [{ kind: "ReplicaSet", name: "gateway-rs", apiVersion: "apps/v1" }] },
      spec: { nodeName: "node1" },
    }),
    pod({
      metadata: { name: "clickhouse-0", namespace: "observability", ownerReferences: [{ kind: "StatefulSet", name: "clickhouse", apiVersion: "apps/v1" }] },
      status: { phase: "Pending", containerStatuses: [] },
    }),
  ],
  nodes: [{ metadata: { name: "node1" }, status: { nodeInfo: { kubeletVersion: "v1.33.0" }, conditions: [{ type: "Ready", status: "True" }] } }],
  replicasets: [{ metadata: { name: "gateway-rs", namespace: "osiris", ownerReferences: [{ kind: "Deployment", name: "gateway" }] } }],
  version: "v1.33.0",
};

/** The Kubernetes source with a fixed snapshot, for the generic graph and tree. */
const k8s: TwinSource = { ...kubernetesSource(undefined as never, "busiris"), snapshot: async () => clusterGraph(input) };
const counts = new Map([[errorKey(["osiris", "gateway-abc"]), 3]]);

describe("the Kubernetes models", () => {
  it("define one DTDL interface per kind, containment and placement as relationships", () => {
    const docs = dtdlModel();
    expect(docs.map((d) => d["@id"])).toEqual([MODEL.Cluster, MODEL.Namespace, MODEL.Workload, MODEL.Pod, MODEL.Container, MODEL.Node]);
    for (const doc of docs) {
      expect(doc["@context"]).toBe("dtmi:dtdl:context;2");
      expect(doc["@type"]).toBe("Interface");
    }
    expect(docs[0]!.contents).toContainEqual(expect.objectContaining({ "@type": "Relationship", name: "contains", target: MODEL.Namespace }));
    expect(docs[3]!.contents).toContainEqual(expect.objectContaining({ "@type": "Relationship", name: "runsOn", target: MODEL.Node }));
  });

  it("make instance ids that never collide, whatever the names", () => {
    expect(instanceId("busiris", ["namespace", "osiris"], ["pod", "gateway-abc"])).toBe("k8s:busiris/namespace/osiris/pod/gateway-abc");
    // Names that used to fold into one id stay apart.
    expect(instanceId("c", ["namespace", "api.v1"])).not.toBe(instanceId("c", ["namespace", "api-v1"]));
    expect(instanceId("c", ["namespace", "A"])).not.toBe(instanceId("c", ["namespace", "a"]));
    expect(instanceId("c", ["namespace", "a/b"])).not.toBe(instanceId("c", ["namespace", "a"], ["b", ""]));
  });
});

describe("the cluster's graph", () => {
  const snapshot = clusterGraph(input);
  const graph = graphOf(k8s, snapshot, counts, 1);
  const entity = (kind: string, name: string) => graph.entities.find((e) => e.kind === kind && e.name === name)!;

  it("has an entity per object, each an instance of its model, with the attributes of its telemetry", () => {
    expect(entity("cluster", "busiris").id).toBe(graph.root);
    expect(entity("workload", "gateway").properties.kind).toBe("Deployment"); // through the ReplicaSet
    expect(entity("pod", "gateway-abc")).toMatchObject({ model: MODEL.Pod, telemetry: { "k8s.namespace.name": "osiris", "k8s.pod.name": "gateway-abc" } });
    expect(entity("node", "node1").model).toBe(MODEL.Node);
  });

  it("relates them: containment down the tree, nodes of the cluster, pods to their node", () => {
    const rel = (name: string, from: string, to: string) => ({ name, source: from, target: to });
    expect(graph.relationships).toContainEqual(rel("contains", graph.root, entity("namespace", "osiris").id));
    expect(graph.relationships).toContainEqual(rel("contains", entity("workload", "gateway").id, entity("pod", "gateway-abc").id));
    expect(graph.relationships).toContainEqual(rel("hasNode", graph.root, entity("node", "node1").id));
    expect(graph.relationships).toContainEqual(rel("runsOn", entity("pod", "gateway-abc").id, entity("node", "node1").id));
  });

  it("gives error counts to the entities named by exactly the error attributes: pods, not their containers", () => {
    expect(entity("pod", "gateway-abc").errors).toBe(3);
    expect(entity("container", "app").errors).toBe(0);
    expect(entity("namespace", "osiris").errors).toBe(0);
  });
});

describe("treeOf", () => {
  const tree = treeOf(graphOf(k8s, clusterGraph(input), counts, 1));
  const ns = (name: string) => tree.cluster.children.find((n) => n.name === name)!;

  it("nests by containment: namespaces, workloads, pods, containers; nodes stay out of it", () => {
    expect(tree.cluster.kind).toBe("cluster");
    expect(tree.cluster.children.map((c) => c.name)).toEqual(["observability", "osiris"]);
    const [gateway] = ns("osiris").children;
    expect(gateway!.name).toBe("gateway");
    expect(gateway!.children[0]!.name).toBe("gateway-abc");
    expect(gateway!.children[0]!.children[0]!.kind).toBe("container");
    expect(tree.ts).toBe(1);
  });

  it("rolls error counts and status up", () => {
    expect(ns("osiris").errors).toBe(3);
    expect(tree.cluster.errors).toBe(3);
    expect(ns("observability").status).toBe("warn"); // a pending pod
    expect(tree.cluster.status).toBe("warn");
  });

  it("groups ownerless pods under themselves", () => {
    const lonely = treeOf(graphOf(k8s, clusterGraph({ ...input, pods: [pod({ metadata: { name: "lonely", namespace: "osiris" } })] })));
    const workload = lonely.cluster.children.find((n) => n.name === "osiris")!.children[0]!;
    expect(workload.properties.kind).toBe("Pod");
    expect(workload.name).toBe("lonely");
    expect(workload.children[0]!.id).not.toBe(workload.id);
  });

  it("works for any source's graph, and never repeats a node on a cycle", () => {
    const graph: TwinGraph = {
      source: "building",
      root: "b",
      entities: [
        { id: "b", model: "dtmi:acme:Building;1", kind: "building", name: "HQ", status: "ok", errors: 0, properties: {} },
        { id: "r", model: "dtmi:acme:Room;1", kind: "room", name: "101", status: "error", errors: 2, properties: {} },
      ],
      relationships: [
        { name: "contains", source: "b", target: "r" },
        { name: "contains", source: "r", target: "b" },
        { name: "feeds", source: "r", target: "b" },
      ],
      ts: 1,
    };
    const t = treeOf(graph);
    expect(t.cluster).toMatchObject({ name: "HQ", status: "error", errors: 2 });
    expect(t.cluster.children[0]!.children).toEqual([]);
  });
});

describe("statuses", () => {
  it("marks failed pods as errors and pending or not-ready pods as warnings", () => {
    expect(podStatus(pod({ metadata: { name: "a", namespace: "n" }, status: { phase: "Failed" } }))).toBe("error");
    expect(podStatus(pod({ metadata: { name: "a", namespace: "n" }, status: { phase: "Pending" } }))).toBe("warn");
    expect(
      podStatus({
        metadata: { name: "a", namespace: "n" },
        spec: {},
        status: { phase: "Running", containerStatuses: [{ name: "app", ready: false, restartCount: 1, image: "i" }] },
      }),
    ).toBe("warn");
    expect(podStatus(pod({ metadata: { name: "a", namespace: "n" } }))).toBe("ok");
    expect(podStatus(pod({ metadata: { name: "a", namespace: "n" }, status: { phase: "Succeeded" } }))).toBe("ok");
  });

  it("marks a node that isn't Ready as an error, pressure as a warning", () => {
    const node = (conditions: { type: string; status: string }[]) => ({ metadata: { name: "n" }, status: { conditions } });
    expect(nodeStatus(node([{ type: "Ready", status: "False" }]))).toBe("error");
    expect(nodeStatus(node([{ type: "Ready", status: "True" }, { type: "MemoryPressure", status: "True" }]))).toBe("warn");
    expect(nodeStatus(node([{ type: "Ready", status: "True" }, { type: "DiskPressure", status: "False" }]))).toBe("ok");
  });
});
