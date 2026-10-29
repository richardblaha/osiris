import { describe, expect, it } from "vitest";
import { cephState, parsePrometheus, readCeph } from "../src/sources/kubernetes/ceph.ts";
import { clusterGraph } from "../src/sources/kubernetes/graph.ts";
import { dtdlModel, MODEL } from "../src/sources/kubernetes/models.ts";
import { toRelationship } from "../src/twin.ts";
import { interfaceErrors, relationshipErrors, twinErrors, type DigitalTwin, type DtdlInterface } from "@osiris/shared/dtdl.ts";

/** A cut of a Squid manager's Prometheus page. */
const METRICS = `# HELP ceph_health_status Cluster health status
# TYPE ceph_health_status untyped
ceph_health_status 1.0
ceph_cluster_total_bytes 2855314841600.0
ceph_cluster_total_used_bytes 231001784320.0
ceph_mon_metadata{ceph_daemon="mon.n1",hostname="n1",public_addr="192.168.0.231",rank="0",ceph_version="ceph version 19.2.3 (c92aebb) squid (stable)"} 1.0
ceph_osd_metadata{back_iface="",ceph_daemon="osd.7",cluster_addr="192.168.0.242",device_class="hdd",front_iface="",hostname="n2",objectstore="bluestore",public_addr="192.168.0.242",ceph_version="ceph version 19.2.3"} 1.0
ceph_osd_metadata{back_iface="",ceph_daemon="osd.9",cluster_addr="10.0.0.9",device_class="ssd",front_iface="",hostname="elsewhere",objectstore="bluestore",public_addr="10.0.0.9",ceph_version="ceph version 19.2.3"} 1.0
ceph_disk_occupation{ceph_daemon="osd.7",device="/dev/sdb",db_device="/dev/dm-1",wal_device="",instance="n2",devices="nvme0n1,sdb",device_ids="nvme0n1=SAMSUNG_X,sdb=ST500LM0_00-1EJ162_18A2"} 1.0
ceph_osd_up{ceph_daemon="osd.7"} 1.0
ceph_osd_in{ceph_daemon="osd.7"} 1.0
ceph_osd_up{ceph_daemon="osd.9"} 0.0
ceph_osd_in{ceph_daemon="osd.9"} 1.0
ceph_pool_metadata{pool_id="2",name="microk8s-rbd0",type="replicated",description="replica:3",compression_mode="none"} 1.0
ceph_pool_stored{pool_id="2"} 4600000000.0
ceph_pool_max_avail{pool_id="2"} 979000000000.0
`;

describe("Ceph from its manager's metrics", () => {
  const state = cephState(parsePrometheus(METRICS))!;

  it("reads health, capacity, the OSDs with their disks and the pools", () => {
    expect(state).toMatchObject({ health: 1, version: "19.2.3", size: 2855314841600, used: 231001784320 });
    expect(state.osds[0]).toMatchObject({ id: 7, host: "n2", device: "/dev/sdb", model: "ST500LM0 00-1EJ162 18A2", dbDevice: "/dev/dm-1", deviceClass: "hdd", up: true, in: true });
    expect(state.osds[1]).toMatchObject({ id: 9, up: false });
    expect(state.pools).toEqual([{ id: 2, name: "microk8s-rbd0", stored: 4600000000, maxAvailable: 979000000000 }]);
  });

  it("asks the managers in turn: a standby's empty page is skipped", async () => {
    const pages: Record<string, string> = { "http://a/metrics": "", "http://b/metrics": METRICS };
    const fetchFn = (async (url: string) => new Response(pages[url] ?? "", { status: pages[url] === undefined ? 404 : 200 })) as unknown as typeof fetch;
    expect((await readCeph(["http://x/metrics", "http://a/metrics", "http://b/metrics"], fetchFn))?.osds).toHaveLength(2);
    expect(await readCeph(["http://a/metrics"], fetchFn)).toBeUndefined();
  });

  it("puts Ceph in the cluster, its pools in it and each disk in its node; a pool holds the claims on it", () => {
    const g = clusterGraph({
      clusterName: "c",
      namespaces: [{ metadata: { name: "db" } }],
      nodes: [{ metadata: { name: "n2" }, status: { addresses: [{ type: "InternalIP", address: "192.168.0.242" }] } }],
      pods: [],
      pvcs: [{ metadata: { name: "data", namespace: "db" }, spec: { volumeName: "pv-1" }, status: { phase: "Bound" } }],
      pvs: [{ metadata: { name: "pv-1" }, spec: { csi: { driver: "rbd", volumeAttributes: { pool: "microk8s-rbd0" } } } }],
      replicasets: [],
      version: null,
      ceph: state,
    });
    const id = (model: string, name: string) => g.twins.find((t) => t.$metadata.$model === model && t.name === name)!.$dtId;
    const has = (name: string, from: string, to: string) => expect(g.relationships).toContainEqual({ name, source: from, target: to });
    has("contains", "k8s:c", id(MODEL.Ceph, "Ceph"));
    has("contains", "k8s:c/node/n2", id(MODEL.CephOsd, "osd.7"));
    // A disk of a host the cluster doesn't know stays in Ceph.
    has("contains", id(MODEL.Ceph, "Ceph"), id(MODEL.CephOsd, "osd.9"));
    has("contains", id(MODEL.Ceph, "Ceph"), id(MODEL.CephPool, "microk8s-rbd0"));
    has("holds", id(MODEL.CephPool, "microk8s-rbd0"), id(MODEL.PersistentVolumeClaim, "data"));
    expect(g.twins.find((t) => t.name === "osd.9")).toMatchObject({ status: "error", up: false });
    expect(g.twins.find((t) => t.name === "Ceph")).toMatchObject({ status: "warn", osdCount: 2 });
    expect(g.twins.find((t) => t.name === "n2")).toMatchObject({ ip: "192.168.0.242" });
    // Every twin and relationship is valid against the models.
    const models = new Map(dtdlModel().map((m): [string, DtdlInterface] => [m["@id"], m]));
    for (const m of dtdlModel()) expect(interfaceErrors(m)).toEqual([]);
    const twins = new Map(g.twins.map((t) => [t.$dtId, t as DigitalTwin]));
    for (const t of twins.values()) expect(twinErrors(t, models)).toEqual([]);
    for (const r of g.relationships.map(toRelationship)) expect(relationshipErrors(r, twins, models)).toEqual([]);
  });
});
