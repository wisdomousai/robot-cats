import { Cat, type CatEnv, type CatRole, OWNER } from './brain/cat';
import { Director } from './brain/play';
import type { Obstacle } from './brain/steer';
import { Toys } from './brain/toys';
import { byId } from './cliches';
import { Rng } from './math/rng';
import { BREED_IDS } from './model/dims';
import { GAME_NAMES, type BreedId, type CatModel, type Counters, type GameName, type Input, type SystemId, type V3, type WorldReadout } from './types';

/**
 * The cats' world: the three cats, the toys and props, the director that runs group games,
 * the session counters and the fake wall clock. `step(dt, input)` applies the page's input
 * and advances everything by dt; `readout()` gives the plain data the console draws, in the
 * same shape as src/dev/mock-readout.ts.
 *
 * Input follows the console's conventions. A subsystem button sends only `{ subsystem }`,
 * and the world starts that row's demo act on the selected cat; while the subsystem stays
 * set, the selected cat runs the demo again each time it ends. A behaviour button sends its
 * name as `trigger`: the games start with the selected cat as the one that starts them, the
 * rest are acts the selected cat runs once. The subsystem is left as the page set it.
 *
 * Nothing here reads the system clock or the global random source: time is the sum of the
 * dt values and every random number comes from Rng forks of the seed.
 */

export interface WorldOptions {
  /** Colour of the cats' x-ray look. */
  accent?: string;
  /**
   * Models from an earlier world to reuse, matched by breed. Starting a world over with the
   * same seed then replays the same way on the meshes the page already shows.
   */
  models?: CatModel[];
}

const freshCounters = (): Counters => ({ biscuits: 0, cups: 0, lives: 9, birds: 0, boxes: 0, grabs: 0, laps: 0, keys: 0, blinks: 0 });

/** The act name a cat shows while it waits out another cat's demo. */
const WAIT_ACT = 'watch';

/** Places a cat can wait at during a demo: a grid over the floor, filtered against the props when used. */
const WAIT_SPOTS: V3[] = [];
for (let x = -1.2; x <= 1.21; x += 0.24) for (const z of [-0.3, 0, 0.25, 0.5, 0.72]) WAIT_SPOTS.push([x, 0, z]);

/** Half the length of a cat with some room to spare, metres: what one must not cover of another. */
const WAIT_BODY = 0.5;

/** Floor distance from q to the segment a to b. */
function toSegment(q: V3, a: V3, b: V3): number {
  const vx = b[0] - a[0];
  const vz = b[2] - a[2];
  const len2 = vx * vx + vz * vz;
  const u = len2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * vx + (q[2] - a[2]) * vz) / len2)) : 0;
  return Math.hypot(q[0] - a[0] - u * vx, q[2] - a[2] - u * vz);
}

/** The wall clock starts here and runs a minute per world second. */
const CLOCK_START = 14 * 60 + 20;

const pad = (n: number) => String(n).padStart(2, '0');

export class CatWorld implements CatEnv {
  readonly seed: number;
  readonly toys: Toys;
  readonly cats: Cat[];
  readonly director: Director;
  readonly counters: Counters = freshCounters();
  time = 0;
  selected: BreedId = 'tabby';
  subsystem: SystemId | null = null;
  cursor: V3 | null = null;
  cursorAge = 99;
  /** Where the owner's eyes are: the default camera's position. The page may move it with the camera. */
  ownerAt: V3 = [...OWNER];
  /**
   * Where the camera the visitor looks through is heading, when the page knows; null means
   * the owner's eyes. Waiting cats keep off the line from it to the demo cat.
   */
  eye: () => V3 | null = () => null;
  private readonly claims = new Map<string, Cat>();
  /** Cats sent aside during a demo, with the spot each waits at and when it was picked. */
  private readonly parked = new Map<Cat, { spot: V3; at: number; role: CatRole | null }>();
  private belly = false;

  constructor(seed = 1, opts: WorldOptions = {}) {
    this.seed = seed;
    const rng = new Rng(seed);
    // The cup sits toward the ledge's left end, where a cat standing beside the ledge can reach it.
    this.toys = new Toys(rng.fork('toys'), { cup: [-0.08, 0.05] });
    this.cats = BREED_IDS.map((id) => new Cat(id, rng, { accent: opts.accent, model: opts.models?.find((m) => m.breed.id === id) }));
    for (const cat of this.cats) {
      cat.env = this;
      cat.place();
    }
    this.director = new Director(rng);
  }

  get models(): CatModel[] {
    return this.cats.map((c) => c.model);
  }

  cat(id: BreedId): Cat {
    return this.cats.find((c) => c.id === id) ?? this.cats[0];
  }

  /** The current game's name, or null. */
  get game(): GameName | null {
    return this.director.game;
  }

  // ---------- Stepping ----------

  step(dt: number, input: Input = {}): void {
    this.apply(input);
    if (!(dt > 0)) return;
    this.time += dt;
    this.cursorAge += dt;
    // Free play counts toward a game only while no demo and no button's act is running.
    const busy = this.subsystem !== null || this.cats.some((c) => c.directed && !c.role);
    this.director.step(dt, this, !busy);
    this.makeRoom();
    for (const cat of this.cats) cat.step(dt, this);

    // Paws and bellies on the keyboard press its keys; the cushion is pressed by the kneading act.
    // Only the keyboard act and a cat lying on it type: a cat running across would otherwise
    // fill the counter and the typed text during acts that have nothing to do with it.
    const kb = this.toys.keyboard;
    for (const cat of this.cats) {
      if (cat.actName !== 'keyboard' && cat.shownPosture !== 'lie') continue;
      const on = cat.pressPoints().filter((p) => p[1] < kb.size[1] + 0.03 && kb.contains(p, 0));
      if (on.length) kb.stepOn(on);
    }
    const movers: Obstacle[] = [];
    for (const cat of this.cats) movers.push(...this.circles(cat));
    this.toys.step(dt, movers);
    for (const e of this.toys.drain()) {
      if (e.kind === 'cup' && e.name === 'landed') {
        this.counters.cups++;
        this.noise();
      } else if (e.kind === 'box' && e.name === 'entered') this.counters.boxes++;
      else if (e.kind === 'keyboard' && e.name === 'key') this.counters.keys++;
    }
    this.belly = false;
  }

  private apply(input: Input): void {
    if (input.resetCounters) this.resetCounters();
    if (input.select && BREED_IDS.includes(input.select)) this.selected = input.select;
    if (input.cursor !== undefined) {
      const c = input.cursor;
      const prev = this.cursor;
      const moved = !c !== !prev || (c && prev && Math.hypot(c[0] - prev[0], c[2] - prev[2]) > 0.002);
      if (moved && c) this.cursorAge = 0;
      this.cursor = c ? [c[0], 0, c[2]] : null;
    }
    if (input.bellyTouch) this.belly = true;
    if (input.subsystem !== undefined) {
      this.subsystem = input.subsystem;
      const demo = this.demoAct(input.subsystem);
      if (demo) {
        this.director.stop();
        this.cat(this.selected).start(demo, true);
      }
    }
    if (input.trigger) {
      const t = input.trigger;
      const cat = this.cat(this.selected);
      if ((GAME_NAMES as readonly string[]).includes(t)) this.director.start(t as GameName, cat, this);
      else if (cat.acts[t]) {
        this.director.stop();
        cat.start(t, true);
      }
      this.director.hold();
    }
  }

  // ---------- Demos ----------

  /**
   * While the selected cat shows a demo, the other cats in free play go and wait where they
   * neither crowd it nor stand between it and the camera, and watch it. Left to free play
   * they wander into the shot, and the demo cannot be read from the default camera. When the
   * demo ends, or another cat is selected, they get their own acts back.
   */
  private makeRoom(): void {
    const shown = !this.director.game && this.demoAct(this.subsystem) ? this.cat(this.selected) : null;
    for (const cat of this.cats) {
      // Only the role this method gave counts; a game may use the same act name.
      const entry0 = this.parked.get(cat);
      const waiting = !!entry0 && cat.role === entry0.role;
      if (!shown || cat === shown) {
        if (waiting) cat.direct(null);
        this.parked.delete(cat);
        continue;
      }
      if (waiting) continue;
      this.parked.delete(cat);
      // A button's act or a game's role is left alone.
      if (cat.directed) continue;
      const entry = { spot: this.waitSpot(cat, null), at: this.time, role: null as CatRole | null, inWay: false };
      this.parked.set(cat, entry);
      entry.role = {
        act: WAIT_ACT,
        mood: 'calm',
        // A cat in the way, as when the demo cat walks off behind it, trots clear.
        get hurry() {
          return entry.inWay ? 0.9 : 0.4;
        },
        arrive: 0.08,
        // The demo cat moves about, so the spot is looked at again now and then; not while it
        // runs, or the waiting cats would trail round the room after a cat with the zoomies,
        // unless the waiting cat is in the way.
        goal: () => {
          entry.inWay = this.inTheWay(cat.steer.position);
          const due = entry.inWay ? 0.5 : 1.5;
          if (this.time - entry.at > due && (entry.inWay || this.cat(this.selected).steer.speed < 0.5)) {
            entry.spot = this.waitSpot(cat, entry.spot);
            entry.at = this.time;
          }
          return entry.spot;
        },
        look: () => this.cat(this.selected).headAt,
        faceTo: () => this.cat(this.selected).steer.position,
        gaze: 'cat',
        pose: () => {
          cat.posture = cat.walking ? 'stand' : 'sit';
        },
      };
      cat.direct(entry.role);
    }
  }

  /**
   * Whether a cat at q stands in the way of the demo cat, seen from the camera the beat is
   * seen through (a side or top view moves it away from the owner's eyes). A cat nearer the
   * camera looks bigger, so the room it needs beside the line grows toward the camera: the
   * angle between the two cats, as the camera sees them, is compared with the angles their
   * bodies take up. A cat beyond the demo cat is the one hidden, which does no harm.
   */
  private inTheWay(q: V3, shown: V3 = this.cat(this.selected).steer.position): boolean {
    const cam = this.eye() ?? this.ownerAt;
    if (toSegment(q, shown, [cam[0], 0, cam[2]]) < 0.5) return true;
    const a: V3 = [shown[0] - cam[0], 0.25 - cam[1], shown[2] - cam[2]];
    const b: V3 = [q[0] - cam[0], 0.25 - cam[1], q[2] - cam[2]];
    const da = Math.hypot(...a);
    const db = Math.hypot(...b);
    if (db > da) return false;
    const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (da * db);
    return Math.acos(Math.min(1, cos)) < Math.atan(WAIT_BODY / da) + Math.atan(WAIT_BODY / db);
  }

  /**
   * Where `cat` should wait during the selected cat's demo: away from the props, the other
   * waiting cats and the demo cat, and off the line from the demo cat to the camera. `keep`
   * is the spot it already has, kept unless another is clearly better.
   */
  private waitSpot(cat: Cat, keep: V3 | null): V3 {
    const shown = this.cat(this.selected).steer.position;
    const eye: V3 = [this.ownerAt[0], 0, this.ownerAt[2]];
    const cam = this.eye() ?? this.ownerAt;
    const props = this.toys.obstacles();
    const soft = [this.toys.cushion.position, this.toys.keyboard.position];
    // The box demos walk up to the box's front and hop in from there.
    const box = this.toys.box;
    const yaw = (box.yaw * Math.PI) / 180;
    const reach = box.size[2] / 2 + 0.43;
    const boxFront: V3 = [box.position[0] + reach * Math.sin(yaw), 0, box.position[2] + reach * Math.cos(yaw)];
    const taken: V3[] = [];
    for (const [other, e] of this.parked) if (other !== cat) taken.push(e.spot);
    const here = cat.steer.position;
    const score = (q: V3): number => {
      if (props.some((o) => Math.hypot(q[0] - o.x, q[2] - o.z) < o.r + 0.3)) return -Infinity;
      if (soft.some((o) => Math.hypot(q[0] - o[0], q[2] - o[2]) < 0.4)) return -Infinity;
      if (Math.hypot(q[0] - boxFront[0], q[2] - boxFront[2]) < 0.5) return -Infinity;
      // The front right corner is so close to the default camera that a cat there fills the frame.
      if (Math.hypot(q[0] - eye[0], q[2] - eye[2]) < 3) return -Infinity;
      // Two waiting cats one behind the other read as one heap, so that counts as a crowd too.
      const crowd = taken.some((o) => Math.hypot(q[0] - o[0], q[2] - o[2]) < 0.55 || this.inTheWay(q, o) || this.inTheWay(o, q)) ? 2 : 0;
      // Between the demo cat and the camera is the one place it must not be.
      const across = toSegment(q, shown, [cam[0], 0, cam[2]]);
      const line = Math.min(across, 0.9) - (this.inTheWay(q) ? 3 : 0);
      const apart = Math.min(Math.hypot(q[0] - shown[0], q[2] - shown[2]), 1.1);
      const walk = Math.hypot(q[0] - here[0], q[2] - here[2]);
      // Nearer the camera a waiting cat fills the frame, so the far side of the room is better.
      const far = Math.min(Math.hypot(q[0] - eye[0], q[2] - eye[2]), 4.5) * 0.5;
      return line + 0.5 * apart + far - 0.15 * walk - crowd;
    };
    let best = keep;
    let bestScore = keep ? score(keep) + 0.15 : -Infinity;
    for (const q of WAIT_SPOTS) {
      const sc = score(q);
      if (sc > bestScore) {
        best = q;
        bestScore = sc;
      }
    }
    return best ?? here;
  }

  /** Something loud: cats close by start. */
  private noise(): void {
    for (const cat of this.cats) cat.mood.trigger('noise', 0.3);
  }

  resetCounters(): void {
    Object.assign(this.counters, freshCounters());
    this.toys.keyboard.typed = '';
  }

  private demoAct(id: SystemId | null): string | null {
    return id ? (byId(id)?.demo ?? null) : null;
  }

  // ---------- What the cats see (CatEnv) ----------

  bellyTouched(cat: Cat): boolean {
    return this.belly && cat.id === this.selected;
  }

  owner(): V3 {
    return this.ownerAt;
  }

  count(key: keyof Counters, n = 1): void {
    this.counters[key] += n;
  }

  claim(prop: string, cat: Cat): boolean {
    const holder = this.claims.get(prop);
    if (holder && holder !== cat) {
      // A demo or a button wins: the other cat gives the prop up and wanders off.
      if (!cat.directed || holder.directed) return false;
      holder.start('walk');
    }
    this.claims.set(prop, cat);
    return true;
  }

  claimedBy(prop: string): Cat | null {
    return this.claims.get(prop) ?? null;
  }

  release(cat: Cat): void {
    for (const [prop, holder] of this.claims) if (holder === cat) this.claims.delete(prop);
  }

  /** A cat as two circles along its length, so the others keep clear of its head and its rump. */
  private circles(cat: Cat): Obstacle[] {
    const s = cat.steer;
    const front = s.toWorld(0, 0.16);
    const back = s.toWorld(0, -0.15);
    return [
      { id: cat.id, x: front[0], z: front[2], r: 0.17, soft: true },
      { id: cat.id, x: back[0], z: back[2], r: 0.17, soft: true },
    ];
  }

  obstacles(cat: Cat): Obstacle[] {
    const out = this.toys.obstacles();
    for (const other of this.cats) if (other !== cat) out.push(...this.circles(other));
    return out;
  }

  demoFor(cat: Cat): string | null {
    if (cat.id !== this.selected || this.director.game) return null;
    return this.demoAct(this.subsystem);
  }

  // ---------- Readout ----------

  /** The fake wall clock: 14:20 plus a minute per second, or 03:xx while a cat has the zoomies. */
  clock(): string {
    const zoom = this.cats.find((c) => c.actName === 'zoomies');
    if (zoom) return `03:${pad(Math.min(59, Math.floor(zoom.actT)))}`;
    const minutes = CLOCK_START + Math.floor(this.time);
    return `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
  }

  readout(): WorldReadout {
    const t = this.toys;
    return {
      time: this.time,
      cats: this.cats.map((c) => c.readout()),
      selected: this.selected,
      subsystem: this.subsystem,
      counters: { ...this.counters },
      clock: this.clock(),
      toys: t.readout().map((r) => ({ kind: r.kind, position: [...r.position] as V3, active: r.active })),
      game: this.director.game,
      typed: t.keyboard.typed,
      cupOnLedge: t.cup.onLedge,
      laser: t.laser.on ? ([...t.laser.position] as V3) : null,
    };
  }
}
