// Development gallery: one of each geometry primitive on a studio floor, as a visual
// check of shapes, normals, painted regions and screen UVs.
import {
  ACESFilmicToneMapping,
  Box3,
  CanvasTexture,
  CircleGeometry,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  boltGeo,
  lathe,
  mergeByKey,
  paintFaces,
  placed,
  plate,
  screenPair,
  stretch,
  superellipsoid,
  torus,
  tube,
  type V3,
} from '../cats';

const BACKGROUND = '#f1efe9';

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// PCFSoftShadowMap is removed in three 0.187; PCF with a shadow radius is the soft path.
renderer.shadowMap.type = PCFShadowMap;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.outputColorSpace = SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(BACKGROUND);
scene.fog = new Fog(BACKGROUND, 4.5, 8);

const camera = new PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.05, 40);
camera.position.set(0, 0.95, 2.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.1, 0);
controls.enableDamping = true;

scene.add(new HemisphereLight('#ffffff', '#cdc6b6', 1.5));
const sun = new DirectionalLight('#fff4e4', 2.6);
sun.position.set(1.6, 3.2, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -1.4, right: 1.4, top: 1.4, bottom: -1.4, near: 0.5, far: 8 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.01;
sun.shadow.radius = 4;
scene.add(sun);

const floor = new Mesh(new CircleGeometry(9, 96), new MeshStandardMaterial({ color: BACKGROUND, roughness: 0.95 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// ---------- Materials ----------

const shell = new MeshStandardMaterial({ vertexColors: true, roughness: 0.42 });
const plain = new MeshStandardMaterial({ color: '#dcd6cb', roughness: 0.45 });
const joint = new MeshStandardMaterial({ color: '#4a4f57', roughness: 0.35, metalness: 0.2 });
const bezel = new MeshStandardMaterial({ color: '#23262b', roughness: 0.5 });

/** A face for the screen. The dot sits top left, to show the texture reads upright. */
function faceTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 348;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#0d1117';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#7df9ff';
  for (const x of [170, 342]) {
    g.beginPath();
    g.roundRect(x - 34, 110, 68, 96, 30);
    g.fill();
  }
  g.strokeStyle = '#7df9ff';
  g.lineWidth = 12;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(226, 246, 30, 0.15 * Math.PI, 0.85 * Math.PI);
  g.arc(286, 246, 30, 0.15 * Math.PI, 0.85 * Math.PI);
  g.stroke();
  g.fillStyle = '#ff7a59';
  g.beginPath();
  g.arc(40, 40, 14, 0, 2 * Math.PI);
  g.fill();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
const face = new MeshBasicMaterial({ map: faceTexture(), toneMapped: false });

// ---------- Pieces ----------

const STRIPES: [number, number][] = [[-0.36, -0.18], [-0.02, 0.16], [0.32, 0.5], [0.66, 0.82]];
const TAIL_RINGS: [number, number][] = [[0.42, 0.52], [0.64, 0.74], [0.86, 1.01]];

function mesh(geometry: BufferGeometry, material: Material, shadow = true): Mesh {
  const m = new Mesh(geometry, material);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

// Tabby stripes across the long axis, with a ring of the mesh on every stripe border.
const body = superellipsoid([0.14, 0.12, 0.24], 0.45, 0.45, [48, 32], 0, { axis: 'z', rows: STRIPES.flat() });
paintFaces(body, (_c, p) => (STRIPES.some(([a, b]) => p[2] > a && p[2] < b) ? 'Stripe' : null), { Stripe: '#b9652c' }, '#f2b66d');

const head = superellipsoid([0.2, 0.15, 0.16], 0.35, 0.35, [56, 36], 0.3);

const screen = new Group();
const { glass, rim } = screenPair([0.155, 0.105, 0.11], 0.01, 0.35);
screen.add(mesh(glass, face), mesh(rim, bezel));

const collar = torus(0.1, 0.016, [40, 10]);

// Rings by t on a tail-like tube, with rings of the mesh on the ring borders.
const tailPoints: V3[] = [[0, 0.03, 0.24], [0, 0.06, 0.15], [0, 0.15, 0.09], [0, 0.26, 0.09], [0, 0.34, 0.13]];
const tail = tube(tailPoints, [0.032, 0.02], 12, { samples: 21, rows: TAIL_RINGS.flat() });
paintFaces(
  tail,
  (_c, _p, t) => (t >= 0.86 ? 'Tip' : TAIL_RINGS.some(([a, b]) => t > a && t < b) ? 'Ring' : null),
  { Ring: '#7a3e1a', Tip: '#fff1dc' },
  '#f2b66d',
);

const ear = stretch(lathe([[0, 0.14], [0.025, 0.12], [0.06, 0.05], [0.078, 0]], 24), 1, 1, 0.42);
const cup = lathe([[0, 0.07], [0.029, 0.07], [0.036, 0.078], [0.04, 0.074], [0.034, 0.004], [0.028, 0], [0, 0]], 20);

// A panel and four bolts merged into one geometry.
const panelGeo = plate(0.16, 0.11, 0.01, 0.3);
const bolt = boltGeo(0.008, 0.6);
const corners: V3[] = [[-0.062, 0.038, 0.005], [0.062, 0.038, 0.005], [-0.062, -0.038, 0.005], [0.062, -0.038, 0.005]];
const panel = mergeByKey([
  { geometry: panelGeo, key: 'panel' },
  ...corners.map((c) => ({ geometry: bolt, key: 'panel', matrix: new Matrix4().makeTranslation(...c) })),
]).get('panel')!;

const bigBolt = placed(boltGeo(0.03, 0.6), [0, 0, 0], [-Math.PI / 2, 0, 0]);

// The screen comes first so it starts out facing the camera.
const pieces: Object3D[] = [
  screen,
  mesh(body, shell),
  mesh(head, plain),
  mesh(collar, joint),
  mesh(tail, shell),
  mesh(ear, plain),
  mesh(cup, plain),
  mesh(panel, joint),
  mesh(bigBolt, joint),
];

// ---------- Layout ----------

const stage = new Group();
scene.add(stage);
const box = new Box3();
pieces.forEach((piece, i) => {
  const angle = (2 * Math.PI * i) / pieces.length;
  piece.position.set(Math.sin(angle) * 0.75, 0, Math.cos(angle) * 0.75);
  // Face outward from the centre, so the screen and panel face the camera as they pass.
  piece.rotation.y = angle;
  stage.add(piece);
  piece.updateMatrixWorld(true);
  box.setFromObject(piece);
  piece.position.y = -box.min.y;
});

// ---------- Loop ----------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop((ms: number) => {
  stage.rotation.y = ms * 0.00012;
  controls.update();
  renderer.render(scene, camera);
});
