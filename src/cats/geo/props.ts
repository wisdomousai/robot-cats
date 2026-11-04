import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import type { Toys } from '../brain/toys';
import type { ToyKind, V3 } from '../types';
import { cut, lathe, placed, plate, stretch, superellipsoid, torus, tube } from './primitives';

/**
 * Meshes for the toys and props in brain/toys.ts, in the pale studio style: warm whites,
 * kraft, fabric and graphite, with the accent colour on the laser dot only. Everything is
 * built from the primitives, sized from the simulation objects so the two always agree,
 * and stands on the floor at y = 0 (the bird and its perch hang on the back wall).
 *
 * `createProps(sim)` builds the meshes once; `syncProps(sim, meshes)` places the moving
 * ones every frame. Static props (ledge, box, bed, keyboard, cushion, perch) are placed
 * when built.
 */

export const PROP_COLOURS = {
  paper: '#f3f0e9',
  stone: '#e2ddd3',
  graphite: '#4a4f57',
  kraft: '#d8c6a6',
  fabric: '#e8e2d6',
  fabricDeep: '#d4cbbb',
  ball: '#dde3e8',
  yarn: '#dcc1ab',
  yarnDeep: '#c9aa92',
  ceramic: '#f7f5f0',
  key: '#f6f5f1',
  accent: '#ff5a1f',
} as const;

export interface PropMeshes {
  /** Add this to the scene. */
  root: Group;
  /** One group per toy, named `prop.<kind>`. */
  parts: Record<ToyKind, Group>;
  materials: Record<string, Material>;
  /** Moving pieces syncProps drives. */
  rope: Mesh;
  keys: InstancedMesh;
  cushionBody: Object3D;
  birdHead: Object3D;
  birdWings: [Object3D, Object3D];
  birdBody: Object3D;
  dispose(): void;
}

const DEG = Math.PI / 180;

function mesh(geo: BufferGeometry, material: Material, name: string, shadow = true): Mesh {
  const m = new Mesh(geo, material);
  m.name = name;
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

function group(name: string, at: V3 = [0, 0, 0], yaw = 0): Group {
  const g = new Group();
  g.name = name;
  g.position.set(...at);
  g.rotation.y = yaw * DEG;
  return g;
}

// ---------- The yarn strand ----------

/** Sides of the strand's cross-section. Six read as round at the strand's 9 mm width. */
const ROPE_SIDES = 6;

/**
 * A tube through the yarn's verlet points, rewritten in place each frame. Rings follow
 * parallel-transport frames so the strand does not twist, and normals are the ring
 * directions, exact for a round tube, so nothing is recomputed from the triangles.
 */
class Rope {
  readonly mesh: Mesh;
  private readonly geo: BufferGeometry;
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  private readonly t: Vector3[];

  constructor(
    readonly count: number,
    readonly radius: number,
    material: Material,
  ) {
    const n = count * ROPE_SIDES;
    this.pos = new Float32Array(n * 3);
    this.nor = new Float32Array(n * 3);
    this.t = Array.from({ length: count }, () => new Vector3());
    const index: number[] = [];
    for (let i = 0; i < count - 1; i++) {
      for (let j = 0; j < ROPE_SIDES; j++) {
        const a = i * ROPE_SIDES + j;
        const b = i * ROPE_SIDES + ((j + 1) % ROPE_SIDES);
        const c = a + ROPE_SIDES;
        const d = b + ROPE_SIDES;
        index.push(a, b, c, b, d, c);
      }
    }
    this.geo = new BufferGeometry();
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    this.geo.setAttribute('normal', new BufferAttribute(this.nor, 3).setUsage(DynamicDrawUsage));
    this.geo.setIndex(index);
    this.mesh = mesh(this.geo, material, 'Yarn.Strand');
    // The strand moves anywhere on the floor; its bounds are not worth recomputing.
    this.mesh.frustumCulled = false;
  }

  update(points: Float64Array): void {
    const n = this.count;
    const P = (i: number, out: Vector3) => out.set(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
    const a = new Vector3();
    const b = new Vector3();
    for (let i = 0; i < n; i++) {
      P(Math.min(n - 1, i + 1), a);
      P(Math.max(0, i - 1), b);
      this.t[i].subVectors(a, b);
      if (this.t[i].lengthSq() < 1e-12) this.t[i].set(1, 0, 0);
      this.t[i].normalize();
    }
    // First frame: any normal across the first tangent.
    const normal = new Vector3(0, 1, 0);
    if (Math.abs(normal.dot(this.t[0])) > 0.9) normal.set(1, 0, 0);
    normal.addScaledVector(this.t[0], -normal.dot(this.t[0])).normalize();
    const binormal = new Vector3();
    const centre = new Vector3();
    for (let i = 0; i < n; i++) {
      const t = this.t[i];
      normal.addScaledVector(t, -normal.dot(t));
      if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0).addScaledVector(t, -t.y);
      normal.normalize();
      binormal.crossVectors(t, normal);
      P(i, centre);
      for (let j = 0; j < ROPE_SIDES; j++) {
        const th = (2 * Math.PI * j) / ROPE_SIDES;
        const c = Math.cos(th);
        const s = Math.sin(th);
        const nx = c * normal.x + s * binormal.x;
        const ny = c * normal.y + s * binormal.y;
        const nz = c * normal.z + s * binormal.z;
        const k = (i * ROPE_SIDES + j) * 3;
        this.nor[k] = nx;
        this.nor[k + 1] = ny;
        this.nor[k + 2] = nz;
        this.pos[k] = centre.x + nx * this.radius;
        this.pos[k + 1] = centre.y + ny * this.radius;
        this.pos[k + 2] = centre.z + nz * this.radius;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
  }
}

// ---------- Building ----------

export function createProps(sim: Toys, opts: { accent?: string; wallZ?: number } = {}): PropMeshes {
  const C = PROP_COLOURS;
  const std = (color: string, roughness = 0.7, metalness = 0) => new MeshStandardMaterial({ color, roughness, metalness });
  const materials: Record<string, Material> = {
    paper: std(C.paper, 0.62),
    stone: std(C.stone, 0.75),
    graphite: std(C.graphite, 0.4, 0.2),
    kraft: std(C.kraft, 0.88),
    fabric: std(C.fabric, 0.96),
    fabricDeep: std(C.fabricDeep, 0.96),
    ball: std(C.ball, 0.45),
    yarn: std(C.yarn, 0.95),
    yarnDeep: std(C.yarnDeep, 0.95),
    ceramic: std(C.ceramic, 0.25),
    key: std(C.key, 0.5),
    laser: new MeshBasicMaterial({ color: opts.accent ?? C.accent, toneMapped: false }),
    laserGlow: new MeshBasicMaterial({ color: opts.accent ?? C.accent, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false }),
  };
  const M = materials;
  const root = group('props');

  // ----- Ball: a light sphere with two crossing seams, so the roll shows -----
  const ball = group('prop.ball');
  {
    const r = sim.ball.radius;
    ball.add(mesh(superellipsoid([r, r, r], 1, 1, [32, 20]), M.ball, 'Ball.Shell'));
    ball.add(mesh(torus(r * 0.995, 0.0028, [40, 6]), M.graphite, 'Ball.Seam1', false));
    ball.add(mesh(torus(r * 0.995, 0.0028, [40, 6], { axis: 'x' }), M.graphite, 'Ball.Seam2', false));
  }

  // ----- Yarn: a wound ball and its loose strand -----
  const yarn = group('prop.yarn');
  const yarnBall = group('Yarn.Ball');
  {
    const r = sim.yarn.ballRadius;
    yarnBall.add(mesh(superellipsoid([r, r, r], 1, 1, [28, 18]), M.yarn, 'Yarn.Core'));
    // Windings: thin loops round the core at fixed tilts, like turns of wool.
    const tilts: V3[] = [
      [0, 0, 0.3],
      [0.9, 0, 0.2],
      [-0.6, 0.4, 1.1],
      [1.4, 0.8, 0],
      [0.3, 1.2, -0.9],
      [-1.2, -0.5, 0.6],
    ];
    tilts.forEach((rot, i) => yarnBall.add(mesh(placed(torus(r * 0.985, 0.0042, [36, 5]), [0, 0, 0], rot), M.yarnDeep, `Yarn.Winding${i + 1}`, false)));
  }
  yarn.add(yarnBall);
  const rope = new Rope(sim.yarn.count, sim.yarn.thread, M.yarn);
  yarn.add(rope.mesh);

  // ----- Laser dot: a bright core and a soft halo, flat on the floor -----
  const laser = group('prop.laser');
  {
    laser.add(mesh(superellipsoid([0.0085, 0.0008, 0.0085], 1, 1, [20, 6]), M.laser, 'Laser.Dot', false));
    const glow = mesh(superellipsoid([0.026, 0.0004, 0.026], 1, 1, [24, 4]), M.laserGlow, 'Laser.Glow', false);
    glow.renderOrder = 2;
    laser.add(glow);
    laser.visible = false;
  }

  // ----- Ledge: a plinth with a plinth base -----
  const ledge = group('prop.ledge', sim.ledge.position);
  {
    const [w, h, d] = sim.ledge.size;
    ledge.add(mesh(placed(superellipsoid([w / 2, (h - 0.012) / 2, d / 2], 0.1, 0.12, [40, 16]), [0, 0.012 + (h - 0.012) / 2, 0]), M.paper, 'Ledge.Block'));
    ledge.add(mesh(placed(superellipsoid([w / 2 + 0.008, 0.006, d / 2 + 0.008], 0.2, 0.12, [40, 8]), [0, 0.006, 0]), M.stone, 'Ledge.Base'));
  }

  // ----- Cup: a mug with a handle, origin at the centre of its base -----
  const cup = group('prop.cup');
  {
    const r = sim.cup.radius;
    const h = sim.cup.height;
    const wall = 0.004;
    const body = lathe(
      [
        [0, 0],
        [r - 0.004, 0],
        [r, 0.004],
        [r, h - 0.002],
        [r - 0.0008, h],
        [r - wall + 0.0005, h],
        [r - wall, h - 0.003],
        [r - wall, 0.011],
        [0, 0.01],
      ],
      36,
    );
    cup.add(mesh(body, M.ceramic, 'Cup.Body'));
    const handle = cut(placed(torus(0.021, 0.0052, [28, 8], { axis: 'z' }), [r + 0.006, h * 0.52, 0], [0, 0, 0], [0.85, 1, 1]), [1, 0, 0], r - 0.002, false);
    cup.add(mesh(handle, M.ceramic, 'Cup.Handle'));
    cup.add(mesh(placed(torus(r + 0.0004, 0.0016, [36, 4]), [0, h * 0.78, 0]), M.stone, 'Cup.Band', false));
  }

  // ----- Box: open kraft box with four flaps folded out -----
  const box = group('prop.box', sim.box.position, sim.box.yaw);
  {
    const [w, h, d] = sim.box.size;
    const t = 0.006;
    const r = 0.06;
    box.add(mesh(placed(plate(w, h, t, r), [0, h / 2, d / 2 - t / 2]), M.kraft, 'Box.Front'));
    box.add(mesh(placed(plate(w, h, t, r), [0, h / 2, -d / 2 + t / 2]), M.kraft, 'Box.Back'));
    box.add(mesh(placed(plate(d - 2 * t, h, t, r), [w / 2 - t / 2, h / 2, 0], [0, Math.PI / 2, 0]), M.kraft, 'Box.SideL'));
    box.add(mesh(placed(plate(d - 2 * t, h, t, r), [-w / 2 + t / 2, h / 2, 0], [0, Math.PI / 2, 0]), M.kraft, 'Box.SideR'));
    box.add(mesh(placed(plate(w - 2 * t, d - 2 * t, t, r), [0, t / 2, 0], [-Math.PI / 2, 0, 0]), M.kraft, 'Box.Floor'));
    // Flaps hinge on the top edges and lean out 25° above level.
    const lean = 25 * DEG;
    const long = d * 0.46;
    const short = w * 0.3;
    for (const s of [1, -1]) {
      const leaf = superellipsoid([w / 2 - 0.004, long / 2, t / 2], r, r, [24, 8], 0, { axis: 'z' });
      const dir: V3 = [0, Math.sin(lean), Math.cos(lean) * s];
      box.add(mesh(placed(leaf, [0, h + (dir[1] * long) / 2, (s * d) / 2 + (dir[2] * long) / 2], [s * (Math.PI / 2 - lean), 0, 0]), M.kraft, s > 0 ? 'Box.FlapFront' : 'Box.FlapBack'));
      const side = superellipsoid([t / 2, short / 2, d / 2 - 0.006], r, r, [24, 8], 0, { axis: 'x' });
      const sdir: V3 = [Math.cos(lean) * s, Math.sin(lean), 0];
      box.add(mesh(placed(side, [(s * w) / 2 + (sdir[0] * short) / 2, h + (sdir[1] * short) / 2, 0], [0, 0, -s * (Math.PI / 2 - lean)]), M.kraft, s > 0 ? 'Box.FlapL' : 'Box.FlapR'));
    }
  }

  // ----- Bed: a padded ring round a cushion -----
  const bed = group('prop.bed', sim.bed.position);
  {
    const R = sim.bed.radius;
    // The rim is a flattened roll resting on the floor; its top is the bed's height.
    const roll = sim.bed.height / 1.7;
    const rimY = roll * 0.85;
    bed.add(mesh(placed(superellipsoid([R - roll, 0.032, R - roll], 0.5, 1, [40, 12]), [0, 0.032, 0]), M.fabric, 'Bed.Cushion'));
    bed.add(mesh(placed(stretch(torus(R - roll, roll, [48, 16]), 1, 0.85, 1), [0, rimY, 0]), M.fabricDeep, 'Bed.Rim'));
  }

  // ----- Keyboard: a low base and one instanced key cap per key -----
  const keyboard = group('prop.keyboard', sim.keyboard.position, sim.keyboard.yaw);
  const layout = sim.keyboard.layout;
  const keys = new InstancedMesh(superellipsoid([0.5, 0.5, 0.5], 0.3, 0.25, [16, 8]), M.key, layout.length);
  {
    const [w, h, d] = sim.keyboard.size;
    keyboard.add(mesh(placed(superellipsoid([w / 2, h * 0.32, d / 2], 0.2, 0.12, [40, 8]), [0, h * 0.32, 0]), M.stone, 'Keyboard.Base'));
    keys.name = 'Keyboard.Keys';
    keys.castShadow = false;
    keys.receiveShadow = true;
    keys.userData.down = new Uint8Array(layout.length);
    placeKeys(keys, sim, true);
    keyboard.add(keys);
  }

  // ----- Cushion: a square cushion with a button in the middle -----
  const cushion = group('prop.cushion', sim.cushion.position);
  const cushionBody = group('Cushion.Body');
  {
    const [w, h, d] = sim.cushion.size;
    cushionBody.add(mesh(placed(superellipsoid([w / 2, h / 2, d / 2], 0.45, 0.3, [40, 16]), [0, h / 2, 0]), M.fabric, 'Cushion.Pad'));
    cushionBody.add(mesh(placed(superellipsoid([0.012, 0.006, 0.012], 1, 1, [12, 6]), [0, h - 0.002, 0]), M.fabricDeep, 'Cushion.Button', false));
    cushion.add(cushionBody);
  }

  // ----- Bird: a small robot bird on a perch on the back wall -----
  const bird = group('prop.bird');
  const perch = new Group();
  perch.name = 'Bird.Perch';
  const birdBody = group('Bird.Body');
  const birdHead = group('Bird.Head', [0, 0.06, 0.024]);
  const wingL = group('Bird.WingL', [0.023, 0.046, 0.004]);
  const wingR = group('Bird.WingR', [-0.023, 0.046, 0.004]);
  {
    const [a, b] = sim.bird.perch;
    const wallZ = opts.wallZ ?? a[2] - 0.07;
    const bar = 0.0055;
    perch.add(mesh(tube([[a[0] - 0.04, a[1] - bar, a[2]], [b[0] + 0.04, b[1] - bar, b[2]]], bar, 12), M.stone, 'Perch.Bar'));
    for (const [i, end] of [a, b].entries()) {
      const x = end[0] + (i === 0 ? -0.02 : 0.02);
      perch.add(mesh(tube([[x, end[1] - bar, wallZ], [x, end[1] - bar, end[2]]], 0.004, 8), M.graphite, `Perch.Arm${i + 1}`));
      perch.add(mesh(placed(superellipsoid([0.016, 0.016, 0.003], 1, 1, [20, 4], 0, { axis: 'z' }), [x, end[1] - bar, wallZ + 0.003]), M.stone, `Perch.Plate${i + 1}`));
    }

    birdBody.add(mesh(placed(superellipsoid([0.024, 0.023, 0.04], 0.9, 1, [24, 14], -0.2, { axis: 'z' }), [0, 0.036, 0], [-0.12, 0, 0]), M.paper, 'Bird.Shell'));
    birdBody.add(mesh(placed(plate(0.026, 0.034, 0.003, 0.4), [0, 0.042, -0.048], [-1.2, 0, 0]), M.stone, 'Bird.Tail'));
    for (const x of [0.008, -0.008]) birdBody.add(mesh(tube([[x, 0, 0.002], [x, 0.018, 0]], 0.0018, 6), M.graphite, 'Bird.Leg', false));
    birdHead.add(mesh(superellipsoid([0.018, 0.018, 0.019], 1, 1, [20, 12]), M.paper, 'Bird.HeadShell'));
    birdHead.add(mesh(placed(lathe([[0, 0.016], [0.0055, 0]], 12), [0, -0.002, 0.016], [Math.PI / 2, 0, 0]), M.graphite, 'Bird.Beak', false));
    for (const x of [0.0172, -0.0172]) {
      birdHead.add(mesh(placed(superellipsoid([0.0016, 0.004, 0.004], 1, 1, [10, 6], 0, { axis: 'x' }), [x, 0.004, 0.006]), M.graphite, 'Bird.Eye', false));
    }
    for (const [wing, s] of [[wingL, 1], [wingR, -1]] as const) {
      wing.add(mesh(placed(superellipsoid([0.003, 0.016, 0.03], 0.6, 0.6, [12, 8], 0, { axis: 'z' }), [0.002 * s, -0.012, -0.008], [-0.15, 0, 0]), M.stone, 'Bird.Wing'));
      birdBody.add(wing);
    }
    birdBody.add(birdHead);
    bird.add(birdBody);
  }

  const parts: Record<ToyKind, Group> = { ball, yarn, laser, cup, ledge, box, bed, keyboard, cushion, bird };
  for (const p of Object.values(parts)) root.add(p);
  root.add(perch);

  const meshes: PropMeshes = {
    root,
    parts,
    materials,
    rope: rope.mesh,
    keys,
    cushionBody,
    birdHead,
    birdWings: [wingL, wingR],
    birdBody,
    dispose() {
      root.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose();
      });
      for (const m of Object.values(materials)) m.dispose();
    },
  };
  meshes.rope.userData.rope = rope;
  syncProps(sim, meshes);
  return meshes;
}

// ---------- Every frame ----------

const qa = new Quaternion();
const qb = new Quaternion();
const axis = new Vector3();
const UP = new Vector3(0, 1, 0);
const m4 = new Matrix4();
const kp = new Vector3();
const kq = new Quaternion();
const ks = new Vector3();

/** How far a held key sinks, metres. */
const KEY_TRAVEL = 0.0035;

function placeKeys(keys: InstancedMesh, sim: Toys, all: boolean): void {
  const layout = sim.keyboard.layout;
  const held = sim.keyboard.held;
  const down = keys.userData.down as Uint8Array;
  const top = sim.keyboard.size[1] * 0.64;
  let changed = false;
  for (let i = 0; i < layout.length; i++) {
    const isDown = held[i] > 0 ? 1 : 0;
    if (!all && down[i] === isDown) continue;
    down[i] = isDown;
    const k = layout[i];
    const capH = 0.008;
    kp.set(k.x, top + capH / 2 - isDown * KEY_TRAVEL, k.z);
    ks.set(k.w, capH, k.d);
    m4.compose(kp, kq.identity(), ks);
    keys.setMatrixAt(i, m4);
    changed = true;
  }
  if (changed) keys.instanceMatrix.needsUpdate = true;
}

/** Places the moving props from the simulation. Call once per rendered frame. */
export function syncProps(sim: Toys, m: PropMeshes): void {
  const { ball, yarn, laser, cup, bird } = m.parts;

  ball.position.set(...sim.ball.position);
  ball.quaternion.set(...sim.ball.spin);

  const yarnBall = yarn.children[0];
  yarnBall.position.set(...sim.yarn.position);
  yarnBall.quaternion.set(...sim.yarn.spin);
  (m.rope.userData.rope as Rope).update(sim.yarn.points);

  laser.visible = sim.laser.on;
  // Just above the floor so the floor never shows through it.
  laser.position.set(sim.laser.position[0], 0.0012, sim.laser.position[2]);

  // The cup tips about the level axis across its fall direction, after turning on its own axis.
  const c = sim.cup;
  cup.position.set(...c.position);
  axis.set(Math.cos(c.dir), 0, -Math.sin(c.dir));
  qa.setFromAxisAngle(axis, c.tilt);
  qb.setFromAxisAngle(UP, c.spin);
  cup.quaternion.multiplyQuaternions(qa, qb);
  cup.scale.setScalar(Math.max(0.001, c.scale));

  placeKeys(m.keys, sim, false);

  const dent = sim.cushion.dent;
  m.cushionBody.scale.set(1 + 0.03 * dent, 1 - 0.28 * dent, 1 + 0.03 * dent);

  const b = sim.bird;
  bird.visible = b.present;
  bird.position.set(...b.position);
  // The bird's own +z is its beak; facing +x means a quarter turn.
  bird.rotation.y = b.facing * 90 * DEG;
  const flying = b.state === 'leaving' || b.state === 'arriving';
  m.birdBody.rotation.x = flying ? 0.35 : 0;
  // Its head turns toward the room (+z), which is its right when facing +x.
  m.birdHead.rotation.y = -b.facing * b.headYaw * DEG;
  m.birdHead.rotation.x = b.peck * 0.7;
  const [wl, wr] = m.birdWings;
  wl.rotation.z = b.flap * 1.3;
  wr.rotation.z = -b.flap * 1.3;
}
