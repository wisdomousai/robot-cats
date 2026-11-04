// Development check for the console: the stage with three placeholder cats made of
// primitives, the console on top fed by the mock readout, live input and the auto tour.
// The placeholders follow the mock's positions, headings, gait and postures, so the
// floor map, the name tags and the callout leader can be checked against the 3D view.
import {
  Bone,
  Box3,
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { lathe, placed, superellipsoid, torus, tube } from '../cats/geo/primitives';
import type { BoneName, Breed, BreedId, CatModel, FaceLike, MaterialRole, PartDef, SystemId, V3, WorldReadout } from '../cats/types';
import { createConsole } from '../showcase/console';
import { createCursor } from '../showcase/cursor';
import { createPlayer, exposeFilm, type FilmHost } from '../showcase/film';
import { createControls, createLive } from '../showcase/live';
import { createGovernor, perfLog, startTier, type TierId } from '../showcase/quality';
import { createStage, STUDIO } from '../showcase/stage';
import { createMockWorld } from './mock-readout';

const ACCENT = '#ff5a1f';
const params = new URLSearchParams(location.search);

// ---------- Placeholder cats ----------

interface Piece {
  name: string;
  system: SystemId;
  bone: BoneName;
  role: MaterialRole;
  geometry: BufferGeometry;
  at: V3;
  explode: V3;
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

const SHELL: Record<BreedId, { shell: string; dark: string }> = {
  tabby: { shell: '#e9a15c', dark: '#7a4a24' },
  siamese: { shell: '#efe4d0', dark: '#4e3a2e' },
  black: { shell: '#2e2e33', dark: '#18181b' },
};

/** A stand-in cat with the CatModel contract: meshes under bones, parts info in userData. */
function placeholderCat(id: BreedId): CatModel {
  const colours = SHELL[id];
  const root = new Group();
  root.name = `cat.${id}`;
  const bones = new Map<string, Bone>();
  const bone = (name: BoneName, parent: Object3D, at: V3) => {
    const b = new Bone();
    b.name = name;
    b.position.set(...at);
    parent.add(b);
    bones.set(name, b);
    return b;
  };
  const rootBone = bone('root', root, [0, 0, 0]);
  const body = bone('body', rootBone, [0, 0.27, 0]);
  const head = bone('head', body, [0, 0.14, 0.19]);
  bone('ear.L', head, [0.075, 0.1, 0]);
  bone('ear.R', head, [-0.075, 0.1, 0]);
  for (const [leg, x, z] of [['FL', 1, 1], ['FR', -1, 1], ['BL', 1, -1], ['BR', -1, -1]] as const) {
    bone(`leg.${leg}`, body, [0.072 * x, -0.06, 0.13 * z]);
  }
  bone('tail.1', body, [0, 0.03, -0.19]);

  const materials: Record<string, Material> = {
    shell: new MeshStandardMaterial({ color: colours.shell, roughness: 0.42 }),
    joint: new MeshStandardMaterial({ color: '#4a4f57', roughness: 0.35, metalness: 0.2 }),
    inner: new MeshStandardMaterial({ color: colours.dark, roughness: 0.5 }),
    screen: new MeshStandardMaterial({ color: '#14171c', roughness: 0.25 }),
    pad: new MeshStandardMaterial({ color: '#d98a7a', roughness: 0.6 }),
    ghost: new MeshBasicMaterial({ color: '#8f969f', transparent: true, opacity: 0.16, depthWrite: false }),
    xray: new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }),
  };

  const pieces: Piece[] = [
    { name: 'Body.Shell', system: 'body', bone: 'body', role: 'shell', geometry: superellipsoid([0.12, 0.11, 0.21], 0.6, 0.6, [40, 24]), at: [0, 0, 0], explode: [0, 0, 0] },
    { name: 'BellyPlate', system: 'belly', bone: 'body', role: 'inner', geometry: superellipsoid([0.075, 0.02, 0.13], 0.4, 0.4, [24, 12]), at: [0, -0.1, 0.01], explode: [0, -1, 0] },
    { name: 'Collar.Ring', system: 'collar', bone: 'head', role: 'joint', geometry: torus(0.07, 0.012, [36, 8]), at: [0, -0.09, -0.02], explode: [0, -0.3, 1] },
    { name: 'Head.Shell', system: 'head', bone: 'head', role: 'shell', geometry: superellipsoid([0.14, 0.11, 0.115], 0.4, 0.4, [40, 24], 0.2), at: [0, 0.02, 0.02], explode: [0, 0.6, 0.8] },
    { name: 'Screen.Glass', system: 'eyes', bone: 'head', role: 'screen', geometry: superellipsoid([0.1, 0.065, 0.02], 0.3, 0.3, [32, 12]), at: [0, 0.025, 0.125], explode: [0, 0.3, 1] },
    ...(['L', 'R'] as const).map((side): Piece => ({
      name: `Ear.${side}`,
      system: 'ears',
      bone: `ear.${side}`,
      role: 'inner',
      geometry: placed(lathe([[0, 0.085], [0.018, 0.07], [0.042, 0.02], [0.048, 0]], 20), [0, 0, 0], [0, 0, side === 'L' ? -0.35 : 0.35]),
      at: [0, 0, 0],
      explode: norm([side === 'L' ? 0.7 : -0.7, 0.7, 0]),
    })),
    ...(['L', 'R'] as const).flatMap((side): Piece[] => {
      const s = side === 'L' ? 1 : -1;
      return [1, 2].map((n): Piece => ({
        name: `Whisker.${side}${n}`,
        system: 'whiskers',
        bone: 'head',
        role: 'joint',
        geometry: tube([[0.09 * s, 0, 0.11], [0.16 * s, 0.006 * (n === 1 ? 1 : -1), 0.12], [0.22 * s, 0.014 * (n === 1 ? 1 : -1), 0.11]], 0.0035, 6),
        at: [0, -0.01 - 0.012 * n, 0],
        explode: norm([s, 0, 0.4]),
      }));
    }),
    ...(['FL', 'FR', 'BL', 'BR'] as const).flatMap((leg): Piece[] => {
      const x = leg.endsWith('L') ? 1 : -1;
      const z = leg.startsWith('F') ? 1 : -1;
      return [
        { name: `Leg.${leg}`, system: 'legs', bone: `leg.${leg}`, role: 'joint', geometry: tube([[0, 0, 0], [0, -0.1, 0.005], [0, -0.19, 0]], 0.027, 14), at: [0, 0, 0], explode: norm([0.8 * x, -0.2, 0.5 * z]) },
        { name: `Paw.${leg}`, system: 'paws', bone: `leg.${leg}`, role: 'inner', geometry: superellipsoid([0.038, 0.022, 0.05], 0.5, 0.6, [20, 10]), at: [0, -0.2, 0.012], explode: norm([0.5 * x, -0.4, 0.8 * z]) },
        { name: `Pad.${leg}`, system: 'kneading', bone: `leg.${leg}`, role: 'pad', geometry: superellipsoid([0.026, 0.006, 0.032], 0.5, 0.5, [16, 8]), at: [0, -0.222, 0.016], explode: norm([0.3 * x, -1, 0.3 * z]) },
      ];
    }),
    { name: 'Tail.Tube', system: 'tail', bone: 'tail.1', role: 'shell', geometry: tube([[0, 0, 0], [0, 0.04, -0.1], [0, 0.15, -0.15], [0, 0.27, -0.12]], [0.026, 0.017], 14, { samples: 16 }), at: [0, 0, 0], explode: norm([0, 0.4, -0.9]) },
  ];

  const meshes: Object3D[] = [];
  const parts: PartDef[] = [];
  for (const p of pieces) {
    const mesh = new Mesh(p.geometry, materials[p.role === 'shell' ? 'shell' : p.role]);
    mesh.name = p.name;
    mesh.position.set(...p.at);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { parts: [p.name], system: p.system, bone: p.bone, explode: p.explode };
    bones.get(p.bone)!.add(mesh);
    meshes.push(mesh);
    parts.push({ name: p.name, system: p.system, bone: p.bone, geometry: p.geometry, role: p.role, explode: p.explode });
  }

  const face: FaceLike = { expression: 'neutral', look: { x: 0, y: 0 }, blink: 0, dilate: 0, talk: 0, update() {} };
  const breed = { id, name: id, what: 'placeholder', dims: {}, feels: {}, temperament: { energy: 1, social: 1, napping: 1 } } as unknown as Breed;
  return { breed, root, bones, parts, meshes, materials, recoat() {}, face, light() {} };
}

/** Coat buttons on the placeholders: shell and inner colours of another breed. */
function recoat(model: CatModel, coat: BreedId) {
  (model.materials.shell as MeshStandardMaterial).color.set(SHELL[coat].shell);
  (model.materials.inner as MeshStandardMaterial).color.set(SHELL[coat].dark);
}

/** Poses a placeholder from its readout: place, heading, legs on the gait, posture, head, ears. */
function poseCat(model: CatModel, world: WorldReadout) {
  const r = world.cats.find((c) => c.id === model.breed.id);
  if (!r) return;
  model.root.position.set(r.position[0], 0, r.position[2]);
  model.root.rotation.y = (r.heading * Math.PI) / 180;
  const body = model.bones.get('body')!;
  const moving = r.gait !== 'still';
  const swing = Math.min(0.55, r.speed * 0.7);
  for (const leg of ['FL', 'FR', 'BL', 'BR'] as const) {
    const b = model.bones.get(`leg.${leg}`)!;
    const phase = leg === 'FL' || leg === 'BR' ? 0 : Math.PI;
    let pitch = moving ? swing * Math.sin(r.gaitPhase + phase) : 0;
    if (r.posture === 'sit' && leg.startsWith('B')) pitch = -1.1;
    if (r.posture === 'lie') pitch = leg.startsWith('F') ? 1.3 : -1.3;
    b.rotation.x = pitch;
  }
  body.rotation.x = r.posture === 'sit' ? -0.38 : 0;
  body.position.y = r.posture === 'sit' ? 0.24 : r.posture === 'lie' ? 0.13 : 0.27;
  body.scale.set(1 + r.squash * 0.25, 1 - r.squash * 0.4, 1 + r.squash * 0.1);
  const head = model.bones.get('head')!;
  head.rotation.y = (r.headYaw * Math.PI) / 180;
  head.rotation.x = r.posture === 'sit' ? 0.3 : 0;
  model.bones.get('ear.L')!.rotation.y = (r.earAzimuth[0] * Math.PI) / 180;
  model.bones.get('ear.R')!.rotation.y = (r.earAzimuth[1] * Math.PI) / 180;
  model.bones.get('tail.1')!.rotation.x = (-(r.tailCarriage - 60) * Math.PI) / 180 / 2;
}

// ---------- Toys ----------

function toyMeshes(): Record<string, Object3D> {
  const mat = (color: string) => new MeshStandardMaterial({ color, roughness: 0.7 });
  const mesh = (geo: BufferGeometry, color: string, y: number) => {
    const m = new Mesh(geo, mat(color));
    m.position.y = y;
    m.castShadow = true;
    m.receiveShadow = true;
    const g = new Group();
    g.add(m);
    return g;
  };
  const ledge = new Group();
  {
    const shelf = new Mesh(new BoxGeometry(0.7, 0.04, 0.22), mat('#d9d4c8'));
    shelf.position.set(0, 0.68, 0);
    const post = new Mesh(new BoxGeometry(0.05, 0.66, 0.05), mat('#cfc9bb'));
    post.position.set(0, 0.33, -0.05);
    for (const m of [shelf, post]) {
      m.castShadow = true;
      m.receiveShadow = true;
      ledge.add(m);
    }
    ledge.position.set(0.4, 0, -0.95);
  }
  const laser = new Mesh(new CircleGeometry(0.018, 20), new MeshBasicMaterial({ color: ACCENT }));
  laser.rotation.x = -Math.PI / 2;
  laser.position.y = 0.002;
  const laserGroup = new Group();
  laserGroup.add(laser);
  return {
    box: mesh(new BoxGeometry(0.36, 0.2, 0.28), '#d2b48c', 0.1),
    bed: mesh(new CylinderGeometry(0.2, 0.21, 0.07, 32), '#c9d3dc', 0.035),
    keyboard: mesh(new BoxGeometry(0.42, 0.025, 0.14), '#5b5f66', 0.0125),
    cushion: mesh(new SphereGeometry(0.17, 24, 12).scale(1, 0.25, 0.9), '#e3c4b5', 0.04),
    cup: mesh(new CylinderGeometry(0.035, 0.03, 0.08, 20), '#7aa0c4', 0.04),
    ball: mesh(new SphereGeometry(0.04, 20, 12), '#4f86c6', 0.04),
    yarn: mesh(new SphereGeometry(0.05, 20, 12), '#c96f8f', 0.05),
    bird: mesh(new SphereGeometry(0.04, 16, 8).scale(1.4, 1, 1), '#6f7f8f', 0),
    laser: laserGroup,
    ledge,
  };
}

// ---------- Page ----------

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const overlay = document.getElementById('overlay')!;
const stage = createStage(canvas, { accent: ACCENT });

const models = (['tabby', 'siamese', 'black'] as BreedId[]).map(placeholderCat);
for (const m of models) stage.addCat(m);
const toys = toyMeshes();
for (const o of Object.values(toys)) stage.add(o);

// Frame the whole play area so the console's side columns do not cover it.
stage.fit(new Box3(new Vector3(-STUDIO.play.x, 0, -STUDIO.play.z), new Vector3(STUDIO.play.x, 0.55, STUDIO.play.z)), 0.56);

const world = createMockWorld(Number(params.get('seed') ?? 1));
const con = createConsole(overlay, { title: 'Robot cats, console check' });
const cursor = createCursor(overlay, { accent: ACCENT });
const controls = createControls({ stage, models, recoat });
const ui = controls.ui;
controls.sync();

const governor = createGovernor(startTier());
if (params.has('tier')) governor.pin(governor.tier);
stage.setTier(governor.tier);

let pageTime = 0;
let acc = 0;
const STEP = 1 / 60;

const syncScene = (r: WorldReadout) => {
  for (const m of models) poseCat(m, r);
  for (const t of r.toys) {
    const o = toys[t.kind];
    if (!o) continue;
    o.position.set(t.position[0], t.position[1], t.position[2]);
  }
  toys.laser.visible = !!r.laser;
  toys.bird.visible = true;
};

const host: FilmHost = {
  press: (id, value) => controls.press(id, value),
  input: (input) => controls.feed(input),
  caption: (text) => {
    ui.caption = text;
  },
  // The mock page has no toys to aim at; the beat's turn and zoom are enough here.
  shot: (s) => stage.shot(s ? { ...s, toward: undefined } : null),
  value: (id) => controls.value(id),
  reset: () => {
    world.reset();
    controls.reset();
    acc = 0;
  },
  step: (dt) => {
    const input = controls.drain();
    input.cursor = null;
    world.update(input, dt);
  },
  render: () => {
    controls.sync();
    const r = world.state();
    syncScene(r);
    stage.frame(0);
    controls.overlay(con);
    con.draw(r, ui, pageTime);
  },
};

const player = createPlayer({ cursor, console: con, host });
const live = createLive({ stage, console: con, controls, player, cursor });
exposeFilm(player);

(window as unknown as { __check: unknown }).__check = { stage, world, con, controls, player, live, ui };

window.addEventListener('resize', () => stage.resize());

let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
  last = now;
  pageTime += dt;

  const tier = governor.sample(dt);
  if (tier !== stage.tier.id) stage.setTier(tier as TierId);
  perfLog.frame(dt, stage.tier.id);

  live.update(pageTime, dt);
  player.update(pageTime);

  acc += dt;
  let n = 0;
  while (acc >= STEP && n < 8) {
    const input = controls.drain();
    input.cursor = live.floor();
    world.update(input, STEP);
    acc -= STEP;
    n++;
  }
  if (n === 8) acc = 0;

  const r = world.state();
  syncScene(r);
  cursor.update(pageTime);
  stage.frame(dt);

  ui.fps = governor.fps;
  ui.tier = stage.tier.id;
  controls.overlay(con);
  con.frame(r, ui, pageTime, stage.tier.id);
  requestAnimationFrame(loop);
}

stage.resize();
stage.warm(models).then(() => {
  canvas.style.opacity = '1';
  last = performance.now();
  player.start(pageTime);
  requestAnimationFrame(loop);
});
