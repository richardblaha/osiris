import { useFrame } from "@react-three/fiber";
import { t } from "i18next";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { Link } from "../TwinLayout.ts";
import { cableGeometry, dotTexture } from "./geometry.ts";
import { reducedMotion, type Colors, type Content, type LinkPaint, type LinkPath } from "./paint.ts";

/** Most packets a link carries at once (at its container's highest load). */
const MAX_PACKETS = 5;

/** The tunnels between nodes, the routing and storage relations are dashed. */
const isDashed = (l: Link) => l.kind === "overlay" || l.kind === "virtual" || l.kind === "storage";

/** Line segments of the links given, with a colour (and alpha) per vertex, so each link fades on its own. */
function linesOf(list: LinkPath[]) {
  const segments = list.flatMap((l) => l.path.slice(1).flatMap((p, i) => [...l.path[i]!, ...p]));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array((segments.length / 3) * 4), 4));
  return g;
}

/**
 * The links between interfaces: solid and dashed lines (each link's colour and opacity from `paint`), a dot where each
 * meets a wall, the packets travelling them as many and as fast as their load says (with `traffic`), and the cables a
 * machine is plugged in with as solid tubes with plugs, pulsing with their traffic.
 */
export function Links({ content, paint, traffic, inView, colors, order }: { content: Content; paint: LinkPaint; traffic: boolean; inView: (l: LinkPath) => boolean; colors: Colors; order: number }) {
  const { links } = content;
  const dot = useMemo(() => dotTexture(), []);
  useEffect(() => () => dot.dispose(), [dot]);
  const { solid, dashed, at, ends, packets } = useMemo(() => {
    const at: { dashed: boolean; from: number }[] = [];
    const counts = { solid: 0, dashed: 0 };
    for (const l of links) {
      const d = isDashed(l);
      at.push({ dashed: d, from: d ? counts.dashed : counts.solid });
      counts[d ? "dashed" : "solid"] += (l.path.length - 1) * 2;
    }
    const ends = new THREE.BufferGeometry();
    const points = links.flatMap((l) => [l.path[0]!, l.path.at(-1)!]);
    ends.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3));
    ends.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(points.length * 4), 4));
    const packets = new THREE.BufferGeometry();
    packets.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(links.length * MAX_PACKETS * 3), 3));
    packets.setDrawRange(0, 0);
    return { solid: linesOf(links.filter((l) => !isDashed(l))), dashed: linesOf(links.filter(isDashed)), at, ends, packets };
  }, [links]);
  const dashedRef = useRef<THREE.LineSegments>(null);
  useLayoutEffect(() => void dashedRef.current?.computeLineDistances(), [dashed]);

  // The links' colours, written into their vertices whenever the view changes.
  useEffect(() => {
    const s = solid.getAttribute("color") as THREE.BufferAttribute;
    const d = dashed.getAttribute("color") as THREE.BufferAttribute;
    const e = ends.getAttribute("color") as THREE.BufferAttribute;
    links.forEach((l, k) => {
      const [r, g, b, a] = paint.color.subarray(k * 4, k * 4 + 4);
      const where = at[k]!;
      const target = where.dashed ? d : s;
      for (let i = 0; i < (l.path.length - 1) * 2; i++) target.setXYZW(where.from + i, r!, g!, b!, a!);
      for (const v of [2 * k, 2 * k + 1]) e.setXYZW(v, r!, g!, b!, paint.dots[k]!);
    });
    s.needsUpdate = d.needsUpdate = e.needsUpdate = true;
  }, [paint, solid, dashed, ends, at, links]);

  // The packets now: each link's packets spread along it, half going out and half coming in.
  const packetsRef = useRef<THREE.Points>(null);
  const live = useRef({ paint, traffic, inView });
  live.current = { paint, traffic, inView };
  useFrame(({ clock }) => {
    const { paint, traffic, inView } = live.current;
    if (!traffic) return void packets.setDrawRange(0, 0);
    const position = packets.getAttribute("position") as THREE.BufferAttribute;
    const still = reducedMotion();
    const time = clock.elapsedTime;
    let n = 0;
    for (const [k, l] of links.entries()) {
      const load = paint.loads[k] ?? 0;
      if (load <= 0 || !inView(l)) continue;
      const count = 1 + Math.round(load * (MAX_PACKETS - 1));
      const speed = 1.5 + 9 * load; // scene units per second
      for (let j = 0; j < count; j++) {
        let f = (((still ? 0 : time) * speed) / l.total + j / count) % 1;
        if (j % 2) f = 1 - f;
        let dist = f * l.total;
        let i = 0;
        while (i < l.lengths.length - 1 && dist > l.lengths[i]!) dist -= l.lengths[i++]!;
        const a = l.path[i]!;
        const b = l.path[i + 1]!;
        const s = Math.min(1, dist / (l.lengths[i] || 1));
        position.setXYZ(n++, a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s);
      }
    }
    position.needsUpdate = true;
    packets.setDrawRange(0, n);
  });

  return (
    <>
      <lineSegments geometry={solid} renderOrder={-1}>
        <lineBasicMaterial vertexColors transparent depthWrite={false} />
      </lineSegments>
      <lineSegments ref={dashedRef} geometry={dashed} renderOrder={-1}>
        <lineDashedMaterial vertexColors transparent depthWrite={false} dashSize={0.35} gapSize={0.25} />
      </lineSegments>
      {[...paint.tubes.entries()].map(([k, tube]) => (
        <Cable key={`${links[k]!.kind}:${links[k]!.id}:${links[k]!.to ?? ""}:${k}`} link={links[k]!} tube={tube} load={paint.loads[k] ?? 0} order={order - 1} />
      ))}
      <points ref={packetsRef} geometry={packets} renderOrder={order} frustumCulled={false}>
        <pointsMaterial size={7} sizeAttenuation={false} map={dot} transparent depthWrite={false} color={colors.cyan} />
      </points>
      <points geometry={ends} renderOrder={order}>
        <pointsMaterial size={5} sizeAttenuation={false} map={dot} vertexColors transparent depthWrite={false} />
      </points>
    </>
  );
}

/** A cable drawn solid: a tube with its plugs, pulsing brighter and dimmer, faster the more goes through it. */
function Cable({ link, tube, load, order }: { link: LinkPath; tube: { shown: boolean; color: string; base: number }; load: number; order: number }) {
  const geometry = useMemo(() => cableGeometry(link.path, link.radius ?? (link.kind === "cable" ? 0.1 : 0.075)), [link]);
  const ref = useRef<THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>(null);
  const live = useRef({ load, base: tube.base });
  live.current = { load, base: tube.base };
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const { load, base } = live.current;
    m.material.opacity = load > 0 && !reducedMotion() ? base * (0.7 + 0.3 * Math.sin(clock.elapsedTime * (1 + 6 * load) * Math.PI * 2)) : base;
  });
  return (
    <mesh ref={ref} geometry={geometry} visible={tube.shown} renderOrder={order}>
      <meshBasicMaterial transparent depthWrite={false} color={tube.color} opacity={tube.base} />
    </mesh>
  );
}

/** The internet: a wireframe globe behind each outermost twin, turning slowly, named; shown while a line reaches it. */
export function Globes({ content, paint, colors, dim }: { content: Content; paint: LinkPaint; colors: Colors; dim: boolean }) {
  return (
    <>
      {content.scene.internet.map((n) => (
        <Globe key={n.id} center={n.center} radius={n.radius} shown={paint.globes.has(n.id)} color={colors.cyan} dim={dim} />
      ))}
    </>
  );
}

function Globe({ center, radius, shown, color, dim }: { center: [number, number, number]; radius: number; shown: boolean; color: THREE.Color; dim: boolean }) {
  const geometry = useMemo(() => new THREE.WireframeGeometry(new THREE.SphereGeometry(radius, 18, 12)), [radius]);
  const ref = useRef<THREE.LineSegments>(null);
  const label = useMemo(() => {
    const div = document.createElement("div");
    div.className = "twin-label-globe";
    div.textContent = t("twin:internet");
    return new CSS2DObject(div);
  }, []);
  useEffect(() => () => void label.removeFromParent(), [label]);
  useFrame(({ clock }) => {
    if (ref.current && !reducedMotion()) ref.current.rotation.y = clock.elapsedTime / 12;
  });
  label.visible = shown && !dim;
  return (
    <>
      <lineSegments ref={ref} geometry={geometry} position={center} visible={shown}>
        <lineBasicMaterial transparent depthWrite={false} color={color} opacity={dim ? 0.08 : 0.4} />
      </lineSegments>
      <primitive object={label} position={[center[0], center[1] + radius * 1.25, center[2]]} />
    </>
  );
}
