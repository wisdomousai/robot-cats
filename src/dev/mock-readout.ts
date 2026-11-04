/**
 * A deterministic stand-in for the cat world, for building the console before the real
 * engine exists. It publishes a WorldReadout with every value the console draws moving:
 * three cats steering about the 3 x 2 m floor with gaits and paw contacts, servo loads,
 * tail carriage and spring energy, ears, gaze and attention shares, counters that tick
 * during the demos, toys, games and the fake clock. It reacts to Input the way the plan
 * says the engine will: `select`, `subsystem` (starts the row's demo act on the selected
 * cat), `trigger` (a behaviour or a game), `cursor`, `bellyTouch` and `resetCounters`.
 *
 * Same seed and same steps give the same readouts: all randomness comes from Rng.
 */
import { SUBSYSTEMS, TAIL_SEMAPHORE } from '../cats/cliches';
import { damp } from '../cats/math/ease';
import { Rng } from '../cats/math/rng';
import { Spring } from '../cats/math/spring';
import { paws as pawContacts } from '../cats/rig/moves';
import type { BreedId, CatReadout, Counters, Input, LegName, Mood, Posture, SystemId, V3, WorldReadout } from '../cats/types';

export interface MockWorld {
  readonly seed: number;
  /** One step: apply the input, then advance dt seconds. */
  update(input: Input, dt: number): void;
  state(): WorldReadout;
  /** Back to the state the seed starts from. */
  reset(): void;
}

// ---------- Tables ----------

type Gaze = CatReadout['gazeTarget'];
type Goal = 'stay' | 'wander' | 'prop' | 'zoom' | 'role';
type Prop = 'box' | 'bed' | 'keyboard' | 'cushion' | 'ledge' | 'bird' | 'ball';

interface ActSpec {
  speed: number;
  posture: Posture;
  mood: Mood;
  length: [number, number];
  /** Weight in free play; 0 means only on request. */
  weight: number;
  goal: Goal;
  prop?: Prop;
  gaze?: Gaze;
}

const act = (speed: number, posture: Posture, mood: Mood, length: [number, number], weight: number, goal: Goal, extra: Partial<ActSpec> = {}): ActSpec => ({
  speed,
  posture,
  mood,
  length,
  weight,
  goal,
  ...extra,
});

const ACTS: Record<string, ActSpec> = {
  idle: act(0, 'stand', 'calm', [2, 4], 2, 'stay'),
  walk: act(0.3, 'stand', 'curious', [5, 9], 3, 'wander'),
  trot: act(0.65, 'stand', 'playful', [3, 6], 1.2, 'wander'),
  run: act(1.3, 'stand', 'playful', [2.5, 4], 0.4, 'wander'),
  sit: act(0, 'sit', 'calm', [3, 7], 2, 'stay'),
  loaf: act(0, 'lie', 'calm', [6, 10], 1.4, 'stay'),
  stretch: act(0, 'stand', 'calm', [2, 3], 0.7, 'stay'),
  groom: act(0, 'sit', 'calm', [4, 7], 1, 'stay'),
  pounce: act(0, 'stand', 'focused', [3, 3.5], 0.5, 'stay', { gaze: 'toy' }),
  sleep: act(0, 'lie', 'sleepy', [16, 24], 0.4, 'stay', { gaze: 'nothing' }),
  sniff: act(0.08, 'stand', 'curious', [2, 4], 1, 'wander'),
  ball: act(0.55, 'stand', 'playful', [7, 10], 0, 'prop', { prop: 'ball', gaze: 'toy' }),
  // Subsystem demos (the `demo` column of SUBSYSTEMS).
  listen: act(0, 'sit', 'curious', [9, 12], 0.3, 'stay', { gaze: 'nothing' }),
  ignore: act(0.3, 'sit', 'calm', [9, 12], 0.3, 'prop', { prop: 'box', gaze: 'box' }),
  slowBlink: act(0, 'sit', 'love', [9, 12], 0.4, 'stay', { gaze: 'owner' }),
  fitsCheck: act(0.3, 'stand', 'curious', [9, 12], 0, 'prop', { prop: 'box', gaze: 'box' }),
  fits: act(0.3, 'lie', 'happy', [10, 14], 0.3, 'prop', { prop: 'box', gaze: 'box' }),
  roll: act(0, 'lie', 'playful', [9, 12], 0.3, 'stay', { gaze: 'owner' }),
  knock: act(0.35, 'stand', 'focused', [9, 12], 0.4, 'prop', { prop: 'ledge', gaze: 'owner' }),
  knead: act(0.3, 'lie', 'love', [9, 12], 0.5, 'prop', { prop: 'cushion' }),
  zoomies: act(1.6, 'stand', 'playful', [8, 10], 0.2, 'zoom', { gaze: 'nothing' }),
  dropTest: act(0, 'stand', 'startled', [8, 10], 0, 'stay'),
  semaphore: act(0, 'sit', 'calm', [10, 12], 0, 'stay'),
  purr: act(0, 'lie', 'love', [9, 12], 0.4, 'stay', { gaze: 'owner' }),
  chatter: act(0.3, 'sit', 'focused', [9, 12], 0.4, 'prop', { prop: 'bird', gaze: 'bird' }),
  keyboard: act(0.3, 'lie', 'calm', [10, 14], 0.4, 'prop', { prop: 'keyboard' }),
  boxOverBed: act(0.3, 'lie', 'happy', [10, 14], 0.3, 'prop', { prop: 'box', gaze: 'box' }),
  // Roles in games.
  chase: act(1.05, 'stand', 'playful', [99, 99], 0, 'role', { gaze: 'cat' }),
  flee: act(0.9, 'stand', 'playful', [99, 99], 0, 'role', { gaze: 'cat' }),
  watch: act(0, 'sit', 'curious', [99, 99], 0, 'role', { gaze: 'cat' }),
  wrestle: act(0.45, 'stand', 'playful', [99, 99], 0, 'role', { gaze: 'cat' }),
  laserChase: act(1.2, 'stand', 'focused', [99, 99], 0, 'role', { gaze: 'toy' }),
  yarnBat: act(0.6, 'stand', 'playful', [99, 99], 0, 'role', { gaze: 'toy' }),
};

const GAMES = ['chase', 'wrestle', 'tag', 'yarn', 'laser'] as const;
type Game = (typeof GAMES)[number];
const GAME_LENGTH = 16;
const SOLO = new Set(['walk', 'trot', 'run', 'sit', 'loaf', 'stretch', 'groom', 'pounce', 'sleep', 'ball']);

/** Fixed props on the floor, metres. The cat stands at `at` to use it. */
const PROPS: Record<Exclude<Prop, 'ball'>, { at: V3; facing?: number; shown: V3 }> = {
  box: { at: [-0.95, 0, -0.5], shown: [-0.95, 0, -0.5] },
  bed: { at: [-0.35, 0, -0.72], shown: [-0.35, 0, -0.72] },
  keyboard: { at: [0.9, 0, -0.62], shown: [0.9, 0, -0.62] },
  cushion: { at: [1.05, 0, 0.55], shown: [1.05, 0, 0.55] },
  ledge: { at: [0.4, 0, -0.78], facing: 180, shown: [0.4, 0.7, -0.95] },
  bird: { at: [-0.2, 0, -0.8], facing: 180, shown: [-0.2, 1.1, -1.0] },
};

const MOOD_TAIL: Record<Mood, string> = {
  calm: 'out, level',
  happy: 'up, hooked tip',
  curious: 'up, hooked tip',
  playful: 'up, hooked tip',
  sleepy: 'low, still',
  cross: 'low, thumping',
  startled: 'up, puffed',
  love: 'up, quivering',
  focused: 'out, level',
};

const ATTENTION: Record<Gaze, CatReadout['attention']> = {
  owner: { owner: 0.12, box: 0.6, nothing: 0.25, toy: 0.03 },
  box: { owner: 0.02, box: 0.96, nothing: 0.02, toy: 0 },
  nothing: { owner: 0.02, box: 0.2, nothing: 0.75, toy: 0.03 },
  toy: { owner: 0.02, box: 0.1, nothing: 0.18, toy: 0.7 },
  cat: { owner: 0.02, box: 0.3, nothing: 0.4, toy: 0.28 },
  bird: { owner: 0.02, box: 0.2, nothing: 0.6, toy: 0.18 },
};

const NAMES: Record<BreedId, string> = { tabby: 'Pixel', siamese: 'Suki', black: 'Soot' };
const STARTS: Record<BreedId, [V3, number]> = {
  tabby: [[-0.6, 0, 0.15], 30],
  siamese: [[0, 0, -0.2], -10],
  black: [[0.6, 0, 0.15], -40],
};
const ENERGY: Record<BreedId, number> = { tabby: 1, siamese: 1.3, black: 0.7 };

/** Inside this margin of the walls the cats turn back. */
const LIMIT = { x: 1.5 - 0.14, z: 1 - 0.14 };
const KEYS = 'fjdk;slaghfj';

// ---------- State ----------

interface Cat {
  id: BreedId;
  rng: Rng;
  x: number;
  z: number;
  heading: number;
  speed: number;
  gait: number;
  act: string;
  actT: number;
  actLen: number;
  directed: boolean;
  goal: [number, number] | null;
  arrived: number;
  flags: Record<string, number>;
  tail: Spring;
  earL: Spring;
  earR: Spring;
  earTarget: number;
  headYaw: number;
  gaze: Gaze;
  gazeT: number;
  attention: CatReadout['attention'];
  load: CatReadout['load'];
  pupil: number;
  blinkMs: number;
  blinkIn: number;
  squash: number;
  distance: number;
}

interface World {
  time: number;
  rng: Rng;
  cats: Cat[];
  selected: BreedId;
  subsystem: SystemId | null;
  counters: Counters;
  game: { kind: Game; t: number; it: BreedId; meet: [number, number]; tagged: number } | null;
  nextGame: number;
  cursor: V3 | null;
  bellyTouch: boolean;
  typed: string;
  cupOnLedge: boolean;
  cupBack: number;
  ball: { x: number; z: number; vx: number; vz: number };
  yarn: { x: number; z: number; vx: number; vz: number };
}

const freshCounters = (): Counters => ({ biscuits: 0, cups: 0, lives: 9, birds: 0, boxes: 0, grabs: 0, laps: 0, keys: 0, blinks: 0 });

const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const DEG = Math.PI / 180;

export function createMockWorld(seed = 1): MockWorld {
  let w: World;

  const startAct = (c: Cat, name: string, directed: boolean) => {
    const spec = ACTS[name] ?? ACTS.idle;
    c.act = name in ACTS ? name : 'idle';
    c.actT = 0;
    c.actLen = c.rng.range(spec.length[0], spec.length[1]);
    c.directed = directed;
    c.arrived = -1;
    c.flags = {};
    c.goal = null;
    if (spec.goal === 'wander' || spec.goal === 'zoom') c.goal = randomPoint(c);
    else if (spec.goal === 'prop' && spec.prop && spec.prop !== 'ball') {
      const p = PROPS[spec.prop].at;
      c.goal = [p[0], p[2]];
    }
    if (spec.goal === 'stay') c.arrived = 0;
  };

  const randomPoint = (c: Cat): [number, number] => [c.rng.range(-LIMIT.x + 0.1, LIMIT.x - 0.1), c.rng.range(-LIMIT.z + 0.1, LIMIT.z - 0.1)];

  const pickFree = (c: Cat) => {
    const names = Object.keys(ACTS).filter((n) => ACTS[n].weight > 0);
    const weights = names.map((n) => {
      const s = ACTS[n];
      const energetic = s.speed > 0.5 ? ENERGY[c.id] : 1;
      return s.weight * energetic;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = c.rng.next() * total;
    let i = 0;
    while (i < names.length - 1 && r >= weights[i]) r -= weights[i++];
    startAct(c, names[i], false);
  };

  const makeCat = (id: BreedId, rng: Rng): Cat => {
    const [p, h] = STARTS[id];
    const c: Cat = {
      id,
      rng: rng.fork(id),
      x: p[0],
      z: p[2],
      heading: h,
      speed: 0,
      gait: 0,
      act: 'idle',
      actT: 0,
      actLen: 1,
      directed: false,
      goal: null,
      arrived: 0,
      flags: {},
      tail: new Spring(1.1, 0.3, 0, 10),
      earL: new Spring(4, 0.3, 0, 10),
      earR: new Spring(4, 0.3, 0, -10),
      earTarget: 0,
      headYaw: 0,
      gaze: 'nothing',
      gazeT: 0,
      attention: { owner: 0.02, box: 0.5, nothing: 0.38, toy: 0.1 },
      load: { head: 0.1, body: 0.2, ears: 0.05, FL: 0.3, FR: 0.3, BL: 0.3, BR: 0.3, tail: 0.1 },
      pupil: 0.4,
      blinkMs: 150,
      blinkIn: 1 + rng.next() * 3,
      squash: 0,
      distance: 0,
    };
    pickFree(c);
    return c;
  };

  const reset = () => {
    const rng = new Rng(seed);
    w = {
      time: 0,
      rng,
      cats: [],
      selected: 'tabby',
      subsystem: null,
      counters: freshCounters(),
      game: null,
      nextGame: 40 + rng.next() * 15,
      cursor: null,
      bellyTouch: false,
      typed: '',
      cupOnLedge: true,
      cupBack: 0,
      ball: { x: 0.25, z: 0.45, vx: 0, vz: 0 },
      yarn: { x: -0.55, z: 0.55, vx: 0, vz: 0 },
    };
    w.cats = (['tabby', 'siamese', 'black'] as BreedId[]).map((id) => makeCat(id, rng));
  };

  const cat = (id: BreedId) => w.cats.find((c) => c.id === id)!;
  const nearest = (c: Cat) => {
    let best: Cat | null = null;
    let d = Infinity;
    for (const o of w.cats) {
      if (o === c) continue;
      const dd = Math.hypot(o.x - c.x, o.z - c.z);
      if (dd < d) {
        d = dd;
        best = o;
      }
    }
    return { other: best!, d };
  };

  const demoFor = (id: SystemId | null) => (id ? SUBSYSTEMS.find((s) => s.id === id)?.demo ?? null : null);

  const endGame = () => {
    w.game = null;
    w.nextGame = w.time + 40 + w.rng.next() * 15;
    for (const c of w.cats) {
      const demo = c.id === w.selected ? demoFor(w.subsystem) : null;
      if (demo) startAct(c, demo, true);
      else startAct(c, 'idle', false);
    }
  };

  const startGame = (kind: Game, it: BreedId) => {
    const a = cat(it);
    const { other } = nearest(a);
    w.game = { kind, t: 0, it, meet: [(a.x + other.x) / 2, (a.z + other.z) / 2], tagged: -9 };
    for (const c of w.cats) {
      let role = 'watch';
      if (kind === 'chase' || kind === 'tag') role = c.id === it ? 'chase' : 'flee';
      else if (kind === 'wrestle') role = c === a || c === other ? 'wrestle' : 'watch';
      else if (kind === 'yarn') role = 'yarnBat';
      else if (kind === 'laser') role = 'laserChase';
      startAct(c, role, true);
    }
  };

  const applyInput = (input: Input) => {
    if (input.resetCounters) {
      w.counters = freshCounters();
      w.typed = '';
    }
    if (input.select) w.selected = input.select;
    if (input.cursor !== undefined) w.cursor = input.cursor;
    w.bellyTouch = !!input.bellyTouch;
    if (input.subsystem !== undefined) {
      w.subsystem = input.subsystem;
      const c = cat(w.selected);
      const demo = demoFor(input.subsystem);
      if (w.game) endGame();
      if (demo) startAct(c, demo, true);
      else startAct(c, 'idle', false);
    }
    if (input.trigger) {
      const t = input.trigger;
      if ((GAMES as readonly string[]).includes(t)) startGame(t as Game, w.selected);
      else if (SOLO.has(t) || t in ACTS) {
        if (w.game) endGame();
        startAct(cat(w.selected), t, true);
      }
    }
  };

  // ----- Per cat -----

  const goalOf = (c: Cat): [number, number] | null => {
    const g = w.game;
    switch (c.act) {
      case 'chase': {
        const target = g?.kind === 'tag' || g?.kind === 'chase' ? nearest(c).other : null;
        return target ? [target.x, target.z] : null;
      }
      case 'flee': {
        const it = g ? cat(g.it) : null;
        if (!it) return null;
        const dx = c.x - it.x;
        const dz = c.z - it.z;
        const d = Math.hypot(dx, dz) || 1;
        if (d > 0.9) return null;
        return [clamp(c.x + (dx / d) * 0.6, -LIMIT.x, LIMIT.x), clamp(c.z + (dz / d) * 0.6, -LIMIT.z, LIMIT.z)];
      }
      case 'wrestle':
        return g ? g.meet : null;
      case 'laserChase': {
        const l = laserAt(w.time);
        return [l[0], l[2]];
      }
      case 'yarnBat':
        return [w.yarn.x, w.yarn.z];
      case 'ball':
        return [w.ball.x, w.ball.z];
      default:
        return c.goal;
    }
  };

  const stepCat = (c: Cat, i: number, dt: number) => {
    const spec = ACTS[c.act] ?? ACTS.idle;
    const t = w.time;
    c.actT += dt;

    // Steering: seek and arrive, a heading turn rate, walls.
    const goal = goalOf(c);
    let targetSpeed = 0;
    let wantHeading: number | null = null;
    if (goal) {
      const dx = goal[0] - c.x;
      const dz = goal[1] - c.z;
      const d = Math.hypot(dx, dz);
      const reach = spec.goal === 'role' ? 0.12 : 0.07;
      if (d > reach) {
        targetSpeed = spec.speed * clamp(d / 0.3, 0.25, 1);
        wantHeading = Math.atan2(dx, dz) / DEG;
      } else if (spec.goal === 'wander' || spec.goal === 'zoom') {
        if (spec.goal === 'zoom') c.flags.waypoints = (c.flags.waypoints ?? 0) + 1;
        c.goal = randomPoint(c);
      } else if (spec.goal === 'prop' && c.arrived < 0) {
        c.arrived = c.actT;
        if (spec.prop === 'box') w.counters.boxes++;
      }
    }
    if (spec.goal === 'prop' && spec.prop && spec.prop !== 'ball' && c.arrived >= 0) {
      const facing = PROPS[spec.prop].facing;
      if (facing !== undefined) wantHeading = facing;
    }
    if (c.act === 'watch' && w.game) {
      const it = cat(w.game.it);
      wantHeading = Math.atan2(it.x - c.x, it.z - c.z) / DEG;
    }
    if (c.act === 'pounce') {
      // Wind up, leap, land.
      targetSpeed = c.actT > 1.5 && c.actT < 2 ? 1.8 : 0;
    }
    if (wantHeading !== null) {
      const turn = wrapDeg(wantHeading - c.heading);
      const rate = (140 + 160 * Math.min(1.5, c.speed)) * dt;
      c.heading = wrapDeg(c.heading + clamp(turn, -rate, rate));
      // Slow down for sharp turns so the cat does not run wide circles round its goal.
      targetSpeed *= clamp(1 - Math.abs(turn) / 140, 0.2, 1);
    }
    c.speed = damp(c.speed, targetSpeed, targetSpeed > c.speed ? 3 : 5, dt);
    const step = c.speed * dt;
    c.x += Math.sin(c.heading * DEG) * step;
    c.z += Math.cos(c.heading * DEG) * step;
    c.distance += step;
    if (Math.abs(c.x) > LIMIT.x || Math.abs(c.z) > LIMIT.z) {
      c.x = clamp(c.x, -LIMIT.x, LIMIT.x);
      c.z = clamp(c.z, -LIMIT.z, LIMIT.z);
      if (spec.goal === 'wander' || spec.goal === 'zoom') c.goal = randomPoint(c);
    }

    // Gait: the phase runs with distance, in radians, as the moves module expects.
    const stride = 0.18 + 0.2 * Math.min(1.6, c.speed);
    c.gait = (c.gait + (2 * Math.PI * step) / stride) % (2 * Math.PI * 1000);
    const gait: CatReadout['gait'] = c.speed < 0.04 ? 'still' : c.speed < 0.45 ? 'walk' : c.speed < 1 ? 'trot' : 'run';
    const moving = gait !== 'still';
    let paws: Record<LegName, boolean> = moving ? pawContacts(c.gait, gait === 'run' ? 'gallop' : 'trot') : { FL: true, FR: true, BL: true, BR: true };
    const posture: Posture = moving ? 'stand' : c.act === 'dropTest' ? 'stand' : spec.posture;

    // Demo phases and counters.
    const at = c.arrived >= 0 ? c.actT - c.arrived : -1;
    const every = (key: string, period: number, from = 0) => {
      if (at < from) return false;
      const n = Math.floor((at - from) / period);
      if (n > (c.flags[key] ?? -1)) {
        c.flags[key] = n;
        return true;
      }
      return false;
    };
    switch (c.act) {
      case 'knead':
        if (every('biscuit', 0.5, 0.5)) w.counters.biscuits++;
        break;
      case 'knock':
        if (at > 2 && !c.flags.knocked && w.cupOnLedge) {
          c.flags.knocked = 1;
          w.cupOnLedge = false;
          w.cupBack = t + 3.5;
          w.counters.cups++;
        }
        if (at > 6 && c.flags.knocked && w.cupOnLedge) {
          // The cup is back: knock it again.
          c.flags.knocked = 0;
          c.arrived = c.actT - 1.5;
        }
        break;
      case 'chatter':
        if (every('bird', 3, 0.8)) w.counters.birds++;
        break;
      case 'keyboard':
        if (every('key', 0.18, 0.6)) {
          w.counters.keys++;
          w.typed = (w.typed + KEYS[Math.floor(c.rng.next() * KEYS.length)]).slice(-28);
        }
        break;
      case 'slowBlink':
        if (every('blink', 2.6, 0.5)) {
          w.counters.blinks++;
          c.blinkMs = c.rng.range(900, 1300);
          c.blinkIn = 2.6;
        }
        break;
      case 'roll':
        if (c.actT > 4.5 && !c.flags.grabbed) {
          c.flags.grabbed = 1;
          w.counters.grabs++;
        }
        if (w.bellyTouch && c.id === w.selected && c.actT > 0.8 && t - (c.flags.touch ?? -9) > 1) {
          c.flags.touch = t;
          w.counters.grabs++;
        }
        break;
      case 'zoomies': {
        const laps = Math.floor(c.distance / 4);
        if (laps > (c.flags.lap ?? Math.floor(c.distance / 4) - 1)) {
          if (c.flags.lap !== undefined) w.counters.laps++;
          c.flags.lap = laps;
        }
        break;
      }
      case 'dropTest': {
        // Lifted, turned over, dropped, lands on its feet: every 4 s.
        const p = c.actT % 4;
        if (p < 2.2) paws = { FL: false, FR: false, BL: false, BR: false };
        break;
      }
      case 'ball':
      case 'yarnBat': {
        const toy = c.act === 'ball' ? w.ball : w.yarn;
        const d = Math.hypot(toy.x - c.x, toy.z - c.z);
        if (d < 0.14 && t - (c.flags.bat ?? -9) > 0.6) {
          c.flags.bat = t;
          const a = (c.heading + c.rng.range(-40, 40)) * DEG;
          const kick = c.rng.range(0.5, 0.9);
          toy.vx += Math.sin(a) * kick;
          toy.vz += Math.cos(a) * kick;
        }
        break;
      }
    }
    if (c.act === 'chase' && w.game?.kind === 'tag') {
      const { other, d } = nearest(c);
      if (d < 0.2 && w.game.t - w.game.tagged > 1.5) {
        w.game.tagged = w.game.t;
        w.game.it = other.id;
        startAct(other, 'chase', true);
        startAct(c, 'flee', true);
      }
    }

    // Tail: a spring chasing the carriage for the mood, kicked now and then by flicks.
    const mood: Mood = spec.mood;
    let state = MOOD_TAIL[mood];
    if (c.act === 'semaphore') state = TAIL_SEMAPHORE[Math.floor(c.actT / 1.6) % TAIL_SEMAPHORE.length].state;
    const row = TAIL_SEMAPHORE.find((s) => s.state === state) ?? TAIL_SEMAPHORE[2];
    let carriage = row.carriage + 6 * Math.sin(t * 0.8 + i * 2);
    if (state === 'up, quivering') carriage += 3 * Math.sin(t * 22);
    if (state === 'low, thumping') carriage += 12 * Math.max(0, Math.sin(t * 5));
    if (c.act === 'dropTest') carriage = 40 * Math.sin((c.actT % 4) * 2.4);
    if (moving) carriage += 8 * Math.sin(c.gait);
    if (c.rng.chance(0.5 * dt)) c.tail.kick(c.rng.range(-160, 160));
    c.tail.update(dt, carriage);

    // Ears and head.
    let earAim = 8 * Math.sin(t * 0.37 + i);
    if (c.rng.chance(0.6 * dt)) c.earTarget = c.rng.range(-25, 25);
    earAim += c.earTarget;
    let headAim = 22 * Math.sin(t * 0.33 + i * 1.7);
    if (moving) headAim *= 0.3;
    if (c.act === 'listen') {
      const cur = w.cursor ?? [Math.sin(t * 0.5) * 1.2, 0, 1.4];
      earAim = clamp(wrapDeg(Math.atan2(cur[0] - c.x, cur[2] - c.z) / DEG - c.heading), -85, 85);
      headAim = 0;
    }
    if (c.act === 'ignore' && c.arrived >= 0) {
      const at2 = c.actT - c.arrived;
      // A glance at the owner (toward the camera), then the box.
      headAim = at2 < 1.4 ? clamp(wrapDeg(-c.heading), -70, 70) : clamp(wrapDeg(Math.atan2(PROPS.box.at[0] - c.x, PROPS.box.at[2] - c.z) / DEG - c.heading), -70, 70);
    }
    if (c.act === 'sleep') {
      headAim = 0;
      earAim = -5;
    }
    c.earL.update(dt, earAim + 10);
    c.earR.update(dt, earAim - 10);
    c.headYaw = damp(c.headYaw, headAim, 4, dt);

    // Gaze and attention.
    c.gazeT -= dt;
    let gaze: Gaze = spec.gaze ?? c.gaze;
    if (!spec.gaze && c.gazeT <= 0) {
      gaze = c.rng.pick(['box', 'nothing', 'toy', 'nothing', 'box', 'owner'] as Gaze[]);
      c.gazeT = c.rng.range(3, 6);
    }
    if (c.act === 'ignore') gaze = c.arrived >= 0 && c.actT - c.arrived < 1.4 ? 'owner' : 'box';
    if (c.act === 'slowBlink' && c.actT > 6) gaze = 'nothing';
    c.gaze = gaze;
    const share = ATTENTION[gaze];
    for (const k of ['owner', 'box', 'nothing', 'toy'] as const) c.attention[k] = damp(c.attention[k], share[k], 0.9, dt);

    // Eyes.
    let pupil = 0.38 + 0.06 * Math.sin(t * 0.7 + i);
    if (gaze === 'toy' || c.act === 'laserChase') pupil = 0.85;
    if (gaze === 'nothing' && (c.act === 'listen' || c.act === 'slowBlink')) pupil = 0.92;
    if (mood === 'sleepy') pupil = 0.15;
    c.pupil = damp(c.pupil, pupil, 3, dt);
    c.blinkIn -= dt;
    if (c.blinkIn <= 0) {
      c.blinkIn = c.rng.range(2.5, 5);
      if (c.act !== 'slowBlink') c.blinkMs = c.rng.range(120, 190);
    }

    // Body.
    let squash = 0;
    if ((c.act === 'fits' || c.act === 'boxOverBed') && at > 1) squash = 0.6;
    else if (c.act === 'loaf') squash = 0.15;
    else if (c.act === 'pounce' && c.actT < 1.5) squash = 0.25;
    c.squash = damp(c.squash, squash, 2.5, dt);

    // Servo load per group, smoothed so the bars move like meters.
    const pace = Math.min(1.5, c.speed) / 1.5;
    const leg = (l: LegName) => {
      if (moving) return paws[l] ? 0.35 + 0.45 * pace : 0.12;
      if (posture === 'lie') return 0.06;
      if (posture === 'sit') return l.startsWith('B') ? 0.55 : 0.25;
      return 0.3;
    };
    const target: CatReadout['load'] = {
      head: 0.12 + 0.08 * Math.abs(Math.sin(t * 0.9 + i)) + (c.act === 'groom' ? 0.4 : 0) + (c.act === 'chatter' ? 0.35 : 0) + (c.act === 'listen' ? 0.2 : 0),
      body: 0.15 + 0.35 * pace + c.squash * 0.6 + (c.act === 'stretch' ? 0.45 : 0) + (c.act === 'dropTest' ? 0.5 : 0),
      ears: 0.06 + Math.min(0.8, (Math.abs(c.earL.v) + Math.abs(c.earR.v)) * 0.004),
      FL: leg('FL'),
      FR: leg('FR'),
      BL: leg('BL'),
      BR: leg('BR'),
      tail: 0.1 + Math.min(0.8, Math.sqrt(2 * c.tail.energy()) / 50),
    };
    if (c.act === 'knead' && at > 0.5) {
      target.FL = 0.3 + 0.55 * Math.max(0, Math.sin(t * 2 * Math.PI));
      target.FR = 0.3 + 0.55 * Math.max(0, -Math.sin(t * 2 * Math.PI));
    }
    if (c.act === 'knock' && at > 1.4 && at < 2.2) target.FL = 0.92;
    if (c.act === 'zoomies') for (const l of ['FL', 'FR', 'BL', 'BR'] as const) target[l] = Math.min(1, target[l] + 0.2);
    for (const k of Object.keys(target) as (keyof CatReadout['load'])[]) c.load[k] = damp(c.load[k], clamp(target[k], 0, 1), 10, dt);

    return { paws, posture, gait, mood, state };
  };

  // ----- World -----

  const laserAt = (t: number): V3 => [1.15 * Math.sin(t * 0.9), 0, 0.72 * Math.sin(t * 1.3 + 1)];

  const moveToy = (toy: World['ball'], dt: number) => {
    toy.x += toy.vx * dt;
    toy.z += toy.vz * dt;
    const k = Math.exp(-1.2 * dt);
    toy.vx *= k;
    toy.vz *= k;
    if (Math.abs(toy.x) > LIMIT.x) {
      toy.x = clamp(toy.x, -LIMIT.x, LIMIT.x);
      toy.vx *= -0.6;
    }
    if (Math.abs(toy.z) > LIMIT.z) {
      toy.z = clamp(toy.z, -LIMIT.z, LIMIT.z);
      toy.vz *= -0.6;
    }
  };

  let snapshot: WorldReadout;
  const published: { paws: Record<LegName, boolean>; posture: Posture; gait: CatReadout['gait']; mood: Mood; state: string }[] = [];

  const build = (): WorldReadout => {
    const minutes = 14 * 60 + 20 + Math.floor(w.time);
    const zoom = w.cats.find((c) => c.act === 'zoomies');
    const clock = zoom ? `03:${String(Math.min(59, Math.floor(zoom.actT))).padStart(2, '0')}` : `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const cats: CatReadout[] = w.cats.map((c, i) => {
      const p = published[i] ?? { paws: { FL: true, FR: true, BL: true, BR: true }, posture: 'stand' as Posture, gait: 'still' as const, mood: 'calm' as Mood, state: 'out, level' };
      const spec = ACTS[c.act] ?? ACTS.idle;
      const purr = c.act === 'purr' ? 25 + 1.5 * Math.sin(w.time * 0.7) : c.act === 'knead' && c.arrived >= 0 ? 24 : spec.mood === 'love' ? 22 : 0;
      return {
        id: c.id,
        name: NAMES[c.id],
        mood: p.mood,
        act: c.act,
        actT: c.actT,
        posture: p.posture,
        position: [c.x, 0, c.z],
        heading: c.heading,
        speed: c.speed,
        gaitPhase: c.gait,
        gait: p.gait,
        paws: { ...p.paws },
        load: { ...c.load },
        tailEnergy: Math.min(1, Math.sqrt(2 * c.tail.energy()) / 40),
        tailCarriage: c.tail.y,
        tailState: p.state,
        earAzimuth: [c.earL.y, c.earR.y],
        headYaw: c.headYaw,
        gazeTarget: c.gaze,
        attention: { ...c.attention },
        pupil: c.pupil,
        blinkMs: c.blinkMs,
        squash: c.squash,
        purrHz: purr,
        liquid: c.squash > 0.3,
        bellyArmed: c.act === 'roll' && c.actT > 0.8,
        whiskerSpan: c.act === 'fitsCheck' ? 0.24 + 0.012 * Math.sin(w.time * 3) : 0.235 + 0.006 * Math.sin(w.time * 1.7 + i),
      };
    });
    const toys: WorldReadout['toys'] = [
      { kind: 'box', position: [...PROPS.box.shown], active: w.cats.some((c) => (c.act === 'fits' || c.act === 'boxOverBed' || c.act === 'ignore') && c.arrived >= 0) },
      { kind: 'bed', position: [...PROPS.bed.shown], active: false },
      { kind: 'keyboard', position: [...PROPS.keyboard.shown], active: w.cats.some((c) => c.act === 'keyboard' && c.arrived >= 0) },
      { kind: 'cushion', position: [...PROPS.cushion.shown], active: w.cats.some((c) => c.act === 'knead' && c.arrived >= 0) },
      { kind: 'cup', position: w.cupOnLedge ? [...PROPS.ledge.shown] : [PROPS.ledge.shown[0] + 0.05, 0, -0.62], active: w.cupOnLedge },
      { kind: 'bird', position: [...PROPS.bird.shown], active: w.cats.some((c) => c.act === 'chatter') },
      { kind: 'ball', position: [w.ball.x, 0, w.ball.z], active: Math.hypot(w.ball.vx, w.ball.vz) > 0.05 },
      { kind: 'yarn', position: [w.yarn.x, 0, w.yarn.z], active: w.game?.kind === 'yarn' },
    ];
    const laser = w.game?.kind === 'laser' ? laserAt(w.time) : null;
    if (laser) toys.push({ kind: 'laser', position: laser, active: true });
    return {
      time: w.time,
      cats,
      selected: w.selected,
      subsystem: w.subsystem,
      counters: { ...w.counters },
      clock,
      toys,
      game: w.game?.kind ?? null,
      typed: w.typed,
      cupOnLedge: w.cupOnLedge,
      laser,
    };
  };

  const update = (input: Input, dt: number) => {
    applyInput(input);
    if (dt <= 0) {
      snapshot = build();
      return;
    }
    w.time += dt;
    if (w.game) {
      w.game.t += dt;
      if (w.game.t > GAME_LENGTH) endGame();
    } else if (w.subsystem === null && w.time > w.nextGame) {
      startGame(w.rng.pick(GAMES), w.rng.pick(w.cats).id);
    }
    if (!w.cupOnLedge && w.time > w.cupBack) w.cupOnLedge = true;
    moveToy(w.ball, dt);
    moveToy(w.yarn, dt);

    w.cats.forEach((c, i) => {
      published[i] = stepCat(c, i, dt);
      if (c.actT >= c.actLen) {
        const demo = c.id === w.selected ? demoFor(w.subsystem) : null;
        if (demo && !w.game) startAct(c, demo, true);
        else if (!w.game) pickFree(c);
      }
    });
    // Keep the cats from passing through each other (wrestlers may touch).
    for (let a = 0; a < w.cats.length; a++) {
      for (let b = a + 1; b < w.cats.length; b++) {
        const p = w.cats[a];
        const q = w.cats[b];
        const min = p.act === 'wrestle' && q.act === 'wrestle' ? 0.16 : 0.3;
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d > 1e-6 && d < min) {
          const push = (min - d) / 2;
          p.x -= (dx / d) * push;
          p.z -= (dz / d) * push;
          q.x += (dx / d) * push;
          q.z += (dz / d) * push;
        }
      }
    }
    snapshot = build();
  };

  reset();
  snapshot = build();

  return {
    seed,
    update,
    state: () => snapshot,
    reset() {
      reset();
      published.length = 0;
      snapshot = build();
    },
  };
}
