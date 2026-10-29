import type { TwinStatus } from "@osiris/shared";
import { t } from "i18next";
import { useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { formatBytes, formatBytesRate, formatNumber } from "./i18n.ts";
import { iconOf, kindOf } from "./icons.ts";
import { fillOf, hasNetwork, interfacesOf, isStorage, type TwinScene, type TwinView } from "./scene.ts";
import { layoutTwin, type Box, type Link, type Scene } from "./TwinLayout.ts";

/** A point on the view, in CSS pixels from its top left corner. */
export interface Point {
  x: number;
  y: number;
}

/** The theme's colours the scene wears, read from the page's CSS variables (light and dark scheme alike). */
function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => new THREE.Color(css.getPropertyValue(name).trim() || "#888888");
  return { cyan: v("--accent-primary"), magenta: v("--accent-secondary"), warn: v("--state-warning"), error: v("--state-error") };
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);

/** A twin's basic state in one line: its status, traffic, how full it is, its recent errors. */
function infoOf(node: TwinView): string {
  const full = fillOf(node);
  return [
    t(`twin:status.${node.status}`),
    node.network !== undefined ? formatBytesRate(node.network) : "",
    full !== undefined && node.storage ? t("twin:storageUse", { used: formatBytes(node.storage.used), size: formatBytes(node.storage.fsCapacity), share: formatNumber(full, { style: "percent" }) }) : "",
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
  /** A cylinder's content: a smaller cylinder from its floor up to how full it is, with a ring at the level. */
  fill?: { body: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>; level: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial> };
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

/** A network link as drawn: its path's lengths, for the packets that travel it. */
interface LinkPath extends Link {
  lengths: number[];
  total: number;
}

/** What the scene shows of one twin: boxes, network links and labels, and the layout's shape. */
interface Content {
  byId: Map<string, TwinView>;
  meshes: BoxMesh[];
  boxes: Map<string, Box>;
  links: LinkPath[];
  lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  packets: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  /** The interfaces: a dot where each link meets a wall or a mantle. */
  ports: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  labels: Map<string, CSS2DObject>;
  /** The internet's globes and their labels. */
  globes: { lines: THREE.LineSegments<THREE.WireframeGeometry, THREE.LineBasicMaterial>; label: CSS2DObject }[];
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
 * surface, marked with a dot: an interface, never the inside of a solid. Hovering highlights a box in magenta and names it; a click
 * selects it, and the camera flies to it until it fills the view; deselecting leaves the camera where it is, and
 * `home` changing (a second Escape) flies back to the whole twin. `anchor` gives the selected box's corners on screen, for the panels' callout lines.
 */
export function Twin3D({
  scene: twin,
  selected,
  home,
  onSelect,
  anchor,
}: {
  scene: TwinScene;
  selected?: TwinView;
  home: number;
  onSelect: (node: TwinView) => void;
  anchor: RefObject<(() => Point[] | null) | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const chosen = useRef(selected);
  chosen.current = selected;
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
      world.remove(content.lines, content.packets, content.ports);
      content.ports.geometry.dispose();
      content.ports.material.dispose();
      content.lines.geometry.dispose();
      content.lines.material.dispose();
      content.packets.geometry.dispose();
      content.packets.material.dispose();
      for (const label of content.labels.values()) label.removeFromParent();
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
      const meshes: BoxMesh[] = scene.boxes.map((box) => {
        const cylinder = box.shape === "cylinder";
        const r = box.size[0] / 2;
        const geometry = cylinder
          ? new THREE.CylinderGeometry(r, r, box.size[1], 40)
          : new RoundedBoxGeometry(box.size[0], box.size[1], box.size[2], 3, box.radius);
        const mesh = new THREE.Mesh(geometry as THREE.BufferGeometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
        mesh.position.set(...box.center);
        mesh.userData = { id: box.id };
        // A grouping (a namespace) has dashed edges: a set of things, not a thing.
        const dashed = byId.get(box.id)?.dashed;
        const edges = new THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial | THREE.LineDashedMaterial>(
          cylinder ? cylinderEdges(r, box.size[1]) : roundedEdges(box.size, box.radius),
          dashed ? new THREE.LineDashedMaterial({ transparent: true, dashSize: 0.6, gapSize: 0.4 }) : new THREE.LineBasicMaterial({ transparent: true }),
        );
        if (dashed) edges.computeLineDistances();
        edges.position.set(...box.center);
        world.add(mesh, edges);
        let fill: BoxMesh["fill"];
        if (cylinder) {
          // A unit-high cylinder standing on the floor, scaled to the level in `paint`.
          const body = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.86, r * 0.86, 1, 40).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
          const level = new THREE.LineLoop(ring(r * 0.86), new THREE.LineBasicMaterial({ transparent: true }));
          body.position.set(box.center[0], box.center[1] - box.size[1] / 2, box.center[2]);
          level.position.copy(body.position);
          world.add(body, level);
          fill = { body, level };
        }
        return { id: box.id, box, mesh, edges, fill };
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
      // The links as line segments with a colour (and alpha) per vertex, so each can fade on its own.
      const segments = links.flatMap((l) => l.path.slice(1).flatMap((p, i) => [...l.path[i]!, ...p]));
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
      lineGeometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array((segments.length / 3) * 4), 4));
      const lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
      lines.renderOrder = -1;
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
      world.add(lines, packets, ports);

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
        return { lines, label };
      });

      const b = scene.bounds;
      return {
        byId,
        meshes,
        boxes: new Map(scene.boxes.map((x) => [x.id, x])),
        links,
        lines,
        packets,
        ports,
        labels: new Map(),
        globes,
        bounds: { center: new THREE.Vector3(...b.center), radius: Math.hypot(...b.size) / 2 },
        shape,
      };
    };

    const statusColor = (status: TwinStatus) => (status === "error" ? colors.error : status === "warn" ? colors.warn : colors.cyan);
    /** Whether a twin is the selected one or inside it: outside the selection everything fades. */
    const inFocus = (node: TwinView | undefined) => {
      const focus = chosen.current;
      // Nothing selected, or a twin the view has no box for (a namespace): everything is in view.
      if (!focus || !content?.boxes.has(focus.id)) return true;
      for (let n = node; n; n = n.parent) if (n.id === focus.id) return true;
      return false;
    };
    /** Each link's load from 0 to 1 (by index), against its siblings' highest (at least 100 kB/s, so quiet stays calm). */
    let loads: number[] = [];

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
      for (const m of content.meshes) {
        const node = content.byId.get(m.id);
        if (!node) continue;
        const distance = Math.max(0.1, tmp.set(...m.box.center).distanceTo(camera.position));
        const px = (Math.max(m.box.size[0], m.box.size[2]) / distance) * scale;
        const near = !focus || inFocus(node) || isAncestor(node, focus);
        const level = !near ? 0 : px >= LOD.info ? 3 : px >= LOD.name ? 2 : px >= LOD.icon ? 1 : 0;
        let label = content.labels.get(m.id);
        if (!level && !label) continue;
        label ??= labelOf(node, m.box);
        label.visible = level > 0;
        if (label.element.dataset.lod !== String(level)) label.element.dataset.lod = String(level);
      }
    };
    const isAncestor = (node: TwinView, of: TwinView) => {
      for (let n = of.parent; n; n = n.parent) if (n.id === node.id) return true;
      return false;
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
        // Outside the selection a box is a faint ghost; its ancestors stay as thin shells around it.
        const fade = inFocus(node) ? 1 : 0.18;
        const strong = isChosen || isHovered;
        const color = strong ? colors.magenta : statusColor(node.status);
        m.edges.material.color = color;
        m.edges.material.opacity = (strong ? 1 : node.depth === 0 ? 0.9 : leaf ? 0.8 : 0.6) * fade;
        m.mesh.material.color = color;
        m.mesh.material.opacity = (leaf ? (strong ? 0.4 : 0.2) : strong ? 0.1 : 0.035) * fade;
        if (m.fill) {
          // A storage's content: as high as it is full, cyan up to 80 %, then warning, then error from 95 %.
          const full = fillOf(node);
          m.mesh.material.opacity = (strong ? 0.18 : 0.08) * fade;
          const level = full === undefined ? 0 : Math.max(0.001, full * m.box.size[1]);
          const fillColor = full === undefined ? colors.cyan : full >= 0.95 ? colors.error : full >= 0.8 ? colors.warn : colors.cyan;
          m.fill.body.scale.y = level;
          m.fill.body.visible = full !== undefined;
          m.fill.body.material.color = fillColor;
          m.fill.body.material.opacity = 0.45 * fade;
          m.fill.level.position.y = m.box.center[1] - m.box.size[1] / 2 + level;
          m.fill.level.visible = full !== undefined;
          m.fill.level.material.color = fillColor;
          m.fill.level.material.opacity = 0.9 * fade;
        }
      }

      // Each network link's share of its network's load (interfaces carry no traffic).
      const byParent = new Map<string, number>();
      for (const l of content.links) if (l.kind !== "interface") byParent.set(l.parent, Math.max(byParent.get(l.parent) ?? 0, content.byId.get(l.id)?.network ?? 0));
      loads = content.links.map((l) => {
        const load = l.kind === "interface" ? undefined : content!.byId.get(l.id)?.network;
        return load === undefined || load <= 0 ? 0 : Math.min(1, Math.log1p(load) / Math.log1p(Math.max(byParent.get(l.parent) ?? 0, 100_000)));
      });
      const color = content.lines.geometry.getAttribute("color") as THREE.BufferAttribute;
      const portColor = content.ports.geometry.getAttribute("color") as THREE.BufferAttribute;
      let v = 0;
      content.links.forEach((l, k) => {
        const shown = inFocus(content!.byId.get(l.parent)) || inFocus(content!.byId.get(l.id));
        // Networks in cyan by load; interfaces (a mount) in magenta.
        const c = l.kind === "interface" ? colors.magenta : colors.cyan;
        const alpha = (l.kind === "interface" ? 0.7 : 0.18 + 0.5 * loads[k]!) * (shown ? 1 : 0.15);
        for (let i = 0; i < (l.path.length - 1) * 2; i++, v++) color.setXYZW(v, c.r, c.g, c.b, alpha);
        for (const e of [2 * k, 2 * k + 1]) portColor.setXYZW(e, c.r, c.g, c.b, (shown ? 0.95 : 0.15));
      });
      color.needsUpdate = true;
      portColor.needsUpdate = true;
      content.packets.material.color = colors.cyan;
      for (const g of content.globes) {
        g.lines.material.color = colors.cyan;
        g.lines.material.opacity = focus && content.boxes.has(focus.id) ? 0.08 : 0.4;
        g.label.visible = !focus || !content.boxes.has(focus.id);
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
      const position = content.packets.geometry.getAttribute("position") as THREE.BufferAttribute;
      const still = reducedMotion();
      let n = 0;
      for (const [k, l] of content.links.entries()) {
        const load = loads[k] ?? 0;
        if (load <= 0) continue;
        if (!inFocus(content.byId.get(l.parent)) && !inFocus(content.byId.get(l.id))) continue;
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
    /** The selected twin fills the view (once per selection); none: the camera stays. */
    const focus = () => {
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
      const scene = layoutTwin(twin.top, { networked: (node) => hasNetwork(node, twin.models), storage: (node) => isStorage(node, twin.models), interfaces: interfacesOf(twin) });
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
        meshes.map((m) => m.mesh),
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
      if (content && !reducedMotion()) for (const g of content.globes) g.lines.rotation.y = time / 12_000;
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
  useEffect(() => {
    if (home) view.current?.home();
  }, [home]);

  return <div ref={host} className="relative h-full w-full overflow-hidden" role="application" aria-label={t("twin:view3d")} />;
}
