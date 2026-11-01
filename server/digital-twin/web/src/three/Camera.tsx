import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { TwinView } from "../scene.ts";
import { reducedMotion, type Content } from "./paint.ts";

/** Steering the camera around what it looks at: degrees about the vertical axis, degrees of tilt, a zoom factor,
 * and moving the look-at point in the camera's plane (`pan`) or straight up/down (`lift`), for the keyboard. */
export interface CameraControl {
  rotate(degrees: number): void;
  tilt(degrees: number): void;
  zoom(factor: number): void;
  pan(right: number, forward: number): void;
  lift(up: number): void;
}

/** A point on the view, in CSS pixels from its top left corner. */
export interface Point {
  x: number;
  y: number;
}

const easeInOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
/** Where the camera looks from at first and going home: above at an angle. */
const HOME = () => new THREE.Spherical(1, 0.95, Math.PI / 4);

/**
 * The camera: orbiting with the pointer (damped, never under the floor), fitting everything once, flying to the
 * selection until it fills the view (once per selection; none: the camera stays), flying home when `home` changes,
 * steered from outside through `control` (the keyboard, the agent's twin_view), and telling `anchor` the selected
 * box's corners on screen for the panels' callout lines.
 */
export function CameraRig({ content, selected, home, control, anchor }: { content: Content | undefined; selected?: TwinView; home: number; control?: RefObject<CameraControl | null>; anchor: RefObject<(() => Point[] | null) | null> }) {
  const { camera: cam, gl, size } = useThree();
  const camera = cam as THREE.PerspectiveCamera;
  const controls = useMemo(() => {
    const c = new OrbitControls(camera, gl.domElement);
    c.enableDamping = true;
    c.maxPolarAngle = Math.PI / 2.05;
    return c;
  }, [camera, gl]);
  useEffect(() => () => controls.dispose(), [controls]);
  useFrame(() => controls.update());

  // One animation at a time: a newer flight stops an older one.
  const flight = useRef(0);
  const animate = (ms: number, step: (k: number) => void, done?: () => void) => {
    const id = ++flight.current;
    if (reducedMotion()) return void (step(1), done?.());
    const start = performance.now();
    const tick = () => {
      if (id !== flight.current) return;
      const k = easeInOut(Math.min(1, (performance.now() - start) / ms));
      step(k);
      if (k < 1) requestAnimationFrame(tick);
      else done?.();
    };
    tick();
  };
  useEffect(() => () => void flight.current++, []);

  /** Flies the camera to look at `center` from far enough that a sphere of `radius` fills the view. */
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
    controls.enabled = false;
    animate(
      900,
      (k) => {
        camera.position.lerpVectors(fromPosition, to, k);
        controls.target.lerpVectors(fromTarget, center, k);
      },
      () => (controls.enabled = true),
    );
  };

  // The camera fits everything once; after that it stays the user's.
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current || !content || !content.scene.boxes.length || !size.width) return;
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const fovH = 2 * Math.atan(Math.tan(fov / 2) * camera.aspect);
    const s = HOME();
    s.radius = (content.bounds.radius / Math.sin(Math.min(fov, fovH) / 2)) * 0.9;
    camera.position.copy(content.bounds.center).add(new THREE.Vector3().setFromSpherical(s));
    controls.target.copy(content.bounds.center);
    controls.update();
    fitted.current = true;
  }, [content, size.width]);

  // The selected twin fills the view, centered with room around it, once per selection.
  const flownTo = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selected) return void (flownTo.current = undefined);
    const box = content?.boxes.get(selected.id);
    if (!box || flownTo.current === selected.id) return;
    flownTo.current = selected.id;
    fly(new THREE.Vector3(...box.center), Math.hypot(...box.size) / 2, 2.4);
  }, [selected, content]);

  useEffect(() => {
    if (!home || !content) return;
    flownTo.current = undefined;
    fly(content.bounds.center, content.bounds.radius, 0.9, HOME());
  }, [home]);

  /** Moves the camera around its target to a new spherical position, animated like the flights. */
  const orbit = (change: (s: THREE.Spherical) => void) => {
    const s = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    change(s);
    s.phi = THREE.MathUtils.clamp(s.phi, 0.15, controls.maxPolarAngle);
    s.radius = THREE.MathUtils.clamp(s.radius, 2, 5000);
    const from = camera.position.clone();
    animate(700, (k) => {
      // Around the target, not through it: interpolate the angles and the distance.
      const a = new THREE.Spherical().setFromVector3(from.clone().sub(controls.target));
      a.theta += (s.theta - a.theta) * k;
      a.phi += (s.phi - a.phi) * k;
      a.radius += (s.radius - a.radius) * k;
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(a));
    });
  };
  const move = (off: THREE.Vector3) => {
    camera.position.add(off);
    controls.target.add(off);
    controls.update();
  };
  useEffect(() => {
    if (!control) return;
    control.current = {
      rotate: (degrees) => orbit((s) => (s.theta += THREE.MathUtils.degToRad(degrees))),
      tilt: (degrees) => orbit((s) => (s.phi -= THREE.MathUtils.degToRad(degrees))),
      zoom: (factor) => orbit((s) => (s.radius /= factor > 0 ? factor : 1)),
      pan: (right, forward) => {
        const k = camera.position.distanceTo(controls.target) * 0.004;
        const r = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        f.y = 0;
        f.normalize();
        move(r.multiplyScalar(right * k).addScaledVector(f, forward * k));
      },
      lift: (up) => move(new THREE.Vector3(0, up * camera.position.distanceTo(controls.target) * 0.004, 0)),
    };
    return () => void (control.current = null);
  }, [control, controls]);

  // The selected box's corners on screen, for the panels' callout lines (none behind the camera).
  const live = useRef({ content, selected, size });
  live.current = { content, selected, size };
  useEffect(() => {
    anchor.current = () => {
      const { content, selected, size } = live.current;
      const box = selected && content?.boxes.get(selected.id);
      if (!box) return null;
      const points: Point[] = [];
      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          for (const sz of [-1, 1]) {
            const p = new THREE.Vector3(box.center[0] + (sx * box.size[0]) / 2, box.center[1] + (sy * box.size[1]) / 2, box.center[2] + (sz * box.size[2]) / 2).project(camera);
            if (p.z < 1) points.push({ x: ((p.x + 1) / 2) * size.width, y: ((1 - p.y) / 2) * size.height });
          }
      return points.length ? points : null;
    };
    return () => void (anchor.current = null);
  }, [anchor, camera]);
  return null;
}
