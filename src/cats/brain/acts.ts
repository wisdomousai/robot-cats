import { TAIL_SEMAPHORE } from '../cliches';
import { clamp, ease, pulse, span } from '../math/ease';
import { bound, POUNCE } from '../rig/moves';
import type { LegName, Mood, V3 } from '../types';
import type { Cat, CatAct } from './cat';
import { headingTo, wrapDeg } from './steer';

/**
 * The cat's acts: solo behaviour for free play, the acts the behaviour buttons start, and
 * the demo act of every subsystem row in cliches.ts. Each act is a CatAct: a weight for
 * free play (0 for demo-only acts), a length, and a pose function called every step with the
 * seconds since the act began.
 *
 * Acts that go somewhere first call `cat.goTo` every step and time their moves from
 * `cat.since()`, which is -1 while the cat is still walking. Most demos are staged for the
 * default camera (three-quarter view from the front right): the cat turns its face or its
 * side to the camera, and poses are bigger than a real cat's so they read at that distance.
 *
 * Angles follow the puppet: + pitch tips the chest or head down and swings a leg back,
 * + yaw turns toward the cat's left, + pitch on the tail raises it.
 */

const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;
/** Heading that shows a cat's face to the default camera, and the two side-on headings. */
const TO_CAMERA = 32;
const SIDE_ON = TO_CAMERA + 90;
/** The floor area acts pick points in, a little inside the walls. */
const ROAM = { x: 1.2, z: 0.75 };
/** Sound source the ears follow in the listening demo when the cursor is still. */
const SOUND_RADIUS = 1.2;

/** A floor point in a prop's frame (x along its width, z toward its front) in world coordinates. */
function frame(origin: V3, yaw: number, lx: number, lz: number): V3 {
  const h = yaw * DEG;
  const c = Math.cos(h);
  const s = Math.sin(h);
  return [origin[0] + lx * c + lz * s, 0, origin[2] - lx * s + lz * c];
}

/** Small named state machine for acts with stages. */
class Stages<S extends string> {
  state: S;
  at = 0;
  constructor(readonly first: S) {
    this.state = first;
  }
  go(next: S, now: number): void {
    this.state = next;
    this.at = now;
  }
  reset(now = 0): void {
    this.state = this.first;
    this.at = now;
  }
  t(now: number): number {
    return now - this.at;
  }
}

/** Rows of TAIL_SEMAPHORE by state name. */
const ROW = (state: string) => TAIL_SEMAPHORE.findIndex((r) => r.state === state);
const ROW_MOOD: Record<string, Mood> = {
  pleased: 'happy',
  love: 'love',
  calm: 'calm',
  sleepy: 'sleepy',
  cross: 'cross',
  startled: 'startled',
};

/**
 * A circuit round the room that misses every prop, anticlockwise seen from above. Zoomies
 * run it, and so does the cat being chased.
 */
export const ROOM_LAP: readonly V3[] = [
  [0.95, 0, 0.62],
  [0.8, 0, -0.08],
  [0.05, 0, -0.32],
  [-0.65, 0, -0.08],
  [-0.95, 0, 0.62],
  [0, 0, 0.72],
];

export function makeActs(cat: Cat): Record<string, CatAct> {
  const p = cat.puppet;
  const rng = cat.rng;
  const env = () => cat.env;
  const toys = () => cat.env.toys;
  const w = () => cat.want;
  const s = cat.steer;

  /** A free floor point: away from the props and the other cats. */
  const freePoint = (near?: number): V3 => {
    const obstacles = env().obstacles(cat);
    for (let i = 0; i < 12; i++) {
      const q: V3 = near
        ? [s.x + rng.range(-near, near), 0, s.z + rng.range(-near, near)]
        : [rng.range(-ROAM.x, ROAM.x), 0, rng.range(-ROAM.z, ROAM.z)];
      q[0] = clamp(q[0], -ROAM.x, ROAM.x);
      q[2] = clamp(q[2], -ROAM.z, ROAM.z);
      if (obstacles.every((o) => Math.hypot(q[0] - o.x, q[2] - o.z) > o.r + 0.26)) return q;
    }
    return [rng.range(-0.6, 0.6), 0, rng.range(0, 0.6)];
  };

  /** Walking about between free points, pausing at each. */
  const roam = (hurry: number, pause: [number, number], reach?: number): CatAct => {
    let goal: V3 = [0, 0, 0];
    let wait = 0;
    return {
      weight: 0,
      length: [4, 7],
      start() {
        goal = freePoint(reach);
        wait = rng.range(...pause);
      },
      pose(t) {
        cat.goTo(goal, hurry);
        if (cat.since(t) > wait) {
          goal = freePoint(reach);
          wait = rng.range(...pause);
          cat.goTo(goal, hurry);
        }
      },
    };
  };

  /** Lifts a front paw to the face: the base of grooming, batting and knocking. */
  const pawUp = (leg: 'FL' | 'FR', k: number, reach = -70, fold = 100) => {
    p.add(`leg.${leg}`, reach * k);
    p.add(`shin.${leg}`, fold * k);
  };

  // ---------- The box, shared by fits, fitsCheck and boxOverBed ----------

  type BoxStage = 'approach' | 'measure' | 'hop' | 'turn' | 'settle' | 'out' | 'done';
  const box = new Stages<BoxStage>('approach');
  let hopFrom: V3 = [0, 0, 0];
  let hopTo: V3 = [0, 0, 0];
  const boxFront = () => {
    const b = toys().box;
    return frame(b.position, b.yaw, 0, b.size[2] / 2 + 0.43);
  };
  const boxInside = () => {
    const b = toys().box;
    return frame(b.position, b.yaw, 0, 0.0);
  };
  /** One step of getting into the box. `measure` adds the whisker check at the opening. */
  const boxStep = (t: number, measure: boolean, hurry: number, endAt: number) => {
    const b = toys().box;
    const W = w();
    const into = b.yaw + 180;
    switch (box.state) {
      case 'approach': {
        cat.goTo(boxFront(), hurry, { arrive: 0.07, facing: into });
        if (cat.since(t) >= 0 && Math.abs(wrapDeg(s.heading - into)) < 12) box.go(measure ? 'measure' : 'hop', t);
        if (cat.since(t) > 2.5) box.go(measure ? 'measure' : 'hop', t);
        break;
      }
      case 'measure': {
        // Head into the opening, swept side to side: the whiskers against the walls.
        const u = box.t(t);
        const k = ease(u, 0, 0.5);
        p.add('body', 10 * k);
        p.add('head', 22 * k, 16 * Math.sin(u * TAU * 0.7) * k, 10 * Math.sin(u * TAU * 0.35) * k);
        W.low = 0.03 * k;
        W.look = [b.position[0], 0.05, b.position[2]];
        W.gaze = 'box';
        W.headLock = true;
        W.face = 'focused';
        cat.earsUp(1);
        if (u > 2.6) box.go('hop', t);
        break;
      }
      case 'hop': {
        if (box.t(t) < 1 / 60) {
          hopFrom = [s.x, 0, s.z];
          hopTo = boxInside();
        }
        const u = clamp(box.t(t) / 0.75, 0, 1);
        const e = ease(u, 0, 1);
        s.x = hopFrom[0] + (hopTo[0] - hopFrom[0]) * e;
        s.z = hopFrom[2] + (hopTo[2] - hopFrom[2]) * e;
        s.face(into);
        W.lift = 0.3 * Math.sin(Math.PI * u);
        const tuck = Math.sin(Math.PI * u);
        p.add('leg.FL', -45 * tuck);
        p.add('leg.FR', -45 * tuck);
        p.add('leg.BL', 40 * tuck);
        p.add('leg.BR', 40 * tuck);
        p.add('shin.FL', 70 * tuck);
        p.add('shin.FR', 70 * tuck);
        p.add('body', -12 * Math.sin(TAU * u * 0.5) * (1 - u));
        if (u >= 0.6) b.enter(cat.id);
        if (u >= 1) box.go('turn', t);
        break;
      }
      case 'turn': {
        s.face(b.yaw);
        W.squash = 0.4;
        if (box.t(t) > 1.1) box.go('settle', t);
        break;
      }
      case 'settle': {
        s.face(b.yaw);
        cat.posture = 'lie';
        W.squash = 1;
        W.look = env().owner();
        W.gaze = 'box';
        W.face = 'sheepish';
        W.blink = 0.25 + 0.2 * pulse(box.t(t) % 4, 2.6, 3, 3.4);
        if (t > endAt) box.go('out', t);
        break;
      }
      case 'out': {
        // Out over the front wall, facing the camera, before the next act walks off.
        if (box.t(t) < 1 / 60) {
          hopFrom = [s.x, 0, s.z];
          hopTo = boxFront();
          cat.posture = 'stand';
        }
        const u = clamp(box.t(t) / 0.7, 0, 1);
        const e = ease(u, 0, 1);
        s.x = hopFrom[0] + (hopTo[0] - hopFrom[0]) * e;
        s.z = hopFrom[2] + (hopTo[2] - hopFrom[2]) * e;
        s.face(b.yaw);
        W.lift = 0.28 * Math.sin(Math.PI * u);
        W.squash = 1 - u;
        const tuck = Math.sin(Math.PI * u);
        p.add('leg.FL', -40 * tuck);
        p.add('leg.FR', -40 * tuck);
        p.add('leg.BL', 40 * tuck);
        p.add('leg.BR', 40 * tuck);
        if (u >= 0.4) b.leave(cat.id);
        if (u >= 1) box.go('done', t);
        break;
      }
      case 'done':
        break;
    }
    // Inside, the box is not something to steer round.
    if (box.state !== 'approach' && box.state !== 'measure' && box.state !== 'done') {
      s.stop();
      s.ignore = 'box';
    }
  };
  const boxAct = (measure: boolean, length: [number, number], weight: number): CatAct => ({
    weight,
    length,
    when: () => toys().box.occupant === null && !env().claimedBy('box'),
    start() {
      box.reset();
      env().claim('box', cat);
    },
    pose(t) {
      boxStep(t, measure, 0.8, cat.actLen - 0.8);
    },
    end() {
      toys().box.leave(cat.id);
    },
  });

  // ---------- The ledge and the cup ----------

  type KnockStage = 'approach' | 'rear' | 'down';
  const knock = new Stages<KnockStage>('approach');
  let swiped = 0;
  const knockSpot = (): V3 => {
    const cup = toys().cup.home;
    // Close enough that the front paws, up on the ledge, land just short of the cup.
    return [cup[0] - 0.25, 0, cup[2]];
  };

  // ---------- Kneading ----------

  let kneadPrev: Record<'FL' | 'FR', boolean> = { FL: false, FR: false };

  // ---------- Rolling over ----------

  let grabbedAt = -1;
  /** Whether the pointer was over the belly last step, so a touch is the step it arrives. */
  let handIn = false;
  /** Grabs during this roll; the trap closes on its own only when nothing touched it. */
  let rollGrabs = 0;

  // ---------- Zoomies ----------

  let loopAt = 0;
  let zoomGoal: V3 = [0, 0, 0];
  let swept = 0;
  let lastAngle = 0;

  // ---------- Keyboard ----------

  type KeyStage = 'approach' | 'across' | 'back' | 'lie';
  const keys = new Stages<KeyStage>('approach');

  // ---------- Bed then box ----------

  type BedStage = 'bed' | 'sniff' | 'box';
  const bed = new Stages<BedStage>('bed');

  // ---------- Ball ----------

  type BallStage = 'approach' | 'aim' | 'swipe' | 'watch';
  const ball = new Stages<BallStage>('approach');

  // ---------- Chatter ----------

  let burst = -1;

  // ---------- Pounce, prowl, headbutt ----------

  let leapAlong = 0;
  let leapFar = 0.5;
  let prowlGoal: V3 = [0, 0, 0];
  let buddy: Cat | null = null;
  let onCushion = false;

  const acts: Record<string, CatAct> = {
    // ---------- Standing about ----------

    idle: { weight: 1.2, length: [2, 4] },

    stand: {
      weight: 0.6,
      length: [2, 4],
      pose(t) {
        // A slow look round, left then right.
        p.add('head', 0, 30 * Math.sin(t * 0.8));
        w().headLock = false;
      },
    },

    sit: {
      weight: 2,
      length: [4, 8],
      posture: 'sit',
    },

    lie: {
      weight: 1,
      length: [6, 10],
      posture: 'lie',
      pose(t) {
        p.add('head', 4, 0, 6 * Math.sin(t * 0.3));
      },
    },

    loaf: {
      weight: 1.4,
      length: [6, 10],
      posture: 'lie',
      pose(t) {
        // Paws tucked in, eyes half shut, and the head sinking now and then.
        p.add('head', 6 + 4 * pulse(t % 5, 3, 3.8, 4.6));
        w().blink = 0.5 + 0.15 * Math.sin(t * 0.7);
      },
    },

    sleep: {
      weight: 0.9,
      length: [10, 18],
      posture: 'lie',
      pose(t) {
        const W = w();
        // Curled: head down on the paws and turned to the side, on one hip, deep slow breaths.
        const k = ease(t, 0, 1.5);
        p.add('head', 30 * k, 25 * k, 15 * k);
        p.add('body', 2.5 * Math.sin(t * TAU * 0.22));
        W.roll = 14 * k;
        W.tumbleHz = 0.8;
        W.blink = k;
        W.headLock = true;
        W.gaze = 'nothing';
        W.tail = 'wrap';
        cat.earsBack(0.3, 15);
      },
    },

    // ---------- Getting about ----------

    walk: { ...roam(0, [0.4, 1.5]), weight: 2.5, length: [5, 8] },
    trot: { ...roam(0.5, [0.3, 1]), weight: 1.1, length: [4, 6] },
    run: { ...roam(1, [0.2, 0.6]), weight: 0.45, length: [3, 5] },

    sniff: (() => {
      const r = roam(0, [1.2, 2.2], 0.6);
      return {
        ...r,
        weight: 1,
        length: [4, 6],
        pose(t: number) {
          r.pose!(t);
          // Nose down and twitching.
          const k = cat.walking ? 0.5 : 1;
          p.add('head', 32 * k + 3 * Math.sin(t * TAU * 5));
          cat.earsUp(0.6);
          const W = w();
          W.look = cat.local(0, 0.45, 0);
          W.gaze = 'nothing';
          W.headLock = true;
        },
      } satisfies CatAct;
    })(),

    prowl: {
      weight: 0.5,
      length: [5, 7],
      start() {
        const b = toys().ball.position;
        prowlGoal = cat.distTo(b) < 1.6 ? [b[0], 0, b[2]] : freePoint(1);
      },
      pose(t) {
        // Low and slow, head level and forward, eyes on the target.
        cat.goTo(prowlGoal, 0, { arrive: 0.3 });
        const W = w();
        W.low = 0.07;
        p.add('head', 8);
        cat.earsUp(1);
        W.look = [prowlGoal[0], 0.03, prowlGoal[2]];
        W.gaze = 'toy';
        W.tail = ROW('out, level');
        if (cat.since(t) > 0.5) p.add('root', 0, 0, 3 * Math.sin(t * 6) * ease(cat.since(t), 0.5, 1));
      },
    },

    // ---------- Grooming and stretching ----------

    stretch: {
      weight: 0.8,
      length: [4, 4.6],
      pose(t) {
        // Front stretch: chest to the floor and front legs out flat, rump up on straight hind legs.
        const a = span(t, 0.2, 1, 2, 2.5);
        p.add('body', 26 * a);
        p.add('leg.FL', -100 * a);
        p.add('leg.FR', -100 * a);
        p.add('shin.FL', -15 * a);
        p.add('shin.FR', -15 * a);
        p.add('leg.BL', -26 * a);
        p.add('leg.BR', -26 * a);
        p.add('head', -40 * a);
        w().talk = pulse(t, 0.9, 1.4, 1.9);
        w().blink = a * 0.9;
        // Back stretch: one hind leg pushed out behind.
        const b = span(t, 2.5, 3, 3.6, 4.1);
        p.add('body', -6 * b);
        p.add('leg.BL', 55 * b);
        p.add('shin.BL', -25 * b);
        p.add('head', -10 * b);
        w().headLock = a + b > 0.3;
      },
    },

    groom: {
      weight: 1.1,
      length: [5, 8],
      posture: 'sit',
      pose(t) {
        const W = w();
        W.headLock = true;
        W.gaze = 'nothing';
        W.blink = 0.55;
        const L = cat.actLen;
        const lick = span(t, 0.4, 0.9, L * 0.45, L * 0.5);
        const wipe = span(t, L * 0.45, L * 0.5, L * 0.72, L * 0.77);
        const chest = span(t, L * 0.75, L * 0.8, L - 0.5, L);
        // Paw to the mouth and licked.
        pawUp('FL', lick + wipe, -75, 105);
        p.add('head', (22 + 6 * Math.sin(t * TAU * 3)) * lick, 18 * lick, 8 * lick);
        W.talk = lick * (0.3 + 0.3 * Math.max(0, Math.sin(t * TAU * 3)));
        // The paw wiped over the face and ear.
        p.add('leg.FL', 18 * Math.sin(t * TAU * 1.4) * wipe);
        p.add('head', 18 * wipe, 25 * wipe, -18 * wipe + 8 * Math.sin(t * TAU * 1.4) * wipe);
        // Then the chest.
        p.add('head', (48 + 6 * Math.sin(t * TAU * 3)) * chest, 0, 0);
        W.talk += chest * 0.4 * Math.max(0, Math.sin(t * TAU * 3));
      },
    },

    yawn: {
      weight: 0.5,
      length: [2.6, 3.4],
      posture: 'sit',
      pose(t) {
        const k = span(t, 0.3, 0.9, 1.8, 2.4);
        p.add('head', -28 * k);
        const W = w();
        W.talk = k;
        W.blink = k;
        W.headLock = true;
        cat.earsBack(0.6 * k, 25);
      },
    },

    // ---------- Moods and tells ----------

    tailFlick: {
      weight: 0.5,
      length: [3, 5],
      posture: 'sit',
      pose(t) {
        const W = w();
        W.tail = 'act';
        cat.tailStateName = 'low, thumping';
        // Low and lashing side to side, each bone a beat behind.
        const base = -20 - cat.restElevation - p.target('body')[0];
        p.add(cat.tail[0], base);
        cat.tail.forEach((b, i) => p.add(b, i ? -4 : 0, 32 * Math.sin(t * TAU * 1.3 - i * 0.7)));
        cat.earsBack(0.7, 45);
      },
    },

    stareAtNothing: {
      weight: 0.5,
      length: [5, 7],
      posture: 'sit',
      pose(t) {
        const W = w();
        W.look = cat.pointFor('nothing');
        W.gaze = 'nothing';
        W.wide = 1;
        W.face = 'focused';
        cat.earsUp(1);
        // Now and then the head twitches as if it moved.
        p.add('head', 0, 6 * pulse(t % 3, 1.8, 1.9, 2.2));
      },
    },

    headbutt: {
      weight: 0.6,
      length: [4, 6],
      when: () => cat.nearest().d < 1.4,
      start() {
        buddy = cat.nearest().cat;
      },
      pose(t) {
        if (!buddy) return;
        const at = buddy.steer.position;
        const d = cat.distTo(at);
        const dir = d > 1e-3 ? [(s.x - at[0]) / d, (s.z - at[2]) / d] : [0, 1];
        cat.goTo([at[0] + dir[0] * 0.44, 0, at[2] + dir[1] * 0.44], 0.3, { arrive: 0.08, facing: cat.headingTo(at), ignore: buddy.id });
        const W = w();
        W.look = buddy.headAt;
        W.gaze = 'cat';
        const u = cat.since(t);
        if (u < 0) return;
        // Two pushes of the forehead, eyes shut, then a rub along the cheek.
        const push = pulse(u % 1.1, 0.1, 0.45, 0.9) * (u < 2.3 ? 1 : 0);
        p.add('head', 28 * push, 0, 12 * push);
        p.add('body', 8 * push);
        W.low = 0.03 * push;
        W.blink = push;
        W.purr = 25;
        cat.earsBack(0.4 * push, 20);
      },
    },

    tailChase: {
      weight: 0.35,
      length: [4, 6],
      pose(t) {
        const W = w();
        // Spinning after the tail: tail curled round to the head, head turned to it.
        const k = span(t, 0.3, 0.8, cat.actLen - 1.2, cat.actLen - 0.8);
        s.stop();
        s.spin(-120 * k * (1 / 120));
        p.add('head', 15 * k, -55 * k);
        p.add('body', 0, -15 * k);
        W.tail = 'act';
        cat.tail.forEach((b, i) => p.add(b, -10, -35 * k + (i === 0 ? -20 : 0)));
        W.face = k > 0.5 ? 'starry' : t > cat.actLen - 1 ? 'dizzy' : null;
        W.low = 0.04 * k;
        W.headLock = true;
        // Dizzy at the end: a wobble.
        const dizzy = ease(t, cat.actLen - 1, cat.actLen - 0.8);
        p.add('root', 0, 0, 4 * Math.sin(t * 4) * dizzy);
      },
    },

    // ---------- Play ----------

    pounce: {
      weight: 0.7,
      length: [POUNCE.end + 0.2, POUNCE.end + 0.4],
      start() {
        const b = toys().ball.position;
        const d = cat.distTo(b);
        if (d < 1.1 && d > 0.3) {
          s.face(cat.headingTo(b));
          leapFar = clamp(d - 0.2, 0.25, 0.7);
        } else leapFar = 0.5;
        leapAlong = 0;
      },
      pose(t) {
        const W = w();
        const b = bound(p, t, leapFar, 0.2);
        W.low = b.low;
        W.lift = b.height;
        W.pitch = b.pitch;
        W.tumbleHz = 6;
        W.face = 'focused';
        W.wide = 1;
        W.look = cat.local(0, leapFar + 0.2, 0.02);
        W.gaze = 'toy';
        cat.earsUp(1);
        // Forward along the arc.
        const step = b.along - leapAlong;
        leapAlong = b.along;
        if (step > 0) {
          const [fx, fz] = s.forward();
          s.nudge(fx * step, fz * step);
        }
        if (b.phase === 'land' && t < POUNCE.land + 0.05) {
          const ball = toys().ball;
          if (cat.distTo(ball.position) < 0.35) ball.bat(cat.local(0, 0.1), 0.5, 0.2);
        }
      },
    },

    ball: {
      weight: 0.7,
      length: [10, 14],
      mood: 'playful',
      when: () => !env().claimedBy('ball'),
      start() {
        ball.reset();
        env().claim('ball', cat);
      },
      pose(t) {
        const W = w();
        const b = toys().ball;
        W.look = b.position;
        W.gaze = 'toy';
        cat.earsUp(1);
        switch (ball.state) {
          case 'approach': {
            // Up to the ball from the side away from the room's middle, so the swipe sends it inward.
            const out = Math.hypot(b.position[0], b.position[2]) > 0.2 ? Math.atan2(b.position[0], b.position[2]) : rng.range(-Math.PI, Math.PI);
            const spot: V3 = [b.position[0] + Math.sin(out) * 0.24, 0, b.position[2] + Math.cos(out) * 0.24];
            cat.goTo(spot, cat.distTo(b.position) > 0.8 ? 0.7 : 0.25, { arrive: 0.08, facing: headingTo(spot, b.position) });
            if (cat.since(t) > 0.2 && Math.abs(wrapDeg(s.heading - cat.headingTo(b.position))) < 20) ball.go('aim', t);
            if (b.speed > 0.3) ball.go('approach', t);
            break;
          }
          case 'aim': {
            s.face(cat.headingTo(b.position));
            const u = ball.t(t);
            W.low = 0.05 * ease(u, 0, 0.3);
            W.wide = 1;
            p.add('root', 0, 0, 3 * Math.sin(u * 7) * ease(u, 0.2, 0.4));
            if (u > 0.7) ball.go('swipe', t);
            break;
          }
          case 'swipe': {
            const u = ball.t(t);
            W.low = 0.03;
            const k = pulse(u, 0, 0.12, 0.35);
            pawUp('FR', k, -55, 30);
            p.add('leg.FR', 0, 0, 25 * k);
            if (u > 0.1 && u - 1 / 120 <= 0.1) {
              const d = cat.distTo(b.position);
              if (d < 0.5) b.bat(cat.local(0.05, 0.05), rng.range(0.4, 0.65), rng.range(0, 0.28));
            }
            if (u > 0.4) ball.go('watch', t);
            break;
          }
          case 'watch': {
            W.face = 'starry';
            if (ball.t(t) > 0.6 + (b.speed > 0.2 ? 0.6 : 0)) ball.go('approach', t);
            break;
          }
        }
      },
    },

    roll: {
      weight: 0.4,
      length: [7, 8],
      mood: 'happy',
      start() {
        grabbedAt = -1;
        handIn = false;
        rollGrabs = 0;
        s.face(TO_CAMERA - 90);
      },
      pose(t) {
        const W = w();
        const L = cat.actLen;
        // Over onto the back, belly to the camera, legs folded in the air.
        const k = span(t, 0.5, 1.3, L - 1, L - 0.3);
        cat.posture = k > 0.5 ? 'lie' : 'stand';
        W.roll = 150 * k;
        W.tumbleHz = 1.4;
        p.add('leg.FL', -35 * k + 10 * Math.sin(t * 2.1) * k);
        p.add('leg.FR', -50 * k + 10 * Math.sin(t * 1.7 + 1) * k);
        p.add('shin.FL', 75 * k);
        p.add('shin.FR', 85 * k);
        p.add('leg.BL', -40 * k);
        p.add('leg.BR', -25 * k);
        p.add('shin.BL', 55 * k);
        p.add('shin.BR', 40 * k);
        p.add('head', -10 * k, 0, 25 * k);
        W.tail = 'act';
        cat.tail.forEach((b, i) => p.add(b, -cat.restElevation * (i ? 0.1 : 0.9), 8 * Math.sin(t * 1.5 + i)));
        W.look = env().owner();
        W.gaze = 'owner';
        W.face = 'happy';
        // Once a grab is over the belly is still up, so the trap sets again and the console's
        // armed flag agrees with the pose for as long as the belly is on display.
        if (grabbedAt >= 0 && t - grabbedAt > 2.1) grabbedAt = -1;
        const armed = k > 0.9 && grabbedAt < 0;
        W.belly = armed;
        // The trap: a touch on the belly closes it, and so does a moving pointer arriving over
        // it. A pointer left over the belly does not close it again; the follow camera keeps
        // nudging the pointer's floor point, so it would otherwise snap shut every time it set.
        // With no touch at all it closes on its own after 4.5 s.
        const cursor = env().cursor;
        const near = cursor !== null && cat.distTo(cursor) < 0.22;
        const arrived = near && !handIn && env().cursorAge < 0.6;
        handIn = near;
        if (armed && (env().bellyTouched(cat) || arrived || (rollGrabs === 0 && t > 4.5))) {
          grabbedAt = t;
          rollGrabs++;
          env().count('grabs');
          cat.mood.trigger('grab');
        }
        if (grabbedAt >= 0) {
          const g = span(t - grabbedAt, 0, 0.1, 1.6, 2.1);
          // Front legs clamp in, back legs kick.
          p.add('leg.FL', -25 * g);
          p.add('leg.FR', -25 * g);
          p.add('shin.FL', 30 * g);
          p.add('shin.FR', 30 * g);
          const kick = Math.sin((t - grabbedAt) * TAU * 6);
          p.add('leg.BL', -30 * kick * g);
          p.add('leg.BR', 30 * kick * g);
          p.add('head', 25 * g);
          W.face = 'determined';
          W.wide = 1;
          W.mood = 'playful';
          cat.earsBack(g, 40);
        }
      },
    },

    // ---------- The demos ----------

    listen: {
      weight: 0.5,
      length: [7, 8],
      posture: 'sit',
      start() {
        s.face(headingTo(s.position, env().owner()));
      },
      pose(t) {
        const W = w();
        // The head stays on the owner; the ears go wherever the sound is.
        W.headLock = true;
        W.look = env().owner();
        W.gaze = 'owner';
        const cursor = env().cursor;
        W.ears =
          cursor && env().cursorAge < 1.5
            ? cursor
            : cat.local(SOUND_RADIUS * Math.sin(t * 1.1), SOUND_RADIUS * Math.cos(t * 1.1) * 0.4 - 0.4, 0.3);
      },
    },

    ignore: {
      weight: 0.4,
      length: [7, 8],
      posture: 'sit',
      start() {
        s.face(headingTo(s.position, env().owner()));
      },
      pose(t) {
        const W = w();
        const owner = env().owner();
        if (t < 1.2) {
          W.look = owner;
          W.gaze = 'owner';
          return;
        }
        // Turned to the box, the whole body, with one ear left pointing back at the owner.
        const b = toys().box.position;
        s.face(cat.headingTo(b));
        W.look = [b[0], 0.15, b[2]];
        W.gaze = 'box';
        W.ears = owner;
        W.face = 'neutral';
        W.blink = 0.35;
      },
    },

    slowBlink: {
      weight: 0.5,
      length: [7.2, 7.6],
      posture: 'sit',
      start() {
        s.face(headingTo(s.position, env().owner()));
      },
      pose(t) {
        const W = w();
        if (t < 3) {
          // One slow blink at the owner: lids down over 0.6 s, held, then up over 0.6 s.
          W.look = env().owner();
          W.gaze = 'owner';
          W.headLock = false;
          W.blink = span(t, 0.7, 1.3, 1.7, 2.3);
          W.face = 'love';
          if (t >= 0.7 && t - 1 / 120 < 0.7) {
            cat.blinkMs = 1600;
            env().count('blinks');
            cat.mood.trigger('blink');
          }
          p.add('head', 6 * span(t, 0.7, 1.3, 1.7, 2.3), 0, 8 * span(t, 0.7, 1.3, 1.7, 2.3));
          return;
        }
        // Then a point high up to the cat's left front: pupils wide, ears forward, and nothing
        // there. That side keeps the face toward the head view's camera.
        W.look = cat.local(0.95, 0.75, 1.2);
        W.gaze = 'nothing';
        W.wide = 1;
        W.face = 'focused';
        W.mood = 'focused';
        cat.earsUp(1);
        p.add('body', -6 * ease(t, 3, 3.5));
      },
    },

    fitsCheck: boxAct(true, [10, 11], 0.35),
    fits: boxAct(false, [9, 10], 0.4),

    boxOverBed: {
      weight: 0.25,
      length: [10, 11],
      when: () => toys().box.occupant === null && !env().claimedBy('box') && !env().claimedBy('bed'),
      start() {
        bed.reset();
        box.reset();
        env().claim('box', cat);
        env().claim('bed', cat);
      },
      pose(t) {
        const b = toys().bed;
        const W = w();
        switch (bed.state) {
          case 'bed': {
            // To the edge of the bed on the side nearest the camera.
            // The bed is not steered round here, or the spot by its edge is never reached.
            const spot: V3 = [b.position[0] - 0.3, 0, b.position[2] + 0.38];
            cat.goTo(spot, 0.8, { arrive: 0.08, facing: headingTo(spot, b.position), ignore: 'bed' });
            W.look = [b.position[0], 0.08, b.position[2]];
            W.gaze = 'nothing';
            if (cat.since(t) > 0.3) bed.go('sniff', t);
            break;
          }
          case 'sniff': {
            const u = bed.t(t);
            p.add('head', 30 * span(u, 0, 0.3, 1, 1.3) + 3 * Math.sin(u * TAU * 5));
            p.add('body', 8 * span(u, 0, 0.3, 1, 1.3));
            W.look = [b.position[0], 0.05, b.position[2]];
            W.headLock = u < 1.2;
            if (u > 0.9) {
              // A look back at the owner, and off to the box.
              W.look = env().owner();
              W.gaze = 'owner';
            }
            if (u > 1.3) bed.go('box', t);
            break;
          }
          case 'box':
            boxStep(t, false, 1, cat.actLen - 0.8);
            break;
        }
      },
      end() {
        toys().box.leave(cat.id);
      },
    },

    knock: {
      weight: 0.35,
      length: [10, 11],
      when: () => toys().cup.onLedge && !env().claimedBy('ledge'),
      start() {
        knock.reset();
        swiped = 0;
        env().claim('ledge', cat);
      },
      pose(t) {
        const W = w();
        const cup = toys().cup;
        const ledge = toys().ledge;
        switch (knock.state) {
          case 'approach': {
            cat.goTo(knockSpot(), 0.8, { arrive: 0.02, facing: 90, ignore: 'ledge' });
            W.look = cup.position;
            W.gaze = 'toy';
            // The rear finishes the turn, so a rough heading is enough to start it.
            if (cat.since(t) >= 0 && Math.abs(wrapDeg(s.heading - 90)) < 25 && cup.onLedge && cup.state !== 'respawn') knock.go('rear', t);
            break;
          }
          case 'rear': {
            s.stop();
            s.ignore = 'ledge';
            s.face(90);
            const u = knock.t(t);
            // Up on the hind legs, front paws on the ledge top.
            const r = ease(u, 0, 0.7);
            p.add('body', -42 * r);
            p.add('leg.BL', 42 * r);
            p.add('leg.BR', 42 * r);
            p.add('leg.FL', -4 * r);
            p.add('leg.FR', -4 * r);
            p.add('shin.FL', 20 * r);
            p.add('shin.FR', 20 * r);
            p.add('head', 25 * r);
            W.tail = 'act';
            cat.tailStateName = 'up, hooked tip';
            p.add(cat.tail[0], 80 - cat.restElevation + 42 * r);
            p.add(cat.tail[cat.tail.length - 1], 40 + 10 * Math.sin(u * 3));
            // Pats: two small ones, then the one that sends the cup over. Eye contact in between.
            // They come quickly, so the cup is on the floor while the demo's callout is up.
            const pats = [0.8, 1.4, 2.0];
            let pat = 0;
            for (const at of pats) pat = Math.max(pat, pulse(u, at, at + 0.15, at + 0.45));
            p.add('leg.FL', -40 * pat, 0, -20 * pat);
            p.add('shin.FL', -15 * pat);
            for (let i = 0; i < pats.length; i++) {
              if (u >= pats[i] + 0.15 && swiped === i) {
                swiped++;
                const last = i === pats.length - 1;
                cup.knock([0.15, 1], last ? 0.75 : 0.07);
                cat.mood.trigger(last ? 'knocked' : 'toy', 0.5);
              }
            }
            // Between pats the head turns to the camera and holds it, and holds it after the last.
            const looking = (u > 1.05 && u < 1.3) || (u > 1.65 && u < 1.9) || (u > 2.1 && u < 4.2);
            if (looking) {
              W.look = env().owner();
              W.gaze = 'owner';
              W.face = 'determined';
            } else {
              W.look = cup.state === 'falling' || cup.state === 'down' ? cup.position : [cup.position[0], ledge.top, cup.position[2]];
              W.gaze = 'toy';
              W.face = 'focused';
            }
            cat.earsUp(1);
            if (u > 4.4) knock.go('down', t);
            break;
          }
          case 'down': {
            s.ignore = 'ledge';
            const u = knock.t(t);
            const r = 1 - ease(u, 0, 0.6);
            p.add('body', -42 * r);
            p.add('leg.BL', 42 * r);
            p.add('leg.BR', 42 * r);
            p.add('head', 25 * r);
            cat.posture = u > 0.6 ? 'sit' : 'stand';
            s.face(TO_CAMERA + 40);
            W.look = env().owner();
            W.gaze = 'owner';
            W.face = 'happy';
            break;
          }
        }
      },
    },

    knead: {
      weight: 0.6,
      length: [8, 10],
      mood: 'love',
      start() {
        kneadPrev = { FL: false, FR: false };
        onCushion = env().claim('cushion', cat);
      },
      pose(t) {
        const W = w();
        const c = toys().cushion;
        if (onCushion) cat.goTo([c.position[0], 0, c.position[2] - 0.04], 0.5, { arrive: 0.05, facing: TO_CAMERA - 10 });
        const u = cat.since(t);
        W.look = env().owner();
        W.gaze = 'owner';
        if (u < 0) return;
        // Standing low at the back, the front paws pressing in turn.
        const k = ease(u, 0, 0.5);
        W.low = 0.04 * k;
        p.add('leg.BL', -12 * k);
        p.add('leg.BR', -12 * k);
        const rate = 1.3;
        for (const [leg, phase] of [['FL', 0], ['FR', Math.PI]] as const) {
          const v = Math.sin(u * TAU * rate + phase);
          const up = Math.max(0, v);
          pawUp(leg, up * k, -24, 45);
          const down = v < -0.2;
          if (down && !kneadPrev[leg] && k > 0.5) {
            env().count('biscuits');
            if (onCushion && c.contains(cat.paws[leg], 0)) c.press(1);
          }
          if (down && onCushion) c.press(0.5);
          kneadPrev[leg] = down;
        }
        W.purr = 25;
        W.blink = 0.6 * k;
        W.face = 'love';
        p.add('head', 6 * k, 0, 8 * Math.sin(u * 0.8) * k);
        cat.earsBack(0.2 * k, 10);
      },
    },

    zoomies: {
      weight: 0.35,
      length: [8, 9],
      mood: 'playful',
      start() {
        // Start the loop at the waypoint nearest ahead, so the first dash is not back across the room.
        let best = 0;
        let bestD = Infinity;
        ROOM_LAP.forEach((q, i) => {
          const d = cat.distTo(q);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        loopAt = (best + 1) % ROOM_LAP.length;
        zoomGoal = jitter(ROOM_LAP[loopAt]);
        swept = 0;
        lastAngle = Math.atan2(s.x, s.z);
      },
      pose(t) {
        const W = w();
        const end = cat.actLen - 1.3;
        if (t < end) {
          cat.goTo(zoomGoal, 1.5, { arrive: 0.3, through: true });
          if (cat.since(t) >= 0) {
            loopAt = (loopAt + 1) % ROOM_LAP.length;
            zoomGoal = jitter(ROOM_LAP[loopAt]);
            cat.goTo(zoomGoal, 1.5, { arrive: 0.3, through: true });
          }
          W.low = 0.035;
          W.wide = 1;
          W.face = 'determined';
          W.tail = ROW('up, puffed');
          W.puff = 0.8;
          cat.earsBack(0.8, 35);
        } else {
          // And then it stops dead and sits, as if nothing happened.
          cat.goTo(null);
          cat.posture = 'sit';
          W.look = cat.pointFor('nothing');
          W.gaze = 'nothing';
          W.face = 'neutral';
          W.tail = 'wrap';
        }
        // Laps: the angle swept round the middle of the room, a lap per full turn.
        const a = Math.atan2(s.x, s.z);
        let d = a - lastAngle;
        if (d > Math.PI) d -= TAU;
        if (d < -Math.PI) d += TAU;
        lastAngle = a;
        swept += Math.abs(d);
        if (swept >= TAU) {
          swept -= TAU;
          env().count('laps');
        }
      },
    },

    dropTest: {
      weight: 0,
      length: [8.6, 8.8],
      pose(t) {
        const W = w();
        const cycle = 4.3;
        const u = t % cycle;
        const H = 0.6;
        const rise = ease(u, 0, 0.8);
        const release = 1.6;
        const g = 9.81;
        const cy = cat.centre[1];
        let height = H * rise;
        if (u > release) height = Math.max(0, H - 0.5 * g * (u - release) ** 2);
        const falling = u > release && height > 0;
        W.hold = cy + height;
        // Picked up and turned over by the hand; let go upside down; turned upright on the way down.
        if (u < release) {
          W.roll = 180 * ease(u, 0.6, 1.4);
          W.tumbleHz = 1.2;
          // Legs hang loose while held.
          for (const leg of ['FL', 'FR', 'BL', 'BR'] as LegName[]) p.add(`leg.${leg}`, 8 * Math.sin(u * 3 + leg.length), 0, 0);
          W.face = 'surprised';
          W.look = env().owner();
          W.gaze = 'owner';
        } else {
          W.roll = 0;
          W.tumbleHz = 4.5;
          // Front half first: the head leads the turn.
          if (falling) p.add('head', -10, 0, -30);
          // Legs reach for the floor, then take the landing.
          const reach = falling ? 1 : 0;
          p.add('leg.FL', -15 * reach);
          p.add('leg.FR', -15 * reach);
          p.add('leg.BL', 15 * reach);
          p.add('leg.BR', 15 * reach);
          const land = Math.sqrt((2 * H) / g) + release;
          W.low = 0.08 * pulse(u, land, land + 0.08, land + 0.5);
          W.face = u > land + 0.3 ? 'happy' : 'focused';
          W.look = env().owner();
          W.gaze = 'owner';
        }
        W.wide = falling ? 1 : null;
        W.tail = 'act';
        cat.tailStateName = falling ? 'up, puffed' : 'out, level';
        p.add(cat.tail[0], (falling ? 40 : 10) - cat.restElevation);
        W.puff = falling ? 0.7 : 0;
      },
    },

    semaphore: {
      weight: 0,
      length: [8.2, 8.4],
      start() {
        s.face(SIDE_ON);
      },
      pose(t) {
        const W = w();
        // Side on to the camera, through the six carriages in turn.
        const each = 1.35;
        const i = clamp(Math.floor(t / each), 0, TAIL_SEMAPHORE.length - 1);
        const row = TAIL_SEMAPHORE[i];
        W.tail = i;
        W.mood = ROW_MOOD[row.mood] ?? 'calm';
        W.look = env().owner();
        W.gaze = 'owner';
      },
    },

    purr: {
      weight: 0.5,
      length: [7, 9],
      posture: 'lie',
      start() {
        s.face(headingTo(s.position, env().owner()));
      },
      pose(t) {
        const W = w();
        W.purr = 25;
        W.look = env().owner();
        W.gaze = 'owner';
        W.blink = 0.55 + 0.1 * Math.sin(t * 0.6);
        W.face = 'love';
        p.add('head', 4, 0, 10 * Math.sin(t * 0.5));
        W.lights = { charms: 0.7 + 0.3 * Math.sin(t * TAU * 1.2), beacon: 0.7 + 0.3 * Math.sin(t * TAU * 1.2) };
      },
      after(t) {
        // The buzz: a fine shake of the body at the purr frequency.
        p.turn('body', 0.35 * Math.sin(t * TAU * 25), 0, 0.25 * Math.sin(t * TAU * 25 + 1));
      },
    },

    chatter: {
      weight: 0.4,
      length: [7, 9],
      mood: 'focused',
      when: () => toys().bird.present,
      start() {
        burst = -1;
      },
      pose(t) {
        const W = w();
        const bird = toys().bird;
        // Close under the window, at the keyboard's right edge, so the bird is near enough to
        // share a frame with the cat's face. Further right, the nose meets the ledge and the
        // cat keeps backing off and never sits.
        const spot: V3 = [-0.05, 0, -0.7];
        const [a, b] = bird.perch;
        // The body turns a little short of the bird, toward the room; the head makes up the rest.
        cat.goTo(spot, 0.9, { arrive: 0.06, facing: headingTo(spot, [(a[0] + b[0]) / 2, 0, a[2]]) - 20 });
        W.look = bird.position;
        W.gaze = 'bird';
        W.wide = 1;
        cat.earsUp(1);
        const u = cat.since(t);
        if (u < 0) return;
        cat.posture = 'sit';
        // Bursts of jaw chatter, 1.2 s on and 0.8 s off.
        const n = Math.floor(u / 2);
        const on = u % 2 < 1.2 && bird.present;
        if (on && n !== burst) {
          burst = n;
          env().count('birds');
        }
        if (on) {
          W.talk = Math.sin(u * TAU * 9) > 0 ? 0.9 : 0.1;
          bird.alarm();
          p.add('head', 3 * Math.sin(u * TAU * 9));
          p.kick(cat.tail[cat.tail.length - 1], 0, Math.sin(u * 20) * 60, 0);
        }
        W.face = 'focused';
        p.add('body', -6);
      },
    },

    keyboard: {
      weight: 0.3,
      length: [11, 12],
      mood: 'happy',
      when: () => !env().claimedBy('keyboard'),
      start() {
        keys.reset();
        env().claim('keyboard', cat);
      },
      pose(t) {
        const W = w();
        const kb = toys().keyboard;
        const along = kb.yaw + 90;
        // Walk along behind the keys, the right paws on them, then come back and lie down on it.
        const A: V3 = [kb.position[0] - 0.33, 0, -0.8];
        const B: V3 = [kb.position[0] + 0.3, 0, -0.8];
        const L: V3 = [kb.position[0] - 0.02, 0, -0.8];
        switch (keys.state) {
          case 'approach':
            cat.goTo(A, 0.6, { arrive: 0.06, facing: along });
            if (cat.since(t) > 0.1 && Math.abs(wrapDeg(s.heading - along)) < 10) keys.go('across', t);
            W.look = [kb.position[0], 0.02, kb.position[2]];
            W.gaze = 'nothing';
            break;
          case 'across':
            cat.goTo(B, 0, { arrive: 0.05 });
            W.look = env().owner();
            W.gaze = 'owner';
            if (cat.since(t) > 0.3) keys.go('back', t);
            break;
          case 'back':
            // Back to the middle and down along it: right paws on the letters, belly on the top row.
            cat.goTo(L, 0.1, { arrive: 0.04, facing: along });
            W.look = env().owner();
            W.gaze = 'owner';
            if (cat.since(t) > 0 && Math.abs(wrapDeg(s.heading - along)) < 12) keys.go('lie', t);
            break;
          case 'lie':
            s.face(along);
            cat.posture = 'lie';
            W.look = env().owner();
            W.gaze = 'owner';
            W.face = 'happy';
            W.blink = 0.3;
            break;
        }
      },
    },
  };

  /** A loop waypoint moved a little, so laps differ. */
  function jitter(q: V3): V3 {
    return [q[0] + rng.range(-0.1, 0.1), 0, q[2] + rng.range(-0.08, 0.08)];
  }

  return acts;
}
