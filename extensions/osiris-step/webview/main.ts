/**
 * STEP 3D preview webview. Renders the wireframe + point cloud produced by
 * `extractGeometry` using three.js. Receives one `{ type: 'model', … }` message.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { StepGeometry, StepHeader, Vec3 } from '@osiris/shared-core';

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;

interface ModelMessage {
  type: 'model';
  header: StepHeader;
  stats: { entityCount: number; distinctTypes: number; schemaIdentifiers: string[] };
  geometry: StepGeometry;
  skipped: boolean;
}
interface ErrorMessage {
  type: 'error';
  message: string;
}

const ACCENT = 0x00ffff;
const ACCENT_ALT = 0xff00ff;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1e7);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const grid = new THREE.GridHelper(10, 10, ACCENT_ALT, 0x333333);
scene.add(grid);

let content: THREE.Object3D | undefined;

function resize(): void {
  const { clientWidth, clientHeight } = canvas;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / Math.max(1, clientHeight);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function center(bbox: StepGeometry['bbox']): Vec3 {
  return {
    x: (bbox.min.x + bbox.max.x) / 2,
    y: (bbox.min.y + bbox.max.y) / 2,
    z: (bbox.min.z + bbox.max.z) / 2,
  };
}

function fitCamera(bbox: StepGeometry['bbox']): void {
  const c = center(bbox);
  const size = Math.max(
    bbox.max.x - bbox.min.x,
    bbox.max.y - bbox.min.y,
    bbox.max.z - bbox.min.z,
    1,
  );
  controls.target.set(c.x, c.y, c.z);
  camera.position.set(c.x + size, c.y + size, c.z + size);
  camera.near = size / 1000;
  camera.far = size * 1000;
  camera.updateProjectionMatrix();
  grid.position.set(c.x, bbox.min.y, c.z);
  grid.scale.setScalar(size / 10);
}

function buildContent(geometry: StepGeometry): THREE.Object3D {
  const group = new THREE.Group();
  const positions = new Float32Array(geometry.points.length * 3);
  geometry.points.forEach((p, i) => {
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
  });

  if (geometry.points.length > 0) {
    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    group.add(
      new THREE.Points(
        pointGeo,
        new THREE.PointsMaterial({ color: ACCENT_ALT, size: 2, sizeAttenuation: false }),
      ),
    );
  }

  if (geometry.lineSegments.length > 0) {
    const linePositions = new Float32Array(geometry.lineSegments.length * 6);
    geometry.lineSegments.forEach(([a, b], i) => {
      const pa = geometry.points[a];
      const pb = geometry.points[b];
      if (!pa || !pb) return;
      linePositions.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], i * 6);
    });
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    group.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: ACCENT })));
  }

  return group;
}

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('message', (event: MessageEvent<ModelMessage | ErrorMessage>) => {
  const msg = event.data;
  if (msg.type === 'error') {
    hud.textContent = `Parse error:\n${msg.message}`;
    return;
  }
  if (content) {
    scene.remove(content);
  }
  content = buildContent(msg.geometry);
  scene.add(content);
  fitCamera(msg.geometry.bbox);

  hud.textContent = [
    `${msg.header.name || '(unnamed)'}`,
    `schema: ${msg.stats.schemaIdentifiers.join(', ') || '?'}`,
    `entities: ${msg.stats.entityCount}  types: ${msg.stats.distinctTypes}`,
    `points: ${msg.geometry.points.length}  lines: ${msg.geometry.lineSegments.length}`,
    msg.skipped ? '(geometry skipped — file above entity limit)' : '',
  ]
    .filter(Boolean)
    .join('\n');
});

resize();
animate();
vscodeApi.postMessage({ type: 'ready' });
