import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { iconOf, portKind } from "../icons.ts";
import type { TwinView } from "../scene.ts";
import type { Box } from "../TwinLayout.ts";
import { kindAndInfo, LOD } from "./info.ts";
import { hidden, inFocus, isAncestor, type ViewState } from "./paint.ts";

/** A label's content: the Kubernetes icon, the name, and a line of kind and state. */
function fillLabel(el: HTMLElement, node: TwinView, focus: TwinView | undefined) {
  el.dataset.status = node.status;
  el.dataset.selected = String(focus?.id === node.id);
  el.dataset.dashed = String(!!node.dashed);
  const name = el.querySelector(".twin-label-name")!;
  const info = el.querySelector(".twin-label-info")!;
  if (name.textContent !== node.name) name.textContent = node.name;
  const line = kindAndInfo(node);
  if (info.textContent !== line) info.textContent = line;
}

/** A twin's label: at its solid's top front left corner, growing up and right. */
function makeLabel(node: TwinView, box: Box) {
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
  const label = new CSS2DObject(el);
  const left = box.center[0] - box.size[0] / 2 + Math.min(box.radius, box.size[0] / 4);
  label.position.set(left, box.center[1] + box.size[1] / 2, box.center[2] + box.size[2] / 2);
  return label;
}

/**
 * The labels (DOM, three.js CSS2D: crisp text in the page's own typeface). Level of detail: each solid's size on
 * screen decides what its label shows — nothing when small, the icon, then the name, then the kind and state; outside
 * the selection only its surroundings keep labels. The interfaces' addresses (a port's name and IP, a Service's
 * virtual address) show once what they belong to shows its name.
 */
export function Labels({ view, mode, addresses }: { view: ViewState; mode: "auto" | "all" | "off"; addresses: boolean }) {
  const { scene, camera, size } = useThree();
  const { content } = view;
  const group = useMemo(() => new THREE.Group(), []);
  const labels = useRef(new Map<string, CSS2DObject>());
  // The addresses at the interfaces, made with the scene.
  const ports = useMemo(() => {
    const out: { object: CSS2DObject; node: string; owner: string }[] = [];
    for (const b of content.scene.boxes) {
      const node = content.byId.get(b.id);
      if (!node || (b.shape !== "port" && b.shape !== "hex")) continue;
      const ip = String(node.twin.ip ?? node.twin.clusterIP ?? "");
      const name = b.shape === "port" && node.name !== ip ? `${node.name} ` : "";
      if (!ip && !name) continue;
      const div = document.createElement("div");
      div.className = "twin-port";
      div.dataset.kind = b.shape === "port" ? portKind(node) : "service";
      div.textContent = `${name}${ip}`.trim();
      const object = new CSS2DObject(div);
      object.position.set(b.center[0], b.center[1] + b.size[1] / 2, b.center[2]);
      object.visible = false;
      out.push({ object, node: node.id, owner: node.parent && b.shape === "port" ? node.parent.id : node.id });
    }
    return out;
  }, [content.scene]);
  useEffect(() => {
    scene.add(group);
    return () => void scene.remove(group);
  }, [scene, group]);
  useEffect(() => {
    for (const p of ports) group.add(p.object);
    return () => {
      for (const p of ports) p.object.removeFromParent();
    };
  }, [ports, group]);
  // A new layout drops the labels of the old one.
  useEffect(() => {
    const map = labels.current;
    return () => {
      for (const l of map.values()) l.removeFromParent();
      map.clear();
    };
  }, [content.scene]);
  // The labels' content follows the twins.
  useEffect(() => {
    for (const [id, label] of labels.current) {
      const node = content.byId.get(id);
      if (node) fillLabel(label.element, node, view.focus);
    }
  }, [view]);

  const live = useRef({ view, mode, addresses });
  live.current = { view, mode, addresses };
  const at = useRef(0);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock }) => {
    const time = clock.elapsedTime * 1000;
    if (time - at.current < 120) return;
    at.current = time;
    const { view, mode, addresses } = live.current;
    const { content } = view;
    const cam = camera as THREE.PerspectiveCamera;
    const scale = size.height / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    const focus = view.focus && content.boxes.has(view.focus.id) ? view.focus : undefined;
    const levels = new Map<string, number>();
    for (const box of content.scene.boxes) {
      const node = content.byId.get(box.id);
      if (!node) continue;
      const distance = Math.max(0.1, tmp.set(...box.center).distanceTo(cam.position));
      const px = (Math.max(box.size[0], box.size[2]) / distance) * scale;
      const near = (!focus || inFocus(view, node) || isAncestor(node, focus)) && !hidden(view, node);
      const auto = px >= LOD.info ? 3 : px >= LOD.name ? 2 : px >= LOD.icon ? 1 : 0;
      const level = !near || mode === "off" ? 0 : mode === "all" ? Math.max(2, auto) : auto;
      levels.set(box.id, level);
      let label = labels.current.get(box.id);
      if (!level && !label) continue;
      if (!label) {
        label = makeLabel(node, box);
        fillLabel(label.element, node, view.focus);
        labels.current.set(box.id, label);
        group.add(label);
      }
      label.visible = level > 0;
      if (label.element.dataset.lod !== String(level)) label.element.dataset.lod = String(level);
    }
    for (const p of ports) {
      const owner = content.byId.get(p.owner);
      p.object.visible = addresses && !hidden(view, content.byId.get(p.node)) && !hidden(view, owner) && ((levels.get(p.owner) ?? 0) >= 2 || (!!focus && (focus.id === p.owner || view.path.has(p.owner))));
    }
  });
  return null;
}
