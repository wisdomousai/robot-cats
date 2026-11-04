/**
 * The showcase stage: renderer, studio set, lights, post-processing, camera rig and the
 * teardown effects (isolate, x-ray, explode) for the robot cats.
 *
 * The page owns the loop. It updates the world, then calls `stage.frame(dt)`, which moves
 * the camera, applies the explode offsets for the current pose and draws one frame,
 * either through the composer (with ambient occlusion) or straight to the canvas,
 * depending on the quality tier.
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Fog,
  HalfFloatType,
  HemisphereLight,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Raycaster,
  Scene,
  Sphere,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  type Material,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { CatModel, SystemId, V3 } from '../cats/index';
import { perfLog, pixelRatio, tierOf, type Tier, type TierId } from './quality';

// ---------- Studio ----------

/** The studio set, in metres. Props that sit on the floor or hang on the wall read these. */
export const STUDIO = {
  /** The page and the far floor show this colour exactly. */
  background: '#f4f4f1',
  floor: '#ecece8',
  /** The floor is flat from the front edge back to here, then curves up into the wall. */
  curveZ: -1.1,
  curveRadius: 0.5,
  /** The back wall's face (curveZ - curveRadius). */
  wallZ: -1.6,
  wallHeight: 4.5,
  /**
   * The sweep spans x in ±halfWidth and runs forward to z = front. Its ends are far enough
   * out that the fog has turned them into the background before a side-on camera sees them.
   */
  halfWidth: 30,
  front: 14,
  /** The play area: 3 m along x, 2 m along z, centred on the origin. */
  play: { x: 1.5, z: 1 },
} as const;

const EXPOSURE = 1.05;
/** Fog from here to the far value, in metres from the camera: only the far floor fades. */
const FOG: [near: number, far: number] = [6.5, 15];
/** Shadow penumbra width aimed for at every map size, in metres. */
const SHADOW_SOFTNESS = 0.012;
/** How far a part moves at full explode, in metres. */
const EXPLODE_DISTANCE = 0.12;
/** Render order for x-rayed parts: after everything else, opaque or not. */
const XRAY_ORDER = 1000;

/**
 * The linear scene colour that the ACES filmic curve at `exposure` turns into `hex` on
 * screen. The background and fog use it, so the far floor, the cleared background and
 * the page around the canvas are all the same colour whichever path draws the frame.
 * This inverts three's ACESFilmicToneMapping (input matrix, RRT+ODT fit, output matrix).
 */
function sceneColourFor(hex: string, exposure: number): Color {
  const shown = new Color(hex);
  // three's GLSL matrices, written here row by row (the shader lists them by column).
  const input = new Matrix3().set(0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777);
  const output = new Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602);
  const fitted = new Vector3(shown.r, shown.g, shown.b).applyMatrix3(output.invert());
  // Solve v(v + 0.0245786) - 0.000090537 = m (0.983729 v² + 0.432951 v + 0.238081) for v.
  const unfit = (m: number) => {
    const a = 1 - 0.983729 * m;
    const b = 0.0245786 - 0.432951 * m;
    const c = -(0.000090537 + 0.238081 * m);
    return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  };
  const v = new Vector3(unfit(fitted.x), unfit(fitted.y), unfit(fitted.z)).applyMatrix3(input.invert());
  v.multiplyScalar(0.6 / exposure);
  return new Color().setRGB(v.x, v.y, v.z);
}

/** The floor: flat in front, a quarter circle at the back, then a wall. Faces up and forward. */
function sweepGeometry(): BufferGeometry {
  const { curveZ, curveRadius: r, wallHeight, halfWidth: w, front } = STUDIO;
  // Profile points as [z, y, normal z, normal y], front to top.
  const profile: [number, number, number, number][] = [
    [front, 0, 0, 1],
    [curveZ + 2, 0, 0, 1],
    [curveZ, 0, 0, 1],
  ];
  const arc = 18;
  for (let i = 1; i <= arc; i++) {
    const a = (i / arc) * (Math.PI / 2);
    profile.push([curveZ - r * Math.sin(a), r - r * Math.cos(a), Math.sin(a), Math.cos(a)]);
  }
  profile.push([curveZ - r, wallHeight, 1, 0]);

  const position: number[] = [];
  const normal: number[] = [];
  const index: number[] = [];
  for (const [z, y, nz, ny] of profile) {
    position.push(-w, y, z, w, y, z);
    normal.push(0, ny, nz, 0, ny, nz);
  }
  for (let i = 0; i < profile.length - 1; i++) {
    const a = 2 * i;
    // (left i, right i, left i+1) winds counter-clockwise seen from above the floor.
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normal), 3));
  geo.setIndex(index);
  return geo;
}

// ---------- Small helpers ----------

const DEG = Math.PI / 180;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const easeInOutCubic = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

/**
 * Second-order motion (k2·y'' + k1·y' + y = x + k3·x'), as in src/cats/math/spring.ts,
 * kept local so the stage does not depend on the cats library's internals.
 */
class Spring {
  y: number;
  private v = 0;
  private x: number;
  private readonly k1: number;
  private readonly k2: number;
  private readonly k3: number;

  constructor(f: number, zeta: number, r: number, start = 0) {
    this.k1 = zeta / (Math.PI * f);
    this.k2 = 1 / (2 * Math.PI * f) ** 2;
    this.k3 = (r * zeta) / (2 * Math.PI * f);
    this.x = this.y = start;
  }

  update(dt: number, x: number): number {
    if (dt <= 0) return this.y;
    const xv = (x - this.x) / dt;
    this.x = x;
    // Clamp k2 so a long frame cannot make the spring blow up.
    const k2 = Math.max(this.k2, (dt * dt) / 2 + (dt * this.k1) / 2, dt * this.k1);
    this.y += dt * this.v;
    this.v += (dt * (x + this.k3 * xv - this.y - this.k1 * this.v)) / k2;
    return this.y;
  }

  snap(value: number) {
    this.x = this.y = value;
    this.v = 0;
  }
}

/** Switches meshes off for the AO G-buffer pass and back on after it. */
class VisibilityPass extends Pass {
  constructor(
    private readonly hide: boolean,
    private readonly meshes: Set<Object3D>,
    private readonly hidden: Object3D[],
    private readonly renderer: WebGLRenderer,
  ) {
    super();
    this.needsSwap = false;
  }

  render() {
    if (this.hide) {
      for (const m of this.meshes) {
        if (m.visible) {
          m.visible = false;
          this.hidden.push(m);
        }
      }
      // The G-buffer pass draws normals only; the shadow maps from the colour pass stand.
      this.renderer.shadowMap.autoUpdate = false;
    } else {
      for (const m of this.hidden) m.visible = true;
      this.hidden.length = 0;
      this.renderer.shadowMap.autoUpdate = true;
    }
  }
}

// ---------- Public types ----------

export type ViewId = 'three-quarter' | 'front' | 'side' | 'top' | 'head' | 'follow';
export const VIEW_IDS: readonly ViewId[] = ['three-quarter', 'front', 'side', 'top', 'head', 'follow'];

/**
 * A camera placement. Azimuth is degrees from +z toward +x (0 looks at the cats' fronts),
 * elevation degrees above the floor, distance metres from the target. For `head` the
 * azimuth is relative to the selected cat's heading, and the target is its head bone.
 * For `follow` the target is the selected cat.
 */
export interface View {
  target: V3;
  azimuth: number;
  elevation: number;
  distance: number;
}

/**
 * A tour beat's adjustment of the camera, on top of the view and the visitor's orbit. The
 * next beat replaces it, and the tour stopping clears it.
 */
export interface Shot {
  /** Degrees added to the view's azimuth; for the head view that is relative to the cat. */
  azimuth?: number;
  /**
   * For the head and follow views: the azimuth in world degrees, in place of the one the
   * follow view kept or the head view's turn with the cat.
   */
  heading?: number;
  /** Degrees added to the elevation. */
  elevation?: number;
  /** Factor on the distance. */
  zoom?: number;
  /** For the head and follow views: a point the target moves toward, by `mix` (0 to 1). */
  toward?: V3;
  mix?: number;
}

/**
 * Ghost opacity by view. With nothing else drawn behind it, the follow view needs about the
 * wide views' opacity for the outline to read; in the head view the ghost fills the frame.
 */
const GHOST_WIDE = 0.14;
const GHOST_FOLLOW = 0.13;
const GHOST_HEAD = 0.08;

/** What a merged mesh carries in userData, from the cat model. */
interface PartInfo {
  parts?: string[];
  system?: SystemId;
  bone?: string;
  explode?: V3;
}

interface Entry {
  mesh: Mesh;
  info: PartInfo;
  /** Rest position in the parent bone, taken when explode first moves the mesh. */
  base: Vector3 | null;
}

interface CatState {
  model: CatModel;
  entries: Entry[];
  prefixes: string[] | null;
  xray: boolean;
  ghost: Material;
  xrayMaterial: Material;
  explode: { amount: number; from: number; to: number; t: number; length: number };
}

export interface Stage {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly lights: { key: DirectionalLight; fill: HemisphereLight; rim: DirectionalLight; ambient: AmbientLight };
  readonly floor: Mesh;
  readonly accent: Color;
  /** Camera placements by id; edit them freely. `fit` rewrites the target and distance. */
  readonly views: Record<ViewId, View>;
  readonly view: ViewId;
  readonly tier: Tier;
  /** The GPU and driver string, for the perf log and the dev overlay. */
  readonly gpu: string;
  /** The camera as the springs have it now. */
  rig(): View;

  setView(id: ViewId, opts?: { snap?: boolean }): void;
  /** Adds to the user's orbit offset, in degrees. */
  orbit(dAzimuth: number, dElevation: number): void;
  /** Multiplies the distance (below 1 moves in). */
  zoom(factor: number): void;
  resetOrbit(): void;
  /** Overrides the target of the head and follow views; null goes back to the selected cat. */
  lookAt(target: V3 | null): void;
  /** Sets the tour beat's camera adjustment, or clears it with null. */
  shot(shot: Shot | null): void;
  /**
   * Where the camera is heading in the wide views, with the beat's shot and the orbit; null
   * in the head and follow views, which go with a cat and hide what stands in the way.
   */
  eye(): V3 | null;
  /** The cat the head and follow views look at. */
  select(model: CatModel | null): void;
  /**
   * Frames the fixed views (three-quarter, front, side, top) on a box so it fills `fill`
   * of the frame, and keeps doing so on resize. Null stops refitting.
   */
  fit(subject: Box3 | Object3D | Object3D[] | null, fill?: number): void;
  /** Where a point on the canvas (CSS px from its top left) meets the floor, or null. */
  screenToFloor(x: number, y: number): V3 | null;
  /** A world point in CSS px from the canvas's top left. NaN when behind the camera. */
  project(point: V3): [number, number];

  add(obj: Object3D): void;
  remove(obj: Object3D): void;
  /**
   * Lets the head and follow views hide a static object (a prop) while it stands between the
   * camera and the selected cat, as they do with the other cats.
   */
  addOccluder(obj: Object3D): void;
  /** Registers a prop by kind, so `focus` can hide it. */
  addProp(kind: string, obj: Object3D): void;
  /**
   * The prop kinds that belong to the isolated subsystem's demo, or null when nothing is
   * isolated. While it is set, the head and follow views draw only the selected cat and
   * these props, so the ghosted cat is not crowded by what stands behind it.
   */
  focus(kinds: readonly string[] | null): void;
  addCat(model: CatModel): void;
  /**
   * Keeps the parts whose names start with one of `prefixes` (or whose system is one of
   * them) as they are and ghosts the rest of that cat. An empty list keeps the whole cat;
   * null ends isolation.
   */
  isolate(model: CatModel, prefixes: string[] | null): void;
  /** Draws the isolated parts (or the whole cat) through everything else. */
  xray(model: CatModel, on: boolean): void;
  /** Moves each rigid part out along its explode direction; `seconds` eases there (0 sets it). */
  explode(model: CatModel, amount: number, seconds?: number): void;

  frame(dt: number): void;
  resize(): void;
  setTier(tier: Tier | TierId): void;
  /** Compiles every shader the cats can need (all material variants, both paths) before the first frame. */
  warm(models: CatModel[]): Promise<void>;
  dispose(): void;
}

// ---------- Stage ----------

export function createStage(canvas: HTMLCanvasElement, opts: { accent?: string } = {}): Stage {
  const accent = new Color(opts.accent ?? '#ff5a1f');

  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap is gone in 0.187; PCF with a radius is the soft path.
  renderer.shadowMap.type = PCFShadowMap;

  const gl = renderer.getContext();
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = String(gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  perfLog.gpu(gpu);

  // Direct rendering clears to the display colour as is; the composer's clear is tone
  // mapped by the output pass, so it clears to the colour that maps onto it.
  const backgroundDirect = new Color(STUDIO.background);
  const backgroundLinear = sceneColourFor(STUDIO.background, EXPOSURE);

  const scene = new Scene();
  scene.background = backgroundDirect;
  scene.fog = new Fog(backgroundLinear.clone(), FOG[0], FOG[1]);

  const camera = new PerspectiveCamera(32, 1, 0.05, 60);

  // ----- Set and lights -----

  const floor = new Mesh(sweepGeometry(), new MeshStandardMaterial({ color: STUDIO.floor, roughness: 0.94, metalness: 0 }));
  floor.name = 'studio.floor';
  floor.receiveShadow = true;
  scene.add(floor);

  // Key from the front left, high; it alone casts shadows.
  const key = new DirectionalLight('#fffcf7', 3.1);
  key.name = 'studio.key';
  {
    const az = -42 * DEG;
    const el = 54 * DEG;
    key.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(6);
  }
  key.castShadow = true;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.012;
  scene.add(key, key.target);

  // Fill from the sky, slightly cool, and back from the floor, neutral like the paper.
  const fill = new HemisphereLight('#eef2fb', '#e4e4df', 1.55);
  fill.name = 'studio.fill';
  // A low rim from behind picks the silhouettes off the pale wall.
  const rim = new DirectionalLight('#f4f7ff', 1.5);
  rim.name = 'studio.rim';
  rim.position.set(1.6, 1.3, -4.5);
  const ambient = new AmbientLight('#ffffff', 0.22);
  ambient.name = 'studio.ambient';
  scene.add(fill, rim, ambient);

  /** Fits the key light's orthographic shadow camera around a box (the play area and its props). */
  const fitShadow = (min: Vector3, max: Vector3) => {
    const view = new Matrix4().lookAt(key.position, key.target.position, new Vector3(0, 1, 0)).setPosition(key.position).invert();
    const lo = new Vector3(Infinity, Infinity, Infinity);
    const hi = new Vector3(-Infinity, -Infinity, -Infinity);
    const p = new Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).applyMatrix4(view);
      lo.min(p);
      hi.max(p);
    }
    const cam = key.shadow.camera;
    cam.left = lo.x;
    cam.right = hi.x;
    cam.bottom = lo.y;
    cam.top = hi.y;
    cam.near = Math.max(0.1, -hi.z - 0.5);
    cam.far = -lo.z + 0.5;
    cam.updateProjectionMatrix();
  };
  // The play area with a margin for parts that hang over its edge, up the curve at the
  // back, and as high as a ledge.
  fitShadow(
    new Vector3(-STUDIO.play.x - 0.25, 0, STUDIO.wallZ),
    new Vector3(STUDIO.play.x + 0.25, 1.15, STUDIO.play.z + 0.25),
  );

  // ----- Post-processing -----

  const composerTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
  composerTarget.texture.name = 'stage.composer';
  const composer = new EffectComposer(renderer, composerTarget);
  const renderPass = new RenderPass(scene, camera);
  const seeThrough = new Set<Object3D>();
  const hiddenForAO: Object3D[] = [];
  const hidePass = new VisibilityPass(true, seeThrough, hiddenForAO, renderer);
  const gtao = new GTAOPass(scene, camera, 1, 1);
  // A pale scene shows every bit of AO, so it is kept to creases and contacts: a small
  // world radius, a thin depth window so a cat does not darken the wall behind it, and a
  // blend a little under full.
  gtao.updateGtaoMaterial({ radius: 0.12, distanceExponent: 1.2, thickness: 0.1, distanceFallOff: 1, scale: 1, samples: 16 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1.5, rings: 2, samples: 16 });
  gtao.blendIntensity = 0.9;
  // Only the play area and its props take AO; the bare sweep has no creases to find.
  gtao.setSceneClipBox(new Box3(new Vector3(-2.4, -0.05, STUDIO.wallZ - 0.05), new Vector3(2.4, 1.8, 1.8)));
  const showPass = new VisibilityPass(false, seeThrough, hiddenForAO, renderer);
  const outputPass = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(hidePass);
  composer.addPass(gtao);
  composer.addPass(showPass);
  composer.addPass(outputPass);

  // ----- Camera rig -----

  const views: Record<ViewId, View> = {
    'three-quarter': { target: [0, 0.26, 0], azimuth: 32, elevation: 15, distance: 3.6 },
    front: { target: [0, 0.26, 0], azimuth: 0, elevation: 5, distance: 3.6 },
    side: { target: [0, 0.26, 0], azimuth: 90, elevation: 5, distance: 3.6 },
    top: { target: [0, 0, 0], azimuth: 0, elevation: 88, distance: 5 },
    head: { target: [0, 0.45, 0], azimuth: 24, elevation: 6, distance: 0.9 },
    follow: { target: [0, 0.26, 0], azimuth: 32, elevation: 13, distance: 2.2 },
  };
  /** Bounding radius of a head with its ears and of a whole cat, metres, for the close views. */
  const HEAD_RADIUS = 0.25;
  const CAT_RADIUS = 0.42;

  // Slow and critically damped: a new view glides in, and a followed cat does not yank the frame.
  const F = 0.75;
  const ZETA = 1;
  const springs = {
    az: new Spring(F, ZETA, 0),
    el: new Spring(F, ZETA, 0),
    dist: new Spring(F, ZETA, 0),
    tx: new Spring(F, ZETA, 0),
    ty: new Spring(F, ZETA, 0),
    tz: new Spring(F, ZETA, 0),
  };
  let view: ViewId = 'three-quarter';
  let snapNext = true;
  const orbitOffset = { az: 0, el: 0, zoom: 1 };
  let lookTarget: V3 | null = null;
  let shot: Shot | null = null;
  let focusKinds: readonly string[] | null = null;
  let selected: CatModel | null = null;
  let fitBox: Box3 | null = new Box3(new Vector3(-0.85, 0, -0.35), new Vector3(0.85, 0.62, 0.35));
  let fitFill = 0.65;

  const tmpV = new Vector3();
  const tmpQ = new Quaternion();

  /** Root position and heading (degrees from +z toward +x) of a cat. */
  const catPlace = (model: CatModel): { at: Vector3; heading: number } => {
    model.root.updateWorldMatrix(true, false);
    const at = model.root.getWorldPosition(new Vector3());
    const fwd = new Vector3(0, 0, 1).applyQuaternion(model.root.getWorldQuaternion(tmpQ));
    return { at, heading: Math.atan2(fwd.x, fwd.z) / DEG };
  };

  /** The placement the camera is heading for this frame, with the orbit offset applied. */
  const desired = (): View => {
    const v = views[view];
    let target: V3 = [...v.target];
    let azimuth = v.azimuth;
    const fixed = shot?.heading !== undefined && (view === 'head' || view === 'follow');
    if (fixed) azimuth = shot!.heading!;
    if ((view === 'head' || view === 'follow') && (lookTarget || selected)) {
      if (lookTarget) target = [...lookTarget];
      if (selected) {
        const { at, heading } = catPlace(selected);
        if (view === 'head') {
          if (!fixed) azimuth += heading;
          if (!lookTarget) {
            const head = selected.bones.get('head');
            if (head) {
              head.updateWorldMatrix(true, false);
              head.getWorldPosition(tmpV);
              // Aim above the middle of the face, so the ears are in the frame as well as the chin.
              target = [tmpV.x, tmpV.y + 0.1, tmpV.z];
            } else target = [at.x, at.y + 0.45, at.z];
          }
        } else if (!lookTarget) target = [at.x, v.target[1], at.z];
      }
      if (shot?.toward) {
        const k = shot.mix ?? 0.5;
        target = [0, 1, 2].map((i) => target[i] + (shot!.toward![i] - target[i]) * k) as V3;
      }
    }
    return {
      target,
      azimuth: azimuth + (shot?.azimuth ?? 0) + orbitOffset.az,
      elevation: clamp(v.elevation + (shot?.elevation ?? 0) + orbitOffset.el, 1, 89),
      distance: clamp(v.distance * (shot?.zoom ?? 1) * orbitOffset.zoom, 0.3, 14),
    };
  };

  const updateCamera = (dt: number) => {
    const d = desired();
    // Take the azimuth the short way round from wherever the spring is.
    d.azimuth += 360 * Math.round((springs.az.y - d.azimuth) / 360);
    if (snapNext) {
      springs.az.snap(d.azimuth);
      springs.el.snap(d.elevation);
      springs.dist.snap(d.distance);
      springs.tx.snap(d.target[0]);
      springs.ty.snap(d.target[1]);
      springs.tz.snap(d.target[2]);
      snapNext = false;
    } else {
      springs.az.update(dt, d.azimuth);
      springs.el.update(dt, d.elevation);
      springs.dist.update(dt, d.distance);
      springs.tx.update(dt, d.target[0]);
      springs.ty.update(dt, d.target[1]);
      springs.tz.update(dt, d.target[2]);
    }
    const az = springs.az.y * DEG;
    const el = clamp(springs.el.y, 0.5, 89.5) * DEG;
    const dist = springs.dist.y;
    const t = tmpV.set(springs.tx.y, springs.ty.y, springs.tz.y);
    camera.position.set(
      t.x + dist * Math.sin(az) * Math.cos(el),
      t.y + dist * Math.sin(el),
      t.z + dist * Math.cos(az) * Math.cos(el),
    );
    camera.lookAt(t);
    camera.updateMatrixWorld();
  };

  /**
   * The head and follow views sit close to the selected cat, so another cat between it and
   * the camera, or just beside the camera, fills the frame. Such a cat is hidden while it is
   * there: anything nearer the camera than the selected cat and inside a cone round the line
   * of sight that widens with distance. In the follow view a cat beside the selected one (a
   * game partner) stays; the head view is about one head, so a cat beside it goes as well.
   * While a subsystem is isolated (`focus`), the other cats and the props its demo does not
   * use are hidden outright: through the ghost they would read as part of the cat.
   */
  const toCat = new Vector3();
  const sight = new Vector3();
  const toShown = new Vector3();
  const occluders: { obj: Object3D; centre: Vector3; radius: number }[] = [];
  const props: { kind: string; obj: Object3D }[] = [];
  const clearSightLine = () => {
    const close = (view === 'head' || view === 'follow') && selected !== null;
    const focused = close && focusKinds !== null;
    // In the wide views, while a demo is shown, a cat that covers the selected one is hidden
    // too. The world keeps waiting cats off the line to the camera, but one on its way to the
    // other side of it still passes in front.
    const demo = !close && selected !== null && focusKinds !== null;
    if (demo) {
      selected!.root.getWorldPosition(toShown);
      toShown.y += 0.25;
      toShown.sub(camera.position);
    }
    const shownDist = toShown.length();
    sight.set(springs.tx.y, springs.ty.y, springs.tz.y).sub(camera.position);
    const length = sight.length();
    sight.divideScalar(length || 1);
    const depth = view === 'head' ? length + 0.4 : length - 0.3;
    for (const s of cats.values()) {
      const root = s.model.root;
      if ((!close && !demo) || s.model === selected) {
        root.visible = true;
        continue;
      }
      if (focused) {
        root.visible = false;
        continue;
      }
      root.getWorldPosition(toCat);
      toCat.y += 0.25;
      toCat.sub(camera.position);
      if (demo) {
        const d = toCat.length();
        root.visible = !(d < shownDist && toCat.angleTo(toShown) < Math.atan(CAT_RADIUS / shownDist) + Math.atan(CAT_RADIUS / d));
        continue;
      }
      const along = toCat.dot(sight);
      const across = toCat.addScaledVector(sight, -along).length();
      root.visible = !(along > -0.3 && along < depth && across < CAT_RADIUS + 0.45 * Math.max(0, along));
    }
    // A prop's own group is left to the scene sync (the bird and the laser come and go), so
    // focus hides its children.
    for (const { kind, obj } of props) {
      const shown = !focused || focusKinds!.includes(kind);
      for (const child of obj.children) child.visible = shown;
    }
    // Props only when they cover the line itself: one at the edge of the frame does no harm.
    for (const o of occluders) {
      if (!close) {
        o.obj.visible = true;
        continue;
      }
      toCat.copy(o.centre).sub(camera.position);
      const along = toCat.dot(sight);
      const across = toCat.addScaledVector(sight, -along).length();
      o.obj.visible = !(along > -o.radius && along < length - 0.2 && across < o.radius + 0.05);
    }
    // Close up the ghost is most of the frame; fainter, it still shows the outline.
    for (const s of cats.values()) {
      const ghost = s.ghost as Material & { opacity: number };
      ghost.opacity = !close ? GHOST_WIDE : view === 'head' ? GHOST_HEAD : GHOST_FOLLOW;
    }
  };

  let cssWidth = 1;
  let cssHeight = 1;

  /** Distance at which a box, seen from (azimuth, elevation), fills `fill` of the frame. */
  const fitDistance = (box: Box3, azimuth: number, elevation: number, fill: number): number => {
    const az = azimuth * DEG;
    const el = elevation * DEG;
    const forward = new Vector3(-Math.sin(az) * Math.cos(el), -Math.sin(el), -Math.cos(az) * Math.cos(el));
    const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0)).normalize();
    const up = new Vector3().crossVectors(right, forward);
    const tanV = Math.tan((camera.fov / 2) * DEG);
    const tanH = tanV * camera.aspect;
    const centre = box.getCenter(new Vector3());
    const p = new Vector3();
    let d = 0;
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(centre);
      const depth = p.dot(forward);
      d = Math.max(d, Math.abs(p.dot(right)) / (fill * tanH) - depth, Math.abs(p.dot(up)) / (fill * tanV) - depth);
    }
    return d;
  };

  const refit = () => {
    const tanMin = Math.min(Math.tan((camera.fov / 2) * DEG), Math.tan((camera.fov / 2) * DEG) * camera.aspect);
    views.head.distance = HEAD_RADIUS / (fitFill * tanMin);
    views.follow.distance = CAT_RADIUS / (fitFill * tanMin);
    if (!fitBox) return;
    const c = fitBox.getCenter(new Vector3());
    for (const id of ['three-quarter', 'front', 'side', 'top'] as const) {
      const v = views[id];
      v.target = [c.x, id === 'top' ? fitBox.min.y : c.y, c.z];
      v.distance = fitDistance(fitBox, v.azimuth, v.elevation, fitFill);
    }
  };

  // ----- Cats and the teardown effects -----

  const cats = new Map<CatModel, CatState>();
  const fallbackGhost = new MeshBasicMaterial({ color: '#a7acb4', transparent: true, opacity: 0.14, depthWrite: false });
  const fallbackXray = new MeshBasicMaterial({
    color: accent,
    transparent: true,
    opacity: 0.6,
    depthTest: false,
    depthWrite: false,
    blending: NormalBlending,
  });

  const entriesOf = (model: CatModel): Entry[] => {
    const out: Entry[] = [];
    const sources = model.meshes.length ? model.meshes : [model.root];
    for (const source of sources) {
      source.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        // Parts info lives on the merged mesh; a group in `meshes` may carry it for its children.
        const info = (mesh.userData.parts ? mesh.userData : source.userData) as PartInfo;
        out.push({ mesh, info, base: null });
      });
    }
    return out;
  };

  const stateOf = (model: CatModel): CatState => {
    let s = cats.get(model);
    if (!s) {
      const xrayMaterial = model.materials.xray ?? fallbackXray;
      // X-ray draws through everything: no depth test, and no depth written for others to hit.
      xrayMaterial.depthTest = false;
      xrayMaterial.depthWrite = false;
      s = {
        model,
        entries: entriesOf(model),
        prefixes: null,
        xray: false,
        ghost: model.materials.ghost ?? fallbackGhost,
        xrayMaterial,
        explode: { amount: 0, from: 0, to: 0, t: 0, length: 0 },
      };
      cats.set(model, s);
    }
    return s;
  };

  const inSet = (info: PartInfo, prefixes: string[]) =>
    prefixes.length === 0 ||
    prefixes.some((p) => info.system === p || (info.parts ?? []).some((name) => name.startsWith(p)));

  /** Puts each mesh of a cat in the material its isolate and x-ray state asks for. */
  const applyLook = (s: CatState) => {
    const active = s.prefixes !== null || s.xray;
    for (const { mesh, info } of s.entries) {
      const ud = mesh.userData;
      if (ud.material0 === undefined) {
        ud.material0 = mesh.material;
        ud.renderOrder0 = mesh.renderOrder;
        ud.castShadow0 = mesh.castShadow;
      }
      let material = ud.material0 as Material | Material[];
      let order = ud.renderOrder0 as number;
      let cast = ud.castShadow0 as boolean;
      let through = false;
      if (active) {
        const kept = s.prefixes === null || inSet(info, s.prefixes);
        if (!kept) {
          material = s.ghost;
          // A ghost would still throw a solid shadow; it should not.
          cast = false;
          through = true;
        } else if (s.xray) {
          material = s.xrayMaterial;
          order = XRAY_ORDER;
          through = true;
        }
      }
      mesh.material = material;
      mesh.renderOrder = order;
      mesh.castShadow = cast;
      if (through) seeThrough.add(mesh);
      else seeThrough.delete(mesh);
    }
  };

  const offset = new Vector3();
  const world = new Vector3();
  /** Places every rigid part along its explode direction for the cat's current pose. */
  const applyExplode = (s: CatState, dt: number) => {
    const e = s.explode;
    const before = e.amount;
    if (e.amount !== e.to) {
      e.t += dt;
      const u = e.length > 0 ? clamp(e.t / e.length, 0, 1) : 1;
      e.amount = e.from + (e.to - e.from) * easeInOutCubic(u);
      if (u >= 1) e.amount = e.to;
    }
    if (e.amount === 0 && before === 0) return;
    s.model.root.updateMatrixWorld(true);
    const q = s.model.root.getWorldQuaternion(tmpQ);
    for (const entry of s.entries) {
      const { mesh, info } = entry;
      // The skinned tail bends with its bones and stays where it is.
      if ((mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh || !info.explode || !mesh.parent) continue;
      if (e.amount === 0) {
        // Back at rest: put the part home and take a fresh rest position next time.
        if (entry.base) mesh.position.copy(entry.base);
        entry.base = null;
        continue;
      }
      if (!entry.base) {
        entry.base = mesh.position.clone();
        mesh.userData.position0 = entry.base.clone();
      }
      // The direction is in the cat's frame; the mesh lives in its bone's frame, which
      // turns with the pose, so the offset goes through world space every frame.
      offset.set(info.explode[0], info.explode[1], info.explode[2]).applyQuaternion(q).multiplyScalar(e.amount * EXPLODE_DISTANCE);
      world.copy(entry.base).applyMatrix4(mesh.parent.matrixWorld).add(offset);
      mesh.position.copy(mesh.parent.worldToLocal(world));
    }
  };

  // ----- Tiers and sizing -----

  let tier: Tier = tierOf(0);
  let useComposer = true;
  let warming = false;

  const resize = () => {
    cssWidth = Math.max(1, canvas.clientWidth || window.innerWidth);
    cssHeight = Math.max(1, canvas.clientHeight || window.innerHeight);
    renderer.setSize(cssWidth, cssHeight, false);
    composer.setSize(cssWidth, cssHeight);
    camera.aspect = cssWidth / cssHeight;
    camera.updateProjectionMatrix();
    refit();
  };

  const setTier = (next: Tier | TierId) => {
    tier = typeof next === 'number' ? tierOf(next) : next;
    const ratio = pixelRatio(tier);
    renderer.setPixelRatio(ratio);
    composer.setPixelRatio(ratio);

    const size = tier.shadow;
    if (key.shadow.mapSize.x !== size) {
      key.shadow.map?.dispose();
      key.shadow.map = null;
      key.shadow.mapSize.set(size, size);
    }
    // Same penumbra in metres at every map size: radius is in texels of the map.
    const texel = (key.shadow.camera.right - key.shadow.camera.left) / size;
    key.shadow.radius = clamp(SHADOW_SOFTNESS / texel, 1, 10);

    // MSAA on the composer's targets; a changed count needs fresh buffers.
    const samples = Math.min(tier.samples, renderer.capabilities.maxSamples);
    for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
      if (rt.samples !== samples) {
        rt.samples = samples;
        rt.dispose();
      }
    }
    useComposer = tier.ao;
    gtao.enabled = tier.ao;
    resize();
  };

  // ----- Drawing -----

  const draw = (dt: number) => {
    if (useComposer) {
      scene.background = backgroundLinear;
      composer.render(dt);
    } else {
      scene.background = backgroundDirect;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    }
  };

  // ----- Warm-up -----

  const warm = async (models: CatModel[]) => {
    warming = true;
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
    const added: Object3D[] = [];
    for (const m of models) {
      if (!m.root.parent) {
        scene.add(m.root);
        added.push(m.root);
      }
    }
    const states = models.map(stateOf);
    // Everything is drawn whether or not it is in view, so nothing is left to compile later.
    const culled: [Object3D, boolean][] = [];
    scene.traverse((o) => {
      culled.push([o, o.frustumCulled]);
      o.frustumCulled = false;
    });
    const saved = states.map((s) => ({ prefixes: s.prefixes, xray: s.xray }));
    const compile = async () => {
      if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
      else renderer.compile(scene, camera);
    };
    try {
      updateCamera(0);
      // normal, ghost (isolate a part nothing has), x-ray (the whole cat)
      const looks: [string[] | null, boolean][] = [
        [null, false],
        [['\u0000'], false],
        [[], true],
      ];
      for (const [prefixes, xray] of looks) {
        for (const s of states) {
          s.prefixes = prefixes;
          s.xray = xray;
          applyLook(s);
        }
        // Programs for the direct path (tone mapped, sRGB out)...
        renderer.setRenderTarget(null);
        scene.background = backgroundDirect;
        await compile();
        // ...and for render targets (linear out), with geometry and textures uploaded and
        // the shadow depth materials built by an actual draw.
        renderer.setRenderTarget(target);
        scene.background = backgroundLinear;
        await compile();
        renderer.render(scene, camera);
        // The AO G-buffer draws everything with one override material, skinned or not.
        scene.overrideMaterial = gtao.normalMaterial;
        renderer.render(scene, camera);
        scene.overrideMaterial = null;
        renderer.setRenderTarget(null);
      }
    } finally {
      states.forEach((s, i) => {
        s.prefixes = saved[i].prefixes;
        s.xray = saved[i].xray;
        applyLook(s);
      });
      for (const [o, f] of culled) o.frustumCulled = f;
      for (const o of added) scene.remove(o);
      target.dispose();
    }
    // One pass through the composer compiles its full-screen passes even when the tier
    // starts without AO, so stepping up later does not stall; then the real first frame.
    const enabled = gtao.enabled;
    gtao.enabled = true;
    scene.background = backgroundLinear;
    composer.render(0);
    gtao.enabled = enabled;
    draw(0);
    warming = false;
  };

  // ----- Public object -----

  const stage: Stage = {
    renderer,
    scene,
    camera,
    lights: { key, fill, rim, ambient },
    floor,
    accent,
    views,
    get view() {
      return view;
    },
    get tier() {
      return tier;
    },
    gpu,
    rig() {
      return {
        target: [springs.tx.y, springs.ty.y, springs.tz.y],
        azimuth: springs.az.y,
        elevation: springs.el.y,
        distance: springs.dist.y,
      };
    },

    setView(id, o = {}) {
      if (id === 'follow' && view !== 'follow') {
        // Follow keeps the direction the camera already looks in.
        views.follow.azimuth = springs.az.y - orbitOffset.az;
      }
      view = id;
      if (o.snap) snapNext = true;
    },
    orbit(dAz, dEl) {
      orbitOffset.az += dAz;
      orbitOffset.el = clamp(orbitOffset.el + dEl, -80, 80);
    },
    zoom(factor) {
      if (factor > 0) orbitOffset.zoom = clamp(orbitOffset.zoom * factor, 0.25, 3);
    },
    resetOrbit() {
      orbitOffset.az = 0;
      orbitOffset.el = 0;
      orbitOffset.zoom = 1;
    },
    lookAt(target) {
      lookTarget = target ? [...target] : null;
    },
    shot(next) {
      // Leaving a beat that turned the follow view keeps the camera where the beat left it.
      if (!next && shot?.heading !== undefined && view === 'follow') views.follow.azimuth = shot.heading;
      shot = next ? { ...next } : null;
    },
    eye() {
      if (view === 'head' || view === 'follow') return null;
      const d = desired();
      const az = d.azimuth * DEG;
      const el = d.elevation * DEG;
      return [
        d.target[0] + d.distance * Math.sin(az) * Math.cos(el),
        d.target[1] + d.distance * Math.sin(el),
        d.target[2] + d.distance * Math.cos(az) * Math.cos(el),
      ];
    },
    select(model) {
      selected = model;
    },
    fit(subject, fill = 0.65) {
      fitFill = fill;
      if (subject === null) fitBox = null;
      else if (subject instanceof Box3) fitBox = subject.clone();
      else {
        const box = new Box3();
        for (const o of Array.isArray(subject) ? subject : [subject]) box.expandByObject(o);
        fitBox = box.isEmpty() ? null : box;
      }
      refit();
    },
    screenToFloor(x, y) {
      const ndc = new Vector2((x / cssWidth) * 2 - 1, -(y / cssHeight) * 2 + 1);
      const ray = new Raycaster();
      ray.setFromCamera(ndc, camera);
      const hit = ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), new Vector3());
      if (!hit || hit.distanceTo(camera.position) > 40) return null;
      return [hit.x, 0, hit.z];
    },
    project(point) {
      const v = new Vector3(point[0], point[1], point[2]).project(camera);
      if (v.z > 1) return [NaN, NaN];
      return [((v.x + 1) / 2) * cssWidth, ((1 - v.y) / 2) * cssHeight];
    },

    add(obj) {
      scene.add(obj);
    },
    remove(obj) {
      scene.remove(obj);
    },
    addOccluder(obj) {
      const sphere = new Box3().setFromObject(obj).getBoundingSphere(new Sphere());
      occluders.push({ obj, centre: sphere.center, radius: sphere.radius });
    },
    addProp(kind, obj) {
      props.push({ kind, obj });
    },
    focus(kinds) {
      focusKinds = kinds ? [...kinds] : null;
    },
    addCat(model) {
      stateOf(model);
      scene.add(model.root);
    },
    isolate(model, prefixes) {
      const s = stateOf(model);
      s.prefixes = prefixes ? [...prefixes] : null;
      applyLook(s);
    },
    xray(model, on) {
      const s = stateOf(model);
      s.xray = on;
      applyLook(s);
    },
    explode(model, amount, seconds = 0.6) {
      const e = stateOf(model).explode;
      e.from = e.amount;
      e.to = clamp(amount, 0, 1);
      e.t = 0;
      // Even an immediate set (seconds 0) lands in frame(), which knows the current pose.
      e.length = Math.max(0, seconds);
    },

    frame(dt) {
      if (warming) return;
      const step = clamp(dt, 0, 0.25);
      for (const s of cats.values()) applyExplode(s, step);
      updateCamera(step);
      clearSightLine();
      draw(step);
    },
    resize,
    setTier,
    warm,
    dispose() {
      composer.dispose();
      gtao.dispose();
      renderer.dispose();
    },
  };

  setTier(0);
  return stage;
}
