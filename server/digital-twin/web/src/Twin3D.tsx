import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { t } from "i18next";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { displayName, kindOf } from "./icons.ts";
import { INFRA_LAYERS, isWorkloadLayer, layoutRules, pathOf, WORKLOAD_LAYERS, type TwinScene, type TwinView, type ViewLayer } from "./scene.ts";
import { CameraRig, type CameraControl, type Point } from "./three/Camera.tsx";
import { infoOf } from "./three/info.ts";
import { Labels } from "./three/Labels.tsx";
import { Globes, Links } from "./three/Links.tsx";
import { LookContext, Solid, type LookContextValue } from "./three/looks.tsx";
import { appearanceOf, inFocus, linkPaintOf, themeColors, type Content, type Layers, type ViewState } from "./three/paint.ts";
import { layoutTwin } from "./TwinLayout.ts";

export type { CameraControl, Layers, Point };
export { storageText } from "./three/info.ts";

/**
 * What the view shows besides the base (cluster, nodes, pods, containers): the hardware (CPUs with their cores,
 * memory, disks, LAN and USB ports, what runs on them), the low-level network (interfaces, bridges, routers, tunnels
 * and their wiring), the network services (load balancers, Services, Ingresses, public addresses, their routing),
 * storage (volume claims, Ceph with its pools and disks), the namespaces (bands) and the workloads.
 * The layers in the menu's order: the infrastructure's (keys 1–5 show one alone), then each kind of workload (key 6
 * shows them all, alone).
 */
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

/** The scene of a twin: its layout, every twin by id (the bands too), each box by id, the links with their lengths. */
function contentOf(twin: TwinScene): Content {
  const byId = new Map<string, TwinView>();
  const walk = (node: TwinView) => {
    byId.set(node.id, node);
    for (const child of node.children) walk(child);
  };
  for (const node of twin.top) walk(node);
  for (const band of twin.bands) byId.set(band.id, band);
  const scene = layoutTwin(twin.top, layoutRules(twin));
  const links = scene.links.map((l) => {
    const lengths = l.path.slice(1).map((p, i) => new THREE.Vector3(...p).distanceTo(new THREE.Vector3(...l.path[i]!)));
    return { ...l, lengths, total: lengths.reduce((a, b) => a + b, 0) || 1 };
  });
  const b = scene.bounds;
  return { scene, byId, boxes: new Map(scene.boxes.map((x) => [x.id, x])), links, twin, bounds: { center: new THREE.Vector3(...b.center), radius: Math.hypot(...b.size) / 2 } };
}

/** Renders each frame: the scene, then its DOM labels (three.js CSS2D) over it, in the page's own typeface. */
function Render({ host }: { host: RefObject<HTMLDivElement | null> }) {
  const { size } = useThree();
  const labels = useMemo(() => {
    const r = new CSS2DRenderer({ element: document.createElement("div") });
    Object.assign(r.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    return r;
  }, []);
  useEffect(() => {
    host.current?.appendChild(labels.domElement);
    return () => labels.domElement.remove();
  }, [labels]);
  useEffect(() => labels.setSize(size.width, size.height), [size.width, size.height]);
  useFrame(({ gl, scene, camera }) => {
    gl.render(scene, camera);
    labels.render(scene, camera);
  }, 1);
  return null;
}

/**
 * The pointer: hovering names the innermost (smallest) solid under it in a tip beside the pointer and lights it; a
 * click selects it, but not the end of a drag (orbiting).
 */
function Picker({ content, pick, onHover, onSelect, tip, host }: { content: Content; pick: Map<string, THREE.Mesh>; onHover: (id?: string) => void; onSelect: (node: TwinView) => void; tip: RefObject<HTMLDivElement | null>; host: RefObject<HTMLDivElement | null> }) {
  const { gl, camera } = useThree();
  const live = useRef({ content, onHover, onSelect });
  live.current = { content, onHover, onSelect };
  useEffect(() => {
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const canvas = gl.domElement;
    let hovered: string | undefined;
    let down: Point | undefined;
    const at = (event: MouseEvent): TwinView | undefined => {
      const { content } = live.current;
      const rect = canvas.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const shown = [...pick.values()].filter((m) => m.visible && m.parent?.visible !== false);
      const volume = (id: string) => content.boxes.get(id)?.size.reduce((a, b) => a * b, 1) ?? Infinity;
      const innermost = raycaster
        .intersectObjects(shown, false)
        .map((hit) => hit.object.userData.id as string)
        .sort((a, b) => volume(a) - volume(b))[0];
      return innermost ? content.byId.get(innermost) : undefined;
    };
    const onMove = (event: PointerEvent) => {
      const node = event.buttons ? undefined : at(event);
      if (hovered !== node?.id) live.current.onHover((hovered = node?.id));
      const el = host.current;
      const box = tip.current;
      if (!el || !box) return;
      el.style.cursor = node ? "pointer" : "";
      box.hidden = !node;
      if (!node) return;
      const rect = el.getBoundingClientRect();
      const kind = document.createElement("span");
      kind.className = "twin-tip-kind";
      kind.textContent = kindOf(node);
      const name = document.createElement("strong");
      name.textContent = displayName(node);
      const meta = document.createElement("span");
      meta.dataset.status = node.status;
      meta.textContent = infoOf(node);
      box.replaceChildren(kind, name, meta);
      const x = event.clientX - rect.left + 14;
      const y = event.clientY - rect.top + 14;
      box.style.transform = `translate(${Math.min(x, rect.width - box.offsetWidth - 8)}px, ${Math.min(y, rect.height - box.offsetHeight - 8)}px)`;
    };
    const onLeave = () => {
      if (hovered) live.current.onHover((hovered = undefined));
      if (tip.current) tip.current.hidden = true;
    };
    const onDown = (event: PointerEvent) => (down = { x: event.clientX, y: event.clientY });
    const onClick = (event: MouseEvent) => {
      if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
      const node = at(event);
      if (node) live.current.onSelect(node);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("click", onClick);
    return () => {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("click", onClick);
    };
  }, [gl, camera, pick]);
  return null;
}

/**
 * The twin as a 3D WebGL scene (React Three Fiber over three.js): nested translucent shells — the cluster, its nodes
 * inside, their pods inside those, down to the containers — each drawn by its look (`three/looks.tsx`, chosen by its
 * model's `presentation.look`), with edges coloured by status in the theme's cyan. Where twins have a network, a line
 * runs from a hub on their container's back wall to each one, and packets travel it as fast and as many as its load
 * says; the cables a machine is plugged in with are solid tubes; the internet is a globe behind. Hovering highlights a
 * box in the stronger accent (--accent-active) and names it; a click selects it, and the camera flies to it until it
 * fills the view; deselecting leaves the camera where it is, and `home` changing (a second Escape) flies back to the
 * whole twin. `anchor` gives the selected box's corners on screen, for the panels' callout lines.
 */
export function Twin3D({
  scene: twin,
  selected,
  home,
  onSelect,
  anchor,
  control,
  layers = ALL_LAYERS,
  display = DEFAULT_DISPLAY,
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
  /** The keyboard's 1–6 (layers alone) and 0 (every layer). */
  onLayersChange?: (l: Layers) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  // A changed scheme (light or dark) repaints the scene with the new palette.
  const [colors, setColors] = useState(themeColors);
  useEffect(() => {
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setColors(themeColors());
    scheme.addEventListener("change", change);
    return () => scheme.removeEventListener("change", change);
  }, []);
  const [hovered, setHovered] = useState<string>();
  const content = useMemo(() => contentOf(twin), [twin]);
  // The selection's traffic path: an Ingress's Services and pods, its LoadBalancer, the public address.
  const path = useMemo(() => (selected ? pathOf(twin, selected.of ?? selected.id) : new Set<string>()), [twin, selected]);
  const view = useMemo<ViewState>(() => ({ content, focus: selected, hovered, path, layers, colors }), [content, selected, hovered, path, layers, colors]);
  const appearances = useMemo(() => new Map(content.scene.boxes.flatMap((b) => {
    const node = content.byId.get(b.id);
    return node ? [[b.id, appearanceOf(view, node, b)] as const] : [];
  })), [view]);
  const linkPaint = useMemo(() => linkPaintOf(view), [view]);
  const pick = useMemo(() => new Map<string, THREE.Mesh>(), []);
  const looks = useMemo<LookContextValue>(() => ({ colors, twin, pick }), [colors, twin, pick]);
  const inView = (l: Content["links"][number]) => l.kind === "resource" || inFocus(view, content.byId.get(l.parent)) || inFocus(view, content.byId.get(l.id));
  const total = content.scene.boxes.length;

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

  return (
    <div ref={host} className="relative isolate h-full w-full overflow-hidden outline-none" role="application" aria-label={t("twin:view3d")} tabIndex={0} onKeyDown={onKey}>
      <Canvas flat dpr={[1, 2]} gl={{ antialias: true, alpha: true }} camera={{ fov: 45, near: 0.1, far: 5000 }}>
        {/* Light for the 3D assets' own materials (the built-in looks are unlit). */}
        <ambientLight intensity={1.4} />
        <directionalLight position={[1, 2, 1.5]} intensity={1.6} />
        <LookContext.Provider value={looks}>
          {content.scene.boxes.map((box, i) => {
            const node = content.byId.get(box.id);
            const ap = appearances.get(box.id);
            return node && ap ? <Solid key={box.id} box={box} node={node} ap={ap} order={i} total={total} /> : null;
          })}
        </LookContext.Provider>
        <Links content={content} paint={linkPaint} traffic={display.traffic} inView={inView} colors={colors} order={2 * total} />
        <Globes content={content} paint={linkPaint} colors={colors} dim={!!selected && content.boxes.has(selected.id)} />
        <Labels view={view} mode={display.labels} addresses={display.addresses} />
        <CameraRig content={content} selected={selected} home={home} control={control} anchor={anchor} />
        <Picker content={content} pick={pick} onHover={setHovered} onSelect={onSelect} tip={tip} host={host} />
        <Render host={host} />
      </Canvas>
      <div ref={tip} className="twin-tip" hidden />
    </div>
  );
}
