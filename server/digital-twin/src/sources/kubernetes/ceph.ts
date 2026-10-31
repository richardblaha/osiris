/**
 * A Ceph cluster as its active manager's Prometheus module tells it (`http://<host>:9283/metrics`, the mgr module
 * `prometheus`): health, the OSDs with their host, device and fill, the pools. The standby managers answer an empty
 * page, so the first URL with metrics is the active one.
 */
export interface CephOsd {
  id: number;
  host: string;
  address: string;
  deviceClass: string;
  /** The data device (`/dev/sdb`), its model and serial, and the device holding its DB. */
  device: string;
  model: string;
  dbDevice: string;
  up: boolean;
  in: boolean;
  size: number;
  used: number;
}
export interface CephPool {
  id: number;
  name: string;
  stored: number;
  maxAvailable: number;
}
export interface CephState {
  fsid: string;
  /** The health checks that are raised (`OSD_DOWN`, `PG_DEGRADED`…), with their severity. */
  checks: { name: string; severity: string }[];
  /** The monitors, and how many of them are in quorum. */
  monitors: number;
  quorum: number;
  /** Placement groups: all of them, the active+clean ones, and the degraded ones. */
  pgs: { total: number; clean: number; degraded: number };
  /** Bytes read and written by clients, all pools together since the daemons started (counters). */
  readBytes: number;
  writeBytes: number;
  /** 0 ok, 1 warning, 2 error (HEALTH_OK, HEALTH_WARN, HEALTH_ERR). */
  health: number;
  version: string;
  size: number;
  used: number;
  osds: CephOsd[];
  pools: CephPool[];
}

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Prometheus' text format: one sample per line, `name{label="value",…} value`; comments and the rest skipped. */
export function parsePrometheus(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[2] ?? "").matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]!] = l[2]!.replace(/\\(.)/g, "$1");
    const value = Number(m[3]);
    if (Number.isFinite(value)) out.push({ name: m[1]!, labels, value });
  }
  return out;
}

/** The Ceph state in a manager's metrics; undefined when the page has none (a standby manager). */
export function cephState(samples: Sample[]): CephState | undefined {
  const all = (name: string) => samples.filter((s) => s.name === name);
  const one = (name: string) => all(name)[0]?.value;
  const byOsd = (name: string) => new Map(all(name).map((s) => [s.labels.ceph_daemon ?? "", s.value]));
  const health = one("ceph_health_status");
  if (health === undefined) return undefined;
  const up = byOsd("ceph_osd_up");
  const inside = byOsd("ceph_osd_in");
  const size = byOsd("ceph_osd_stat_bytes");
  const used = byOsd("ceph_osd_stat_bytes_used");
  const disks = new Map(all("ceph_disk_occupation").map((s) => [s.labels.ceph_daemon ?? "", s.labels]));
  const osds = all("ceph_osd_metadata")
    .map((s): CephOsd => {
      const daemon = s.labels.ceph_daemon ?? "";
      const disk = disks.get(daemon) ?? {};
      const device = (disk.device ?? "").replace(/^\/dev\//, "");
      // device_ids: "nvme0n1=MODEL_SERIAL,sdb=MODEL_SERIAL"; the data device's.
      const model = (disk.device_ids ?? "").split(",").find((d) => d.startsWith(`${device}=`))?.split("=")[1] ?? "";
      return {
        id: Number(daemon.replace(/^osd\./, "")),
        host: s.labels.hostname ?? "",
        address: s.labels.public_addr ?? "",
        deviceClass: s.labels.device_class ?? "",
        device: disk.device ?? "",
        model: model.replace(/_/g, " "),
        dbDevice: disk.db_device ?? "",
        up: up.get(daemon) === 1,
        in: inside.get(daemon) === 1,
        size: size.get(daemon) ?? 0,
        used: used.get(daemon) ?? 0,
      };
    })
    .sort((a, b) => a.id - b.id);
  const stored = new Map(all("ceph_pool_stored").map((s) => [s.labels.pool_id ?? "", s.value]));
  const avail = new Map(all("ceph_pool_max_avail").map((s) => [s.labels.pool_id ?? "", s.value]));
  const pools = all("ceph_pool_metadata")
    .map((s): CephPool => ({ id: Number(s.labels.pool_id), name: s.labels.name ?? "", stored: stored.get(s.labels.pool_id ?? "") ?? 0, maxAvailable: avail.get(s.labels.pool_id ?? "") ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const meta = all("ceph_mon_metadata")[0]?.labels ?? all("ceph_osd_metadata")[0]?.labels ?? {};
  const sum = (name: string) => all(name).reduce((n, s) => n + s.value, 0);
  // A PG is clean when active and clean: the mgr counts each state per pool, so the clean count is the lesser.
  const pgTotal = sum("ceph_pg_total");
  return {
    fsid: all("ceph_health_status")[0]?.labels.fsid ?? "",
    checks: all("ceph_health_detail")
      .filter((s) => s.value > 0 && s.labels.name)
      .map((s) => ({ name: s.labels.name!, severity: (s.labels.severity ?? "").replace(/^HEALTH_/, "").toLowerCase() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    monitors: all("ceph_mon_metadata").length,
    quorum: all("ceph_mon_quorum_status").filter((s) => s.value === 1).length,
    pgs: { total: pgTotal, clean: Math.min(sum("ceph_pg_active"), sum("ceph_pg_clean"), pgTotal || Infinity), degraded: sum("ceph_pg_degraded") },
    readBytes: sum("ceph_pool_rd_bytes"),
    writeBytes: sum("ceph_pool_wr_bytes"),
    health,
    version: (meta.ceph_version ?? "").replace(/^ceph version (\S+).*$/, "$1"),
    size: one("ceph_cluster_total_bytes") ?? 0,
    used: one("ceph_cluster_total_used_bytes") ?? 0,
    osds,
    pools,
  };
}

/** Asks each manager in turn; the active one's state, or undefined when none answers with metrics. */
export async function readCeph(urls: string[], fetchFn: typeof fetch = fetch): Promise<CephState | undefined> {
  for (const url of urls) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const state = cephState(parsePrometheus(await res.text()));
      if (state) return state;
    } catch {
      // A manager that is down: the next one.
    }
  }
  return undefined;
}
