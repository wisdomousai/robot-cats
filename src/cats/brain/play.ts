import { clamp, ease, pulse, span } from '../math/ease';
import type { Rng } from '../math/rng';
import { GAME_NAMES, type GameName, type V3 } from '../types';
import { ROOM_LAP } from './acts';
import type { Cat, CatEnv, CatRole } from './cat';
import { headingTo } from './steer';

/**
 * Group games. A game is a generator that hands each cat a role (a goal, a pose, a look, a
 * mood) and yields what to wait for before the next beat: a number of seconds, a condition,
 * or a condition with a time limit. The director advances the generator inside `step`, so a
 * game runs on the world's clock and replays the same way from the same seed.
 *
 * While a game runs, its cats pick no acts of their own. When it ends every cat gets its
 * own acts back. In free play the director starts a game after 15 to 30 seconds without one.
 */

const TAU = 2 * Math.PI;

/** What a game waits for between beats. */
export type Wait = number | (() => boolean) | { until: () => boolean; max: number };

export type Game = Generator<Wait, void, void>;

/** What a game can use. */
export interface PlayContext {
  env: CatEnv;
  rng: Rng;
  /** Seconds since the game started. */
  readonly t: number;
  /** Seconds since the current beat started. */
  readonly beat: number;
  /** Puts a cat in a role, or back to its own acts with null. */
  cast(cat: Cat, role: CatRole | null): void;
}

/** The play area cats run in, a little inside the walls. */
const RUN = { x: 1.15, z: 0.72 };

/** A point about `far` away from `from`, turning off the straight line if it would leave the floor or hit a prop. */
export function awayFrom(env: CatEnv, me: Cat, from: V3, far = 0.9): V3 {
  const dx = me.steer.x - from[0];
  const dz = me.steer.z - from[2];
  const base = Math.atan2(dx, dz);
  const statics = env.toys.obstacles();
  for (const turn of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.5, -2.5]) {
    const a = base + turn;
    const q: V3 = [me.steer.x + Math.sin(a) * far, 0, me.steer.z + Math.cos(a) * far];
    if (Math.abs(q[0]) > RUN.x || Math.abs(q[2]) > RUN.z) continue;
    if (statics.some((o) => Math.hypot(q[0] - o.x, q[2] - o.z) < o.r + 0.25)) continue;
    return q;
  }
  return [clamp(-from[0], -RUN.x, RUN.x), 0, clamp(-from[2], -RUN.z, RUN.z)];
}

/** The point `gap` short of `to` on the line from `me`. */
function shortOf(me: Cat, to: V3, gap: number): V3 {
  const dx = to[0] - me.steer.x;
  const dz = to[2] - me.steer.z;
  const d = Math.hypot(dx, dz);
  if (d <= gap) return [me.steer.x, 0, me.steer.z];
  return [to[0] - (dx / d) * gap, 0, to[2] - (dz / d) * gap];
}

/** Where a cat that is not in a chase waits: inside the lap, so the chase goes round it. */
const LAP_MIDDLE: V3 = [0.1, 0, 0.2];

/**
 * The paths for a chase. The runner goes round ROOM_LAP, the way that first leads away from
 * the chaser, moving on to the next waypoint as it gets near the current one; the waypoints
 * miss every prop, so it never pins itself in a corner or against the box. The chaser
 * follows the runner's own track half a second behind instead of cutting across, so the
 * two run the same way round and never meet head on.
 */
function chaseRoute(env: CatEnv, runner: Cat, chaser: Cat): { runner: () => V3; chaser: () => V3 } {
  const n = ROOM_LAP.length;
  let at = 0;
  ROOM_LAP.forEach((q, i) => {
    if (runner.distTo(q) < runner.distTo(ROOM_LAP[at])) at = i;
  });
  const dir = chaser.distTo(ROOM_LAP[(at + 1) % n]) >= chaser.distTo(ROOM_LAP[(at + n - 1) % n]) ? 1 : -1;
  at = (at + dir + n) % n;
  const track: { t: number; at: V3 }[] = [];
  return {
    runner: () => {
      if (runner.distTo(ROOM_LAP[at]) < 0.34) at = (at + dir + n) % n;
      track.push({ t: env.time, at: runner.steer.position });
      while (track.length > 2 && env.time - track[1].t > 0.5) track.shift();
      return ROOM_LAP[at] as V3;
    },
    chaser: () => {
      // Close behind, it goes for the runner itself and stops short of it.
      if (chaser.distTo(runner.steer.position) < 1) return shortOf(chaser, runner.steer.position, 0.42);
      return track.length ? track[0].at : runner.steer.position;
    },
  };
}

// ---------- Poses the games share ----------

/** Crouched low with the hips wiggling: about to spring. */
function wiggle(cat: Cat, t: number, k = 1): void {
  cat.want.low = 0.06 * k;
  cat.want.wide = 1;
  cat.want.face = 'focused';
  cat.puppet.add('root', 0, 0, 4 * Math.sin(t * 8) * k);
  cat.earsUp(k);
}

/** A short hop forward with the front paws reaching: the catch at the end of a chase. */
function hop(cat: Cat, u: number, high = 0.14): void {
  const k = clamp(u / 0.45, 0, 1);
  cat.want.lift = high * Math.sin(Math.PI * k);
  const reach = Math.sin(Math.PI * k);
  cat.puppet.add('leg.FL', -60 * reach);
  cat.puppet.add('leg.FR', -55 * reach);
  cat.puppet.add('leg.BL', 30 * reach);
  cat.puppet.add('leg.BR', 30 * reach);
  cat.puppet.add('body', -10 * reach);
}

/** Up on the hind legs with the front paws batting: wrestling. */
function rearUp(cat: Cat, t: number, k: number): void {
  const p = cat.puppet;
  p.add('body', -38 * k);
  p.add('leg.BL', 38 * k);
  p.add('leg.BR', 38 * k);
  const a = Math.sin(t * TAU * 1.4);
  p.add('leg.FL', (-50 + 35 * a) * k, 0, 15 * k);
  p.add('leg.FR', (-50 - 35 * a) * k, 0, -15 * k);
  p.add('shin.FL', 40 * k);
  p.add('shin.FR', 40 * k);
  p.add('head', 25 * k);
  cat.earsBack(k, 40);
}

// ---------- Games ----------

function* chase(ctx: PlayContext, lead: Cat): Game {
  const { env } = ctx;
  const first = lead.nearest().cat;
  if (!first) return;
  let chaser: Cat = lead;
  let runner: Cat = first;
  // Anyone else sits in the middle and watches, out of the way of the lap.
  for (const o of env.cats) {
    if (o === lead || o === first) continue;
    ctx.cast(o, {
      act: 'watch',
      mood: 'curious',
      hurry: 0.5,
      arrive: 0.2,
      goal: () => LAP_MIDDLE,
      look: () => runner.headAt,
      faceTo: () => runner.steer.position,
      gaze: 'cat',
      pose: () => {
        o.posture = o.walking ? 'stand' : 'sit';
      },
    });
  }
  for (let round = 0; round < 2; round++) {
    const c: Cat = chaser;
    const r: Cat = runner;
    // The chaser crouches and wiggles; the runner sees it coming.
    ctx.cast(c, {
      act: 'chase',
      mood: 'playful',
      facing: c.headingTo(r.steer.position),
      look: () => r.headAt,
      gaze: 'cat',
      pose: (t) => wiggle(c, t, ease(t, 0, 0.3)),
    });
    ctx.cast(r, { act: 'flee', mood: 'curious', facing: r.headingTo(c.steer.position), look: () => c.headAt, gaze: 'cat' });
    yield 1.3;
    // The run. The runner bolts first and the chaser goes half a second later along the
    // runner's track, a little faster.
    const route = chaseRoute(env, r, c);
    ctx.cast(r, {
      act: 'flee',
      mood: 'startled',
      hurry: 0.9,
      arrive: 0.3,
      through: true,
      goal: route.runner,
      look: () => c.headAt,
      gaze: 'cat',
      pose: () => {
        r.earsBack(1, 40);
        r.want.low = 0.03;
        r.want.puff = 0.6;
      },
    });
    yield 0.5;
    ctx.cast(c, {
      act: 'chase',
      mood: 'playful',
      hurry: 1.35,
      arrive: 0.05,
      goal: route.chaser,
      look: () => r.headAt,
      gaze: 'cat',
      pose: () => {
        c.want.face = 'determined';
        c.want.wide = 1;
        c.want.low = 0.03;
        c.earsBack(0.5, 20);
      },
    });
    yield { until: () => ctx.beat > 2.5 && c.distTo(r.steer.position) < 0.65, max: 7 };
    if (c.distTo(r.steer.position) > 0.8) {
      // Not caught: the chaser stops and sits as if it never wanted to, and the runner turns
      // to look back at it.
      ctx.cast(c, { act: 'chase', mood: 'calm', posture: 'sit', look: () => c.pointFor('nothing'), gaze: 'nothing' });
      ctx.cast(r, { act: 'flee', mood: 'curious', facing: r.headingTo(c.steer.position), look: () => c.headAt, gaze: 'cat' });
      yield 1.6;
      [chaser, runner] = [r, c];
      continue;
    }
    // The catch: a hop that carries it up to the runner, a paw on the back, and the runner flattens.
    ctx.cast(c, {
      act: 'chase',
      mood: 'playful',
      facing: c.headingTo(r.steer.position),
      look: () => r.headAt,
      gaze: 'cat',
      pose: (t, dt) => {
        hop(c, t);
        c.want.face = 'starry';
        const gap = c.distTo(r.steer.position) - 0.45;
        if (t < 0.45 && gap > 0) {
          const [fx, fz] = c.steer.forward();
          const step = Math.min(gap, 1.2 * dt);
          c.steer.nudge(fx * step, fz * step);
        }
      },
    });
    ctx.cast(r, {
      act: 'flee',
      mood: 'startled',
      look: () => c.headAt,
      gaze: 'cat',
      pose: (t) => {
        r.want.low = 0.08 * span(t, 0.2, 0.4, 1.1, 1.5);
        r.earsBack(1, 40);
        r.want.face = 'surprised';
      },
    });
    yield 1.6;
    [chaser, runner] = [r, c];
  }
  // Both sit down and look elsewhere, as if there had been no game.
  for (const cat of [chaser, runner]) ctx.cast(cat, { act: 'groom', posture: 'sit', look: () => cat.pointFor('nothing'), gaze: 'nothing' });
  yield 1.5;
}

function* tag(ctx: PlayContext, lead: Cat): Game {
  const { env } = ctx;
  const cats = env.cats;
  let it = lead;
  let from: Cat | null = null;
  // The nearest cat that is fair game. The one that just tagged it may not be tagged straight
  // back, or the two would stay on top of each other and swap being it.
  const prey = (): { cat: Cat | null; d: number } => {
    let cat: Cat | null = null;
    let d = Infinity;
    for (const c of cats) {
      if (c === it || (c === from && cats.length > 2)) continue;
      const dd = it.distTo(c.steer.position);
      if (dd < d) {
        d = dd;
        cat = c;
      }
    }
    return { cat, d };
  };
  const castAll = () => {
    for (const cat of cats) {
      if (cat === it) {
        const me = cat;
        ctx.cast(me, {
          act: 'tag',
          mood: 'playful',
          hurry: 1.15,
          arrive: 0.1,
          goal: () => {
            const n = prey().cat;
            return n ? shortOf(me, n.steer.position, 0.35) : null;
          },
          look: () => prey().cat?.headAt ?? null,
          gaze: 'cat',
          pose: () => {
            me.want.face = 'determined';
            me.want.wide = 1;
          },
        });
      } else {
        const me = cat;
        const chaser = it;
        ctx.cast(me, {
          act: 'tag',
          mood: 'playful',
          hurry: 0.95,
          arrive: 0.2,
          // Away from whoever is it while it is near, and away from the other runner while that
          // is close, so the runners do not bunch up where the chaser can reach both.
          goal: () => {
            if (me.distTo(chaser.steer.position) < 1.1) return awayFrom(env, me, chaser.steer.position, 0.8);
            const other = cats.find((c) => c !== me && c !== chaser);
            return other && me.distTo(other.steer.position) < 0.9 ? awayFrom(env, me, other.steer.position, 0.6) : null;
          },
          look: () => chaser.headAt,
          gaze: 'cat',
          pose: () => me.earsBack(me.distTo(chaser.steer.position) < 0.8 ? 0.8 : 0, 30),
        });
      }
    }
  };
  for (let n = 0; n < 5 && ctx.t < 26; n++) {
    castAll();
    yield { until: () => prey().d < 0.48, max: 8 };
    const tagged = prey().cat;
    if (!tagged) break;
    // The tap, and a jump from the one tagged.
    const tapper = it;
    ctx.cast(tapper, { act: 'tag', mood: 'playful', look: () => tagged.headAt, gaze: 'cat', pose: (t) => hop(tapper, t, 0.08) });
    ctx.cast(tagged, {
      act: 'tag',
      mood: 'startled',
      look: () => tapper.headAt,
      gaze: 'cat',
      pose: (t) => {
        tagged.want.lift = 0.16 * pulse(t, 0, 0.18, 0.4);
        tagged.want.face = 'surprised';
        tagged.earsBack(1, 40);
      },
    });
    yield 0.8;
    from = it;
    it = tagged;
  }
  // The last tag leaves two cats nose to nose; each steps clear of the nearest one and sits.
  for (const cat of cats) {
    const near = cat.nearest();
    const spot = near.cat && near.d < 0.8 ? awayFrom(env, cat, near.cat.steer.position, 0.5) : null;
    ctx.cast(cat, {
      act: 'tag',
      mood: 'happy',
      hurry: 0.5,
      arrive: 0.1,
      goal: () => (spot && cat.distTo(spot) > 0.12 ? spot : null),
      look: () => cat.pointFor('owner'),
      gaze: 'owner',
      pose: () => {
        cat.posture = cat.walking ? 'stand' : 'sit';
      },
    });
  }
  yield 1.6;
}

function* wrestle(ctx: PlayContext, lead: Cat): Game {
  const a = lead;
  const b = lead.nearest().cat;
  if (!b) return;
  // Meet in the middle, close enough to touch. Reared up, the heads reach forward, so the
  // two stand 0.6 m apart or their heads go into each other.
  const mid = (): V3 => [(a.steer.x + b.steer.x) / 2, 0, (a.steer.z + b.steer.z) / 2];
  const meet = (me: Cat, other: Cat): CatRole => ({
    act: 'wrestle',
    mood: 'playful',
    hurry: 0.5,
    arrive: 0.06,
    ignore: other.id,
    goal: () => {
      const m = mid();
      const d = Math.max(1e-3, Math.hypot(me.steer.x - m[0], me.steer.z - m[2]));
      return [m[0] + ((me.steer.x - m[0]) / d) * 0.3, 0, m[2] + ((me.steer.z - m[2]) / d) * 0.3];
    },
    look: () => other.headAt,
    gaze: 'cat',
  });
  ctx.cast(a, meet(a, b));
  ctx.cast(b, meet(b, a));
  yield { until: () => a.distTo(b.steer.position) < 0.68, max: 6 };
  // Up on the hind legs, batting at each other.
  for (const [me, other] of [
    [a, b],
    [b, a],
  ] as const) {
    ctx.cast(me, {
      act: 'wrestle',
      mood: 'playful',
      ignore: other.id,
      facing: headingTo(me.steer.position, other.steer.position),
      look: () => other.headAt,
      gaze: 'cat',
      pose: (t) => {
        rearUp(me, t + (me === a ? 0 : 0.2), ease(t, 0, 0.4) * (1 - ease(t, 2.6, 3)));
        me.want.face = 'determined';
      },
    });
  }
  yield 3;
  // One goes over on its side and kicks; the other pins it from above.
  const under = ctx.rng.chance(0.5) ? a : b;
  const over = under === a ? b : a;
  ctx.cast(under, {
    act: 'wrestle',
    mood: 'playful',
    ignore: over.id,
    look: () => over.headAt,
    gaze: 'cat',
    pose: (t) => {
      const k = span(t, 0, 0.4, 2.4, 2.9);
      under.want.roll = 95 * k;
      under.want.tumbleHz = 2;
      under.posture = k > 0.5 ? 'lie' : 'stand';
      const kick = Math.sin(t * TAU * 2);
      under.puppet.add('leg.BL', -40 * kick * k);
      under.puppet.add('leg.BR', 40 * kick * k);
      under.puppet.add('leg.FL', -50 * k);
      under.puppet.add('leg.FR', -50 * k);
      under.want.face = 'determined';
    },
  });
  ctx.cast(over, {
    act: 'wrestle',
    mood: 'playful',
    ignore: under.id,
    facing: headingTo(over.steer.position, under.steer.position),
    look: () => under.headAt,
    gaze: 'cat',
    pose: (t) => {
      const k = span(t, 0, 0.4, 2.4, 2.9);
      over.want.low = 0.05 * k;
      over.puppet.add('body', 12 * k);
      over.puppet.add('leg.FL', -45 * k + 14 * Math.sin(t * TAU * 1.5) * k);
      over.puppet.add('leg.FR', -45 * k - 14 * Math.sin(t * TAU * 1.5) * k);
      over.puppet.add('head', 25 * k);
      over.earsBack(k, 40);
    },
  });
  yield 3;
  // Apart, and both groom as if it had not happened.
  for (const [me, other] of [
    [a, b],
    [b, a],
  ] as const) {
    ctx.cast(me, { act: 'wrestle', hurry: 0.5, goal: () => awayFrom(ctx.env, me, other.steer.position, 0.35), arrive: 0.1, look: () => other.headAt, gaze: 'cat' });
  }
  yield 1;
  for (const me of [a, b]) ctx.cast(me, { act: 'groom', posture: 'sit', look: () => me.pointFor('nothing'), gaze: 'nothing' });
  yield 1.5;
}

/** The open middle of the floor: the yarn game's swipes send the yarn toward it. */
const YARN_MIDDLE: V3 = [0.1, 0, 0.15];

function* yarn(ctx: PlayContext, lead: Cat): Game {
  const { env } = ctx;
  const y = env.toys.yarn;
  const cats = [lead, ...env.cats.filter((c) => c !== lead)];
  const ball = () => y.position;
  // Each cat watches from its own side of the yarn, all on the side away from the cameras
  // that show the game (azimuth 32), so the three face them, stay out of the line to the
  // yarn and keep well apart. Near a wall the three slide off it together: pressed onto the
  // wall one by one they would end up side by side on one spot.
  const slot = (i: number): V3 => {
    const p = ball();
    const at = [0, 1, 2].map((k): V3 => {
      const a = ((212 + (k - 1) * 80) * Math.PI) / 180;
      return [p[0] + Math.sin(a) * 0.85, 0, p[2] + Math.cos(a) * 0.85];
    });
    const slide = (lo: number, hi: number, lim: number) => (lo < -lim ? -lim - lo : hi > lim ? lim - hi : 0);
    const dx = slide(Math.min(...at.map((q) => q[0])), Math.max(...at.map((q) => q[0])), RUN.x);
    const dz = slide(Math.min(...at.map((q) => q[2])), Math.max(...at.map((q) => q[2])), RUN.z);
    const q = at[i % 3];
    return [q[0] + dx, 0, q[2] + dz];
  };
  const watch = (me: Cat): CatRole => ({
    act: 'yarn',
    mood: 'playful',
    hurry: 0.5,
    arrive: 0.15,
    goal: () => {
      const q = slot(cats.indexOf(me));
      return me.distTo(q) > 0.2 ? q : null;
    },
    look: () => ball(),
    gaze: 'toy',
    pose: (t) => {
      me.earsUp(1);
      me.want.low = 0.02;
      me.puppet.add('root', 0, 0, 3 * Math.sin(t * 10) * pulse(t % 3, 2, 2.3, 2.6));
    },
  });
  for (const cat of cats) ctx.cast(cat, watch(cat));
  // A yarn by a wall or a prop is first carried out by its strand: there the swipes would
  // only knock it against the prop, with the batter standing on the rope.
  const b0 = ball();
  if (Math.abs(b0[0]) > RUN.x - 0.4 || Math.abs(b0[2]) > RUN.z - 0.35 || env.toys.obstacles().some((o) => Math.hypot(b0[0] - o.x, b0[2] - o.z) < o.r + 0.3)) {
    ctx.cast(lead, { act: 'yarn', mood: 'playful', hurry: 0.6, arrive: 0.06, goal: () => shortOf(lead, y.end, 0.22), look: () => y.end, gaze: 'toy' });
    yield { until: () => lead.distTo(y.end) < 0.3, max: 3 };
    ctx.cast(lead, {
      act: 'yarn',
      mood: 'playful',
      hurry: 0.55,
      arrive: 0.1,
      goal: () => YARN_MIDDLE,
      look: () => ball(),
      gaze: 'toy',
      pose: () => lead.puppet.add('head', 20),
      after: () => y.pin([lead.headAt[0], 0.02, lead.headAt[2]]),
    });
    yield { until: () => lead.since() >= 0 && lead.distTo(YARN_MIDDLE) < 0.15, max: 3.5 };
    y.unpin();
    ctx.cast(lead, watch(lead));
  }
  // Swipes in turn: each batter goes up to the yarn, wiggles and sends it rolling. It bats
  // from the side away from the middle of the floor, so the yarn stays in the open and does
  // not end up in a corner with three cats on top of it.
  const aim = (me: Cat): number => {
    const b = ball();
    return Math.hypot(b[0] - YARN_MIDDLE[0], b[2] - YARN_MIDDLE[2]) > 0.25 ? headingTo(b, YARN_MIDDLE) : headingTo(me.steer.position, b);
  };
  for (let n = 0; n < 4; n++) {
    const me = cats[n % cats.length];
    const toward = aim(me) * (Math.PI / 180);
    ctx.cast(me, {
      act: 'yarn',
      mood: 'playful',
      hurry: 0.8,
      arrive: 0.06,
      goal: () => {
        const b = ball();
        return [clamp(b[0] - Math.sin(toward) * 0.24, -RUN.x, RUN.x), 0, clamp(b[2] - Math.cos(toward) * 0.24, -RUN.z, RUN.z)];
      },
      look: () => ball(),
      gaze: 'toy',
    });
    yield { until: () => me.distTo(ball()) < 0.32 && Math.hypot(y.velocity[0], y.velocity[2]) < 0.2, max: 5 };
    let hit = false;
    ctx.cast(me, {
      act: 'yarn',
      mood: 'playful',
      facing: headingTo(me.steer.position, ball()),
      look: () => ball(),
      gaze: 'toy',
      pose: (t) => {
        wiggle(me, t, ease(t, 0, 0.2) * (1 - ease(t, 0.7, 0.8)));
        const k = pulse(t, 0.8, 0.92, 1.2);
        me.puppet.add('leg.FR', -60 * k, 0, 25 * k);
        me.puppet.add('shin.FR', 30 * k);
        if (!hit && t > 0.9) {
          hit = true;
          // Away from the paw that hits it. A batter that could not get round the yarn (a wall
          // or a prop in the way) would otherwise send it into its own legs, where it stops.
          const a = (headingTo(me.steer.position, ball()) + ctx.rng.range(-30, 30)) * (Math.PI / 180);
          const v = ctx.rng.range(0.4, 0.6);
          y.velocity[0] += Math.sin(a) * v;
          y.velocity[2] += Math.cos(a) * v;
          y.velocity[1] += 0.18;
        }
      },
    });
    yield 1.3;
    ctx.cast(me, watch(me));
    yield 0.6;
  }
  // The strand end caught and dragged off, the ball rolling after.
  const dragger = cats[ctx.rng.int(cats.length)];
  ctx.cast(dragger, {
    act: 'yarn',
    mood: 'playful',
    hurry: 0.6,
    arrive: 0.06,
    goal: () => shortOf(dragger, y.end, 0.22),
    look: () => y.end,
    gaze: 'toy',
  });
  yield { until: () => dragger.distTo(y.end) < 0.3, max: 5 };
  let away: V3 | null = null;
  ctx.cast(dragger, {
    act: 'yarn',
    mood: 'playful',
    hurry: 0.55,
    arrive: 0.1,
    goal: () => (away ??= awayFrom(env, dragger, ball(), 0.9)),
    look: () => ball(),
    gaze: 'toy',
    pose: () => {
      dragger.puppet.add('head', 20);
      dragger.want.face = 'starry';
    },
    after: () => y.pin([dragger.headAt[0], 0.02, dragger.headAt[2]]),
  });
  yield { until: () => dragger.since() >= 0 && away !== null && dragger.distTo(away) < 0.15, max: 3.5 };
  y.unpin();
  for (const cat of cats) ctx.cast(cat, { act: 'yarn', posture: 'sit', mood: 'happy', look: () => ball(), gaze: 'toy' });
  yield 1.2;
}

function* laser(ctx: PlayContext): Game {
  const { env } = ctx;
  const dot = env.toys.laser;
  dot.turnOn(env.cursor ? 'cursor' : 'path');
  env.cats.forEach((c) => c.mood.trigger('laser'));
  const length = 15 + ctx.rng.range(0, 3);
  const pounced = new Map<Cat, number>();
  for (const me of env.cats) {
    ctx.cast(me, {
      act: 'laser',
      mood: 'focused',
      hurry: 1.1,
      arrive: 0.12,
      goal: () => (pounced.has(me) && ctx.t - pounced.get(me)! < 0.9 ? null : shortOf(me, dot.position, 0.18)),
      look: () => dot.position,
      gaze: 'toy',
      pose: () => {
        me.want.wide = 1;
        me.earsUp(1);
        const at = pounced.get(me);
        if (at !== undefined && ctx.t - at < 0.9) {
          hop(me, ctx.t - at, 0.1);
          me.want.face = 'starry';
        } else {
          me.want.face = 'focused';
          me.want.low = me.distTo(dot.position) < 0.5 ? 0.04 : 0;
        }
        // A pounce when the dot is close and slow.
        if ((at === undefined || ctx.t - at > 1.6) && me.distTo(dot.position) < 0.3 && dot.speed < 0.4) pounced.set(me, ctx.t);
      },
    });
  }
  yield { until: () => false, max: length };
  dot.turnOff();
  // The dot is gone. Where did it go.
  for (const me of env.cats) {
    ctx.cast(me, {
      act: 'laser',
      mood: 'curious',
      look: () => [dot.position[0], 0, dot.position[2]],
      gaze: 'toy',
      pose: (t) => {
        me.puppet.add('head', 20, 25 * Math.sin(t * 2.2), 15);
        (me.model.face as { mark?: string }).mark = 'question';
      },
    });
  }
  yield 2;
  for (const me of env.cats) (me.model.face as { mark?: string }).mark = 'none';
}

// ---------- The director ----------

/** Seconds of free play before a game starts on its own. */
const FREE_PLAY: [number, number] = [15, 30];

export class Director {
  game: GameName | null = null;
  /** Cats in the current game. */
  readonly cast = new Set<Cat>();
  private run: Game | null = null;
  private wait: Wait | null = null;
  private t = 0;
  private beat = 0;
  private free = 0;
  private nextGame: number;
  private readonly rng: Rng;
  private env: CatEnv | null = null;

  constructor(rng: Rng) {
    this.rng = rng.fork('director');
    this.nextGame = this.rng.range(...FREE_PLAY);
  }

  /** Starts a game with `lead` as the cat that starts it. Any game already running ends. */
  start(name: GameName, lead: Cat, env: CatEnv): void {
    this.stop();
    this.env = env;
    this.game = name;
    this.t = 0;
    this.beat = 0;
    const self = this;
    const ctx: PlayContext = {
      env,
      rng: this.rng,
      get t() {
        return self.t;
      },
      get beat() {
        return self.beat;
      },
      cast: (cat, role) => {
        if (role) this.cast.add(cat);
        else this.cast.delete(cat);
        cat.direct(role);
      },
    };
    for (const c of env.cats) c.mood.trigger('invite', c === lead ? 1 : 0.5);
    this.run = { chase, wrestle, tag, yarn, laser: (c: PlayContext) => laser(c) }[name](ctx, lead);
    this.wait = 0;
  }

  /** Ends the game and gives every cat in it its own acts back. */
  stop(): void {
    if (!this.game) return;
    for (const cat of this.cast) cat.direct(null);
    this.cast.clear();
    if (this.env) {
      this.env.toys.laser.turnOff();
      this.env.toys.yarn.unpin();
      for (const c of this.env.cats) (c.model.face as { mark?: string }).mark = 'none';
    }
    this.run = null;
    this.wait = null;
    this.game = null;
    this.free = 0;
    this.nextGame = this.rng.range(...FREE_PLAY);
  }

  /** Free play starts counting again (after a button, or while a demo runs). */
  hold(): void {
    this.free = 0;
  }

  /**
   * Advances the game by dt, or counts free play toward the next one. `canStart` is false
   * while a demo or a button's act should not be interrupted.
   */
  step(dt: number, env: CatEnv, canStart: boolean): void {
    this.env = env;
    if (!this.run) {
      if (!canStart) {
        this.free = 0;
        return;
      }
      this.free += dt;
      if (this.free >= this.nextGame) {
        const name = GAME_NAMES[this.rng.int(GAME_NAMES.length)];
        const lead = env.cats[this.rng.int(env.cats.length)];
        this.start(name, lead, env);
      }
      return;
    }
    this.t += dt;
    this.beat += dt;
    if (env.toys.laser.on && this.game === 'laser') env.toys.laser.aim(env.cursor);
    // Advance through every beat that is already due, so a zero wait costs no step.
    for (let guard = 0; guard < 8; guard++) {
      if (!this.due()) return;
      const next = this.run.next();
      this.beat = 0;
      if (next.done) {
        this.stop();
        return;
      }
      this.wait = next.value;
    }
  }

  private due(): boolean {
    const w = this.wait;
    if (w === null) return true;
    if (typeof w === 'number') return this.beat >= w;
    if (typeof w === 'function') return w();
    return this.beat >= w.max || w.until();
  }
}
