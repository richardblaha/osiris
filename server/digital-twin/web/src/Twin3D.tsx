import type { Twin, TwinNode, TwinStatus } from "@osiris/shared";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { layoutTwin } from "./TwinLayout.ts";

/** The theme's colours the scene wears, read from the page's CSS variables (light and dark scheme alike). */
function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim() || "#888888";
  return {
    fill: v("--accent-primary-soft"),
    ok: v("--border-strong"),
    warn: v("--state-warning"),
    error: v("--state-error"),
    selected: v("--accent-primary"),
    hover: v("--accent-primary"),
    background: v("--bg-editor"),
  };
}

/**
 * The twin as a 3D WebGL scene (three.js): nested translucent cuboids — every namespace a box, inside it its
 * workloads' and pods' boxes and the containers' small cubes, edges coloured by status. A box can be selected
 * (click) and flown to (double-click); the OSIRIS palette follows the light and dark scheme.
 */
export function Twin3D({ twin, selected, onSelect }: { twin: Twin; selected?: TwinNode; onSelect: (node: TwinNode) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const chosen = useRef(selected);
  chosen.current = selected;

  useEffect(() => {
    const element = host.current!;
    const colors = themeColors();

    // Every node's box in the layout, with its node for picking.
    const scene = layoutTwin(twin.cluster);
    const byId = new Map<string, TwinNode>();
    const walk = (node: TwinNode) => {
      byId.set(node.id, node);
      for (const child of node.children) walk(child);
    };
    walk(twin.cluster);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(element.clientWidth, element.clientHeight);
    element.appendChild(renderer.domElement);

    // Labels are DOM (three.js CSS2D): crisp text in the page's own typeface, above the boxes.
    const labelRenderer = new CSS2DRenderer({ element: document.createElement("div") });
    labelRenderer.setSize(element.clientWidth, element.clientHeight);
    Object.assign(labelRenderer.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    element.appendChild(labelRenderer.domElement);

    const world = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, element.clientWidth / element.clientHeight, 0.1, 2000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.05;

    const statusColor = (status: TwinStatus) => (status === "error" ? colors.error : status === "warn" ? colors.warn : colors.ok);

    /** A node's box: a translucent fill and the edges that carry its status; bigger boxes render first. */
    const meshes: { mesh: THREE.Mesh; edges: THREE.LineSegments; material: THREE.LineBasicMaterial; box: { center: [number, number, number]; size: [number, number, number] }; id: string }[] = [];
    for (const box of scene.boxes) {
      const node = byId.get(box.id)!;
      const geometry = new THREE.BoxGeometry(...box.size);
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(statusColor(node.status)),
        transparent: true,
        opacity: node.kind === "container" ? 0.22 : 0.07,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...box.center);
      const edgeMaterial = new THREE.LineBasicMaterial({ color: new THREE.Color(statusColor(node.status)), transparent: true, opacity: 0.75 });
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial);
      edges.position.set(...box.center);
      mesh.userData = { id: box.id };
      world.add(mesh, edges);
      meshes.push({ mesh, edges, material: edgeMaterial, box, id: box.id });
    }
    // Big, far boxes behind small, near ones, so transparency stacks whole cuboids in the right order.
    meshes.sort((a, b) => b.box.size[0] * b.box.size[2] - a.box.size[0] * a.box.size[2]);
    meshes.forEach((m, i) => {
      m.mesh.renderOrder = i;
      m.edges.renderOrder = i + meshes.length;
    });

    // Namespace labels (workload labels when the cluster is small enough to stay readable).
    const labels: { object: CSS2DObject; node: TwinNode }[] = [];
    for (const box of scene.boxes) {
      const node = byId.get(box.id)!;
      if (node.kind !== "namespace" && !(node.kind === "workload" && twin.cluster.children.length <= 4)) continue;
      const div = document.createElement("div");
      div.className = "twin-label";
      div.dataset.status = node.status;
      div.textContent = node.name;
      const object = new CSS2DObject(div);
      object.position.set(box.center[0], box.center[1] + box.size[1] / 2 + 0.8, box.center[2]);
      world.add(object);
      labels.push({ object, node });
    }

    // The camera fits everything: above at an angle, looking at the middle of the scene.
    const b = scene.bounds;
    const distance = Math.max(b.size[0], b.size[1] * 2, b.size[2]) * 1.15;
    camera.position.set(b.center[0] + distance * 0.7, b.center[1] + distance * 0.75, b.center[2] + distance * 0.7);
    controls.target.set(...b.center);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hovered: string | undefined;

    /** What a pointer event hits: the innermost (smallest) box under it, so pods answer over their namespace. */
    const pick = (event: MouseEvent): TwinNode | undefined => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(meshes.map((m) => m.mesh), false);
      if (!hits.length) return undefined;
      const innermost = hits
        .map((hit) => meshes.find((m) => m.id === hit.object.userData.id)!)
        .sort((a, b) => a.box.size[0] * a.box.size[1] * a.box.size[2] - b.box.size[0] * b.box.size[1] * b.box.size[2])[0]!;
      return byId.get(innermost.id);
    };

    const paint = () => {
      for (const m of meshes) {
        const node = byId.get(m.id)!;
        const isChosen = chosen.current?.id === m.id;
        const isHovered = hovered === m.id;
        const color = isChosen || isHovered ? colors.selected : statusColor(node.status);
        m.material.color = new THREE.Color(color);
        m.material.opacity = isChosen || isHovered ? 1 : 0.75;
        (m.mesh.material as THREE.MeshBasicMaterial).color = new THREE.Color(color);
        (m.mesh.material as THREE.MeshBasicMaterial).opacity = node.kind === "container" ? (isHovered || isChosen ? 0.35 : 0.22) : isHovered || isChosen ? 0.18 : 0.07;
      }
      for (const { object, node } of labels) {
        object.element.dataset.status = node.status;
        object.element.dataset.selected = String(chosen.current?.id === node.id);
      }
    };
    paint();

    const onMove = (event: PointerEvent) => {
      const node = pick(event);
      hovered = node?.id;
      element.style.cursor = node ? "pointer" : "";
      paint();
    };
    const onClick = (event: PointerEvent) => {
      const node = pick(event);
      if (node) select.current(node);
    };
    const onDouble = (event: MouseEvent) => {
      const node = pick(event);
      if (!node) return;
      const box = scene.boxes.find((b) => b.id === node.id)!;
      const target = new THREE.Vector3(...box.center);
      const size = Math.max(...box.size);
      const from = camera.position.clone();
      const fromTarget = controls.target.clone();
      const to = target.clone().add(new THREE.Vector3(1, 0.75, 1).normalize().multiplyScalar(Math.max(size * 2.2, 6)));
      const start = performance.now();
      const fly = () => {
        const t = Math.min(1, (performance.now() - start) / 500);
        const ease = 1 - (1 - t) ** 3;
        camera.position.lerpVectors(from, to, ease);
        controls.target.lerpVectors(fromTarget, target, ease);
        if (t < 1) requestAnimationFrame(fly);
      };
      fly();
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("click", onClick);
    renderer.domElement.addEventListener("dblclick", onDouble);

    let running = true;
    const draw = () => {
      if (!running) return;
      controls.update();
      renderer.render(world, camera);
      labelRenderer.render(world, camera);
      requestAnimationFrame(draw);
    };
    draw();

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
      scheme.removeEventListener("change", schemeChange);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("click", onClick);
      renderer.domElement.removeEventListener("dblclick", onDouble);
      controls.dispose();
      renderer.dispose();
      for (const { mesh, edges } of meshes) {
        mesh.geometry.dispose();
        edges.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        (edges.material as THREE.Material).dispose();
      }
      for (const { object } of labels) object.removeFromParent();
      element.removeChild(renderer.domElement);
      element.removeChild(labelRenderer.domElement);
    };
  }, [twin]);

  return <div ref={host} className="h-full w-full" role="application" aria-label="Digital twin 3D view" />;
}
