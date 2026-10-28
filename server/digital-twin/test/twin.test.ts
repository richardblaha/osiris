import { describe, expect, it } from "vitest";
import { dtdlModel, instanceId, MODEL } from "../src/dtdl.ts";
import { buildTwin, podStatus } from "../src/twin.ts";
import type { PodObject } from "../src/kube.ts";

const pod = (over: Partial<PodObject> & { metadata: { name: string; namespace: string } }): PodObject => ({
  spec: {},
  status: { phase: "Running", containerStatuses: [{ name: "app", ready: true, restartCount: 0, image: "nginx:1" }] },
  ...over,
});

const input = {
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
  nodes: [{ metadata: { name: "node1" }, status: { nodeInfo: { kubeletVersion: "v1.33.0" } } }],
  version: "v1.33.0",
  deploymentOf: new Map([["osiris/gateway-rs", "gateway"]]),
  podErrors: new Map([["osiris/gateway-abc", 3]]),
};

describe("dtdlModel", () => {
  it("defines one interface per node kind, the nesting as relationships", () => {
    const docs = dtdlModel();
    expect(docs.map((d) => d["@id"])).toEqual([MODEL.Cluster, MODEL.Namespace, MODEL.Workload, MODEL.Pod, MODEL.Container]);
    for (const doc of docs) {
      expect(doc["@context"]).toBe("dtmi:dtdl:context;2");
      expect(doc["@type"]).toBe("Interface");
    }
    const cluster = docs[0]!;
    expect(cluster.contents).toContainEqual(expect.objectContaining({ "@type": "Relationship", target: MODEL.Namespace }));
  });

  it("makes valid instance ids out of k8s names", () => {
    expect(instanceId("osiris", "Gateway.ABC", "pod/x")).toBe("dtmi:osiris:k8s:instance:osiris:gateway-abc:pod-x");
  });
});

describe("buildTwin", () => {
  const twin = buildTwin(input);
  const ns = (name: string) => twin.cluster.children.find((n) => n.name === name)!;
  const osiris = ns("osiris");
  const observability = ns("observability");

  it("nests namespaces under the cluster, workloads under namespaces, pods and containers under those", () => {
    expect(twin.cluster.kind).toBe("cluster");
    expect(twin.cluster.name).toBe("busiris");
    expect(osiris.name).toBe("osiris");
    expect(osiris.model).toBe(MODEL.Namespace);
    const [gateway] = osiris.children;
    expect(gateway!.kind).toBe("workload");
    expect(gateway!.name).toBe("gateway"); // through the ReplicaSet
    expect(gateway!.properties.kind).toBe("Deployment");
    const [podNode] = gateway!.children;
    expect(podNode!.name).toBe("gateway-abc");
    expect(podNode!.children[0]!.kind).toBe("container");
    expect(twin.ts).toBeGreaterThan(0);
  });

  it("rolls error counts and status up the tree", () => {
    expect(osiris.errors).toBe(3);
    expect(twin.cluster.errors).toBe(3);
    expect(observability.status).toBe("warn"); // a pending pod
    expect(twin.cluster.status).toBe("warn");
  });

  it("groups ownerless pods under themselves", () => {
    const lonely = buildTwin({ ...input, pods: [pod({ metadata: { name: "lonely", namespace: "osiris" } })] });
    const workload = lonely.cluster.children.find((n) => n.name === "osiris")!.children[0]!;
    expect(workload.properties.kind).toBe("Pod");
    expect(workload.name).toBe("lonely");
  });
});

describe("podStatus", () => {
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
});
