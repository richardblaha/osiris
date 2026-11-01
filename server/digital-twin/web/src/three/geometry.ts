import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** A position or a size in the scene. */
export type Vec = [number, number, number];

/**
 * A rounded box's outline: each of the 12 edges along the middle of its rounding, joined at every corner by three arcs
 * over the corner's sphere — the box's silhouette, without the facets of the rounding.
 */
export function roundedEdges([w, h, d]: [number, number, number], r: number): THREE.BufferGeometry {
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
export function cylinderEdges(radius: number, height: number): THREE.BufferGeometry {
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

/** An Ingress's outline: a gate — two posts and a beam, seen from the front, with depth. */
export function gateEdges([w, h, d]: [number, number, number]): THREE.BufferGeometry {
  const t = Math.min(w, h) * 0.16;
  const points: number[] = [];
  for (const z of [-d / 2, d / 2]) {
    // The outer frame (no bottom: traffic walks through) and the inner one.
    const outer = [[-w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2], [w / 2, -h / 2]];
    const inner = [[-w / 2 + t, -h / 2], [-w / 2 + t, h / 2 - t], [w / 2 - t, h / 2 - t], [w / 2 - t, -h / 2]];
    for (const line of [outer, inner]) for (let i = 0; i < line.length - 1; i++) points.push(line[i]![0]!, line[i]![1]!, z, line[i + 1]![0]!, line[i + 1]![1]!, z);
    points.push(-w / 2, -h / 2, z, -w / 2 + t, -h / 2, z, w / 2 - t, -h / 2, z, w / 2, -h / 2, z);
  }
  for (const [x, y] of [[-w / 2, h / 2], [w / 2, h / 2], [-w / 2, -h / 2], [w / 2, -h / 2]]) points.push(x!, y!, -d / 2, x!, y!, d / 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** A storage cluster's outline: a drum — its rims, two hoops around its middle and staves down its mantle. */
export function drumEdges(radius: number, height: number): THREE.BufferGeometry {
  const points: number[] = [];
  const N = 64;
  const hoop = (y: number, r: number) => {
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const b = ((i + 1) / N) * Math.PI * 2;
      points.push(Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(b) * r, y, Math.sin(b) * r);
    }
  };
  hoop(-height / 2, radius);
  hoop(height / 2, radius);
  hoop(-height / 6, radius * 1.015);
  hoop(height / 6, radius * 1.015);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    points.push(Math.cos(a) * radius, -height / 2, Math.sin(a) * radius, Math.cos(a) * radius, height / 2, Math.sin(a) * radius);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** A flat arc on a lid: a ring from `inner` to `outer`, `share` of the way round from the front, lying in x/z. */
export const gaugeGeometry = (inner: number, outer: number, share: number) =>
  new THREE.RingGeometry(inner, outer, 64, 1, Math.PI / 2, -Math.max(0.001, Math.min(1, share)) * Math.PI * 2).rotateX(-Math.PI / 2);

/** An Ingress's solid: a portal — two posts and a beam over the way through. */
export function gateGeometry([w, h, d]: [number, number, number]): THREE.BufferGeometry {
  const t = Math.min(w, h) * 0.16;
  const post = (x: number) => new THREE.BoxGeometry(t, h - t, d).translate(x, -t / 2, 0);
  return mergeGeometries([post(-w / 2 + t / 2), post(w / 2 - t / 2), new THREE.BoxGeometry(w, t, d * 1.1).translate(0, h / 2 - t / 2, 0)])!;
}

/** A disk's outline: a cylinder with its platters (rings) inside. */
export function diskEdges(radius: number, height: number): THREE.BufferGeometry {
  const base = cylinderEdges(radius, height).getAttribute("position").array as Float32Array;
  const points = [...base];
  const N = 40;
  for (const k of [0.25, 0.5, 0.75])
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const b = ((i + 1) / N) * Math.PI * 2;
      const y = -height / 2 + k * height;
      const r = radius * 0.92;
      points.push(Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(b) * r, y, Math.sin(b) * r);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** A soft, stable hue for a name (a namespace's tint). */
export const hueOf = (name: string) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 360) / 360;
};

/** A ring of `radius` at height 0, for a storage's fill level. */
export function ring(radius: number): THREE.BufferGeometry {
  const points: number[] = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    points.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** A rectangle of `a` by `b` around the origin, in the x/z plane (or, `upright`, the y/z plane), for a fill's level. */
export function frame(a: number, b: number, upright = false): THREE.BufferGeometry {
  const corners = [[-a / 2, -b / 2], [a / 2, -b / 2], [a / 2, b / 2], [-a / 2, b / 2]];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(corners.flatMap(([u, v]) => (upright ? [0, u!, v!] : [u!, 0, v!])), 3));
  return g;
}

/** `n` spokes from the center of a disc of `radius` (lying in x/y, facing +z), one every 1/n of the way round. */
export function spokes(n: number, inner: number, radius: number): THREE.BufferGeometry {
  const points: number[] = [];
  for (let i = 0; i < Math.max(1, n); i++) {
    const a = Math.PI / 2 - (i / Math.max(1, n)) * Math.PI * 2;
    points.push(Math.cos(a) * inner, Math.sin(a) * inner, 0, Math.cos(a) * radius, Math.sin(a) * radius, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** The dark of a socket's opening. */
export const SOCKET = new THREE.Color("#07090c");

/** How a port faces: the turn about y that takes a part drawn facing +z to face `normal`. */
export const facing = (normal: [number, number, number] | undefined) => {
  const [x, , z] = normal ?? [0, 0, -1];
  return Math.atan2(x, z);
};

/**
 * A cable as a solid tube along its path (cylinders, a ball at each corner) with a plug at each end: a box a little
 * thicker than the cable, along its first and its last segment.
 */
export function cableGeometry(path: [number, number, number][], radius: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const along = (a: THREE.Vector3, b: THREE.Vector3) => new THREE.Quaternion().setFromUnitVectors(up, b.clone().sub(a).normalize());
  const points = path.map((p) => new THREE.Vector3(...p));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = a.distanceTo(b);
    if (length < 1e-6) continue;
    parts.push(new THREE.CylinderGeometry(radius, radius, length, 10, 1, true).applyQuaternion(along(a, b)).translate(...a.clone().add(b).multiplyScalar(0.5).toArray()));
  }
  for (const p of points.slice(1, -1)) parts.push(new THREE.SphereGeometry(radius, 10, 8).translate(p.x, p.y, p.z));
  const plug = (end: THREE.Vector3, next: THREE.Vector3) => {
    const length = Math.min(radius * 7, end.distanceTo(next));
    if (length < 1e-6) return;
    const dir = next.clone().sub(end).normalize();
    parts.push(new THREE.BoxGeometry(radius * 3, length, radius * 2.2).applyQuaternion(along(end, next)).translate(...end.clone().addScaledVector(dir, length / 2).toArray()));
  };
  if (points.length > 1) {
    plug(points[0]!, points[1]!);
    plug(points.at(-1)!, points.at(-2)!);
  }
  return mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
}

/** Slits in rows: a mini PC's vent grille, `w` by `h`, centered. */
export function ventGeometry(w: number, h: number): THREE.BufferGeometry {
  const points: number[] = [];
  const rows = Math.max(2, Math.floor(h / 0.32));
  const slit = 0.42;
  const cols = Math.max(2, Math.floor(w / (slit + 0.2)));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = -w / 2 + c * (w / cols) + (r % 2 ? w / cols / 2 : 0);
      const y = -h / 2 + (r + 0.5) * (h / rows);
      if (x + slit > w / 2) continue;
      points.push(x, y, 0, x + slit, y, 0);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** An RJ45 socket's eight contacts: short lines along the top of its opening. */
export function pinGeometry(w: number, y: number, length: number): THREE.BufferGeometry {
  const points: number[] = [];
  for (let i = 0; i < 8; i++) {
    const x = -w / 2 + ((i + 0.5) * w) / 8;
    points.push(x, y, 0, x, y - length, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return g;
}

/** A soft round dot for the packets. */
export function dotTexture() {
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

