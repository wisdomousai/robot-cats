/**
 * The showcase console: one 1600 x 900 canvas laid over the stage and scaled to fit the
 * window. Every live panel draws from the WorldReadout the world publishes each step and
 * from the SUBSYSTEMS table; button states come from the page's ConsoleUi. The console
 * keeps a few seconds of history for its charts and nothing else, so a frame depends only
 * on the readouts it has been shown.
 *
 * Coordinates: "console px" are the fixed 1600 x 900 layout; "client px" are the window's
 * CSS pixels, which the fake cursor and pointer events use. `toClient` and `toConsole`
 * convert between them.
 */
import {
  LEGS,
  SUBSYSTEMS,
  TAIL_SEMAPHORE,
  type BreedId,
  type CatReadout,
  type Counters,
  type LegName,
  type SpecRow,
  type Subsystem,
  type SystemId,
  type WorldReadout,
} from '../cats/index';
import { tierOf } from './quality';
import { VIEW_IDS, type ViewId } from './stage';

// ---------- Constants ----------

export const CONSOLE_WIDTH = 1600;
export const CONSOLE_HEIGHT = 900;

/** The creatures playground's tokens (--paper, --card, --ink…), day only. */
export const PALETTE = {
  background: '#f4f4f1',
  panel: '#ffffff',
  card: '#ffffff',
  ink: '#111111',
  muted: '#55554f',
  faint: '#8f8f88',
  rule: '#e0e0db',
  border: '#d6d6d1',
  button: '#ffffff',
  hover: '#e9e9e5',
  shade: 'rgba(0, 0, 0, 0.1)',
  accent: '#111111',
  accentSoft: 'rgba(17, 17, 17, 0.06)',
} as const;

const SANS = '"Schibsted Grotesk", system-ui, sans-serif';
const SERIF = '"Newsreader", Georgia, serif';

export const BREED_IDS: readonly BreedId[] = ['tabby', 'siamese', 'black'];

/** Body colour of each breed's dot on the floor map and its card swatch. */
const BREED_INK: Record<BreedId, { fill: string; stroke: string }> = {
  tabby: { fill: '#e9a15c', stroke: '#b9763a' },
  siamese: { fill: '#efe4d0', stroke: '#8f7f68' },
  black: { fill: '#2e2e33', stroke: '#18181b' },
};

/** The behaviour buttons, in their row order. Each one sends its name as the trigger. */
export const BEHAVIOURS = [
  'walk',
  'trot',
  'run',
  'sit',
  'loaf',
  'stretch',
  'groom',
  'pounce',
  'ball',
  'laser',
  'sleep',
  'chase',
  'wrestle',
  'tag',
  'yarn',
] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];

/** Behaviours that are group games (the world reports them in `game`). */
export const GAMES: readonly Behaviour[] = ['laser', 'chase', 'wrestle', 'tag', 'yarn'];

export const VIEW_LABELS: Record<ViewId, string> = {
  'three-quarter': '3/4',
  front: 'front',
  side: 'side',
  top: 'top',
  head: 'head',
  follow: 'follow',
};

const LOAD_GROUPS = ['head', 'body', 'ears', 'FL', 'FR', 'BL', 'BR', 'tail'] as const;

const COUNTER_LABELS: [keyof Counters, string][] = [
  ['biscuits', 'Biscuits'],
  ['cups', 'Cups'],
  ['lives', 'Lives'],
  ['birds', 'Birds'],
  ['boxes', 'Boxes'],
  ['grabs', 'Grabs'],
  ['laps', 'Laps'],
  ['keys', 'Keys'],
  ['blinks', 'Blinks'],
];

/** The play area, metres: x in ±1.5, z in ±1. */
const FLOOR = { x: 1.5, z: 1 };

// ---------- Buttons and actions ----------

/**
 * Button ids: `sys:<SystemId>`, `act:<behaviour>`, `cat:<BreedId>`, `coat:<BreedId>`,
 * `view:<ViewId>`, `xray`, `explode` (the slider) and `tour`.
 */
export type Action =
  | { kind: 'subsystem'; id: SystemId }
  | { kind: 'behaviour'; name: Behaviour }
  | { kind: 'cat'; breed: BreedId }
  | { kind: 'coat'; breed: BreedId }
  | { kind: 'view'; view: ViewId }
  | { kind: 'xray' }
  | { kind: 'explode' }
  | { kind: 'tour' };

export type ButtonKind = Action['kind'];

/** Parses a button id; null for an id no button has. */
export function actionOf(id: string): Action | null {
  const [head, rest] = id.split(':') as [string, string | undefined];
  switch (head) {
    case 'sys':
      return SUBSYSTEMS.some((s) => s.id === rest) ? { kind: 'subsystem', id: rest as SystemId } : null;
    case 'act':
      return (BEHAVIOURS as readonly string[]).includes(rest ?? '') ? { kind: 'behaviour', name: rest as Behaviour } : null;
    case 'cat':
      return BREED_IDS.includes(rest as BreedId) ? { kind: 'cat', breed: rest as BreedId } : null;
    case 'coat':
      return BREED_IDS.includes(rest as BreedId) ? { kind: 'coat', breed: rest as BreedId } : null;
    case 'view':
      return VIEW_IDS.includes(rest as ViewId) ? { kind: 'view', view: rest as ViewId } : null;
    case 'xray':
    case 'explode':
    case 'tour':
      return rest === undefined ? { kind: head } : null;
    default:
      return null;
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ConsoleButton extends Rect {
  id: string;
  kind: ButtonKind;
  label: string;
  /** Keyboard key shown on the button, if any. */
  key?: string;
}

/** What a pointer is over: a button id, and for the explode slider the value under it. */
export interface ConsoleHit {
  id: string;
  value?: number;
}

// ---------- Page state the console shows ----------

/**
 * The page's side of the console: which view, effects and coats are on, the tour, the
 * caption, and where the callout and name tags point. The world knows none of this.
 */
export interface ConsoleUi {
  /** Page time in seconds, for flashes. */
  time: number;
  view: ViewId;
  xray: boolean;
  explode: number;
  /** The coat each cat wears, by the breed the coat comes from. */
  coats: Record<BreedId, BreedId>;
  tour: { running: boolean; time: number; duration: number; resumeIn: number | null };
  caption: string | null;
  /** Button under the visitor's pointer. */
  hover: string | null;
  /** Last pressed button, for a short flash. */
  flash: { id: string; at: number } | null;
  fps: number;
  tier: number;
  /** The isolated parts of the selected cat on screen, console px, or null. */
  anchor: [number, number] | null;
  /** Each cat's name tag position on screen, console px. */
  tags: { id: BreedId; at: [number, number] }[];
}

export function createUi(): ConsoleUi {
  return {
    time: 0,
    view: 'three-quarter',
    xray: false,
    explode: 0,
    coats: { tabby: 'tabby', siamese: 'siamese', black: 'black' },
    tour: { running: false, time: 0, duration: 0, resumeIn: null },
    caption: null,
    hover: null,
    flash: null,
    fps: 0,
    tier: 0,
    anchor: null,
    tags: [],
  };
}

// ---------- Layout ----------

const LEFT = 12;
const RIGHT = CONSOLE_WIDTH - 12 - 288;
const COL = 288;
const EDGE = CONSOLE_WIDTH - 12;

const L = {
  top: { y: 10, h: 24 },
  cards: { y: 44, h: 66, gap: 6 },
  coat: { y: 262, h: 22 },
  gait: { y: 292, h: 148 },
  load: { y: 448, h: 146 },
  tail: { y: 602, h: 128 },
  floor: { y: 44, h: 226 },
  attention: { y: 278, h: 118 },
  callout: { y: 404, h: 326 },
  caption: { y: 702, h: 24 },
  behaviour: { y: 742, h: 22 },
  subsystem: { y: 770, h: 22 },
  counters: { y: 800, h: 46 },
  status: { y: 854, h: 22 },
} as const;

/** The middle of the console, where the stage shows through. */
const STAGE_AREA: Rect = { x: LEFT + COL + 8, y: 40, w: RIGHT - LEFT - COL - 16, h: L.behaviour.y - 48 };

interface Slider {
  track: [number, number];
  y: number;
  label: number;
  value: number;
}

function layout(measure: (text: string, size: number) => number): { buttons: ConsoleButton[]; slider: Slider; viewLabel: number } {
  const buttons: ConsoleButton[] = [];
  const add = (b: ConsoleButton) => buttons.push(b);

  // Top bar, right to left: tour, explode slider, x-ray, views.
  let x = EDGE;
  const fromRight = (id: string, kind: ButtonKind, label: string, w: number, key?: string) => {
    x -= w;
    add({ id, kind, label, key, x, y: L.top.y, w, h: L.top.h });
    x -= 4;
  };
  fromRight('tour', 'tour', 'Tour', 74);
  x -= 14;
  const valueX = x;
  x -= 50;
  const t1 = x;
  x -= 112;
  const t0 = x;
  add({ id: 'explode', kind: 'explode', label: 'Explode', x: t0 - 8, y: L.top.y, w: t1 - t0 + 16, h: L.top.h });
  x -= 12;
  const sliderLabel = x;
  x -= measure('Explode', 11) + 18;
  fromRight('xray', 'xray', 'X-ray', 64);
  x -= 14;
  for (let i = VIEW_IDS.length - 1; i >= 0; i--) {
    const v = VIEW_IDS[i];
    const label = VIEW_LABELS[v];
    fromRight(`view:${v}`, 'view', label, Math.round(measure(`${i + 1} ${label}`, 11) + 18), String(i + 1));
  }
  const viewLabel = x - 6;

  // Cat cards double as the cat select buttons.
  BREED_IDS.forEach((b, i) =>
    add({ id: `cat:${b}`, kind: 'cat', label: b, x: LEFT, y: L.cards.y + i * (L.cards.h + L.cards.gap), w: COL, h: L.cards.h }),
  );
  // Coat row under the cards.
  {
    const x0 = LEFT + 46;
    const w = (COL - 46 - 8) / 3;
    BREED_IDS.forEach((b, i) =>
      add({ id: `coat:${b}`, kind: 'coat', label: b, x: x0 + i * (w + 4), y: L.coat.y, w, h: L.coat.h }),
    );
  }

  // Behaviour and subsystem rows share one grid so their columns line up.
  const rowX = LEFT + 86;
  const n = Math.max(BEHAVIOURS.length, SUBSYSTEMS.length);
  const w = (EDGE - rowX - (n - 1) * 4) / n;
  BEHAVIOURS.forEach((name, i) =>
    add({ id: `act:${name}`, kind: 'behaviour', label: name, x: rowX + i * (w + 4), y: L.behaviour.y, w, h: L.behaviour.h }),
  );
  SUBSYSTEMS.forEach((s, i) =>
    add({ id: `sys:${s.id}`, kind: 'subsystem', label: s.id, x: rowX + i * (w + 4), y: L.subsystem.y, w, h: L.subsystem.h }),
  );

  return { buttons, slider: { track: [t0, t1], y: L.top.y + L.top.h / 2, label: sliderLabel, value: valueX }, viewLabel };
}

// ---------- History ----------

/** Seconds of history per chart, and the sample rate. */
const RATE = 30;
const TAIL_SECONDS = 10;
const GAIT_SECONDS = 3;
const TRAIL_SECONDS = 4;
const TRAIL_RATE = 5;

class Ring {
  readonly data: Float32Array;
  private head = 0;
  size = 0;
  constructor(readonly length: number) {
    this.data = new Float32Array(length);
  }
  push(v: number) {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.length;
    this.size = Math.min(this.length, this.size + 1);
  }
  /** i = 0 is the oldest sample kept. */
  at(i: number): number {
    return this.data[(this.head - this.size + i + this.length * 2) % this.length];
  }
  clear() {
    this.head = 0;
    this.size = 0;
  }
}

interface CatHistory {
  carriage: Ring;
  energy: Ring;
  paws: Record<LegName, Ring>;
  trailX: Ring;
  trailZ: Ring;
}

const newHistory = (): CatHistory => ({
  carriage: new Ring(TAIL_SECONDS * RATE),
  energy: new Ring(TAIL_SECONDS * RATE),
  paws: { FL: new Ring(GAIT_SECONDS * RATE), FR: new Ring(GAIT_SECONDS * RATE), BL: new Ring(GAIT_SECONDS * RATE), BR: new Ring(GAIT_SECONDS * RATE) },
  trailX: new Ring(TRAIL_SECONDS * TRAIL_RATE),
  trailZ: new Ring(TRAIL_SECONDS * TRAIL_RATE),
});

// ---------- Formatting ----------

const pct = (v: number) => `${Math.round(v * 100)} %`;
const mmss = (s: number) => {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const r = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};
const formatAny = (v: unknown): string => {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.map(formatAny).join(' / ');
  return String(v);
};

/** The value a spec row shows for a cat: its static value, or the live key formatted. */
export function specValue(row: SpecRow, cat: CatReadout | undefined, counters: Counters): string {
  if (row.live === undefined) return row.value ?? '';
  const key = row.live as string;
  let v: unknown;
  if (cat && Object.prototype.hasOwnProperty.call(cat, key)) v = (cat as unknown as Record<string, unknown>)[key];
  else if (Object.prototype.hasOwnProperty.call(counters, key)) v = (counters as unknown as Record<string, unknown>)[key];
  else return row.value ?? '–';
  const s = row.format ? row.format(v) : formatAny(v);
  return row.unit ? `${s} ${row.unit}` : s;
}

const wrapAngle = (r: number) => ((r % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

// ---------- Console ----------

export interface Console {
  readonly canvas: HTMLCanvasElement;
  readonly buttons: readonly ConsoleButton[];
  /** Client px per console px. */
  readonly scale: number;
  /** Refit to the window; the console also does this on its own on resize. */
  resize(): void;
  toConsole(clientX: number, clientY: number): [number, number];
  toClient(x: number, y: number): [number, number];
  /** The button under a client point, or null. */
  hit(clientX: number, clientY: number): ConsoleHit | null;
  /** A button's rectangle in client px. */
  rect(id: string): Rect | null;
  /** Where to point at a button, client px: its centre, or for the slider the knob at `value`. */
  point(id: string, value?: number): [number, number] | null;
  /** The explode value under a client x. */
  sliderValue(clientX: number): number;
  /** Feeds the charts and redraws when the tier's redraw rate says so; true if it drew. */
  frame(world: WorldReadout, ui: ConsoleUi, t: number, tier?: number): boolean;
  /** Feeds the charts and redraws now. */
  draw(world: WorldReadout, ui: ConsoleUi, t: number): void;
  /** Forget chart history (after a seek or a reset). */
  clearHistory(): void;
  dispose(): void;
}

export interface ConsoleOptions {
  /** Shown at the top left. */
  title?: string;
}

export function createConsole(parent: HTMLElement, opts: ConsoleOptions = {}): Console {
  const title = opts.title ?? 'Robot cats';
  const canvas = document.createElement('canvas');
  canvas.className = 'console';
  canvas.setAttribute('aria-label', 'Showcase console');
  Object.assign(canvas.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    pointerEvents: 'none',
    zIndex: '10',
  } satisfies Partial<CSSStyleDeclaration>);
  parent.appendChild(canvas);
  const g = canvas.getContext('2d')!;

  const measure = (text: string, size: number, weight = 400, face = SANS) => {
    g.font = `${weight} ${size}px ${face}`;
    return g.measureText(text).width;
  };
  const { buttons, slider, viewLabel } = layout((t, s) => measure(t, s));
  const byId = new Map(buttons.map((b) => [b.id, b]));

  // ----- Fit -----

  let scale = 1;
  let offX = 0;
  let offY = 0;
  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    scale = Math.min(w / CONSOLE_WIDTH, h / CONSOLE_HEIGHT);
    offX = (w - CONSOLE_WIDTH * scale) / 2;
    offY = (h - CONSOLE_HEIGHT * scale) / 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(CONSOLE_WIDTH * scale * dpr);
    canvas.height = Math.round(CONSOLE_HEIGHT * scale * dpr);
    canvas.style.width = `${CONSOLE_WIDTH * scale}px`;
    canvas.style.height = `${CONSOLE_HEIGHT * scale}px`;
    canvas.style.transform = `translate(${offX}px, ${offY}px)`;
    dirty = true;
  };
  let dirty = true;
  resize();
  window.addEventListener('resize', resize);

  const toConsole = (cx: number, cy: number): [number, number] => [(cx - offX) / scale, (cy - offY) / scale];
  const toClient = (x: number, y: number): [number, number] => [offX + x * scale, offY + y * scale];
  const sliderValueAt = (x: number) => Math.min(1, Math.max(0, (x - slider.track[0]) / (slider.track[1] - slider.track[0])));

  // ----- History -----

  const history: Record<string, CatHistory> = {};
  let sampledTo = -Infinity;
  let trailTo = -Infinity;
  const clearHistory = () => {
    for (const h of Object.values(history)) {
      h.carriage.clear();
      h.energy.clear();
      for (const leg of LEGS) h.paws[leg].clear();
      h.trailX.clear();
      h.trailZ.clear();
    }
    sampledTo = -Infinity;
    trailTo = -Infinity;
  };
  const sample = (world: WorldReadout) => {
    // A world that went back in time was reset or seeked: its past is not this past.
    if (world.time < sampledTo - 1e-6) clearHistory();
    const step = 1 / RATE;
    if (!Number.isFinite(sampledTo)) sampledTo = world.time - step;
    let n = 0;
    while (sampledTo + step <= world.time + 1e-9 && n < RATE * TAIL_SECONDS) {
      sampledTo += step;
      n++;
      for (const c of world.cats) {
        const h = (history[c.id] ??= newHistory());
        h.carriage.push(c.tailCarriage);
        h.energy.push(c.tailEnergy);
        for (const leg of LEGS) h.paws[leg].push(c.paws[leg] ? 1 : 0);
      }
    }
    if (n >= RATE * TAIL_SECONDS) sampledTo = world.time;
    const tstep = 1 / TRAIL_RATE;
    if (!Number.isFinite(trailTo)) trailTo = world.time - tstep;
    while (trailTo + tstep <= world.time + 1e-9) {
      trailTo += tstep;
      for (const c of world.cats) {
        const h = (history[c.id] ??= newHistory());
        h.trailX.push(c.position[0]);
        h.trailZ.push(c.position[2]);
      }
    }
  };

  // Values that change flash in the accent for a moment, so a ticking counter shows.
  const changed = new Map<string, { value: string; at: number }>();
  const changeAge = (key: string, value: string, t: number): number => {
    const last = changed.get(key);
    if (!last) {
      changed.set(key, { value, at: -Infinity });
      return Infinity;
    }
    if (last.value !== value) {
      last.value = value;
      last.at = t;
    }
    return t - last.at;
  };

  // ----- Drawing helpers -----

  const font = (size: number, weight = 400, face = SANS) => {
    g.font = `${weight} ${size}px ${face}`;
  };
  const text = (s: string, x: number, y: number, size = 11, color: string = PALETTE.ink, weight = 400, align: CanvasTextAlign = 'left') => {
    font(size, weight);
    g.fillStyle = color;
    g.textAlign = align;
    g.fillText(s, x, y);
  };
  /** Names and headings are in the serif, as on the creatures' cards. */
  const heading = (s: string, x: number, y: number, size = 14, color: string = PALETTE.ink, align: CanvasTextAlign = 'left') => {
    font(size, 600, SERIF);
    g.fillStyle = color;
    g.textAlign = align;
    g.fillText(s, x, y);
  };
  const clip = (s: string, w: number, size = 11, weight = 400) => {
    font(size, weight);
    if (g.measureText(s).width <= w) return s;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (g.measureText(s.slice(0, mid) + '…').width <= w) lo = mid;
      else hi = mid - 1;
    }
    return s.slice(0, lo) + '…';
  };
  const wrap = (s: string, w: number, size = 11): string[] => {
    font(size);
    const lines: string[] = [];
    let line = '';
    for (const word of s.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (g.measureText(next).width > w && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  };
  const box = (x: number, y: number, w: number, h: number, fill: string = PALETTE.panel, stroke: string = PALETTE.border, r = 4, lw = 1) => {
    g.beginPath();
    g.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r);
    if (fill) {
      g.fillStyle = fill;
      g.fill();
    }
    if (stroke) {
      g.lineWidth = lw;
      g.strokeStyle = stroke;
      g.stroke();
    }
  };
  /** A sheet on the wall: white, hairline edge, a small shadow under it. */
  const sheet = (x: number, y: number, w: number, h: number, stroke: string = PALETTE.border, lw = 1) => {
    g.save();
    g.shadowColor = PALETTE.shade;
    g.shadowBlur = 6;
    g.shadowOffsetY = 2;
    box(x, y, w, h, PALETTE.panel, '', 4);
    g.restore();
    box(x, y, w, h, '', stroke, 4, lw);
  };
  const panel = (x: number, y: number, w: number, h: number, title: string, right?: string) => {
    sheet(x, y, w, h);
    heading(title, x + 10, y + 18, 14);
    if (right) text(clip(right, w - 30 - measure(title, 14, 600, SERIF), 10), x + w - 10, y + 17, 10, PALETTE.muted, 400, 'right');
  };
  const rule = (x0: number, x1: number, y: number, color: string = PALETTE.rule) => {
    g.beginPath();
    g.moveTo(x0, y + 0.5);
    g.lineTo(x1, y + 0.5);
    g.lineWidth = 1;
    g.strokeStyle = color;
    g.stroke();
  };
  const lamp = (x: number, y: number, r: number, on: boolean) => {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    if (on) {
      g.fillStyle = PALETTE.accent;
      g.fill();
    } else {
      g.fillStyle = PALETTE.button;
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = PALETTE.faint;
      g.stroke();
    }
  };
  /** The round pin a card hangs from, ink with a glint. */
  const pin = (x: number, y: number) => {
    g.save();
    g.shadowColor = PALETTE.shade;
    g.shadowBlur = 2;
    g.shadowOffsetY = 2;
    const grad = g.createRadialGradient(x - 2, y - 2, 0, x, y, 6);
    grad.addColorStop(0, '#6e6e68');
    grad.addColorStop(0.6, PALETTE.ink);
    g.beginPath();
    g.arc(x, y, 5.5, 0, Math.PI * 2);
    g.fillStyle = grad;
    g.fill();
    g.restore();
  };
  const bar = (x: number, y: number, w: number, h: number, v: number, color: string = PALETTE.ink) => {
    g.fillStyle = PALETTE.rule;
    g.fillRect(x, y, w, h);
    g.fillStyle = color;
    g.fillRect(x, y, Math.max(0, Math.min(1, v)) * w, h);
  };

  const flashOf = (ui: ConsoleUi, id: string) => (ui.flash && ui.flash.id === id ? Math.max(0, 1 - (ui.time - ui.flash.at) / 0.45) : 0);

  // Keys are pills; a pressed one is filled with ink, as the playground's choice keys are.
  const button = (b: ConsoleButton, ui: ConsoleUi, on: boolean, label = b.label) => {
    const hover = ui.hover === b.id;
    const r = b.h / 2;
    box(b.x, b.y, b.w, b.h, on ? PALETTE.ink : hover ? PALETTE.hover : PALETTE.button, on ? PALETTE.ink : hover ? PALETTE.ink : PALETTE.border, r);
    const f = flashOf(ui, b.id);
    if (f > 0) {
      g.globalAlpha = 0.25 * f;
      box(b.x, b.y, b.w, b.h, PALETTE.ink, '', r);
      g.globalAlpha = 1;
    }
    const color = on ? PALETTE.card : PALETTE.ink;
    if (b.key) {
      const keyW = measure(b.key, 10);
      const full = keyW + 5 + measure(label, 12);
      const x0 = b.x + (b.w - full) / 2;
      text(b.key, x0, b.y + b.h / 2 + 4, 10, PALETTE.faint);
      text(label, x0 + keyW + 5, b.y + b.h / 2 + 4, 12, color);
    } else text(clip(label, b.w - 8, 12), b.x + b.w / 2, b.y + b.h / 2 + 4, 12, color, 400, 'center');
  };

  // ----- Panels -----

  const drawTop = (world: WorldReadout, ui: ConsoleUi) => {
    heading(title, LEFT, L.top.y + 18, 20);
    const sel = world.cats.find((c) => c.id === world.selected);
    const titleW = measure(title, 20, 600, SERIF);
    if (sel) text(`selected ${sel.name}`, LEFT + titleW + 16, L.top.y + 16, 11, PALETTE.muted);
    text('View', viewLabel, L.top.y + 16, 11, PALETTE.muted, 400, 'right');
    for (const b of buttons) {
      if (b.kind === 'view') button(b, ui, ui.view === b.id.slice(5));
      else if (b.kind === 'xray') button(b, ui, ui.xray);
      else if (b.kind === 'tour') {
        button(b, ui, ui.tour.running, ui.tour.running ? 'Tour on' : 'Tour off');
      }
    }
    // Explode slider.
    const [t0, t1] = slider.track;
    const y = slider.y;
    text('Explode', slider.label, y + 4, 11, PALETTE.muted, 400, 'right');
    g.fillStyle = PALETTE.border;
    g.fillRect(t0, y - 1.5, t1 - t0, 3);
    const kx = t0 + ui.explode * (t1 - t0);
    g.fillStyle = ui.explode > 0.001 ? PALETTE.accent : PALETTE.muted;
    g.fillRect(t0, y - 1.5, kx - t0, 3);
    const hover = ui.hover === 'explode';
    g.beginPath();
    g.arc(kx, y, hover ? 7 : 6, 0, Math.PI * 2);
    g.fillStyle = PALETTE.button;
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = ui.explode > 0.001 ? PALETTE.accent : PALETTE.muted;
    g.stroke();
    text(pct(ui.explode), slider.value, y + 4, 11, PALETTE.ink, 400, 'right');
  };

  const drawCards = (world: WorldReadout, ui: ConsoleUi) => {
    for (const b of buttons) {
      if (b.kind !== 'cat') continue;
      const id = b.label as BreedId;
      const c = world.cats.find((k) => k.id === id);
      const on = world.selected === id;
      const hover = ui.hover === b.id;
      sheet(b.x, b.y, b.w, b.h, on ? PALETTE.ink : PALETTE.border, on ? 1.5 : 1);
      if (hover) box(b.x, b.y, b.w, b.h, PALETTE.accentSoft, '', 4);
      const f = flashOf(ui, b.id);
      if (f > 0) {
        g.globalAlpha = 0.15 * f;
        box(b.x, b.y, b.w, b.h, PALETTE.ink, '', 4);
        g.globalAlpha = 1;
      }
      if (!c) {
        text(id, b.x + 10, b.y + 18, 11, PALETTE.muted);
        continue;
      }
      const ink = BREED_INK[ui.coats[id] ?? id];
      g.beginPath();
      g.arc(b.x + 16, b.y + 14, 5.5, 0, Math.PI * 2);
      g.fillStyle = ink.fill;
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = ink.stroke;
      g.stroke();
      heading(c.name, b.x + 28, b.y + 19, 15);
      text(c.id, b.x + 30 + measure(c.name, 15, 600, SERIF) + 6, b.y + 18, 10, PALETTE.muted);
      text(c.mood, b.x + b.w - 10, b.y + 18, 11, PALETTE.ink, 400, 'right');
      text(clip(c.act, 150), b.x + 10, b.y + 36, 11, PALETTE.ink);
      text(`${c.actT.toFixed(1)} s`, b.x + 170, b.y + 36, 10, PALETTE.muted, 400, 'right');
      text(c.posture, b.x + b.w - 10, b.y + 36, 11, PALETTE.muted, 400, 'right');
      text(`${c.gait}  ${c.speed.toFixed(2)} m/s`, b.x + 10, b.y + 54, 11, PALETTE.ink);
      // Paw lamps, as seen from above with the head up.
      const px = b.x + b.w - 52;
      LEGS.forEach((leg, i) => lamp(px + (i % 2) * 10 + Math.floor(i / 2) * 22, b.y + 50, 3.5, c.paws[leg]));
      text('paws', px - 8, b.y + 54, 10, PALETTE.faint, 400, 'right');
    }
    text('Coat', LEFT, L.coat.y + 15, 11, PALETTE.muted);
    const sel = world.selected;
    for (const b of buttons) if (b.kind === 'coat') button(b, ui, ui.coats[sel] === b.label);
  };

  const drawGait = (cat: CatReadout | undefined) => {
    const x = LEFT;
    const y = L.gait.y;
    panel(x, y, COL, L.gait.h, 'Gait', cat?.name);
    if (!cat) return;
    // Dial: the phase of the stride cycle, clockwise from the top.
    const cx = x + 52;
    const cy = y + 66;
    const r = 34;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.lineWidth = 1;
    g.strokeStyle = PALETTE.border;
    g.stroke();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r0 = i % 3 === 0 ? r - 7 : r - 4;
      g.beginPath();
      g.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0);
      g.lineTo(cx + Math.sin(a) * r, cy - Math.cos(a) * r);
      g.strokeStyle = i % 3 === 0 ? PALETTE.muted : PALETTE.faint;
      g.stroke();
    }
    const phase = wrapAngle(cat.gaitPhase);
    const moving = cat.gait !== 'still';
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.sin(phase) * (r - 3), cy - Math.cos(phase) * (r - 3));
    g.lineWidth = 2;
    g.strokeStyle = moving ? PALETTE.accent : PALETTE.muted;
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, 3, 0, Math.PI * 2);
    g.fillStyle = PALETTE.ink;
    g.fill();
    text(`${Math.round((phase * 180) / Math.PI)}°`, cx, cy + 18, 9, PALETTE.muted, 400, 'center');

    // Paw lamps, seen from above with the head up: the cat's left is on the left.
    const lx = x + 118;
    const ly = y + 40;
    g.beginPath();
    g.roundRect(lx + 11, ly + 2, 20, 50, 8);
    g.fillStyle = PALETTE.rule;
    g.fill();
    const spots: Record<LegName, [number, number]> = { FL: [lx, ly + 6], FR: [lx + 42, ly + 6], BL: [lx, ly + 48], BR: [lx + 42, ly + 48] };
    for (const leg of LEGS) {
      const [px, py] = spots[leg];
      lamp(px, py, 7, cat.paws[leg]);
      text(leg, px + (leg.endsWith('L') ? -11 : 11), py + 4, 9, PALETTE.muted, 400, leg.endsWith('L') ? 'right' : 'left');
    }
    const down = LEGS.filter((l) => cat.paws[l]).length;
    const tx = x + 196;
    text(cat.gait, tx, y + 44, 12, PALETTE.ink, 700);
    text(`${cat.speed.toFixed(2)} m/s`, tx, y + 62, 11);
    text(`${down} of 4 down`, tx, y + 80, 11, PALETTE.muted);
    text(cat.posture, tx, y + 98, 11, PALETTE.muted);

    // Footfall chart: the last few seconds of contact, newest on the right.
    const h = history[cat.id];
    const fx0 = x + 30;
    const fx1 = x + COL - 10;
    const fy = y + 112;
    LEGS.forEach((leg, row) => {
      const yy = fy + row * 8;
      text(leg, x + 10, yy + 6, 8, PALETTE.muted);
      g.fillStyle = PALETTE.rule;
      g.fillRect(fx0, yy, fx1 - fx0, 6);
      if (!h) return;
      const ring = h.paws[leg];
      const n = ring.length;
      const w = (fx1 - fx0) / n;
      g.fillStyle = PALETTE.ink;
      const start = n - ring.size;
      for (let i = 0; i < ring.size; i++) if (ring.at(i) > 0.5) g.fillRect(fx0 + (start + i) * w, yy, w + 0.3, 6);
    });
  };

  const drawLoad = (cat: CatReadout | undefined) => {
    const x = LEFT;
    const y = L.load.y;
    panel(x, y, COL, L.load.h, 'Servo load', cat?.name);
    if (!cat) return;
    LOAD_GROUPS.forEach((k, i) => {
      const yy = y + 32 + i * 14;
      const v = cat.load[k];
      text(k, x + 10, yy + 7, 10, PALETTE.muted);
      bar(x + 52, yy, 176, 7, v, v > 0.8 ? PALETTE.accent : PALETTE.ink);
      text(pct(v), x + COL - 10, yy + 7, 10, PALETTE.ink, 400, 'right');
    });
  };

  const drawTail = (cat: CatReadout | undefined) => {
    const x = LEFT;
    const y = L.tail.y;
    panel(x, y, COL, L.tail.h, 'Tail', cat ? cat.tailState : undefined);
    if (!cat) return;
    // Sparkline of the carriage over the last seconds, with the spring energy under it.
    const sx0 = x + 34;
    const sx1 = x + 186;
    const sy0 = y + 30;
    const sy1 = y + 104;
    const lo = -45;
    const hi = 95;
    const yOf = (deg: number) => sy1 - ((Math.max(lo, Math.min(hi, deg)) - lo) / (hi - lo)) * (sy1 - sy0);
    for (const d of [90, 0, -30]) {
      rule(sx0, sx1, Math.round(yOf(d)), d === 0 ? PALETTE.border : PALETTE.rule);
      text(`${d}°`, sx0 - 4, yOf(d) + 3, 9, PALETTE.faint, 400, 'right');
    }
    const h = history[cat.id];
    if (h && h.carriage.size > 1) {
      const n = h.carriage.length;
      const w = (sx1 - sx0) / (n - 1);
      const start = n - h.carriage.size;
      // Energy as a filled band along the floor of the chart.
      g.beginPath();
      g.moveTo(sx0 + start * w, sy1);
      for (let i = 0; i < h.energy.size; i++) g.lineTo(sx0 + (start + i) * w, sy1 - Math.min(1, h.energy.at(i)) * 18);
      g.lineTo(sx0 + (start + h.energy.size - 1) * w, sy1);
      g.closePath();
      g.fillStyle = 'rgba(138, 132, 119, 0.22)';
      g.fill();
      g.beginPath();
      for (let i = 0; i < h.carriage.size; i++) {
        const px = sx0 + (start + i) * w;
        const py = yOf(h.carriage.at(i));
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.lineWidth = 1.4;
      g.strokeStyle = PALETTE.ink;
      g.stroke();
    }
    text(`${TAIL_SECONDS} s`, sx1, sy1 + 12, 9, PALETTE.faint, 400, 'right');
    text(`energy ${cat.tailEnergy.toFixed(2)}`, sx0, sy1 + 12, 9, PALETTE.muted);

    // Carriage gauge: the tail seen from the side, level pointing back (left), up is 90°.
    const gx = x + COL - 26;
    const gy = y + 70;
    const r = 40;
    g.beginPath();
    g.arc(gx, gy, r, Math.PI / 2, (3 * Math.PI) / 2);
    g.lineWidth = 1;
    g.strokeStyle = PALETTE.border;
    g.stroke();
    for (const s of TAIL_SEMAPHORE) {
      const a = (s.carriage * Math.PI) / 180;
      g.beginPath();
      g.moveTo(gx - Math.cos(a) * (r - 5), gy - Math.sin(a) * (r - 5));
      g.lineTo(gx - Math.cos(a) * r, gy - Math.sin(a) * r);
      g.strokeStyle = s.state === cat.tailState ? PALETTE.accent : PALETTE.faint;
      g.lineWidth = s.state === cat.tailState ? 2 : 1;
      g.stroke();
    }
    const a = (Math.max(-90, Math.min(90, cat.tailCarriage)) * Math.PI) / 180;
    g.beginPath();
    g.moveTo(gx, gy);
    g.lineTo(gx - Math.cos(a) * (r - 4), gy - Math.sin(a) * (r - 4));
    g.lineWidth = 2;
    g.strokeStyle = PALETTE.ink;
    g.stroke();
    g.beginPath();
    g.arc(gx, gy, 3, 0, Math.PI * 2);
    g.fillStyle = PALETTE.ink;
    g.fill();
    text(`${Math.round(cat.tailCarriage)}°`, gx - r / 2, gy + r + 14, 11, PALETTE.ink, 600, 'center');
  };

  const drawFloor = (world: WorldReadout) => {
    const x = RIGHT;
    const y = L.floor.y;
    panel(x, y, COL, L.floor.h, 'Floor', '3 × 2 m, top view');
    const mx0 = x + 12;
    const my0 = y + 30;
    const mw = COL - 24;
    const k = mw / (2 * FLOOR.x);
    const mh = 2 * FLOOR.z * k;
    const mx = (wx: number) => mx0 + (wx + FLOOR.x) * k;
    const my = (wz: number) => my0 + (Math.max(-FLOOR.z, Math.min(FLOOR.z, wz)) + FLOOR.z) * k;
    g.fillStyle = PALETTE.background;
    g.fillRect(mx0, my0, mw, mh);
    g.strokeStyle = PALETTE.rule;
    g.lineWidth = 1;
    for (let gx = -1; gx <= 1.0001; gx += 0.5) {
      g.beginPath();
      g.moveTo(Math.round(mx(gx)) + 0.5, my0);
      g.lineTo(Math.round(mx(gx)) + 0.5, my0 + mh);
      g.stroke();
    }
    for (let gz = -0.5; gz <= 0.5001; gz += 0.5) rule(mx0, mx0 + mw, Math.round(my(gz)));
    g.strokeStyle = PALETTE.border;
    g.strokeRect(mx0 + 0.5, my0 + 0.5, mw - 1, mh - 1);
    text('back wall', mx0 + 50, my0 - 3, 8, PALETTE.faint);

    // Toys and props.
    for (const toy of world.toys) {
      if (toy.kind === 'laser') continue;
      const px = mx(toy.position[0]);
      const py = my(toy.position[2]);
      const ink = toy.active ? PALETTE.ink : PALETTE.muted;
      g.lineWidth = 1;
      g.strokeStyle = ink;
      g.fillStyle = toy.active ? PALETTE.ink : PALETTE.button;
      switch (toy.kind) {
        case 'box':
        case 'bed':
        case 'keyboard':
        case 'cushion': {
          const size: Record<string, [number, number]> = { box: [0.36, 0.28], bed: [0.42, 0.32], keyboard: [0.42, 0.14], cushion: [0.34, 0.3] };
          const [w, d] = size[toy.kind];
          g.fillStyle = toy.active ? 'rgba(77, 73, 64, 0.16)' : 'rgba(255, 255, 255, 0.7)';
          g.beginPath();
          g.roundRect(px - (w * k) / 2, py - (d * k) / 2, w * k, d * k, toy.kind === 'bed' || toy.kind === 'cushion' ? 6 : 1);
          g.fill();
          g.stroke();
          // Labels go inside the shape when they fit, else just below it.
          const inside = measure(toy.kind, 8) < w * k - 4;
          text(toy.kind, px, inside ? py + 3 : py + (d * k) / 2 + 9, 8, PALETTE.muted, 400, 'center');
          break;
        }
        case 'cup':
        case 'ledge':
          g.fillRect(px - 3, py - 3, 6, 6);
          text(toy.kind, px, py + 11, 8, PALETTE.muted, 400, 'center');
          break;
        case 'bird':
          g.beginPath();
          g.moveTo(px - 5, py - 2);
          g.lineTo(px, py + 2);
          g.lineTo(px + 5, py - 2);
          g.stroke();
          text('bird', px, py + 11, 8, PALETTE.muted, 400, 'center');
          break;
        default:
          g.beginPath();
          g.arc(px, py, toy.kind === 'yarn' ? 4 : 3, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          text(toy.kind, px + 6, py - 4, 8, PALETTE.muted);
      }
    }
    // Laser dot.
    if (world.laser) {
      const px = mx(world.laser[0]);
      const py = my(world.laser[2]);
      g.beginPath();
      g.arc(px, py, 7, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255, 90, 31, 0.2)';
      g.fill();
      g.beginPath();
      g.arc(px, py, 2.5, 0, Math.PI * 2);
      g.fillStyle = PALETTE.accent;
      g.fill();
    }
    // Cats: trails, bodies with a heading tick, the selected one ringed.
    for (const c of world.cats) {
      const h = history[c.id];
      if (h) {
        for (let i = 0; i < h.trailX.size; i++) {
          g.globalAlpha = 0.15 + (0.5 * i) / h.trailX.length;
          g.fillStyle = PALETTE.muted;
          g.fillRect(mx(h.trailX.at(i)) - 1, my(h.trailZ.at(i)) - 1, 2, 2);
        }
        g.globalAlpha = 1;
      }
    }
    for (const c of world.cats) {
      const px = mx(c.position[0]);
      const py = my(c.position[2]);
      const a = (c.heading * Math.PI) / 180;
      const ink = BREED_INK[c.id];
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + Math.sin(a) * 14, py + Math.cos(a) * 14);
      g.lineWidth = 2;
      g.strokeStyle = PALETTE.ink;
      g.stroke();
      g.beginPath();
      g.arc(px, py, 6, 0, Math.PI * 2);
      g.fillStyle = ink.fill;
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = ink.stroke;
      g.stroke();
      if (c.id === world.selected) {
        g.beginPath();
        g.arc(px, py, 10, 0, Math.PI * 2);
        g.lineWidth = 1.5;
        g.strokeStyle = PALETTE.accent;
        g.stroke();
      }
      text(c.name, px, py - 13, 9, c.id === world.selected ? PALETTE.accent : PALETTE.ink, 600, 'center');
    }
  };

  const ATTENTION: { key: keyof CatReadout['attention']; label: string; color: string }[] = [
    { key: 'owner', label: 'owner', color: PALETTE.accent },
    { key: 'box', label: 'empty box', color: PALETTE.ink },
    { key: 'nothing', label: 'nothing', color: PALETTE.muted },
    { key: 'toy', label: 'toy', color: PALETTE.faint },
  ];

  const donut = (cx: number, cy: number, r: number, thick: number, cat: CatReadout) => {
    const total = ATTENTION.reduce((s, a) => s + Math.max(0, cat.attention[a.key]), 0) || 1;
    let a0 = -Math.PI / 2;
    for (const a of ATTENTION) {
      const share = Math.max(0, cat.attention[a.key]) / total;
      const a1 = a0 + share * Math.PI * 2;
      g.beginPath();
      g.arc(cx, cy, r - thick / 2, a0, a1);
      g.lineWidth = thick;
      g.strokeStyle = a.color;
      g.stroke();
      a0 = a1;
    }
  };

  const drawAttention = (cat: CatReadout | undefined) => {
    const x = RIGHT;
    const y = L.attention.y;
    panel(x, y, COL, L.attention.h, 'Attention', cat?.name);
    if (!cat) return;
    donut(x + 54, y + 68, 36, 12, cat);
    text(cat.gazeTarget, x + 54, y + 72, 10, PALETTE.ink, 600, 'center');
    const total = ATTENTION.reduce((s, a) => s + Math.max(0, cat.attention[a.key]), 0) || 1;
    ATTENTION.forEach((a, i) => {
      const yy = y + 36 + i * 17;
      g.fillStyle = a.color;
      g.fillRect(x + 112, yy, 8, 8);
      text(a.label, x + 126, yy + 8, 11, PALETTE.ink);
      text(pct(Math.max(0, cat.attention[a.key]) / total), x + COL - 10, yy + 8, 11, PALETTE.ink, 400, 'right');
    });
    text('gaze target', x + 112, y + L.attention.h - 10, 10, PALETTE.muted);
    text(cat.gazeTarget, x + COL - 10, y + L.attention.h - 10, 10, PALETTE.accent, 600, 'right');
  };

  const drawCallout = (world: WorldReadout, ui: ConsoleUi, cat: CatReadout | undefined, t: number) => {
    const x = RIGHT;
    const y = L.callout.y;
    const h = L.callout.h;
    const sub = world.subsystem ? SUBSYSTEMS.find((s) => s.id === world.subsystem) : undefined;
    if (!sub) {
      panel(x, y, COL, h, 'Subsystem', 'none selected');
      SUBSYSTEMS.forEach((s, i) => {
        const yy = y + 40 + i * 18;
        text(s.id, x + 10, yy, 10, PALETTE.muted);
        text(clip(s.title, COL - 96), x + 86, yy, 11, PALETTE.ink);
      });
      return;
    }
    // The selected subsystem's card is pinned to the wall, like a playground's card.
    sheet(x, y, COL, h, PALETTE.ink, 1);
    pin(x + COL / 2, y);
    heading(clip(sub.title, COL - 80, 16), x + 10, y + 22, 16);
    text(sub.id, x + COL - 10, y + 21, 10, PALETTE.muted, 400, 'right');
    let yy = y + 38;
    for (const line of wrap(sub.line, COL - 20, 11)) {
      text(line, x + 10, yy, 11, PALETTE.muted);
      yy += 15;
    }
    yy += 6;
    rule(x + 10, x + COL - 10, yy - 10);
    for (const row of sub.specs) {
      const value = specValue(row, cat, world.counters);
      const age = row.live ? changeAge(`${sub.id}:${row.label}`, value, t) : Infinity;
      const valueW = measure(value, 11, 600);
      text(clip(row.label, COL - 34 - valueW), x + 10, yy + 4, 11, PALETTE.ink);
      if (row.live) {
        g.fillStyle = PALETTE.accent;
        g.fillRect(x + COL - 16 - valueW, yy, 3, 3);
      }
      text(value, x + COL - 10, yy + 4, 11, age < 0.5 ? PALETTE.accent : PALETTE.ink, 600, 'right');
      rule(x + 10, x + COL - 10, yy + 10);
      yy += 19;
    }
    drawChart(sub, world, cat, x + 10, yy + 4, COL - 20, y + h - 10 - (yy + 4), t);

    // Leader from the callout to the parts on stage.
    const a = ui.anchor;
    if (a && a[0] > STAGE_AREA.x && a[0] < STAGE_AREA.x + STAGE_AREA.w && a[1] > STAGE_AREA.y && a[1] < STAGE_AREA.y + STAGE_AREA.h) {
      const hy = y + 14;
      g.beginPath();
      g.moveTo(x, hy);
      g.lineTo(x - 18, hy);
      g.lineTo(a[0], a[1]);
      g.lineWidth = 1.2;
      g.strokeStyle = PALETTE.accent;
      g.stroke();
      g.beginPath();
      g.arc(a[0], a[1], 7, 0, Math.PI * 2);
      g.lineWidth = 1.5;
      g.stroke();
      g.beginPath();
      g.arc(a[0], a[1], 2.5, 0, Math.PI * 2);
      g.fillStyle = PALETTE.accent;
      g.fill();
    }
  };

  const drawChart = (sub: Subsystem, world: WorldReadout, cat: CatReadout | undefined, x: number, y: number, w: number, h: number, t: number) => {
    if (!cat || h < 30) return;
    switch (sub.chart) {
      case 'semaphore': {
        text('Carriage table', x, y + 8, 10, PALETTE.muted);
        const rows = TAIL_SEMAPHORE.length;
        const pitch = Math.min(17, (h - 16) / rows);
        TAIL_SEMAPHORE.forEach((s, i) => {
          const yy = y + 18 + i * pitch;
          const on = s.state === cat.tailState;
          // A small tail glyph at the row's carriage.
          const a = (s.carriage * Math.PI) / 180;
          g.beginPath();
          g.moveTo(x + 16, yy + 6);
          g.lineTo(x + 16 - Math.cos(a) * 12, yy + 6 - Math.sin(a) * 6);
          g.lineWidth = on ? 2 : 1.2;
          g.strokeStyle = on ? PALETTE.accent : PALETTE.muted;
          g.stroke();
          text(s.state, x + 26, yy + 9, 10, on ? PALETTE.accent : PALETTE.ink, on ? 600 : 400);
          text(`${s.mood}  ${s.carriage}°`, x + w, yy + 9, 10, on ? PALETTE.accent : PALETTE.muted, 400, 'right');
        });
        break;
      }
      case 'donut': {
        const r = Math.min(34, h / 2 - 4);
        donut(x + r + 4, y + h / 2, r, 10, cat);
        const total = ATTENTION.reduce((s, a) => s + Math.max(0, cat.attention[a.key]), 0) || 1;
        ATTENTION.forEach((a, i) => {
          const yy = y + h / 2 - 30 + i * 16;
          g.fillStyle = a.color;
          g.fillRect(x + 2 * r + 20, yy, 8, 8);
          text(a.label, x + 2 * r + 34, yy + 8, 10);
          text(pct(Math.max(0, cat.attention[a.key]) / total), x + w, yy + 8, 10, PALETTE.ink, 400, 'right');
        });
        break;
      }
      case 'clock': {
        const r = Math.min(34, h / 2 - 4);
        const cx = x + r + 4;
        const cy = y + h / 2;
        const [hh, mm] = world.clock.split(':').map(Number);
        g.beginPath();
        g.arc(cx, cy, r, 0, Math.PI * 2);
        g.lineWidth = 1;
        g.strokeStyle = PALETTE.border;
        g.stroke();
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          g.beginPath();
          g.moveTo(cx + Math.sin(a) * (r - 4), cy - Math.cos(a) * (r - 4));
          g.lineTo(cx + Math.sin(a) * r, cy - Math.cos(a) * r);
          g.strokeStyle = PALETTE.faint;
          g.stroke();
        }
        const ha = (((hh % 12) + mm / 60) / 12) * Math.PI * 2;
        const ma = (mm / 60) * Math.PI * 2;
        g.lineWidth = 2.2;
        g.strokeStyle = PALETTE.ink;
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + Math.sin(ha) * r * 0.5, cy - Math.cos(ha) * r * 0.5);
        g.stroke();
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + Math.sin(ma) * r * 0.82, cy - Math.cos(ma) * r * 0.82);
        g.stroke();
        text('Local time', x + 2 * r + 20, cy - 8, 10, PALETTE.muted);
        text(world.clock, x + 2 * r + 20, cy + 14, 20, hh === 3 ? PALETTE.accent : PALETTE.ink, 600);
        break;
      }
      case 'counter': {
        const row = sub.specs.find((s) => s.live && s.live in world.counters);
        if (!row) break;
        const value = specValue(row, cat, world.counters);
        const age = changeAge(`chart:${sub.id}`, value, t);
        text(row.label, x, y + 12, 10, PALETTE.muted);
        text(value, x, y + 44, 30, age < 0.6 ? PALETTE.accent : PALETTE.ink, 600);
        if (sub.id === 'keyboard' && world.typed) text(clip(`typed ${world.typed}`, w, 10), x, y + 64, 10, PALETTE.muted);
        if (sub.id === 'paws') text(world.cupOnLedge ? 'cup on ledge' : 'cup on floor', x, y + 64, 10, PALETTE.muted);
        break;
      }
      default: {
        // No chart: the selected cat's act, so the panel still shows what the demo is doing.
        text('Demo', x, y + 12, 10, PALETTE.muted);
        text(`${cat.act}  ${cat.actT.toFixed(1)} s`, x, y + 30, 12, PALETTE.ink, 600);
      }
    }
  };

  const drawRows = (world: WorldReadout, ui: ConsoleUi) => {
    const sel = world.cats.find((c) => c.id === world.selected);
    text('Behaviour', LEFT, L.behaviour.y + 15, 11, PALETTE.muted);
    text('Subsystem', LEFT, L.subsystem.y + 15, 11, PALETTE.muted);
    for (const b of buttons) {
      if (b.kind === 'behaviour') {
        const name = b.label;
        const on = world.game === name || (!!sel && sel.act === name);
        button(b, ui, on);
      } else if (b.kind === 'subsystem') button(b, ui, world.subsystem === b.label);
    }
  };

  const drawCounters = (world: WorldReadout, t: number) => {
    const y = L.counters.y;
    sheet(LEFT, y, EDGE - LEFT, L.counters.h);
    heading('Counters', LEFT + 10, y + 19, 14);
    text('this session', LEFT + 10, y + 34, 10, PALETTE.muted);
    const x0 = LEFT + 112;
    const w = (EDGE - x0) / COUNTER_LABELS.length;
    COUNTER_LABELS.forEach(([key, label], i) => {
      const x = x0 + i * w;
      const value = String(world.counters[key]);
      const age = changeAge(`counter:${key}`, value, t);
      if (i > 0) {
        g.fillStyle = PALETTE.rule;
        g.fillRect(Math.round(x) - 8, y + 8, 1, L.counters.h - 16);
      }
      text(label, x, y + 17, 10, PALETTE.muted);
      text(value, x, y + 37, 16, age < 0.8 ? PALETTE.accent : PALETTE.ink, 600);
    });
  };

  const drawStatus = (world: WorldReadout, ui: ConsoleUi) => {
    const y = L.status.y;
    sheet(LEFT, y, EDGE - LEFT, L.status.h);
    const parts = [
      `time ${mmss(world.time)}`,
      `clock ${world.clock}`,
      `${Math.round(ui.fps)} fps`,
      `tier ${ui.tier}`,
      `game ${world.game ?? 'none'}`,
    ];
    text(parts.join('   '), LEFT + 10, y + 15, 11, PALETTE.ink);
    const tour = ui.tour;
    const right = tour.running
      ? `tour ${mmss(tour.time)} / ${mmss(tour.duration)}`
      : tour.resumeIn !== null
        ? `tour paused, resumes in ${Math.ceil(tour.resumeIn)} s`
        : 'tour off';
    text('drag to orbit   wheel to zoom   keys 1–6 for views', EDGE - 10, y + 15, 10, PALETTE.muted, 400, 'right');
    const hintW = measure('drag to orbit   wheel to zoom   keys 1–6 for views', 10);
    text(right, EDGE - 10 - hintW - 24, y + 15, 11, tour.running ? PALETTE.accent : PALETTE.ink, 600, 'right');
  };

  const drawCaption = (ui: ConsoleUi) => {
    if (!ui.caption) return;
    const s = clip(ui.caption, STAGE_AREA.w - 40, 12);
    const w = measure(s, 12) + 34;
    const x = CONSOLE_WIDTH / 2 - w / 2;
    const y = L.caption.y;
    g.save();
    g.shadowColor = 'rgba(0, 0, 0, 0.18)';
    g.shadowBlur = 14;
    g.shadowOffsetY = 4;
    box(x, y, w, L.caption.h, PALETTE.card, '', L.caption.h / 2);
    g.restore();
    box(x, y, w, L.caption.h, '', PALETTE.border, L.caption.h / 2);
    g.beginPath();
    g.arc(x + 13, y + L.caption.h / 2, 3, 0, Math.PI * 2);
    g.fillStyle = ui.tour.running ? PALETTE.accent : PALETTE.faint;
    g.fill();
    text(s, x + 23, y + 16, 12, PALETTE.ink);
  };

  const drawTags = (world: WorldReadout, ui: ConsoleUi) => {
    for (const tag of ui.tags) {
      const c = world.cats.find((k) => k.id === tag.id);
      if (!c) continue;
      const [x, y] = tag.at;
      if (!(x > STAGE_AREA.x + 30 && x < STAGE_AREA.x + STAGE_AREA.w - 30 && y > STAGE_AREA.y + 10 && y < STAGE_AREA.y + STAGE_AREA.h - 10)) continue;
      const on = c.id === world.selected;
      const s = c.name;
      const w = measure(s, 10, 600) + 12;
      box(x - w / 2, y - 16, w, 16, on ? PALETTE.ink : 'rgba(255, 255, 255, 0.9)', on ? PALETTE.ink : PALETTE.border, 8);
      text(s, x, y - 4.5, 10, on ? PALETTE.card : PALETTE.ink, 600, 'center');
      // A short stem down toward the cat.
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y + 6);
      g.lineWidth = 1;
      g.strokeStyle = on ? PALETTE.accent : PALETTE.border;
      g.stroke();
    }
  };

  const draw = (world: WorldReadout, ui: ConsoleUi, t: number) => {
    sample(world);
    const k = canvas.width / CONSOLE_WIDTH;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.clearRect(0, 0, CONSOLE_WIDTH, CONSOLE_HEIGHT);
    g.textBaseline = 'alphabetic';
    const cat = world.cats.find((c) => c.id === world.selected);
    drawTags(world, ui);
    drawTop(world, ui);
    drawCards(world, ui);
    drawGait(cat);
    drawLoad(cat);
    drawTail(cat);
    drawFloor(world);
    drawAttention(cat);
    drawCallout(world, ui, cat, t);
    drawCaption(ui);
    drawRows(world, ui);
    drawCounters(world, t);
    drawStatus(world, ui);
    dirty = false;
  };

  let frames = 0;

  const con: Console = {
    canvas,
    buttons,
    get scale() {
      return scale;
    },
    resize,
    toConsole,
    toClient,
    hit(cx, cy) {
      const [x, y] = toConsole(cx, cy);
      for (const b of buttons) {
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
          return b.kind === 'explode' ? { id: b.id, value: sliderValueAt(x) } : { id: b.id };
        }
      }
      return null;
    },
    rect(id) {
      const b = byId.get(id);
      if (!b) return null;
      const [x, y] = toClient(b.x, b.y);
      return { x, y, w: b.w * scale, h: b.h * scale };
    },
    point(id, value) {
      const b = byId.get(id);
      if (!b) return null;
      if (b.kind === 'explode') {
        const v = Math.min(1, Math.max(0, value ?? 0));
        return toClient(slider.track[0] + v * (slider.track[1] - slider.track[0]), slider.y);
      }
      // A little left of and below the centre, where a hand would land on a label.
      return toClient(b.x + b.w * 0.5, b.y + b.h * 0.55);
    },
    sliderValue(cx) {
      return sliderValueAt(toConsole(cx, 0)[0]);
    },
    frame(world, ui, t, tier = ui.tier) {
      frames++;
      const every = tierOf(tier).consoleEvery;
      if (!dirty && frames % every !== 0) {
        sample(world);
        return false;
      }
      draw(world, ui, t);
      return true;
    },
    draw,
    clearHistory,
    dispose() {
      window.removeEventListener('resize', resize);
      canvas.remove();
    },
  };
  return con;
}
