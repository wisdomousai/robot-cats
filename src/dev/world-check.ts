// Development check for the world: the three cats and the props driven by CatWorld at a
// fixed 120 Hz step, with a button for every subsystem demo and every behaviour, and a
// readout of the selected cat. `?seed=N` picks the seed; `?paused` starts stopped, for
// scripted screenshots through window.__world.
import { Box3, Vector3 } from 'three';
import { SUBSYSTEMS } from '../cats/cliches';
import { createProps, syncProps } from '../cats/geo/props';
import { BREED_IDS, BREEDS } from '../cats/model/dims';
import type { BreedId, Input, SystemId } from '../cats/types';
import { CatWorld } from '../cats/world';
import { createStage, STUDIO } from '../showcase/stage';

const ACCENT = '#ff5a1f';
const STEP = 1 / 120;
/** At most this many steps per frame, so a slow frame does not snowball. */
const MAX_STEPS = 12;

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const stage = createStage(canvas, { accent: ACCENT });
const world = new CatWorld(Number(params.get('seed') ?? 1), { accent: ACCENT });
const props = createProps(world.toys, { accent: ACCENT, wallZ: STUDIO.wallZ });
stage.add(props.root);
for (const cat of world.cats) stage.addCat(cat.model);
// Framed on the floor the cats use, not the perch high on the wall.
stage.fit(new Box3(new Vector3(-1.5, 0, -1.1), new Vector3(1.5, 0.55, 1)), 0.95);
stage.setView('three-quarter', { snap: true });

// ---------- Input ----------

let pending: Input = {};
const feed = (input: Input) => {
  pending = { ...pending, ...input };
};
let subsystem: SystemId | null = null;
let paused = params.has('paused');

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  feed({ cursor: stage.screenToFloor(e.clientX - rect.left, e.clientY - rect.top) });
});
canvas.addEventListener('pointerleave', () => feed({ cursor: null }));

// ---------- Buttons ----------

const panel = document.getElementById('panel')!;
const buttons = new Map<string, HTMLButtonElement>();
function row(title: string, items: [id: string, text: string, act: () => void][]) {
  const div = document.createElement('div');
  div.className = 'row';
  const span = document.createElement('span');
  span.textContent = title;
  div.append(span);
  for (const [id, text, act] of items) {
    const b = document.createElement('button');
    b.textContent = text;
    b.onclick = act;
    buttons.set(id, b);
    div.append(b);
  }
  panel.append(div);
}

const select = (id: BreedId) => {
  feed({ select: id });
  stage.select(world.cat(id).model);
};
const demo = (id: SystemId | null) => {
  subsystem = subsystem === id ? null : id;
  feed({ subsystem });
};
const trigger = (name: string) => feed({ trigger: name });

row('cat', BREED_IDS.map((id) => [`cat:${id}`, BREEDS[id].name, () => select(id)]));
row('demo', SUBSYSTEMS.map((s) => [`sys:${s.id}`, `${s.id}: ${s.demo}`, () => demo(s.id)]));
row(
  'act',
  ['walk', 'trot', 'run', 'sit', 'loaf', 'stretch', 'groom', 'pounce', 'ball', 'sleep'].map((t) => [`act:${t}`, t, () => trigger(t)]),
);
row('game', ['chase', 'wrestle', 'tag', 'yarn', 'laser'].map((t) => [`act:${t}`, t, () => trigger(t)]));
row('world', [
  ['pause', 'pause', () => (paused = !paused)],
  ['belly', 'touch belly', () => feed({ bellyTouch: true })],
  ['reset', 'reset counters', () => feed({ resetCounters: true })],
]);
select('tabby');

// ---------- Readout ----------

const readout = document.getElementById('readout')!;
function draw() {
  const r = world.readout();
  const c = r.cats.find((x) => x.id === r.selected)!;
  const n = r.counters;
  readout.textContent = [
    `${c.name}  ${c.act} ${c.actT.toFixed(1)} s`,
    `mood ${c.mood}  ${c.posture}  ${c.gait} ${c.speed.toFixed(2)} m/s`,
    `tail ${c.tailState}  ${Math.round(c.tailCarriage)}°`,
    `game ${r.game ?? '-'}  clock ${r.clock}  t ${r.time.toFixed(1)}`,
    `cups ${n.cups} boxes ${n.boxes} keys ${n.keys} laps ${n.laps} grabs ${n.grabs}`,
    `biscuits ${n.biscuits} blinks ${n.blinks} birds ${n.birds} lives ${n.lives}`,
    `typed ${r.typed.slice(-24)}`,
  ].join('\n');
  for (const [id, b] of buttons) {
    let on = false;
    if (id.startsWith('cat:')) on = id === `cat:${r.selected}`;
    else if (id.startsWith('sys:')) on = id === `sys:${subsystem}`;
    else if (id.startsWith('act:')) on = r.game === id.slice(4) || c.act === id.slice(4);
    else if (id === 'pause') on = paused;
    b.classList.toggle('on', on);
  }
}

// ---------- Loop ----------

/** Steps the world `seconds` at the fixed step, applying the pending input first. */
function advance(seconds: number) {
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n; i++) {
    world.step(STEP, pending);
    pending = {};
  }
  syncProps(world.toys, props);
}

let last = 0;
let carry = 0;
const loop = (now: number) => {
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  if (!paused) {
    carry += dt;
    let steps = 0;
    while (carry >= STEP && steps < MAX_STEPS) {
      world.step(STEP, pending);
      pending = {};
      carry -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) carry = 0;
    syncProps(world.toys, props);
  }
  stage.frame(dt);
  draw();
  requestAnimationFrame(loop);
};

stage.resize();
window.addEventListener('resize', () => stage.resize());

// For scripted checks: step the world by hand and press the same buttons the page has.
const api = {
  world,
  stage,
  ready: false,
  get paused() {
    return paused;
  },
  pause(on = true) {
    paused = on;
  },
  advance(seconds: number) {
    advance(seconds);
    stage.frame(0);
    draw();
  },
  select,
  demo,
  trigger,
  feed,
};
(window as unknown as { __world: typeof api }).__world = api;

stage.warm(world.models).then(() => {
  canvas.style.opacity = '1';
  api.ready = true;
  requestAnimationFrame(loop);
});
