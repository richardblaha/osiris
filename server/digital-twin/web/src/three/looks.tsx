import { useFrame } from "@react-three/fiber";
import { createContext, memo, useContext, useLayoutEffect, useMemo, useRef, type ComponentType, type ReactNode } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { portKind } from "../icons.ts";
import type { TwinScene, TwinView } from "../scene.ts";
import type { Box } from "../TwinLayout.ts";
import { brickLines, cylinderEdges, diskEdges, drumEdges, facing, frame, gateEdges, gateGeometry, gaugeGeometry, pinGeometry, ring, roundedEdges, SOCKET, spokes, ventGeometry, wifiArcs } from "./geometry.ts";
import { num } from "./info.ts";
import { reducedMotion, sameAppearance, type Appearance, type Colors } from "./paint.ts";
import { VisualParts } from "./visual.tsx";

/**
 * The registry of looks: how each kind of twin is drawn, one React component per look (`presentation.look` of its
 * model, else the built-in one of its DTMI). A look draws in its solid's own frame (centered on the box, the layout's
 * size), its body registered for picking with {@link Body}. A new look is a component here and an entry in
 * {@link LOOK_COMPONENTS}; a model chooses it by name.
 */
export interface LookProps {
  box: Box;
  node: TwinView;
  ap: Appearance;
  /** Its place in the drawing order: outer shells first, so transparency stacks whole solids in the right order. */
  order: number;
  total: number;
}
export type LookComponent = ComponentType<LookProps>;

/** What looks share: the theme's colours, the twin (its relationships) and where bodies register for picking. */
export interface LookContextValue {
  colors: Colors;
  twin: TwinScene;
  pick: Map<string, THREE.Mesh>;
}
export const LookContext = createContext<LookContextValue | null>(null);
const useLook = () => useContext(LookContext)!;

type V3 = [number, number, number];
const material = { transparent: true, depthWrite: false } as const;

/** A solid's body: the translucent mesh the pointer picks. */
function Body({ id, geometry, ap, order }: { id: string; geometry: THREE.BufferGeometry; ap: Appearance; order: number }) {
  const { pick } = useLook();
  const ref = useRef<THREE.Mesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current!;
    mesh.userData.id = id;
    pick.set(id, mesh);
    return () => void (pick.get(id) === mesh && pick.delete(id));
  }, [id, pick]);
  return (
    <mesh ref={ref} geometry={geometry} renderOrder={order} visible={!ap.hidden}>
      <meshBasicMaterial {...material} color={ap.body} opacity={ap.bodyOpacity} />
    </mesh>
  );
}

/** A solid's outline, carrying its status: solid, dashed for a grouping (a namespace), dotted for a workload. */
function Outline({ geometry, ap, order, dash }: { geometry: THREE.BufferGeometry; ap: Appearance; order: number; dash?: { dashSize: number; gapSize: number } }) {
  const ref = useRef<THREE.LineSegments>(null);
  useLayoutEffect(() => void (dash && ref.current?.computeLineDistances()), [geometry, dash]);
  return (
    <lineSegments ref={ref} geometry={geometry} renderOrder={order}>
      {dash ? <lineDashedMaterial transparent color={ap.edge} opacity={ap.edgeOpacity} {...dash} /> : <lineBasicMaterial transparent color={ap.edge} opacity={ap.edgeOpacity} />}
    </lineSegments>
  );
}

/** A flat part on a face: a plate of a colour (a socket's opening, a light, a panel). */
function Plate({ size, position, rotation, color, opacity, plateRef }: { size: [number, number]; position: V3; rotation?: V3; color: THREE.ColorRepresentation; opacity: number; plateRef?: React.Ref<THREE.Mesh> }) {
  return (
    <mesh ref={plateRef} position={position} rotation={rotation}>
      <planeGeometry args={size} />
      <meshBasicMaterial {...material} side={THREE.DoubleSide} color={color} opacity={opacity} />
    </mesh>
  );
}

/** A light blinking `rate` times a second (always on with `steady`, dim at 0). */
function useBlink(ap: Appearance, phase: number, steady = false) {
  const ref = useRef<THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>(null);
  const rate = useRef(ap.rate);
  rate.current = ap.rate;
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const r = rate.current;
    const on = reducedMotion() ? r > 0 || steady : r ? Math.sin(clock.elapsedTime * r * Math.PI * 2 + phase) > -0.2 : steady;
    m.material.opacity = (on ? 0.95 : 0.12) * ap.fade;
  });
  return ref;
}

const roundedBox = (box: Box, segments = 3) => new RoundedBoxGeometry(box.size[0], box.size[1], box.size[2], segments, box.radius);

/** The plain look: a rounded box with its outline (a grouping's broken), and a part's load inside it. */
function BoxLook({ box, node, ap, order, total, children }: LookProps & { children?: ReactNode }) {
  const geometry = useMemo(() => roundedBox(box), [box.size.join(), box.radius]);
  const outline = useMemo(() => roundedEdges(box.size, box.radius), [box.size.join(), box.radius]);
  // A grouping has broken edges: a namespace dashed, a workload dotted — sets of things, not things.
  const dash = node.dashed ? DASHED : node.look === "workload" ? DOTTED : undefined;
  return (
    <>
      <Body id={box.id} geometry={geometry} ap={ap} order={order} />
      <Outline geometry={outline} ap={ap} order={order + total} dash={dash} />
      {children}
    </>
  );
}
const DASHED = { dashSize: 0.6, gapSize: 0.4 };
const DOTTED = { dashSize: 0.12, gapSize: 0.14 };

/** The cluster: its box and the floor it stands on. */
function ClusterLook(props: LookProps) {
  const { box } = props;
  const { colors } = useLook();
  const grid = useMemo(() => {
    const span = Math.max(box.size[0], box.size[2]);
    const g = new THREE.GridHelper(span, Math.max(4, Math.round(span / 2)), colors.cyan, colors.cyan);
    g.scale.set(box.size[0] / span, 1, box.size[2] / span);
    const m = g.material as THREE.LineBasicMaterial;
    m.transparent = true;
    m.opacity = 0.07;
    m.depthWrite = false;
    return g;
  }, [box.size.join(), colors]);
  return (
    <BoxLook {...props}>
      <primitive object={grid} position={[0, -box.size[1] / 2 + 0.02, 0]} />
    </BoxLook>
  );
}

/** Storage: a cylinder filled from its floor as far as it is full, a ring at the level; a disk with its platters. */
function CylinderLook({ box, node, ap, order, total }: LookProps) {
  const r = box.size[0] / 2;
  const h = box.size[1];
  const geometry = useMemo(() => new THREE.CylinderGeometry(r, r, h, 40), [r, h]);
  const outline = useMemo(() => (node.look === "disk" ? diskEdges(r, h) : cylinderEdges(r, h)), [r, h, node.look]);
  const content = useMemo(() => new THREE.CylinderGeometry(r * 0.86, r * 0.86, 1, 40).translate(0, 0.5, 0), [r]);
  const level = useMemo(() => ring(r * 0.86), [r]);
  const height = ap.fill === undefined ? 0 : Math.max(0.001, ap.fill * h);
  const shown = ap.fill !== undefined && !ap.hidden;
  return (
    <>
      <Body id={box.id} geometry={geometry} ap={ap} order={order} />
      <Outline geometry={outline} ap={ap} order={order + total} />
      <mesh geometry={content} position={[0, -h / 2, 0]} scale={[1, height, 1]} visible={shown}>
        <meshBasicMaterial {...material} color={ap.fillColor} opacity={ap.fillOpacity} />
      </mesh>
      <lineLoop geometry={level} position={[0, -h / 2 + height, 0]} visible={shown}>
        <lineBasicMaterial transparent color={ap.fillColor} opacity={0.9 * ap.fade} />
      </lineLoop>
    </>
  );
}

/** A storage cluster (Ceph): a drum, its lid a gauge as far round as it is full, a halo above it pulsing while it
 * isn't healthy. */
function DrumLook({ box, node, ap, order, total }: LookProps) {
  const { colors } = useLook();
  const r = box.size[0] / 2;
  const h = box.size[1];
  const geometry = useMemo(() => new THREE.CylinderGeometry(r, r, h, 64), [r, h]);
  const outline = useMemo(() => drumEdges(r, h), [r, h]);
  const track = useMemo(() => gaugeGeometry(r * 0.8, r * 0.92, 1), [r]);
  const full = ap.fill ?? 0;
  const gauge = useMemo(() => gaugeGeometry(r * 0.8, r * 0.92, full), [r, full]);
  const halo = useMemo(() => ring(r * 1.1), [r]);
  const haloRef = useRef<THREE.LineLoop>(null);
  const ok = node.status === "ok";
  useFrame(({ clock }) => haloRef.current?.scale.setScalar(ok || reducedMotion() ? 1 : 1 + 0.08 * (0.5 + 0.5 * Math.sin(clock.elapsedTime / 0.6))));
  const lid = h / 2 + 0.03;
  const gaugeColor = full >= 0.85 ? colors.error : full >= 0.75 ? colors.warn : colors.cyan;
  return (
    <>
      <Body id={box.id} geometry={geometry} ap={ap} order={order} />
      <Outline geometry={outline} ap={ap} order={order + total} />
      <mesh geometry={track} position={[0, lid, 0]}>
        <meshBasicMaterial {...material} side={THREE.DoubleSide} color={colors.neutral} opacity={0.15 * ap.fade} />
      </mesh>
      <mesh geometry={gauge} position={[0, lid + 0.01, 0]}>
        <meshBasicMaterial {...material} side={THREE.DoubleSide} color={gaugeColor} opacity={0.75 * ap.fade} />
      </mesh>
      <lineLoop ref={haloRef} geometry={halo} position={[0, lid + 0.3, 0]}>
        <lineBasicMaterial transparent color={ap.status} opacity={0.8 * ap.fade} />
      </lineLoop>
    </>
  );
}

/**
 * A storage cluster (Ceph) as a disk array: a shelf box — its physical disks in the bottom row, each with its OSD
 * (a virtual disk) standing on it, its pools above — with the cluster's fill as a gauge on its lid and a halo above
 * it pulsing while it isn't healthy.
 */
function ArrayLook({ box, node, ap, order, total }: LookProps) {
  const { colors } = useLook();
  const [w, h, d] = box.size;
  const geometry = useMemo(() => roundedBox(box), [box.size.join(), box.radius]);
  const outline = useMemo(() => roundedEdges(box.size, box.radius), [box.size.join(), box.radius]);
  const r = Math.min(w, d) * 0.3;
  const track = useMemo(() => gaugeGeometry(r * 0.8, r * 0.92, 1), [r]);
  const full = ap.fill ?? 0;
  const gauge = useMemo(() => gaugeGeometry(r * 0.8, r * 0.92, full), [r, full]);
  const halo = useMemo(() => ring(r * 1.15), [r]);
  const haloRef = useRef<THREE.LineLoop>(null);
  const ok = node.status === "ok";
  useFrame(({ clock }) => haloRef.current?.scale.setScalar(ok || reducedMotion() ? 1 : 1 + 0.08 * (0.5 + 0.5 * Math.sin(clock.elapsedTime / 0.6))));
  const lid = h / 2 + 0.03;
  const gaugeColor = full >= 0.85 ? colors.error : full >= 0.75 ? colors.warn : colors.cyan;
  return (
    <>
      <Body id={box.id} geometry={geometry} ap={ap} order={order} />
      <Outline geometry={outline} ap={ap} order={order + total} />
      <mesh geometry={track} position={[0, lid, 0]}>
        <meshBasicMaterial {...material} side={THREE.DoubleSide} color={colors.neutral} opacity={0.15 * ap.fade} />
      </mesh>
      <mesh geometry={gauge} position={[0, lid + 0.01, 0]}>
        <meshBasicMaterial {...material} side={THREE.DoubleSide} color={gaugeColor} opacity={0.75 * ap.fade} />
      </mesh>
      <lineLoop ref={haloRef} geometry={halo} position={[0, lid + 0.3, 0]}>
        <lineBasicMaterial transparent color={ap.status} opacity={0.8 * ap.fade} />
      </lineLoop>
    </>
  );
}

/** A firewall: the one box all ingresses sit in — a wall of bricks on its faces toward and away from the viewer. */
function FirewallLook({ box, node, ap, order, total }: LookProps) {
  const [w, h, d] = box.size;
  const bricks = useMemo(() => brickLines(w * 0.92, h * 0.92), [w, h]);
  return (
    <BoxLook box={box} node={node} ap={ap} order={order} total={total}>
      {[d / 2 + 0.02, -d / 2 - 0.02].map((z, i) => (
        <lineSegments key={z} geometry={bricks} position={[0, 0, z]} rotation={[0, i ? Math.PI : 0, 0]}>
          <lineBasicMaterial transparent color={ap.edge} opacity={0.55 * ap.fade} />
        </lineSegments>
      ))}
    </BoxLook>
  );
}

/** An access point: a flat box with Wi-Fi waves over it. */
function ApLook({ box, node, ap, order, total }: LookProps) {
  const { colors } = useLook();
  const [w, h] = box.size;
  const r = Math.min(w, box.size[2]) * 0.3;
  const arcs = useMemo(() => wifiArcs(r).rotateX(-Math.PI / 2), [r]);
  const act = useBlink(ap, box.center[0]);
  return (
    <BoxLook box={box} node={node} ap={ap} order={order} total={total}>
      <lineSegments geometry={arcs} position={[0, h / 2 + r * 0.2, 0]}>
        <lineBasicMaterial transparent color={colors.active} opacity={0.8 * ap.fade} />
      </lineSegments>
      <mesh ref={act} position={[w / 2 - 0.15, 0.12, box.size[2] / 2 + 0.01]}>
        <planeGeometry args={[0.16, 0.16]} />
        <meshBasicMaterial {...material} color={colors.active} opacity={0.12} />
      </mesh>
    </BoxLook>
  );
}

/** A Service: a hexagonal prism, its lid's spokes one per ready pod and a sweep handing each request to the next. */
function HexLook({ box, node, ap, order, total }: LookProps) {
  const { colors } = useLook();
  const r = box.size[0] / 2;
  const h = box.size[1];
  const geometry = useMemo(() => new THREE.CylinderGeometry(r, r, h, 6), [r, h]);
  const outline = useMemo(() => new THREE.EdgesGeometry(geometry), [geometry]);
  const steps = Math.min(12, Math.max(0, num(node.twin.readyEndpoints) ?? 0));
  const fan = useMemo(() => spokes(steps, r * 0.15, r * 0.8).rotateX(-Math.PI / 2), [steps, r]);
  const hand = useMemo(() => spokes(1, 0, r * 0.86).rotateX(-Math.PI / 2), [r]);
  const sweep = useRef<THREE.LineSegments>(null);
  const lit = useRef(ap.lit);
  lit.current = ap.lit;
  useFrame(({ clock }) => {
    if (!sweep.current || !steps || reducedMotion()) return;
    sweep.current.rotation.y = -(Math.floor((clock.elapsedTime * 1000) / (lit.current ? 260 : 700)) % steps) * ((Math.PI * 2) / steps);
  });
  return (
    <>
      <Body id={box.id} geometry={geometry} ap={ap} order={order} />
      <Outline geometry={outline} ap={ap} order={order + total} />
      {steps > 0 && (
        <>
          <lineSegments geometry={fan} position={[0, h / 2 + 0.02, 0]}>
            <lineBasicMaterial transparent color={ap.status} opacity={(ap.strong ? 0.8 : 0.4) * ap.fade} />
          </lineSegments>
          <lineSegments ref={sweep} geometry={hand} position={[0, h / 2 + 0.03, 0]}>
            <lineBasicMaterial transparent color={colors.active} opacity={(ap.strong ? 1 : 0.7) * ap.fade} />
          </lineSegments>
        </>
      )}
    </>
  );
}

/** An Ingress: a portal traffic comes through — its membrane breathing, a lock on the beam with TLS. */
function GateLook({ box, node, ap, order, total }: LookProps) {
  const { colors } = useLook();
  const [w, h] = box.size;
  const geometry = useMemo(() => gateGeometry(box.size), [box.size.join()]);
  const outline = useMemo(() => gateEdges(box.size), [box.size.join()]);
  const t = Math.min(w, h) * 0.16;
  const membrane = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => membrane.current?.scale.setScalar(reducedMotion() ? 1 : 0.94 + 0.06 * (0.5 + 0.5 * Math.sin(clock.elapsedTime / 0.6))));
  return (
    <>
      <Body id={box.id} geometry={geometry} ap={ap} order={order} />
      <Outline geometry={outline} ap={ap} order={order + total} />
      <mesh ref={membrane} position={[0, -t / 2, 0]}>
        <planeGeometry args={[w - 2 * t, h - t]} />
        <meshBasicMaterial {...material} side={THREE.DoubleSide} color={ap.strong ? colors.active : ap.status} opacity={(ap.strong ? 0.22 : 0.1) * ap.fade} />
      </mesh>
      {node.twin.tls === true && (
        <>
          <mesh position={[0, h / 2 + 0.2, 0]}>
            <boxGeometry args={[0.34, 0.26, 0.12]} />
            <meshBasicMaterial transparent color={colors.active} opacity={0.9 * ap.fade} />
          </mesh>
          <mesh position={[0, h / 2 + 0.33, 0]}>
            <torusGeometry args={[0.11, 0.03, 6, 16, Math.PI]} />
            <meshBasicMaterial transparent color={colors.active} opacity={0.9 * ap.fade} />
          </mesh>
        </>
      )}
    </>
  );
}

/**
 * A network interface by its kind: a router a disc, a tunnel a hexagonal one, a load balancer a big disc with a rotor
 * of spokes turning on its face (one per node it hands traffic to), a bridge a bar, the rest a plate. A physical port
 * is a real socket on its face: an RJ45's opening with its clip's notch, its contacts and two lights; a USB-A's
 * opening with its tongue.
 */
function PortLook({ box, node, ap, order, total }: LookProps) {
  const { colors, twin } = useLook();
  const kind = portKind(node);
  const disc = kind === "router" || kind === "tunnel" || kind === "loadbalancer";
  const r = box.size[0] / 2;
  const geometry = useMemo(
    () => (disc ? new THREE.CylinderGeometry(r, r, box.size[2], kind === "tunnel" ? 6 : kind === "loadbalancer" ? 40 : 24).rotateX(Math.PI / 2) : roundedBox(box, 2)),
    [box.size.join(), box.radius, kind],
  );
  const outline = useMemo(() => (disc ? new THREE.EdgesGeometry(geometry) : roundedEdges(box.size, box.radius)), [geometry]);
  return (
    <>
      <Body id={box.id} geometry={geometry} ap={ap} order={order} />
      <Outline geometry={outline} ap={ap} order={order + total} />
      {kind === "loadbalancer" && <Rotor box={box} ap={ap} steps={Math.max(1, twin.relationships.filter((x) => x.$relationshipName === "connectedTo" && x.$sourceId === box.id).length)} colors={colors} />}
      {(kind === "physical" || kind === "usb") && <Socket box={box} ap={ap} usb={kind === "usb"} colors={colors} />}
      {kind === "wifi" && <WifiGlyph box={box} ap={ap} colors={colors} />}
    </>
  );
}

function Rotor({ box, ap, steps, colors }: { box: Box; ap: Appearance; steps: number; colors: Colors }) {
  const r = box.size[0] / 2;
  const rotor = useMemo(() => spokes(steps, r * 0.18, r * 0.82), [steps, r]);
  const rim = useMemo(() => ring(r * 0.95).rotateX(Math.PI / 2), [r]);
  const ref = useRef<THREE.LineSegments>(null);
  const lit = useRef(ap.lit);
  lit.current = ap.lit;
  useFrame((_, delta) => {
    if (ref.current && !reducedMotion()) ref.current.rotation.z -= delta * (lit.current ? 2.4 : 0.5);
  });
  const face = box.size[2] / 2 + 0.02;
  return (
    <>
      <lineSegments ref={ref} geometry={rotor} position={[0, 0, face]}>
        <lineBasicMaterial transparent color={colors.active} opacity={(ap.strong ? 1 : 0.7) * ap.fade} />
      </lineSegments>
      <lineLoop geometry={rim} position={[0, 0, face]}>
        <lineBasicMaterial transparent color={ap.status} opacity={0.8 * ap.fade} />
      </lineLoop>
    </>
  );
}

/** A Wi-Fi port: waves coming out of its face. */
function WifiGlyph({ box, ap, colors }: { box: Box; ap: Appearance; colors: Colors }) {
  const turn = facing(box.normal);
  const normal = new THREE.Vector3(...(box.normal ?? [0, 0, -1]));
  const sideways = Math.abs(normal.x) > 0.5;
  const out = (sideways ? box.size[0] : box.size[2]) / 2;
  const r = Math.min(box.size[0], box.size[1]) * 0.45;
  const arcs = useMemo(() => wifiArcs(r), [r]);
  return (
    <group rotation={[0, turn, 0]}>
      <group position={[0, 0, out + 0.01]}>
        <lineSegments geometry={arcs}>
          <lineBasicMaterial transparent color={colors.active} opacity={0.9 * ap.fade} />
        </lineSegments>
      </group>
    </group>
  );
}

function Socket({ box, ap, usb, colors }: { box: Box; ap: Appearance; usb: boolean; colors: Colors }) {
  const turn = facing(box.normal);
  const normal = new THREE.Vector3(...(box.normal ?? [0, 0, -1]));
  const sideways = Math.abs(normal.x) > 0.5;
  const across = sideways ? box.size[2] : box.size[0];
  const out = (sideways ? box.size[0] : box.size[2]) / 2;
  const h = box.size[1];
  // Everything on the port's face, drawn facing +z in a group turned to the way the port faces.
  const sw = across * 0.7;
  const sh = h * 0.52;
  const sy = -h * 0.08;
  const pins = useMemo(() => pinGeometry(sw * 0.8, sy + sh / 2 - 0.02, sh * 0.3), [sw, sy, sh]);
  const act = useBlink(ap, box.center[0] + box.center[2]);
  return (
    <group rotation={[0, turn, 0]}>
      <group position={[0, 0, out]}>
        {usb ? (
          <>
            <Plate size={[across * 0.84, h * 0.62]} position={[0, 0, 0.004]} color={SOCKET} opacity={0.95 * ap.fade} />
            <Plate size={[across * 0.68, h * 0.2]} position={[0, h * 0.09, 0.008]} color={colors.cyan} opacity={0.9 * ap.fade} />
            <Plate plateRef={act} size={[across * 0.12, h * 0.12]} position={[across * 0.5 + 0.1, h * 0.3, 0.004]} color={colors.active} opacity={0.12} />
          </>
        ) : (
          <>
            <Plate size={[sw, sh]} position={[0, sy, 0.004]} color={SOCKET} opacity={0.95 * ap.fade} />
            <Plate size={[across * 0.3, h * 0.14]} position={[0, sy - sh / 2 - h * 0.06, 0.004]} color={SOCKET} opacity={0.95 * ap.fade} />
            <lineSegments geometry={pins} position={[0, 0, 0.008]}>
              <lineBasicMaterial transparent color={colors.neutral} opacity={0.85 * ap.fade} />
            </lineSegments>
            <Plate size={[across * 0.14, h * 0.12]} position={[-across * 0.36, h * 0.36, 0.004]} color={ap.status} opacity={(ap.linked ? 0.95 : 0.12) * ap.fade} />
            <Plate plateRef={act} size={[across * 0.14, h * 0.12]} position={[across * 0.36, h * 0.36, 0.004]} color={colors.active} opacity={0.12} />
          </>
        )}
      </group>
    </group>
  );
}

/** A model that draws its twins itself (`presentation.visual` with `mode: "replace"`): only the solid's outline,
 * carrying its status, and an invisible body the pointer picks; the model's parts do the rest. */
function OutlineLook({ box, node, ap, order, total }: LookProps) {
  const geometry = useMemo(() => roundedBox(box), [box.size.join(), box.radius]);
  const outline = useMemo(() => roundedEdges(box.size, box.radius), [box.size.join(), box.radius]);
  return (
    <>
      <Body id={box.id} geometry={geometry} ap={{ ...ap, bodyOpacity: 0 }} order={order} />
      <Outline geometry={outline} ap={ap} order={order + total} dash={node.dashed ? DASHED : undefined} />
    </>
  );
}

/** The looks by name: a box's by its twin's look, any other shape by its shape. */
export const LOOK_COMPONENTS: Record<string, LookComponent> = {
  box: BoxLook,
  cluster: ClusterLook,
  cylinder: CylinderLook,
  drum: DrumLook,
  hex: HexLook,
  gate: GateLook,
  port: PortLook,
  ceph: ArrayLook,
  firewall: FirewallLook,
  ap: ApLook,
};
/**
 * The looks drawn from a preset of `presentation.visual` (`VISUAL_PRESETS`) over a plain box: a machine a mini PC's
 * front, a router and a switch their lights and antennas, a disk and a core or memory their load.
 */
const PRESET_LOOKS: Record<string, (node: TwinView) => string | undefined> = {
  node: () => "mini-pc",
  router: () => "router",
  switch: () => "switch",
  drive: (n) => (n.twin.internal === false && n.twin.bus === "usb" ? "usb-disk" : n.children.length ? undefined : "drive"),
  core: (n) => (n.children.length ? undefined : "level-y"),
  memory: (n) => (n.children.length ? undefined : "level-x"),
};
export const presetOf = (node: TwinView) => PRESET_LOOKS[node.look]?.(node);
/** The presets that draw a device whole (its 3D asset): its plain box gives way to the outline and the picking body. */
const WHOLE = new Set(["router", "switch", "usb-disk"]);

export const lookOf = (box: Box, node: TwinView): LookComponent => (box.shape !== "box" ? LOOK_COMPONENTS[box.shape] : LOOK_COMPONENTS[node.look]) ?? BoxLook;

/** One solid of the scene at its place, drawn by its look; drawn again only when its appearance or size changes. */
export const Solid = memo(
  function Solid(props: LookProps) {
    const { colors } = useLook();
    const visual = props.node.visual;
    // A model's own drawing goes over its look, or instead of it.
    const replace = visual?.mode === "replace";
    // The look's own preset (unless the model draws instead of it), then the model's drawing.
    const preset = replace || props.box.shape !== "box" ? undefined : presetOf(props.node);
    const Look = replace || (preset && WHOLE.has(preset)) ? OutlineLook : lookOf(props.box, props.node);
    const presetVisual = useMemo(() => (preset ? { preset } : undefined), [preset]);
    return (
      <group position={props.box.center} visible={!props.ap.hidden}>
        <Look {...props} />
        {presetVisual && <VisualParts visual={presetVisual} node={props.node} box={props.box} ap={props.ap} colors={colors} />}
        {visual && <VisualParts visual={visual} node={props.node} box={props.box} ap={props.ap} colors={colors} />}
      </group>
    );
  },
  (a, b) => a.box === b.box && a.node === b.node && a.order === b.order && a.total === b.total && sameAppearance(a.ap, b.ap),
);
