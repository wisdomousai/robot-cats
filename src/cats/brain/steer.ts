import { clamp, ease } from '../math/ease';
import { Spring } from '../math/spring';
import type { LegName, RngLike, V3 } from '../types';

/**
 * Floor locomotion for one cat, as a plain object with no scene behind it. The world
 * gives it a goal, a hurry and the circles it must keep out of; every step it turns the
 * heading toward where it wants to go, speeds up or brakes, moves along the heading
 * (cats do not strafe), and advances a gait phase from the distance covered. The cat
 * pipeline reads the phase and the gait blend to swing the legs, and the console reads
 * the paw contacts.
 *
 * Heading is in degrees, measured from +z toward +x, so it is the cat root's y rotation
 * and 0 faces the front of the studio. Everything here is a function of the inputs and
 * dt; the only randomness is the optional Rng that picks a detour side.
 */

/** Half extents of the play area in metres: 3 m along x by 2 m along z, centred on the origin. */
export const PLAY_AREA = { x: 1.5, z: 1 } as const;

export type Gait = 'still' | 'walk' | 'trot' | 'run';

/** A circle on the floor that a cat keeps out of: another cat or a prop. */
export interface Obstacle {
  id: string;
  x: number;
  z: number;
  r: number;
  /**
   * A moving obstacle (another cat). Overlap with it is resolved half by each side, since
   * the other one moves out too.
   */
  soft?: boolean;
}

export interface SteerOptions {
  /** Identifies this cat in the obstacle list, so it skips itself. */
  id?: string;
  /** Radius of the cat's footprint circle, metres. */
  radius?: number;
  /** Top speed at hurry 0, 0.5, 1 and 1.5, metres per second. */
  speeds?: [walk: number, trot: number, run: number, sprint: number];
  /** Acceleration and braking limits, m/s². */
  accel?: number;
  brake?: number;
  /** Heading spring natural frequency (Hz) and damping. */
  turn?: { f: number; zeta: number };
  /** Within this distance the goal counts as reached, metres. */
  arrive?: number;
  /** Width of the band along each wall where the soft limit pushes inward, metres. */
  margin?: number;
  /** How far ahead the avoidance looks, in seconds of travel at the current speed. */
  look?: number;
  /** Half extents of the area to stay in. */
  bounds?: { x: number; z: number };
  /** Picks the side of a detour when stuck; without one the sides alternate. */
  rng?: RngLike;
}

/** What the console and the cat readout take from the steering. */
export interface SteerReadout {
  position: V3;
  heading: number;
  speed: number;
  /** The gait cycle, 0..1. */
  gaitPhase: number;
  gait: Gait;
  paws: Record<LegName, boolean>;
  /** Seconds without progress toward the goal. */
  stuck: number;
}

/** How much of each gait the legs show; the three sum to 1 while moving. */
export interface GaitBlend {
  walk: number;
  trot: number;
  run: number;
}

const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;

/** Metres covered per full leg cycle in each gait. A longer stride at speed keeps the legs from blurring. */
const STRIDE: GaitBlend = { walk: 0.26, trot: 0.42, run: 0.78 };
/** Fraction of the cycle each paw is on the floor. Walks keep three paws down most of the time. */
const DUTY: GaitBlend = { walk: 0.68, trot: 0.5, run: 0.4 };
/**
 * Leg phase offsets in radians, the same as the trot and gallop in rig/moves.ts: a paw is
 * on the floor while its leg sweeps back, cos(phase + offset) > 0.
 */
const DIAGONAL: Record<LegName, number> = { FL: 0, BR: 0, FR: Math.PI, BL: Math.PI };
const BOUND: Record<LegName, number> = { FL: 0, FR: 0, BL: Math.PI, BR: Math.PI };
/** Turning on the spot still moves the feet: each degree of yaw counts as this many metres. */
const TURN_STEP = 0.12 * DEG;
/** Below this foot speed (m/s) the cat counts as standing. */
const STILL = 0.03;

/** An angle in degrees brought into [-180, 180). */
export function wrapDeg(a: number): number {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

/** The heading (degrees, from +z toward +x) that points from one floor point to another. */
export function headingTo(from: V3, to: V3): number {
  return Math.atan2(to[0] - from[0], to[2] - from[2]) / DEG;
}

/** A floor point pulled inside the play area, `inset` metres from every wall. */
export function clampToFloor(p: V3, inset = 0, bounds: { x: number; z: number } = PLAY_AREA): V3 {
  return [clamp(p[0], -bounds.x + inset, bounds.x - inset), p[1], clamp(p[2], -bounds.z + inset, bounds.z - inset)];
}

/** The gait mix at a foot speed: walk below about 0.3 m/s, trot to about 0.7, then run. */
export function gaitBlend(speed: number): GaitBlend {
  const run = ease(speed, 0.62, 0.95);
  const trot = ease(speed, 0.26, 0.4) * (1 - run);
  return { walk: 1 - trot - run, trot, run };
}

/**
 * Which paws are on the floor at a point of the gait cycle. Walk and trot use the
 * diagonal pairs (as the trot pose swings them), the run uses front and back pairs (as
 * the gallop pose does), and the duty factor blends with the mix: a slow walk has three
 * or four paws down, a run has flights with none.
 */
export function pawContacts(phase: number, blend: GaitBlend): Record<LegName, boolean> {
  const duty = blend.walk * DUTY.walk + blend.trot * DUTY.trot + blend.run * DUTY.run;
  const offsets = blend.run > 0.5 ? BOUND : DIAGONAL;
  const half = duty * Math.PI;
  const down = (leg: LegName) => {
    const u = (((phase + offsets[leg] + half) % TAU) + TAU) % TAU;
    return u < 2 * half;
  };
  return { FL: down('FL'), FR: down('FR'), BL: down('BL'), BR: down('BR') };
}

const ALL_DOWN: Record<LegName, boolean> = { FL: true, FR: true, BL: true, BR: true };

export class Steer {
  readonly id: string;
  readonly radius: number;
  x: number;
  z: number;
  /** Forward speed along the heading, m/s. Never negative: to go back, a cat turns round. */
  speed = 0;
  /** Heading change rate, degrees per second. */
  yawRate = 0;
  /** Gait cycle in radians, kept in [0, 2π). */
  phase = 0;
  gait: Gait = 'still';
  blend: GaitBlend = { walk: 0, trot: 0, run: 0 };
  /** How hard the legs swing, 0..1: rises from standing to a full stride over the first 0.3 m/s. */
  amount = 0;
  paws: Record<LegName, boolean> = { ...ALL_DOWN };

  /** Where it is going, on the floor, or null to stand. */
  goal: V3 | null = null;
  /** 0 walks, 0.5 trots, 1 runs, 1.5 sprints. */
  hurry = 0;
  /** Heading to turn to while standing, or null to keep the current one. */
  facing: number | null = null;
  /** An obstacle id the cat may walk into: the box it is climbing into, the bed it lies in. */
  ignore: string | null = null;
  /**
   * True when the goal is a waypoint to run through rather than a spot to stop on: the cat
   * keeps its top speed up to it instead of braking, so a run of waypoints stays a run.
   */
  through = false;
  /** True from the step the goal is reached until a new goal is given. */
  arrived = false;
  /** Seconds without progress toward the goal. */
  stuck = 0;
  /** True once the goal was given up after several detours. */
  blocked = false;
  /** A side step taken to get unstuck, or null. */
  detour: V3 | null = null;

  private readonly speeds: [number, number, number, number];
  private readonly accel: number;
  private readonly brake: number;
  private readonly arriveAt: number;
  private readonly margin: number;
  private readonly look: number;
  private readonly bounds: { x: number; z: number };
  private readonly rng: RngLike | null;
  private readonly turn: Spring;
  private arriveRadius: number;
  private lastDist = Infinity;
  private detours = 0;
  private detourT = 0;
  private side = 1;

  constructor(opts: SteerOptions & { at?: V3; heading?: number } = {}) {
    this.id = opts.id ?? 'cat';
    this.radius = opts.radius ?? 0.17;
    // A room only 3 m across: these stay a stroll, a jog and a canter, and they take a
    // moment to get there. The old tops (up to 2.3 m/s) crossed the floor in a lunge.
    this.speeds = opts.speeds ?? [0.2, 0.44, 0.92, 1.4];
    this.accel = opts.accel ?? 0.85;
    this.brake = opts.brake ?? 1.35;
    this.arriveAt = this.arriveRadius = opts.arrive ?? 0.06;
    this.margin = opts.margin ?? 0.3;
    this.look = opts.look ?? 0.8;
    this.bounds = opts.bounds ?? PLAY_AREA;
    this.rng = opts.rng ?? null;
    // Critically damped and slow, so a new heading is a turn, not a snap.
    const turn = opts.turn ?? { f: 0.72, zeta: 1 };
    // r = 0: the heading eases into a new direction instead of jumping toward it.
    this.turn = new Spring(turn.f, turn.zeta, 0, opts.heading ?? 0);
    const at = clampToFloor(opts.at ?? [0, 0, 0], this.radius, this.bounds);
    this.x = at[0];
    this.z = at[2];
  }

  /** Degrees, wrapped to [-180, 180). */
  get heading(): number {
    return wrapDeg(this.turn.y);
  }

  get position(): V3 {
    return [this.x, 0, this.z];
  }

  /** Unit vector along the heading on the floor, as [x, z]. */
  forward(): [number, number] {
    const h = this.turn.y * DEG;
    return [Math.sin(h), Math.cos(h)];
  }

  /** Top speed for a hurry value, by straight lines through the walk, trot, run and sprint speeds. */
  topSpeed(hurry = this.hurry): number {
    const s = this.speeds;
    const h = clamp(hurry, 0, 1.5) * 2;
    const i = Math.min(2, Math.floor(h));
    return s[i] + (s[i + 1] - s[i]) * (h - i);
  }

  /**
   * Walk to a floor point (clamped inside the walls) at a hurry. `ignore` names an obstacle
   * to walk into; `arrive` widens or narrows the distance that counts as there.
   */
  seek(goal: V3 | null, hurry = this.hurry, opts: { ignore?: string | null; arrive?: number; through?: boolean } = {}): void {
    this.goal = goal ? clampToFloor(goal, this.radius, this.bounds) : null;
    this.hurry = hurry;
    this.through = opts.through ?? false;
    this.ignore = opts.ignore ?? null;
    this.arriveRadius = opts.arrive ?? this.arriveAt;
    this.arrived = false;
    this.blocked = false;
    this.stuck = 0;
    this.detour = null;
    this.detours = 0;
    this.lastDist = Infinity;
  }

  /** Brake to a stop where it is. */
  stop(): void {
    this.seek(null);
  }

  /** Turn to a heading while standing; null keeps whatever heading it has. */
  face(heading: number | null): void {
    this.facing = heading;
  }

  /** Put the cat somewhere at once, at rest. */
  place(at: V3, heading = this.turn.y): void {
    const p = clampToFloor(at, this.radius, this.bounds);
    this.x = p[0];
    this.z = p[2];
    this.turn.snap(heading);
    this.speed = 0;
    this.yawRate = 0;
    this.lastDist = Infinity;
  }

  /** Move by an act's own motion (a pounce, a shove), staying inside the walls. */
  nudge(dx: number, dz: number): void {
    const p = clampToFloor([this.x + dx, 0, this.z + dz], this.radius, this.bounds);
    this.x = p[0];
    this.z = p[2];
  }

  /** Turn by an act's own motion (a tail chase spin), in degrees. */
  spin(degrees: number): void {
    this.turn.snap(this.turn.y + degrees);
  }

  /** A point in the cat's own floor frame (x its left, z its front) in world coordinates. */
  toWorld(lx: number, lz: number, y = 0): V3 {
    const h = this.turn.y * DEG;
    const c = Math.cos(h);
    const s = Math.sin(h);
    return [this.x + lx * c + lz * s, y, this.z - lx * s + lz * c];
  }

  /** This cat as an obstacle for the others. */
  asObstacle(): Obstacle {
    return { id: this.id, x: this.x, z: this.z, r: this.radius, soft: true };
  }

  step(dt: number, obstacles: readonly Obstacle[] = []): void {
    if (!(dt > 0)) return;
    const target = this.detour ?? this.goal;
    let want = this.facing ?? this.turn.y;
    let desired = 0;
    let track: [dist: number, dx: number, dz: number] | null = null;

    if (target) {
      const gx = target[0] - this.x;
      const gz = target[2] - this.z;
      const dist = Math.hypot(gx, gz);
      const done = this.detour ? 0.1 : this.arriveRadius;
      if (dist <= done) {
        if (this.detour) {
          this.detour = null;
        } else {
          this.arrived = true;
          this.goal = null;
        }
      } else {
        const dx = gx / dist;
        const dz = gz / dist;
        const [ax, az] = this.avoid(dx, dz, dist, obstacles);
        const [wx, wz] = this.walls(target);
        const fx = dx + ax + wx;
        const fz = dz + az + wz;
        want = Math.atan2(fx, fz) / DEG;
        // Brake in time to stop on the goal: v² = 2·a·d.
        desired = this.through
          ? this.topSpeed()
          : Math.min(this.topSpeed(), Math.sqrt(2 * this.brake * 0.8 * Math.max(0, dist - done)));
        track = [dist, dx, dz];
      }
    }

    // The heading spring goes the short way round.
    const before = this.turn.y;
    const aim = before + wrapDeg(want - before);
    const heading = this.turn.update(dt, aim);
    this.yawRate = (heading - before) / dt;

    // Tight turns slow it down; past about 100° off it turns on the spot.
    const err = Math.abs(wrapDeg(want - heading)) * DEG;
    desired *= clamp((Math.cos(err) + 0.2) / 1.2, 0, 1);
    // A turn on the spot is not being stuck, so progress is judged against the speed the
    // cat is trying for after the turn, with a floor so a wall it keeps facing still counts.
    if (track) this.progress(dt, track[0], Math.max(desired, 0.1 * this.topSpeed()), track[1], track[2]);
    this.speed += clamp(desired - this.speed, -this.brake * dt, this.accel * dt);
    if (this.speed < 1e-4) this.speed = 0;

    const h = heading * DEG;
    this.x += Math.sin(h) * this.speed * dt;
    this.z += Math.cos(h) * this.speed * dt;
    this.separate(obstacles);
    this.contain();
    this.legs(dt);
  }

  readout(): SteerReadout {
    return {
      position: this.position,
      heading: this.heading,
      speed: this.speed,
      gaitPhase: this.phase / TAU,
      gait: this.gait,
      paws: { ...this.paws },
      stuck: this.stuck,
    };
  }

  // ---------- Inside the step ----------

  /**
   * A sideways pull around each obstacle in the way. Only obstacles closer than the goal
   * and ahead of the cat count; the pull is the part of the obstacle's direction across
   * the path, reversed, so the cat curves round the near side and keeps going.
   */
  private avoid(dx: number, dz: number, dist: number, obstacles: readonly Obstacle[]): [number, number] {
    let ax = 0;
    let az = 0;
    const range = 0.25 + this.speed * this.look;
    for (const o of obstacles) {
      if (o.id === this.id || o.id === this.ignore) continue;
      const rx = o.x - this.x;
      const rz = o.z - this.z;
      const d = Math.hypot(rx, rz);
      if (d < 1e-6) continue;
      const gap = d - o.r - this.radius;
      if (gap > range || d - o.r > dist) continue;
      const nx = rx / d;
      const nz = rz / d;
      const ahead = nx * dx + nz * dz;
      const w = (1 - Math.max(0, gap) / range) ** 2;
      if (ahead > 0) {
        // The obstacle's direction across the path. Dead ahead it is zero, so take the
        // cat's right, the same choice every time.
        let px = nx - ahead * dx;
        let pz = nz - ahead * dz;
        let pl = Math.hypot(px, pz);
        if (pl < 1e-3) {
          px = dz;
          pz = -dx;
          pl = 1;
        }
        ax -= (px / pl) * w * ahead * 1.8;
        az -= (pz / pl) * w * ahead * 1.8;
      }
      if (gap < 0.05) {
        ax -= nx * w * 1.2;
        az -= nz * w * 1.2;
      }
    }
    return [ax, az];
  }

  /**
   * The soft wall limit: inside the margin along a wall, a push back toward the middle
   * that grows with depth. A goal that is itself near the wall moves the start of the
   * push out to the goal, so the cat can still get there.
   */
  private walls(target: V3): [number, number] {
    const { x: bx, z: bz } = this.bounds;
    const m = this.margin;
    const push = (pos: number, limit: number) => clamp((pos - limit) / m, 0, 1) * 2;
    const wx = -push(this.x, Math.max(bx - m, target[0])) + push(-this.x, Math.max(bx - m, -target[0]));
    const wz = -push(this.z, Math.max(bz - m, target[2])) + push(-this.z, Math.max(bz - m, -target[2]));
    return [wx, wz];
  }

  /**
   * The stuck timer. Progress slower than a quarter of the intended speed counts as stuck;
   * after 1.2 s the cat side-steps 0.45 m across its path, and after four side steps for the
   * same goal it gives up and reports itself blocked.
   */
  private progress(dt: number, dist: number, desired: number, dx: number, dz: number): void {
    const made = this.lastDist === Infinity ? Infinity : this.lastDist - dist;
    this.lastDist = dist;
    if (this.detour) {
      this.detourT += dt;
      if (this.detourT > 2) this.detour = null;
      return;
    }
    if (desired > 0.05 && made < 0.25 * desired * dt) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - 2 * dt);
    if (this.stuck < 1.2) return;
    this.stuck = 0;
    this.detours++;
    if (this.detours > 4) {
      this.blocked = true;
      this.goal = null;
      return;
    }
    this.side = this.rng ? (this.rng.chance(0.5) ? 1 : -1) : -this.side;
    this.detour = clampToFloor([this.x + dz * 0.45 * this.side, 0, this.z - dx * 0.45 * this.side], this.radius, this.bounds);
    this.detourT = 0;
    this.lastDist = Infinity;
  }

  /** Pushes out of any obstacle it overlaps, half way for another cat (it moves too). */
  private separate(obstacles: readonly Obstacle[]): void {
    for (const o of obstacles) {
      if (o.id === this.id || o.id === this.ignore) continue;
      const rx = this.x - o.x;
      const rz = this.z - o.z;
      const d = Math.hypot(rx, rz);
      const overlap = o.r + this.radius - d;
      if (overlap <= 0) continue;
      const share = o.soft ? 0.5 : 1;
      // Exactly on top of each other: part along x, the same way every time.
      const nx = d > 1e-6 ? rx / d : 1;
      const nz = d > 1e-6 ? rz / d : 0;
      this.x += nx * overlap * share;
      this.z += nz * overlap * share;
    }
  }

  /** The hard limit behind the soft one: the footprint never crosses a wall. */
  private contain(): void {
    const { x: bx, z: bz } = this.bounds;
    const r = this.radius;
    this.x = clamp(this.x, -bx + r, bx - r);
    this.z = clamp(this.z, -bz + r, bz - r);
  }

  /** Advances the gait phase by the distance the feet cover and derives the paw contacts. */
  private legs(dt: number): void {
    const feet = this.speed + Math.abs(this.yawRate) * TURN_STEP;
    if (feet < STILL) {
      this.gait = 'still';
      this.blend = { walk: 0, trot: 0, run: 0 };
      this.amount = 0;
      this.paws = { ...ALL_DOWN };
      return;
    }
    const blend = gaitBlend(feet);
    const stride = blend.walk * STRIDE.walk + blend.trot * STRIDE.trot + blend.run * STRIDE.run;
    this.phase = (this.phase + (TAU * feet * dt) / stride) % TAU;
    this.blend = blend;
    this.amount = clamp(feet / 0.3, 0, 1);
    this.gait = blend.run >= blend.trot && blend.run >= blend.walk ? 'run' : blend.trot >= blend.walk ? 'trot' : 'walk';
    this.paws = pawContacts(this.phase, blend);
  }
}
