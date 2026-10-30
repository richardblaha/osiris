import { describe, expect, it } from "vitest";
import { relationshipErrors, twinErrors, type DigitalTwin, type DtdlInterface } from "@osiris/shared/dtdl.ts";
import { clusterGraph, type ClusterInput } from "../src/sources/kubernetes/graph.ts";
import { dtdlModel, MODEL } from "../src/sources/kubernetes/models.ts";
import { publicAddressesOf } from "../src/sources/kubernetes/source.ts";
import { toRelationship } from "../src/twin.ts";

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

  it("routes Ingresses and IngressRoutes to Services, served by the controller's address, reached from the public one", () => {
    const site = twin(MODEL.Ingress, "site");
    expect(site).toMatchObject({ kind: "Ingress", hosts: "k6labs.cz", routes: "k6labs.cz/ → site:80", tls: true, status: "ok" });
    has("routesTo", site.$dtId, twin(MODEL.Service, "site").$dtId);
    has("servedBy", site.$dtId, twin(MODEL.Interface, "192.168.0.50").$dtId);
    // A route to a Service that isn't there.
    expect(twin(MODEL.Ingress, "old")).toMatchObject({ kind: "IngressRoute", hosts: "old.k6labs.cz", routes: "old.k6labs.cz/api → gone:80", status: "error" });
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
