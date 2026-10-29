import type { TwinView } from "./scene.ts";

type Vec = [number, number, number];

/** A node's box in the twin's 3D scene: the center and the full size, in scene units. */
export interface Box {
  id: string;
  center: Vec;
  size: Vec;
}

/**
 * A network link: from the hub on its container's floor, along the floor under the box, then up into the box. The
 * view animates traffic along it by the box's load.
 */
export interface Link {
  /** The twin whose traffic the link carries, and the one whose network it joins. */
  id: string;
  parent: string;
  path: Vec[];
}

export interface Scene {
  /** Every node's box, outermost first. */
  boxes: Box[];
  links: Link[];
  /** Everything together, to fit the camera. */
  bounds: { center: Vec; size: Vec };
}

/** What a node's own layout measured: its size, with boxes and links relative to its floor center. */
interface Measured {
  size: Vec;
  boxes: Box[];
  links: Link[];
}

/** The space between siblings: wide between the outer shells (nodes), tight between the innermost (containers). */
const gapAt = (depth: number) => Math.max(0.5, 4 / 2.4 ** depth);
/** The margin of a shell around what it holds, on every side: children float inside it, never touching it. */
const padAt = (depth: number) => gapAt(depth) * 0.55 + 0.45;

/** A leaf's box: a small cube at the bottom of the tree, a bigger one higher up. */
const leafOf = (node: TwinView): Vec => (node.depth >= 3 ? [1, 1, 1] : node.depth === 2 ? [1.6, 1.2, 1.6] : [3, 2, 3]);

const shift = (v: Vec, by: Vec): Vec => [v[0] + by[0], v[1] + by[1], v[2] + by[2]];

/**
 * Measures one node: its children grouped by model (siblings of a kind share a layer), each group a near-square grid
 * of uniform cells with gaps between them, the groups one behind another, all of it floating inside the node's own
 * box with a margin on every side — shells within shells. Children whose model has a network get a link to a hub
 * on the node's floor.
 */
function measure(node: TwinView, networked: (node: TwinView) => boolean): Measured {
  if (!node.children.length) {
    const size = leafOf(node);
    return { size, boxes: [{ id: node.id, center: [0, size[1] / 2, 0], size }], links: [] };
  }
  const gap = gapAt(node.depth);
  const pad = padAt(node.depth);

  const groups = new Map<string, { node: TwinView; m: Measured }[]>();
  for (const child of node.children) {
    const list = groups.get(child.model) ?? groups.set(child.model, []).get(child.model)!;
    list.push({ node: child, m: measure(child, networked) });
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

  const boxes: Box[] = [{ id: node.id, center: [0, size[1] / 2, 0], size }];
  const links: Link[] = [];
  // The hub: on the node's floor, halfway up to its children's.
  const hubY = pad * 0.5;
  let z = -innerD / 2;
  for (const g of grids) {
    g.items.forEach(({ node: child, m }, i) => {
      const col = i % g.cols;
      const row = Math.floor(i / g.cols);
      // Centered in its row: a short last row doesn't hug one side.
      const inRow = row === g.rows - 1 ? g.items.length - row * g.cols : g.cols;
      const rowW = (g.cell[0] + gap) * inRow - gap;
      const at: Vec = [-rowW / 2 + g.cell[0] / 2 + col * (g.cell[0] + gap), pad, z + g.cell[2] / 2 + row * (g.cell[2] + gap)];
      for (const b of m.boxes) boxes.push({ id: b.id, center: shift(b.center, at), size: b.size });
      for (const l of m.links) links.push({ ...l, path: l.path.map((p) => shift(p, at)) });
      if (networked(child)) links.push({ id: child.id, parent: node.id, path: [[0, hubY, 0], [at[0], hubY, at[2]], [at[0], pad, at[2]]] });
    });
    z += g.depth + gap;
  }
  return { size, boxes, links };
}

/**
 * The twin's whole scene: the outermost twins (a cluster) side by side, each with what it contains nested inside as
 * translucent shells, all the way down.
 */
export function layoutTwin(top: TwinView[], networked: (node: TwinView) => boolean): Scene {
  const roots = top.map((node) => measure(node, networked));
  if (!roots.length) return { boxes: [], links: [], bounds: { center: [0, 1, 0], size: [4, 2, 4] } };
  const gap = gapAt(0) * 2;
  const boxes: Box[] = [];
  const links: Link[] = [];
  let x = 0;
  for (const r of roots) {
    const at: Vec = [x + r.size[0] / 2, 0, 0];
    for (const b of r.boxes) boxes.push({ id: b.id, center: shift(b.center, at), size: b.size });
    for (const l of r.links) links.push({ ...l, path: l.path.map((p) => shift(p, at)) });
    x += r.size[0] + gap;
  }
  const minX = Math.min(...boxes.map((b) => b.center[0] - b.size[0] / 2));
  const maxX = Math.max(...boxes.map((b) => b.center[0] + b.size[0] / 2));
  const minZ = Math.min(...boxes.map((b) => b.center[2] - b.size[2] / 2));
  const maxZ = Math.max(...boxes.map((b) => b.center[2] + b.size[2] / 2));
  const maxY = Math.max(...boxes.map((b) => b.center[1] + b.size[1] / 2));
  return { boxes, links, bounds: { center: [(minX + maxX) / 2, maxY / 2, (minZ + maxZ) / 2], size: [maxX - minX, maxY, maxZ - minZ] } };
}
