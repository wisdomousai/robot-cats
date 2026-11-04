import { ease, pulse } from '../math/ease';
import type { LegName } from '../types';
import type { Puppet } from './puppet';

/**
 * Shared bits of motion for the cats. trot and swish are ported from the creatures
 * package; gallop, bound and the paw contact helpers are new.
 *
 * Leg angles are puppet pitch on the hanging `leg.*` bones: + swings a leg back. A leg
 * whose angle is S·sin(gait + offset) sweeps back while cos(gait + offset) > 0; that is
 * its stance (paw on the floor, pushing the body forward), and the rest is its swing.
 */

export { sin } from '../math/ease';

export interface LegOptions {
  /** Bend each `shin.*` bone while its paw is off the floor. */
  shins?: boolean;
  /** Peak shin bend in degrees at mid-swing (40 unless set). */
  lift?: number;
}

/** Phase offsets (radians) of each leg in a pattern. */
const TROT: Record<LegName, number> = { FL: 0, BR: 0, FR: Math.PI, BL: Math.PI };
const GALLOP: Record<LegName, number> = { FL: 0, FR: 0, BL: Math.PI, BR: Math.PI };
/** Fraction of a gallop cycle each pair has its paws down; the rest is flight. */
const GALLOP_DUTY = 0.4;

/**
 * A four-legged walk: diagonal pairs swing together (front left with back right), so
 * the body stays balanced. gait is the walk cycle in radians, amount 0..1 how hard.
 * With `shins`, each shin bends on its own leg's swing, so the paw clears the floor.
 */
export function trot(p: Puppet, gait: number, amount: number, swing = 28, opts: LegOptions = {}) {
  const a = Math.sin(gait) * swing * amount;
  p.add('leg.FL', a);
  p.add('leg.BR', a);
  p.add('leg.FR', -a);
  p.add('leg.BL', -a);
  p.add('body', 0, 0, Math.cos(gait * 2) * 2 * amount);
  p.add('head', Math.cos(gait * 2) * 3 * amount);
  if (opts.shins) bendShins(p, gait, amount, TROT, opts.lift ?? 40);
}

/**
 * A run: the front pair moves together and the back pair together, half a cycle apart.
 * The body rocks with them, nose up as the front paws reach forward and down as the back
 * paws come under; the head takes back most of the rock so the eyes stay level.
 */
export function gallop(p: Puppet, gait: number, amount: number, swing = 40, opts: LegOptions = {}) {
  const s = Math.sin(gait);
  const a = s * swing * amount;
  p.add('leg.FL', a);
  p.add('leg.FR', a);
  p.add('leg.BL', -a);
  p.add('leg.BR', -a);
  p.add('body', 7 * s * amount);
  p.add('head', -5 * s * amount);
  if (opts.shins) bendShins(p, gait, amount, GALLOP, opts.lift ?? 40);
}

/** Each shin bends back (paw tucked) by how far through its swing its leg is. */
function bendShins(p: Puppet, gait: number, amount: number, offsets: Record<LegName, number>, lift: number) {
  for (const leg of ['FL', 'FR', 'BL', 'BR'] as const) {
    const bone = `shin.${leg}`;
    if (!p.has(bone)) continue;
    const off = Math.max(0, -Math.cos(gait + offsets[leg]));
    p.add(bone, lift * amount * off);
  }
}

/**
 * Whether a paw is on the floor at this point of the cycle. For the trot, exactly one
 * diagonal pair is down at every phase (each pair half the cycle). For the gallop, each
 * pair is down for 40% of the cycle around the middle of its stance, with two short
 * flights between.
 */
export function pawDown(gait: number, leg: LegName, pattern: 'trot' | 'gallop' = 'trot'): boolean {
  const TAU = 2 * Math.PI;
  const wrap = (x: number) => ((x % TAU) + TAU) % TAU;
  if (pattern === 'trot') {
    // One test for the FL/BR pair; FR/BL is its complement, so rounding can never give
    // both pairs (or neither) at a boundary.
    const first = wrap(gait + Math.PI / 2) < Math.PI;
    return TROT[leg] === 0 ? first : !first;
  }
  const half = GALLOP_DUTY * Math.PI;
  return wrap(gait + GALLOP[leg] + half) < 2 * half;
}

/** Contact for all four paws, for the console's paw lamps. */
export function paws(gait: number, pattern: 'trot' | 'gallop' = 'trot'): Record<LegName, boolean> {
  return {
    FL: pawDown(gait, 'FL', pattern),
    FR: pawDown(gait, 'FR', pattern),
    BL: pawDown(gait, 'BL', pattern),
    BR: pawDown(gait, 'BR', pattern),
  };
}

/**
 * A tail in several bones swinging side to side, each bone a beat behind the one
 * before. phase is in radians and should be accumulated (not time × rate), so the
 * swing can speed up or slow down without jumping.
 */
export function swish(p: Puppet, bones: string[], phase: number, degrees: number, delay = 0.7) {
  bones.forEach((bone, i) => {
    const s = Math.sin(phase - i * delay) * degrees;
    // The base turns about the up axis; the bones above it sway sideways.
    if (i === 0) p.add(bone, 0, s, 0);
    else p.add(bone, 0, 0, s * 0.8);
  });
}

/** Timing of a pounce in seconds from its start: wiggle until `wind`, leave at `leap`, land at `land`. */
export const POUNCE = { wind: 1.5, leap: 1.95, land: 2.5, end: 3.4 };

/** Where a pounce has the cat at one moment. */
export interface BoundState {
  phase: 'crouch' | 'air' | 'land' | 'done';
  /** Metres travelled forward along the heading since take-off. */
  along: number;
  /** Metres above the floor. */
  height: number;
  /** Metres the body sinks (the crouch before and the dip after). */
  low: number;
  /** Degrees to pitch the root, applied direct with p.turn('root', pitch) after update. */
  pitch: number;
}

/**
 * A pounce, ported from Pixel's pounce act: a crouch with a wiggle of the hips, a coil onto
 * the back legs, a parabolic leap with the front paws reaching, and a soft landing. Adds
 * the leg, body, head and tail turns for time t (seconds since the pounce began) and
 * returns the arc for the caller to move the cat along. `far` and `high` are the leap's
 * length and height in metres.
 */
export function bound(p: Puppet, t: number, far = 0.5, high = 0.22): BoundState {
  const P = POUNCE;
  const tail = p.has('tail.1');
  if (t < P.leap) {
    const k = ease(t, 0.2, 0.6);
    const rear = ease(t, 0.6, P.leap);
    p.add('body', 12 * k);
    p.add('leg.FL', -35 * k);
    p.add('leg.FR', -35 * k);
    p.add('head', -14 * k);
    p.add('root', 0, 0, 4 * Math.sin(t * 8) * rear * (1 - ease(t, P.wind, P.leap)));
    if (tail) p.add('tail.1', 8 * rear, 16 * Math.sin(t * 6) * rear);
    // Coiled just before the spring: hips sunk, weight on the back legs.
    const coil = ease(t, P.leap - 0.4, P.leap - 0.05);
    p.add('body', 8 * coil);
    p.add('leg.BL', -14 * coil);
    p.add('leg.BR', -14 * coil);
    return { phase: 'crouch', along: 0, height: 0, low: 0.06 * k + 0.02 * coil, pitch: 0 };
  }
  if (t < P.land) {
    const u = ease(t, P.leap, P.land);
    const lin = (t - P.leap) / (P.land - P.leap);
    p.add('leg.FL', -85 + 40 * u);
    p.add('leg.FR', -80 + 40 * u);
    p.add('leg.BL', 40);
    p.add('leg.BR', 40);
    p.add('body', -8 * Math.sin(u * Math.PI));
    if (tail) p.add('tail.1', 14);
    // Paws tucked in flight.
    for (const leg of ['FL', 'FR', 'BL', 'BR'] as const)
      if (p.has(`shin.${leg}`)) p.add(`shin.${leg}`, 45 * Math.sin(lin * Math.PI));
    return {
      phase: 'air',
      along: far * u,
      height: 4 * high * lin * (1 - lin),
      low: 0,
      pitch: -12 * Math.sin(lin * Math.PI),
    };
  }
  // Lands soft: a small dip, the front legs taking it, then she straightens.
  const u = ease(t, P.land, P.land + 0.4);
  const dip = pulse(t, P.land, P.land + 0.15, P.land + 0.6);
  p.add('body', 6 * dip);
  p.add('head', 6 * dip);
  p.add('leg.FL', -30 * (1 - u));
  return { phase: t < P.end ? 'land' : 'done', along: far, height: 0, low: 0.05 * dip, pitch: 0 };
}
