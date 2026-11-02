import { describe, expect, it } from "vitest";
import { relationshipErrors, twinErrors, type DigitalTwin, type DtdlInterface } from "@osiris/shared/dtdl.ts";
import { clusterGraph, lanIds, type ClusterInput } from "../src/sources/kubernetes/graph.ts";
import { dtdlModel, MODEL } from "../src/sources/kubernetes/models.ts";
import { probeService, publicAddressesOf } from "../src/sources/kubernetes/source.ts";
import { toRelationship } from "../src/twin.ts";
import { buildScene, layoutRules } from "../web/src/scene.ts";
import { layoutTwin } from "../web/src/TwinLayout.ts";

const node = (name: string, ip: string, tunnel: string) => ({
  metadata: { name, annotations: { "projectcalico.org/IPv4Address": `${ip}/24`, "projectcalico.org/IPv4VXLANTunnelAddr": tunnel } },
  status: { addresses: [{ type: "InternalIP", address: ip }] },
});
const pod = (name: string, ns: string, nodeName: string, ip: string, hostNetwork = false) => ({
  metadata: { name, namespace: ns },
  spec: { nodeName, hostNetwork },
  status: { phase: "Running", podIP: ip, containerStatuses: [{ name: "app", ready: true, restartCount: 0, image: "x" }] },
});
const input: ClusterInput = {
  clusterName: "c",
  namespaces: [{ metadata: { name: "web" } }, { metadata: { name: "ingress" } }],
  nodes: [node("n1", "192.168.0.241", "10.1.0.1"), node("n2", "192.168.0.242", "10.1.0.2")],
  pods: [pod("site-1", "web", "n1", "10.1.0.10"), pod("traefik-1", "ingress", "n2", "10.1.0.20"), pod("agent-1", "web", "n2", "192.168.0.242", true)],
  replicasets: [],
  version: null,
  services: [
    { metadata: { name: "site", namespace: "web" }, spec: { type: "ClusterIP", clusterIP: "10.152.0.5", ports: [{ port: 80, targetPort: 8080 }], selector: { app: "site" } } },
    { metadata: { name: "empty", namespace: "web" }, spec: { type: "ClusterIP", ports: [{ port: 80 }], selector: { app: "none" } } },
    { metadata: { name: "traefik", namespace: "ingress" }, spec: { type: "LoadBalancer", ports: [{ port: 443 }], selector: { app: "traefik" } }, status: { loadBalancer: { ingress: [{ ip: "192.168.0.50" }] } } },
  ],
  endpointSlices: [
    { metadata: { name: "site-x", namespace: "web", labels: { "kubernetes.io/service-name": "site" } }, endpoints: [{ addresses: ["10.1.0.10"], conditions: { ready: true }, targetRef: { kind: "Pod", name: "site-1" } }] },
    { metadata: { name: "traefik-x", namespace: "ingress", labels: { "kubernetes.io/service-name": "traefik" } }, endpoints: [{ conditions: { ready: true }, targetRef: { kind: "Pod", name: "traefik-1" } }] },
  ],
  ingresses: [{ metadata: { name: "site", namespace: "web" }, spec: { tls: [{ hosts: ["k6labs.cz"] }], rules: [{ host: "k6labs.cz", http: { paths: [{ path: "/", backend: { service: { name: "site", port: { number: 80 } } } }] } }] } }],
  ingressRoutes: [{ metadata: { name: "old", namespace: "web" }, spec: { routes: [{ match: "Host(`old.k6labs.cz`) && PathPrefix(`/api`)", services: [{ name: "gone", port: 80 }] }] } }],
  publicAddresses: { "k6labs.cz": ["94.230.151.215"], "old.k6labs.cz": ["94.230.151.215"], "cdn.k6labs.cz": ["104.21.60.211", "172.67.201.129"] },
};
const g = clusterGraph(input);
const twin = (model: string, name: string) => g.twins.find((t) => t.$metadata.$model === model && t.name === name)!;
const has = (name: string, from: string, to: string) => expect(g.relationships).toContainEqual({ name, source: from, target: to });

describe("the cluster's network", () => {
  it("gives each node its card, router and tunnel, each pod its eth0 to its node's router", () => {
    const nic = "k8s:c/node/n1/if/nic";
    expect(twin(MODEL.Interface, "192.168.0.241")).toMatchObject({ $dtId: nic, kind: "physical", ip: "192.168.0.241", cidr: "192.168.0.241/24" });
    has("contains", "k8s:c/node/n1", "k8s:c/node/n1/if/router");
    has("connectedTo", "k8s:c/node/n1/if/router", nic);
    has("connectedTo", "k8s:c/node/n1/if/vxlan", "k8s:c/node/n2/if/vxlan");
    has("contains", "k8s:c/namespace/web/pod/site-1", "k8s:c/namespace/web/pod/site-1/if/eth0");
    has("connectedTo", "k8s:c/namespace/web/pod/site-1/if/eth0", "k8s:c/node/n1/if/router");
    // A host-network pod is on the node's card.
    has("connectedTo", "k8s:c/namespace/web/pod/agent-1/if/eth0", "k8s:c/node/n2/if/nic");
  });

  it("routes Services to their ready pods, a LoadBalancer address to its Service through the nodes' cards", () => {
    const site = twin(MODEL.Service, "site");
    expect(site).toMatchObject({ status: "ok", clusterIP: "10.152.0.5", ports: "80/TCP→8080", readyEndpoints: 1 });
    has("routesTo", site.$dtId, "k8s:c/namespace/web/pod/site-1");
    expect(twin(MODEL.Service, "empty").status).toBe("warn");
    const lb = twin(MODEL.Interface, "192.168.0.50");
    expect(lb).toMatchObject({ kind: "loadbalancer" });
    has("exposes", lb.$dtId, twin(MODEL.Service, "traefik").$dtId);
    has("connectedTo", lb.$dtId, "k8s:c/node/n2/if/nic");
  });

  it("routes all Ingresses and IngressRoutes through the one ingress controller twin to Services, served by its address", () => {
    // No object per ingress resource: one twin (named after the controller) with every host and route.
    const controller = twin(MODEL.Ingress, "traefik");
    expect(controller).toMatchObject({
      kind: "Ingress",
      hosts: "k6labs.cz, old.k6labs.cz",
      routes: "k6labs.cz/ → site:80\nold.k6labs.cz/api → gone:80",
      tls: true,
      // A route to a Service that isn't there is an error.
      status: "error",
    });
    expect(g.twins.filter((t) => t.$metadata.$model === MODEL.Ingress)).toHaveLength(1);
    has("routesTo", controller.$dtId, twin(MODEL.Service, "site").$dtId);
    has("servedBy", controller.$dtId, twin(MODEL.Interface, "192.168.0.50").$dtId);
    has("hasIngress", "k8s:c/namespace/web", controller.$dtId);
    const pub = twin(MODEL.Interface, "94.230.151.215");
    expect(pub).toMatchObject({ kind: "public", ports: "k6labs.cz, old.k6labs.cz" });
    has("connectedTo", pub.$dtId, twin(MODEL.Interface, "192.168.0.50").$dtId);
    // A host behind Cloudflare: its addresses are the CDN's, in front of the cluster's own.
    const cdn = twin(MODEL.Interface, "Cloudflare");
    expect(cdn).toMatchObject({ kind: "public", ip: "104.21.60.211, 172.67.201.129", cidr: "CDN proxy", ports: "cdn.k6labs.cz" });
    has("connectedTo", cdn.$dtId, pub.$dtId);
    expect(g.twins.some((t) => t.name === "104.21.60.211")).toBe(false);
  });

  it("is valid against the models", () => {
    const models = new Map(dtdlModel().map((m): [string, DtdlInterface] => [m["@id"], m]));
    const twins = new Map(g.twins.map((t) => [t.$dtId, t as DigitalTwin]));
    for (const t of twins.values()) expect(twinErrors(t, models), t.$dtId).toEqual([]);
    for (const r of g.relationships.map(toRelationship)) expect(relationshipErrors(r, twins, models)).toEqual([]);
  });

  it("keeps only public addresses of the hosts", async () => {
    expect(await publicAddressesOf(["localhost", "*.wild", "bad name"])).toEqual({});
  });
});

describe("the firewall, the external services and further LAN devices", () => {
  const lanInput: ClusterInput = {
    ...input,
    lan: { switchModel: "TL-SG108", routerModel: "Archer C6", devices: [{ kind: "ap", name: "Office AP", model: "EAP225" }] },
    externalServices: [
      { url: "https://api.mistral.ai/v1/models", name: "api.mistral.ai", status: "ok" },
      { url: "https://down.example.com", name: "down.example.com", status: "error" },
    ],
  };
  const g = clusterGraph(lanInput);
  const twin = (model: string, name: string) => g.twins.find((t) => t.$metadata.$model === model && t.name === name)!;
  const has = (name: string, from: string, to: string) => expect(g.relationships).toContainEqual({ name, source: from, target: to });

  it("puts the ingress controller, Services, LoadBalancer addresses and the network components in one firewall box, its status their worst", () => {
    const fw = twin(MODEL.Firewall, "firewall");
    expect(fw.status).toBe("error"); // the old IngressRoute routes to a missing Service
    has("contains", "k8s:c", fw.$dtId);
    has("contains", fw.$dtId, twin(MODEL.Ingress, "traefik").$dtId);
    has("contains", fw.$dtId, twin(MODEL.Service, "site").$dtId);
    has("contains", fw.$dtId, twin(MODEL.Interface, "192.168.0.50").$dtId);
    // The network's components, with what they work through.
    has("contains", fw.$dtId, "k8s:c/component/calico");
    has("contains", fw.$dtId, "k8s:c/component/metallb");
    has("connectedTo", "k8s:c/component/calico", "k8s:c/node/n1/if/router");
    has("connectedTo", "k8s:c/component/metallb", twin(MODEL.Interface, "192.168.0.50").$dtId);
    // The namespaces still have their services and ingresses; none of them is loose in the cluster anymore.
    has("hasService", "k8s:c/namespace/web", twin(MODEL.Service, "site").$dtId);
    has("hasIngress", "k8s:c/namespace/web", twin(MODEL.Ingress, "traefik").$dtId);
    for (const t of [twin(MODEL.Ingress, "traefik"), twin(MODEL.Service, "site"), twin(MODEL.Interface, "192.168.0.50")])
      expect(g.relationships.some((r) => r.name === "contains" && r.source === "k8s:c" && r.target === t.$dtId)).toBe(false);
  });

  it("adds the external services as interfaces of kind external, behind the router's WAN port", () => {
    const mistral = twin(MODEL.Interface, "api.mistral.ai");
    expect(mistral).toMatchObject({ kind: "external", status: "ok", url: "https://api.mistral.ai/v1/models", ip: "api.mistral.ai" });
    expect(twin(MODEL.Interface, "down.example.com").status).toBe("error");
    has("contains", "k8s:c", mistral.$dtId);
    has("connectedTo", lanIds("k8s:c").routerWan, mistral.$dtId);
  });

  it("cables a further LAN device (an access point) to a free switch port and gives it a Wi-Fi port", () => {
    const ap = twin(MODEL.AccessPoint, "Office AP");
    expect(ap).toMatchObject({ model: "EAP225", ssid: "Office AP" });
    has("contains", "k8s:c", ap.$dtId);
    const up = lanIds("k8s:c").uplink(ap.$dtId);
    has("contains", ap.$dtId, up);
    has("connectedTo", up, lanIds("k8s:c").switchPort(3)); // 2 nodes + the switch's own uplink
    expect(twin(MODEL.Interface, "Office AP")).toMatchObject({ kind: "wifi" });
    expect(twin(MODEL.Switch, "switch").portCount).toBe(4);
  });

  it("lays the firewall out as one box on top of the stack with the ingresses inside, the external services on the internet's globe, the WAN's line a cable", () => {
    const models = dtdlModel().map((m) => ({ id: m["@id"], model: m, uploadTime: "", decommissioned: false }));
    const scene = buildScene(models, g.twins.map((t) => ({ ...t, $etag: "", $metadata: { $model: t.$metadata.$model } })), g.relationships.map(toRelationship), {}, {}, {}, null);
    const layout = layoutTwin(scene.top, layoutRules(scene));
    const box = (id: string) => layout.boxes.find((b) => b.id === id)!;
    const min = (b: (typeof layout.boxes)[number], i: number) => b.center[i]! - b.size[i]! / 2;
    const max = (b: (typeof layout.boxes)[number], i: number) => b.center[i]! + b.size[i]! / 2;
    const inside = (inner: (typeof layout.boxes)[number], outer: (typeof layout.boxes)[number]) =>
      [0, 1, 2].every((i) => min(inner, i) >= min(outer, i) - 1e-6 && max(inner, i) <= max(outer, i) + 1e-6);
    // The firewall is a box as big as a machine, on top of the stack, with the whole virtual network inside it.
    const fwId = twin(MODEL.Firewall, "firewall").$dtId;
    const fw = box(fwId);
    const topNode = max(box("k8s:c/node/n1"), 1);
    expect(min(fw, 1)).toBeGreaterThanOrEqual(topNode - 1e-6);
    expect(fw.size).toEqual(box("k8s:c/node/n1").size);
    expect(inside(box(twin(MODEL.Ingress, "traefik").$dtId), fw)).toBe(true);
    expect(inside(box(twin(MODEL.Service, "site").$dtId), fw)).toBe(true);
    expect(inside(box("k8s:c/component/calico"), fw)).toBe(true);
    expect(inside(box("k8s:c/component/metallb"), fw)).toBe(true);
    expect(scene.byId.get(fwId)!.look).toBe("firewall");
    // A Service's routing to its pod is a thin line ending on the inner side of the pod's eth0.
    const routed = layout.links.find((l) => l.kind === "virtual" && l.id === twin(MODEL.Service, "site").$dtId)!;
    const eth0 = box("k8s:c/namespace/web/pod/site-1/if/eth0");
    expect(routed.path.at(-1)).toEqual(eth0.center);
    expect(routed.path.at(-2)![2]).toBeGreaterThan(eth0.center[2]);
    // The external services sit on the globe behind the cluster, reached by an internet line.
    const cluster = box("k8s:c");
    const mistral = box(twin(MODEL.Interface, "api.mistral.ai").$dtId);
    expect(min(mistral, 2)).toBeLessThan(min(cluster, 2));
    expect(layout.links.some((l) => l.kind === "internet" && l.to === mistral.id)).toBe(true);
    // The WAN port's line to the internet is an Ethernet cable (a tube with a radius).
    const wan = layout.links.find((l) => l.kind === "internet" && l.layer === "network")!;
    expect(wan.path[0]).toEqual(box(lanIds("k8s:c").routerWan).center);
    expect(wan.radius).toBeGreaterThan(0);
    // The access point stands behind the stack with the switch, its uplink cabled to the switch.
    const ap = box(twin(MODEL.AccessPoint, "Office AP").$dtId);
    expect(max(ap, 2)).toBeLessThan(min(box("k8s:c/node/n2"), 2));
    const cable = layout.links.find((l) => l.kind === "ethernet" && l.to === lanIds("k8s:c").switchPort(3))!;
    expect(cable.path[0]).toEqual(box(lanIds("k8s:c").uplink(ap.id)).center);
    // Every twin and relationship is valid against the models.
    const byModel = new Map(dtdlModel().map((m): [string, DtdlInterface] => [m["@id"], m]));
    for (const t of g.twins) expect(twinErrors(t as DigitalTwin, byModel), t.$dtId).toEqual([]);
    const byId = new Map(g.twins.map((t) => [t.$dtId, t as DigitalTwin]));
    for (const r of g.relationships) expect(relationshipErrors(toRelationship(r), byId, byModel), JSON.stringify(r)).toEqual([]);
  });

  it("probes an external service: any HTTP answer is up, a 5xx a warning, no answer an error", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("mistral")) return new Response("{}", { status: 401 });
      if (url.includes("busy")) return new Response("", { status: 503 });
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(await probeService("https://api.mistral.ai/v1/models", fetchFn)).toEqual({ url: "https://api.mistral.ai/v1/models", name: "api.mistral.ai", status: "ok" });
    expect((await probeService("https://busy.example.com", fetchFn)).status).toBe("warn");
    expect((await probeService("https://down.example.com", fetchFn)).status).toBe("error");
  });
});
