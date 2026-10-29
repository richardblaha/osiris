import type { TwinView } from "./scene.ts";

type Vec = [number, number, number];

/** A node's solid in the twin's 3D scene: a rounded box, or a cylinder (storage); its center and full size. */
export interface Box {
  id: string;
  shape: "box" | "cylinder";
  center: Vec;
  /** Width, height, depth; a cylinder's width and depth are its diameter. */
  size: Vec;
  /** How round a box's edges are. */
  radius: number;
}

/**
 * A line between two interfaces, both on a solid's surface (a wall or a cylinder's mantle), never inside one:
 * `network` from the container's hub on its back wall to the child's wall facing it (traffic animated by the child's
 * load), `interface` between two siblings that are related (a container mounting a volume), `internet` from the
 * outermost twin's back wall to the globe.
 */
export interface Link {
  kind: "network" | "interface" | "internet";
  /** The twin whose load the link carries (network, internet), or the relationship's source (interface). */
  id: string;
  /** The container whose network it joins; the internet's links have their own. */
  parent: string;
  path: Vec[];
}

/** The internet outside an outermost twin: a globe its network reaches through the back wall. */
export interface Internet {
  /** The outermost twin it serves. */
  id: string;
  center: Vec;
  radius: number;
}

/** The parent id of the links to the internet: they share their own load scale. */
export const INTERNET = "@internet";

export interface Scene {
  /** Every node's solid, outermost first. */
  boxes: Box[];
  links: Link[];
  internet: Internet[];
  /** Everything together, to fit the camera. */
  bounds: { center: Vec; size: Vec };
}

/** What the layout asks of the twin: which twins have a network, which are storage, and the siblings' interfaces. */
export interface LayoutRules {
  networked: (node: TwinView) => boolean;
  storage: (node: TwinView) => boolean;
  /** Related siblings, as id pairs. */
  interfaces: [string, string][];
}

/** What a node's own layout measured: its size, with solids and links relative to its floor center. */
interface Measured {
  size: Vec;
  boxes: Box[];
  links: Link[];
}

/** The space between siblings: wide between the outer shells (nodes), tight between the innermost (containers). */
const gapAt = (depth: number) => Math.max(0.5, 4 / 2.4 ** depth);
/** The margin of a shell around what it holds, on every side: children float inside it, never touching it. */
const padAt = (depth: number) => gapAt(depth) * 0.55 + 0.45;
/** How round a box's edges are: a little, more for the big shells, never more than a fifth of its least side. */
const roundness = (size: Vec) => Math.min(Math.min(...size) * 0.2, Math.min(...size) * 0.06 + 0.1, 1.2);

/** A leaf's size: a small cube (or cylinder) at the bottom of the tree, a bigger one higher up. */
const leafOf = (node: TwinView, storage: boolean): Vec =>
  storage ? (node.depth >= 3 ? [1.3, 1.5, 1.3] : [2, 2.2, 2]) : node.depth >= 3 ? [1, 1, 1] : node.depth === 2 ? [1.6, 1.2, 1.6] : [3, 2, 3];

const shift = (v: Vec, by: Vec): Vec => [v[0] + by[0], v[1] + by[1], v[2] + by[2]];

/** A solid placed in its container: its floor center and its size. */
interface Placed {
  at: Vec;
  size: Vec;
  shape: Box["shape"];
}

/**
 * The interface of a solid toward a point (only x and z count), at height `y`: on a box, the middle of the wall facing
 * it; on a cylinder, the mantle where it faces it.
 */
function port(p: Placed, toward: Vec, y: number): Vec {
  const [x, , z] = p.at;
  const dx = toward[0] - x;
  const dz = toward[2] - z;
  if (p.shape === "cylinder") {
    const r = p.size[0] / 2;
    const d = Math.hypot(dx, dz);
    return d ? [x + (dx / d) * r, y, z + (dz / d) * r] : [x, y, z - r];
  }
  // The wall the point lies beyond: the axis on which it is farther out, relative to the box's extent.
  return Math.abs(dx) / p.size[0] > Math.abs(dz) / p.size[2] ? [x + Math.sign(dx) * (p.size[0] / 2), y, z] : [x, y, z + (Math.sign(dz) || -1) * (p.size[2] / 2)];
}

/**
 * Measures one node: its children grouped by model (siblings of a kind share a layer), each group a near-square grid
 * of uniform cells with gaps between them, the groups one behind another, all of it floating inside the node's own
 * solid with a margin on every side — shells within shells. Networked children get a link from the node's hub (on
 * its back wall, between its floor and theirs) to their own facing wall; related children a link wall to wall.
 */
function measure(node: TwinView, rules: LayoutRules): Measured {
  const storage = rules.storage(node);
  if (!node.children.length) {
    const size = leafOf(node, storage);
    return { size, boxes: [{ id: node.id, shape: storage ? "cylinder" : "box", center: [0, size[1] / 2, 0], size, radius: roundness(size) }], links: [] };
  }
  const gap = gapAt(node.depth);
  const pad = padAt(node.depth);

  const groups = new Map<string, { node: TwinView; m: Measured }[]>();
  for (const child of node.children) {
    const list = groups.get(child.model) ?? groups.set(child.model, []).get(child.model)!;
    list.push({ node: child, m: measure(child, rules) });
  }
  // Each group as a grid: its cell (the largest child's size), columns and footprint.
  const grids = [...groups.values()]
    .sort((a, b) => b.length - a.length)
    .map((items) => {
      const cell: Vec = [0, 1, 2].map((i) => Math.max(...items.map((x) => x.m.size[i]!))) as Vec;
      const cols = Math.ceil(Math.sqrt(items.length));
      const rows = Math.ceil(items.length / cols);
      return { items, cell, cols, rows, width: (cell[0] + gap) * cols - gap, depth: (cell[2] + gap) * rows - gap };
    });
  const innerW = Math.max(...grids.map((g) => g.width));
  const innerD = grids.reduce((n, g) => n + g.depth, 0) + gap * (grids.length - 1);
  const innerH = Math.max(...grids.map((g) => g.cell[1]));
  const size: Vec = [innerW + 2 * pad, innerH + 2 * pad, innerD + 2 * pad];

  const boxes: Box[] = [{ id: node.id, shape: storage ? "cylinder" : "box", center: [0, size[1] / 2, 0], size, radius: roundness(size) }];
  const links: Link[] = [];
  const placed = new Map<string, Placed>();
  // The hub: the node's interface on its back wall, halfway between its floor and its children's.
  const hub: Vec = [0, pad * 0.5, -size[2] / 2];
  let z = -innerD / 2;
  for (const g of grids) {
    g.items.forEach(({ node: child, m }, i) => {
      const col = i % g.cols;
      const row = Math.floor(i / g.cols);
      // Centered in its row: a short last row doesn't hug one side.
      const inRow = row === g.rows - 1 ? g.items.length - row * g.cols : g.cols;
      const rowW = (g.cell[0] + gap) * inRow - gap;
      const at: Vec = [-rowW / 2 + g.cell[0] / 2 + col * (g.cell[0] + gap), pad, z + g.cell[2] / 2 + row * (g.cell[2] + gap)];
      for (const b of m.boxes) boxes.push({ ...b, center: shift(b.center, at) });
      for (const l of m.links) links.push({ ...l, path: l.path.map((p) => shift(p, at)) });
      const p: Placed = { at, size: m.size, shape: m.boxes[0]!.shape };
      placed.set(child.id, p);
      if (rules.networked(child)) {
        // Along the floor to the foot of the child's facing wall, then up that wall to its middle.
        const end = port(p, hub, at[1] + m.size[1] / 2);
        links.push({ kind: "network", id: child.id, parent: node.id, path: [hub, [end[0], hub[1], end[2]], end] });
      }
    });
    z += g.depth + gap;
  }
  // Related children: wall to wall, at the lower one's middle height.
  for (const [a, b] of rules.interfaces) {
    const pa = placed.get(a);
    const pb = placed.get(b);
    if (!pa || !pb) continue;
    const y = pad + Math.min(pa.size[1], pb.size[1]) / 2;
    links.push({ kind: "interface", id: a, parent: node.id, path: [port(pa, pb.at, y), port(pb, pa.at, y)] });
  }
  return { size, boxes, links };
}

/**
 * The twin's whole scene: the outermost twins (a cluster) side by side, each with what it contains nested inside as
 * translucent shells, all the way down; behind each with a network, the internet it talks to.
 */
export function layoutTwin(top: TwinView[], rules: LayoutRules): Scene {
  const roots = top.map((node) => measure(node, rules));
  if (!roots.length) return { boxes: [], links: [], internet: [], bounds: { center: [0, 1, 0], size: [4, 2, 4] } };
  const gap = gapAt(0) * 2;
  const boxes: Box[] = [];
  const links: Link[] = [];
  const internet: Internet[] = [];
  let x = 0;
  top.forEach((node, i) => {
    const r = roots[i]!;
    const at: Vec = [x + r.size[0] / 2, 0, 0];
    for (const b of r.boxes) boxes.push({ ...b, center: shift(b.center, at) });
    for (const l of r.links) links.push({ ...l, path: l.path.map((p) => shift(p, at)) });
    // Behind the twin, up in the air: the internet, from the hub on the twin's back wall to the globe's surface.
    if (r.links.some((l) => l.kind === "network")) {
      const hub: Vec = [at[0], padAt(0) * 0.5, -r.size[2] / 2];
      const radius = Math.max(2.5, Math.min(r.size[0], r.size[2]) * 0.07);
      const center: Vec = [at[0], r.size[1] + radius * 1.5, -r.size[2] / 2 - radius * 3 - gap];
      internet.push({ id: node.id, center, radius });
      const out: Vec = [hub[0], hub[1], hub[2] - gap / 2];
      const d: Vec = [out[0] - center[0], out[1] - center[1], out[2] - center[2]];
      const len = Math.hypot(...d) || 1;
      links.push({ kind: "internet", id: node.id, parent: INTERNET, path: [hub, out, shift(center, [(d[0] / len) * radius, (d[1] / len) * radius, (d[2] / len) * radius])] });
    }
    x += r.size[0] + gap;
  });
  const minX = Math.min(...boxes.map((b) => b.center[0] - b.size[0] / 2));
  const maxX = Math.max(...boxes.map((b) => b.center[0] + b.size[0] / 2));
  const minZ = Math.min(...boxes.map((b) => b.center[2] - b.size[2] / 2), ...internet.map((n) => n.center[2] - n.radius));
  const maxZ = Math.max(...boxes.map((b) => b.center[2] + b.size[2] / 2));
  const maxY = Math.max(...boxes.map((b) => b.center[1] + b.size[1] / 2), ...internet.map((n) => n.center[1] + n.radius));
  return { boxes, links, internet, bounds: { center: [(minX + maxX) / 2, maxY / 2, (minZ + maxZ) / 2], size: [maxX - minX, maxY, maxZ - minZ] } };
}
