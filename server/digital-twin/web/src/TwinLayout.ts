import type { TwinNode } from "@osiris/shared";

/** A node's box in the twin's 3D scene: the center and the full size, in scene units. */
export interface Box {
  id: string;
  center: [number, number, number];
  size: [number, number, number];
}

export interface Scene {
  /** Every node's box (namespaces, workloads, pods, containers). */
  boxes: Box[];
  /** Everything together, to fit the camera. */
  bounds: { center: [number, number, number]; size: [number, number, number] };
}

const GAP = 1.4;
const PAD = 0.9;

/** What a node's own layout measured: its size on the floor, with boxes relative to its floor center. */
interface Measured {
  size: [number, number, number];
  boxes: Box[];
}

const cellOf = (kind: TwinNode["kind"]): [number, number, number] =>
  kind === "container" ? [1.6, 1.1, 1.6] : kind === "pod" ? [2.6, 1.8, 2.6] : [4, 3, 4];

/**
 * Measures one node: children in a grid of uniform cells (at most four in a row), wrapped in the node's own box.
 * Boxes come back relative to the node's floor center; `translate` moves them into place afterwards. Everything
 * grows up from y = 0, so nested boxes share a floor and read as one cuboid tree.
 */
function measure(node: TwinNode): Measured {
  if (!node.children.length) {
    const size = cellOf(node.kind);
    return { size, boxes: [{ id: node.id, center: [0, size[1] / 2, 0], size }] };
  }
  const children = node.children.map(measure);
  // Same-kind siblings share one cell size (a workload's pods, a namespace's workloads): the largest.
  const cell: [number, number, number] = [
    Math.max(...children.map((c) => c.size[0])),
    Math.max(...children.map((c) => c.size[1])),
    Math.max(...children.map((c) => c.size[2])),
  ];
  const cols = Math.min(4, children.length);
  const rows = Math.ceil(children.length / cols);
  const step = (v: number) => v + GAP;
  const inner: [number, number, number] = [step(cell[0]) * cols - GAP, cell[1], step(cell[2]) * rows - GAP];
  const size: [number, number, number] = [inner[0] + 2 * PAD, cell[1] + 2 * PAD, inner[2] + 2 * PAD];
  const boxes: Box[] = [{ id: node.id, center: [0, size[1] / 2, 0], size }];
  children.forEach((child, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const center: [number, number, number] = [inner[0] / 2 - step(cell[0]) / 2 + col * step(cell[0]), 0, inner[2] / 2 - step(cell[2]) / 2 + row * step(cell[2])];
    // The child's own box is at the cell's floor center; its descendants hang below inside it.
    translate(child.boxes, center, boxes);
  });
  return { size, boxes };
}

/** Copies measured boxes into `out`, shifted by `center` (a child's grid cell) — children sit on the same floor. */
function translate(source: Box[], center: [number, number, number], out: Box[]) {
  for (const box of source) out.push({ id: box.id, center: [box.center[0] + center[0], box.center[1], box.center[2] + center[2]], size: box.size });
}

/**
 * The twin's whole scene: namespaces side by side in a grid on one floor, each with its workloads, pods and
 * containers nested inside as translucent cuboids.
 */
export function layoutTwin(twin: TwinNode): Scene {
  const namespaces = twin.children.map(measure);
  if (!namespaces.length) return { boxes: [], bounds: { center: [0, 1, 0], size: [4, 2, 4] } };
  const cell: [number, number, number] = [
    Math.max(...namespaces.map((n) => n.size[0])),
    Math.max(...namespaces.map((n) => n.size[1])),
    Math.max(...namespaces.map((n) => n.size[2])),
  ];
  const cols = Math.min(4, namespaces.length);
  const rows = Math.ceil(namespaces.length / cols);
  const step = (v: number) => v + 2 * GAP;
  const boxes: Box[] = [];
  namespaces.forEach((ns, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    translate(ns.boxes, [step(cell[0]) / 2 - cell[0] / 2 + col * step(cell[0]), 0, step(cell[2]) / 2 - cell[2] / 2 + row * step(cell[2])], boxes);
  });
  const minX = Math.min(...boxes.map((b) => b.center[0] - b.size[0] / 2));
  const maxX = Math.max(...boxes.map((b) => b.center[0] + b.size[0] / 2));
  const minZ = Math.min(...boxes.map((b) => b.center[2] - b.size[2] / 2));
  const maxZ = Math.max(...boxes.map((b) => b.center[2] + b.size[2] / 2));
  const maxY = Math.max(...boxes.map((b) => b.center[1] + b.size[1] / 2));
  return {
    boxes,
    bounds: { center: [(minX + maxX) / 2, maxY / 2, (minZ + maxZ) / 2], size: [maxX - minX, maxY, maxZ - minZ] },
  };
}
