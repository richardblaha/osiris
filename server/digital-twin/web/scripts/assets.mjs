// Generates the twin's built-in 3D assets (server/digital-twin/assets/*.glb): a mini PC, a home router, a desktop
// switch and a 2.5" USB disk, made of three.js primitives at their real size in millimetres, without any badge or
// brand. Run `node scripts/assets.mjs` in server/digital-twin/web; the files are committed.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// GLTFExporter reads its binary through a FileReader, which Node doesn't have.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    void blob.arrayBuffer().then((r) => ((this.result = r), this.onloadend?.()));
  }
  readAsDataURL(blob) {
    void blob.arrayBuffer().then((r) => ((this.result = `data:${blob.type};base64,${Buffer.from(r).toString("base64")}`), this.onloadend?.()));
  }
};

const out = join(dirname(fileURLToPath(import.meta.url)), "../../assets");
mkdirSync(out, { recursive: true });

/** Materials by finish. */
const mat = {
  graphite: new THREE.MeshStandardMaterial({ name: "graphite", color: 0x2c2f34, metalness: 0.55, roughness: 0.42 }),
  graphiteLight: new THREE.MeshStandardMaterial({ name: "graphite-light", color: 0x41454c, metalness: 0.5, roughness: 0.5 }),
  bezel: new THREE.MeshStandardMaterial({ name: "bezel", color: 0x1c1e22, metalness: 0.2, roughness: 0.6 }),
  hole: new THREE.MeshStandardMaterial({ name: "hole", color: 0x050506, metalness: 0, roughness: 1 }),
  silver: new THREE.MeshStandardMaterial({ name: "silver", color: 0xb9bec6, metalness: 0.9, roughness: 0.25 }),
  usbBlue: new THREE.MeshStandardMaterial({ name: "usb-blue", color: 0x1f5fd0, metalness: 0.1, roughness: 0.5 }),
  rubber: new THREE.MeshStandardMaterial({ name: "rubber", color: 0x111111, metalness: 0, roughness: 0.95 }),
  gloss: new THREE.MeshStandardMaterial({ name: "gloss-black", color: 0x151618, metalness: 0.3, roughness: 0.18 }),
  matte: new THREE.MeshStandardMaterial({ name: "matte-black", color: 0x1e1f22, metalness: 0.05, roughness: 0.85 }),
  aluminium: new THREE.MeshStandardMaterial({ name: "aluminium", color: 0x9aa1aa, metalness: 0.8, roughness: 0.35 }),
  led: new THREE.MeshStandardMaterial({ name: "led", color: 0xffffff, emissive: 0x9fd8ff, emissiveIntensity: 1.2 }),
  ledGreen: new THREE.MeshStandardMaterial({ name: "led-green", color: 0xffffff, emissive: 0x39d353, emissiveIntensity: 1.2 }),
};

/** A model built part by part: each part a geometry placed in millimetres, merged per material into one mesh. */
function model(name) {
  const parts = new Map();
  const add = (material, geometry, [x, y, z] = [0, 0, 0], rotation) => {
    if (rotation) geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation)));
    geometry.translate(x, y, z);
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    g.deleteAttribute("uv");
    (parts.get(material) ?? parts.set(material, []).get(material)).push(g);
  };
  const box = (material, [w, h, d], at, rotation) => add(material, new THREE.BoxGeometry(w, h, d), at, rotation);
  const rounded = (material, [w, h, d], r, at) => add(material, new RoundedBoxGeometry(w, h, d, 3, r), at);
  const cylinder = (material, r, h, at, rotation, segments = 24) => add(material, new THREE.CylinderGeometry(r, r, h, segments), at, rotation);
  const done = async () => {
    const scene = new THREE.Scene();
    const root = new THREE.Group();
    root.name = name;
    for (const [material, geometries] of parts) {
      const mesh = new THREE.Mesh(mergeGeometries(geometries), material);
      mesh.name = material.name;
      root.add(mesh);
    }
    // Millimetres to metres, as glTF expects.
    root.scale.setScalar(0.001);
    scene.add(root);
    const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
    writeFileSync(join(out, `${name}.glb`), Buffer.from(glb));
    console.log(`${name}.glb`, glb.byteLength, "bytes");
  };
  return { add, box, rounded, cylinder, done };
}

/** A grid of square holes on a face facing +z (a vent grille), its center at `at`. */
function grille(m, material, cols, rows, pitch, size, at, rotation) {
  const holes = [];
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) {
      const g = new THREE.BoxGeometry(size, size, 1.2);
      g.translate((c - (cols - 1) / 2) * pitch + (r % 2 ? pitch / 2 : 0), (r - (rows - 1) / 2) * pitch, 0);
      holes.push(g.toNonIndexed());
    }
  m.add(material, mergeGeometries(holes), at, rotation);
}

/** A USB-A socket on a face facing +z: its opening and its tongue. */
function usbA(m, [x, y, z]) {
  m.box(mat.silver, [13.2, 5.6, 0.6], [x, y, z]);
  m.box(mat.hole, [12, 4.5, 0.8], [x, y, z + 0.1]);
  m.box(mat.usbBlue, [10, 1.6, 0.9], [x, y + 0.9, z + 0.2]);
}

// A mini PC (177 × 34 × 175 mm), its front facing +z: a graphite chassis with a lighter top, a black front with a
// vent grille over most of it, a power button with its light, two USB-A, a USB-C and an audio jack at the right,
// slits along its left side and rubber feet. Its back and right side stay plain: the twin mounts its own ports there.
{
  const m = model("mini-pc");
  const [W, H, D] = [177, 34, 175];
  m.rounded(mat.graphite, [W, H, D], 3, [0, 0, 0]);
  m.box(mat.graphiteLight, [W - 14, 0.6, D - 14], [0, H / 2 + 0.2, 0]);
  m.box(mat.bezel, [W - 2, H - 2, 1.6], [0, 0, D / 2 + 0.5]);
  grille(m, mat.hole, 30, 5, 3.4, 1.8, [-W / 2 + 62, 0, D / 2 + 1.1]);
  m.cylinder(mat.silver, 5, 1.2, [W / 2 - 14, 6, D / 2 + 1.2], [Math.PI / 2, 0, 0], 32);
  m.cylinder(mat.bezel, 4, 1.4, [W / 2 - 14, 6, D / 2 + 1.4], [Math.PI / 2, 0, 0], 32);
  m.box(mat.led, [3, 1, 0.6], [W / 2 - 14, -1.5, D / 2 + 1.4]);
  usbA(m, [W / 2 - 52, 5, D / 2 + 1.3]);
  usbA(m, [W / 2 - 52, -5, D / 2 + 1.3]);
  m.rounded(mat.hole, [8.4, 2.6, 1], 1.2, [W / 2 - 34, 5, D / 2 + 1.3]);
  m.cylinder(mat.hole, 1.75, 1.2, [W / 2 - 34, -5, D / 2 + 1.3], [Math.PI / 2, 0, 0]);
  // Slits along the left side.
  for (let i = 0; i < 14; i++) m.box(mat.hole, [1, 2, 6], [-W / 2 - 0.2, -4 + (i % 2) * 8, -D / 2 + 30 + Math.floor(i / 2) * 18]);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) m.cylinder(mat.rubber, 6, 2, [x * (W / 2 - 18), -H / 2 - 1, z * (D / 2 - 18)]);
  await m.done();
}

// A home router (230 × 35 × 144 mm), its front facing +z: a gloss black body with a matte top inset, a row of lights
// along its front edge, four flat antennas on hinges standing up at its back, feet. No badge.
{
  const m = model("router");
  const [W, H, D] = [230, 35, 144];
  m.rounded(mat.gloss, [W, H, D], 6, [0, 0, 0]);
  m.box(mat.matte, [W - 30, 0.6, D - 30], [0, H / 2 + 0.2, 0]);
  for (let i = 0; i < 7; i++) m.box(i === 0 ? mat.ledGreen : mat.led, [6, 0.6, 2], [-36 + i * 12, H / 2 + 0.4, D / 2 - 10]);
  for (let i = 0; i < 4; i++) {
    const x = -W / 2 + 22 + (i * (W - 44)) / 3;
    m.cylinder(mat.matte, 6, 14, [x, H / 2 - 4, -D / 2 + 2], [0, 0, Math.PI / 2]);
    m.rounded(mat.matte, [16, 150, 7], 3, [x, H / 2 + 75, -D / 2 + 2]);
  }
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) m.cylinder(mat.rubber, 5, 2, [x * (W / 2 - 20), -H / 2 - 1, z * (D / 2 - 18)]);
  await m.done();
}

// A desktop switch (120 × 26 × 70 mm), its front facing +z: an aluminium body, a darker front, slits on its sides and
// a power light. The twin mounts the ports on its front.
{
  const m = model("switch");
  const [W, H, D] = [120, 26, 70];
  m.rounded(mat.aluminium, [W, H, D], 2, [0, 0, 0]);
  m.box(mat.bezel, [W - 4, H - 4, 1], [0, 0, D / 2 + 0.3]);
  m.box(mat.ledGreen, [3, 1.5, 0.6], [-W / 2 + 8, H / 2 - 6, D / 2 + 0.9]);
  for (const side of [-1, 1]) for (let i = 0; i < 8; i++) m.box(mat.hole, [1, 10, 3], [side * (W / 2 + 0.2), 0, -D / 2 + 12 + i * 6.5]);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) m.cylinder(mat.rubber, 4, 1.5, [x * (W / 2 - 12), -H / 2 - 0.75, z * (D / 2 - 10)]);
  await m.done();
}

// A 2.5" USB disk (120 × 15 × 80 mm), lying flat, its long side along x: a matte black enclosure with a graphite top,
// its activity light at the front edge and the USB socket on its left end, where the cable comes in.
{
  const m = model("usb-disk");
  const [W, H, D] = [120, 15, 80];
  m.rounded(mat.matte, [W, H, D], 4, [0, 0, 0]);
  m.box(mat.graphiteLight, [W - 16, 0.6, D - 16], [0, H / 2 + 0.2, 0]);
  m.box(mat.led, [6, 1, 0.6], [W / 2 - 14, 0, D / 2 + 0.2]);
  m.box(mat.silver, [0.6, 5.2, 12.5], [-W / 2 - 0.2, 0, 0]);
  m.box(mat.hole, [0.8, 3.8, 11], [-W / 2 - 0.4, 0, 0]);
  await m.done();
}
