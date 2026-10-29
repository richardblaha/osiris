import { describe, expect, it } from "vitest";
import { interfaceErrors, relationshipErrors, resolveContents, twinErrors, type DigitalTwin, type DtdlInterface } from "@osiris/shared/dtdl.ts";
import { clusterGraph, nodeStatus, podStatus, type ClusterInput } from "../src/sources/kubernetes/graph.ts";
import type { PodObject } from "../src/sources/kubernetes/kube.ts";
import { dtdlModel, instanceId, MODEL } from "../src/sources/kubernetes/models.ts";
import { errorKey, errorsByTwin, toRelationship } from "../src/twin.ts";

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
    pod({ metadata: { name: "lonely", namespace: "osiris" } }),
    pod({
      metadata: { name: "db-0", namespace: "osiris", ownerReferences: [{ kind: "StatefulSet", name: "db", apiVersion: "apps/v1" }] },
      spec: { nodeName: "node1", volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data-db-0" } }, { name: "tmp" }], containers: [{ name: "app", volumeMounts: [{ name: "data", mountPath: "/var/lib/db" }, { name: "tmp", mountPath: "/tmp" }] }] },
    }),
  ],
  pvcs: [
    { metadata: { name: "data-db-0", namespace: "osiris" }, spec: { storageClassName: "local", accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "5Gi" } } }, status: { phase: "Bound", capacity: { storage: "10Gi" } } },
    { metadata: { name: "orphan", namespace: "osiris" }, spec: { resources: { requests: { storage: "500M" } } }, status: { phase: "Pending" } },
  ],
  nodes: [{ metadata: { name: "node1" }, status: { nodeInfo: { kubeletVersion: "v1.33.0" }, conditions: [{ type: "Ready", status: "True" }] } }],
  replicasets: [{ metadata: { name: "gateway-rs", namespace: "osiris", ownerReferences: [{ kind: "Deployment", name: "gateway" }] } }],
  version: "v1.33.0",
};

const models = new Map(dtdlModel().map((m): [string, DtdlInterface] => [m["@id"], m]));
const snapshot = clusterGraph(input);
const twins = new Map(snapshot.twins.map((t) => [t.$dtId, t as DigitalTwin]));
const twin = (model: string, name: string) => snapshot.twins.find((t) => t.$metadata.$model === model && t.name === name)!;

describe("the Kubernetes models", () => {
  it("are valid DTDL v3, each kind extending the twin's base Entity", () => {
    for (const m of dtdlModel()) expect(interfaceErrors(m)).toEqual([]);
    const pod = resolveContents(MODEL.Pod, models).map((c) => c.name);
    expect(pod).toEqual(expect.arrayContaining(["name", "status", "otelResource", "errorLogs", "phase", "namespace", "contains", "network"]));
  });

  it("make instance ids that never collide, whatever the names", () => {
    expect(instanceId("busiris", ["namespace", "osiris"], ["pod", "gateway-abc"])).toBe("k8s:busiris/namespace/osiris/pod/gateway-abc");
    expect(instanceId("c", ["namespace", "api.v1"])).not.toBe(instanceId("c", ["namespace", "api-v1"]));
    expect(instanceId("c", ["namespace", "A"])).not.toBe(instanceId("c", ["namespace", "a"]));
    expect(instanceId("c", ["namespace", "a/b"])).not.toBe(instanceId("c", ["namespace", "a"], ["b", ""]));
  });
});

describe("the cluster's twins", () => {
  it("are instances of their models, every property of the model's type", () => {
    for (const t of twins.values()) expect(twinErrors(t, models)).toEqual([]);
  });

  it("nest as the machines do (cluster, node, pod), namespaces and workloads related to their pods", () => {
    const rels = snapshot.relationships.map(toRelationship);
    for (const r of rels) expect(relationshipErrors(r, twins, models)).toEqual([]);
    const has = (name: string, from: string, to: string) => expect(snapshot.relationships).toContainEqual({ name, source: from, target: to });
    const root = twin(MODEL.Cluster, "busiris").$dtId;
    has("contains", root, twin(MODEL.Node, "node1").$dtId);
    has("contains", twin(MODEL.Node, "node1").$dtId, twin(MODEL.Pod, "gateway-abc").$dtId);
    // Not scheduled yet: the cluster's own.
    has("contains", root, twin(MODEL.Pod, "clickhouse-0").$dtId);
    has("hasNamespace", root, twin(MODEL.Namespace, "osiris").$dtId);
    has("hasWorkload", twin(MODEL.Namespace, "osiris").$dtId, twin(MODEL.Workload, "gateway").$dtId);
    has("hasPod", twin(MODEL.Workload, "gateway").$dtId, twin(MODEL.Pod, "gateway-abc").$dtId);
    // Every twin has at most one container.
    const parents = snapshot.relationships.filter((r) => r.name === "contains").map((r) => r.target);
    expect(new Set(parents).size).toBe(parents.length);
  });

  it("put a volume claim in the pod that mounts it, mounted by its containers; an unmounted one in the cluster", () => {
    const claim = twin(MODEL.PersistentVolumeClaim, "data-db-0");
    expect(claim).toMatchObject({ phase: "bound", capacity: "10Gi", storageClass: "local", accessModes: "ReadWriteOnce", status: "ok" });
    expect(claim.otelResource).toEqual({ "k8s.namespace.name": "osiris", "k8s.persistentvolumeclaim.name": "data-db-0" });
    const has = (name: string, from: string, to: string) => expect(snapshot.relationships).toContainEqual({ name, source: from, target: to });
    has("contains", twin(MODEL.Pod, "db-0").$dtId, claim.$dtId);
    has("mounts", instanceId("busiris", ["namespace", "osiris"], ["pod", "db-0"], ["container", "app"]), claim.$dtId);
    has("contains", twin(MODEL.Cluster, "busiris").$dtId, twin(MODEL.PersistentVolumeClaim, "orphan").$dtId);
    expect(twin(MODEL.PersistentVolumeClaim, "orphan")).toMatchObject({ status: "warn", capacity: "500M" });
  });

  it("group pods by owner: a Deployment through its ReplicaSet, an ownerless pod as its own workload", () => {
    expect(twin(MODEL.Workload, "gateway").ownerKind).toBe("Deployment");
    const lone = twin(MODEL.Workload, "lonely");
    expect(lone.ownerKind).toBe("Pod");
    expect(lone.$dtId).not.toBe(twin(MODEL.Pod, "lonely").$dtId);
  });

  it("carry their own status and the attributes naming their telemetry", () => {
    expect(twin(MODEL.Pod, "clickhouse-0")).toMatchObject({ status: "warn", phase: "pending" });
    // A namespace and a workload carry their worst pod's status, as nothing contains under them.
    expect(twin(MODEL.Namespace, "observability").status).toBe("warn");
    expect(twin(MODEL.Workload, "clickhouse").status).toBe("warn");
    expect(twin(MODEL.Namespace, "osiris").status).toBe("ok");
    expect(twin(MODEL.Pod, "gateway-abc").otelResource).toEqual({ "k8s.namespace.name": "osiris", "k8s.pod.name": "gateway-abc" });
  });

  it("get error counts by exactly the error attributes: pods, not their containers or namespace", () => {
    const counts = new Map([[errorKey(["osiris", "gateway-abc"]), 3]]);
    expect(errorsByTwin(snapshot.twins, ["k8s.namespace.name", "k8s.pod.name"], counts)).toEqual({ [twin(MODEL.Pod, "gateway-abc").$dtId]: 3 });
  });
});

describe("statuses", () => {
  it("mark failed pods as errors and pending or not-ready pods as warnings", () => {
    expect(podStatus(pod({ metadata: { name: "a", namespace: "n" }, status: { phase: "Failed" } }))).toBe("error");
    expect(podStatus(pod({ metadata: { name: "a", namespace: "n" }, status: { phase: "Pending" } }))).toBe("warn");
    expect(podStatus({ metadata: { name: "a", namespace: "n" }, spec: {}, status: { phase: "Running", containerStatuses: [{ name: "app", ready: false, restartCount: 1, image: "i" }] } })).toBe("warn");
    expect(podStatus(pod({ metadata: { name: "a", namespace: "n" } }))).toBe("ok");
    expect(podStatus(pod({ metadata: { name: "a", namespace: "n" }, status: { phase: "Succeeded" } }))).toBe("ok");
  });

  it("mark a node that isn't Ready as an error, pressure as a warning", () => {
    const node = (conditions: { type: string; status: string }[]) => ({ metadata: { name: "n" }, status: { conditions } });
    expect(nodeStatus(node([{ type: "Ready", status: "False" }]))).toBe("error");
    expect(nodeStatus(node([{ type: "Ready", status: "True" }, { type: "MemoryPressure", status: "True" }]))).toBe("warn");
    expect(nodeStatus(node([{ type: "Ready", status: "True" }, { type: "DiskPressure", status: "False" }]))).toBe("ok");
  });
});

describe("DTDL validation", () => {
  it("refuses what isn't DTDL v3", () => {
    expect(interfaceErrors({ "@context": "dtmi:dtdl:context;2", "@id": "dtmi:x:A;1", "@type": "Interface" })[0]).toMatch(/context/);
    expect(interfaceErrors({ "@context": "dtmi:dtdl:context;3", "@id": "x:A", "@type": "Interface" })[0]).toMatch(/DTMI/);
    const bad = { "@context": "dtmi:dtdl:context;3", "@id": "dtmi:x:A;1", "@type": "Interface", contents: [{ "@type": "Property", name: "a", schema: { "@type": "Enum", enumValues: [] } }, { "@type": "Property", name: "a", schema: "text" }] };
    expect(interfaceErrors(bad).join("\n")).toMatch(/valueSchema[\s\S]*duplicate[\s\S]*unknown schema text/);
  });

  it("refuses a twin whose values don't match its model", () => {
    const t = { $dtId: "x", $metadata: { $model: MODEL.Pod }, restarts: "two", color: "red" } as DigitalTwin;
    expect(twinErrors(t, models)).toEqual([expect.stringContaining("expected integer"), expect.stringContaining("no property color")]);
  });
});
