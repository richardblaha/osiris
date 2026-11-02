import type { TwinView } from "./scene.ts";

type Vec = [number, number, number];

/**
 * A solid's shape: a rounded box, a cylinder (storage), a port (a network interface, a plate on a wall), a hexagonal
 * prism (a Service: virtual), a gate (an Ingress: a portal traffic comes through) or a drum (a storage cluster: Ceph,
 * its pools inside).
 */
export type Shape = "box" | "cylinder" | "port" | "hex" | "gate" | "drum";

/** A node's solid in the twin's 3D scene: its shape, center and full size. */
export interface Box {
  id: string;
  shape: Shape;
  center: Vec;
  /** Width, height, depth; a cylinder's and a hexagon's width and depth are their diameter. */
  size: Vec;
  /** How round a box's edges are. */
  radius: number;
  /** The way a port faces, out of the wall it is on (−z, the back wall, by default). */
  normal?: Vec;
}

/** The view's layer a line belongs to (the display menu switches them with the solids). */
export type LinkLayer = "base" | "hardware" | "network" | "services" | "storage";

/**
 * A line between two interfaces, both on a solid's surface (a wall, a mantle, a port), never inside one, and always
 * orthogonal: every segment runs along one axis, turning at right angles, never the shortest way across.
 * `network` from the container's router or bridge (its hub on its back wall) to the child's port or back wall
 * (traffic animated by the child's load), `lan` a pod's containers on its eth0 (they share its network),
 * `internet` from the cluster's LoadBalancer to its public address on the globe, `wire` between a node's own
 * interfaces (card, router, bridge, tunnel), `overlay` a VXLAN tunnel between nodes, `interface` between related
 * siblings (a container mounting a volume), `virtual` a Service's or an Ingress's routing (to Services, pods' eth0,
 * from a LoadBalancer), `storage` Ceph to its disks and its pools to the claims they hold, `cable` a USB port to the
 * disk plugged into it, `ethernet` a network card to the switch and the switch to the router (cables drawn thick),
 * `resource` a container down to the CPU and memory of its node.
 */
export interface Link {
  kind: "network" | "lan" | "interface" | "internet" | "wire" | "overlay" | "virtual" | "storage" | "cable" | "ethernet" | "resource";
  layer: LinkLayer;
  /** The twin whose load the link carries (network, internet), or the relationship's source. */
  id: string;
  /** The relationship's target (wire, overlay, virtual, interface). */
  to?: string;
  /** The container whose network it joins; the internet's links have their own. */
  parent: string;
  path: Vec[];
  /** A cable's radius, at the scale of the machines it plugs into (drawn as a solid tube). */
  radius?: number;
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

/** A machine's board: a thin plate under its hardware deck (no twin of its own). */
export interface Board {
  /** The machine it belongs to. */
  id: string;
  center: Vec;
  size: Vec;
}

export interface Scene {
  /** Every node's solid, outermost first. */
  boxes: Box[];
  links: Link[];
  boards: Board[];
  internet: Internet[];
  /** Everything together, to fit the camera. */
  bounds: { center: Vec; size: Vec };
}

/** What the layout asks of the twin: kinds of solids, which twins have a network, and the relationships to draw. */
export interface LayoutRules {
  networked: (node: TwinView) => boolean;
  storage: (node: TwinView) => boolean;
  /** A solid of its own shape (a port, a Service, an Ingress); undefined for a box or a storage cylinder. */
  shape?: (node: TwinView) => Shape | undefined;
  /** A network interface's kind (physical, router, bridge, tunnel, veth, loadbalancer, public). */
  portKind?: (node: TwinView) => string;
  /** A twin that shares its container's network (a container in its pod): wired to the container's own interface. */
  sharesNetwork?: (node: TwinView) => boolean;
  /** Related siblings, as id pairs. */
  interfaces: [string, string][];
  /** Interfaces connected to each other (connectedTo). */
  wires?: [string, string][];
  /** Routing between twins anywhere (routesTo, exposes, servedBy). */
  virtual?: [string, string][];
  /** Storage relations between twins anywhere (Ceph hasOsd, a pool holds a claim). */
  storageLinks?: [string, string][];
  /** A machine's part (CPU, memory, a disk): on the deck at its floor, under its workloads. */
  hardware?: (node: TwinView) => boolean;
  /** What runs on what (a container on its node's CPU and memory). */
  resources?: [string, string][];
  /** A port to what is plugged into it (a USB disk). */
  cables?: [string, string][];
  /** A device of the LAN the machines are cabled to (a switch, a router, an access point); undefined for anything else. */
  device?: (node: TwinView) => "switch" | "router" | "ap" | undefined;
}

/** What a node's own layout measured: its size, with solids and links relative to its floor center. */
interface Measured {
  size: Vec;
  boxes: Box[];
  links: Link[];
  /** Where its own interface is (a pod's eth0), for the link that reaches it. */
  port?: Vec;
  /** Its interfaces that belong outside it (public addresses: on the globe). */
  outside?: TwinView[];
  /** The boards under hardware decks inside it. */
  boards?: Board[];
  /** Its router's WAN port, which the internet's line reaches. */
  wan?: Vec;
  /** The WAN's cable radius, at the machines' scale (the internet's line is drawn a solid tube). */
  wanRadius?: number;
}

/** The space between siblings: wide between the outer shells (nodes), tight between the innermost (containers). */
const gapAt = (depth: number) => Math.max(0.5, 4 / 2.4 ** depth);
/** The margin of a shell around what it holds, on every side: children float inside it, never touching it. */
const padAt = (depth: number) => gapAt(depth) * 0.55 + 0.45;
/** How round a box's edges are: a little, more for the big shells, never more than a fifth of its least side. */
const roundness = (size: Vec) => Math.min(Math.min(...size) * 0.2, Math.min(...size) * 0.06 + 0.1, 1.2);
/** A port: a small plate standing out of a wall; a bridge a wider bar, a router a bigger disc. */
const PORT: Vec = [0.55, 0.55, 0.16];
const portSize = (kind: string): Vec =>
  kind === "bridge" ? [1.2, 0.5, 0.16]
  : kind === "router" ? [0.75, 0.75, 0.16]
  : kind === "loadbalancer" ? [1.3, 1.3, 0.3]
  : kind === "usb" ? [0.5, 0.22, 0.16]
  : kind === "physical" ? [0.6, 0.5, 0.2]
  : PORT;
/** The space between two ports side by side on a wall. */
const PORT_GAP = 0.6;
/** How far a line leaves a surface before it turns. */
const STUB = 0.3;

type Axis = 0 | 1 | 2;
/**
 * An orthogonal path through `points`: between each two, a segment along each axis in `order` (x, then z, then y by
 * default) — right angles only. Repeated points are dropped.
 */
export function orthogonal(points: Vec[], order: Axis[] = [0, 2, 1]): Vec[] {
  const out: Vec[] = [points[0]!];
  for (const q of points.slice(1)) {
    let cur = out.at(-1)!;
    for (const axis of order) {
      if (Math.abs(cur[axis] - q[axis]) < 1e-6) continue;
      cur = [...cur] as Vec;
      cur[axis] = q[axis];
      out.push(cur);
    }
  }
  // Collinear corners merged: a straight run is one segment.
  return out.filter((p, i) => {
    const a = out[i - 1];
    const b = out[i + 1];
    if (!a || !b) return true;
    const same = (k: number) => Math.abs(a[k]! - p[k]!) < 1e-6 && Math.abs(p[k]! - b[k]!) < 1e-6;
    return [0, 1, 2].filter(same).length < 2;
  });
}

/** A leaf's size by its shape: a small cube (or cylinder) at the bottom of the tree, a bigger one higher up. */
function leafOf(node: TwinView, shape: Shape): Vec {
  // A machine's parts by what they are: a core a tile, memory a module standing up, a CPU a flat chip, an NVMe disk a
  // stick, a SATA or USB disk a 2.5" drive.
  if (node.look === "core") return [0.62, 0.24, 0.62];
  if (node.look === "memory") return [2.4, 1, 0.34];
  if (node.look === "cpu") return [1.8, 0.4, 1.8];
  if (node.look === "drive") return node.twin.bus === "nvme" ? [0.8, 0.16, 2.2] : node.twin.internal === true ? [1.6, 0.4, 2.2] : [1.7, 0.55, 2.4];
  if (shape === "port") return PORT;
  if (shape === "hex") return [1.4, 0.8, 1.4];
  if (shape === "gate") return [2.4, 2, 0.7];
  if (shape === "drum") return [2.6, 1.6, 2.6];
  if (shape === "cylinder") return node.depth >= 3 ? [1.2, 1.2, 1.2] : [2, 2, 2];
  return node.depth >= 3 ? [1, 1, 1] : node.depth === 2 ? [1.6, 1.6, 1.6] : [3, 3, 3];
}

const shift = (v: Vec, by: Vec): Vec => [v[0] + by[0], v[1] + by[1], v[2] + by[2]];

/** A solid placed in its container: its floor center and its size. */
interface Placed {
  at: Vec;
  size: Vec;
  shape: Shape;
}

/** A placed solid's top center, where lines between solids anywhere start and end (they run over the top). */
const topOf = (p: Placed): Vec => [p.at[0], p.at[1] + p.size[1], p.at[2]];
/** A placed solid's back wall (−z) at its middle: where its container's network reaches it. */
const backOf = (p: Placed): Vec => [p.at[0], p.at[1] + p.size[1] / 2, p.at[2] - p.size[2] / 2];

const shapeOf = (node: TwinView, rules: LayoutRules): Shape => rules.shape?.(node) ?? (rules.storage(node) && !node.children.length ? "cylinder" : "box");
const isPort = (node: TwinView, rules: LayoutRules) => rules.shape?.(node) === "port";
/** Where a container's own interfaces go on its back wall, left to right: card, router, bridge (the hub), tunnel, the rest. */
const PORT_ORDER = ["physical", "usb", "router", "bridge", "tunnel", "loadbalancer", "veth", "wifi"];
/** How wide a row of ports is on a wall. */
const portsWidth = (ports: TwinView[], rules: LayoutRules) => ports.reduce((n, p) => n + portSize(rules.portKind?.(p) ?? "veth")[0] + PORT_GAP, 0);

/**
 * A container's interfaces on its back wall at height `y`: the hub — the bridge where there is one, else the router —
 * at `hub` (where its children's links start), the others beside it in a row. Returns where each went.
 */
function mountPorts(ports: TwinView[], hub: Vec, rules: LayoutRules, boxes: Box[], sizeOf?: (p: TwinView) => Vec | undefined): Map<string, Vec> {
  const at = new Map<string, Vec>();
  const kind = (p: TwinView) => rules.portKind?.(p) ?? "veth";
  const sorted = [...ports].sort((a, b) => PORT_ORDER.indexOf(kind(a)) - PORT_ORDER.indexOf(kind(b)) || a.name.localeCompare(b.name));
  const bridge = sorted.findIndex((p) => kind(p) === "bridge");
  const router = sorted.findIndex((p) => kind(p) === "router");
  const center = bridge >= 0 ? bridge : router;
  // Each port's x from the row's left end; the hub's lands on `hub`.
  const xs: number[] = [];
  let x = 0;
  for (const p of sorted) {
    const w = (sizeOf?.(p) ?? portSize(kind(p)))[0];
    xs.push(x + w / 2);
    x += w + PORT_GAP;
  }
  const origin = center >= 0 ? xs[center]! : (x - PORT_GAP) / 2;
  sorted.forEach((p, i) => {
    const c: Vec = [hub[0] + xs[i]! - origin, hub[1], hub[2]];
    boxes.push({ id: p.id, shape: "port", center: c, size: sizeOf?.(p) ?? portSize(kind(p)), radius: 0.08, normal: [0, 0, -1] });
    at.set(p.id, c);
  });
  return at;
}

/** Children laid out: their footprint, and each one's floor center relative to the footprint's center. */
interface Arranged {
  inner: Vec;
  placed: { node: TwinView; m: Measured; at: Vec }[];
}

/** How far a box is from a cube: its longest side over its shortest (1 is a cube). */
const aspect = (v: Vec) => Math.max(...v) / Math.max(0.01, Math.min(...v));

/**
 * The cube-most grid for `n` cells of size `cell` with `gap` between them: columns (x), rows (z) and layers (y),
 * filled a layer at a time from the floor up, so only the top layer can be short.
 */
function cubeGrid(n: number, cell: Vec, gap: number): { cols: number; rows: number; layers: number; size: Vec } {
  let best: { cols: number; rows: number; layers: number; size: Vec; score: number } | undefined;
  const extent = (k: number, c: number) => k * (c + gap) - gap;
  for (let layers = 1; layers <= n; layers++) {
    const perLayer = Math.ceil(n / layers);
    if (layers > 1 && perLayer * (layers - 1) >= n) break; // an empty layer
    for (let cols = 1; cols <= perLayer; cols++) {
      const rows = Math.ceil(perLayer / cols);
      if (cols > 1 && (cols - 1) * rows >= perLayer) continue; // an empty column
      const size: Vec = [extent(cols, cell[0]), extent(layers, cell[1]), extent(rows, cell[2])];
      // As near a cube as can be; of equals, the lower one (fewer layers) and the one with fewer empty cells.
      const score = aspect(size) + layers * 0.01 + (cols * rows * layers - n) * 0.02;
      if (!best || score < best.score) best = { cols, rows, layers, size, score };
    }
  }
  return best!;
}

/**
 * Children grouped by model (siblings of a kind together), each group a cube-like grid of uniform cells with `gap`
 * between them — columns, rows and layers stacked from the floor; short rows centered. The groups go side by side,
 * one behind another or one on top of another, whichever keeps the whole nearest a cube.
 */
function arrange(children: { node: TwinView; m: Measured }[], gap: number): Arranged {
  if (!children.length) return { inner: [0, 0, 0], placed: [] };
  const groups = new Map<string, { node: TwinView; m: Measured }[]>();
  for (const c of children) (groups.get(c.node.model) ?? groups.set(c.node.model, []).get(c.node.model)!).push(c);
  const grids = [...groups.values()]
    .sort((a, b) => b.length - a.length)
    .map((items) => {
      const cell: Vec = [0, 1, 2].map((i) => Math.max(...items.map((x) => x.m.size[i]!))) as Vec;
      return { items, cell, ...cubeGrid(items.length, cell, gap) };
    });
  // The axis the groups line up along: the one that leaves the whole most like a cube.
  const total = (axis: number): Vec =>
    [0, 1, 2].map((i) => (i === axis ? grids.reduce((n, g) => n + g.size[i]!, 0) + gap * (grids.length - 1) : Math.max(...grids.map((g) => g.size[i]!)))) as Vec;
  const axis = [2, 0, 1].reduce((a, b) => (aspect(total(b)) < aspect(total(a)) - 1e-9 ? b : a));
  const inner = total(axis);
  const placed: Arranged["placed"] = [];
  let along = axis === 1 ? 0 : -inner[axis]! / 2;
  for (const g of grids) {
    // The group's own origin: its floor center.
    const origin: Vec = [0, 0, 0];
    if (axis === 1) origin[1] = along;
    else origin[axis] = along + g.size[axis]! / 2;
    const perLayer = g.cols * g.rows;
    g.items.forEach((item, i) => {
      const layer = Math.floor(i / perLayer);
      const k = i % perLayer;
      const col = k % g.cols;
      const row = Math.floor(k / g.cols);
      const inLayer = Math.min(perLayer, g.items.length - layer * perLayer);
      const rowsHere = Math.ceil(inLayer / g.cols);
      const inRow = row === rowsHere - 1 ? inLayer - row * g.cols : g.cols;
      const rowW = (g.cell[0] + gap) * inRow - gap;
      const layerD = (g.cell[2] + gap) * rowsHere - gap;
      placed.push({
        ...item,
        at: [
          origin[0] - rowW / 2 + g.cell[0] / 2 + col * (g.cell[0] + gap),
          origin[1] + layer * (g.cell[1] + gap),
          origin[2] - layerD / 2 + g.cell[2] / 2 + row * (g.cell[2] + gap),
        ],
      });
    });
    along += g.size[axis]! + gap;
  }
  return { inner, placed };
}

/** Puts a measured child's solids and links at `at` (its floor center) and remembers where it is and its port. */
function place(child: TwinView, m: Measured, at: Vec, boxes: Box[], links: Link[], placed: Map<string, Placed & { port?: Vec }>, boards?: Board[]) {
  for (const b of m.boxes) boxes.push({ ...b, center: shift(b.center, at) });
  for (const l of m.links) links.push({ ...l, path: l.path.map((p) => shift(p, at)) });
  if (boards) for (const b of m.boards ?? []) boards.push({ ...b, center: shift(b.center, at) });
  placed.set(child.id, { at, size: m.size, shape: m.boxes[0]!.shape, port: m.port && shift(m.port, at) });
}

/**
 * A network link, at right angles: out of the hub into the container, along its back in a tray under its children's
 * floor, forward under the child to just behind it, up, and into the child's interface (its port, else its back wall).
 * `stub` is how far behind the child it rises (less than the gap between rows).
 */
function networkLink(id: string, parent: string, hub: Vec, p: Placed & { port?: Vec }, stub: number): Link {
  const end = p.port ?? backOf(p);
  const s = Math.min(STUB, stub);
  return {
    kind: "network",
    layer: "network",
    id,
    parent,
    path: orthogonal([hub, [hub[0], hub[1], hub[2] + s], [end[0], hub[1], end[2] - s], [end[0], end[1], end[2] - s], end]),
  };
}

/**
 * A line over the top: up from the start's top (or out of its port along `na`), along at `lane`, x then z, and down
 * onto the end's top (or into its port against `nb`).
 */
function overTop(a: Vec, b: Vec, lane: number, na: Vec = [0, 1, 0], nb: Vec = [0, 1, 0]): Vec[] {
  const a1: Vec = [a[0] + na[0] * STUB, a[1] + na[1] * STUB, a[2] + na[2] * STUB];
  const b1: Vec = [b[0] + nb[0] * STUB, b[1] + nb[1] * STUB, b[2] + nb[2] * STUB];
  const y = Math.max(lane, a1[1], b1[1]);
  return orthogonal([a, a1, [a1[0], y, a1[2]], [b1[0], y, b1[2]], b1, b], [0, 2, 1]);
}

/**
 * Measures one node: its children grouped by model, each group a near-square grid of uniform cells with gaps between
 * them, all floating inside the node's own solid with a margin on every side — shells within shells. Its network
 * interfaces are ports on its back wall (a pod's eth0, a node's card, router and tunnel), not cells; networked
 * children get a link from the router (the hub) to their own port; related children a link wall to wall.
 */
function measure(node: TwinView, rules: LayoutRules): Measured {
  if (isBanded(node)) return measureBanded(node, rules);
  const shape = shapeOf(node, rules);
  const ports = node.children.filter((c) => isPort(c, rules));
  const inner = node.children.filter((c) => !isPort(c, rules));
  if (node.look === "cpu" && inner.length) return measureChip(node, inner, rules);
  if (node.look === "drive" && inner.length) return measureDrive(node, inner, rules, shape);
  if (!inner.length) {
    const size = leafOf(node, shape);
    const boxes: Box[] = [{ id: node.id, shape, center: [0, size[1] / 2, 0], size, radius: shape === "port" ? 0.08 : roundness(size) }];
    // A leaf's interface (a pod without containers): on its back wall.
    let own: Vec | undefined;
    if (ports.length) own = mountPorts(ports, [0, size[1] / 2, -size[2] / 2], rules, boxes).values().next().value;
    return { size, boxes, links: [], port: own };
  }
  const gap = gapAt(node.depth);
  const pad = padAt(node.depth);
  const { inner: footprint, placed: items } = arrange(inner.map((child) => ({ node: child, m: measure(child, rules) })), gap);
  // A drum is round: its footprint's diagonal fits inside.
  const round = shape === "drum" ? Math.hypot(footprint[0], footprint[2]) + 2 * pad : 0;
  const size: Vec = round ? [round, footprint[1] + 2 * pad, round] : [Math.max(footprint[0] + 2 * pad, portsWidth(ports, rules) + 2 * pad), footprint[1] + 2 * pad, footprint[2] + 2 * pad];

  const boxes: Box[] = [{ id: node.id, shape, center: [0, size[1] / 2, 0], size, radius: roundness(size) }];
  const links: Link[] = [];
  const boards: Board[] = [];
  const placed = new Map<string, Placed & { port?: Vec }>();
  // The hub: the node's router on its back wall, halfway between its floor and its children's.
  const hub: Vec = [0, pad * 0.5, -size[2] / 2];
  // A pod's eth0 sits higher, in the middle of its back wall: the end of the link from its node's router.
  const mounted = ports.length ? mountPorts(ports, rules.networked(node) ? [0, size[1] / 2, -size[2] / 2] : hub, rules, boxes) : new Map<string, Vec>();
  const own = rules.networked(node) ? mounted.values().next().value : undefined;
  for (const { node: child, m, at: rel } of items) {
    place(child, m, [rel[0], pad + rel[1], rel[2]], boxes, links, placed, boards);
    const p = placed.get(child.id)!;
    if (rules.networked(child)) links.push(networkLink(child.id, node.id, hub, p, gap * 0.45));
    // A pod's containers share its eth0: from it into the pod, along, up and into each one's back.
    else if (own && rules.sharesNetwork?.(child)) {
      const end = backOf(p);
      const s = Math.min(STUB, gap * 0.45);
      links.push({ kind: "lan", layer: "network", id: child.id, to: [...mounted.keys()][0], parent: node.id, path: orthogonal([own, [own[0], own[1], own[2] + s], [end[0], end[1], end[2] - s], end], [0, 1, 2]) });
    }
  }
  addInterfaces(rules, placed, links, node.id, pad);
  return { size, boxes, links, port: own, boards };
}

/** A CPU: a flat chip with its cores as tiles in a square grid on it. */
function measureChip(node: TwinView, cores: TwinView[], rules: LayoutRules): Measured {
  const cell = leafOf(cores[0]!, shapeOf(cores[0]!, rules));
  const gap = 0.14;
  const pad = 0.3;
  const cols = Math.ceil(Math.sqrt(cores.length));
  const rows = Math.ceil(cores.length / cols);
  const size: Vec = [cols * (cell[0] + gap) - gap + 2 * pad, cell[1] + 0.2, rows * (cell[2] + gap) - gap + 2 * pad];
  const boxes: Box[] = [{ id: node.id, shape: "box", center: [0, size[1] / 2, 0], size, radius: 0.08 }];
  cores.forEach((core, i) => {
    const x = -size[0] / 2 + pad + (i % cols) * (cell[0] + gap) + cell[0] / 2;
    const z = -size[2] / 2 + pad + Math.floor(i / cols) * (cell[2] + gap) + cell[2] / 2;
    boxes.push({ id: core.id, shape: "box", center: [x, 0.1 + cell[1] / 2, z], size: cell, radius: 0.05 });
  });
  return { size, boxes, links: [] };
}

/** A disk with what stores on it (a Ceph OSD): the drive, and its contents standing on top of it. */
function measureDrive(node: TwinView, inner: TwinView[], rules: LayoutRules, shape: Shape): Measured {
  const base = leafOf(node, shape);
  const { inner: footprint, placed: items } = arrange(inner.map((child) => ({ node: child, m: measure(child, rules) })), 0.3);
  const size: Vec = [Math.max(base[0], footprint[0] + 0.3), base[1], Math.max(base[2], footprint[2] + 0.3)];
  const boxes: Box[] = [{ id: node.id, shape: "box", center: [0, size[1] / 2, 0], size, radius: Math.min(0.12, roundness(size)) }];
  const links: Link[] = [];
  const placed = new Map<string, Placed & { port?: Vec }>();
  const lift = size[1] + 0.06;
  for (const { node: child, m, at } of items) place(child, m, [at[0], lift + at[1], at[2]], boxes, links, placed);
  return { size: [size[0], lift + footprint[1], size[2]], boxes, links };
}

/** A machine's parts on its deck, each a share of the floor's width: the CPU the most, then the disks, then memory. */
const DECK_SHARE: Record<string, number> = { cpu: 0.42, drive: 0.32, memory: 0.26 };
/** How high each part stands: a CPU a flat chip, memory modules lying flat, an NVMe stick, a 2.5" drive. */
const partHeight = (node: TwinView) => (node.look === "cpu" ? 0.5 : node.look === "memory" ? 0.32 : node.twin.bus === "nvme" ? 0.26 : 0.42);
const DECK_GAP = 0.5;
/** A deck's least floor: its parts must still read as what they are. */
const DECK_MIN: [number, number] = [7, 4.5];

/** A part of a machine at a given size: a CPU with its cores as tiles covering it, a disk with its contents on top. */
function measurePart(node: TwinView, size: Vec, rules: LayoutRules): Measured {
  const [w, h, d] = size;
  const boxes: Box[] = [{ id: node.id, shape: "box", center: [0, h / 2, 0], size, radius: 0.08 }];
  const links: Link[] = [];
  const inner = node.children.filter((c) => !isPort(c, rules));
  if (!inner.length) return { size, boxes, links };
  if (node.look === "cpu") {
    // The cores in a grid of the chip's own proportions, tiles filling it.
    const pad = Math.min(w, d) * 0.07;
    const gap = 0.14;
    const cols = Math.max(1, Math.min(inner.length, Math.round(Math.sqrt((inner.length * w) / d))));
    const rows = Math.ceil(inner.length / cols);
    const tw = (w - 2 * pad - gap * (cols - 1)) / cols;
    const td = (d - 2 * pad - gap * (rows - 1)) / rows;
    const th = 0.24;
    inner.forEach((core, i) => {
      const x = -w / 2 + pad + (i % cols) * (tw + gap) + tw / 2;
      const z = -d / 2 + pad + Math.floor(i / cols) * (td + gap) + td / 2;
      boxes.push({ id: core.id, shape: "box", center: [x, h - th / 2 + 0.06, z], size: [tw, th, td], radius: 0.05 });
    });
    return { size: [w, h + 0.06, d], boxes, links };
  }
  // A disk's contents (an OSD) standing on it.
  const { inner: footprint, placed: items } = arrange(inner.map((child) => ({ node: child, m: measure(child, rules) })), 0.3);
  const placed = new Map<string, Placed & { port?: Vec }>();
  const lift = h + 0.06;
  for (const { node: child, m, at } of items) place(child, m, [at[0], lift + at[1], at[2]], boxes, links, placed);
  return { size: [w, lift + footprint[1], d], boxes, links };
}

/**
 * A machine's hardware deck covering its whole floor (`w` by `d`): the CPU, memory and internal disks side by side,
 * each a share of the width and the full depth (disks of a kind one behind another). Positions are part centers
 * relative to the deck's center.
 */
function layoutDeck(parts: TwinView[], w: number, d: number, rules: LayoutRules): { items: { node: TwinView; m: Measured; x: number; z: number }[]; height: number } {
  const kindOf = (v: TwinView) => (v.look === "cpu" || v.look === "memory" ? v.look : "drive");
  const groups = ["cpu", "memory", "drive"]
    .map((kind) => ({ kind, nodes: parts.filter((v) => kindOf(v) === kind).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter((g) => g.nodes.length);
  const total = groups.reduce((n, g) => n + DECK_SHARE[g.kind]!, 0);
  const free = w - DECK_GAP * Math.max(0, groups.length - 1);
  const items: { node: TwinView; m: Measured; x: number; z: number }[] = [];
  let x = -w / 2;
  for (const g of groups) {
    const gw = (free * DECK_SHARE[g.kind]!) / total;
    const cellD = (d - DECK_GAP * (g.nodes.length - 1)) / g.nodes.length;
    g.nodes.forEach((node, i) => {
      const m = measurePart(node, [gw, partHeight(node), cellD], rules);
      items.push({ node, m, x: x + gw / 2, z: -d / 2 + i * (cellD + DECK_GAP) + cellD / 2 });
    });
    x += gw + DECK_GAP;
  }
  return { items, height: Math.max(0, ...items.map((i) => i.m.size[1])) };
}

/** A physical disk in the storage cluster's array, lying flat (on its width): a USB disk (`usb-disk` preset —
 * the asset, its fill level, and the USB connector at its back, where the cable plugs in). The OSD is merged into
 * the disk twin. */
function measureArrayDisk(node: TwinView, size: Vec): Measured {
  return { size, boxes: [{ id: node.id, shape: "box", center: [0, size[1] / 2, 0], size, radius: Math.min(0.12, roundness(size)) }], links: [] };
}

/** A Ceph pool in the array's right column: a flat disc, stacked like the disks but round — the distinction from a
 * physical disk — with its fill level and no connector. */
function measureArrayPool(node: TwinView, cell: Vec): Measured {
  const size: Vec = [cell[0], cell[1], cell[0]];
  return { size, boxes: [{ id: node.id, shape: "cylinder", center: [0, size[1] / 2, 0], size, radius: size[0] / 2 }], links: [] };
}

/**
 * A storage cluster (Ceph) as a disk array of two columns: the physical disks in the left one, lying flat and
 * stacked on one another; the cluster's pools in the right one, flat discs stacked the same way.
 */
function measureArray(node: TwinView, disks: { node: TwinView; m: Measured }[], cell: Vec, rules: LayoutRules): Measured {
  const pad = padAt(node.depth);
  const gap = Math.max(gapAt(node.depth), 0.5);
  /** A column of cells stacked along y, each at its floor center relative to the column's center. */
  const colOf = (items: { node: TwinView; m: Measured }[]) => {
    const w = Math.max(0, ...items.map((x) => x.m.size[0]));
    const d = Math.max(1, ...items.map((x) => x.m.size[2]));
    const h = items.reduce((n, x) => n + x.m.size[1], 0) + gap * Math.max(0, items.length - 1);
    const placed: { node: TwinView; m: Measured; at: Vec }[] = [];
    let y = 0;
    for (const it of items) {
      placed.push({ ...it, at: [0, y, 0] }); // the floor center, from the column's floor up
      y += it.m.size[1] + gap;
    }
    return { w, d, h, placed };
  };
  const left = colOf(disks);
  const own = node.children.filter((c) => !isPort(c, rules)).map((c) => ({ node: c, m: measureArrayPool(c, cell) }));
  const right = colOf(own);
  const colGap = gap * 2;
  const size: Vec = [left.w + colGap + right.w + 2 * pad, Math.max(left.h, right.h) + 2 * pad, Math.max(left.d, right.d) + 2 * pad];
  const boxes: Box[] = [{ id: node.id, shape: "box", center: [0, size[1] / 2, 0], size, radius: roundness(size) }];
  const links: Link[] = [];
  const placed = new Map<string, Placed & { port?: Vec }>();
  const putCol = (col: ReturnType<typeof colOf>, x: number) => {
    for (const { node: child, m, at } of col.placed) place(child, m, [x, pad + at[1], 0], boxes, links, placed);
  };
  putCol(left, -(colGap + right.w) / 2);
  putCol(right, (colGap + left.w) / 2);
  return { size, boxes, links };
}

/** A twin whose contents' contents belong to bands (a cluster: its nodes' pods to namespaces). Not the firewall: its
 * ingresses belong to bands, yet it is one box on top, not a stack of machines. */
const isBanded = (node: TwinView) => node.look !== "firewall" && node.children.some((c) => c.band !== undefined || c.children.some((g) => g.band !== undefined));
/** A column of a banded container: a node, the firewall (a box as big as a machine, holding the cluster's whole
 * virtual network), or whatever holds things of the bands (a storage cluster is not one: it sits compactly with what
 * belongs to no band). */
const isColumn = (c: TwinView, rules: LayoutRules) =>
  c.band === undefined && !isPort(c, rules) && c.children.some((g) => !isPort(g, rules)) && (c.look === "node" || c.look === "firewall" || c.children.some((g) => g.band !== undefined));
/** The id of the band of `group` across `root` (scene.ts makes it the same way). */
export const bandId = (root: string, group: string) => `${root}~${group}`;
/** The machines from the top of the stack down: the firewall (the virtual network) on top, then the control planes,
 * then the workers, each by name. */
const stackOrder = (a: TwinView, b: TwinView) => (a.look === "firewall" ? -1 : a.twin.role === "control-plane" ? 0 : 1) - (b.look === "firewall" ? -1 : b.twin.role === "control-plane" ? 0 : 1) || a.name.localeCompare(b.name);
/**
 * Real sizes in millimetres, drawn at the machines' own scale (a mini PC is 175 mm deep): an Ethernet port (RJ45) and
 * a USB-A port as they face out of a wall (width, height, how far they stand out), a 2.5" USB disk lying flat, a
 * desktop switch (20 mm per port) and a home router, a router's antennas, and the cables' radius.
 */
const MM = { machine: 175, rj45: [16, 13.5, 4] as Vec, usb: [12, 4.5, 3] as Vec, disk: [120, 15, 80] as Vec, switchPort: 20, switch: [26, 70], router: [230, 35, 144] as Vec, ap: [180, 26, 180] as Vec, antenna: 150, usbCable: 2.2, lanCable: 3 };
const mm = (v: Vec, u: number): Vec => [v[0] * u, v[1] * u, v[2] * u];
/** A LAN device's solid at `u` scene units per millimetre: a switch as wide as its ports need, a router, an access point. */
const deviceSize = (device: TwinView, rules: LayoutRules, u: number): Vec =>
  rules.device?.(device) === "switch"
    ? [Math.max(100, device.children.filter((p) => isPort(p, rules)).length * MM.switchPort + 20) * u, MM.switch[0]! * u, MM.switch[1]! * u]
    : rules.device?.(device) === "ap"
      ? mm(MM.ap, u)
      : mm(MM.router, u);

/**
 * A container laid out in bands, its machines lying flat one on top of another like mini PCs on a shelf — the
 * control planes at the top, the workers below. Every machine has the same floor plan: its hardware covers its floor
 * (CPU, memory, internal disks side by side), and above it the bands (namespaces), each in the same place on every
 * machine, so one dashed solid around a band takes in all of it through the machines' floors. The floor plan is
 * kept as near a square as the bands allow. What belongs to no machine (a pod no node runs yet, Services, the
 * firewall with the Ingresses) floats above the stack on the same plan. The storage cluster stands beside the stack
 * as a disk array (`measureArray`): each machine's USB disks in its bottom row, cabled to the USB ports on the
 * machines' sides; its network card (RJ45) on its back wall is cabled to the switch behind the stack, the switch to
 * the router beside it, whose WAN port's Ethernet cable reaches the internet. The container's own interfaces
 * (LoadBalancers) are on its back wall; public addresses and external services are left for the globe.
 */
function measureBanded(node: TwinView, rules: LayoutRules): Measured {
  const pad = padAt(node.depth);
  const colPad = padAt(node.depth + 1);
  const colGap = gapAt(node.depth);
  // A band's margin inside the machines', and the space between bands.
  const bandPad = colPad * 0.5;
  const rowGap = Math.max(gapAt(node.depth + 1), 2 * bandPad + 0.5);
  const itemGap = gapAt(node.depth + 2);

  const ownPorts = node.children.filter((c) => isPort(c, rules));
  const devices = node.children.filter((c) => !!rules.device?.(c));
  const columns = node.children.filter((c) => !devices.includes(c) && isColumn(c, rules)).sort(stackOrder);
  // A storage cluster of its own (Ceph) stands outside, beside the machines' USB disks it stores on.
  const stores = node.children.filter((c) => c.look === "ceph" && !columns.includes(c) && !devices.includes(c));
  const loose = node.children.filter((c) => !columns.includes(c) && !devices.includes(c) && !stores.includes(c) && !isPort(c, rules));
  const keyOf = (v: TwinView) => v.band ?? "";
  const isPart = (v: TwinView) => !!rules.hardware?.(v);
  const isExternal = (v: TwinView) => isPart(v) && v.look === "drive" && v.twin.internal === false;
  const contents = (holder: TwinView) => holder.children.filter((v) => !isPort(v, rules) && !isPart(v));
  const kind = (p: TwinView) => rules.portKind?.(p) ?? "veth";
  const backPorts = (h: TwinView) => h.children.filter((v) => isPort(v, rules) && kind(v) !== "usb");
  const usbPorts = (h: TwinView) => h.children.filter((v) => isPort(v, rules) && kind(v) === "usb").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const rows = [...new Set([...columns.flatMap((c) => contents(c).map(keyOf)), ...loose.map(keyOf)])].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  // Each cell's contents (a machine's, or the loose level's, of a band), arranged.
  const holders: (TwinView | undefined)[] = [...columns, ...(loose.length ? [undefined] : [])];
  const cells = holders.map((holder) =>
    rows.map((row) => arrange((holder ? contents(holder) : loose).filter((v) => keyOf(v) === row).map((v) => ({ node: v, m: measure(v, rules) })), itemGap)),
  );
  const bandW = rows.map((_, r) => Math.max(1, ...cells.map((col) => col[r]!.inner[0])));
  const bandD = rows.map((_, r) => Math.max(1, ...cells.map((col) => col[r]!.inner[2])));
  const cellH = holders.map((_, c) => Math.max(0, ...cells[c]!.map((cell) => cell.inner[1])));


  // The floor plan: the bands in columns along x, those of a column one behind another, as many columns as keep the
  // floor nearest a square.
  const minW = Math.max(DECK_MIN[0], ...columns.map((h) => portsWidth(backPorts(h), rules) + 1));
  const minD = DECK_MIN[1];
  const planOf = (k: number) => {
    const per = Math.ceil(rows.length / k);
    const groups = Array.from({ length: k }, (_, i) => rows.map((_, r) => r).slice(i * per, (i + 1) * per)).filter((g) => g.length);
    const widths = groups.map((g) => Math.max(...g.map((r) => bandW[r]!)));
    const depths = groups.map((g) => g.reduce((n, r) => n + bandD[r]!, 0) + rowGap * (g.length - 1));
    const used = widths.reduce((n, x) => n + x, 0) + rowGap * Math.max(0, groups.length - 1);
    return { groups, widths, depths, used, w: Math.max(minW, used), d: Math.max(minD, ...depths) };
  };
  const squareness = (p: { w: number; d: number }) => Math.max(p.w, p.d) / Math.min(p.w, p.d);
  let plan = planOf(1);
  for (let k = 2; k <= rows.length; k++) {
    const next = planOf(k);
    if (squareness(next) < squareness(plan) - 1e-9) plan = next;
  }
  // Every machine alike: the deck covering its floor (nearly to its walls), the bands above it. A mini PC lies flat:
  // its floor at least FLAT times as wide and as deep as it is high.
  const FLAT = 2.6;
  const partsOf = (h: TwinView) => h.children.filter((v) => isPart(v) && !isExternal(v));
  const deckOf = (w: number, d: number) => columns.map((h) => layoutDeck(partsOf(h), w + colPad, d + colPad, rules));
  let decks = deckOf(plan.w, plan.d);
  const deckH = Math.max(0, ...decks.map((d) => d.height));
  const deckRise = deckH ? deckH + Math.max(gapAt(node.depth + 1), 0.8) : 0;
  const contentH = Math.max(1, ...columns.map((_, c) => cellH[c]!));
  const slabH = colPad + deckRise + contentH + colPad;
  const W = Math.max(plan.w, FLAT * slabH - 2 * colPad);
  const D = Math.max(plan.d, FLAT * slabH - 2 * colPad);
  if (W !== plan.w || D !== plan.d) decks = deckOf(W, D);
  const bandX: number[] = [];
  const bandZ: number[] = [];
  const bandSpan: number[] = [];
  {
    let x = (W - plan.used) / 2;
    plan.groups.forEach((g, i) => {
      let z = (D - plan.depths[i]!) / 2;
      for (const r of g) {
        bandX[r] = x;
        bandZ[r] = z;
        bandSpan[r] = plan.widths[i]!;
        z += bandD[r]! + rowGap;
      }
      x += plan.widths[i]! + rowGap;
    });
  }

  const slab: Vec = [W + 2 * colPad, slabH, D + 2 * colPad];
  // Everything plugged into the machines at their scale: scene units per millimetre.
  const u = slab[2] / MM.machine;
  const rj45 = mm(MM.rj45, u);
  const usb = mm(MM.usb, u);
  // The USB disks beside each machine, one behind another, smaller where more than fit along its side.
  const USB_GAP = 12 * u;
  // In the storage cluster's array the disks lie flat (on their width), stacked in the left column; on a shelf
  // beside the machines they lie flat too.
  const arrayCell = mm(MM.disk, u);
  const disksOf = columns.map((h) => {
    const disks = h.children.filter(isExternal).sort((a, b) => a.name.localeCompare(b.name));
    const base = mm(MM.disk, u);
    if (stores.length) return disks.map((v) => ({ node: v, m: measureArrayDisk(v, arrayCell) }));
    const fit = Math.min(1, (D - USB_GAP * Math.max(0, disks.length - 1)) / Math.max(1e-9, disks.length * base[2]));
    return disks.map((v) => ({ node: v, m: measurePart(v, mm(base, fit), rules) }));
  });
  // With a storage cluster, the USB disks stand in its array (its bottom row), not on a shelf beside the machines.
  const shelfW = stores.length ? 0 : Math.max(0, ...disksOf.flatMap((ds) => ds.map((x) => x.m.size[0])));
  const looseH = loose.length ? Math.max(1, cellH[holders.length - 1]!) : 0;

  // The LAN behind the stack: the switch and the router side by side, on the floor.
  const devSizes = devices.map((v) => deviceSize(v, rules, u));
  const devGap = 40 * u;
  const lanD = devices.length ? Math.max(...devSizes.map((s) => s[2])) : 0;
  const lanGap = devices.length ? Math.max(2.4, 60 * u) : 0;
  const devW = devSizes.reduce((n, s) => n + s[0], 0) + devGap * Math.max(0, devices.length - 1);

  // The container's own solid holds only the machines (and what of it belongs to no machine, above them); the USB
  // disks, the storage cluster and the LAN's devices stand outside it: the disks and the storage beside it, the
  // switch and the router behind it.
  const clusterW = Math.max(pad + slab[0] + pad, portsWidth(ownPorts, rules) + PORT[0] + PORT_GAP + 2 * pad);
  const stackH = columns.length * slab[1] + Math.max(0, columns.length - 1) * colGap + (loose.length ? (columns.length ? colGap : 0) + looseH : 0);
  const clusterH = pad + Math.max(stackH, 1) + pad;
  const zC = lanD + lanGap;
  const clusterD = pad + slab[2] + pad;
  const outGap = Math.max(2.4, 40 * u);
  const shelfX = clusterW + (shelfW ? outGap : 0);
  // A storage cluster is measured as a disk array: the physical USB disks in its bottom row, its pools above.
  const storeMs = stores.map((v) => ({ node: v, m: v.look === "ceph" ? measureArray(v, disksOf.flat(), arrayCell, rules) : measure(v, rules) }));
  const storeX = (shelfW ? shelfX + shelfW : clusterW) + outGap;
  const storesW = storeMs.reduce((n, x) => n + x.m.size[0], 0) + outGap * Math.max(0, storeMs.length - 1);
  const width = Math.max(clusterW, shelfW ? shelfX + shelfW : 0, storeMs.length ? storeX + storesW : 0, devW);
  const slabZ = zC + pad;
  const depth = zC + clusterD;
  const height = Math.max(clusterH, devices.length ? Math.max(...devSizes.map((s) => s[1])) + MM.antenna * u : 0, ...storeMs.map((x) => x.m.size[1]));
  const cx = width / 2;
  const cz = depth / 2;
  const at = (px: number, py: number, pz: number): Vec => [px - cx, py, pz - cz];
  // Where each holder's floor and its contents' floor are (the top machine first; the loose level above them all).
  const floorY = holders.map((holder, c) => (holder ? pad + (columns.length - 1 - c) * (slab[1] + colGap) : pad + columns.length * (slab[1] + colGap)));
  const contentY = holders.map((holder, c) => (holder ? floorY[c]! + colPad + deckRise : floorY[c]!));
  const ix = pad + colPad;
  const iz = slabZ + colPad;

  const clusterSize: Vec = [clusterW, clusterH, clusterD];
  const boxes: Box[] = [{ id: node.id, shape: shapeOf(node, rules), center: at(clusterW / 2, clusterH / 2, zC + clusterD / 2), size: clusterSize, radius: roundness(clusterSize) }];
  const links: Link[] = [];
  const boards: Board[] = [];
  const placed = new Map<string, Placed & { port?: Vec }>();
  const hub: Vec = at(clusterW / 2, pad * 0.5, zC);
  let storeAt = storeX;
  for (const { node: store, m } of storeMs) {
    place(store, m, at(storeAt + m.size[0] / 2, 0, zC + clusterD / 2), boxes, links, placed, boards);
    storeAt += m.size[0] + outGap;
  }
  // The container's own interfaces (LoadBalancers) on its back wall, beside the hub; public addresses and external
  // services go outside, onto the internet's globe.
  const outside = ownPorts.filter((p) => kind(p) === "public" || kind(p) === "external");
  mountPorts(ownPorts.filter((p) => !outside.includes(p)), [hub[0] + PORT[0] + 0.6, hub[1], hub[2]], rules, boxes);

  // The LAN's devices and their ports: the switch's on its front (toward the machines), the router's LAN port on
  // its front and its WAN port on its back (toward the internet).
  const portAt = new Map<string, Vec>();
  let wan: Vec | undefined;
  {
    let x = Math.max(0, (clusterW - devW) / 2);
    devices.forEach((device, i) => {
      const size = devSizes[i]!;
      const front = lanD;
      const center = at(x + size[0] / 2, size[1] / 2, front - size[2] / 2);
      boxes.push({ id: device.id, shape: "box", center, size, radius: 0.1 });
      placed.set(device.id, { at: [center[0], 0, center[2]], size, shape: "box" });
      const ports = device.children.filter((p) => isPort(p, rules)).sort((a, b) => (a.name === "uplink" ? -1 : b.name === "uplink" ? 1 : a.name.localeCompare(b.name, undefined, { numeric: true })));
      const ahead = ports.filter((p) => p.name !== "wan");
      const step = MM.switchPort * u;
      ahead.forEach((p, k) => {
        const c: Vec = [center[0] + (k - (ahead.length - 1) / 2) * step, center[1], center[2] + size[2] / 2];
        boxes.push({ id: p.id, shape: "port", center: c, size: rj45, radius: 0.04, normal: [0, 0, 1] });
        portAt.set(p.id, c);
      });
      for (const p of ports.filter((p) => p.name === "wan")) {
        const c: Vec = [center[0], center[1], center[2] - size[2] / 2];
        boxes.push({ id: p.id, shape: "port", center: c, size: rj45, radius: 0.04, normal: [0, 0, -1] });
        portAt.set(p.id, c);
        wan = c;
      }
      x += size[0] + devGap;
    });
  }

  let cable = 0;
  holders.forEach((holder, c) => {
    // The machine's own solid, with its interfaces on its back wall: its router is its hub, its card cabled to the
    // switch (or, without one, the container's hub to it).
    let colHub: Vec | undefined;
    if (holder) {
      const floor = at(pad + slab[0] / 2, floorY[c]!, slabZ + slab[2] / 2);
      boxes.push({ id: holder.id, shape: shapeOf(holder, rules), center: [floor[0], floor[1] + slab[1] / 2, floor[2]], size: slab, radius: Math.min(0.5, roundness(slab)) });
      colHub = at(pad + slab[0] / 2, floorY[c]! + Math.max(colPad * 0.5, rj45[1] / 2 + 0.2), slabZ);
      const mounted = mountPorts(backPorts(holder), colHub, rules, boxes, (p) => (kind(p) === "physical" ? rj45 : undefined));
      const card = holder.children.find((v) => isPort(v, rules) && kind(v) === "physical");
      placed.set(holder.id, { at: floor, size: slab, shape: "box", port: card && mounted.get(card.id) });
      const cardAt = card && mounted.get(card.id);
      const plug = card && rules.wires?.find(([a, b]) => (a === card.id && portAt.has(b)) || (b === card.id && portAt.has(a)));
      if (cardAt && plug) {
        // Out of the back wall, along to above (or below) its port on the switch, down and into it: each cable its own
        // lane behind the stack.
        const to = plug[0] === card.id ? plug[1] : plug[0];
        const end = portAt.get(to)!;
        const lane = end[2] + 14 * u + 9 * u * cable++;
        links.push({ kind: "ethernet", layer: "hardware", id: holder.id, to, parent: node.id, radius: MM.lanCable * u, path: orthogonal([cardAt, [cardAt[0], cardAt[1], lane], [end[0], cardAt[1], lane], [end[0], end[1], lane], end], [2, 0, 1]) });
      } else if (rules.networked(holder)) links.push(networkLink(holder.id, node.id, hub, placed.get(holder.id)!, pad * 0.45));
      // Its hardware covering its floor, on a board.
      const deckAt = at(ix + W / 2, floorY[c]! + colPad, iz + D / 2);
      for (const { node: part, m, x, z } of decks[c]!.items) place(part, m, [deckAt[0] + x, deckAt[1], deckAt[2] + z], boxes, links, placed, boards);
      if (decks[c]!.items.length) boards.push({ id: holder.id, center: [deckAt[0], deckAt[1] - 0.04, deckAt[2]], size: [W + 1.5 * colPad, 0.05, D + 1.5 * colPad] });
      // Its USB disks: on the shelf beside the machine, or in the storage cluster's array where the store placed them
      // already; each cabled from a USB port on its side straight across.
      const disks = disksOf[c]!;
      const total = disks.reduce((n, x) => n + x.m.size[2], 0) + USB_GAP * Math.max(0, disks.length - 1);
      let z = iz + (D - total) / 2;
      const portY = floorY[c]! + Math.max(colPad + Math.max(0.3, deckH * 0.6), usb[1] / 2 + 0.2);
      const ports = usbPorts(holder);
      const used = new Set<string>();
      for (const { node: disk, m } of disks) {
        if (!stores.length) place(disk, m, at(shelfX + shelfW / 2, floorY[c]!, z + m.size[2] / 2), boxes, links, placed, boards);
        // Where the disk stands now (on the shelf, or in the storage cluster's array).
        const db = boxes.find((b) => b.id === disk.id)!;
        const port = ports.find((p) => !used.has(p.id) && rules.cables?.some(([a, b]) => a === p.id && b === disk.id));
        if (port) {
          used.add(port.id);
          const pc: Vec = [at(pad + slab[0], 0, 0)[0], portY, db.center[2]];
          boxes.push({ id: port.id, shape: "port", center: pc, size: [usb[2], usb[1], usb[0]], radius: 0.04, normal: [1, 0, 0] });
          // Into the disk's back, where its USB connector is — the last stretch comes from behind the disk, so the
          // cable never runs through it.
          const y = db.center[1] - db.size[1] / 2 + Math.min(m.size[1], m.boxes[0]!.size[1]) / 2;
          const end: Vec = [db.center[0], y, db.center[2] - db.size[2] / 2];
          const lane = end[2] - Math.max(0.8, 6 * u);
          const out = pc[0] + 18 * u;
          links.push({ kind: "cable", layer: "hardware", id: port.id, to: disk.id, parent: holder.id, radius: MM.usbCable * u, path: orthogonal([pc, [out, pc[1], pc[2]], [out, y, pc[2]], [out, y, lane], [end[0], y, lane], end], [0, 1, 2]) });
        }
        z += m.size[2] + USB_GAP;
      }
      // USB ports with nothing plugged in, along the rest of the side.
      ports
        .filter((p) => !used.has(p.id))
        .forEach((p, k) => boxes.push({ id: p.id, shape: "port", center: [at(pad + slab[0], 0, 0)[0], portY, at(0, 0, iz + usb[0] + k * 2 * usb[0])[2]], size: [usb[2], usb[1], usb[0]], radius: 0.04, normal: [1, 0, 0] }));
    }
    rows.forEach((_, r) => {
      const cell = cells[c]![r]!;
      // The cell's contents centered in its band's place on the floor plan.
      const center = at(ix + bandX[r]! + bandSpan[r]! / 2, contentY[c]!, iz + bandZ[r]! + bandD[r]! / 2);
      for (const { node: item, m, at: rel } of cell.placed) {
        place(item, m, [center[0] + rel[0], center[1] + rel[1], center[2] + rel[2]], boxes, links, placed, boards);
        if (rules.networked(item)) links.push(networkLink(item.id, holder?.id ?? node.id, colHub ?? hub, placed.get(item.id)!, Math.min(itemGap, rowGap) * 0.45));
      }
    });
  });
  // The switch's uplink to the router's LAN port, in front of both.
  for (const [a, b] of rules.wires ?? []) {
    const pa = portAt.get(a);
    const pb = portAt.get(b);
    if (!pa || !pb || pa === wan || pb === wan) continue;
    const lane = Math.max(pa[2], pb[2]) + 7 * u;
    links.push({ kind: "ethernet", layer: "hardware", id: node.id, to: b, parent: INTERNET, radius: MM.lanCable * u, path: orthogonal([pa, [pa[0], pa[1], lane], [pb[0], pb[1], lane], pb], [2, 0, 1]) });
  }
  // The bands: one solid per band, through the machines that hold any of it (and the loose level above).
  rows.forEach((row, r) => {
    if (!row) return;
    const used = holders.map((_, c) => (cells[c]![r]!.placed.length > 0 ? c : -1)).filter((c) => c >= 0);
    if (!used.length) return;
    const x0 = ix + bandX[r]! - bandPad;
    const x1 = ix + bandX[r]! + bandSpan[r]! + bandPad;
    const y0 = Math.min(...used.map((c) => contentY[c]!)) - bandPad;
    const y1 = Math.max(...used.map((c) => contentY[c]! + cells[c]![r]!.inner[1])) + bandPad;
    const z0 = iz + bandZ[r]! - bandPad;
    const z1 = iz + bandZ[r]! + bandD[r]! + bandPad;
    const size: Vec = [x1 - x0, y1 - y0, z1 - z0];
    boxes.push({ id: bandId(node.id, row), shape: "box", center: at((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), size, radius: roundness(size) * 0.5 });
  });
  addInterfaces(rules, placed, links, node.id, pad);
  return { size: [width, height, depth], boxes, links, outside, boards, wan, wanRadius: MM.lanCable * u };
}

/** Related siblings (a container mounting a claim): over the top of both, at right angles, under the container's
 * ceiling; a line to storage is the storage layer's. */
function addInterfaces(rules: LayoutRules, placed: Map<string, Placed>, links: Link[], parent: string, pad: number) {
  for (const [a, b] of rules.interfaces) {
    const pa = placed.get(a);
    const pb = placed.get(b);
    if (!pa || !pb) continue;
    const lane = Math.max(topOf(pa)[1], topOf(pb)[1]) + Math.min(0.35, pad * 0.4);
    const storage = pa.shape === "cylinder" || pb.shape === "cylinder";
    links.push({ kind: "interface", layer: storage ? "storage" : "base", id: a, to: b, parent, path: overTop(topOf(pa), topOf(pb), lane) });
  }
}

/**
 * The twin's whole scene: the outermost twins (a cluster) side by side, each with what it contains nested inside as
 * translucent shells, all the way down; behind each with a network, the internet it talks to, its public addresses
 * on the globe. Then the lines between interfaces anywhere: a node's card, router and tunnel wired together, the
 * tunnels between nodes (overlay), and the routing (Ingress → Service → pods, LoadBalancer → Service).
 */
export function layoutTwin(top: TwinView[], rules: LayoutRules): Scene {
  const roots = top.map((node) => measure(node, rules));
  if (!roots.length) return { boxes: [], links: [], boards: [], internet: [], bounds: { center: [0, 1, 0], size: [4, 2, 4] } };
  const gap = gapAt(0) * 2;
  const boxes: Box[] = [];
  const links: Link[] = [];
  const boards: Board[] = [];
  const internet: Internet[] = [];
  // Every port's kind, by id, for the links below.
  const kinds = new Map<string, string>();
  const walkKinds = (v: TwinView) => (rules.shape?.(v) === "port" && kinds.set(v.id, rules.portKind?.(v) ?? ""), v.children.forEach(walkKinds));
  top.forEach(walkKinds);
  let x = 0;
  top.forEach((node, i) => {
    const r = roots[i]!;
    const at: Vec = [x + r.size[0] / 2, 0, 0];
    for (const b of r.boxes) boxes.push({ ...b, center: shift(b.center, at) });
    for (const l of r.links) links.push({ ...l, path: l.path.map((p) => shift(p, at)) });
    for (const b of r.boards ?? []) boards.push({ ...b, center: shift(b.center, at) });
    // Behind the twin, up in the air: the internet; its public addresses on the globe, facing the twin, each reached
    // from the LoadBalancers on the back wall (else from the hub).
    if (r.links.some((l) => l.kind === "network") || r.wan) {
      const hub: Vec = [at[0], padAt(0) * 0.5, -r.size[2] / 2];
      const radius = Math.max(2.5, Math.min(r.size[0], r.size[2]) * 0.07);
      const center: Vec = [at[0], r.size[1] + radius * 1.5, -r.size[2] / 2 - radius * 3 - gap];
      internet.push({ id: node.id, center, radius });
      // Each public address on the globe's face toward the twin, side by side below its middle: its line comes in
      // straight along z.
      const onGlobe = (spread: number): Vec => {
        const ox = Math.max(-radius * 0.8, Math.min(radius * 0.8, spread));
        const oy = -radius * 0.3;
        return [center[0] + ox, center[1] + oy, center[2] + Math.sqrt(Math.max(0, radius ** 2 - ox ** 2 - oy ** 2))];
      };
      // The LoadBalancers wherever they sit (in the firewall box now), their lines are the services'.
      const lbs = boxes.filter((b) => b.shape === "port" && kinds.get(b.id) === "loadbalancer");
      // The router's WAN port reaches the internet on the network layer; the LoadBalancers' lines are the services'.
      const starts = lbs.length ? lbs.map((b) => b.center) : r.wan ? [shift(r.wan, at)] : [hub];
      if (r.wan) {
        const w = shift(r.wan, at);
        const e = onGlobe(0);
        const out = w[2] - gap * 0.5;
        // The internet goes over an Ethernet cable out of the router's WAN port, drawn a solid tube.
        links.push({ kind: "internet", layer: "network", id: node.id, parent: INTERNET, radius: r.wanRadius, path: orthogonal([w, [w[0], w[1], out], [e[0], e[1], out], e], [0, 1, 2]) });
      }
      const publics = r.outside ?? [];
      const ends = (publics.length ? publics : [undefined]).map((p, k) => {
        const end = onGlobe((k - (publics.length - 1) / 2) * radius * 0.45);
        if (p) boxes.push({ id: p.id, shape: "port", center: end, size: PORT, radius: 0.08 });
        return { id: p?.id, at: end };
      });
      // Out of the back wall, along behind the twin, up to the address's height and on into it: right angles only.
      starts.forEach((s, i) =>
        ends.forEach(({ id, at: e }) => {
          const out = s[2] - gap * (0.3 + 0.08 * (i % 4));
          links.push({ kind: "internet", layer: lbs.length ? "services" : "network", id: node.id, to: id, parent: INTERNET, path: orthogonal([s, [s[0], s[1], out], [e[0], e[1], out], e], [0, 1, 2]) });
        }),
      );
    }
    x += r.size[0] + gap;
  });

  // Lines between interfaces and routed twins anywhere, from the solids' final places.
  const byId = new Map(boxes.map((b) => [b.id, b]));
  // The LAN devices' ports: their cables are drawn with the stack.
  const cabled = new Set<string>();
  const devicePorts = (v: TwinView) => (rules.device?.(v) ? v.children.forEach((p) => cabled.add(p.id)) : v.children.forEach(devicePorts));
  top.forEach(devicePorts);
  const placedOf = (b: Box): Placed => ({ at: [b.center[0], b.center[1] - b.size[1] / 2, b.center[2]], size: b.size, shape: b.shape });
  // A node's own wiring right behind its back wall, the tunnels between nodes farther out: each pair its own lane,
  // so lines side by side stay apart.
  let wire = 0;
  let overlay = 0;
  for (const [a, b] of rules.wires ?? []) {
    const ka = kinds.get(a);
    const kb = kinds.get(b);
    const ba = byId.get(a);
    const bb = byId.get(b);
    // The links already drawn (a pod's eth0 from its router, a LoadBalancer's and the public address's) aren't twice.
    if (!ba || !bb || cabled.has(a) || cabled.has(b) || [ka, kb].some((k) => k === "veth" || k === "loadbalancer" || k === "public")) continue;
    const tunnel = ka === "tunnel" && kb === "tunnel";
    const out = tunnel ? 0.75 + 0.22 * (overlay++ % 6) : 0.3 + 0.1 * (wire++ % 3);
    const z = Math.min(ba.center[2], bb.center[2]) - out;
    links.push({ kind: tunnel ? "overlay" : "wire", layer: "network", id: a, to: b, parent: a, path: orthogonal([ba.center, [ba.center[0], ba.center[1], z], [bb.center[0], bb.center[1], z], bb.center], [0, 1, 2]) });
  }
  // Routing and storage relations over the top of what they join; routing into a pod ends at its eth0, from behind.
  const ethOf = new Map<string, string>();
  const findEth = (v: TwinView) => {
    const eth = v.children.find((c) => rules.shape?.(c) === "port" && rules.portKind?.(c) === "veth");
    if (eth) ethOf.set(v.id, eth.id);
    v.children.forEach(findEth);
  };
  top.forEach(findEth);
  const end = (id: string, inward: boolean): { at: Vec; n: Vec } | undefined => {
    const eth = ethOf.get(id);
    const b = byId.get(eth ?? id);
    if (!b) return undefined;
    // Into a pod's eth0 from its inner side (from within the machine), where the virtual link ends.
    if (eth) return { at: b.center, n: [0, 0, 1] };
    // A port on a wall (a LoadBalancer): into the twin; any other solid from its top.
    if (b.shape === "port") return { at: b.center, n: [0, 0, inward ? 1 : -1] };
    return { at: topOf(placedOf(b)), n: [0, 1, 0] };
  };
  const relate = (pairs: [string, string][], kind: "virtual" | "storage") =>
    pairs.forEach(([a, b], k) => {
      const ea = end(a, true);
      const eb = end(b, true);
      if (!ea || !eb) return;
      const lane = Math.max(ea.at[1], eb.at[1]) + 0.6 + 0.12 * (k % 5);
      links.push({ kind, layer: kind === "virtual" ? "services" : "storage", id: a, to: b, parent: a, path: overTop(ea.at, eb.at, lane, ea.n, eb.n) });
    });
  relate(rules.virtual ?? [], "virtual");
  relate(rules.storageLinks ?? [], "storage");
  // What runs on what: from a container's floor straight down to just over the hardware, across, and onto the part's
  // top (its node's CPU or memory).
  (rules.resources ?? []).forEach(([a, b], k) => {
    const ba = byId.get(a);
    const bb = byId.get(b);
    if (!ba || !bb) return;
    const from: Vec = [ba.center[0], ba.center[1] - ba.size[1] / 2, ba.center[2]];
    const to = topOf(placedOf(bb));
    const lane = to[1] + 0.35 + 0.05 * (k % 6);
    links.push({ kind: "resource", layer: "hardware", id: a, to: b, parent: a, path: orthogonal([from, [from[0], lane, from[2]], [to[0], lane, to[2]], to], [1, 0, 2]) });
  });

  const minX = Math.min(...boxes.map((b) => b.center[0] - b.size[0] / 2));
  const maxX = Math.max(...boxes.map((b) => b.center[0] + b.size[0] / 2));
  const minZ = Math.min(...boxes.map((b) => b.center[2] - b.size[2] / 2), ...internet.map((n) => n.center[2] - n.radius));
  const maxZ = Math.max(...boxes.map((b) => b.center[2] + b.size[2] / 2));
  const maxY = Math.max(...boxes.map((b) => b.center[1] + b.size[1] / 2), ...internet.map((n) => n.center[1] + n.radius));
  return { boxes, links, boards, internet, bounds: { center: [(minX + maxX) / 2, maxY / 2, (minZ + maxZ) / 2], size: [maxX - minX, maxY, maxZ - minZ] } };
}
