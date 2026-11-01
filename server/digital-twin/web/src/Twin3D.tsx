import type { TwinStatus } from "@osiris/shared";
import { t } from "i18next";
import { useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { formatBytes, formatBytesRate, formatNumber } from "./i18n.ts";
import { iconOf, kindOf, portKind } from "./icons.ts";
import { fillOf, INFRA_LAYERS, isWorkloadLayer, layoutRules, pathOf, storageOf, WORKLOAD_LAYERS, type TwinScene, type TwinView, type ViewLayer } from "./scene.ts";
import { layoutTwin, type Box, type Link, type LinkLayer, type Scene } from "./TwinLayout.ts";

/**
 * What the view shows besides the base (cluster, nodes, pods, containers): the hardware (CPUs with their cores,
 * memory, disks, LAN and USB ports, what runs on them), the low-level network (interfaces, bridges, routers, tunnels
 * and their wiring), the network services (load balancers, Services, Ingresses, public addresses, their routing),
 * storage (volume claims, Ceph with its pools and disks), the namespaces (bands) and the workloads.
 */
export type Layers = Record<ViewLayer, boolean>;
/** The layers in the menu's order: the infrastructure's (keys 1–5 show one alone), then each kind of workload (key 6
 * shows them all, alone). */
export const LAYER_KEYS = [...INFRA_LAYERS, ...WORKLOAD_LAYERS] as const satisfies readonly ViewLayer[];
export const ALL_LAYERS = Object.fromEntries(LAYER_KEYS.map((k) => [k, true])) as Layers;
/** Only these layers on. */
const onlyLayers = (on: (k: ViewLayer) => boolean) => Object.fromEntries(LAYER_KEYS.map((k) => [k, on(k)])) as Layers;

/** How the view draws: labels by level of detail, every name, or none; the interfaces' addresses; moving traffic. */
export interface DisplayOptions {
  labels: "auto" | "all" | "off";
  addresses: boolean;
  traffic: boolean;
}
export const DEFAULT_DISPLAY: DisplayOptions = { labels: "auto", addresses: true, traffic: true };

/** Steering the camera around what it looks at: degrees about the vertical axis, degrees of tilt, a zoom factor,
 * and moving the look-at point in the camera's plane (`pan`) or straight up/down (`lift`), for the keyboard. */
export interface CameraControl {
  rotate(degrees: number): void;
  tilt(degrees: number): void;
  zoom(factor: number): void;
  pan(right: number, forward: number): void;
  lift(up: number): void;
}

/** A point on the view, in CSS pixels from its top left corner. */
export interface Point {
  x: number;
  y: number;
}

/** The theme's colours the scene wears, read from the page's CSS variables (light and dark scheme alike). */
function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => new THREE.Color(css.getPropertyValue(name).trim() || "#888888");
  // The accent for what is well, a stronger one (--accent-active) for what is selected or hovered, the theme's --state-error for errors.
  return { cyan: v("--accent-primary"), active: v("--accent-active"), neutral: v("--text-secondary"), warn: v("--state-warning"), error: v("--state-error") };
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);

/** How full a storage twin is, in words: bytes of its size where they're known, else the share (an estimate). */
export function storageText(node: TwinView, full = fillOf(node)): string {
  const bytes = storageOf(node);
  if (bytes && full !== undefined) return t("twin:storageUse", { used: formatBytes(bytes.used), size: formatBytes(bytes.size), share: formatNumber(full, { style: "percent" }) });
  return full !== undefined ? t("twin:fillEstimate", { share: formatNumber(full, { style: "percent" }) }) : "";
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

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
const loadLevel = (load: number | undefined): TwinStatus => (load === undefined ? "ok" : load >= 0.95 ? "error" : load >= 0.8 ? "warn" : "ok");

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
function infoOf(node: TwinView): string {
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
const LOD = { icon: 26, name: 70, info: 150 } as const;

/** One solid of the scene: its translucent body, its outline and, for storage, how full it is. */
interface BoxMesh {
  id: string;
  box: Box;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  edges: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial | THREE.LineDashedMaterial>;
  /**
   * Its content: a cylinder's (storage) a smaller cylinder from its floor up to how full it is with a ring at the
   * level; a core's, memory's or disk's a box as high (or, along `x`, as long) as its load, a frame at the level.
   */
  fill?: { body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; level: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>; axis: "x" | "y"; span: number; base: number };
  /** A node's status light: a strip along the bottom of its front. */
  led?: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  /**
   * A look's own parts: an Ingress's portal membrane and TLS lock, a storage cluster's lid gauge (its track and how
   * full it is) and health halo.
   */
  decor: {
    role:
      | "membrane" | "lock" | "track" | "gauge" | "halo" | "activity" | "rotor" | "spokes" | "sweep" | "die"
      | "socket" | "pins" | "tongue" | "linkLed" | "actLed" | "bezel" | "vents" | "button" | "antenna" | "deviceLed";
    object: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    /** How many spokes a rotor or a sweep turns between (a load balancer's nodes, a Service's endpoints). */
    steps?: number;
    /** How often a port's activity light blinks (per second; 0 dark), from the traffic through it. */
    rate?: number;
  }[];
  /** The fill the lid gauge was drawn for, so it is made again only when that changes. */
  gaugeAt?: number;
}

/**
 * A rounded box's outline: each of the 12 edges along the middle of its rounding, joined at every corner by three arcs
 * over the corner's sphere — the box's silhouette, without the facets of the rounding.
 */
function roundedEdges([w, h, d]: [number, number, number], r: number): THREE.BufferGeometry {
  const points: number[] = [];
  const k = Math.SQRT1_2 * r;
  const inner = [w / 2 - r, h / 2 - r, d / 2 - r];
  const corner = (sx: number, sy: number, sz: number) => new THREE.Vector3(sx * inner[0]!, sy * inner[1]!, sz * inner[2]!);
  const push = (a: THREE.Vector3, b: THREE.Vector3) => points.push(a.x, a.y, a.z, b.x, b.y, b.z);
  for (const sa of [-1, 1])
    for (const sb of [-1, 1]) {
      // Edges along x, y and z, each at the middle of its quarter-cylinder.
      push(new THREE.Vector3(-inner[0]!, sa * (inner[1]! + k), sb * (inner[2]! + k)), new THREE.Vector3(inner[0]!, sa * (inner[1]! + k), sb * (inner[2]! + k)));
      push(new THREE.Vector3(sa * (inner[0]! + k), -inner[1]!, sb * (inner[2]! + k)), new THREE.Vector3(sa * (inner[0]! + k), inner[1]!, sb * (inner[2]! + k)));
      push(new THREE.Vector3(sa * (inner[0]! + k), sb * (inner[1]! + k), -inner[2]!), new THREE.Vector3(sa * (inner[0]! + k), sb * (inner[1]! + k), inner[2]!));
    }
  // At each corner, arcs between the three edges' ends, over the sphere of radius r.
  const SEGMENTS = 6;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const c = corner(sx, sy, sz);
        const ends = [new THREE.Vector3(0, sy, sz), new THREE.Vector3(sx, 0, sz), new THREE.Vector3(sx, sy, 0)].map((v) => v.normalize());
        for (const [a, b] of [
          [0, 1],
          [1, 2],
          [2, 0],
        ] as const) {
          let prev = ends[a]!.clone().multiplyScalar(r).add(c);
          for (let i = 1; i <= SEGMENTS; i++) {
            const next = ends[a]!.clone().lerp(ends[b]!, i / SEGMENTS).normalize().multiplyScalar(r).add(c);
            push(prev, next);
            prev = next;
          }
        }
      }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** A cylinder's outline: its top and bottom rims and four lines down its mantle. */
function cylinderEdges(radius: number, height: number): THREE.BufferGeometry {
  const points: number[] = [];
  const N = 48;
  for (const y of [-height / 2, height / 2])
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const b = ((i + 1) / N) * Math.PI * 2;
      points.push(Math.cos(a) * radius, y, Math.sin(a) * radius, Math.cos(b) * radius, y, Math.sin(b) * radius);
    }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    points.push(Math.cos(a) * radius, -height / 2, Math.sin(a) * radius, Math.cos(a) * radius, height / 2, Math.sin(a) * radius);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** An Ingress's outline: a gate — two posts and a beam, seen from the front, with depth. */
function gateEdges([w, h, d]: [number, number, number]): THREE.BufferGeometry {
  const t = Math.min(w, h) * 0.16;
  const points: number[] = [];
  for (const z of [-d / 2, d / 2]) {
    // The outer frame (no bottom: traffic walks through) and the inner one.
    const outer = [[-w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2], [w / 2, -h / 2]];
    const inner = [[-w / 2 + t, -h / 2], [-w / 2 + t, h / 2 - t], [w / 2 - t, h / 2 - t], [w / 2 - t, -h / 2]];
    for (const line of [outer, inner]) for (let i = 0; i < line.length - 1; i++) points.push(line[i]![0]!, line[i]![1]!, z, line[i + 1]![0]!, line[i + 1]![1]!, z);
    points.push(-w / 2, -h / 2, z, -w / 2 + t, -h / 2, z, w / 2 - t, -h / 2, z, w / 2, -h / 2, z);
  }
  for (const [x, y] of [[-w / 2, h / 2], [w / 2, h / 2], [-w / 2, -h / 2], [w / 2, -h / 2]]) points.push(x!, y!, -d / 2, x!, y!, d / 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** A storage cluster's outline: a drum — its rims, two hoops around its middle and staves down its mantle. */
function drumEdges(radius: number, height: number): THREE.BufferGeometry {
  const points: number[] = [];
  const N = 64;
  const hoop = (y: number, r: number) => {
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const b = ((i + 1) / N) * Math.PI * 2;
      points.push(Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(b) * r, y, Math.sin(b) * r);
    }
  };
  hoop(-height / 2, radius);
  hoop(height / 2, radius);
  hoop(-height / 6, radius * 1.015);
  hoop(height / 6, radius * 1.015);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    points.push(Math.cos(a) * radius, -height / 2, Math.sin(a) * radius, Math.cos(a) * radius, height / 2, Math.sin(a) * radius);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** A flat arc on a lid: a ring from `inner` to `outer`, `share` of the way round from the front, lying in x/z. */
const gaugeGeometry = (inner: number, outer: number, share: number) =>
  new THREE.RingGeometry(inner, outer, 64, 1, Math.PI / 2, -Math.max(0.001, Math.min(1, share)) * Math.PI * 2).rotateX(-Math.PI / 2);

/** An Ingress's solid: a portal — two posts and a beam over the way through. */
function gateGeometry([w, h, d]: [number, number, number]): THREE.BufferGeometry {
  const t = Math.min(w, h) * 0.16;
  const post = (x: number) => new THREE.BoxGeometry(t, h - t, d).translate(x, -t / 2, 0);
  return mergeGeometries([post(-w / 2 + t / 2), post(w / 2 - t / 2), new THREE.BoxGeometry(w, t, d * 1.1).translate(0, h / 2 - t / 2, 0)])!;
}

/** A disk's outline: a cylinder with its platters (rings) inside. */
function diskEdges(radius: number, height: number): THREE.BufferGeometry {
  const base = cylinderEdges(radius, height).getAttribute("position").array as Float32Array;
  const points = [...base];
  const N = 40;
  for (const k of [0.25, 0.5, 0.75])
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const b = ((i + 1) / N) * Math.PI * 2;
      const y = -height / 2 + k * height;
      const r = radius * 0.92;
      points.push(Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(b) * r, y, Math.sin(b) * r);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** A soft, stable hue for a name (a namespace's tint). */
const hueOf = (name: string) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 360) / 360;
};

/** A ring of `radius` at height 0, for a storage's fill level. */
function ring(radius: number): THREE.BufferGeometry {
  const points: number[] = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    points.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** A rectangle of `a` by `b` around the origin, in the x/z plane (or, `upright`, the y/z plane), for a fill's level. */
function frame(a: number, b: number, upright = false): THREE.BufferGeometry {
  const corners = [[-a / 2, -b / 2], [a / 2, -b / 2], [a / 2, b / 2], [-a / 2, b / 2]];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(corners.flatMap(([u, v]) => (upright ? [0, u!, v!] : [u!, 0, v!])), 3));
  return g;
}

/** `n` spokes from the center of a disc of `radius` (lying in x/y, facing +z), one every 1/n of the way round. */
function spokes(n: number, inner: number, radius: number): THREE.BufferGeometry {
  const points: number[] = [];
  for (let i = 0; i < Math.max(1, n); i++) {
    const a = Math.PI / 2 - (i / Math.max(1, n)) * Math.PI * 2;
    points.push(Math.cos(a) * inner, Math.sin(a) * inner, 0, Math.cos(a) * radius, Math.sin(a) * radius, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** A network link as drawn: its path's lengths, for the packets that travel it. */
interface LinkPath extends Link {
  lengths: number[];
  total: number;
}

/** The dark of a socket's opening. */
const SOCKET = new THREE.Color("#07090c");

/** How a port faces: the turn about y that takes a part drawn facing +z to face `normal`. */
const facing = (normal: [number, number, number] | undefined) => {
  const [x, , z] = normal ?? [0, 0, -1];
  return Math.atan2(x, z);
};

/**
 * A cable as a solid tube along its path (cylinders, a ball at each corner) with a plug at each end: a box a little
 * thicker than the cable, along its first and its last segment.
 */
function cableGeometry(path: [number, number, number][], radius: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const along = (a: THREE.Vector3, b: THREE.Vector3) => new THREE.Quaternion().setFromUnitVectors(up, b.clone().sub(a).normalize());
  const points = path.map((p) => new THREE.Vector3(...p));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = a.distanceTo(b);
    if (length < 1e-6) continue;
    parts.push(new THREE.CylinderGeometry(radius, radius, length, 10, 1, true).applyQuaternion(along(a, b)).translate(...a.clone().add(b).multiplyScalar(0.5).toArray()));
  }
  for (const p of points.slice(1, -1)) parts.push(new THREE.SphereGeometry(radius, 10, 8).translate(p.x, p.y, p.z));
  const plug = (end: THREE.Vector3, next: THREE.Vector3) => {
    const length = Math.min(radius * 7, end.distanceTo(next));
    if (length < 1e-6) return;
    const dir = next.clone().sub(end).normalize();
    parts.push(new THREE.BoxGeometry(radius * 3, length, radius * 2.2).applyQuaternion(along(end, next)).translate(...end.clone().addScaledVector(dir, length / 2).toArray()));
  };
  if (points.length > 1) {
    plug(points[0]!, points[1]!);
    plug(points.at(-1)!, points.at(-2)!);
  }
  return mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
}

/** Slits in rows: a mini PC's vent grille, `w` by `h`, centered. */
function ventGeometry(w: number, h: number): THREE.BufferGeometry {
  const points: number[] = [];
  const rows = Math.max(2, Math.floor(h / 0.32));
  const slit = 0.42;
  const cols = Math.max(2, Math.floor(w / (slit + 0.2)));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = -w / 2 + c * (w / cols) + (r % 2 ? w / cols / 2 : 0);
      const y = -h / 2 + (r + 0.5) * (h / rows);
      if (x + slit > w / 2) continue;
      points.push(x, y, 0, x + slit, y, 0);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** An RJ45 socket's eight contacts: short lines along the top of its opening. */
function pinGeometry(w: number, y: number, length: number): THREE.BufferGeometry {
  const points: number[] = [];
  for (let i = 0; i < 8; i++) {
    const x = -w / 2 + ((i + 0.5) * w) / 8;
    points.push(x, y, 0, x, y - length, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** What the scene shows of one twin: boxes, network links and labels, and the layout's shape. */
interface Content {
  byId: Map<string, TwinView>;
  meshes: BoxMesh[];
  boxes: Map<string, Box>;
  links: LinkPath[];
  lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  /** The dashed ones: the tunnels between nodes and the routing (Ingress → Service → pods). */
  dashed: THREE.LineSegments<THREE.BufferGeometry, THREE.LineDashedMaterial>;
  /** Where each link's vertices are: in `lines` or in `dashed`, from which vertex. */
  vertexAt: { dashed: boolean; from: number }[];
  /** Decorations without a twin of their own (the cluster's floor grid): removed with the scene. */
  extras: THREE.Object3D[];
  /** The machines' boards under their hardware decks, shown with the hardware layer. */
  boards: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>[];
  /** The cables drawn solid (USB, Ethernet), by the index of their link, with the opacity they pulse around. */
  tubes: { k: number; mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; base: number }[];
  packets: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  /** The interfaces' addresses (an IP) beside their dots, each shown while its owner is big enough on screen. */
  portLabels: { object: CSS2DObject; node: string; owner: string }[];
  /** The interfaces: a dot where each link meets a wall or a mantle. */
  ports: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  labels: Map<string, CSS2DObject>;
  /** The internet's globes and their labels. */
  globes: { id: string; lines: THREE.LineSegments<THREE.WireframeGeometry, THREE.LineBasicMaterial>; label: CSS2DObject }[];
  bounds: { center: THREE.Vector3; radius: number };
  /** The layout's boxes as one string: an unchanged structure keeps its meshes and only repaints. */
  shape: string;
}

/** Most packets a link carries at once (at its container's highest load). */
const MAX_PACKETS = 5;

/** A soft round dot for the packets. */
function dotTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const g = canvas.getContext("2d")!;
  const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.85)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gradient;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

/**
 * The twin as a 3D WebGL scene (three.js): nested translucent shells — the cluster, its nodes inside, their pods
 * inside those, down to the containers — with gaps between siblings and edges coloured by status in the theme's cyan.
 * Boxes have slightly rounded edges; storage (DTDL telemetry `used`) is a cylinder filled as far as it is full. Where
 * twins have a network (DTDL telemetry `network`), a line runs from a hub on their container's back wall to each one's
 * facing wall, and packets travel it as fast and as many as its load says; the cluster's hub reaches the internet, a
 * globe behind it. Related siblings (a container mounting a volume) are joined wall to wall. Every line ends on a
 * surface, marked with a dot: an interface, never the inside of a solid. Hovering highlights a box in the stronger accent (--accent-active) and names it; a click
 * selects it, and the camera flies to it until it fills the view; deselecting leaves the camera where it is, and
 * `home` changing (a second Escape) flies back to the whole twin. `anchor` gives the selected box's corners on screen, for the panels' callout lines.
 */
export function Twin3D({
  scene: twin,
  selected,
  home,
  onSelect,
  anchor,
  control,
  layers = ALL_LAYERS,
  display: displayOptions = DEFAULT_DISPLAY,
  onNavigate,
  onLayersChange,
}: {
  scene: TwinScene;
  selected?: TwinView;
  home: number;
  onSelect: (node: TwinView) => void;
  anchor: RefObject<(() => Point[] | null) | null>;
  /** The camera, steered from outside (the agent's twin_view): turn, tilt and zoom, animated. */
  control?: RefObject<CameraControl | null>;
  /** What the view shows. */
  layers?: Layers;
  /** How it draws (labels, addresses, moving traffic). */
  display?: DisplayOptions;
  /** The keyboard's Tab/Shift+Tab (cycle the selection) and H (the whole twin). */
  onNavigate?: (action: "next" | "prev" | "home") => void;
  /** The keyboard's 1–4 (one layer alone) and 0 (every layer). */
  onLayersChange?: (l: Layers) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const chosen = useRef(selected);
  chosen.current = selected;
  const shown = useRef(layers);
  shown.current = layers;
  const display = useRef(displayOptions);
  display.current = displayOptions;
  /** The mounted scene's entry points, for the effects below. */
  const view = useRef<{ show: (twin: TwinScene) => void; focus: () => void; home: () => void }>(undefined);

  useEffect(() => {
    const element = host.current!;
    const colors = themeColors();

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(element.clientWidth, element.clientHeight);
    element.appendChild(renderer.domElement);

    // Labels are DOM (three.js CSS2D): crisp text in the page's own typeface, above the boxes.
    const labelRenderer = new CSS2DRenderer({ element: document.createElement("div") });
    labelRenderer.setSize(element.clientWidth, element.clientHeight);
    Object.assign(labelRenderer.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    element.appendChild(labelRenderer.domElement);

    // The hover tip: what the pointer is over, next to the pointer.
    const tip = document.createElement("div");
    tip.className = "twin-tip";
    tip.hidden = true;
    element.appendChild(tip);

    const world = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, element.clientWidth / element.clientHeight, 0.1, 5000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.05;
    const dot = dotTexture();

    let content: Content | undefined;
    let hovered: string | undefined;
    let fitted = false;
    /** The twin the camera last flew to, so a refreshed selection doesn't fly again. */
    let flownTo: string | undefined;

    const clear = () => {
      if (!content) return;
      for (const { mesh, edges, fill } of content.meshes) {
        world.remove(mesh, edges);
        mesh.geometry.dispose();
        mesh.material.dispose();
        edges.geometry.dispose();
        edges.material.dispose();
        if (fill) {
          world.remove(fill.body, fill.level);
          fill.body.geometry.dispose();
          fill.body.material.dispose();
          fill.level.geometry.dispose();
          fill.level.material.dispose();
        }
      }
      world.remove(content.lines, content.dashed, content.packets, content.ports);
      content.dashed.geometry.dispose();
      content.dashed.material.dispose();
      for (const x of content.extras) {
        world.remove(x);
        x.traverse((o) => {
          const any = o as THREE.Mesh;
          any.geometry?.dispose();
          (any.material as THREE.Material | undefined)?.dispose();
        });
      }
      for (const m of content.meshes) {
        if (m.led) (world.remove(m.led), m.led.geometry.dispose(), m.led.material.dispose());
        for (const d of m.decor) (world.remove(d.object), d.object.geometry.dispose(), d.object.material.dispose());
      }
      content.ports.geometry.dispose();
      content.ports.material.dispose();
      content.lines.geometry.dispose();
      content.lines.material.dispose();
      content.packets.geometry.dispose();
      content.packets.material.dispose();
      for (const label of content.labels.values()) label.removeFromParent();
      for (const p of content.portLabels) p.object.removeFromParent();
      for (const g of content.globes) {
        world.remove(g.lines);
        g.lines.geometry.dispose();
        g.lines.material.dispose();
        g.label.removeFromParent();
      }
      content = undefined;
    };

    /**
     * Every solid (a translucent body and the outline that carries its status, outer shells drawn first; storage a
     * cylinder with its content), the links and their interfaces.
     */
    const build = (scene: Scene, byId: Map<string, TwinView>, shape: string): Content => {
      const extras: THREE.Object3D[] = [];
      const meshes: BoxMesh[] = scene.boxes.map((box) => {
        const node = byId.get(box.id);
        const look = node?.look ?? "box";
        const cylinder = box.shape === "cylinder";
        const r = box.size[0] / 2;
        // An interface by its kind: a router a disc, a tunnel a hexagonal one, a bridge a bar, the rest a plate.
        const kind = box.shape === "port" && node ? portKind(node) : "";
        const disc = kind === "router" || kind === "tunnel" || kind === "loadbalancer";
        const geometry =
          cylinder ? new THREE.CylinderGeometry(r, r, box.size[1], 40)
          : box.shape === "drum" ? new THREE.CylinderGeometry(r, r, box.size[1], 64)
          : box.shape === "hex" ? new THREE.CylinderGeometry(r, r, box.size[1], 6)
          : box.shape === "gate" ? gateGeometry(box.size)
          : disc ? new THREE.CylinderGeometry(box.size[0] / 2, box.size[0] / 2, box.size[2], kind === "tunnel" ? 6 : kind === "loadbalancer" ? 40 : 24).rotateX(Math.PI / 2)
          : new RoundedBoxGeometry(box.size[0], box.size[1], box.size[2], box.shape === "port" ? 2 : 3, box.radius);
        const mesh = new THREE.Mesh(geometry as THREE.BufferGeometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
        mesh.position.set(...box.center);
        mesh.userData = { id: box.id };
        // A grouping has broken edges: a namespace dashed, a workload dotted — sets of things, not things.
        const dashed = node?.dashed ? { dashSize: 0.6, gapSize: 0.4 } : look === "workload" ? { dashSize: 0.12, gapSize: 0.14 } : undefined;
        const outline =
          box.shape === "gate" ? gateEdges(box.size)
          : box.shape === "drum" ? drumEdges(r, box.size[1])
          : box.shape === "hex" || disc ? new THREE.EdgesGeometry(geometry as THREE.BufferGeometry)
          : look === "disk" ? diskEdges(r, box.size[1])
          : cylinder ? cylinderEdges(r, box.size[1])
          : roundedEdges(box.size, box.radius);
        const edges = new THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial | THREE.LineDashedMaterial>(
          outline,
          dashed ? new THREE.LineDashedMaterial({ transparent: true, ...dashed }) : new THREE.LineBasicMaterial({ transparent: true }),
        );
        if (dashed) edges.computeLineDistances();
        edges.position.set(...box.center);
        world.add(mesh, edges);
        // A node's status light along the bottom of its front; the cluster stands on a floor.
        let led: BoxMesh["led"];
        if (look === "node") {
          // A mini PC's front: power button with its light at the right, no badge.
          const front = box.center[2] + box.size[2] / 2 + 0.04;
          const bx = box.center[0] + box.size[0] / 2 - Math.max(1.2, box.size[1] * 0.15);
          const by = box.center[1] + box.size[1] * 0.2;
          const r = Math.max(0.32, box.size[1] * 0.05);
          led = new THREE.Mesh(new THREE.BoxGeometry(r * 1.1, r * 0.35, 0.06), new THREE.MeshBasicMaterial({ transparent: true }));
          led.position.set(bx, by - r * 2.2, front);
          world.add(led);
        }
        if (look === "cluster") {
          const span = Math.max(box.size[0], box.size[2]);
          const grid = new THREE.GridHelper(span, Math.max(4, Math.round(span / 2)), colors.cyan, colors.cyan);
          grid.scale.set(box.size[0] / span, 1, box.size[2] / span);
          grid.position.set(box.center[0], box.center[1] - box.size[1] / 2 + 0.02, box.center[2]);
          const material = grid.material as THREE.LineBasicMaterial;
          material.transparent = true;
          material.opacity = 0.07;
          material.depthWrite = false;
          grid.userData = { floor: true };
          world.add(grid);
          extras.push(grid);
        }
        const decor: BoxMesh["decor"] = [];
        const add = (role: BoxMesh["decor"][number]["role"], object: BoxMesh["decor"][number]["object"]) => (world.add(object), decor.push({ role, object }));
        const flat = () => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
        if (look === "node") {
          // The chassis' front: a panel, a vent grille over most of it, a round power button at the right.
          const [w, h, d] = box.size;
          const front = box.center[2] + d / 2 + 0.02;
          const panel = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.3, h - 0.3), flat());
          panel.position.set(box.center[0], box.center[1], front);
          add("bezel", panel);
          const gw = (w - 0.3) * 0.72;
          const gh = (h - 0.3) * 0.7;
          const vents = new THREE.LineSegments(ventGeometry(gw, gh), new THREE.LineBasicMaterial({ transparent: true }));
          vents.position.set(box.center[0] - (w - 0.3) / 2 + 0.8 + gw / 2, box.center[1], front + 0.01);
          add("vents", vents);
          const button = new THREE.LineLoop(ring(Math.max(0.32, h * 0.05)).rotateX(Math.PI / 2), new THREE.LineBasicMaterial({ transparent: true }));
          button.position.set(box.center[0] + w / 2 - Math.max(1.2, h * 0.15), box.center[1] + h * 0.2, front + 0.01);
          add("button", button);
        }
        if (look === "router") {
          // A router's antennas standing up at its back, its lights along its front.
          const [w, h, d] = box.size;
          const length = w * 0.65;
          for (let i = 0; i < 4; i++) {
            const antenna = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.1, h * 0.14, length, 8), new THREE.MeshBasicMaterial({ transparent: true }));
            antenna.position.set(box.center[0] - w / 2 + w * 0.08 + (i * w * 0.84) / 3, box.center[1] + h / 2 + length / 2, box.center[2] - d / 2 + h * 0.4);
            antenna.rotation.z = (i - 1.5) * 0.08;
            add("antenna", antenna);
          }
        }
        if (look === "router" || look === "switch") {
          const [w, h, d] = box.size;
          for (let i = 0; i < (look === "router" ? 5 : 1); i++) {
            const light = new THREE.Mesh(new THREE.PlaneGeometry(h * 0.25, h * 0.12), flat());
            light.rotation.x = -Math.PI / 2;
            light.position.set(box.center[0] - w / 2 + h * 0.8 + i * h * 0.5, box.center[1] + h / 2 + 0.01, box.center[2] + d / 2 - h * 0.4);
            add("deviceLed", light);
          }
        }
        if (box.shape === "port" && (kind === "physical" || kind === "usb")) {
          // A real socket on the port's face: an RJ45's opening with its clip's notch, its contacts and two lights; a
          // USB-A's opening with its tongue.
          const turn = facing(box.normal);
          const normal = new THREE.Vector3(...(box.normal ?? [0, 0, -1]));
          const across = Math.abs(normal.x) > 0.5 ? box.size[2] : box.size[0];
          const out = (Math.abs(normal.x) > 0.5 ? box.size[0] : box.size[2]) / 2;
          const h = box.size[1];
          const onFace = (object: THREE.Object3D, x: number, y: number, lift: number) => {
            const offset = new THREE.Vector3(x, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), turn);
            object.position.set(box.center[0] + offset.x + normal.x * (out + lift), box.center[1] + y, box.center[2] + offset.z + normal.z * (out + lift));
            object.rotation.y = turn;
            return object;
          };
          const plate = (w: number, ph: number, x: number, y: number, lift: number) => onFace(new THREE.Mesh(new THREE.PlaneGeometry(w, ph), flat()), x, y, lift) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
          if (kind === "physical") {
            const sw = across * 0.7;
            const sh = h * 0.52;
            const sy = -h * 0.08;
            add("socket", plate(sw, sh, 0, sy, 0.004));
            add("socket", plate(across * 0.3, h * 0.14, 0, sy - sh / 2 - h * 0.06, 0.004));
            add("pins", onFace(new THREE.LineSegments(pinGeometry(sw * 0.8, sy + sh / 2 - 0.02, sh * 0.3), new THREE.LineBasicMaterial({ transparent: true })), 0, 0, 0.008) as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>);
            add("linkLed", plate(across * 0.14, h * 0.12, -across * 0.36, h * 0.36, 0.004));
            add("actLed", plate(across * 0.14, h * 0.12, across * 0.36, h * 0.36, 0.004));
          } else {
            add("socket", plate(across * 0.84, h * 0.62, 0, 0, 0.004));
            add("tongue", plate(across * 0.68, h * 0.2, 0, h * 0.09, 0.008));
            add("actLed", plate(across * 0.12, h * 0.12, across * 0.5 + 0.1, h * 0.3, 0.004));
          }
        }
        if (box.shape === "gate") {
          // The way through the portal: a membrane traffic passes, glowing softly; a lock on the beam with TLS.
          const t = Math.min(box.size[0], box.size[1]) * 0.16;
          const membrane = new THREE.Mesh(new THREE.PlaneGeometry(box.size[0] - 2 * t, box.size[1] - t), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
          membrane.position.set(box.center[0], box.center[1] - t / 2, box.center[2]);
          add("membrane", membrane);
          if (node?.twin.tls === true) {
            const top = box.center[1] + box.size[1] / 2;
            const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.26, 0.12), new THREE.MeshBasicMaterial({ transparent: true }));
            body.position.set(box.center[0], top + 0.2, box.center[2]);
            const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.03, 6, 16, Math.PI), new THREE.MeshBasicMaterial({ transparent: true }));
            shackle.position.set(box.center[0], top + 0.33, box.center[2]);
            add("lock", body);
            add("lock", shackle);
          }
        }
        if (box.shape === "drum") {
          // The lid: a track and an arc as far round as the cluster is full; a halo above it in its health's colour.
          const lid = box.center[1] + box.size[1] / 2 + 0.03;
          const track = new THREE.Mesh(gaugeGeometry(r * 0.8, r * 0.92, 1), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
          track.position.set(box.center[0], lid, box.center[2]);
          add("track", track);
          const gauge = new THREE.Mesh(gaugeGeometry(r * 0.8, r * 0.92, 0.001), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
          gauge.position.set(box.center[0], lid + 0.01, box.center[2]);
          add("gauge", gauge);
          const halo = new THREE.LineLoop(ring(r * 1.1), new THREE.LineBasicMaterial({ transparent: true }));
          halo.position.set(box.center[0], lid + 0.3, box.center[2]);
          add("halo", halo);
        }
        if (look === "drive") {
          // A disk's activity light on its front, blinking with its I/O.
          const light = new THREE.Mesh(new THREE.BoxGeometry(0.16, Math.min(0.08, box.size[1] * 0.4), 0.04), new THREE.MeshBasicMaterial({ transparent: true }));
          light.position.set(box.center[0] + box.size[0] / 2 - 0.2, box.center[1], box.center[2] + box.size[2] / 2 + 0.03);
          add("activity", light);
        }
        if (box.shape === "port" && kind === "loadbalancer") {
          // A load balancer: a rotor of spokes, one per node it hands traffic to, turning on the disc's face.
          const steps = Math.max(1, scenePaths?.relationships.filter((x) => x.$relationshipName === "connectedTo" && x.$sourceId === box.id).length ?? 1);
          const rotor = new THREE.LineSegments(spokes(steps, r * 0.18, r * 0.82), new THREE.LineBasicMaterial({ transparent: true }));
          rotor.position.set(box.center[0], box.center[1], box.center[2] + box.size[2] / 2 + 0.02);
          add("rotor", rotor);
          decor[decor.length - 1]!.steps = steps;
          const rim = new THREE.LineLoop(ring(r * 0.95).rotateX(Math.PI / 2), new THREE.LineBasicMaterial({ transparent: true }));
          rim.position.copy(rotor.position);
          add("halo", rim);
        }
        if (box.shape === "hex") {
          // A Service's endpoints: spokes on its lid, one per ready pod, and a sweep handing each request to the next.
          const steps = Math.min(12, Math.max(0, num(node?.twin.readyEndpoints) ?? 0));
          if (steps) {
            const lid = box.center[1] + box.size[1] / 2 + 0.02;
            const fan = new THREE.LineSegments(spokes(steps, r * 0.15, r * 0.8).rotateX(-Math.PI / 2), new THREE.LineBasicMaterial({ transparent: true }));
            fan.position.set(box.center[0], lid, box.center[2]);
            add("spokes", fan);
            const sweep = new THREE.LineSegments(spokes(1, 0, r * 0.86).rotateX(-Math.PI / 2), new THREE.LineBasicMaterial({ transparent: true }));
            sweep.position.set(box.center[0], lid + 0.01, box.center[2]);
            add("sweep", sweep);
            decor[decor.length - 1]!.steps = steps;
          }
        }
        let fill: BoxMesh["fill"];
        if (cylinder) {
          // A unit-high cylinder standing on the floor, scaled to the level in `paint`.
          const body = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.86, r * 0.86, 1, 40).translate(0, 0.5, 0) as THREE.BufferGeometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
          const level = new THREE.LineLoop(ring(r * 0.86), new THREE.LineBasicMaterial({ transparent: true }));
          body.position.set(box.center[0], box.center[1] - box.size[1] / 2, box.center[2]);
          level.position.copy(body.position);
          world.add(body, level);
          fill = { body, level, axis: "y", span: box.size[1], base: body.position.y };
        } else if ((look === "core" || look === "memory" || look === "drive") && !node?.children.length) {
          // A part's load: from its floor up (a core, memory), along a flat disk from its left end.
          const [w, h, d] = box.size;
          const along = look === "drive" || look === "memory";
          const k = 0.84;
          const body = new THREE.Mesh(
            (along ? new THREE.BoxGeometry(1, h * k, d * k).translate(0.5, 0, 0) : new THREE.BoxGeometry(w * k, 1, d * k).translate(0, 0.5, 0)) as THREE.BufferGeometry,
            new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
          );
          const level = new THREE.LineLoop(along ? frame(h * k, d * k, true) : frame(w * k, d * k), new THREE.LineBasicMaterial({ transparent: true }));
          if (along) body.position.set(box.center[0] - (w * k) / 2, box.center[1], box.center[2]);
          else body.position.set(box.center[0], box.center[1] - h / 2 + (h * (1 - k)) / 2, box.center[2]);
          level.position.copy(body.position);
          world.add(body, level);
          fill = { body, level, axis: along ? "x" : "y", span: along ? w * k : h * k, base: along ? body.position.x : body.position.y };
        }
        return { id: box.id, box, mesh, edges, fill, led, decor };
      });
      // The machines' boards: thin plates under their hardware.
      const boards = scene.boards.map((b) => {
        const plate = new THREE.Mesh(new THREE.BoxGeometry(...b.size), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
        plate.position.set(...b.center);
        plate.renderOrder = -2;
        world.add(plate);
        extras.push(plate);
        return plate;
      });
      // Outer shells behind inner ones, so transparency stacks whole cuboids in the right order.
      meshes.forEach((m, i) => {
        m.mesh.renderOrder = i;
        m.edges.renderOrder = i + meshes.length;
      });

      const links: LinkPath[] = scene.links.map((l) => {
        const lengths = l.path.slice(1).map((p, i) => new THREE.Vector3(...p).distanceTo(new THREE.Vector3(...l.path[i]!)));
        return { ...l, lengths, total: lengths.reduce((a, b) => a + b, 0) || 1 };
      });
      // The links as line segments with a colour (and alpha) per vertex, so each can fade on its own; the tunnels and
      // the routing dashed.
      const isDashed = (l: Link) => l.kind === "overlay" || l.kind === "virtual" || l.kind === "storage";
      const vertexAt: Content["vertexAt"] = [];
      const counts = { solid: 0, dashed: 0 };
      for (const l of links) {
        const d = isDashed(l);
        vertexAt.push({ dashed: d, from: d ? counts.dashed : counts.solid });
        if (d) counts.dashed += (l.path.length - 1) * 2;
        else counts.solid += (l.path.length - 1) * 2;
      }
      const geometryOf = (list: LinkPath[]) => {
        const segments = list.flatMap((l) => l.path.slice(1).flatMap((p, i) => [...l.path[i]!, ...p]));
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
        g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array((segments.length / 3) * 4), 4));
        return g;
      };
      const lines = new THREE.LineSegments(geometryOf(links.filter((l) => !isDashed(l))), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
      lines.renderOrder = -1;
      const dashed = new THREE.LineSegments(
        geometryOf(links.filter(isDashed)),
        new THREE.LineDashedMaterial({ vertexColors: true, transparent: true, depthWrite: false, dashSize: 0.35, gapSize: 0.25 }),
      );
      dashed.computeLineDistances();
      dashed.renderOrder = -1;
      // The cables a machine is plugged in with: solid, thick, with their plugs.
      const tubes: Content["tubes"] = links.flatMap((l, k) => {
        if (l.kind !== "cable" && l.kind !== "ethernet") return [];
        const mesh = new THREE.Mesh(cableGeometry(l.path, l.radius ?? (l.kind === "cable" ? 0.1 : 0.075)), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
        mesh.renderOrder = 2 * meshes.length - 1;
        world.add(mesh);
        extras.push(mesh);
        return [{ k, mesh, base: 0.75 }];
      });
      const packetGeometry = new THREE.BufferGeometry();
      packetGeometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(links.length * MAX_PACKETS * 3), 3));
      packetGeometry.setDrawRange(0, 0);
      const packets = new THREE.Points(
        packetGeometry,
        new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, map: dot, transparent: true, depthWrite: false, color: colors.cyan }),
      );
      packets.renderOrder = 2 * meshes.length;
      packets.frustumCulled = false;
      // The interfaces: both ends of every link, each on a wall, a mantle or the globe.
      const portGeometry = new THREE.BufferGeometry();
      const ends = links.flatMap((l) => [l.path[0]!, l.path.at(-1)!]);
      portGeometry.setAttribute("position", new THREE.Float32BufferAttribute(ends.flat(), 3));
      portGeometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(ends.length * 4), 4));
      const ports = new THREE.Points(portGeometry, new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, map: dot, vertexColors: true, transparent: true, depthWrite: false }));
      ports.renderOrder = packets.renderOrder;
      world.add(lines, dashed, packets, ports);

      // The internet: a wireframe globe behind each outermost twin, named.
      const globes = scene.internet.map((n) => {
        const lines = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(n.radius, 18, 12)), new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }));
        lines.position.set(...n.center);
        const div = document.createElement("div");
        div.className = "twin-label-globe";
        div.textContent = t("twin:internet");
        const label = new CSS2DObject(div);
        label.position.set(n.center[0], n.center[1] + n.radius * 1.25, n.center[2]);
        world.add(lines, label);
        return { id: n.id, lines, label };
      });

      const b = scene.bounds;
      return {
        byId,
        meshes,
        boxes: new Map(scene.boxes.map((x) => [x.id, x])),
        links,
        lines,
        dashed,
        vertexAt,
        extras,
        boards,
        tubes,
        packets,
        ports,
        portLabels: portLabelsOf(scene.boxes, byId),
        labels: new Map(),
        globes,
        bounds: { center: new THREE.Vector3(...b.center), radius: Math.hypot(...b.size) / 2 },
        shape,
      };
    };

    const statusColor = (status: TwinStatus) => (status === "error" ? colors.error : status === "warn" ? colors.warn : colors.cyan);
    /** The twins traffic through the selection passes (an Ingress's Services and pods, its LoadBalancer, the public address). */
    let path = new Set<string>();
    let scenePaths: TwinScene | undefined;
    /** Whether a layer shows (the base always does). */
    const layerOn = (layer: LinkLayer | TwinView["layer"]) => layer === "base" || shown.current[layer];
    /**
     * Whether a twin is in a layer the view hides: its model's (`presentation.layer`, else the built-in one; a
     * workload's by its kind). A hidden workload takes what it groups with it (its pods and their containers).
     */
    const hidden = (node: TwinView | undefined): boolean => {
      if (!node) return false;
      if (!layerOn(node.layer)) return true;
      for (let n = node.parent; n; n = n.parent) if (isWorkloadLayer(n.layer) && !layerOn(n.layer)) return true;
      return false;
    };
    /** Whether a twin is the selected one or inside it: outside the selection everything fades. */
    const inFocus = (node: TwinView | undefined) => {
      const focus = chosen.current;
      // Nothing selected, or a twin the view has no box for (a namespace): everything is in view.
      if (!focus || !content?.boxes.has(focus.id)) return true;
      for (let n = node; n; n = n.parent) {
        if (n.id === focus.id || path.has(n.of ?? n.id)) return true;
        // A band (a namespace) selected: what belongs to it, in whichever container.
        if (focus.isBand && n.band === focus.of) return true;
      }
      return false;
    };
    /** Each link's load from 0 to 1 (by index), against its siblings' highest (at least 100 kB/s, so quiet stays calm). */
    let loads: number[] = [];

    /**
     * The addresses at the interfaces: each port's name and IP (eth0 10.1.0.10, vxlan.calico, the LoadBalancer's and
     * the public address) and each Service's virtual address, shown while what they belong to shows its name.
     */
    const portLabelsOf = (boxesOf: Box[], byId: Map<string, TwinView>) => {
      const out: Content["portLabels"] = [];
      // A twin with an address shown by its own solid: an interface's port (its owner is what it's mounted on), a
      // Service's virtual address.
      for (const b of boxesOf) {
        const node = byId.get(b.id);
        if (!node || (b.shape !== "port" && b.shape !== "hex")) continue;
        const ip = String(node.twin.ip ?? node.twin.clusterIP ?? "");
        const name = b.shape === "port" && node.name !== ip ? `${node.name} ` : "";
        if (!ip && !name) continue;
        const div = document.createElement("div");
        div.className = "twin-port";
        div.dataset.kind = b.shape === "port" ? portKind(node) : "service";
        div.textContent = `${name}${ip}`.trim();
        const object = new CSS2DObject(div);
        object.position.set(b.center[0], b.center[1] + b.size[1] / 2, b.center[2]);
        object.visible = false;
        world.add(object);
        out.push({ object, node: node.id, owner: node.parent && b.shape === "port" ? node.parent.id : node.id });
      }
      return out;
    };

    /** A label's content: the Kubernetes icon, the name, and a line of kind and state. */
    const fillLabel = (el: HTMLElement, node: TwinView) => {
      const focus = chosen.current;
      el.dataset.status = node.status;
      el.dataset.selected = String(focus?.id === node.id);
      el.dataset.dashed = String(!!node.dashed);
      const name = el.querySelector(".twin-label-name")!;
      const info = el.querySelector(".twin-label-info")!;
      if (name.textContent !== node.name) name.textContent = node.name;
      const line = `${kindOf(node)} · ${infoOf(node)}`;
      if (info.textContent !== line) info.textContent = line;
    };
    /** A twin's label, made the first time it shows: at its solid's top front left corner, growing up and right. */
    const labelOf = (node: TwinView, box: Box) => {
      let label = content!.labels.get(node.id);
      if (label) return label;
      const el = document.createElement("div");
      el.className = "twin-label";
      const inner = document.createElement("div");
      inner.className = "twin-label-body";
      // The icon is the generated, geometry-only markup of `k8s-icons.ts` (no data from the twin).
      inner.innerHTML = iconOf(node) ?? "";
      const text = document.createElement("div");
      text.className = "twin-label-text";
      const name = document.createElement("span");
      name.className = "twin-label-name";
      const info = document.createElement("span");
      info.className = "twin-label-info";
      text.append(name, info);
      inner.append(text);
      el.append(inner);
      label = new CSS2DObject(el);
      const left = box.center[0] - box.size[0] / 2 + Math.min(box.radius, box.size[0] / 4);
      label.position.set(left, box.center[1] + box.size[1] / 2, box.center[2] + box.size[2] / 2);
      world.add(label);
      content!.labels.set(node.id, label);
      fillLabel(el, node);
      return label;
    };

    /**
     * Level of detail: each solid's size on screen decides what its label shows — nothing when small, the icon, then
     * the name, then the kind and state. Outside the selection only its surroundings keep labels.
     */
    let lodAt = 0;
    const tmp = new THREE.Vector3();
    const updateLod = (time: number) => {
      if (!content || time - lodAt < 120) return;
      lodAt = time;
      const h = element.clientHeight;
      const scale = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      const focus = chosen.current && content.boxes.has(chosen.current.id) ? chosen.current : undefined;
      const levels = new Map<string, number>();
      for (const m of content.meshes) {
        const node = content.byId.get(m.id);
        if (!node) continue;
        const distance = Math.max(0.1, tmp.set(...m.box.center).distanceTo(camera.position));
        const px = (Math.max(m.box.size[0], m.box.size[2]) / distance) * scale;
        const near = (!focus || inFocus(node) || isAncestor(node, focus)) && !hidden(node);
        const mode = display.current.labels;
        const auto = px >= LOD.info ? 3 : px >= LOD.name ? 2 : px >= LOD.icon ? 1 : 0;
        const level = !near || mode === "off" ? 0 : mode === "all" ? Math.max(2, auto) : auto;
        levels.set(m.id, level);
        let label = content.labels.get(m.id);
        if (!level && !label) continue;
        label ??= labelOf(node, m.box);
        label.visible = level > 0;
        if (label.element.dataset.lod !== String(level)) label.element.dataset.lod = String(level);
      }
      // An address shows once its owner shows its name.
      for (const p of content.portLabels) {
        const owner = content.byId.get(p.owner);
        p.object.visible =
          display.current.addresses && !hidden(content.byId.get(p.node)) && !hidden(owner) && ((levels.get(p.owner) ?? 0) >= 2 || (!!focus && (focus.id === p.owner || path.has(p.owner))));
      }
    };
    /** Whether `node` is around `of`: a container it's in, or the band (namespace) it belongs to. */
    const isAncestor = (node: TwinView, of: TwinView) => {
      for (let n: TwinView | undefined = of; n; n = n.parent) if ((n !== of && n.id === node.id) || (node.isBand && n.band === node.of)) return true;
      return false;
    };

    /** How fast an activity light blinks for this many bytes per second: not at all when idle, up to 13 times a second. */
    const blinkRate = (bytes: number) => (bytes > 0 ? 1 + Math.min(12, Math.log10(1 + bytes / 1000) * 3) : 0);
    /** Whether a port has something plugged in: a cable to it (connectedTo, attaches) either way. */
    const portLinked = (node: TwinView) =>
      !!scenePaths?.relationships.some((r) => (r.$relationshipName === "connectedTo" || r.$relationshipName === "attaches") && (r.$sourceId === node.id || r.$targetId === node.id));
    /**
     * The traffic through a port (or a LAN device): a USB port's disk's I/O, a machine's card its machine's network, a
     * switch port the machine plugged into it, the uplink, the WAN port and the devices the whole cluster's.
     */
    const trafficOf = (node: TwinView): number => {
      const byId = content!.byId;
      const rels = scenePaths?.relationships ?? [];
      if (portKind(node) === "usb") return byId.get(rels.find((r) => r.$relationshipName === "attaches" && r.$sourceId === node.id)?.$targetId ?? "")?.resources?.io ?? 0;
      if (node.parent?.look === "node") return node.parent.network ?? 0;
      const card = rels.find((r) => r.$relationshipName === "connectedTo" && r.$targetId === node.id && byId.get(r.$sourceId)?.parent?.look === "node");
      if (card) return byId.get(card.$sourceId)!.parent!.network ?? 0;
      let root: TwinView | undefined = node;
      while (root?.parent) root = root.parent;
      return root?.network ?? 0;
    };

    const paint = () => {
      if (!content) return;
      const focus = chosen.current;
      for (const m of content.meshes) {
        const node = content.byId.get(m.id);
        if (!node) continue;
        const isChosen = focus?.id === m.id;
        const isHovered = hovered === m.id;
        const leaf = !node.children.length;
        const look = node.look;
        const off = hidden(node);
        m.mesh.visible = m.edges.visible = !off;
        if (m.led) m.led.visible = !off;
        // Outside the selection a box is a faint ghost; its ancestors stay as thin shells around it; on the path of
        // the selection's traffic it glows.
        const lit = focus && !isChosen && path.has(node.of ?? node.id);
        const fade = inFocus(node) ? 1 : 0.18;
        const strong = isChosen || isHovered || !!lit;
        // A part of a machine carries its load's colour while it is well.
        const load = node.resources?.load;
        const own = node.status === "ok" && load !== undefined ? loadLevel(load) : node.status;
        const color = strong ? colors.active : node.color ? new THREE.Color(node.color) : statusColor(own);
        m.edges.material.color = color;
        m.edges.material.opacity = (strong ? 1 : node.depth === 0 ? 0.9 : leaf ? 0.8 : 0.6) * fade;
        m.mesh.material.color = color;
        // Each kind its own body: a container solid, a port a lit plate, a Service and an Ingress only outlines, a
        // namespace tinted with its own hue.
        const body =
          look === "container" ? 0.38
          : look === "port" ? 0.65
          : look === "hex" ? 0.02
          : look === "gate" ? 0.3
          : look === "ceph" ? 0.07
          : look === "core" || look === "memory" ? 0.1
          : look === "cpu" ? 0.14
          : look === "drive" ? 0.16
          : look === "switch" || look === "router" ? 0.55
          : look === "node" ? 0.06
          : leaf ? 0.2
          : 0.035;
        m.mesh.material.opacity = (strong ? Math.max(body, leaf ? 0.4 : 0.1) : body) * fade;
        // A machine's chassis and the LAN's devices are grey metal; their outline still carries their status.
        if ((look === "node" || look === "switch" || look === "router") && !strong) m.mesh.material.color = colors.neutral;
        if (node.isBand && !strong) {
          m.mesh.material.color = new THREE.Color().setHSL(hueOf(node.name), 0.7, 0.55);
          m.mesh.material.opacity = 0.045 * fade;
        }
        if (look === "port" && !strong && node.status === "ok") {
          const kind = portKind(node);
          const c = kind === "router" ? colors.neutral : kind === "loadbalancer" || kind === "public" ? colors.active : colors.cyan;
          m.mesh.material.color = c;
          m.edges.material.color = c;
          if (kind === "bridge") m.mesh.material.opacity = 0.4 * fade;
          if (kind === "usb" || kind === "physical") (m.mesh.material.color = colors.neutral), (m.edges.material.color = colors.neutral), (m.mesh.material.opacity = 0.8 * fade);
          if (kind === "loadbalancer") m.mesh.material.opacity = 0.3 * fade;
        }
        for (const d of m.decor) {
          d.object.visible = !off;
          const full = fillOf(node) ?? 0;
          const material = d.object.material;
          if (d.role === "membrane") (material.color = strong ? colors.active : statusColor(node.status)), (material.opacity = (strong ? 0.22 : 0.1) * fade);
          else if (d.role === "lock") (material.color = colors.active), (material.opacity = 0.9 * fade);
          else if (d.role === "activity") material.color = colors.active;
          else if (d.role === "rotor" || d.role === "sweep") (material.color = colors.active), (material.opacity = (strong ? 1 : 0.7) * fade);
          else if (d.role === "spokes") (material.color = statusColor(node.status)), (material.opacity = (strong ? 0.8 : 0.4) * fade);
          else if (d.role === "track") (material.color = colors.neutral), (material.opacity = 0.15 * fade);
          else if (d.role === "socket") (material.color = SOCKET), (material.opacity = 0.95 * fade);
          else if (d.role === "pins" || d.role === "antenna") (material.color = colors.neutral), (material.opacity = 0.85 * fade);
          else if (d.role === "tongue") (material.color = colors.cyan), (material.opacity = 0.9 * fade);
          else if (d.role === "linkLed") (material.color = statusColor(node.status)), (material.opacity = (portLinked(node) ? 0.95 : 0.12) * fade);
          else if (d.role === "actLed") (material.color = colors.active), (d.rate = blinkRate(trafficOf(node)));
          else if (d.role === "bezel") (material.color = colors.neutral), (material.opacity = (strong ? 0.12 : 0.07) * fade);
          else if (d.role === "vents") (material.color = colors.neutral), (material.opacity = 0.35 * fade);
          else if (d.role === "button") (material.color = statusColor(node.status)), (material.opacity = 0.9 * fade);
          else if (d.role === "deviceLed") (material.color = statusColor(node.status)), (material.opacity = 0.95 * fade), (d.rate = blinkRate(trafficOf(node)));
          else if (d.role === "gauge") {
            if (m.gaugeAt !== full) {
              d.object.geometry.dispose();
              d.object.geometry = gaugeGeometry(m.box.size[0] * 0.4, m.box.size[0] * 0.46, full);
              m.gaugeAt = full;
            }
            material.color = full >= 0.85 ? colors.error : full >= 0.75 ? colors.warn : colors.cyan;
            material.opacity = 0.75 * fade;
          } else (material.color = statusColor(node.status)), (material.opacity = 0.8 * fade);
        }
        if (m.led) {
          m.led.material.color = statusColor(node.status);
          m.led.material.opacity = 0.9 * fade;
        }
        if (m.fill) {
          // Its content: as high (or as long) as it is full or busy, cyan up to 80 %, then warning, then error from 95 %.
          const full = m.box.shape === "cylinder" ? fillOf(node) : load;
          if (m.box.shape === "cylinder") m.mesh.material.opacity = (strong ? 0.18 : 0.08) * fade;
          const level = full === undefined ? 0 : Math.max(0.001, full * m.fill.span);
          const fillColor = full === undefined ? colors.cyan : statusColor(loadLevel(full));
          m.fill.body.scale[m.fill.axis] = level;
          m.fill.body.visible = full !== undefined && !off;
          m.fill.body.material.color = fillColor;
          m.fill.body.material.opacity = (node.resources?.estimated ? 0.25 : 0.45) * fade;
          m.fill.level.position[m.fill.axis] = m.fill.base + level;
          m.fill.level.visible = full !== undefined && !off;
          m.fill.level.material.color = fillColor;
          m.fill.level.material.opacity = 0.9 * fade;
        }
      }

      for (const b of content.boards) {
        b.visible = layerOn("hardware");
        b.material.color = colors.neutral;
        b.material.opacity = 0.08;
      }
      // Each network link's share of its network's load (interfaces carry no traffic).
      const byParent = new Map<string, number>();
      for (const l of content.links) if (l.kind !== "interface" && l.kind !== "resource" && l.kind !== "cable" && l.kind !== "ethernet") byParent.set(l.parent, Math.max(byParent.get(l.parent) ?? 0, content.byId.get(l.id)?.network ?? 0));
      const linkShown = (l: Link) => layerOn(l.layer) && !hidden(content!.byId.get(l.id)) && !hidden(l.to ? content!.byId.get(l.to) : content!.byId.get(l.parent));
      /** A line of what runs on what shows only for the selection: a container (or its pod) and its node's parts, or a part
       * and everything running on it. */
      const runsHere = (l: Link) => !!focus && (l.id === focus.id || l.to === focus.id || content!.byId.get(l.id)?.parent?.id === focus.id);
      loads = content.links.map((l) => {
        if (!linkShown(l)) return 0;
        if (l.kind === "resource") return runsHere(l) ? Math.min(1, 0.25 + (content!.byId.get(l.id)?.resources?.cpu ?? 0) * 2) : 0;
        if (l.kind === "cable") return Math.min(1, Math.log1p(content!.byId.get(l.to ?? "")?.resources?.io ?? 0) / Math.log1p(50_000_000));
        if (l.kind === "ethernet") return Math.min(1, Math.log1p(content!.byId.get(l.id)?.network ?? 0) / Math.log1p(50_000_000));
        // The selection's traffic moves along its path.
        if (path.has(l.id) && (!l.to || path.has(l.to)) && focus) return 0.6;
        if (l.kind === "wire" || l.kind === "overlay" || l.kind === "virtual" || l.kind === "lan" || l.kind === "storage") return 0;
        const load = l.kind === "interface" ? undefined : content!.byId.get(l.id)?.network;
        return load === undefined || load <= 0 ? 0 : Math.min(1, Math.log1p(load) / Math.log1p(Math.max(byParent.get(l.parent) ?? 0, 100_000)));
      });
      const solid = content.lines.geometry.getAttribute("color") as THREE.BufferAttribute;
      const broken = content.dashed.geometry.getAttribute("color") as THREE.BufferAttribute;
      const portColor = content.ports.geometry.getAttribute("color") as THREE.BufferAttribute;
      const globesOn = new Set<string>();
      content.links.forEach((l, k) => {
        const a = content!.byId.get(l.id);
        // A line ends at the selection (a disk of the selected Ceph, a Service's pods): lit like the traffic's path.
        const atFocus = !!focus && (l.id === focus.id || l.to === focus.id || l.id === focus.of || l.to === focus.of);
        const onPath = (path.has(l.id) && (!l.to || path.has(l.to))) || atFocus;
        const visible = linkShown(l);
        if (visible && l.kind === "internet") globesOn.add(l.id);
        const near = inFocus(content!.byId.get(l.parent)) || inFocus(a);
        // Networks in cyan by load; a node's wiring and the tunnels quieter; mounts and storage grey; routing faint,
        // glowing on the path of the selection's traffic.
        const c = onPath || l.kind === "resource" ? colors.active : l.kind === "interface" || l.kind === "wire" || l.kind === "storage" || l.kind === "cable" ? colors.neutral : colors.cyan;
        const alpha = !visible
          ? 0
          : l.kind === "resource" ? (runsHere(l) ? 0.85 : 0)
          : l.kind === "cable" || l.kind === "ethernet" ? 0
          : onPath && l.kind !== "network" && l.kind !== "internet"
            ? 0.9
            : l.kind === "virtual" ? 0.3 * (near ? 1 : 0.2)
            : l.kind === "storage" ? 0.4 * (near ? 1 : 0.15)
            : l.kind === "interface" ? 0.7 * (near ? 1 : 0.15)
            : l.kind === "lan" ? 0.5 * (near ? 1 : 0.15)
            : l.kind === "wire" || l.kind === "overlay" ? 0.45 * (near ? 1 : 0.2)
            : (onPath ? 0.9 : 0.18 + 0.5 * loads[k]!) * (near || onPath ? 1 : 0.15);
        const at = content!.vertexAt[k]!;
        const target = at.dashed ? broken : solid;
        for (let i = 0; i < (l.path.length - 1) * 2; i++) target.setXYZW(at.from + i, c.r, c.g, c.b, alpha);
        for (const e of [2 * k, 2 * k + 1]) portColor.setXYZW(e, c.r, c.g, c.b, alpha ? (near || onPath || l.kind === "resource" ? 0.95 : 0.15) : 0);
      });
      // The cables: USB light grey, Ethernet in the network's cyan, both brighter on the selection's path.
      for (const tube of content.tubes) {
        const l = content.links[tube.k]!;
        const shown = linkShown(l);
        tube.mesh.visible = shown;
        const near = inFocus(content.byId.get(l.parent)) || inFocus(content.byId.get(l.id)) || inFocus(l.to ? content.byId.get(l.to) : undefined);
        const lit = !!focus && (l.id === focus.id || l.to === focus.id || content.byId.get(l.to ?? "")?.parent?.id === focus.id);
        tube.mesh.material.color = lit ? colors.active : l.kind === "cable" ? colors.neutral : colors.cyan;
        tube.base = (lit ? 0.95 : 0.75) * (near ? 1 : 0.2);
        tube.mesh.material.opacity = tube.base;
      }
      solid.needsUpdate = true;
      broken.needsUpdate = true;
      portColor.needsUpdate = true;
      content.packets.material.color = colors.cyan;
      // The internet shows while a line to it does.
      for (const g of content.globes) {
        g.lines.visible = globesOn.has(g.id);
        g.lines.material.color = colors.cyan;
        g.lines.material.opacity = focus && content.boxes.has(focus.id) ? 0.08 : 0.4;
        g.label.visible = g.lines.visible && (!focus || !content.boxes.has(focus.id));
      }

      // The labels' content follows the twin; how much of it shows is the level of detail's (every few frames).
      for (const [id, label] of content.labels) {
        const node = content.byId.get(id);
        if (node) fillLabel(label.element, node);
      }
      lodAt = 0;
    };

    /** The packets' positions now: each link's packets spread along it, half going out and half coming in. */
    const movePackets = (time: number) => {
      if (!content) return;
      if (!display.current.traffic) return void content.packets.geometry.setDrawRange(0, 0);
      const position = content.packets.geometry.getAttribute("position") as THREE.BufferAttribute;
      const still = reducedMotion();
      let n = 0;
      for (const [k, l] of content.links.entries()) {
        const load = loads[k] ?? 0;
        if (load <= 0) continue;
        if (l.kind !== "resource" && !inFocus(content.byId.get(l.parent)) && !inFocus(content.byId.get(l.id))) continue;
        const count = 1 + Math.round(load * (MAX_PACKETS - 1));
        const speed = 1.5 + 9 * load; // scene units per second
        for (let k = 0; k < count; k++) {
          let f = (((still ? 0 : time / 1000) * speed) / l.total + k / count) % 1;
          if (k % 2) f = 1 - f;
          let d = f * l.total;
          let i = 0;
          while (i < l.lengths.length - 1 && d > l.lengths[i]!) d -= l.lengths[i++]!;
          const a = l.path[i]!;
          const b = l.path[i + 1]!;
          const s = Math.min(1, d / (l.lengths[i] || 1));
          position.setXYZ(n++, a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s);
        }
      }
      position.needsUpdate = true;
      content.packets.geometry.setDrawRange(0, n);
    };

    /** Flies the camera to look at `center` from far enough that a sphere of `radius` fills the view. */
    let flight = 0;
    const fly = (center: THREE.Vector3, radius: number, fill: number, from?: THREE.Spherical) => {
      const fov = THREE.MathUtils.degToRad(camera.fov);
      const fovH = 2 * Math.atan(Math.tan(fov / 2) * camera.aspect);
      const distance = (radius / Math.sin(Math.min(fov, fovH) / 2)) * fill;
      // From the side the user looks from, at a comfortable height.
      const direction = from ?? new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
      const phi = THREE.MathUtils.clamp(direction.phi, 0.55, 1.1);
      const to = center.clone().add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(distance, phi, direction.theta)));
      const fromPosition = camera.position.clone();
      const fromTarget = controls.target.clone();
      const id = ++flight;
      if (reducedMotion()) {
        camera.position.copy(to);
        controls.target.copy(center);
        return;
      }
      const start = performance.now();
      controls.enabled = false;
      const step = () => {
        if (id !== flight) return;
        const k = easeInOut(Math.min(1, (performance.now() - start) / 900));
        camera.position.lerpVectors(fromPosition, to, k);
        controls.target.lerpVectors(fromTarget, center, k);
        if (k < 1) requestAnimationFrame(step);
        else controls.enabled = true;
      };
      step();
    };
    const homeDirection = () => new THREE.Spherical(1, 0.95, Math.PI / 4);
    const flyHome = () => {
      flownTo = undefined;
      if (content) fly(content.bounds.center, content.bounds.radius, 0.9, homeDirection());
    };
    /** The selection's traffic path, worked out again whenever the selection or the scene changes. */
    const updatePath = () => {
      const focus = chosen.current;
      path = focus && scenePaths ? pathOf(scenePaths, focus.of ?? focus.id) : new Set();
    };
    /** The selected twin fills the view (once per selection); none: the camera stays. */
    const focus = () => {
      updatePath();
      paint();
      const node = chosen.current;
      if (!node) return void (flownTo = undefined);
      const box = content?.boxes.get(node.id);
      if (!box || flownTo === node.id) return;
      flownTo = node.id;
      // Centered with room around it, so what is next to it stays in view.
      fly(new THREE.Vector3(...box.center), Math.hypot(...box.size) / 2, 2.4);
    };

    /** Shows a (new or refreshed) twin: the same structure only repaints, a changed one rebuilds the boxes. */
    const show = (twin: TwinScene) => {
      const byId = new Map<string, TwinView>();
      const walk = (node: TwinView) => {
        byId.set(node.id, node);
        for (const child of node.children) walk(child);
      };
      for (const node of twin.top) walk(node);
      for (const band of twin.bands) byId.set(band.id, band);
      path = new Set();
      scenePaths = twin;
      const scene = layoutTwin(twin.top, layoutRules(twin));
      const shape = scene.boxes.map((x) => `${x.id}@${x.center.join(",")}:${x.size.join(",")}`).join("|");
      if (content && content.shape === shape) content.byId = byId;
      else {
        clear();
        content = build(scene, byId, shape);
      }
      // The camera fits everything once: above at an angle; after that it stays the user's.
      if (!fitted && content.meshes.length) {
        const sphere = new THREE.Spherical(1, 0.95, Math.PI / 4);
        const fov = THREE.MathUtils.degToRad(camera.fov);
        const fovH = 2 * Math.atan(Math.tan(fov / 2) * camera.aspect);
        camera.position.copy(content.bounds.center).add(new THREE.Vector3().setFromSpherical(sphere.set((content.bounds.radius / Math.sin(Math.min(fov, fovH) / 2)) * 0.9, sphere.phi, sphere.theta)));
        controls.target.copy(content.bounds.center);
        fitted = true;
      }
      focus();
    };
    view.current = { show, focus, home: flyHome };

    /** Moves the camera around its target to a new spherical position, animated like the flights. */
    const orbit = (change: (s: THREE.Spherical) => void) => {
      const s = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
      change(s);
      s.phi = THREE.MathUtils.clamp(s.phi, 0.15, controls.maxPolarAngle);
      s.radius = THREE.MathUtils.clamp(s.radius, 2, 5000);
      const to = controls.target.clone().add(new THREE.Vector3().setFromSpherical(s));
      const from = camera.position.clone();
      const id = ++flight;
      if (reducedMotion()) return void camera.position.copy(to);
      const start = performance.now();
      const step = () => {
        if (id !== flight) return;
        const k = easeInOut(Math.min(1, (performance.now() - start) / 700));
        // Around the target, not through it: interpolate the angles and the distance.
        const a = new THREE.Spherical().setFromVector3(from.clone().sub(controls.target));
        a.theta += (s.theta - a.theta) * k;
        a.phi += (s.phi - a.phi) * k;
        a.radius += (s.radius - a.radius) * k;
        camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(a));
        if (k < 1) requestAnimationFrame(step);
      };
      step();
    };
    if (control)
      control.current = {
        rotate: (degrees) => orbit((s) => (s.theta += THREE.MathUtils.degToRad(degrees))),
        tilt: (degrees) => orbit((s) => (s.phi -= THREE.MathUtils.degToRad(degrees))),
        zoom: (factor) => orbit((s) => (s.radius /= factor > 0 ? factor : 1)),
        pan: (right, forward) => {
          const radius = camera.position.distanceTo(controls.target);
          const k = radius * 0.004;
          const r = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
          const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
          f.y = 0;
          f.normalize();
          const off = r.multiplyScalar(right * k).addScaledVector(f, forward * k);
          camera.position.add(off);
          controls.target.add(off);
          controls.update();
        },
        lift: (up) => {
          const k = camera.position.distanceTo(controls.target) * 0.004;
          const off = new THREE.Vector3(0, up * k, 0);
          camera.position.add(off);
          controls.target.add(off);
          controls.update();
        },
      };

    // The selected box's corners on screen, for the panels' callout lines (none behind the camera).
    anchor.current = () => {
      const box = chosen.current && content?.boxes.get(chosen.current.id);
      if (!box) return null;
      const w = element.clientWidth;
      const h = element.clientHeight;
      const points: Point[] = [];
      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          for (const sz of [-1, 1]) {
            const p = new THREE.Vector3(box.center[0] + (sx * box.size[0]) / 2, box.center[1] + (sy * box.size[1]) / 2, box.center[2] + (sz * box.size[2]) / 2).project(camera);
            if (p.z < 1) points.push({ x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h });
          }
      return points.length ? points : null;
    };

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    /** What a pointer event hits: the innermost (smallest) box under it, so a pod answers over its node. */
    const pick = (event: MouseEvent): TwinView | undefined => {
      if (!content) return undefined;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const { meshes, byId } = content;
      const hits = raycaster.intersectObjects(
        meshes.filter((m) => m.mesh.visible).map((m) => m.mesh),
        false,
      );
      const volume = (id: string) => content!.boxes.get(id)!.size.reduce((a, b) => a * b, 1);
      const innermost = hits.map((hit) => hit.object.userData.id as string).sort((a, b) => volume(a) - volume(b))[0];
      return innermost ? byId.get(innermost) : undefined;
    };

    const onMove = (event: PointerEvent) => {
      const node = event.buttons ? undefined : pick(event);
      if (hovered !== node?.id) {
        hovered = node?.id;
        paint();
      }
      element.style.cursor = node ? "pointer" : "";
      tip.hidden = !node;
      if (!node) return;
      const rect = element.getBoundingClientRect();
      tip.replaceChildren();
      const kind = document.createElement("span");
      kind.className = "twin-tip-kind";
      kind.textContent = kindOf(node);
      const name = document.createElement("strong");
      name.textContent = node.name;
      const meta = document.createElement("span");
      meta.dataset.status = node.status;
      meta.textContent = infoOf(node);
      tip.append(kind, name, meta);
      const x = event.clientX - rect.left + 14;
      const y = event.clientY - rect.top + 14;
      tip.style.transform = `translate(${Math.min(x, rect.width - tip.offsetWidth - 8)}px, ${Math.min(y, rect.height - tip.offsetHeight - 8)}px)`;
    };
    const onLeave = () => {
      hovered = undefined;
      tip.hidden = true;
      paint();
    };
    // A click selects, but not the end of a drag (orbiting).
    let down: Point | undefined;
    const onDown = (event: PointerEvent) => (down = { x: event.clientX, y: event.clientY });
    const onClick = (event: MouseEvent) => {
      if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
      const node = pick(event);
      if (node) select.current(node);
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerleave", onLeave);
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("click", onClick);

    let running = true;
    const draw = (time: number) => {
      if (!running) return;
      controls.update();
      movePackets(time);
      updateLod(time);
      if (content && !reducedMotion()) {
        for (const g of content.globes) g.lines.rotation.y = time / 12_000;
        // A portal breathes; a storage cluster's halo pulses while it isn't healthy.
        const wave = 0.5 + 0.5 * Math.sin(time / 600);
        for (const m of content.meshes)
          for (const d of m.decor) {
            if (d.role === "membrane") d.object.scale.setScalar(0.94 + 0.06 * wave);
            if (d.role === "halo" && m.box.shape !== "port") d.object.scale.setScalar(content.byId.get(m.id)?.status === "ok" ? 1 : 1 + 0.08 * wave);
            const node = content.byId.get(m.id);
            const lit = chosen.current?.id === m.id || path.has(m.id) || hovered === m.id;
            // A disk blinks with its I/O (faster the more), a load balancer turns (faster on the selection's path), a
            // Service's sweep hands requests to its endpoints in turn.
            if (d.role === "activity") {
              const io = node?.resources?.io ?? 0;
              const rate = io > 0 ? 1 + Math.min(12, Math.log10(1 + io / 1000) * 3) : 0;
              d.object.material.opacity = d.object.visible ? (rate ? (Math.sin((time / 1000) * rate * Math.PI * 2) > 0 ? 0.95 : 0.15) : 0.1) : 0;
            }
            if ((d.role === "actLed" || d.role === "deviceLed") && d.object.visible) {
              const rate = d.rate ?? 0;
              const on = rate ? Math.sin((time / 1000) * rate * Math.PI * 2 + m.box.center[0]) > -0.2 : d.role === "deviceLed";
              d.object.material.opacity = on ? 0.95 : 0.12;
            }
            if (d.role === "rotor") d.object.rotation.z = -(time / 1000) * (lit ? 2.4 : 0.5);
            if (d.role === "sweep" && d.steps) d.object.rotation.y = -(Math.floor(time / (lit ? 260 : 700)) % d.steps) * ((Math.PI * 2) / d.steps);
          }
      }
      // A cable with traffic pulses: brighter and dimmer, faster the more goes through it.
      if (content && !reducedMotion())
        for (const tube of content.tubes) {
          const load = loads[tube.k] ?? 0;
          tube.mesh.material.opacity = load > 0 ? tube.base * (0.7 + 0.3 * Math.sin((time / 1000) * (1 + 6 * load) * Math.PI * 2)) : tube.base;
        }
      renderer.render(world, camera);
      labelRenderer.render(world, camera);
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);

    const resize = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      camera.aspect = element.clientWidth / element.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(element.clientWidth, element.clientHeight);
      labelRenderer.setSize(element.clientWidth, element.clientHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    // A changed scheme (light or dark) repaints the scene with the new palette.
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const schemeChange = () => {
      Object.assign(colors, themeColors());
      paint();
    };
    scheme.addEventListener("change", schemeChange);

    return () => {
      running = false;
      flight++;
      view.current = undefined;
      anchor.current = null;
      if (control) control.current = null;
      scheme.removeEventListener("change", schemeChange);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("click", onClick);
      clear();
      dot.dispose();
      controls.dispose();
      renderer.dispose();
      element.replaceChildren();
    };
  }, []);

  useEffect(() => view.current?.show(twin), [twin]);
  useEffect(() => view.current?.focus(), [selected]);
  useEffect(() => view.current?.focus(), [...LAYER_KEYS.map((k) => layers[k]), displayOptions.labels, displayOptions.addresses, displayOptions.traffic]);
  useEffect(() => {
    if (home) view.current?.home();
  }, [home]);

  // The keyboard inside the model: WASD/arrows move the look-at point, Q/E down/up, +/- zoom, Tab/Shift+Tab cycle
  // the selection, H the whole twin, 1–5 one infrastructure layer alone, 6 the workloads alone, 0 every layer. Keys go to inputs (the chat) first.
  const onKey = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
    const c = control?.current;
    const k = e.key;
    const handled = () => e.preventDefault();
    if (k === "Tab") (handled(), onNavigate?.(e.shiftKey ? "prev" : "next"));
    else if (k === "h" || k === "H") (handled(), onNavigate?.("home"));
    else if (k >= "1" && k <= String(INFRA_LAYERS.length) && k.length === 1) (handled(), onLayersChange?.(onlyLayers((l) => l === INFRA_LAYERS[Number(k) - 1])));
    else if (k === String(INFRA_LAYERS.length + 1)) (handled(), onLayersChange?.(onlyLayers(isWorkloadLayer)));
    else if (k === "0") (handled(), onLayersChange?.(ALL_LAYERS));
    else if (k === "ArrowLeft" || k === "a" || k === "A") (handled(), c?.pan(-60, 0));
    else if (k === "ArrowRight" || k === "d" || k === "D") (handled(), c?.pan(60, 0));
    else if (k === "ArrowUp" || k === "w" || k === "W") (handled(), c?.pan(0, 60));
    else if (k === "ArrowDown" || k === "s" || k === "S") (handled(), c?.pan(0, -60));
    else if (k === "q" || k === "Q") (handled(), c?.lift(-60));
    else if (k === "e" || k === "E") (handled(), c?.lift(60));
    else if (k === "+" || k === "=") (handled(), c?.zoom(1.25));
    else if (k === "-" || k === "_") (handled(), c?.zoom(0.8));
  };

  return <div ref={host} className="relative isolate h-full w-full overflow-hidden outline-none" role="application" aria-label={t("twin:view3d")} tabIndex={0} onKeyDown={onKey} />;
}
