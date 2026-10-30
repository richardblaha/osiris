import type { TwinView } from "./scene.ts";

type Vec = [number, number, number];

/**
 * A solid's shape: a rounded box, a cylinder (storage), a port (a network interface, a plate on a wall), a hexagonal
 * prism (a Service: virtual) or a gate (an Ingress: a frame traffic comes through).
 */
export type Shape = "box" | "cylinder" | "port" | "hex" | "gate";

/** A node's solid in the twin's 3D scene: its shape, center and full size. */
export interface Box {
  id: string;
  shape: Shape;
  center: Vec;
  /** Width, height, depth; a cylinder's and a hexagon's width and depth are their diameter. */
  size: Vec;
  /** How round a box's edges are. */
  radius: number;
}

/**
 * A line between two interfaces, both on a solid's surface (a wall, a mantle, a port), never inside one:
 * `network` from the container's router (its hub on its back wall) to the child's port or facing wall (traffic
 * animated by the child's load), `internet` from the cluster's LoadBalancer to its public address on the globe,
 * `wire` between a node's own interfaces (card, router, tunnel), `overlay` a VXLAN tunnel between nodes,
 * `interface` between related siblings (a container mounting a volume), `virtual` a Service's or an Ingress's
 * routing (to Services, pods, from a LoadBalancer), shown with what it belongs to.
 */
export interface Link {
  kind: "network" | "interface" | "internet" | "wire" | "overlay" | "virtual";
  /** The twin whose load the link carries (network, internet), or the relationship's source. */
  id: string;
  /** The relationship's target (wire, overlay, virtual, interface). */
  to?: string;
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

/** What the layout asks of the twin: kinds of solids, which twins have a network, and the relationships to draw. */
export interface LayoutRules {
  networked: (node: TwinView) => boolean;
  storage: (node: TwinView) => boolean;
  /** A solid of its own shape (a port, a Service, an Ingress); undefined for a box or a storage cylinder. */
  shape?: (node: TwinView) => Shape | undefined;
  /** A network interface's kind (physical, router, tunnel, veth, loadbalancer, public). */
  portKind?: (node: TwinView) => string;
  /** Related siblings, as id pairs. */
  interfaces: [string, string][];
  /** Interfaces connected to each other (connectedTo). */
  wires?: [string, string][];
  /** Routing between twins anywhere (routesTo, exposes, servedBy). */
  virtual?: [string, string][];
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
}

/** The space between siblings: wide between the outer shells (nodes), tight between the innermost (containers). */
const gapAt = (depth: number) => Math.max(0.5, 4 / 2.4 ** depth);
/** The margin of a shell around what it holds, on every side: children float inside it, never touching it. */
const padAt = (depth: number) => gapAt(depth) * 0.55 + 0.45;
/** How round a box's edges are: a little, more for the big shells, never more than a fifth of its least side. */
const roundness = (size: Vec) => Math.min(Math.min(...size) * 0.2, Math.min(...size) * 0.06 + 0.1, 1.2);
/** A port: a small plate standing out of a wall. */
const PORT: Vec = [0.55, 0.55, 0.16];

/** A leaf's size by its shape: a small cube (or cylinder) at the bottom of the tree, a bigger one higher up. */
function leafOf(node: TwinView, shape: Shape): Vec {
  if (shape === "port") return PORT;
  if (shape === "hex") return [1.4, 0.8, 1.4];
  if (shape === "gate") return [1.8, 1.5, 0.5];
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

/**
 * The interface of a solid toward a point (only x and z count), at height `y`: on a box, the middle of the wall facing
 * it; on a cylinder or a hexagon, the mantle where it faces it.
 */
function port(p: Placed, toward: Vec, y: number): Vec {
  const [x, , z] = p.at;
  const dx = toward[0] - x;
  const dz = toward[2] - z;
  if (p.shape === "cylinder" || p.shape === "hex") {
    const r = p.size[0] / 2;
    const d = Math.hypot(dx, dz);
    return d ? [x + (dx / d) * r, y, z + (dz / d) * r] : [x, y, z - r];
  }
  // The wall the point lies beyond: the axis on which it is farther out, relative to the box's extent.
  return Math.abs(dx) / p.size[0] > Math.abs(dz) / p.size[2] ? [x + Math.sign(dx) * (p.size[0] / 2), y, z] : [x, y, z + (Math.sign(dz) || -1) * (p.size[2] / 2)];
}

const shapeOf = (node: TwinView, rules: LayoutRules): Shape => rules.shape?.(node) ?? (rules.storage(node) && !node.children.length ? "cylinder" : "box");
const isPort = (node: TwinView, rules: LayoutRules) => rules.shape?.(node) === "port";
/** Where a container's own interfaces go on its back wall, left to right: card, router (the hub), tunnel, the rest. */
const PORT_ORDER = ["physical", "router", "tunnel", "loadbalancer", "veth"];

/**
 * A container's interfaces on its back wall at height `y`: the router at `hub` (where its children's links start),
 * the others beside it, a port's width apart. Returns where each went.
 */
function mountPorts(ports: TwinView[], hub: Vec, rules: LayoutRules, boxes: Box[]): Map<string, Vec> {
  const at = new Map<string, Vec>();
  const kind = (p: TwinView) => rules.portKind?.(p) ?? "veth";
  const sorted = [...ports].sort((a, b) => PORT_ORDER.indexOf(kind(a)) - PORT_ORDER.indexOf(kind(b)) || a.name.localeCompare(b.name));
  const router = sorted.findIndex((p) => kind(p) === "router");
  const center = router >= 0 ? router : (sorted.length - 1) / 2;
  sorted.forEach((p, i) => {
    const c: Vec = [hub[0] + (i - center) * (PORT[0] + 0.6), hub[1], hub[2]];
    boxes.push({ id: p.id, shape: "port", center: c, size: PORT, radius: 0.08 });
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
function place(child: TwinView, m: Measured, at: Vec, boxes: Box[], links: Link[], placed: Map<string, Placed & { port?: Vec }>) {
  for (const b of m.boxes) boxes.push({ ...b, center: shift(b.center, at) });
  for (const l of m.links) links.push({ ...l, path: l.path.map((p) => shift(p, at)) });
  placed.set(child.id, { at, size: m.size, shape: m.boxes[0]!.shape, port: m.port && shift(m.port, at) });
}

/**
 * A network link: along the floor from the hub to the foot of the child's interface (its port, else its facing wall),
 * then up to it.
 */
function networkLink(id: string, parent: string, hub: Vec, p: Placed & { port?: Vec }): Link {
  const end = p.port ?? port(p, hub, p.at[1] + p.size[1] / 2);
  return { kind: "network", id, parent, path: [hub, [end[0], hub[1], end[2]], end] };
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
  const size: Vec = [Math.max(footprint[0] + 2 * pad, ports.length * (PORT[0] + 0.6) + 2 * pad), footprint[1] + 2 * pad, footprint[2] + 2 * pad];

  const boxes: Box[] = [{ id: node.id, shape, center: [0, size[1] / 2, 0], size, radius: roundness(size) }];
  const links: Link[] = [];
  const placed = new Map<string, Placed & { port?: Vec }>();
  // The hub: the node's router on its back wall, halfway between its floor and its children's.
  const hub: Vec = [0, pad * 0.5, -size[2] / 2];
  // A pod's eth0 sits higher, in the middle of its back wall: the end of the link from its node's router.
  const mounted = ports.length ? mountPorts(ports, rules.networked(node) ? [0, size[1] / 2, -size[2] / 2] : hub, rules, boxes) : new Map<string, Vec>();
  for (const { node: child, m, at: rel } of items) {
    place(child, m, [rel[0], pad + rel[1], rel[2]], boxes, links, placed);
    if (rules.networked(child)) links.push(networkLink(child.id, node.id, hub, placed.get(child.id)!));
  }
  addInterfaces(rules, placed, links, node.id);
  return { size, boxes, links, port: rules.networked(node) ? mounted.values().next().value : undefined };
}

/** A twin whose contents' contents belong to bands (a cluster: its nodes' pods to namespaces). */
const isBanded = (node: TwinView) => node.children.some((c) => c.band !== undefined || c.children.some((g) => g.band !== undefined));
/** The id of the band of `group` across `root` (scene.ts makes it the same way). */
export const bandId = (root: string, group: string) => `${root}~${group}`;

/**
 * A container laid out in bands: its children that hold things (the nodes, Ceph) are columns side by side, and every
 * band (a namespace) a row across them, the rows one behind another in levels stacked as high as keeps the whole
 * nearest a cube — the cell of a column and a row holds what of that column belongs to that
 * band, so one dashed solid around the row takes in all of the band, through the columns' walls and the gaps between
 * them. What belongs to a band but no column (a pod no node runs yet, a Service, an Ingress) has a column of its own
 * without walls, behind the others; what belongs to no band (disks, pools) has the last row. Each column's
 * interfaces (a node's card, router, tunnel) are ports on its back wall, the container's own (LoadBalancers) on its
 * back wall; public addresses are left for the globe.
 */
function measureBanded(node: TwinView, rules: LayoutRules): Measured {
  const pad = padAt(node.depth);
  const colPad = padAt(node.depth + 1);
  const colGap = gapAt(node.depth);
  // A band's margin inside the columns' (so a band in one column stays in it), and the space between bands.
  const bandPad = colPad * 0.5;
  const rowGap = Math.max(gapAt(node.depth + 1), 2 * bandPad + 0.5);
  const itemGap = gapAt(node.depth + 2);

  const ownPorts = node.children.filter((c) => isPort(c, rules));
  const columns = node.children.filter((c) => c.band === undefined && !isPort(c, rules) && c.children.some((g) => !isPort(g, rules)));
  const loose = node.children.filter((c) => !columns.includes(c) && !isPort(c, rules));
  const keyOf = (v: TwinView) => v.band ?? "";
  const contents = (holder: TwinView) => holder.children.filter((v) => !isPort(v, rules));
  const rows = [...new Set([...columns.flatMap((c) => contents(c).map(keyOf)), ...loose.map(keyOf)])].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  // Each cell's contents, arranged; the loose column is the last.
  const holders: (TwinView | undefined)[] = [...columns, ...(loose.length ? [undefined] : [])];
  const cells = holders.map((holder) =>
    rows.map((row) => arrange((holder ? contents(holder) : loose).filter((v) => keyOf(v) === row).map((v) => ({ node: v, m: measure(v, rules) })), itemGap)),
  );
  const colW = holders.map((holder, c) => Math.max(1, (holder?.children.filter((v) => isPort(v, rules)).length ?? 0) * (PORT[0] + 0.6), ...cells[c]!.map((cell) => cell.inner[0])));
  const rowD = rows.map((_, r) => Math.max(1, ...cells.map((col) => col[r]!.inner[2])));
  const rowH = rows.map((_, r) => Math.max(0, ...cells.map((col) => col[r]!.inner[1])));

  // x of each column's inside, z of each row, all from 0; centered at the end.
  const colX: number[] = [];
  let x = pad;
  holders.forEach((holder, c) => {
    if (!holder && c > 0) x += bandPad; // The loose column has no walls: just past the last one.
    colX.push(x + (holder ? colPad : 0));
    x += colW[c]! + (holder ? 2 * colPad : 0) + colGap;
  });
  const width = Math.max(x - colGap + pad, ownPorts.length * (PORT[0] + 0.6) + 2 * pad);
  // The bands in levels: rows one behind another, levels one on top of another, as many levels as keep the whole
  // nearest a cube (the rows in order, a level filled before the next).
  const levelsOf = (count: number) => {
    const per = Math.ceil(rows.length / count);
    const levels = Array.from({ length: count }, (_, l) => rows.map((_, r) => r).slice(l * per, (l + 1) * per)).filter((l) => l.length);
    const depthIn = Math.max(1, ...levels.map((l) => l.reduce((n, r) => n + rowD[r]!, 0) + rowGap * (l.length - 1)));
    const heights = levels.map((l) => Math.max(0, ...l.map((r) => rowH[r]!)));
    const heightIn = Math.max(1, heights.reduce((n, h) => n + h, 0) + rowGap * (levels.length - 1));
    return { levels, heights, depthIn, heightIn };
  };
  let plan = levelsOf(1);
  for (let count = 2; count <= rows.length; count++) {
    const next = levelsOf(count);
    if (aspect([width, next.heightIn, next.depthIn]) < aspect([width, plan.heightIn, plan.depthIn])) plan = next;
  }
  const innerH = plan.heightIn;
  const colFloor = pad;
  const itemFloor = pad + colPad;
  const rowZ: number[] = [];
  const rowY: number[] = [];
  let y = itemFloor;
  plan.levels.forEach((level, l) => {
    let z = pad + colPad;
    for (const r of level) {
      rowZ[r] = z;
      rowY[r] = y;
      z += rowD[r]! + rowGap;
    }
    y += plan.heights[l]! + rowGap;
  });
  const depth = pad + colPad + plan.depthIn + colPad + pad;
  const height = itemFloor + innerH + colPad + pad;
  const cx = width / 2;
  const cz = depth / 2;
  const at = (px: number, py: number, pz: number): Vec => [px - cx, py, pz - cz];

  const boxes: Box[] = [{ id: node.id, shape: shapeOf(node, rules), center: [0, height / 2, 0], size: [width, height, depth], radius: roundness([width, height, depth]) }];
  const links: Link[] = [];
  const placed = new Map<string, Placed & { port?: Vec }>();
  const hub: Vec = [0, pad * 0.5, -depth / 2];
  // The container's own interfaces (LoadBalancers) on its back wall, beside the hub; public addresses go outside.
  const outside = ownPorts.filter((p) => rules.portKind?.(p) === "public");
  mountPorts(ownPorts.filter((p) => !outside.includes(p)), [hub[0] + PORT[0] + 0.6, hub[1], hub[2]], rules, boxes);
  holders.forEach((holder, c) => {
    // The column's own solid (a node), with its interfaces on its back wall: the router is its hub.
    let colHub: Vec | undefined;
    if (holder) {
      const size: Vec = [colW[c]! + 2 * colPad, innerH + 2 * colPad, depth - 2 * pad];
      const floor = at(colX[c]! - colPad + size[0] / 2, colFloor, depth / 2);
      boxes.push({ id: holder.id, shape: shapeOf(holder, rules), center: [floor[0], floor[1] + size[1] / 2, floor[2]], size, radius: roundness(size) });
      colHub = [floor[0], colFloor + colPad * 0.5, floor[2] - size[2] / 2];
      const mounted = mountPorts(holder.children.filter((v) => isPort(v, rules)), colHub, rules, boxes);
      // The cluster's network reaches the node at its card.
      const card = holder.children.find((v) => isPort(v, rules) && rules.portKind?.(v) === "physical");
      placed.set(holder.id, { at: floor, size, shape: "box", port: card && mounted.get(card.id) });
      if (rules.networked(holder)) links.push(networkLink(holder.id, node.id, hub, placed.get(holder.id)!));
    }
    rows.forEach((_, r) => {
      const cell = cells[c]![r]!;
      // The cell's contents centered in it.
      const center = at(colX[c]! + colW[c]! / 2, rowY[r]!, rowZ[r]! + rowD[r]! / 2);
      for (const { node: item, m, at: rel } of cell.placed) {
        place(item, m, [center[0] + rel[0], rowY[r]! + rel[1], center[2] + rel[2]], boxes, links, placed);
        if (rules.networked(item)) links.push(networkLink(item.id, holder?.id ?? node.id, colHub ?? hub, placed.get(item.id)!));
      }
    });
  });
  // The bands: one solid per row of a band, across the columns that hold any of it.
  rows.forEach((row, r) => {
    if (!row) return;
    const used = holders.map((_, c) => cells[c]![r]!.placed.length > 0);
    const first = used.indexOf(true);
    const last = used.lastIndexOf(true);
    if (first < 0) return;
    const x0 = colX[first]! - bandPad;
    const x1 = colX[last]! + colW[last]! + bandPad;
    const y0 = rowY[r]! - bandPad;
    const y1 = rowY[r]! + rowH[r]! + bandPad;
    const z0 = rowZ[r]! - bandPad;
    const z1 = rowZ[r]! + rowD[r]! + bandPad;
    const size: Vec = [x1 - x0, y1 - y0, z1 - z0];
    boxes.push({ id: bandId(node.id, row), shape: "box", center: at((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), size, radius: roundness(size) * 0.5 });
  });
  addInterfaces(rules, placed, links, node.id);
  return { size: [width, height, depth], boxes, links, outside };
}

/** Related siblings (a container mounting a claim): wall to wall, each end halfway up its own solid (they may be on
 * different layers of the grid). */
function addInterfaces(rules: LayoutRules, placed: Map<string, Placed>, links: Link[], parent: string) {
  for (const [a, b] of rules.interfaces) {
    const pa = placed.get(a);
    const pb = placed.get(b);
    if (!pa || !pb) continue;
    links.push({ kind: "interface", id: a, to: b, parent, path: [port(pa, pb.at, pa.at[1] + pa.size[1] / 2), port(pb, pa.at, pb.at[1] + pb.size[1] / 2)] });
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
    // Behind the twin, up in the air: the internet; its public addresses on the globe, facing the twin, each reached
    // from the LoadBalancers on the back wall (else from the hub).
    if (r.links.some((l) => l.kind === "network")) {
      const hub: Vec = [at[0], padAt(0) * 0.5, -r.size[2] / 2];
      const radius = Math.max(2.5, Math.min(r.size[0], r.size[2]) * 0.07);
      const center: Vec = [at[0], r.size[1] + radius * 1.5, -r.size[2] / 2 - radius * 3 - gap];
      internet.push({ id: node.id, center, radius });
      const onGlobe = (from: Vec, spread: number): Vec => {
        const d: Vec = [from[0] - center[0] + spread, from[1] - center[1], from[2] - center[2]];
        const len = Math.hypot(...d) || 1;
        return shift(center, [(d[0] / len) * radius, (d[1] / len) * radius, (d[2] / len) * radius]);
      };
      const lbs = boxes.filter((b) => b.shape === "port" && node.children.some((c) => c.id === b.id && rules.portKind?.(c) === "loadbalancer"));
      const starts = lbs.length ? lbs.map((b) => b.center) : [hub];
      const publics = r.outside ?? [];
      const ends = (publics.length ? publics : [undefined]).map((p, k) => {
        const end = onGlobe(starts[0]!, (k - (publics.length - 1) / 2) * radius * 0.5);
        if (p) boxes.push({ id: p.id, shape: "port", center: end, size: PORT, radius: 0.08 });
        return end;
      });
      for (const s of starts)
        for (const e of ends) {
          const out: Vec = [s[0], s[1], s[2] - gap / 2];
          links.push({ kind: "internet", id: node.id, parent: INTERNET, path: [s, out, e] });
        }
    }
    x += r.size[0] + gap;
  });

  // Lines between interfaces and routed twins anywhere, from the solids' final places.
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const kinds = new Map<string, string>();
  const walk = (v: TwinView) => (rules.shape?.(v) === "port" && kinds.set(v.id, rules.portKind?.(v) ?? ""), v.children.forEach(walk));
  top.forEach(walk);
  const placedOf = (b: Box): Placed => ({ at: [b.center[0], b.center[1] - b.size[1] / 2, b.center[2]], size: b.size, shape: b.shape });
  for (const [a, b] of rules.wires ?? []) {
    const ka = kinds.get(a);
    const kb = kinds.get(b);
    const ba = byId.get(a);
    const bb = byId.get(b);
    // The links already drawn (a pod's eth0 from its router, a LoadBalancer's and the public address's) aren't twice.
    if (!ba || !bb || [ka, kb].some((k) => k === "veth" || k === "loadbalancer" || k === "public")) continue;
    links.push({ kind: ka === "tunnel" && kb === "tunnel" ? "overlay" : "wire", id: a, to: b, parent: a, path: [ba.center, bb.center] });
  }
  for (const [a, b] of rules.virtual ?? []) {
    const ba = byId.get(a);
    const bb = byId.get(b);
    if (!ba || !bb) continue;
    const pa = placedOf(ba);
    const pb = placedOf(bb);
    links.push({ kind: "virtual", id: a, to: b, parent: a, path: [port(pa, pb.at, ba.center[1]), port(pb, pa.at, bb.center[1])] });
  }

  const minX = Math.min(...boxes.map((b) => b.center[0] - b.size[0] / 2));
  const maxX = Math.max(...boxes.map((b) => b.center[0] + b.size[0] / 2));
  const minZ = Math.min(...boxes.map((b) => b.center[2] - b.size[2] / 2), ...internet.map((n) => n.center[2] - n.radius));
  const maxZ = Math.max(...boxes.map((b) => b.center[2] + b.size[2] / 2));
  const maxY = Math.max(...boxes.map((b) => b.center[1] + b.size[1] / 2), ...internet.map((n) => n.center[1] + n.radius));
  return { boxes, links, internet, bounds: { center: [(minX + maxX) / 2, maxY / 2, (minZ + maxZ) / 2], size: [maxX - minX, maxY, maxZ - minZ] } };
}
