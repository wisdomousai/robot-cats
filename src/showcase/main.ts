// The showcase page: the stage with the three cats of the cat world and the props, the
// console over it, live input that takes over from the tour, the tour player with its fake
// cursor, and the quality governor. The world steps at a fixed 120 Hz. `?seed=N` picks the
// seed, `?tier=N` pins a quality tier and `?debug` puts the tour on window.__film and the
// fps samples on window.__perf.
import { Box3, Vector3 } from 'three';
import { createProps, syncProps, type ToyKind, type V3, type WorldReadout } from '../cats/index';
import { createConsole } from './console';
import { createCursor } from './cursor';
import { createEngine, recoat } from './engine';
import { loadFonts } from './fonts';
import { createPlayer, exposeFilm, type FilmHost } from './film';
import { createControls, createLive } from './live';
import { createGovernor, perfLog, startTier, type TierId } from './quality';
import { createStage, STUDIO } from './stage';

/** Ink, as in the creatures playground: the x-ray, the tour cursor and the console's pressed keys. */
const INK = '#111111';
/** The laser dot stays a laser's red. */
const LASER = '#ff3b2f';
const STEP = 1 / 120;
/** At most this many world steps per frame, so a slow frame does not snowball. */
const MAX_STEPS = 4;
const DEG = Math.PI / 180;

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const overlay = document.getElementById('overlay')!;
const stage = createStage(canvas, { accent: INK });

const engine = createEngine(Number(params.get('seed') ?? 1), { accent: INK });
const models = engine.models;
for (const m of models) stage.addCat(m);
// The props follow whichever world is current; a reset swaps the world but not these meshes.
const props = createProps(engine.world.toys, { accent: LASER, wallZ: STUDIO.wallZ });
stage.add(props.root);
// The props a close view can end up behind; the stage hides them while they are in the way.
for (const kind of ['box', 'bed', 'ledge'] as const) stage.addOccluder(props.parts[kind]);
// Every prop by kind, so a close view of an isolated subsystem can show only its demo's props.
for (const [kind, obj] of Object.entries(props.parts)) stage.addProp(kind, obj);

/** A prop's place for a tour beat's camera. The bird comes and goes, so it is the middle of its perch. */
const toyPoint = (kind: ToyKind): V3 => {
  const toys = engine.world.toys;
  if (kind === 'bird') {
    const [a, b] = toys.bird.perch;
    return [(a[0] + b[0]) / 2, a[1], (a[2] + b[2]) / 2];
  }
  return [...toys.get(kind).position] as V3;
};

// Frame the whole play area so the console's side columns do not cover it.
stage.fit(new Box3(new Vector3(-STUDIO.play.x, 0, -STUDIO.play.z), new Vector3(STUDIO.play.x, 0.55, STUDIO.play.z)), 0.56);

/**
 * The world keeps cats that wait out a demo off the line between the demo cat and the
 * owner's eyes. On this page the eyes are the default camera, so tell the world where it is.
 */
const placeOwner = () => {
  const v = stage.views['three-quarter'];
  const az = v.azimuth * DEG;
  const el = v.elevation * DEG;
  const eye: V3 = [
    v.target[0] + v.distance * Math.sin(az) * Math.cos(el),
    v.target[1] + v.distance * Math.sin(el),
    v.target[2] + v.distance * Math.cos(az) * Math.cos(el),
  ];
  engine.world.ownerAt = eye;
};
placeOwner();
// Waiting cats keep out of the camera's way, wherever the tour or the visitor has put it.
engine.world.eye = () => stage.eye();

await loadFonts();
const con = createConsole(overlay);
const cursor = createCursor(overlay, { accent: INK });
const controls = createControls({ stage, models, recoat });
const ui = controls.ui;
controls.sync();

const governor = createGovernor(startTier());
if (params.has('tier')) governor.pin(governor.tier);
stage.setTier(governor.tier);

let pageTime = 0;
let acc = 0;

const syncScene = () => syncProps(engine.world.toys, props);

const host: FilmHost = {
  press: (id, value) => controls.press(id, value),
  input: (input) => controls.feed(input),
  caption: (text) => {
    ui.caption = text;
  },
  shot: (s) => stage.shot(s ? { ...s, toward: s.toward ? toyPoint(s.toward) : undefined } : null),
  value: (id) => controls.value(id),
  reset: () => {
    stage.shot(null);
    controls.reset();
    engine.reset();
    placeOwner();
    acc = 0;
  },
  step: (dt) => {
    const input = controls.drain();
    // A seek replays the tour's buttons only; the tour cursor is not a visitor's pointer.
    input.cursor = null;
    engine.update(input, dt);
  },
  render: () => {
    controls.sync();
    const r = engine.state();
    syncScene();
    stage.frame(0);
    controls.overlay(con);
    con.draw(r, ui, pageTime);
  },
};

const player = createPlayer({ cursor, console: con, host });
const live = createLive({ stage, console: con, controls, player, cursor });
exposeFilm(player);
// Scripted checks read the console's button rectangles and the world from here.
if (params.has('debug')) Object.assign(window, { __showcase: { stage, engine, con, controls, live, player } });

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
  while (acc >= STEP && n < MAX_STEPS) {
    const input = controls.drain();
    input.cursor = live.floor();
    engine.update(input, STEP);
    acc -= STEP;
    n++;
  }
  // Behind by more than the cap: drop the rest rather than catch up over later frames.
  if (n === MAX_STEPS) acc = 0;

  const r: WorldReadout = engine.state();
  syncScene();
  cursor.update(pageTime);
  stage.frame(dt);

  ui.fps = governor.fps;
  ui.tier = stage.tier.id;
  controls.overlay(con);
  con.frame(r, ui, pageTime, stage.tier.id);
  requestAnimationFrame(loop);
}

stage.resize();
syncScene();
// Every shader is compiled before the canvas fades in, so the first seconds do not stutter.
stage.warm(models).then(() => {
  canvas.style.opacity = '1';
  last = performance.now();
  player.start(pageTime);
  requestAnimationFrame(loop);
});
