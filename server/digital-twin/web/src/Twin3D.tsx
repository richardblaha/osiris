import type { TwinStatus } from "@osiris/shared";
import { t } from "i18next";
import { useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { formatBytesRate } from "./i18n.ts";
import { hasNetwork, type TwinScene, type TwinView } from "./scene.ts";
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

/** One box of the scene: its fill and edges. */
interface BoxMesh {
  id: string;
  box: Box;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  edges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
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
  labels: Map<string, CSS2DObject>;
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
 * Where twins have a network (DTDL telemetry `network`), a line joins each to a hub on its container's floor, and
 * packets travel it as fast and as many as its load says. Hovering highlights a box in magenta and names it; a click
 * selects it, and the camera flies to it until it fills the view. `home` changing (Escape) flies back to the whole
 * twin. `anchor` gives the selected box's corners on screen, for the panels' callout lines.
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
      for (const { mesh, edges } of content.meshes) {
        world.remove(mesh, edges);
        mesh.geometry.dispose();
        mesh.material.dispose();
        edges.geometry.dispose();
        edges.material.dispose();
      }
      world.remove(content.lines, content.packets);
      content.lines.geometry.dispose();
      content.lines.material.dispose();
      content.packets.geometry.dispose();
      content.packets.material.dispose();
      for (const label of content.labels.values()) label.removeFromParent();
      content = undefined;
    };

    /** Every box (a fill and the edges that carry its status, outer shells drawn first) and the network. */
    const build = (scene: Scene, byId: Map<string, TwinView>, shape: string): Content => {
      const meshes: BoxMesh[] = scene.boxes.map((box) => {
        const geometry = new THREE.BoxGeometry(...box.size);
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
        mesh.position.set(...box.center);
        mesh.userData = { id: box.id };
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ transparent: true }));
        edges.position.set(...box.center);
        world.add(mesh, edges);
        return { id: box.id, box, mesh, edges };
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
      world.add(lines, packets);

      const b = scene.bounds;
      return {
        byId,
        meshes,
        boxes: new Map(scene.boxes.map((x) => [x.id, x])),
        links,
        lines,
        packets,
        labels: new Map(),
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
    /** Each link's load from 0 to 1, against its siblings' highest (and at least 100 kB/s, so quiet stays calm). */
    let loads = new Map<string, number>();

    /** The labels shown: the outer two levels, or the selected twin and what it holds. */
    const labelled = (node: TwinView) => {
      const focus = chosen.current;
      if (!focus || !content?.boxes.has(focus.id)) return node.depth <= 1;
      return node.id === focus.id || (node.parent?.id === focus.id && focus.children.length <= 64);
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
      }

      // Each link's share of its network's load.
      const byParent = new Map<string, number>();
      for (const l of content.links) byParent.set(l.parent, Math.max(byParent.get(l.parent) ?? 0, content.byId.get(l.id)?.network ?? 0));
      loads = new Map(
        content.links.map((l) => {
          const load = content!.byId.get(l.id)?.network;
          return [l.id, load === undefined || load <= 0 ? 0 : Math.min(1, Math.log1p(load) / Math.log1p(Math.max(byParent.get(l.parent) ?? 0, 100_000)))];
        }),
      );
      const color = content.lines.geometry.getAttribute("color") as THREE.BufferAttribute;
      let v = 0;
      for (const l of content.links) {
        const shown = inFocus(content.byId.get(l.parent)) || inFocus(content.byId.get(l.id));
        const alpha = (0.18 + 0.5 * (loads.get(l.id) ?? 0)) * (shown ? 1 : 0.15);
        for (let i = 0; i < (l.path.length - 1) * 2; i++, v++) color.setXYZW(v, colors.cyan.r, colors.cyan.g, colors.cyan.b, alpha);
      }
      color.needsUpdate = true;
      content.packets.material.color = colors.cyan;

      for (const node of content.byId.values()) {
        const box = content.boxes.get(node.id);
        if (!box) continue;
        const want = labelled(node);
        let label = content.labels.get(node.id);
        if (want && !label) {
          const div = document.createElement("div");
          div.className = "twin-label";
          label = new CSS2DObject(div);
          label.position.set(box.center[0], box.center[1] + box.size[1] / 2 + 0.3, box.center[2] - box.size[2] / 2);
          world.add(label);
          content.labels.set(node.id, label);
        }
        if (!label) continue;
        label.visible = want;
        label.element.textContent = node.name;
        label.element.dataset.status = node.status;
        label.element.dataset.selected = String(focus?.id === node.id);
        label.element.dataset.level = String(Math.min(node.depth, 2));
      }
    };

    /** The packets' positions now: each link's packets spread along it, half going out and half coming in. */
    const movePackets = (time: number) => {
      if (!content) return;
      const position = content.packets.geometry.getAttribute("position") as THREE.BufferAttribute;
      const still = reducedMotion();
      let n = 0;
      for (const l of content.links) {
        const load = loads.get(l.id) ?? 0;
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
    /** The selected twin fills the view (once per selection); none: back to the whole twin. */
    const focus = () => {
      paint();
      const node = chosen.current;
      if (!node) return void (flownTo && flyHome());
      const box = content?.boxes.get(node.id);
      if (!box || flownTo === node.id) return;
      flownTo = node.id;
      // A little room around it for the panels' lines.
      fly(new THREE.Vector3(...box.center), Math.hypot(...box.size) / 2, 1.05);
    };

    /** Shows a (new or refreshed) twin: the same structure only repaints, a changed one rebuilds the boxes. */
    const show = (twin: TwinScene) => {
      const byId = new Map<string, TwinView>();
      const walk = (node: TwinView) => {
        byId.set(node.id, node);
        for (const child of node.children) walk(child);
      };
      for (const node of twin.top) walk(node);
      const scene = layoutTwin(twin.top, (node) => hasNetwork(node, twin.models));
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
      kind.textContent = node.modelName;
      const name = document.createElement("strong");
      name.textContent = node.name;
      const meta = document.createElement("span");
      meta.dataset.status = node.status;
      meta.textContent = [t(`twin:status.${node.status}`), node.network !== undefined ? formatBytesRate(node.network) : "", node.errors ? t("twin:errorCount", { count: node.errors }) : ""].filter(Boolean).join(" · ");
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
