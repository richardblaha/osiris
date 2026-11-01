import type { TwinStatus } from "@osiris/shared";
import * as THREE from "three";
import { portKind } from "../icons.ts";
import { fillOf, isWorkloadLayer, type TwinScene, type TwinView, type ViewLayer } from "../scene.ts";
import type { Box, Link, LinkLayer, Scene } from "../TwinLayout.ts";
import { hueOf } from "./geometry.ts";
import { loadLevel } from "./info.ts";

/** The theme's colours the scene wears, read from the page's CSS variables (light and dark scheme alike). */
export interface Colors {
  cyan: THREE.Color;
  active: THREE.Color;
  neutral: THREE.Color;
  warn: THREE.Color;
  error: THREE.Color;
}
export function themeColors(): Colors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => new THREE.Color(css.getPropertyValue(name).trim() || "#888888");
  // The accent for what is well, a stronger one (--accent-active) for what is selected or hovered, the theme's --state-error for errors.
  return { cyan: v("--accent-primary"), active: v("--accent-active"), neutral: v("--text-secondary"), warn: v("--state-warning"), error: v("--state-error") };
}
export const statusColor = (colors: Colors, status: TwinStatus) => (status === "error" ? colors.error : status === "warn" ? colors.warn : colors.cyan);

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A network link as drawn: its path's lengths, for the packets that travel it. */
export interface LinkPath extends Link {
  lengths: number[];
  total: number;
}

/** What the view shows of one twin scene: the layout, every twin by id and each box by id. */
export interface Content {
  scene: Scene;
  byId: Map<string, TwinView>;
  boxes: Map<string, Box>;
  links: LinkPath[];
  twin: TwinScene;
  bounds: { center: THREE.Vector3; radius: number };
}

/** Which layers show (the base always does). */
export type Layers = Record<ViewLayer, boolean>;

/**
 * Where the view stands now, for everything that draws: the selection, the hovered twin, the selection's traffic path
 * and the layers. `hidden` and `inFocus` answer for any twin.
 */
export interface ViewState {
  content: Content;
  focus?: TwinView;
  hovered?: string;
  path: Set<string>;
  layers: Layers;
  colors: Colors;
}

export const layerOn = (v: Pick<ViewState, "layers">, layer: LinkLayer | TwinView["layer"]) => layer === "base" || v.layers[layer];

/**
 * Whether a twin is in a layer the view hides: its model's (`presentation.layer`, else the built-in one; a workload's by
 * its kind). A hidden workload takes what it groups with it (its pods and their containers).
 */
export function hidden(v: Pick<ViewState, "layers">, node: TwinView | undefined): boolean {
  if (!node) return false;
  if (!layerOn(v, node.layer)) return true;
  for (let n = node.parent; n; n = n.parent) if (isWorkloadLayer(n.layer) && !layerOn(v, n.layer)) return true;
  return false;
}

/** Whether a twin is the selected one or inside it: outside the selection everything fades. */
export function inFocus(v: ViewState, node: TwinView | undefined): boolean {
  const focus = v.focus;
  // Nothing selected, or a twin the view has no box for (a namespace): everything is in view.
  if (!focus || !v.content.boxes.has(focus.id)) return true;
  for (let n = node; n; n = n.parent) {
    if (n.id === focus.id || v.path.has(n.of ?? n.id)) return true;
    // A band (a namespace) selected: what belongs to it, in whichever container.
    if (focus.isBand && n.band === focus.of) return true;
  }
  return false;
}

/** Whether `node` is around `of`: a container it's in, or the band (namespace) it belongs to. */
export function isAncestor(node: TwinView, of: TwinView): boolean {
  for (let n: TwinView | undefined = of; n; n = n.parent) if ((n !== of && n.id === node.id) || (node.isBand && n.band === node.of)) return true;
  return false;
}

/** How fast an activity light blinks for this many bytes per second: not at all when idle, up to 13 times a second. */
export const blinkRate = (bytes: number) => (bytes > 0 ? 1 + Math.min(12, Math.log10(1 + bytes / 1000) * 3) : 0);

/** Whether a port has something plugged in: a cable to it (connectedTo, attaches) either way. */
export const portLinked = (twin: TwinScene, node: TwinView) =>
  twin.relationships.some((r) => (r.$relationshipName === "connectedTo" || r.$relationshipName === "attaches") && (r.$sourceId === node.id || r.$targetId === node.id));

/**
 * The traffic through a port (or a LAN device): a USB port's disk's I/O, a machine's card its machine's network, a
 * switch port the machine plugged into it, the uplink, the WAN port and the devices the whole cluster's.
 */
export function trafficOf(content: Content, node: TwinView): number {
  const { byId } = content;
  const rels = content.twin.relationships;
  if (node.look === "drive") return node.resources?.io ?? 0;
  if (portKind(node) === "usb") return byId.get(rels.find((r) => r.$relationshipName === "attaches" && r.$sourceId === node.id)?.$targetId ?? "")?.resources?.io ?? 0;
  if (node.parent?.look === "node") return node.parent.network ?? 0;
  const card = rels.find((r) => r.$relationshipName === "connectedTo" && r.$targetId === node.id && byId.get(r.$sourceId)?.parent?.look === "node");
  if (card) return byId.get(card.$sourceId)!.parent!.network ?? 0;
  let root: TwinView | undefined = node;
  while (root?.parent) root = root.parent;
  return root?.network ?? 0;
}

/**
 * How one solid looks now: whether it shows, how much it fades (outside the selection), whether it stands out
 * (selected, hovered, on the selection's traffic path), the colours and opacities of its outline and body, its
 * status colour, how full it is (storage, a part's load) and how fast its activity light blinks. Colours are hex
 * strings, so an unchanged look compares equal and its solid isn't drawn again.
 */
export interface Appearance {
  hidden: boolean;
  fade: number;
  strong: boolean;
  /** On the selection's path, selected or hovered: a load balancer turns faster. */
  lit: boolean;
  edge: string;
  edgeOpacity: number;
  body: string;
  bodyOpacity: number;
  status: string;
  /** How full (0–1) its content is drawn, its colour and opacity; undefined without. */
  fill?: number;
  fillColor: string;
  fillOpacity: number;
  /** Activity light blinks per second (0 dark). */
  rate: number;
  /** A port with something plugged in. */
  linked: boolean;
}

const hex = (c: THREE.Color) => `#${c.getHexString()}`;

/** Each kind's body opacity: a container solid, a port a lit plate, a Service and an Ingress only outlines. */
function bodyOpacity(node: TwinView, leaf: boolean): number {
  const look = node.look;
  return look === "container" ? 0.38
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
}

/** How a twin's solid looks in the view as it stands. */
export function appearanceOf(v: ViewState, node: TwinView, box: Box): Appearance {
  const { colors, focus } = v;
  const isChosen = focus?.id === node.id;
  const isHovered = v.hovered === node.id;
  const leaf = !node.children.length;
  const look = node.look;
  // Outside the selection a box is a faint ghost; its ancestors stay as thin shells around it; on the path of the
  // selection's traffic it glows.
  const lit = !!focus && !isChosen && v.path.has(node.of ?? node.id);
  const fade = inFocus(v, node) ? 1 : 0.18;
  const strong = isChosen || isHovered || lit;
  // A part of a machine carries its load's colour while it is well.
  const load = node.resources?.load;
  const own = node.status === "ok" && load !== undefined ? loadLevel(load) : node.status;
  let edge = strong ? colors.active : node.color ? new THREE.Color(node.color) : statusColor(colors, own);
  let edgeOpacity = (strong ? 1 : node.depth === 0 ? 0.9 : leaf ? 0.8 : 0.6) * fade;
  let body = edge;
  const base = bodyOpacity(node, leaf);
  let opacity = (strong ? Math.max(base, leaf ? 0.4 : 0.1) : base) * fade;
  // A machine's chassis and the LAN's devices are grey metal; their outline still carries their status.
  if ((look === "node" || look === "switch" || look === "router") && !strong) body = colors.neutral;
  if (node.isBand && !strong) {
    body = new THREE.Color().setHSL(hueOf(node.name), 0.7, 0.55);
    opacity = 0.045 * fade;
  }
  if (look === "port" && !strong && node.status === "ok") {
    const kind = portKind(node);
    const c = kind === "router" ? colors.neutral : kind === "loadbalancer" || kind === "public" ? colors.active : colors.cyan;
    body = edge = c;
    if (kind === "bridge") opacity = 0.4 * fade;
    if (kind === "usb" || kind === "physical") (body = edge = colors.neutral), (opacity = 0.8 * fade);
    if (kind === "loadbalancer") opacity = 0.3 * fade;
  }
  // Its content: as high (or as long) as it is full or busy, cyan up to 80 %, then warning, then error from 95 %.
  const cylinder = box.shape === "cylinder";
  const part = (look === "core" || look === "memory" || look === "drive") && leaf;
  const fill = cylinder ? fillOf(node) : part ? load : undefined;
  if (cylinder) opacity = (strong ? 0.18 : 0.08) * fade;
  const kind = look === "port" ? portKind(node) : "";
  const rate = look === "drive" || look === "switch" || look === "router" || kind === "usb" || kind === "physical" ? blinkRate(trafficOf(v.content, node)) : 0;
  return {
    hidden: hidden(v, node),
    fade,
    strong,
    lit: isChosen || isHovered || v.path.has(node.id),
    edge: hex(edge),
    edgeOpacity: edgeOpacity,
    body: hex(body),
    bodyOpacity: opacity,
    status: hex(statusColor(colors, node.status)),
    fill,
    fillColor: hex(fill === undefined ? colors.cyan : statusColor(colors, loadLevel(fill))),
    fillOpacity: (node.resources?.estimated ? 0.25 : 0.45) * fade,
    rate,
    linked: look === "port" ? portLinked(v.content.twin, node) : false,
  };
}

/** Two appearances alike: a solid whose appearance is alike isn't drawn again. */
export const sameAppearance = (a: Appearance, b: Appearance) => {
  for (const k of Object.keys(a) as (keyof Appearance)[]) if (a[k] !== b[k]) return false;
  return true;
};

/**
 * How every link looks now: its colour and opacity (r, g, b, a per link), its interfaces' dots' opacity, its load
 * (0–1, how many packets and how fast) and which internet globes show.
 */
export interface LinkPaint {
  color: Float32Array;
  dots: Float32Array;
  loads: number[];
  /** The cables drawn solid, by link index: shown, their colour and the opacity they pulse around. */
  tubes: Map<number, { shown: boolean; color: string; base: number }>;
  globes: Set<string>;
}

export function linkPaintOf(v: ViewState): LinkPaint {
  const { content, colors, focus } = v;
  const { byId, links } = content;
  // Each network link's share of its network's load (interfaces carry no traffic).
  const byParent = new Map<string, number>();
  for (const l of links) if (l.kind !== "interface" && l.kind !== "resource" && l.kind !== "cable" && l.kind !== "ethernet") byParent.set(l.parent, Math.max(byParent.get(l.parent) ?? 0, byId.get(l.id)?.network ?? 0));
  const linkShown = (l: Link) => layerOn(v, l.layer) && !hidden(v, byId.get(l.id)) && !hidden(v, l.to ? byId.get(l.to) : byId.get(l.parent));
  /** A line of what runs on what shows only for the selection: a container (or its pod) and its node's parts, or a part
   * and everything running on it. */
  const runsHere = (l: Link) => !!focus && (l.id === focus.id || l.to === focus.id || byId.get(l.id)?.parent?.id === focus.id);
  const loads = links.map((l) => {
    if (!linkShown(l)) return 0;
    if (l.kind === "resource") return runsHere(l) ? Math.min(1, 0.25 + (byId.get(l.id)?.resources?.cpu ?? 0) * 2) : 0;
    if (l.kind === "cable") return Math.min(1, Math.log1p(byId.get(l.to ?? "")?.resources?.io ?? 0) / Math.log1p(50_000_000));
    if (l.kind === "ethernet") return Math.min(1, Math.log1p(byId.get(l.id)?.network ?? 0) / Math.log1p(50_000_000));
    // The selection's traffic moves along its path.
    if (v.path.has(l.id) && (!l.to || v.path.has(l.to)) && focus) return 0.6;
    if (l.kind === "wire" || l.kind === "overlay" || l.kind === "virtual" || l.kind === "lan" || l.kind === "storage") return 0;
    const load = l.kind === "interface" ? undefined : byId.get(l.id)?.network;
    return load === undefined || load <= 0 ? 0 : Math.min(1, Math.log1p(load) / Math.log1p(Math.max(byParent.get(l.parent) ?? 0, 100_000)));
  });
  const color = new Float32Array(links.length * 4);
  const dots = new Float32Array(links.length);
  const tubes = new Map<number, { shown: boolean; color: string; base: number }>();
  const globes = new Set<string>();
  links.forEach((l, k) => {
    const a = byId.get(l.id);
    // A line ends at the selection (a disk of the selected Ceph, a Service's pods): lit like the traffic's path.
    const atFocus = !!focus && (l.id === focus.id || l.to === focus.id || l.id === focus.of || l.to === focus.of);
    const onPath = (v.path.has(l.id) && (!l.to || v.path.has(l.to))) || atFocus;
    const visible = linkShown(l);
    if (visible && l.kind === "internet") globes.add(l.id);
    const near = inFocus(v, byId.get(l.parent)) || inFocus(v, a);
    // Networks in cyan by load; a node's wiring and the tunnels quieter; mounts and storage grey; routing faint,
    // glowing on the path of the selection's traffic. The cables are tubes of their own.
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
    color.set([c.r, c.g, c.b, alpha], k * 4);
    dots[k] = alpha ? (near || onPath || l.kind === "resource" ? 0.95 : 0.15) : 0;
    if (l.kind === "cable" || l.kind === "ethernet") {
      // USB light grey, Ethernet in the network's cyan, both brighter on the selection's path.
      const nearTube = near || inFocus(v, l.to ? byId.get(l.to) : undefined);
      const tubeLit = !!focus && (l.id === focus.id || l.to === focus.id || byId.get(l.to ?? "")?.parent?.id === focus.id);
      tubes.set(k, { shown: visible, color: hex(tubeLit ? colors.active : l.kind === "cable" ? colors.neutral : colors.cyan), base: (tubeLit ? 0.95 : 0.75) * (nearTube ? 1 : 0.2) });
    }
  });
  return { color, dots, loads, tubes, globes };
}
