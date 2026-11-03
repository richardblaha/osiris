import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { DtdlInterface, DtdlVisual, Look } from "@osiris/shared/dtdl.ts";
import type { TwinScene, TwinView } from "./scene.ts";
import { LookContext, Solid } from "./three/looks.tsx";
import { blinkRate, themeColors, type Appearance } from "./three/paint.ts";
import type { Box, Shape } from "./TwinLayout.ts";

/** The solid's shape a look is drawn on (as the layout gives it). */
const SHAPE: Partial<Record<Look, Shape>> = { cylinder: "cylinder", disk: "cylinder", ceph: "drum", hex: "hex", gate: "gate", port: "port" };

function Orbit() {
  const { camera, gl } = useThree();
  const controls = useMemo(() => {
    const c = new OrbitControls(camera, gl.domElement);
    c.enableDamping = true;
    c.autoRotate = true;
    c.autoRotateSpeed = 1.2;
    return c;
  }, [camera, gl]);
  useEffect(() => () => controls.dispose(), [controls]);
  useFrame(() => controls.update());
  return null;
}

/**
 * A model's drawing tried out: one solid of the model's look with its drawing (preset and parts), on a twin that is
 * well and busy — load 60 %, traffic and I/O going — turning slowly; drag to look around. It draws with the very
 * components of the 3D view, so what it shows is what the twin will.
 */
export default function VisualPreview({
  model,
  visual,
  size,
  componentSha256,
}: {
  model: DtdlInterface;
  visual?: DtdlVisual;
  size: readonly [number, number, number];
  componentSha256?: string;
}) {
  const [colors] = useState(themeColors);
  const look = model.presentation?.look ?? "box";
  const node: TwinView = useMemo(
    () => ({
      id: "preview",
      twin: { $dtId: "preview", $metadata: { $model: model["@id"] }, name: "preview", status: "ok", readyEndpoints: 3 },
      model: model["@id"],
      modelName: "",
      name: "preview",
      ownStatus: "ok",
      status: "ok",
      ownErrors: 0,
      errors: 0,
      network: 2_000_000,
      resources: { load: 0.6, io: 5_000_000, used: 3, size: 4, cpu: 0.5, memory: 1e9 },
      values: { load: 0.6, cpu: 0.5, memory: 1e9, temperature: 45 },
      component: componentSha256,
      depth: 1,
      children: [],
      look,
      labelProp: "name",
      layer: "base",
      visible: true,
      visual,
    }),
    [model, visual, look, componentSha256],
  );
  const box: Box = useMemo(() => ({ id: "preview", shape: SHAPE[look] ?? "box", center: [0, size[1] / 2, 0], size: [...size], radius: 0.12 }), [look, size.join()]);
  const hex = (c: { getHexString(): string }) => `#${c.getHexString()}`;
  const ap: Appearance = {
    hidden: false,
    fade: 1,
    strong: false,
    lit: false,
    edge: model.presentation?.color ?? hex(colors.cyan),
    edgeOpacity: 0.8,
    body: look === "node" || look === "switch" || look === "router" ? hex(colors.neutral) : (model.presentation?.color ?? hex(colors.cyan)),
    bodyOpacity: look === "switch" || look === "router" ? 0.55 : 0.12,
    status: hex(colors.cyan),
    fill: 0.6,
    fillColor: hex(colors.cyan),
    fillOpacity: 0.45,
    rate: blinkRate(5_000_000),
    linked: true,
  };
  const twin = useMemo<TwinScene>(() => ({ models: new Map(), byId: new Map(), top: [], bands: [], relationships: [], at: null }), []);
  const looks = useMemo(() => ({ colors, twin, pick: new Map() }), [colors, twin]);
  const far = Math.max(...size) * 2.2;
  return (
    <Canvas flat dpr={[1, 2]} gl={{ antialias: true, alpha: true }} camera={{ fov: 40, position: [far, far * 0.8, far], near: 0.05, far: 500 }}>
      <ambientLight intensity={1.4} />
      <directionalLight position={[1, 2, 1.5]} intensity={1.6} />
      <gridHelper args={[Math.max(...size) * 3, 12, colors.neutral, colors.neutral]} position={[0, 0, 0]} />
      <LookContext.Provider value={looks}>
        <Solid box={box} node={node} ap={ap} order={0} total={1} />
      </LookContext.Provider>
      <Orbit />
    </Canvas>
  );
}
