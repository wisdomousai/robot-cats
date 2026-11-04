import { clamp, damp, ease } from '../math/ease';
import type { Rng } from '../math/rng';
import type { ToyKind, ToyReadout, V2, V3 } from '../types';
import { PLAY_AREA, type Obstacle } from './steer';

/**
 * The toys and props, simulated without a scene: a ball, a ball of yarn with a verlet
 * strand, a laser dot, a cup on a ledge, a box, a bed, a keyboard, a cushion and a bird on
 * the back wall. geo/props.ts draws them from these objects.
 *
 * Every toy has `position` (metres, three.js axes, on or above the floor), `step(dt)`,
 * `readout()` for the console, and an `events` list of short names (`fell`, `key`,
 * `bounce`) that collects until `Toys.drain()` empties it. Cats act on toys through
 * methods (`bat`, `knock`, `pin`, `stepOn`, `press`, `alarm`), which may be called before or
 * after the toy's step in the same tick. Randomness comes only from the Rng passed in.
 */

const G = 9.81;
const TAU = 2 * Math.PI;

export type Quat = [x: number, y: number, z: number, w: number];

export interface Toy {
  readonly kind: ToyKind;
  readonly position: V3;
  readonly events: string[];
  step(dt: number): void;
  readout(): ToyReadout;
}

/** Events kept per toy when nobody drains them, so the list cannot grow without end. */
const MAX_EVENTS = 32;

function emit(events: string[], name: string) {
  events.push(name);
  if (events.length > MAX_EVENTS) events.shift();
}

/** Turns q by the rotation `angle` radians about the unit axis (ax, ay, az), in world axes. */
function rotate(q: Quat, ax: number, ay: number, az: number, angle: number): void {
  const s = Math.sin(angle / 2);
  const c = Math.cos(angle / 2);
  const [x, y, z, w] = q;
  const bx = ax * s;
  const by = ay * s;
  const bz = az * s;
  // r = b * q, the new rotation applied after the old one.
  q[0] = c * x + bx * w + by * z - bz * y;
  q[1] = c * y - bx * z + by * w + bz * x;
  q[2] = c * z + bx * y - by * x + bz * w;
  q[3] = c * w - bx * x - by * y - bz * z;
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= n;
  q[1] /= n;
  q[2] /= n;
  q[3] /= n;
}

/** Rolls an orientation by a ball's floor velocity over dt: no slip, so the turn is distance / radius. */
function roll(q: Quat, vx: number, vz: number, radius: number, dt: number): void {
  const v = Math.hypot(vx, vz);
  if (v < 1e-6) return;
  // Rolling toward +x turns about -z, toward +z about +x: the axis is up × velocity.
  rotate(q, vz / v, 0, -vx / v, (v * dt) / radius);
}

/** Keeps a floor point and its velocity inside the play area, bouncing off the walls. */
function wallBounce(p: V3, v: V3, inset: number, restitution: number): boolean {
  let hit = false;
  const bx = PLAY_AREA.x - inset;
  const bz = PLAY_AREA.z - inset;
  if (p[0] > bx || p[0] < -bx) {
    p[0] = clamp(p[0], -bx, bx);
    if (v[0] * p[0] > 0) v[0] = -v[0] * restitution;
    hit = true;
  }
  if (p[2] > bz || p[2] < -bz) {
    p[2] = clamp(p[2], -bz, bz);
    if (v[2] * p[2] > 0) v[2] = -v[2] * restitution;
    hit = true;
  }
  return hit;
}

/**
 * Pushes a round toy out of the circles it overlaps. Off a prop it bounces; off a cat
 * (soft) it is shoved, taking up the cat's push as speed, so a cat walking through the
 * ball sends it rolling.
 */
function collide(p: V3, v: V3, r: number, obstacles: readonly Obstacle[], restitution: number, dt: number): boolean {
  let hit = false;
  for (const o of obstacles) {
    const dx = p[0] - o.x;
    const dz = p[2] - o.z;
    const d = Math.hypot(dx, dz);
    const overlap = o.r + r - d;
    if (overlap <= 0) continue;
    const nx = d > 1e-6 ? dx / d : 1;
    const nz = d > 1e-6 ? dz / d : 0;
    p[0] += nx * overlap;
    p[2] += nz * overlap;
    const vn = v[0] * nx + v[2] * nz;
    if (o.soft) {
      const shove = Math.min(1.2, (overlap / dt) * 0.5);
      if (vn < shove) {
        v[0] += nx * (shove - vn);
        v[2] += nz * (shove - vn);
      }
    } else if (vn < 0) {
      v[0] -= (1 + restitution) * vn * nx;
      v[2] -= (1 + restitution) * vn * nz;
    }
    hit = true;
  }
  return hit;
}

// ---------- Ball ----------

/** A light ball: rolls with friction, bounces off walls and props, hops when batted from below. */
export class Ball implements Toy {
  readonly kind = 'ball';
  readonly radius: number;
  readonly position: V3;
  readonly velocity: V3 = [0, 0, 0];
  /** Orientation, rolled from the motion so the seam turns as it goes. */
  readonly spin: Quat = [0, 0, 0, 1];
  readonly events: string[] = [];
  /** Props to bounce off and cats that shove it; Toys sets these each step. */
  obstacles: readonly Obstacle[] = [];
  /** Per-second velocity decay on the floor, and a constant rolling drag in m/s². */
  friction = 0.55;
  drag = 0.1;

  constructor(at: V3, radius = 0.045) {
    this.radius = radius;
    this.position = [at[0], radius, at[2]];
  }

  get speed(): number {
    return Math.hypot(this.velocity[0], this.velocity[2]);
  }

  /** A paw strike from `from`: the ball leaves directly away from the paw, `lift` m/s upward. */
  bat(from: V3, strength = 0.9, lift = 0): void {
    let dx = this.position[0] - from[0];
    let dz = this.position[2] - from[2];
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) {
      dx = 0;
      dz = 1;
    } else {
      dx /= d;
      dz /= d;
    }
    this.velocity[0] += dx * strength;
    this.velocity[2] += dz * strength;
    this.velocity[1] += lift;
    emit(this.events, 'bat');
  }

  step(dt: number): void {
    const p = this.position;
    const v = this.velocity;
    const r = this.radius;
    if (p[1] > r + 1e-6 || v[1] > 0) {
      v[1] -= G * dt;
      p[1] += v[1] * dt;
      if (p[1] <= r) {
        p[1] = r;
        if (v[1] < -0.3) {
          v[1] = -v[1] * 0.45;
          emit(this.events, 'bounce');
        } else v[1] = 0;
      }
    }
    const onFloor = p[1] <= r + 1e-6;
    if (onFloor) {
      const s = this.speed;
      if (s > 0) {
        const k = Math.exp(-this.friction * dt);
        const after = Math.max(0, s * k - this.drag * dt);
        v[0] *= after / s;
        v[2] *= after / s;
      }
    }
    p[0] += v[0] * dt;
    p[2] += v[2] * dt;
    if (collide(p, v, r, this.obstacles, 0.5, dt)) emit(this.events, 'hit');
    if (wallBounce(p, v, r, 0.6)) emit(this.events, 'wall');
    if (onFloor) roll(this.spin, v[0], v[2], r, dt);
  }

  readout(): ToyReadout {
    return { kind: this.kind, position: [...this.position], active: this.speed > 0.03 || this.position[1] > this.radius + 0.002 };
  }
}

// ---------- Yarn ----------

/**
 * A ball of yarn and its loose strand: 24 verlet points, the first tied to the ball's
 * surface. Any point can be pinned to a paw; dragging it pulls the strand taut and then
 * the ball, which rolls after it. The strand lies on the floor with friction and only
 * resists stretching, so it can bunch up in loops.
 */
export class Yarn implements Toy {
  readonly kind = 'yarn';
  readonly count = 24;
  /** Rest length of each of the 23 segments, metres. */
  readonly segment = 0.034;
  readonly ballRadius = 0.05;
  /** Radius of the strand, metres; the strand lies this high on the floor. */
  readonly thread = 0.0045;
  readonly position: V3;
  readonly velocity: V3 = [0, 0, 0];
  readonly spin: Quat = [0, 0, 0, 1];
  /** x, y, z per point, point 0 at the ball. */
  readonly points: Float64Array;
  readonly events: string[] = [];
  obstacles: readonly Obstacle[] = [];
  /** The pinned point and where its paw holds it, or null. */
  pinned: { index: number; at: V3 } | null = null;
  /** How far the strand is stretched from the ball to the pin, as a fraction of its length. */
  taut = 0;
  private readonly prev: Float64Array;

  /** `toward` is the heading (degrees from +z toward +x) along which the strand lies from the ball. */
  constructor(at: V3, toward = -90) {
    this.position = [at[0], this.ballRadius, at[2]];
    this.points = new Float64Array(this.count * 3);
    this.prev = new Float64Array(this.count * 3);
    const h = (toward * Math.PI) / 180;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    for (let i = 0; i < this.count; i++) {
      // A loose S on the floor, so it starts with some slack.
      const along = this.ballRadius + i * this.segment * 0.92;
      const side = 0.05 * Math.sin(i * 0.45);
      const x = at[0] + fx * along + fz * side;
      const z = at[2] + fz * along - fx * side;
      const c = clampFloor(x, z, 0.01);
      this.points.set([c[0], this.thread, c[1]], i * 3);
    }
    this.prev.set(this.points);
  }

  /** Point i as a new array. */
  point(i: number): V3 {
    return [this.points[i * 3], this.points[i * 3 + 1], this.points[i * 3 + 2]];
  }

  /** The free end of the strand. */
  get end(): V3 {
    return this.point(this.count - 1);
  }

  /** Holds a point (the free end unless told) at a paw. Call every step the paw holds it. */
  pin(at: V3, index = this.count - 1): void {
    if (!this.pinned || this.pinned.index !== index) emit(this.events, 'caught');
    this.pinned = { index, at: [at[0], Math.max(this.thread, at[1]), at[2]] };
  }

  unpin(): void {
    if (this.pinned) emit(this.events, 'released');
    this.pinned = null;
  }

  step(dt: number): void {
    const P = this.points;
    const Q = this.prev;
    const n = this.count;
    const pin = this.pinned;
    const air = Math.exp(-1.5 * dt);
    const grip = Math.exp(-10 * dt);

    // Verlet: carry each point on by its last motion, with gravity, floor friction and walls.
    for (let i = 1; i < n; i++) {
      const k = i * 3;
      if (pin && pin.index === i) {
        Q[k] = P[k];
        Q[k + 1] = P[k + 1];
        Q[k + 2] = P[k + 2];
        P[k] = pin.at[0];
        P[k + 1] = pin.at[1];
        P[k + 2] = pin.at[2];
        continue;
      }
      const onFloor = P[k + 1] <= this.thread + 1e-4;
      const f = onFloor ? grip : air;
      const vx = (P[k] - Q[k]) * f;
      const vy = (P[k + 1] - Q[k + 1]) * air;
      const vz = (P[k + 2] - Q[k + 2]) * f;
      Q[k] = P[k];
      Q[k + 1] = P[k + 1];
      Q[k + 2] = P[k + 2];
      P[k] += vx;
      P[k + 1] += vy - G * dt * dt;
      P[k + 2] += vz;
    }

    // The ball rolls on the floor with friction, shoved by cats and stopped by props.
    const b = this.position;
    const bv = this.velocity;
    const startX = b[0];
    const startZ = b[2];
    const s = Math.hypot(bv[0], bv[2]);
    if (s > 0) {
      const after = Math.max(0, s * Math.exp(-2.5 * dt) - 0.1 * dt);
      bv[0] *= after / s;
      bv[2] *= after / s;
    }
    b[0] += bv[0] * dt;
    b[2] += bv[2] * dt;
    collide(b, bv, this.ballRadius, this.obstacles, 0.4, dt);
    wallBounce(b, bv, this.ballRadius, 0.4);

    // Constraints. Point 0 sits on the ball's surface facing point 1 and is heavier than
    // the strand, so a pull moves it a little each pass; the ball follows it after.
    const anchor = this.anchor();
    P[0] = anchor[0];
    P[1] = anchor[1];
    P[2] = anchor[2];
    const inv = (i: number) => (pin && pin.index === i ? 0 : i === 0 ? 0.3 : 1);
    for (let it = 0; it < 12; it++) {
      for (let i = 0; i < n - 1; i++) {
        const a = i * 3;
        const c = a + 3;
        const dx = P[c] - P[a];
        const dy = P[c + 1] - P[a + 1];
        const dz = P[c + 2] - P[a + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-9) continue;
        // Full correction when stretched; a tenth when bunched, as a little stiffness.
        const err = d - this.segment;
        const stiff = err > 0 ? 1 : 0.1;
        const wa = inv(i);
        const wc = inv(i + 1);
        const w = wa + wc;
        if (w === 0) continue;
        const m = (stiff * err) / (d * w);
        P[a] += dx * m * wa;
        P[a + 1] += dy * m * wa;
        P[a + 2] += dz * m * wa;
        P[c] -= dx * m * wc;
        P[c + 1] -= dy * m * wc;
        P[c + 2] -= dz * m * wc;
      }
      for (let i = 1; i < n; i++) {
        const k = i * 3;
        if (P[k + 1] < this.thread) P[k + 1] = this.thread;
        const c = clampFloor(P[k], P[k + 2], this.thread);
        P[k] = c[0];
        P[k + 2] = c[1];
      }
    }

    // Whatever the strand did to point 0 drags the ball along the floor.
    const mx = P[0] - anchor[0];
    const mz = P[2] - anchor[2];
    if (mx !== 0 || mz !== 0) {
      b[0] += mx;
      b[2] += mz;
      bv[0] += (mx / dt) * 0.6;
      bv[2] += (mz / dt) * 0.6;
      wallBounce(b, bv, this.ballRadius, 0.4);
    }
    roll(this.spin, (b[0] - startX) / dt, (b[2] - startZ) / dt, this.ballRadius, dt);
    const fixed = this.anchor();
    P[0] = fixed[0];
    P[1] = fixed[1];
    P[2] = fixed[2];

    if (pin) {
      const k = pin.index * 3;
      const straight = Math.hypot(P[k] - P[0], P[k + 2] - P[2]);
      this.taut = straight / (pin.index * this.segment);
    } else this.taut = 0;
  }

  /** Where the strand leaves the ball: its surface on the side facing point 1, low down. */
  private anchor(): V3 {
    const b = this.position;
    const dx = this.points[3] - b[0];
    const dz = this.points[5] - b[2];
    const d = Math.hypot(dx, dz) || 1;
    const r = this.ballRadius * 0.92;
    return [b[0] + (dx / d) * r, this.ballRadius * 0.45, b[2] + (dz / d) * r];
  }

  readout(): ToyReadout {
    const moving = Math.hypot(this.velocity[0], this.velocity[2]) > 0.02;
    return { kind: this.kind, position: [...this.position], active: moving || this.pinned !== null };
  }
}

/** A floor point (x, z) pulled inside the play area, `inset` from the walls. */
function clampFloor(x: number, z: number, inset: number): V2 {
  return [clamp(x, -PLAY_AREA.x + inset, PLAY_AREA.x - inset), clamp(z, -PLAY_AREA.z + inset, PLAY_AREA.z - inset)];
}

// ---------- Laser dot ----------

/**
 * A laser pointer's dot on the floor. Left to itself it runs a Lissajous figure over the
 * play area with a warped clock, so it dawdles and then darts, which is what makes a cat
 * chase it. Aimed at a cursor point, it follows with a hand's lag and tremor.
 */
export class LaserDot implements Toy {
  readonly kind = 'laser';
  readonly position: V3 = [0, 0, 0];
  readonly events: string[] = [];
  on = false;
  mode: 'path' | 'cursor' = 'path';
  /** Metres per second the dot moved in the last step. */
  speed = 0;
  /** Lissajous half extents, x and z, metres. */
  readonly extent: V2 = [1.15, 0.72];
  private readonly phase: number;
  private time = 0;
  private s = 0;
  private cursor: V3 | null = null;

  constructor(rng: Rng) {
    this.phase = rng.next();
    this.s = rng.range(0, 20);
    const start = this.pathPoint();
    this.position[0] = start[0];
    this.position[2] = start[1];
  }

  turnOn(mode: 'path' | 'cursor' = this.mode): void {
    if (!this.on) emit(this.events, 'on');
    this.on = true;
    this.mode = mode;
  }

  turnOff(): void {
    if (this.on) emit(this.events, 'off');
    this.on = false;
    this.speed = 0;
  }

  /** Follow a point on the floor; null goes back to the figure. */
  aim(cursor: V3 | null): void {
    this.cursor = cursor ? [cursor[0], 0, cursor[2]] : null;
    this.mode = cursor ? 'cursor' : 'path';
  }

  step(dt: number): void {
    this.time += dt;
    if (!this.on) return;
    const before: V2 = [this.position[0], this.position[2]];
    if (this.mode === 'cursor' && this.cursor) {
      const t = this.time;
      // A hand holding a pointer is never quite still: two small incommensurate shakes.
      const shake = 0.004;
      const tx = this.cursor[0] + shake * (Math.sin(t * 23.1) + 0.6 * Math.sin(t * 37.7));
      const tz = this.cursor[2] + shake * (Math.sin(t * 19.3 + 1) + 0.6 * Math.sin(t * 41.9));
      const c = clampFloor(tx, tz, 0.03);
      this.position[0] = damp(this.position[0], c[0], 6, dt);
      this.position[2] = damp(this.position[2], c[1], 6, dt);
    } else {
      // The clock dawdles, then picks up. The peak stays under a walk, so the cats can follow it.
      const surge = Math.max(0, Math.sin(TAU * (0.12 * this.time + this.phase)));
      this.s += dt * (0.16 + 0.55 * surge);
      const p = this.pathPoint();
      this.position[0] = p[0];
      this.position[2] = p[1];
    }
    this.position[1] = 0;
    this.speed = Math.hypot(this.position[0] - before[0], this.position[2] - before[1]) / dt;
  }

  private pathPoint(): V2 {
    const [ax, az] = this.extent;
    return clampFloor(ax * Math.sin(TAU * 0.13 * this.s + 1.1), az * Math.sin(TAU * 0.21 * this.s), 0.03);
  }

  readout(): ToyReadout {
    return { kind: this.kind, position: [...this.position], active: this.on };
  }
}

// ---------- Ledge and cup ----------

/** A low plinth near the back wall that the cup stands on. Its centre is on the floor. */
export class Ledge implements Toy {
  readonly kind = 'ledge';
  readonly position: V3;
  /** Width (x), height (y), depth (z), metres. */
  readonly size: V3;
  readonly events: string[] = [];

  constructor(at: V3, size: V3 = [0.36, 0.26, 0.24]) {
    this.position = [at[0], 0, at[2]];
    this.size = size;
  }

  get top(): number {
    return this.size[1];
  }

  /** Whether a floor point is over the top, `inset` in from its edges. */
  contains(x: number, z: number, inset = 0): boolean {
    return Math.abs(x - this.position[0]) <= this.size[0] / 2 - inset && Math.abs(z - this.position[2]) <= this.size[2] / 2 - inset;
  }

  obstacle(): Obstacle {
    return { id: 'ledge', x: this.position[0], z: this.position[2], r: Math.hypot(this.size[0], this.size[2]) * 0.45 };
  }

  step(): void {}

  readout(): ToyReadout {
    return { kind: this.kind, position: [...this.position], active: false };
  }
}

export type CupState = 'resting' | 'sliding' | 'falling' | 'down' | 'respawn';

/**
 * A mug on the ledge. A paw knocks it into a slide; past the edge it tips and falls, lands
 * on its side and rolls a little, lies there for a moment and then reappears on the ledge.
 * `fallen` counts the trips to the floor. `position` is the centre of its base.
 */
export class Cup implements Toy {
  readonly kind = 'cup';
  readonly radius = 0.034;
  readonly height = 0.088;
  readonly position: V3;
  readonly velocity: V3 = [0, 0, 0];
  readonly events: string[] = [];
  readonly home: V3;
  state: CupState = 'resting';
  /** Tip angle in radians toward `dir`, the fall heading in radians (from +z toward +x). */
  tilt = 0;
  dir = 0;
  /** Turn about its own axis from rolling on its side, radians. */
  spin = 0;
  /** 0..1 while it reappears on the ledge. */
  scale = 1;
  fallen = 0;
  private tiltRate = 0;
  private timer = 0;

  constructor(readonly ledge: Ledge, spot: V2 = [0.1, 0]) {
    this.home = [ledge.position[0] + spot[0], ledge.top, ledge.position[2] + spot[1]];
    this.position = [...this.home];
  }

  get onLedge(): boolean {
    return this.state === 'resting' || this.state === 'sliding' || this.state === 'respawn';
  }

  /** A paw push along `dir` (x, z on the floor). Only works while the cup stands on the ledge. */
  knock(dir: V2, strength = 0.45): boolean {
    if (this.state !== 'resting' && this.state !== 'sliding') return false;
    const d = Math.hypot(dir[0], dir[1]) || 1;
    this.velocity[0] += (dir[0] / d) * strength;
    this.velocity[2] += (dir[1] / d) * strength;
    this.state = 'sliding';
    emit(this.events, 'knocked');
    return true;
  }

  step(dt: number): void {
    const p = this.position;
    const v = this.velocity;
    switch (this.state) {
      case 'resting':
        return;
      case 'sliding': {
        // Ceramic on a painted top: about 1.4 m/s² of friction.
        const s = Math.hypot(v[0], v[2]);
        const after = Math.max(0, s - 1.4 * dt);
        if (s > 0) {
          v[0] *= after / s;
          v[2] *= after / s;
        }
        p[0] += v[0] * dt;
        p[2] += v[2] * dt;
        if (!this.ledge.contains(p[0], p[2])) {
          this.state = 'falling';
          this.dir = Math.atan2(v[0], v[2]);
          this.tiltRate = 7;
          v[1] = 0;
          emit(this.events, 'fell');
        } else if (after === 0) this.state = 'resting';
        return;
      }
      case 'falling': {
        v[1] -= G * dt;
        p[0] += v[0] * dt;
        p[1] += v[1] * dt;
        p[2] += v[2] * dt;
        this.tilt = Math.min(Math.PI / 2, this.tilt + this.tiltRate * dt);
        // Lying on its side the axis is one radius up, and so is the base centre.
        if (p[1] <= this.radius) {
          p[1] = this.radius;
          this.tilt = Math.PI / 2;
          v[0] *= 0.35;
          v[2] *= 0.35;
          v[1] = 0;
          this.state = 'down';
          this.timer = 0;
          this.fallen++;
          emit(this.events, 'landed');
        }
        this.keepIn();
        return;
      }
      case 'down': {
        const s = Math.hypot(v[0], v[2]);
        const after = Math.max(0, s * Math.exp(-3 * dt) - 0.2 * dt);
        if (s > 0) {
          v[0] *= after / s;
          v[2] *= after / s;
        }
        p[0] += v[0] * dt;
        p[2] += v[2] * dt;
        this.spin += (after * dt) / this.radius;
        this.keepIn();
        this.timer += dt;
        // Long enough on the floor to be seen there, then back on the ledge.
        if (this.timer > 5) {
          this.state = 'respawn';
          this.timer = 0;
          p[0] = this.home[0];
          p[1] = this.home[1];
          p[2] = this.home[2];
          v[0] = v[1] = v[2] = 0;
          this.tilt = 0;
          this.spin = 0;
          this.scale = 0;
          emit(this.events, 'respawn');
        }
        return;
      }
      case 'respawn':
        this.timer += dt;
        this.scale = ease(this.timer, 0, 0.6);
        if (this.timer >= 0.6) {
          this.scale = 1;
          this.state = 'resting';
        }
        return;
    }
  }

  private keepIn(): void {
    const c = clampFloor(this.position[0], this.position[2], this.radius);
    this.position[0] = c[0];
    this.position[2] = c[1];
  }

  readout(): ToyReadout {
    return { kind: this.kind, position: [...this.position], active: this.state !== 'resting' };
  }
}

// ---------- Box, bed, cushion ----------

/** A cardboard box, open at the top. Cats get in; `entered` counts how often. */
export class Box implements Toy {
  readonly kind = 'box';
  readonly position: V3;
  /** Width (x), height (y), depth (z) in metres, before `yaw`. */
  readonly size: V3;
  /** Degrees about y. */
  readonly yaw: number;
  readonly events: string[] = [];
  occupant: string | null = null;
  entered = 0;

  // Wide enough for the squashed tabby with its whiskers folded back.
  constructor(at: V3, yaw = 0, size: V3 = [0.5, 0.22, 0.32]) {
    this.position = [at[0], 0, at[2]];
    this.yaw = yaw;
    this.size = size;
  }

  /** Whether a floor point is inside the walls, `inset` in from them. */
  contains(p: V3, inset = 0): boolean {
    const [lx, lz] = toLocal(p, this.position, this.yaw);
    return Math.abs(lx) <= this.size[0] / 2 - inset && Math.abs(lz) <= this.size[2] / 2 - inset;
  }

  enter(id: string): void {
    if (this.occupant === id) return;
    this.occupant = id;
    this.entered++;
    emit(this.events, 'entered');
  }

  leave(id: string): void {
    if (this.occupant !== id) return;
    this.occupant = null;
    emit(this.events, 'left');
  }

  obstacle(): Obstacle {
    return { id: 'box', x: this.position[0], z: this.position[2], r: Math.hypot(this.size[0], this.size[2]) * 0.42 };
  }

  step(): void {}

  readout(): ToyReadout {
    return { kind: this.kind, position: [...this.position], active: this.occupant !== null };
  }
}

/** A round, padded cat bed. It is there to be passed over for the box. */
export class Bed implements Toy {
  readonly kind = 'bed';
  readonly position: V3;
  readonly radius: number;
  readonly height: number;
  readonly events: string[] = [];
  occupant: string | null = null;

  constructor(at: V3, radius = 0.28, height = 0.12) {
    this.position = [at[0], 0, at[2]];
    this.radius = radius;
    this.height = height;
  }

  contains(p: V3, inset = 0): boolean {
    return Math.hypot(p[0] - this.position[0], p[2] - this.position[2]) <= this.radius - inset;
  }

  enter(id: string): void {
    if (this.occupant === id) return;
    this.occupant = id;
    emit(this.events, 'entered');
  }

  leave(id: string): void {
    if (this.occupant !== id) return;
    this.occupant = null;
    emit(this.events, 'left');
  }

  obstacle(): Obstacle {
    return { id: 'bed', x: this.position[0], z: this.position[2], r: this.radius };
  }

  step(): void {}

  readout(): ToyReadout {
    return { kind: this.kind, position: [...this.position], active: this.occupant !== null };
  }
}

/** A square cushion that dents under kneading paws and springs back. */
export class Cushion implements Toy {
  readonly kind = 'cushion';
  readonly position: V3;
  /** Width (x), height (y), depth (z), metres. */
  readonly size: V3;
  readonly events: string[] = [];
  /** How far it is pressed in, 0..1. */
  dent = 0;
  presses = 0;
  private push = 0;
  private pushed = false;

  constructor(at: V3, size: V3 = [0.42, 0.085, 0.42]) {
    this.position = [at[0], 0, at[2]];
    this.size = size;
  }

  contains(p: V3, inset = 0): boolean {
    return Math.abs(p[0] - this.position[0]) <= this.size[0] / 2 - inset && Math.abs(p[2] - this.position[2]) <= this.size[2] / 2 - inset;
  }

  /** A paw pressing down this step, 0..1. Call every step it presses. */
  press(amount = 1): void {
    this.push = Math.max(this.push, clamp(amount, 0, 1));
  }

  step(dt: number): void {
    // Foam gives quickly and recovers more slowly.
    this.dent = damp(this.dent, this.push, this.push > this.dent ? 14 : 4, dt);
    const down = this.push > 0.3;
    if (down && !this.pushed) {
      this.presses++;
      emit(this.events, 'press');
    }
    this.pushed = down;
    this.push = 0;
  }

  readout(): ToyReadout {
    return { kind: this.kind, position: [...this.position], active: this.dent > 0.05 };
  }
}

// ---------- Keyboard ----------

/** One key: its character and its centre and size on the keyboard, metres, keyboard axes. */
export interface KeyCap {
  char: string;
  x: number;
  z: number;
  w: number;
  d: number;
}

/** Key pitch, metres. A desk keyboard's is 19 mm; this one is a little larger to read at studio distance. */
const PITCH = 0.0265;

function keyLayout(): KeyCap[] {
  const rows = ['1234567890-=', 'qwertyuiop[]', "asdfghjkl;'", 'zxcvbnm,./'];
  const out: KeyCap[] = [];
  rows.forEach((row, r) => {
    const z = -0.05 + r * PITCH;
    const x0 = -0.159 + r * 0.013;
    for (let i = 0; i < row.length; i++) out.push({ char: row[i], x: x0 + i * PITCH, z, w: PITCH * 0.86, d: PITCH * 0.86 });
  });
  out.push({ char: ' ', x: 0, z: -0.05 + 4 * PITCH, w: PITCH * 5.6, d: PITCH * 0.86 });
  return out;
}

/**
 * A keyboard on the floor. A paw that lands on a key types it; a paw left on a key repeats
 * it after half a second, ten times a second, as a real keyboard does. `typed` keeps the
 * last 48 characters and `keys` counts every press.
 */
export class Keyboard implements Toy {
  readonly kind = 'keyboard';
  readonly position: V3;
  readonly yaw: number;
  /** Width (x), height (y), depth (z), metres. */
  readonly size: V3 = [0.36, 0.024, 0.15];
  readonly layout: KeyCap[] = keyLayout();
  /** Seconds each key has been held down; 0 while up. */
  readonly held: Float64Array;
  readonly events: string[] = [];
  typed = '';
  keys = 0;
  private readonly touched: Uint8Array;
  private readonly repeats: Uint16Array;

  constructor(at: V3, yaw = 0) {
    this.position = [at[0], 0, at[2]];
    this.yaw = yaw;
    this.held = new Float64Array(this.layout.length);
    this.touched = new Uint8Array(this.layout.length);
    this.repeats = new Uint16Array(this.layout.length);
  }

  /** The key under a floor point, or -1. */
  keyAt(p: V3): number {
    const [lx, lz] = toLocal(p, this.position, this.yaw);
    for (let i = 0; i < this.layout.length; i++) {
      const k = this.layout[i];
      if (Math.abs(lx - k.x) <= PITCH * (k.char === ' ' ? 2.8 : 0.5) && Math.abs(lz - k.z) <= PITCH * 0.5) return i;
    }
    return -1;
  }

  contains(p: V3, inset = 0): boolean {
    const [lx, lz] = toLocal(p, this.position, this.yaw);
    return Math.abs(lx) <= this.size[0] / 2 - inset && Math.abs(lz) <= this.size[2] / 2 - inset;
  }

  /** The paws on the floor this step, in world coordinates. Call every step a cat stands on it. */
  stepOn(paws: readonly V3[]): void {
    for (const p of paws) {
      const i = this.keyAt(p);
      if (i >= 0) this.touched[i] = 1;
    }
  }

  step(dt: number): void {
    for (let i = 0; i < this.layout.length; i++) {
      if (!this.touched[i]) {
        this.held[i] = 0;
        this.repeats[i] = 0;
        continue;
      }
      if (this.held[i] === 0) this.type(i);
      this.held[i] += dt;
      const due = Math.floor(Math.max(0, this.held[i] - 0.5) * 10);
      while (this.repeats[i] < due) {
        this.repeats[i]++;
        this.type(i);
      }
      this.touched[i] = 0;
    }
  }

  private type(i: number): void {
    this.typed = (this.typed + this.layout[i].char).slice(-48);
    this.keys++;
    emit(this.events, 'key');
  }

  readout(): ToyReadout {
    let down = false;
    for (let i = 0; i < this.held.length; i++) if (this.held[i] > 0) down = true;
    return { kind: this.kind, position: [...this.position], active: down };
  }
}

/** A floor point in a prop's own axes: x across it, z front to back, after its yaw in degrees. */
function toLocal(p: V3, origin: V3, yaw: number): V2 {
  const dx = p[0] - origin[0];
  const dz = p[2] - origin[2];
  const h = (-yaw * Math.PI) / 180;
  const c = Math.cos(h);
  const s = Math.sin(h);
  return [dx * c + dz * s, -dx * s + dz * c];
}

// ---------- Bird ----------

export type BirdState = 'perched' | 'hopping' | 'leaving' | 'away' | 'arriving';

/**
 * A small robot bird on a perch on the back wall, for the chatter act. It hops along the
 * perch, looks about and pecks. A cat chattering at it makes it nervous (`alarm`), and
 * after about 2.5 s of that it flies off, stays away for 6 to 10 s and comes back.
 * `position` is between its feet; `perch` gives the two ends of the bar.
 */
export class Bird implements Toy {
  readonly kind = 'bird';
  readonly position: V3;
  readonly perch: [V3, V3];
  readonly events: string[] = [];
  state: BirdState = 'perched';
  /** +1 faces along +x, -1 along -x. */
  facing: 1 | -1 = 1;
  /** Degrees the head is turned from the facing direction, + toward the room. */
  headYaw = 0;
  /** Wing beat 0..1 (0 folded) and how far the head is down pecking, 0..1. */
  flap = 0;
  peck = 0;
  nervous = 0;
  private readonly rng: Rng;
  private u = 0.5;
  private from = 0.5;
  private to = 0.5;
  private timer = 1;
  private t = 0;
  private alarmed = false;
  private look = 0;

  constructor(rng: Rng, perch: [V3, V3] = [[0.35, 1.02, -1.53], [1.05, 1.02, -1.53]]) {
    this.rng = rng;
    this.perch = perch;
    this.u = rng.range(0.2, 0.8);
    this.timer = rng.range(1, 3);
    this.position = this.at(this.u);
  }

  get present(): boolean {
    return this.state !== 'away';
  }

  /** A cat chattering at the bird this step. */
  alarm(): void {
    this.alarmed = true;
  }

  private at(u: number): V3 {
    const [a, b] = this.perch;
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  }

  private set(p: V3): void {
    this.position[0] = p[0];
    this.position[1] = p[1];
    this.position[2] = p[2];
  }

  step(dt: number): void {
    this.t += dt;
    this.timer -= dt;
    this.nervous = this.alarmed ? this.nervous + dt : Math.max(0, this.nervous - 0.3 * dt);
    this.alarmed = false;
    const flight = (k: number, away: number): V3 => {
      const p = this.at(this.u);
      // Off and up to the side it faces, a little out from the wall.
      return [p[0] + this.facing * 0.9 * k, p[1] + 0.55 * k + 0.05 * Math.sin(Math.PI * k), p[2] + 0.2 * k * away];
    };
    switch (this.state) {
      case 'perched': {
        this.flap = damp(this.flap, 0, 4, dt);
        // Glances about, now and then toward the room, and pecks at the perch.
        if (this.rng.chance(dt * 0.8)) this.look = this.rng.pick([-40, 0, 25, 60, 70]);
        this.headYaw = damp(this.headYaw, this.look, 3.5, dt);
        this.peck = this.look === 0 ? Math.max(0, Math.sin(this.t * 4)) ** 4 : damp(this.peck, 0, 4, dt);
        if (this.nervous > 2.5) {
          this.state = 'leaving';
          this.timer = 1.2;
          emit(this.events, 'left');
        } else if (this.timer <= 0) {
          this.from = this.u;
          this.to = clamp(this.u + this.rng.range(-0.35, 0.35), 0.08, 0.92);
          this.facing = this.to >= this.from ? 1 : -1;
          this.state = 'hopping';
          this.timer = 0.7;
        }
        return;
      }
      case 'hopping': {
        const k = 1 - clamp(this.timer / 0.7, 0, 1);
        this.u = this.from + (this.to - this.from) * ease(k, 0, 1);
        const p = this.at(this.u);
        p[1] += 0.025 * Math.sin(Math.PI * k);
        this.set(p);
        this.flap = Math.sin(Math.PI * k);
        if (this.timer <= 0) {
          this.u = this.to;
          this.set(this.at(this.u));
          this.state = 'perched';
          this.timer = this.rng.range(1.5, 4);
        }
        return;
      }
      case 'leaving': {
        const k = 1 - clamp(this.timer / 1.2, 0, 1);
        this.set(flight(ease(k, 0, 1), 1));
        this.flap = 0.5 + 0.5 * Math.sin(this.t * 18);
        if (this.timer <= 0) {
          this.state = 'away';
          this.timer = this.rng.range(6, 10);
          this.nervous = 0;
        }
        return;
      }
      case 'away':
        if (this.timer <= 0) {
          this.u = this.rng.range(0.15, 0.85);
          this.facing = this.rng.chance(0.5) ? 1 : -1;
          this.state = 'arriving';
          this.timer = 1;
        }
        return;
      case 'arriving': {
        const k = clamp(this.timer / 1, 0, 1);
        this.set(flight(ease(k, 0, 1), 1));
        this.flap = 0.5 + 0.5 * Math.sin(this.t * 18);
        if (this.timer <= 0) {
          this.set(this.at(this.u));
          this.state = 'perched';
          this.timer = this.rng.range(1.5, 4);
          emit(this.events, 'arrived');
        }
        return;
      }
    }
  }

  readout(): ToyReadout {
    return { kind: this.kind, position: [...this.position], active: this.present };
  }
}

// ---------- All of them ----------

/** Where everything stands. Floor points are metres in the 3 x 2 m play area. */
export interface ToyLayout {
  ball: V3;
  yarn: V3;
  ledge: V3;
  /** The cup's spot on the ledge top, from the ledge centre (x, z). */
  cup: V2;
  box: V3;
  boxYaw: number;
  bed: V3;
  keyboard: V3;
  keyboardYaw: number;
  cushion: V3;
  /** The two ends of the bird's perch on the back wall. */
  perch: [V3, V3];
}

/**
 * The default set: the box, keyboard, ledge and bed along the back, the cushion at the
 * front left, and the ball and yarn in the open middle where the cats play.
 */
export const TOY_LAYOUT: ToyLayout = {
  ball: [0.25, 0, 0.38],
  yarn: [0.9, 0, 0.5],
  ledge: [0.5, 0, -0.78],
  cup: [0.11, 0.02],
  box: [-1.0, 0, -0.55],
  boxYaw: 12,
  bed: [1.1, 0, -0.52],
  keyboard: [-0.32, 0, -0.74],
  keyboardYaw: -6,
  cushion: [-1.0, 0, 0.5],
  perch: [
    [0.35, 1.02, -1.53],
    [1.05, 1.02, -1.53],
  ],
};

export interface ToyEvent {
  kind: ToyKind;
  name: string;
}

export class Toys {
  readonly ball: Ball;
  readonly yarn: Yarn;
  readonly laser: LaserDot;
  readonly ledge: Ledge;
  readonly cup: Cup;
  readonly box: Box;
  readonly bed: Bed;
  readonly keyboard: Keyboard;
  readonly cushion: Cushion;
  readonly bird: Bird;
  readonly list: readonly Toy[];
  readonly layout: ToyLayout;
  time = 0;
  private readonly statics: Obstacle[];

  /** `rng` is forked per toy, so a toy that draws more numbers does not shift another's. */
  constructor(rng: Rng, layout: Partial<ToyLayout> = {}) {
    const l = (this.layout = { ...TOY_LAYOUT, ...layout });
    this.ball = new Ball(l.ball);
    this.yarn = new Yarn(l.yarn);
    this.laser = new LaserDot(rng.fork('laser'));
    this.ledge = new Ledge(l.ledge);
    this.cup = new Cup(this.ledge, l.cup);
    this.box = new Box(l.box, l.boxYaw);
    this.bed = new Bed(l.bed);
    this.keyboard = new Keyboard(l.keyboard, l.keyboardYaw);
    this.cushion = new Cushion(l.cushion);
    this.bird = new Bird(rng.fork('bird'), l.perch);
    this.list = [this.ball, this.yarn, this.laser, this.ledge, this.cup, this.box, this.bed, this.keyboard, this.cushion, this.bird];
    this.statics = [this.box.obstacle(), this.bed.obstacle(), this.ledge.obstacle()];
  }

  /** The props cats walk around: box, bed and ledge. The keyboard and cushion are walked on. */
  obstacles(): Obstacle[] {
    return this.statics.map((o) => ({ ...o }));
  }

  /** `movers` are the cats this step, as circles: they shove the ball and the yarn. */
  step(dt: number, movers: readonly Obstacle[] = []): void {
    if (!(dt > 0)) return;
    this.time += dt;
    const around = movers.length ? [...this.statics, ...movers] : this.statics;
    this.ball.obstacles = around;
    this.yarn.obstacles = around;
    for (const toy of this.list) toy.step(dt);
  }

  readout(): ToyReadout[] {
    return this.list.map((t) => t.readout());
  }

  /** Everything that happened since the last drain, in toy order, and empties the lists. */
  drain(): ToyEvent[] {
    const out: ToyEvent[] = [];
    for (const toy of this.list) {
      for (const name of toy.events) out.push({ kind: toy.kind, name });
      toy.events.length = 0;
    }
    return out;
  }

  get<K extends ToyKind>(kind: K): Toy {
    return this.list.find((t) => t.kind === kind)!;
  }
}
