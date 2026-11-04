// Development check for the stage and the cat model: the three breeds built by buildCat,
// with buttons for views, isolate, x-ray, explode, coats, tiers and the tour cursor.
// main.ts replaces it.
import { Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';
import { SUBSYSTEMS } from '../cats/cliches';
import { Rng } from '../cats/math/rng';
import { buildCat, catStats, puppetOf } from '../cats/model/build';
import { BREED_IDS, BREEDS, dimsOf, POINTS_COAT, SOLID_COAT, TABBY_COAT } from '../cats/model/dims';
import { tailBoneNames } from '../cats/model/parts';
import { swish, trot } from '../cats/rig/moves';
import type { CoatSpec, V3 } from '../cats/types';
import { createCursor } from './cursor';
import { createGovernor, perfLog, startTier, TIERS, type TierId } from './quality';
import { createStage, VIEW_IDS, type ViewId } from './stage';

const ACCENT = '#ff5a1f';

// ---------- Page ----------

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const stage = createStage(canvas, { accent: ACCENT });
const params = new URLSearchParams(location.search);

const cats = BREED_IDS.map((id) => buildCat(BREEDS[id], { accent: ACCENT }));
const spots: [V3, number][] = [
  [[-0.7, 0, 0.05], 22],
  [[0, 0, -0.12], -8],
  [[0.7, 0, 0.08], -30],
];
cats.forEach((cat, i) => {
  cat.root.position.set(...spots[i][0]);
  cat.root.rotation.y = (spots[i][1] * Math.PI) / 180;
  stage.addCat(cat);
});
stage.fit(cats.map((c) => c.root));

let selected = 0;
stage.select(cats[selected]);

// A marker where the last click met the floor, to check screenToFloor.
const marker = new Mesh(new SphereGeometry(0.018, 16, 8), new MeshBasicMaterial({ color: ACCENT }));
marker.visible = false;
stage.add(marker);

// ---------- Overlay ----------

const overlay = document.getElementById('overlay')!;
const readout = document.getElementById('readout')!;
const label = document.getElementById('label')!;
const cursor = createCursor(overlay, { accent: ACCENT });

const governor = createGovernor(startTier());
// `?tier=N` pins the tier, so headless shots show the tier asked for.
let pinned: TierId | null = null;
function pinTier(t: TierId | null) {
  pinned = t;
  governor.pin(t);
}
if (params.has('tier')) pinTier(governor.tier);
stage.setTier(governor.tier);

const state = {
  isolate: null as string[] | null,
  xray: false,
  explode: false,
  walk: false,
};

function applyTeardown() {
  cats.forEach((cat, i) => {
    stage.isolate(cat, i === selected ? state.isolate : null);
    stage.xray(cat, i === selected && state.xray);
  });
}

const panel = document.getElementById('panel')!;
const buttons = new Map<string, HTMLButtonElement>();
function row(title: string, items: [id: string, text: string, act: () => void][]) {
  const div = document.createElement('div');
  div.className = 'row';
  const h = document.createElement('span');
  h.textContent = title;
  div.appendChild(h);
  for (const [id, text, act] of items) {
    const b = document.createElement('button');
    b.textContent = text;
    b.onclick = () => {
      act();
      refreshButtons();
    };
    buttons.set(id, b);
    div.appendChild(b);
  }
  panel.appendChild(div);
}

// One button per cliché row, isolating that row's parts (an empty list keeps the whole cat).
const isolates: [string, string[] | null][] = [['none', null], ...SUBSYSTEMS.map((s): [string, string[]] => [s.id, s.parts])];

// Any cat can wear any coat; the button rewrites the selected cat's colours in place.
const coats: [string, CoatSpec][] = [
  ['tabby', TABBY_COAT],
  ['points', POINTS_COAT],
  ['solid', SOLID_COAT],
];
const worn = cats.map((c) => coats.findIndex(([, coat]) => coat === c.breed.coat));
function wear(k: number) {
  worn[selected] = k;
  cats[selected].recoat(coats[k][1]);
}

row('View', VIEW_IDS.map((v) => [`view:${v}`, v, () => stage.setView(v as ViewId)]));
row('Cat', cats.map((c, i) => [`cat:${i}`, c.breed.id, () => select(i)]));
row('Isolate', isolates.map(([name, prefixes]) => [`iso:${name}`, name, () => {
  state.isolate = prefixes;
  applyTeardown();
}]));
row('Effects', [
  ['xray', 'x-ray', () => {
    state.xray = !state.xray;
    applyTeardown();
  }],
  ['explode', 'explode', () => {
    state.explode = !state.explode;
    stage.explode(cats[selected], state.explode ? 1 : 0, 0.8);
  }],
  ['walk', 'walk', () => {
    state.walk = !state.walk;
  }],
  ['orbit', 'reset orbit', () => stage.resetOrbit()],
  ['cursor', 'cursor demo', () => cursorDemo()],
]);
row('Coat', coats.map(([name], k) => [`coat:${k}`, name, () => wear(k)]));
row('Tier', [
  ['tier:auto', 'auto', () => pinTier(null)],
  ...TIERS.map((t): [string, string, () => void] => [`tier:${t.id}`, String(t.id), () => pinTier(t.id)]),
]);

function select(i: number) {
  if (state.explode) stage.explode(cats[selected], 0, 0.5);
  selected = i;
  stage.select(cats[i]);
  applyTeardown();
  if (state.explode) stage.explode(cats[i], 1, 0.8);
}

function refreshButtons() {
  for (const [id, b] of buttons) {
    const on =
      id === `view:${stage.view}` ||
      id === `cat:${selected}` ||
      id === `iso:${isolates.find(([, p]) => p === state.isolate)?.[0]}` ||
      (id === 'xray' && state.xray) ||
      (id === 'explode' && state.explode) ||
      (id === 'walk' && state.walk) ||
      id === `coat:${worn[selected]}` ||
      id === `tier:${pinned ?? 'auto'}`;
    b.classList.toggle('on', on);
  }
}

// ---------- Input ----------

let drag: { x: number; y: number; moved: boolean } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
  drag.x = e.clientX;
  drag.y = e.clientY;
  stage.orbit(-dx * 0.3, dy * 0.2);
});
canvas.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved) {
    const r = canvas.getBoundingClientRect();
    const hit = stage.screenToFloor(e.clientX - r.left, e.clientY - r.top);
    marker.visible = !!hit;
    if (hit) marker.position.set(hit[0], 0.018, hit[2]);
  }
  drag = null;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  stage.zoom(Math.exp(e.deltaY * 0.0012));
}, { passive: false });
window.addEventListener('resize', () => stage.resize());

// ---------- Cursor demo ----------

let pageTime = 0;
const cues: { at: number; run: () => void }[] = [];
function cursorDemo() {
  const head = cats[selected].bones.get('head')!.getWorldPosition(new Vector3());
  const [hx, hy] = stage.project([head.x, head.y, head.z]);
  const start = pageTime;
  cursor.place([canvas.clientWidth * 0.82, canvas.clientHeight * 0.78]);
  cursor.show(start);
  cursor.walkTo([hx, hy], 1.1, start);
  cues.push(
    { at: start + 1.15, run: () => cursor.press() },
    { at: start + 1.3, run: () => { state.isolate = isolates[1][1]; applyTeardown(); refreshButtons(); } },
    { at: start + 2.6, run: () => cursor.hide() },
  );
}

// ---------- Motion ----------

// Bones are turned through a puppet per cat, since their rest rotations are not the identity.
const puppets = cats.map(puppetOf);
const tails = cats.map((c) => tailBoneNames(dimsOf(c.breed)));
const rngs = cats.map((_, i) => new Rng(101 + i));
const swishes = cats.map(() => 0);
let gait = 0;
let walkAngle = 0;

function animate(t: number, dt: number) {
  cats.forEach((cat, i) => {
    const p = puppets[i];
    p.begin();
    p.add('head', 6 * Math.sin(t * 1.3 + i), 18 * Math.sin(t * 0.7 + i * 2), 0);
    const walking = state.walk && i === selected;
    if (walking) {
      gait += dt * 7;
      trot(p, gait, 1, 26, { shins: true });
      // A slow circle about the cat's starting spot.
      const [sx, , sz] = spots[i][0];
      walkAngle += dt * 0.6;
      cat.root.position.set(sx + 0.45 * Math.sin(walkAngle), 0, sz + 0.45 * Math.cos(walkAngle) - 0.45);
      cat.root.rotation.y = walkAngle + Math.PI / 2;
    }
    swishes[i] += dt * (walking ? 3.2 : 1.7);
    swish(p, tails[i], swishes[i], walking ? 9 : 14);
    p.update(dt);
    cat.face.look.x = 0.6 * Math.sin(t * 0.7 + i * 2);
    cat.face.update(t, rngs[i]);
  });
}

// ---------- Loop ----------

let last = performance.now();
let frames = 0;
let fpsShown = 0;
let fpsSpan = 0;
const dev = {
  stage,
  cats,
  ready: false,
  frames: 0,
  select,
  view: (v: ViewId, snap = true) => {
    stage.setView(v, { snap });
    refreshButtons();
  },
  isolate: (prefixes: string[] | null) => {
    state.isolate = prefixes;
    applyTeardown();
  },
  xray: (on: boolean) => {
    state.xray = on;
    applyTeardown();
  },
  explode: (amount: number, seconds = 0) => stage.explode(cats[selected], amount, seconds),
  tier: (t: TierId | null) => pinTier(t),
  cursorDemo,
  cursor,
  coat: (k: number) => {
    wear(k);
    refreshButtons();
  },
  stats: () => cats.map((c) => ({ id: c.breed.id, ...catStats(c) })),
};
(window as unknown as { __dev: typeof dev }).__dev = dev;

function loop(now: number) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  pageTime += dt;
  animate(pageTime, dt);

  const tier = governor.sample(dt);
  if (tier !== stage.tier.id) stage.setTier(tier);
  perfLog.frame(dt, stage.tier.id);

  while (cues.length && cues[0].at <= pageTime) cues.shift()!.run();
  cursor.update(pageTime);

  stage.frame(dt);
  dev.frames++;

  // A label pinned to the selected cat's head, to check project().
  const head = cats[selected].bones.get('head')!;
  const p = head.getWorldPosition(new Vector3());
  const [lx, ly] = stage.project([p.x, p.y + 0.16, p.z]);
  label.style.transform = `translate(${lx.toFixed(0)}px, ${ly.toFixed(0)}px)`;

  frames++;
  fpsSpan += dt;
  if (fpsSpan >= 0.5) {
    fpsShown = frames / fpsSpan;
    frames = 0;
    fpsSpan = 0;
    readout.textContent = `${fpsShown.toFixed(0)} fps · tier ${stage.tier.id}${pinned !== null ? ' (pinned)' : ''} · ${stage.gpu}`;
  }
  requestAnimationFrame(loop);
}

refreshButtons();
stage.resize();
stage.warm(cats).then(() => {
  canvas.style.opacity = '1';
  dev.ready = true;
  last = performance.now();
  requestAnimationFrame(loop);
});
