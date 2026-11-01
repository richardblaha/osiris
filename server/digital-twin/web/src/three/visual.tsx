import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { api, currentInstance } from "../api.ts";
import { visualParts, type DtdlVisual, type VisualAxis, type VisualPart } from "@osiris/shared/dtdl.ts";
import { visualNumber, visualWhen, type TwinView } from "../scene.ts";
import type { Box } from "../TwinLayout.ts";
import { loadLevel } from "./info.ts";
import { blinkRate, reducedMotion, statusColor, type Appearance, type Colors } from "./paint.ts";

type V3 = [number, number, number];
const AXIS: Record<VisualAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
const DEG = Math.PI / 180;

/** Each shape at unit size, centered: a part scales it to its size. */
const UNIT: Record<Exclude<VisualPart["shape"], "gltf">, () => THREE.BufferGeometry> = {
  box: () => new THREE.BoxGeometry(1, 1, 1),
  cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 32),
  sphere: () => new THREE.SphereGeometry(0.5, 24, 16),
  plane: () => new THREE.PlaneGeometry(1, 1),
};
const geometries = new Map<string, { body: THREE.BufferGeometry; edges: THREE.BufferGeometry }>();
/** The shapes' geometries, made once and shared by every part (never disposed: a handful for the whole app). */
function unit(shape: Exclude<VisualPart["shape"], "gltf">) {
  let g = geometries.get(shape);
  if (!g) {
    const body = UNIT[shape]();
    g = { body, edges: new THREE.EdgesGeometry(body, 20) };
    geometries.set(shape, g);
  }
  return g;
}

/** A part's colour: one of the theme's by name, its value's band (`level`), else its own `#rrggbb`. */
function colorOf(part: VisualPart, node: TwinView, ap: Appearance, colors: Colors): THREE.ColorRepresentation {
  const c = part.color ?? "status";
  if (c === "status") return ap.strong ? colors.active : ap.status;
  if (c === "accent") return colors.cyan;
  if (c === "active") return colors.active;
  if (c === "neutral") return colors.neutral;
  if (c === "warn") return colors.warn;
  if (c === "error") return colors.error;
  if (c === "level") return statusColor(colors, loadLevel(part.fill ? visualNumber(node, part.fill.value) : 0));
  if (c === "body") return ap.body;
  return c;
}

/** One part (and its copies), following the twin's values. */
function Part({ part, node, box, ap, colors }: { part: VisualPart; node: TwinView; box: Box; ap: Appearance; colors: Colors }) {
  const shown = !part.when || visualWhen(node, part.when);
  const count = part.repeat ? Math.max(0, Math.min(64, Math.floor(typeof part.repeat.count === "number" ? part.repeat.count : visualNumber(node, part.repeat.count)))) : 1;
  if (!shown || !count) return null;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Copy key={i} part={part} index={i} node={node} box={box} ap={ap} colors={colors} />
      ))}
    </>
  );
}

/** The twin's 3D assets, loaded once each (by instance and name) and shared: every part draws its own copy. */
const assets = new Map<string, Promise<THREE.Object3D>>();
function loadAsset(name: string): Promise<THREE.Object3D> {
  const key = `${currentInstance()}\u0000${name}`;
  let p = assets.get(key);
  if (!p) {
    p = api.assetBytes(name).then((bytes) => new GLTFLoader().parseAsync(bytes, "").then((gltf) => gltf.scene));
    p.catch(() => assets.delete(key));
    assets.set(key, p);
  }
  return p;
}

/**
 * A `gltf` part: the asset fitted into the part's size keeping its proportions (centered in it), in its own
 * materials — tinted with the part's colour when it names one, faded with its solid. Nothing while it loads or when
 * it can't.
 */
function Asset({ part, size, color, opacity }: { part: VisualPart; size: V3; color?: THREE.ColorRepresentation; opacity: number }) {
  const [scene, setScene] = useState<THREE.Object3D>();
  useEffect(() => {
    let current = true;
    if (part.asset) void loadAsset(part.asset).then((s) => current && setScene(s), () => {});
    return () => void (current = false);
  }, [part.asset]);
  const copy = useMemo(() => {
    if (!scene) return undefined;
    const object = scene.clone(true);
    const bounds = new THREE.Box3().setFromObject(object);
    const extent = bounds.getSize(new THREE.Vector3());
    // Its proportions kept (the least scale of the three), or stretched to the size.
    const per = [0, 1, 2].map((i) => size[i]! / Math.max(1e-6, extent.getComponent(i)));
    const least = Math.min(...per);
    const scale = new THREE.Vector3(...(part.fit === "stretch" ? per : [least, least, least]));
    const center = bounds.getCenter(new THREE.Vector3());
    object.position.sub(center.multiply(scale));
    object.scale.multiply(scale);
    const fitted = new THREE.Group();
    fitted.add(object);
    // Each copy its own materials, so a fade or a tint never reaches another part.
    object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
    });
    return fitted;
  }, [scene, size.join()]);
  useEffect(() => {
    copy?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of [mesh.material].flat() as (THREE.Material & { color?: THREE.Color })[]) {
        m.transparent = opacity < 1;
        m.opacity = opacity;
        m.depthWrite = opacity >= 1;
        if (color !== undefined && m.color) m.color.set(color);
      }
    });
  }, [copy, opacity, color]);
  return copy ? <primitive object={copy} /> : null;
}

function Copy({ part, index, node, box, ap, colors }: { part: VisualPart; index: number; node: TwinView; box: Box; ap: Appearance; colors: Colors }) {
  const size: V3 = [0, 1, 2].map((i) => (part.size?.[i] ?? 1) * box.size[i]!) as V3;
  const at: V3 = [0, 1, 2].map((i) => (part.at?.[i] ?? 0) * box.size[i]!) as V3;
  if (part.repeat) at[AXIS[part.repeat.axis ?? "x"]] += index * part.repeat.step * box.size[AXIS[part.repeat.axis ?? "x"]]!;
  // A fill grows from the part's start along its axis as far as its value says.
  if (part.fill) {
    const axis = AXIS[part.fill.axis ?? "y"];
    const share = Math.max(0.001, Math.min(1, visualNumber(node, part.fill.value)));
    at[axis] += -size[axis] / 2 + (size[axis] * share) / 2;
    size[axis] *= share;
  }
  const color = colorOf(part, node, ap, colors);
  // The body's colour carries the body's opacity too (already faded), unless the part says its own.
  const opacity = part.color === "body" && part.opacity === undefined ? ap.bodyOpacity : (part.opacity ?? (part.shape === "gltf" ? 1 : 0.8)) * ap.fade;
  const rotation = useMemo(() => new THREE.Euler(...((part.rotate ?? [0, 0, 0]).map((d) => d * DEG) as V3)), [part.rotate?.join()]);
  const group = useRef<THREE.Group>(null);
  const material = useRef<THREE.MeshBasicMaterial>(null);
  const live = useRef({ node, opacity });
  live.current = { node, opacity };
  // A blinking light and a turning part move every frame, without drawing the scene's React tree again.
  useFrame(({ clock }, delta) => {
    const { node, opacity } = live.current;
    if (part.blink && material.current) {
      const rate = blinkRate(visualNumber(node, part.blink));
      const on = reducedMotion() ? rate > 0 : rate > 0 && Math.sin(clock.elapsedTime * rate * Math.PI * 2 + index) > -0.2;
      material.current.opacity = on ? opacity : opacity * 0.15;
    }
    if (part.spin !== undefined && group.current && !reducedMotion()) {
      const turns = typeof part.spin === "number" ? part.spin : visualNumber(node, part.spin);
      group.current.rotation.y += delta * turns * Math.PI * 2;
    }
  });
  if (part.shape === "gltf")
    return (
      <group position={at} rotation={rotation}>
        <group ref={group}>
          <Asset part={part} size={size} color={part.color ? color : undefined} opacity={opacity} />
        </group>
      </group>
    );
  const { body, edges } = unit(part.shape);
  return (
    <group position={at} rotation={rotation}>
      <group ref={group} scale={size}>
        <mesh geometry={body}>
          <meshBasicMaterial ref={material} transparent depthWrite={false} side={part.shape === "plane" ? THREE.DoubleSide : THREE.FrontSide} color={color} opacity={opacity} />
        </mesh>
        {part.outline && (
          <lineSegments geometry={edges}>
            <lineBasicMaterial transparent color={color} opacity={Math.min(1, opacity + 0.15)} />
          </lineSegments>
        )}
      </group>
    </group>
  );
}

/** A drawing (a model's own, or a look's preset): its parts in the solid's frame, each following the twin's values. */
export function VisualParts({ visual, node, box, ap, colors }: { visual: DtdlVisual; node: TwinView; box: Box; ap: Appearance; colors: Colors }) {
  const parts = useMemo(() => visualParts(visual), [visual]);
  return (
    <>
      {parts.map((part, i) => (
        <Part key={i} part={part} node={node} box={box} ap={ap} colors={colors} />
      ))}
    </>
  );
}
