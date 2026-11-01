import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { VisualAxis, VisualPart } from "@osiris/shared/dtdl.ts";
import { visualNumber, visualWhen, type TwinView } from "../scene.ts";
import type { Box } from "../TwinLayout.ts";
import { loadLevel } from "./info.ts";
import { blinkRate, reducedMotion, statusColor, type Appearance, type Colors } from "./paint.ts";

type V3 = [number, number, number];
const AXIS: Record<VisualAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
const DEG = Math.PI / 180;

/** Each shape at unit size, centered: a part scales it to its size. */
const UNIT: Record<VisualPart["shape"], () => THREE.BufferGeometry> = {
  box: () => new THREE.BoxGeometry(1, 1, 1),
  cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 32),
  sphere: () => new THREE.SphereGeometry(0.5, 24, 16),
  plane: () => new THREE.PlaneGeometry(1, 1),
};
const geometries = new Map<string, { body: THREE.BufferGeometry; edges: THREE.BufferGeometry }>();
/** The shapes' geometries, made once and shared by every part (never disposed: a handful for the whole app). */
function unit(shape: VisualPart["shape"]) {
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

function Copy({ part, index, node, box, ap, colors }: { part: VisualPart; index: number; node: TwinView; box: Box; ap: Appearance; colors: Colors }) {
  const { body, edges } = unit(part.shape);
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
  const opacity = (part.opacity ?? 0.8) * ap.fade;
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

/** A model's own drawing: its parts in the solid's frame, each following the twin's values. */
export function VisualParts({ parts, node, box, ap, colors }: { parts: VisualPart[]; node: TwinView; box: Box; ap: Appearance; colors: Colors }) {
  return (
    <>
      {parts.map((part, i) => (
        <Part key={i} part={part} node={node} box={box} ap={ap} colors={colors} />
      ))}
    </>
  );
}
