import type { TwinStatus } from "@osiris/shared";
import { t } from "i18next";
import { formatBytes, formatBytesRate, formatNumber } from "../i18n.ts";
import { kindOf } from "../icons.ts";
import { fillOf, storageOf, type TwinView } from "../scene.ts";

/** How full a storage twin is, in words: bytes of its size where they're known, else the share (an estimate). */
export function storageText(node: TwinView, full = fillOf(node)): string {
  const bytes = storageOf(node);
  if (bytes && full !== undefined) return t("twin:storageUse", { used: formatBytes(bytes.used), size: formatBytes(bytes.size), share: formatNumber(full, { style: "percent" }) });
  return full !== undefined ? t("twin:fillEstimate", { share: formatNumber(full, { style: "percent" }) }) : "";
}

export const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** What a storage cluster (Ceph) needs watching for, in short: disks up, placement groups clean, monitors in quorum,
 * client I/O and the raised health checks. */
function cephInfo(node: TwinView): string[] {
  const x = node.twin;
  const out: string[] = [];
  if (num(x.osdCount) !== undefined) out.push(t("twin:ceph.osds", { up: num(x.osdUp) ?? 0, total: num(x.osdCount) }));
  if (num(x.pgTotal)) out.push(t("twin:ceph.pgs", { clean: num(x.pgClean) ?? 0, total: num(x.pgTotal) }));
  if (num(x.monitors)) out.push(t("twin:ceph.mons", { quorum: num(x.quorum) ?? 0, total: num(x.monitors) }));
  if (num(x.readRate) !== undefined || num(x.writeRate) !== undefined) out.push(t("twin:ceph.io", { read: formatBytesRate(num(x.readRate) ?? 0), write: formatBytesRate(num(x.writeRate) ?? 0) }));
  if (typeof x.checks === "string" && x.checks) out.push(x.checks);
  return out;
}

/** A load's colour band: well up to 80 %, a warning to 95 %, then an error. */
export const loadLevel = (load: number | undefined): TwinStatus => (load === undefined ? "ok" : load >= 0.95 ? "error" : load >= 0.8 ? "warn" : "ok");

/** What a piece of hardware or a workload reads, in short: a CPU's cores busy, a load, bytes of a size, a disk's bus,
 * model and I/O, a container's CPU and memory; a Service's endpoints. */
function resourceInfo(node: TwinView): string[] {
  const r = node.resources ?? {};
  const out: string[] = [];
  const percent = (v: number) => formatNumber(v, { style: "percent" });
  if (node.look === "drive") {
    const bus = String(node.twin.bus ?? "unknown");
    out.push([t(`twin:hw.bus.${bus}`, { defaultValue: bus }), typeof node.twin.model === "string" ? node.twin.model : ""].filter(Boolean).join(" "));
  }
  if (node.look === "cpu" && r.used !== undefined && r.size) out.push(t("twin:hw.cpu", { used: formatNumber(r.used, { maximumFractionDigits: 2 }), cores: r.size }));
  if (r.load !== undefined) out.push(r.estimated ? t("twin:hw.estimated", { share: percent(r.load) }) : percent(r.load));
  if ((node.look === "memory" || node.look === "drive") && r.used !== undefined && r.size) out.push(t("twin:hw.bytes", { used: formatBytes(r.used), size: formatBytes(r.size) }));
  if (node.look === "drive" && r.used === undefined && num(node.twin.size)) out.push(formatBytes(num(node.twin.size)!));
  if (r.io !== undefined) out.push(t("twin:hw.io", { rate: formatBytesRate(r.io) }));
  if (r.cpu !== undefined) out.push(t("twin:hw.cores", { value: formatNumber(r.cpu, { maximumFractionDigits: r.cpu < 0.1 ? 3 : 2 }) }));
  if (r.memory !== undefined) out.push(formatBytes(r.memory));
  if (node.look === "hex" && num(node.twin.readyEndpoints) !== undefined) out.push(t("twin:hw.endpoints", { count: num(node.twin.readyEndpoints) }));
  return out;
}

/** A twin's basic state in one line: its status, traffic, how full it is, its recent errors; a storage cluster's
 * health in short, an Ingress's hosts, the hardware's readings. */
export function infoOf(node: TwinView): string {
  const full = fillOf(node);
  const hosts = node.look === "gate" && typeof node.twin.hosts === "string" ? node.twin.hosts.split(", ").filter(Boolean) : [];
  return [
    t(`twin:status.${node.status}`),
    node.network !== undefined ? formatBytesRate(node.network) : "",
    storageText(node, full),
    ...(node.look === "ceph" ? cephInfo(node) : []),
    ...resourceInfo(node),
    hosts.length ? (hosts.length > 2 ? `${hosts.slice(0, 2).join(", ")} +${hosts.length - 2}` : hosts.join(", ")) : "",
    node.twin.tls === true ? "TLS" : "",
    node.errors ? t("twin:errorCount", { count: node.errors }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** How much a label shows by its solid's size on screen (px): nothing, the icon, with the name, with the kind and state. */
export const LOD = { icon: 26, name: 70, info: 150 } as const;


/** A twin's kind and state in one line, for its label and the hover tip. */
export const kindAndInfo = (node: TwinView) => `${kindOf(node)} · ${infoOf(node)}`;
