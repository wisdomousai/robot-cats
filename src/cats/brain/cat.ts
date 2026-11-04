import { Color, MeshStandardMaterial, Quaternion, Vector3, type Bone, type Object3D } from 'three';
import { TAIL_SEMAPHORE } from '../cliches';
import { linearColour } from '../geo/paint';
import { clamp, damp } from '../math/ease';
import type { Rng } from '../math/rng';
import { wobble } from '../math/spring';
import { buildCat, puppetOf, type MeshInfo } from '../model/build';
import { BREEDS, dimsOf } from '../model/dims';
import { DOT, setLight } from '../model/materials';
import { legXZ, tailBoneNames, tailJoints } from '../model/parts';
import type { Puppet } from '../rig/puppet';
import {
  LEGS,
  type Act,
  type BreedId,
  type CatModel,
  type CatReadout,
  type Counters,
  type Dims,
  type Expression,
  type Gaze,
  type LegName,
  type Mood,
  type Posture,
  type Role,
  type V3,
} from '../types';
import { makeActs } from './acts';
import { FEELINGS, MOOD_BIAS, MoodState, type Feeling } from './moods';
import { Steer, headingTo, wrapDeg, type Obstacle } from './steer';
import type { Toys } from './toys';

/**
 * One robot cat in the world: the model, its puppet, its steering, its moods and its acts.
 * `step(dt, env)` runs the same order as the creatures package's character pipeline:
 *
 *   pick act, steer, puppet.begin, idle (breath, posture), act pose, role pose, mood,
 *   species pose (tail carriage by mood, ears, gaze), puppet.update, after (gait, crouch,
 *   squash, tumble), place on the floor, face, lights, readout.
 *
 * Acts and roles do not move bones directly. They add turns through the puppet and fill in
 * `want` (crouch, lift, tumble, face, look, tail carriage, purr), and the later stages turn
 * that into the pose. `want` is cleared at the start of every step, so an act that stops
 * asking for something stops getting it.
 *
 * Everything random comes from the cat's own Rng (a fork of the world's), and time from the
 * world's clock in the env, so a world built from the same seed replays the same way.
 */

const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;
const UP = new Vector3(0, 1, 0);
const AX = new Vector3(1, 0, 0);
const AZ = new Vector3(0, 0, 1);

/** Where each cat starts. Headings face roughly toward the camera. */
export const CAT_STARTS: Record<BreedId, { at: V3; heading: number }> = {
  tabby: { at: [-0.55, 0, 0.25], heading: 40 },
  siamese: { at: [0.05, 0, -0.15], heading: 10 },
  black: { at: [0.75, 0, -0.02], heading: -40 },
};

/** Where the owner usually is: about where the default camera stands, at eye height. */
export const OWNER: V3 = [1.84, 1.19, 2.95];
/** The empty corner cats stare into: high on the back wall, at the left. */
export const EMPTY_CORNER: V3 = [-1.35, 1.25, -1.55];

/** An act as this library writes them: the creatures shape plus a posture and a hook after the springs. */
export interface CatAct extends Act {
  /** Posture the act starts in; the act may change `cat.posture` as it goes. */
  posture?: Posture;
  /** Every step after the springs, for direct turns that a spring would smear (a paw swipe). */
  after?: (t: number) => void;
}

/** A director's role with the extras this library uses. */
export interface CatRole extends Role {
  /** Name shown as the cat's act while it plays this part. */
  act: string;
  /** What `look` points at, for the attention panel. */
  gaze?: Gaze;
  /** An obstacle id the cat may walk into (the other wrestler). */
  ignore?: string | null;
  /** Distance that counts as there, metres. */
  arrive?: number;
  /** Run through the goal at speed instead of braking to stop on it (a chase, a lap). */
  through?: boolean;
  /** A point to turn toward while standing, followed as it moves; overrides `facing`. */
  faceTo?: () => V3 | null;
  /** Direct turns after the springs, as CatAct.after. */
  after?: (t: number) => void;
}

/**
 * What the cat's surroundings offer it each step. The world implements this; acts read it
 * through `cat.env`.
 */
export interface CatEnv {
  readonly time: number;
  readonly toys: Toys;
  readonly cats: readonly Cat[];
  /** The cursor on the floor, or null when it is off the floor. */
  readonly cursor: V3 | null;
  /** Seconds since the cursor last moved. */
  readonly cursorAge: number;
  /** True on the step a hand touched this cat's belly. */
  bellyTouched(cat: Cat): boolean;
  /** The owner's position: the cursor raised to hand height, or the camera's usual place. */
  owner(): V3;
  count(key: keyof Counters, n?: number): void;
  /** Claims a prop for the cat's current act; false if another cat holds it. */
  claim(prop: string, cat: Cat): boolean;
  claimedBy(prop: string): Cat | null;
  release(cat: Cat): void;
  /** Props and other cats as circles on the floor, for steering. */
  obstacles(cat: Cat): Obstacle[];
  /** The act the world wants this cat to run when its act ends, or null for free play. */
  demoFor(cat: Cat): string | null;
}

/** Tail carriages: by mood, a row of TAIL_SEMAPHORE by index, the act's own, or curled round the body. */
export type TailWant = 'mood' | 'wrap' | 'act' | number;

/** What the act and role ask for this step. Cleared before every step. */
export interface Want {
  face: Expression | null;
  /** A mood that wins over the levels while it is asked for. */
  mood: Mood | null;
  /** Pupil width 0..1, or null for the mood's. */
  wide: number | null;
  look: V3 | null;
  gaze: Gaze | null;
  /** The head keeps still whatever the cat looks at; only the eyes and ears move. */
  headLock: boolean;
  /** A point the ears track at full swivel. */
  ears: V3 | null;
  /** Crouch: the body sinks this far (metres) with the paws kept on the floor. */
  low: number;
  /** Extra height above whatever the cat stands on, metres (a leap). */
  lift: number;
  /** Body centre held at this height, metres, unless the floor is higher (picked up, falling). */
  hold: number | null;
  /** Tumble about the body centre, degrees: roll about the cat's length, pitch about its width. */
  roll: number;
  pitch: number;
  /** How quickly the tumble follows, Hz. */
  tumbleHz: number;
  /** Liquid state 0..1: the whole cat flattens and spreads. */
  squash: number;
  tail: TailWant;
  puff: number | null;
  /** Purr frequency in Hz, 0 for none. */
  purr: number;
  /** Mouth open 0..1. */
  talk: number;
  /** Eyelids held by the act, 0 open to 1 shut; null leaves blinking to the face. */
  blink: number | null;
  /** The belly is up and the trap is set. */
  belly: boolean;
  /** Light levels by dot name (and the beacon), overriding the ones the act and mood give. */
  lights: Partial<Record<keyof typeof DOT | 'beacon', number>> | null;
}

function blankWant(): Want {
  return {
    face: null,
    mood: null,
    wide: null,
    look: null,
    gaze: null,
    headLock: false,
    ears: null,
    low: 0,
    lift: 0,
    hold: null,
    roll: 0,
    pitch: 0,
    tumbleHz: 2.2,
    squash: 0,
    tail: 'mood',
    puff: null,
    purr: 0,
    talk: 0,
    blink: null,
    belly: false,
    lights: null,
  };
}

/** Which carriage each mood holds the tail in, as rows of TAIL_SEMAPHORE. */
export const MOOD_TAIL: Record<Mood, string> = {
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

/** Shares of attention by what the cat looks at, for the attention panel. */
const ATTENTION: Record<Gaze, CatReadout['attention']> = {
  owner: { owner: 0.12, box: 0.6, nothing: 0.25, toy: 0.03 },
  box: { owner: 0.02, box: 0.96, nothing: 0.02, toy: 0 },
  nothing: { owner: 0.02, box: 0.2, nothing: 0.75, toy: 0.03 },
  toy: { owner: 0.02, box: 0.1, nothing: 0.18, toy: 0.7 },
  cat: { owner: 0.02, box: 0.3, nothing: 0.4, toy: 0.28 },
  bird: { owner: 0.02, box: 0.2, nothing: 0.6, toy: 0.18 },
};

/** Act groups that the breed's temperament scales. */
const ENERGETIC = new Set(['trot', 'run', 'zoomies', 'pounce', 'tailChase', 'ball', 'prowl']);
const SOCIAL = new Set(['headbutt', 'slowBlink', 'purr', 'knead', 'roll']);
const NAPPY = new Set(['sleep', 'loaf', 'lie', 'yawn', 'sphinx', 'stretch']);

/** Metres per leg cycle and the share of it each paw is down, as the steering uses them. */
const STRIDE = { walk: 0.26, trot: 0.42, run: 0.78 };
const DUTY = { walk: 0.68, trot: 0.5, run: 0.4 };
const DIAGONAL: Record<LegName, number> = { FL: 0, BR: 0, FR: Math.PI, BL: Math.PI };
const BOUND: Record<LegName, number> = { FL: 0, FR: 0, BL: Math.PI, BR: Math.PI };
/** How far folded legs may sink into the surface under a lying cat, metres. */
const LEG_SINK = 0.03;
/**
 * The opening the clearance gauge compares the whiskers with, metres. The gauge is set so
 * whiskers at rest read exactly this, which is why its verdict is always to go in.
 */
const GAUGE_OPENING = 0.24;

/** A point fixed to a bone: its offset in the bone's own frame. */
interface Point {
  bone: Bone;
  local: Vector3;
}

/** A spring whose frequency may change while it moves (semi-implicit Euler). */
class Tumble {
  x = 0;
  v = 0;
  step(dt: number, target: number, f: number, zeta = 0.75): number {
    const w = TAU * f;
    this.v += dt * (w * w * (target - this.x) - 2 * zeta * w * this.v);
    this.x += dt * this.v;
    return this.x;
  }
}

/** The puppet made for each model, so a reused model keeps the rest pose it was measured in. */
const PUPPETS = new WeakMap<CatModel, Puppet>();

/** How far the whiskers fold back in the box, radians from sideways towards the tail. */
const WHISKER_FOLD = 80 * DEG;
const v1 = new Vector3();
const v2 = new Vector3();
const q1 = new Quaternion();
const q2 = new Quaternion();
const q3 = new Quaternion();

export class Cat {
  readonly id: BreedId;
  readonly name: string;
  readonly model: CatModel;
  readonly puppet: Puppet;
  readonly steer: Steer;
  readonly mood: MoodState;
  readonly rng: Rng;
  readonly dims: Dims;
  /** Tail bone names, base first. */
  readonly tail: string[];
  /** Hip height above the floor at rest, metres: what the legs reach. */
  readonly legLength: number;
  /** The body centre in the cat's frame: tumbles turn about it. */
  readonly centre: V3;
  /** Body tip that puts the rump and the front paws on the floor together when sitting. */
  sitTip = -24;
  readonly acts: Record<string, CatAct>;

  env!: CatEnv;
  time = 0;
  actName = 'idle';
  act: CatAct;
  actT = 0;
  actLen = 3;
  /** Started by a button or a demo rather than picked in free play. */
  directed = false;
  role: CatRole | null = null;
  roleT = 0;
  posture: Posture = 'stand';
  want: Want = blankWant();
  /** Act time at which the walk to the act's spot ended, or -1 while still walking. */
  arrivedAt = 0;
  /** Duration of the last blink, for the eyes panel. Acts that hold a slow blink set it. */
  blinkMs = 160;

  // Readout state.
  gaze: Gaze = 'nothing';
  readonly attention: CatReadout['attention'] = { owner: 0.05, box: 0.4, nothing: 0.45, toy: 0.1 };
  tailCarriage = 10;
  tailStateName = 'out, level';
  whiskerSpan = 0;
  squash = 0;
  purrHz = 0;
  lift = 0;
  readonly load: CatReadout['load'] = { head: 0, body: 0, ears: 0, FL: 0, FR: 0, BL: 0, BR: 0, tail: 0 };
  readonly pawsDown: Record<LegName, boolean> = { FL: true, FR: true, BL: true, BR: true };
  /** Paw bottoms in world coordinates, after the last placement. */
  readonly paws: Record<LegName, V3> = { FL: [0, 0, 0], FR: [0, 0, 0], BL: [0, 0, 0], BR: [0, 0, 0] };
  /** The head's centre in world coordinates after the last placement: where the eyes are. */
  readonly headAt: V3 = [0, 0.45, 0];

  /** Points that may touch the ground: paws first (in LEGS order), then rump, body, head, ears. */
  private readonly contacts: Point[] = [];
  private readonly pawIndex: Record<LegName, number> = { FL: 0, FR: 1, BL: 2, BR: 3 };
  private readonly rump: number[] = [];
  private readonly belly: number[] = [];
  private readonly headPoint: Point;
  private readonly tailTip: Point;
  private readonly whiskerTips: [Point, Point];
  /** Tip-to-tip span at rest, metres, which the gauge reads as GAUGE_OPENING. */
  private readonly whiskerRest: number;
  /** Each cheek's whisker meshes with the root and up axis they fold about, in the head bone. */
  private readonly whiskerFold: { mesh: Object3D; s: number; pivot: Vector3; axis: Vector3 }[] = [];
  private whiskerFolded = 0;
  private readonly rootBone: Bone;
  private readonly tumbleRoll = new Tumble();
  private readonly tumblePitch = new Tumble();
  private crouch = 0;
  private crouchV = 0;
  private squashed = 0;
  private puffed = 0;
  private pupils = 0.3;
  private groundLift = 0;
  /** How far the leg contacts may go below the surface, metres; eased in while lying. */
  private legSink = 0;
  private freeGaze: Gaze = 'nothing';
  private freeGazeT = 0;
  private nextFlick = 2;
  private nextEarFlick = 3;
  private bobPhase = 0;
  private lastHeading = 0;
  private swing = 0;
  private lastBlinks = 0;
  private gaitLoad = 0;
  private readonly tone = new Color();
  private readonly baseTone = new Color();
  private readonly scratch = new Color();

  /**
   * `opts.model` reuses a model an earlier Cat of this breed built, so a world can start
   * over without building geometry again or swapping what the page has in its scene.
   */
  constructor(id: BreedId, rng: Rng, opts: { accent?: string; model?: CatModel } = {}) {
    const breed = BREEDS[id];
    this.id = id;
    this.name = breed.name;
    this.rng = rng.fork(`cat.${id}`);
    const reused = opts.model ? PUPPETS.get(opts.model) : undefined;
    if (opts.model && reused) {
      // Back to the state buildCat leaves it in: the rig at rest at the origin, its own coat.
      this.model = opts.model;
      this.puppet = reused;
      reused.reset();
      this.model.root.position.set(0, 0, 0);
      this.model.root.quaternion.identity();
      this.model.recoat(breed.coat);
      this.model.face.reset?.();
    } else {
      this.model = buildCat(breed, { accent: opts.accent });
      this.puppet = puppetOf(this.model);
      PUPPETS.set(this.model, this.puppet);
    }
    this.dims = dimsOf(breed);
    this.tail = tailBoneNames(this.dims);
    this.legLength = this.dims.leg.top;
    const b = this.dims.body;
    this.centre = [0, b.center[1], b.center[2]];
    const start = CAT_STARTS[id];
    this.steer = new Steer({ id, radius: 0.2, at: start.at, heading: start.heading, rng: this.rng.fork('steer') });
    this.lastHeading = start.heading;
    this.mood = new MoodState({ temperament: breed.temperament });
    this.rootBone = this.model.bones.get('root')!;
    const beacon = this.model.materials.beacon;
    if (beacon instanceof MeshStandardMaterial) this.baseTone.copy(beacon.emissive);
    this.tone.copy(this.baseTone);

    // Points on the rig, recorded at rest (the root at the identity).
    this.model.root.updateMatrixWorld(true);
    const d = this.dims;
    const point = (bone: string, p: V3): Point => {
      const bn = this.model.bones.get(bone)!;
      return { bone: bn, local: new Vector3(...p).applyMatrix4(bn.matrixWorld.clone().invert()) };
    };
    const contact = (bone: string, p: V3, list?: number[]) => {
      list?.push(this.contacts.length);
      this.contacts.push(point(bone, p));
    };
    for (const leg of LEGS) {
      const [x, z] = legXZ(d, leg);
      contact(`shin.${leg}`, [x, 0, z]);
    }
    const [rx, ry, rz] = b.radii;
    const [, cy, cz] = b.center;
    // The rump: the bottom and back of the body's rear, which a sitting cat rests on.
    contact('body', [0, cy - ry * 0.92, cz - rz * 0.7], this.rump);
    contact('body', [0, cy - ry * 0.6, cz - rz * 0.92], this.rump);
    contact('body', [0, cy, cz - rz], this.rump);
    for (const k of [-0.5, 0, 0.6]) {
      const z = cz + rz * k;
      const s = Math.sqrt(1 - k * k);
      contact('body', [0, cy - ry * s * 0.95, z], this.belly);
      contact('body', [0, cy + ry * s * 0.95, z]);
      contact('body', [rx * s * 0.95, cy, z]);
      contact('body', [-rx * s * 0.95, cy, z]);
    }
    const h = d.head;
    contact('head', [0, h.center[1] - h.radii[1] * 0.92, h.center[2]]);
    contact('head', [0, h.center[1] + h.radii[1] * 0.9, h.center[2]]);
    contact('head', [h.radii[0] * 0.9, h.center[1], h.center[2]]);
    contact('head', [-h.radii[0] * 0.9, h.center[1], h.center[2]]);
    contact('head', [0, h.center[1], h.center[2] + h.radii[2] * 0.9]);
    const e = d.ear;
    const tip = e.profile[e.profile.length - 1][1];
    for (const [side, s] of [['L', 1], ['R', -1]] as const) {
      contact(`ear.${side}`, [s * (e.x + tip * Math.sin(e.tilt)), e.y + tip * Math.cos(e.tilt) - 0.02, e.z]);
    }
    this.headPoint = point('head', [...h.center] as V3);
    const joints = tailJoints(d);
    this.tailTip = point(this.tail[this.tail.length - 1], joints[joints.length - 1]);
    // The whisker tips, for the measured span.
    const w = d.whiskers;
    const wy = h.center[1] + (d.screen.dz ?? 0) + w.dy;
    const wz = h.center[2] + h.radii[2] + w.dz;
    this.whiskerTips = [point('head', [w.x + w.length, wy, wz]), point('head', [-(w.x + w.length), wy, wz])];
    this.whiskerRest = 2 * (w.x + w.length);
    const toHead = this.model.bones.get('head')!.matrixWorld.clone().invert();
    const up = new Vector3(0, 1, 0).transformDirection(toHead);
    for (const mesh of this.model.meshes) {
      const info = mesh.userData as MeshInfo;
      if (info.system !== 'whiskers' || info.bone !== 'head') continue;
      const side = Math.sign(info.explode[0]);
      this.whiskerFold.push({ mesh, s: side, pivot: new Vector3(side * w.x, wy, wz).applyMatrix4(toHead), axis: up });
    }

    this.calibrate();
    this.acts = makeActs(this);
    this.act = this.acts.idle;
    this.actLen = this.rng.range(1, 3);
    this.place();
  }

  // ---------- Calibration ----------

  /**
   * Finds the body tip at which a sitting cat has its rump and its front paws on the floor
   * together. Each breed's legs and body differ, so this is measured on the rig: pose the
   * sit at a range of tips, snap, and compare the lowest rump point with the front paws.
   */
  private calibrate(): void {
    const p = this.puppet;
    let best = this.sitTip;
    let bestErr = Infinity;
    for (let tip = -10; tip >= -56; tip -= 2) {
      p.begin();
      this.foldSit(tip);
      p.snap();
      this.model.root.updateMatrixWorld(true);
      const front = Math.min(this.worldY(this.pawIndex.FL), this.worldY(this.pawIndex.FR));
      let rump = Infinity;
      for (const i of this.rump) rump = Math.min(rump, this.worldY(i));
      const err = Math.abs(front - rump);
      if (err < bestErr) {
        bestErr = err;
        best = tip;
      }
    }
    this.sitTip = best;
    p.begin();
    p.snap();
    this.model.root.updateMatrixWorld(true);
  }

  private worldY(i: number): number {
    const c = this.contacts[i];
    return v1.copy(c.local).applyMatrix4(c.bone.matrixWorld).y;
  }

  private worldOf(pt: Point, out = new Vector3()): Vector3 {
    return out.copy(pt.local).applyMatrix4(pt.bone.matrixWorld);
  }

  // ---------- Acts ----------

  /** Starts an act by name. `directed` acts were asked for (a button or a demo). */
  start(name: string, directed = false): void {
    const act = this.acts[name] ?? this.acts.idle;
    this.act.end?.();
    this.env?.release(this);
    this.actName = act === this.acts.idle ? 'idle' : name;
    this.act = act;
    this.actT = 0;
    this.actLen = this.rng.range(act.length[0], act.length[1]);
    this.directed = directed;
    this.arrivedAt = 0;
    this.blinkMs = 160;
    this.steer.stop();
    this.steer.face(null);
    this.posture = act.posture ?? 'stand';
    act.start?.();
  }

  /** Picks the next act in free play: weight times temperament times mood, among those whose `when` holds. */
  pickFree(): void {
    const t = BREEDS[this.id].temperament;
    const names: string[] = [];
    const weights: number[] = [];
    let total = 0;
    for (const [name, act] of Object.entries(this.acts)) {
      if (!(act.weight > 0) || name === this.actName) continue;
      if (act.when && !act.when()) continue;
      let w = act.weight * (MOOD_BIAS[this.mood.mood][name] ?? 1);
      if (ENERGETIC.has(name)) w *= t.energy;
      if (SOCIAL.has(name)) w *= t.social;
      if (NAPPY.has(name)) w *= t.napping;
      names.push(name);
      weights.push(w);
      total += w;
    }
    let r = this.rng.next() * total;
    for (let i = 0; i < names.length; i++) {
      r -= weights[i];
      if (r <= 0) return this.start(names[i]);
    }
    this.start('idle');
  }

  /** Hands the cat to a director, or back to its own acts with null. */
  direct(role: CatRole | null): void {
    this.act.end?.();
    this.env?.release(this);
    this.act = this.acts.idle;
    this.actT = 0;
    this.directed = !!role;
    this.steer.stop();
    this.steer.face(null);
    this.role = role;
    this.roleT = 0;
    this.arrivedAt = 0;
    if (role) {
      this.actName = role.act;
      this.actLen = Infinity;
      this.posture = role.posture ?? 'stand';
    } else {
      this.actName = 'idle';
      this.actLen = 0;
    }
  }

  // ---------- Helpers for acts ----------

  /**
   * Walks to a floor point. `since()` counts from when the cat gets there. Calling it again
   * with nearly the same goal keeps the walk going instead of restarting it.
   */
  goTo(
    goal: V3 | null,
    hurry = 0,
    opts: { ignore?: string | null; arrive?: number; facing?: number | null; through?: boolean } = {},
  ): void {
    const s = this.steer;
    if (opts.facing !== undefined) s.face(opts.facing);
    if (!goal) {
      if (s.goal) s.stop();
      return;
    }
    const ignore = opts.ignore ?? null;
    const through = opts.through ?? false;
    if (
      s.goal &&
      Math.hypot(s.goal[0] - goal[0], s.goal[2] - goal[2]) < 0.03 &&
      s.hurry === hurry &&
      s.ignore === ignore &&
      s.through === through
    )
      return;
    const arrive = opts.arrive ?? 0.06;
    const near = Math.hypot(goal[0] - s.x, goal[2] - s.z) <= arrive;
    if (near) {
      // Already there: nothing to walk, and the act's timeline keeps running.
      s.ignore = ignore;
      if (this.arrivedAt < 0) this.arrivedAt = this.actT;
      return;
    }
    s.seek(goal, hurry, { ignore, arrive, through });
    this.arrivedAt = -1;
  }

  /** Seconds since the cat reached the spot its act walked it to; -1 while on the way. */
  since(t = this.actT): number {
    return this.arrivedAt < 0 ? -1 : t - this.arrivedAt;
  }

  /** True while the steering is carrying the cat somewhere. */
  get walking(): boolean {
    return this.steer.goal !== null;
  }

  /** Moving at all, by the legs' measure. */
  get moving(): boolean {
    return this.steer.amount > 0.08;
  }

  /** The posture as shown: a walking cat stands, whatever its act wants next. */
  get shownPosture(): Posture {
    return this.moving ? 'stand' : this.posture;
  }

  /** The cat's own floor frame point (x its left, z its front) in world coordinates. */
  local(lx: number, lz: number, y = 0): V3 {
    return this.steer.toWorld(lx, lz, y);
  }

  headingTo(p: V3): number {
    return headingTo(this.steer.position, p);
  }

  distTo(p: V3): number {
    return Math.hypot(p[0] - this.steer.x, p[2] - this.steer.z);
  }

  /** Ears laid back (k 0..1), flattened out to the sides. */
  earsBack(k: number, out = 30): void {
    this.puppet.add('ear.L', -25 * k, 0, -out * k);
    this.puppet.add('ear.R', -25 * k, 0, out * k);
  }

  /** Ears pricked forward (k 0..1). */
  earsUp(k: number): void {
    this.puppet.add('ear.L', 16 * k, 0, 6 * k);
    this.puppet.add('ear.R', 16 * k, 0, -6 * k);
  }

  /** The nearest other cat and its floor distance. */
  nearest(): { cat: Cat | null; d: number } {
    let best: Cat | null = null;
    let d = Infinity;
    for (const c of this.env.cats) {
      if (c === this) continue;
      const dd = this.distTo(c.steer.position);
      if (dd < d) {
        d = dd;
        best = c;
      }
    }
    return { cat: best, d };
  }

  /** On its haunches: front legs upright, hind legs folded forward under the rump. */
  foldSit(tip: number): void {
    const p = this.puppet;
    p.add('body', tip);
    p.add('leg.FL', -tip);
    p.add('leg.FR', -tip);
    p.add('leg.BL', -80 - tip);
    p.add('leg.BR', -80 - tip);
    p.add('shin.BL', 150);
    p.add('shin.BR', 150);
    p.add('head', -tip * 0.8);
  }

  /** Lying with the legs tucked under: front paws folded beneath the chest, hind legs under the haunch. */
  foldLie(): void {
    const p = this.puppet;
    p.add('leg.FL', 75);
    p.add('leg.FR', 75);
    p.add('shin.FL', -150);
    p.add('shin.FR', -150);
    p.add('leg.BL', -80);
    p.add('leg.BR', -80);
    p.add('shin.BL', 155);
    p.add('shin.BR', 155);
    p.add('head', 8);
  }

  /** Points pressing down on whatever is under the cat: the paws that are down and, lying, the belly. */
  pressPoints(): V3[] {
    const out: V3[] = [];
    for (const leg of LEGS) if (this.pawsDown[leg]) out.push(this.paws[leg]);
    if (this.shownPosture !== 'stand') {
      for (const i of this.belly) {
        const w = this.worldOf(this.contacts[i], v2);
        out.push([w.x, w.y, w.z]);
      }
    }
    return out;
  }

  /** A world point on a bone, given in the cat's rest frame (for paw tips and the like). */
  pointOn(bone: string, rest: V3): V3 {
    const w = this.worldOf(this.restPoint(bone, rest), v2);
    return [w.x, w.y, w.z];
  }

  private readonly restPoints = new Map<string, Point>();
  private restPoint(bone: string, rest: V3): Point {
    const key = `${bone}|${rest.join(',')}`;
    let pt = this.restPoints.get(key);
    if (!pt) {
      const bn = this.model.bones.get(bone)!;
      // The bone's rest world matrix in the cat's frame: rebuild it from the puppet's rest.
      const m = this.puppet.restMatrix(bone);
      pt = { bone: bn, local: new Vector3(...rest).applyMatrix4(m.clone().invert()) };
      this.restPoints.set(key, pt);
    }
    return pt;
  }

  /** A paw's tip (the toes) in world coordinates. */
  pawTip(leg: LegName): V3 {
    const [x, z] = legXZ(this.dims, leg);
    return this.pointOn(`shin.${leg}`, [x, 0.02, z + this.dims.paw.radii[2]]);
  }

  // ---------- The step ----------

  step(dt: number, env: CatEnv): void {
    this.env = env;
    this.time = env.time;
    if (!this.role && this.actT >= this.actLen) {
      const demo = env.demoFor(this);
      if (demo) this.start(demo, true);
      else this.pickFree();
    }
    this.actT += dt;
    if (this.role) this.roleT += dt;
    this.want = blankWant();

    const role = this.role;
    if (role) {
      const goal = role.goal ? role.goal() : null;
      const faceTo = role.faceTo?.() ?? null;
      this.goTo(goal, role.hurry ?? 0.5, {
        ignore: role.ignore ?? null,
        arrive: role.arrive ?? 0.12,
        facing: faceTo ? this.headingTo(faceTo) : (role.facing ?? null),
        through: role.through ?? false,
      });
    }
    const steer = this.steer;
    const obstacles = env.obstacles(this);
    steer.step(dt, obstacles);
    this.keepNoseClear(obstacles);
    if (this.arrivedAt < 0 && (steer.arrived || steer.blocked || !steer.goal)) this.arrivedAt = this.actT;

    const p = this.puppet;
    p.begin();
    this.idle();
    this.act.pose?.(this.actT);
    role?.pose?.(this.roleT, dt);
    this.feel(dt);
    this.species(dt);
    p.update(dt);
    this.after(dt);
    this.act.after?.(this.actT);
    role?.after?.(this.roleT);
    this.place(dt);
    this.faceStep(dt);
    this.lights();
    this.measure(dt);
  }

  /**
   * The steering keeps the cat's centre clear of the others, but the head reaches well past
   * it. If the nose would be inside another cat or a prop, the cat is eased back from it.
   */
  private keepNoseClear(obstacles: readonly Obstacle[]): void {
    const s = this.steer;
    const nose = s.toWorld(0, 0.26);
    for (const o of obstacles) {
      if (o.id === s.id || o.id === s.ignore) continue;
      const dx = nose[0] - o.x;
      const dz = nose[2] - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + 0.07;
      if (d < min && d > 1e-6) s.nudge((dx / d) * (min - d) * 0.5, (dz / d) * (min - d) * 0.5);
    }
  }

  // ---------- Layers ----------

  /** Breathing, a slow sway of the head, and the legs folded for the posture. */
  private idle(): void {
    const p = this.puppet;
    const t = this.time;
    const breath = Math.sin(TAU * 0.3 * t + this.steer.radius * 10);
    p.add('body', breath * 1.2);
    p.add('head', 3 * wobble(t * 0.4, this.id.length));
    const posture = this.shownPosture;
    // The fold is only the target; the leg springs ease the cat into it.
    if (posture === 'sit') this.foldSit(this.sitTip);
    else if (posture === 'lie') this.foldLie();
  }

  /** Mood: the act's or role's own mood holds while it lasts; a cursor close by makes the cat curious. */
  private feel(dt: number): void {
    const cursor = this.env.cursor;
    const near = cursor !== null && this.env.cursorAge < 1.5 && this.distTo(cursor) < 0.6;
    const forced = this.want.mood ?? this.role?.mood ?? this.act.mood ?? null;
    this.mood.step(dt, { act: this.actName, role: forced, posture: this.shownPosture, cursorNear: near });
  }

  /** Body sway in the gait, the tail by mood, ears and gaze: what every cat does whatever its act. */
  private species(dt: number): void {
    const p = this.puppet;
    const s = this.steer;
    if (s.amount > 0.02) {
      const g = s.phase;
      const walky = s.blend.walk + s.blend.trot;
      p.add('body', 7 * Math.sin(g) * s.blend.run * s.amount, 0, Math.cos(2 * g) * 2 * walky * s.amount);
      p.add('head', (Math.cos(2 * g) * 3 * walky - 5 * Math.sin(g) * s.blend.run) * s.amount);
    }
    // Leaning into turns, and the tail trailing behind them.
    const yaw = wrapDeg(s.heading - this.lastHeading) / Math.max(dt, 1e-4);
    this.lastHeading = s.heading;
    this.swing = damp(this.swing, clamp(yaw, -400, 400), 2.4, dt);
    p.add('root', 0, 0, clamp(-this.swing * 0.02 * Math.min(1, s.speed), -8, 8));

    const f = FEELINGS[this.mood.mood];
    this.tailPose(dt, f);
    this.earsPose(f);
    this.gazePose(dt);
  }

  /** Elevation of the tail at rest, base to tip, degrees above level. */
  get restElevation(): number {
    const pts = this.dims.tail.points;
    const a = pts[0];
    const b = pts[pts.length - 1];
    return Math.atan2(b[1] - a[1], Math.hypot(b[0] - a[0], b[2] - a[2])) / DEG;
  }

  private tailPose(dt: number, f: Feeling): void {
    const p = this.puppet;
    const w = this.want;
    const bones = this.tail;
    const n = bones.length;
    const t = this.time;
    let mode = w.tail;
    if (mode === 'mood' && this.shownPosture !== 'stand') mode = 'wrap';
    if (mode === 'mood' || typeof mode === 'number') {
      const row = typeof mode === 'number' ? TAIL_SEMAPHORE[mode] : TAIL_SEMAPHORE.find((r) => r.state === MOOD_TAIL[this.mood.mood])!;
      this.tailStateName = row.state;
      // The tail hangs off the body, so the body's own pitch tips it; the base takes the difference.
      const body = p.target('body')[0];
      let carriage = row.carriage - this.restElevation - body;
      if (this.moving && row.carriage < 30) carriage += 10;
      const [bob, hz] = row.state === 'low, thumping' ? [14, 1.6] : (f.bob ?? [0, 0]);
      this.bobPhase += dt * TAU * hz;
      carriage += bob * Math.sin(this.bobPhase);
      p.add(bones[0], carriage * 0.8);
      for (let i = 1; i < n; i++) p.add(bones[i], (carriage * 0.2) / (n - 1));
      // A low tail droops toward the tip.
      if (row.carriage < 0) for (let i = 1; i < n; i++) p.add(bones[i], -8 / i);
      const hook = row.state === 'up, hooked tip' ? 45 : row.state === 'up, puffed' ? -20 : (f.hook ?? 0) * 0.5;
      p.add(bones[n - 1], hook);
      if (n > 2) p.add(bones[n - 2], hook * 0.4);
      if (row.state === 'up, quivering') {
        for (let i = 0; i < n; i++) p.add(bones[i], 0, 4 * Math.sin(t * TAU * 8 + i), 3 * Math.sin(t * TAU * 11 + i));
      }
      if (row.state === 'up, puffed') w.puff = Math.max(w.puff ?? 0, 1);
    } else if (mode === 'wrap') {
      // A tail wrapped along the floor reads as low whatever the mood; the console matches
      // this name against its semaphore rows, so it names the row the tail really shows.
      this.tailStateName = this.mood.mood === 'cross' ? 'low, thumping' : 'low, still';
      // Curled round to the cat's left, along the floor.
      p.add(bones[0], -this.restElevation * 0.9 - p.target('body')[0], 55);
      for (let i = 1; i < n; i++) p.add(bones[i], -6, (70 / (n - 1)) * (1 + 0.1 * Math.sin(t * 0.9 + i)));
    }
    // Flicks of the tip, now and then, as the mood has them.
    if (mode !== 'act' && t > this.nextFlick) {
      const rate = (f.flicks ?? 0.15) + (this.mood.mood === 'curious' ? 0.4 : 0);
      this.nextFlick = t + this.rng.range(0.5, 2) / Math.max(0.2, rate);
      p.kick(bones[n - 1], 0, this.rng.chance(0.5) ? 260 : -260, 0);
    }
    // The tail trails behind a turn.
    p.add(bones[0], 0, -this.swing * 0.06);
    if (n > 1) p.add(bones[1], 0, -this.swing * 0.04);
    this.puffed = damp(this.puffed, w.puff ?? f.puff ?? 0, 6, dt);
  }

  private earsPose(f: Feeling): void {
    const p = this.puppet;
    const w = this.want;
    // What the ears turn to: the act's point, else the cursor while it moves, else straight ahead.
    const at = w.ears ?? (this.env.cursor && this.env.cursorAge < 3 ? this.env.cursor : null);
    const full = w.ears !== null;
    let az = 0;
    if (at) {
      const headYaw = w.headLock ? 0 : this.lookYaw;
      az = wrapDeg(headingTo(this.headAt, at) - this.steer.heading - headYaw);
    }
    for (const [ear, side] of [['ear.L', 1], ['ear.R', -1]] as const) {
      const near = Math.sign(az) === side ? 1 : 0.7;
      const turn = full ? clamp(az, -85, 85) : clamp(az * f.swivel * near, -45, 45);
      p.add(ear, f.ears, turn, -side * f.out);
    }
    // An ear flick every few seconds: a knock, and the spring does the rest.
    if (this.time > this.nextEarFlick) {
      this.nextEarFlick = this.time + this.rng.range(2, 7);
      const left = this.rng.chance(0.5);
      p.kick(left ? 'ear.L' : 'ear.R', -200, 0, left ? -500 : 500);
    }
  }

  private lookYaw = 0;

  /** Where the head and eyes point, and what the attention panel calls it. */
  private gazePose(dt: number): void {
    const w = this.want;
    const role = this.role;
    let target: V3 | null = null;
    let kind: Gaze | null = null;
    if (w.look) {
      target = w.look;
      kind = w.gaze ?? 'nothing';
    } else if (role?.look) {
      target = role.look();
      kind = role.gaze ?? 'cat';
    }
    if (!target) {
      this.freeGazeT -= dt;
      if (this.freeGazeT <= 0) {
        const options: [Gaze, number][] = [
          ['owner', this.env.cursor ? 2.5 : 1],
          ['box', 1.4],
          ['nothing', 1.2],
          ['toy', 1],
          ['cat', 1],
        ];
        let r = this.rng.next() * options.reduce((a, [, x]) => a + x, 0);
        for (const [g, x] of options) {
          r -= x;
          if (r <= 0) {
            this.freeGaze = g;
            break;
          }
        }
        this.freeGazeT = this.rng.range(3, 6);
      }
      kind = w.gaze ?? this.freeGaze;
      target = this.pointFor(kind);
    }
    this.gaze = kind ?? 'nothing';
    const share = ATTENTION[this.gaze];
    for (const k of ['owner', 'box', 'nothing', 'toy'] as const) this.attention[k] = damp(this.attention[k], share[k], 0.9, dt);

    this.lookYaw = 0;
    if (!target) return;
    if (!w.headLock) {
      const rel = wrapDeg(headingTo(this.headAt, target) - this.steer.heading);
      const flat = Math.hypot(target[0] - this.headAt[0], target[2] - this.headAt[2]);
      const up = Math.atan2(target[1] - this.headAt[1], Math.max(0.05, flat)) / DEG;
      // Walking, the head mostly faces where it goes.
      const k = this.moving ? 0.3 : 1;
      const yaw = clamp(rel * 0.85, -80, 80) * k;
      const pitch = clamp(-up * 0.7, -40, 30) * k;
      this.puppet.add('head', pitch, yaw, 0);
      this.lookYaw = yaw;
    }
    this.aimEyes(target);
  }

  /** The eyes take whatever the head does not. */
  private aimEyes(target: V3): void {
    const head = this.puppet.current('head');
    const rel = wrapDeg(headingTo(this.headAt, target) - this.steer.heading - head[1]);
    const flat = Math.hypot(target[0] - this.headAt[0], target[2] - this.headAt[2]);
    const up = Math.atan2(target[1] - this.headAt[1], Math.max(0.05, flat)) / DEG;
    const face = this.model.face;
    face.look.x = clamp(rel / 40, -1, 1);
    face.look.y = clamp((-up - head[0]) / 35, -1, 1);
  }

  /** A point to look at for each kind of gaze. */
  pointFor(kind: Gaze): V3 | null {
    const toys = this.env.toys;
    switch (kind) {
      case 'owner':
        return this.env.owner();
      case 'box':
        return [toys.box.position[0], 0.15, toys.box.position[2]];
      case 'nothing':
        return EMPTY_CORNER;
      case 'toy':
        return toys.laser.on ? toys.laser.position : toys.ball.position;
      case 'cat': {
        const n = this.nearest().cat;
        return n ? n.headAt : null;
      }
      case 'bird':
        return toys.bird.position;
    }
  }

  /** Direct effects after the springs: the gait, crouch, squash, puffed tail and the tumble springs. */
  private after(dt: number): void {
    const p = this.puppet;
    const w = this.want;
    this.gait();
    // Crouching low: the body sinks and the legs are lifted back into it, so the paws stay put.
    const k = TAU * 2.5;
    this.crouchV += dt * (k * k * (w.low - this.crouch) - 2 * 0.6 * k * this.crouchV);
    this.crouch += dt * this.crouchV;
    p.shift('body', 0, -this.crouch, 0);
    for (const leg of LEGS) p.shift(`leg.${leg}`, 0, this.crouch, 0);
    // Liquid: the whole cat flattens, spreads and shortens about the floor point under it.
    this.squashed = damp(this.squashed, w.squash, 3, dt);
    const q = this.squashed;
    this.rootBone.scale.set(1 + 0.25 * q, 1 - 0.45 * q, 1 - 0.3 * q);
    // Squashed into the box the head fills its width, and whiskers sticking out sideways
    // would go through the walls, so they fold back along the head. Untouched otherwise,
    // so explode keeps sole charge of their positions.
    const fold = clamp(q / 0.4, 0, 1) * WHISKER_FOLD;
    if (fold !== this.whiskerFolded) {
      this.whiskerFolded = fold;
      for (const f of this.whiskerFold) {
        f.mesh.quaternion.setFromAxisAngle(f.axis, f.s * fold);
        f.mesh.position.copy(f.pivot).sub(v1.copy(f.pivot).applyQuaternion(f.mesh.quaternion));
      }
    }
    // Puffed up like a bottle brush: the tail swells across its length.
    const pts = this.dims.tail.points;
    const axis: V3 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
    p.stretch(this.tail[0], 1, axis, 1 + 0.4 * this.puffed);
    this.tumbleRoll.step(dt, w.roll, w.tumbleHz);
    this.tumblePitch.step(dt, w.pitch, w.tumbleHz);
  }

  /**
   * The legs in the gait, turned directly after the springs so they stay in step with the
   * ground. Each paw sweeps back at a steady rate while it is down (its stance, centred on
   * the leg upright) and swings forward with the shin tucked while it is up. The swing angle
   * comes from the stride: a paw that is down for `duty` of a cycle while the body covers
   * `stride` must sweep duty × stride under the hip, so sin S = duty × stride / 2L.
   */
  private gait(): void {
    const s = this.steer;
    const amount = s.amount;
    if (amount < 0.02) {
      this.gaitLoad = 0;
      return;
    }
    const b = s.blend;
    const stride = b.walk * STRIDE.walk + b.trot * STRIDE.trot + b.run * STRIDE.run;
    const duty = b.walk * DUTY.walk + b.trot * DUTY.trot + b.run * DUTY.run;
    const offsets = b.run > 0.5 ? BOUND : DIAGONAL;
    const S = Math.asin(clamp((duty * stride) / (2 * this.legLength), 0, 0.85)) / DEG;
    const half = duty * Math.PI;
    const lift = 50 + 30 * b.run;
    const p = this.puppet;
    for (const leg of LEGS) {
      const u = (((s.phase + offsets[leg] + half) % TAU) + TAU) % TAU;
      let angle: number;
      let shin = 0;
      if (u < 2 * half) {
        angle = -S + (2 * S * u) / (2 * half);
      } else {
        const k = (u - 2 * half) / (TAU - 2 * half);
        const e = k * k * (3 - 2 * k);
        angle = S - 2 * S * e;
        shin = lift * Math.sin(Math.PI * k);
      }
      p.turn(`leg.${leg}`, angle * amount);
      if (shin) p.turn(`shin.${leg}`, shin * amount);
    }
    this.gaitLoad = amount * (0.4 + 0.4 * b.run);
  }

  /**
   * Puts the rig in the world: at the steering's point and heading, tumbled about the body
   * centre, and raised so its lowest point rests on whatever is under it (the floor, the
   * keyboard, the cushion), plus any lift or hold the act asks for.
   */
  place(dt = 1 / 120): void {
    const s = this.steer;
    const w = this.want;
    const root = this.model.root;
    q1.setFromAxisAngle(UP, s.heading * DEG);
    q2.setFromAxisAngle(AZ, this.tumbleRoll.x * DEG).multiply(q3.setFromAxisAngle(AX, this.tumblePitch.x * DEG));
    root.quaternion.copy(q1).multiply(q2);
    // position = P + Ry·(c − Rt·c): the tumble turns about the body centre.
    const c = v1.set(this.centre[0], this.centre[1], this.centre[2]);
    const tc = v2.copy(c).applyQuaternion(q2);
    c.sub(tc).applyQuaternion(q1);
    root.position.set(s.x + c.x, c.y, s.z + c.z);
    root.updateMatrixWorld(true);

    // Lying, the folded legs may sink a little into what is under the cat. The tuck is the
    // same angles for every breed, so long legs prop the body up off the surface otherwise.
    this.legSink = damp(this.legSink, this.shownPosture === 'lie' ? LEG_SINK : 0, 6, dt);
    let low = Infinity;
    let need = -Infinity;
    const at = v1;
    for (let i = 0; i < this.contacts.length; i++) {
      this.worldOf(this.contacts[i], at);
      const sink = i < 4 ? this.legSink : 0;
      low = Math.min(low, at.y + sink);
      if (this.env) need = Math.max(need, this.groundAt(at.x, at.z) - at.y - sink);
      if (i < 4) {
        const paw = this.paws[LEGS[i]];
        paw[0] = at.x;
        paw[1] = at.y;
        paw[2] = at.z;
      }
    }
    // Props under the cat lift it gradually, so stepping onto the keyboard is not a jump.
    const floor = -low;
    const extra = this.env ? Math.max(0, need - floor) : 0;
    this.groundLift = damp(this.groundLift, extra, 18, dt);
    let y = floor + this.groundLift;
    if (w.hold !== null) y = Math.max(y, w.hold - this.centre[1]);
    y += w.lift;
    this.lift = Math.max(0, y - floor - this.groundLift);
    root.position.y += y;
    root.updateMatrixWorld(true);
    for (const leg of LEGS) this.paws[leg][1] += y;
    this.worldOf(this.headPoint, at);
    this.headAt[0] = at.x;
    this.headAt[1] = at.y;
    this.headAt[2] = at.z;
  }

  /** Height of the surface under a floor point: the cushion, the keyboard, the bed's pad, the box floor or the floor. */
  groundAt(x: number, z: number): number {
    const t = this.env.toys;
    const p: V3 = [x, 0, z];
    if (t.cushion.contains(p, 0.01)) return t.cushion.size[1] * (1 - 0.28 * t.cushion.dent);
    if (t.keyboard.contains(p, 0)) return t.keyboard.size[1];
    if (t.bed.contains(p, 0.1)) return 0.064;
    if (t.box.contains(p, 0.01)) return 0.006;
    return 0;
  }

  private faceStep(dt: number): void {
    const face = this.model.face;
    const w = this.want;
    face.expression = this.role?.face ?? w.face ?? this.act.face ?? this.mood.face(this.actName);
    this.pupils = damp(this.pupils, w.wide ?? FEELINGS[this.mood.mood].pupil, 5, dt);
    face.dilate = clamp(this.pupils, 0, 1);
    face.talk = w.talk;
    const real = face as unknown as { autoBlink?: boolean; blinks?: number };
    if (w.blink !== null) {
      if (real.autoBlink !== undefined) real.autoBlink = false;
      face.blink = w.blink;
    } else if (real.autoBlink === false) real.autoBlink = true;
    face.update(this.time, this.rng);
    if (real.blinks !== undefined && real.blinks !== this.lastBlinks) {
      this.lastBlinks = real.blinks;
      if (w.blink === null) this.blinkMs = 160;
    }
  }

  /** The tail tip, tail bands, pads, ears, whiskers, antenna, charms and the tag, by act and mood. */
  private lights(): void {
    const m = this.model;
    const t = this.time;
    const a = this.actName;
    const mood = this.mood.mood;
    const wave = (i: number, hz: number) => 0.5 + 0.5 * Math.sin(TAU * (t * hz - i * 0.22));
    let tip = 0.5 + 0.1 * Math.sin(t * 0.8);
    let bands = 0.15 + 0.3 * wave(1, 0.25) ** 6;
    let pads = 0.25;
    let ears = 0.3;
    let whiskers = 0.25 + 0.2 * Math.max(0, Math.sin(t * 0.9));
    let antenna = (t * 0.8) % 1 < 0.08 ? 1 : 0.15;
    let charms = 0.4;
    let beacon = 0.6;
    if (a === 'chatter') {
      tip = Math.sin(t * 26) > 0 ? 1 : 0.2;
      bands = Math.floor(t * 3.5) % 2 ? 1 : 0.1;
      whiskers = Math.sin(t * 18 * TAU) > 0 ? 1 : 0.1;
      ears = 1;
    } else if (a === 'zoomies' || a === 'tailChase' || a === 'chase' || a === 'flee') {
      tip = 0.9;
      bands = wave(0, 2.5);
      whiskers = 0.8;
      antenna = Math.sin(t * 20) > 0 ? 1 : 0.2;
    } else if (a === 'pounce' || a === 'knock' || a === 'ball' || mood === 'focused') {
      tip = 0.6 + 0.4 * Math.max(0, Math.sin(t * 8));
      whiskers = 1;
      ears = 0.9;
    } else if (a === 'fitsCheck') {
      whiskers = 0.6 + 0.4 * Math.sin(t * 12);
      ears = 0.6;
    } else if (mood === 'love' || a === 'slowBlink' || a === 'knead' || a === 'purr') {
      tip = 0.6 + 0.4 * wave(0, 0.8);
      bands = wave(2, 0.8);
      charms = 0.6 + 0.4 * wave(0, 0.8);
      beacon = 0.6 + 0.4 * wave(0, 0.8);
    } else if (a === 'sleep' || a === 'loaf' || mood === 'sleepy') {
      tip = 0.1 + 0.25 * (0.5 + 0.5 * Math.sin(t * 1.1));
      bands = tip * 0.4;
      whiskers = 0;
      ears = 0.05;
      pads = 0.05;
      antenna = 0.05;
    } else if (mood === 'startled') {
      tip = Math.sin(t * 30) > 0 ? 1 : 0.4;
      bands = tip;
      whiskers = 1;
    } else if (mood === 'happy' || mood === 'playful') {
      tip = 0.85 + 0.15 * Math.sin(t * 3);
    } else if (mood === 'curious') {
      tip = 0.9;
      ears = 0.7;
      whiskers = 0.6;
    }
    // Pads glow while they carry weight.
    let down = 0;
    for (const leg of LEGS) if (this.pawsDown[leg]) down++;
    pads = Math.max(pads, down ? 0.15 + 0.1 * down : 0);
    const o = this.want.lights;
    m.light(DOT.tailTip, clamp(o?.tailTip ?? tip, 0, 1));
    m.light(DOT.tailBands, clamp(o?.tailBands ?? bands, 0, 1));
    m.light(DOT.pads, clamp(o?.pads ?? pads, 0, 1));
    m.light(DOT.ears, clamp(o?.ears ?? ears, 0, 1));
    m.light(DOT.whiskers, clamp(o?.whiskers ?? whiskers, 0, 1));
    m.light(DOT.antenna, clamp(o?.antenna ?? antenna, 0, 1));
    m.light(DOT.charms, clamp(o?.charms ?? charms, 0, 1));
    const mat = m.materials.beacon;
    if (mat instanceof MeshStandardMaterial) {
      const tone = FEELINGS[mood].tone;
      const want = tone ? linearColour(tone, this.scratch) : this.baseTone;
      this.tone.lerp(want, 0.05);
      mat.emissive.copy(this.tone);
    }
    setLight(m.materials, 'beacon', clamp(o?.beacon ?? beacon, 0, 1));
  }

  /** The live numbers the readout publishes, measured from the rig and the springs. */
  private measure(dt: number): void {
    const p = this.puppet;
    const w = this.want;
    // Paws on the floor: the gait's pattern while walking, where they actually are otherwise.
    const moving = this.moving;
    for (const leg of LEGS) {
      const paw = this.paws[leg];
      const ground = this.groundAt(paw[0], paw[2]);
      this.pawsDown[leg] = moving ? this.steer.paws[leg] && this.lift < 0.01 : paw[1] - ground < 0.025;
    }
    // Tail carriage: the chord from the base to the tip, degrees above level.
    const base = this.model.bones.get(this.tail[0])!.getWorldPosition(v1);
    const tip = this.worldOf(this.tailTip, v2);
    this.tailCarriage = Math.atan2(tip.y - base.y, Math.hypot(tip.x - base.x, tip.z - base.z)) / DEG;
    // Whisker span, tip to tip, as seen from above, in the gauge's units (see GAUGE_OPENING).
    const [l, r] = this.whiskerTips;
    const wl = this.worldOf(l, v1);
    const lx = wl.x;
    const lz = wl.z;
    const wr = this.worldOf(r, v2);
    this.whiskerSpan = (Math.hypot(wr.x - lx, wr.z - lz) / this.whiskerRest) * GAUGE_OPENING;

    this.squash = this.squashed;
    this.purrHz = w.purr > 0 ? w.purr : damp(this.purrHz, 0, 6, dt);
    if (this.purrHz < 0.5 && w.purr === 0) this.purrHz = 0;

    // Servo load: how fast each group's springs are moving, plus the weight it carries.
    const dyn = (v: number) => 1 - Math.exp(-v / 260);
    const posture = this.shownPosture;
    const bearing = (leg: LegName) => {
      if (!this.pawsDown[leg]) return 0.04;
      if (posture === 'lie') return 0.06;
      if (posture === 'sit') return leg[0] === 'B' ? 0.5 : 0.3;
      return 0.32;
    };
    const legLoad = (leg: LegName) => bearing(leg) + 0.6 * dyn(p.load(`leg.${leg}`) + p.load(`shin.${leg}`)) + this.gaitLoad;
    const target: CatReadout['load'] = {
      head: 0.08 + 0.7 * dyn(p.load('head')),
      body: 0.12 + 0.6 * dyn(p.load('body') + p.load('root')) + 0.4 * this.squashed,
      ears: 0.04 + 0.8 * dyn(p.loadOf('ear.') * 0.5),
      FL: legLoad('FL'),
      FR: legLoad('FR'),
      BL: legLoad('BL'),
      BR: legLoad('BR'),
      tail: 0.05 + 0.8 * dyn(p.loadOf('tail.') * 0.6),
    };
    for (const k of Object.keys(target) as (keyof CatReadout['load'])[]) this.load[k] = damp(this.load[k], clamp(target[k], 0, 1), 10, dt);
  }

  /** Tail spring energy as a 0..1 liveliness: the swing amplitude it implies, over 40°. */
  tailEnergy(): number {
    let e = 0;
    for (const b of this.tail) e += this.puppet.energy(b);
    return clamp(Math.sqrt(2 * e) / 40, 0, 1);
  }

  readout(): CatReadout {
    const s = this.steer;
    const head = this.puppet.current('head');
    const earL = this.puppet.current('ear.L');
    const earR = this.puppet.current('ear.R');
    return {
      id: this.id,
      name: this.name,
      mood: this.mood.mood,
      act: this.actName,
      actT: this.role ? this.roleT : this.actT,
      posture: this.shownPosture,
      position: [s.x, this.lift, s.z],
      heading: s.heading,
      speed: s.speed,
      gaitPhase: s.phase,
      gait: s.gait,
      paws: { ...this.pawsDown },
      load: { ...this.load },
      tailEnergy: this.tailEnergy(),
      tailCarriage: this.tailCarriage,
      tailState: this.tailStateName,
      earAzimuth: [earL[1], earR[1]],
      headYaw: head[1],
      gazeTarget: this.gaze,
      attention: { ...this.attention },
      pupil: this.model.face.dilate,
      blinkMs: this.blinkMs,
      squash: this.squash,
      purrHz: this.purrHz,
      liquid: this.squash > 0.3,
      bellyArmed: this.want.belly,
      whiskerSpan: this.whiskerSpan,
    };
  }
}
