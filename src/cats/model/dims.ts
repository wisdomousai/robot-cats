import type { Breed, BreedId, CoatSpec, DeepPartial, Dims, Feel, V3 } from '../types';

/**
 * The dimension tables that shape the cats, in metres and three.js axes (+x the cat's
 * left, +y up, +z its front). Pixel's numbers come from creatures/blender/cat.py and
 * Suki's from creatures/blender/siamese.py, converted from Blender axes as (x, z, -y).
 * Soot is new and built on Pixel's proportions.
 *
 * A few fields are read relative to other parts, so a breed can move the head or the
 * collar without moving everything that hangs off it:
 * - `screen.dz` lifts the screen's centre above the head's centre (y); the screen's depth
 *   is set so it stands a little proud of the head's front.
 * - `ear.y` is the height of the ear pivot and `ear.z` its fore-aft position; the cone's
 *   base sits 2 cm below the pivot, inside the head.
 * - `leg.front` and `leg.back` are the z of the front and back legs; `leg.knee` is the
 *   height of the knee joint between the `leg.*` and `shin.*` bones.
 * - `whiskers.x` is how far out the whisker roots sit (clamped to the cheek surface);
 *   `whiskers.dy` and `whiskers.dz` offset them from the screen's centre, down and back.
 * - `bell.center` is the bell's offset from the point at the front of the collar it
 *   hangs from.
 * - `antenna.at` gives x and z of the antenna's foot on the head; its y lifts the foot
 *   above the surface (0 sits on it).
 * - `belly.w` and `belly.h` are the belly plate's width and length; the plate is
 *   centred between the front and back legs.
 */

/** Pixel, the tabby: a loaf body on short legs under a boxy screen head. */
export const BASE: Dims = {
  head: { radii: [0.2, 0.15, 0.16], center: [0, 0.45, 0.2], e: 0.35, taper: 0 },
  screen: { radii: [0.155, 0.105, 0.11], bezel: 0.01, e: 0.35, dz: -0.01 },
  ear: {
    x: 0.12,
    y: 0.575,
    z: 0.2,
    tilt: 0.28,
    flat: 0.42,
    profile: [
      [0, 0.14],
      [0.025, 0.12],
      [0.06, 0.05],
      [0.078, 0],
    ],
    bone: 0.12,
    pitch: 0,
    inset: 0.028,
  },
  body: { radii: [0.14, 0.12, 0.24], center: [0, 0.25, -0.04], e: 0.45, spine: 4 },
  leg: { x: 0.085, front: 0.12, back: -0.2, top: 0.22, knee: 0.115, bottom: 0.04, r: 0.037 },
  paw: { radii: [0.046, 0.03, 0.056], e: 0.4 },
  tail: {
    points: [
      [0, 0.27, -0.24],
      [0, 0.3, -0.33],
      [0, 0.39, -0.39],
      [0, 0.5, -0.39],
      [0, 0.58, -0.35],
    ],
    r: [0.032, 0.02],
    bones: 3,
    rings: [
      [0.42, 0.52],
      [0.64, 0.74],
      [0.86, 1.01],
    ],
    tip: 0.021,
  },
  collar: { center: [0, 0.335, 0.155], major: 0.105, minor: 0.016, tilt: 0.55, tag: 0.022 },
  bell: { r: 0.026, center: [0, -0.04, 0.006] },
  whiskers: { x: 0.194, dy: -0.04, dz: -0.045, length: 0.12, n: 3 },
  antenna: { at: [-0.075, 0, 0.12], length: 0.1 },
  belly: { w: 0.09, h: 0.22 },
};

/** Suki's table at the size the Blender file builds her, about 0.88 m to the ear tips. */
const SUKI_FULL: Dims = {
  head: { radii: [0.135, 0.115, 0.15], center: [0, 0.64, 0.2], e: 0.5, taper: -0.5 },
  screen: { radii: [0.098, 0.07, 0.08], bezel: 0.009, e: 0.4, dz: -0.004 },
  // Narrower at the base than the Blender file's 0.108 m, so the ears stay within the
  // narrow wedge head instead of overhanging it at the sides.
  ear: {
    x: 0.08,
    y: 0.735,
    z: 0.2,
    tilt: 0.42,
    flat: 0.36,
    profile: [
      [0, 0.215],
      [0.021, 0.185],
      [0.052, 0.078],
      [0.072, 0],
    ],
    bone: 0.2,
    pitch: 0,
    inset: 0.022,
  },
  body: { radii: [0.092, 0.092, 0.27], center: [0, 0.4, -0.07], e: 0.5, spine: 5 },
  leg: { x: 0.058, front: 0.12, back: -0.27, top: 0.36, knee: 0.21, bottom: 0.04, r: 0.025 },
  paw: { radii: [0.032, 0.024, 0.048], e: 0.45 },
  tail: {
    points: [
      [0, 0.42, -0.33],
      [0, 0.4, -0.46],
      [0, 0.43, -0.6],
      [0, 0.53, -0.7],
      [0, 0.67, -0.72],
      [0, 0.8, -0.68],
    ],
    r: [0.021, 0.011],
    bones: 5,
    rings: [[0.8, 1.01]],
    tip: 0.012,
  },
  collar: { center: [0, 0.495, 0.16], major: 0.07, minor: 0.011, tilt: 0.35, tag: 0.018 },
  bell: { r: 0.02, center: [0, -0.03, 0.005] },
  whiskers: { x: 0.1, dy: -0.042, dz: -0.055, length: 0.13, n: 3 },
  antenna: { at: [-0.055, 0, 0.17], length: 0.09 },
  belly: { w: 0.05, h: 0.3 },
};

/** Soot, the black cat: longer and lower than Pixel, rounder in the head, a hooked tail. */
const SOOT: Dims = {
  head: { radii: [0.19, 0.145, 0.155], center: [0, 0.47, 0.215], e: 0.42, taper: 0.1 },
  screen: { radii: [0.148, 0.1, 0.105], bezel: 0.01, e: 0.42, dz: -0.008 },
  ear: {
    x: 0.112,
    y: 0.592,
    z: 0.215,
    tilt: 0.3,
    flat: 0.4,
    profile: [
      [0, 0.15],
      [0.022, 0.13],
      [0.058, 0.055],
      [0.074, 0],
    ],
    bone: 0.13,
    pitch: 0,
    inset: 0.026,
  },
  body: { radii: [0.125, 0.11, 0.26], center: [0, 0.27, -0.05], e: 0.5, spine: 5 },
  leg: { x: 0.078, front: 0.13, back: -0.22, top: 0.24, knee: 0.135, bottom: 0.04, r: 0.032 },
  paw: { radii: [0.042, 0.028, 0.052], e: 0.42 },
  tail: {
    points: [
      [0, 0.29, -0.26],
      [0, 0.31, -0.37],
      [0, 0.4, -0.46],
      [0, 0.53, -0.5],
      [0, 0.64, -0.46],
      [0, 0.67, -0.38],
    ],
    r: [0.028, 0.016],
    bones: 4,
    rings: [[0.88, 1.01]],
    tip: 0.017,
  },
  collar: { center: [0, 0.355, 0.17], major: 0.1, minor: 0.015, tilt: 0.55, tag: 0.02 },
  bell: { r: 0.024, center: [0, -0.037, 0.006] },
  whiskers: { x: 0.185, dy: -0.04, dz: -0.045, length: 0.13, n: 3 },
  antenna: { at: [0.07, 0, 0.13], length: 0.085 },
  belly: { w: 0.085, h: 0.24 },
};

const scaleV = (v: V3, s: number): V3 => [v[0] * s, v[1] * s, v[2] * s];

/**
 * Every length in a table times s; shape exponents, angles, counts and the 0..1
 * positions along the tail stay as they are.
 */
export function scaleDims(d: Dims, s: number): Dims {
  return {
    head: { ...d.head, radii: scaleV(d.head.radii, s), center: scaleV(d.head.center, s) },
    screen: { ...d.screen, radii: scaleV(d.screen.radii, s), bezel: d.screen.bezel * s, dz: (d.screen.dz ?? 0) * s },
    ear: {
      ...d.ear,
      x: d.ear.x * s,
      y: d.ear.y * s,
      z: d.ear.z * s,
      profile: d.ear.profile.map(([r, h]) => [r * s, h * s] as [number, number]),
      bone: d.ear.bone * s,
      inset: (d.ear.inset ?? 0.026) * s,
    },
    body: { ...d.body, radii: scaleV(d.body.radii, s), center: scaleV(d.body.center, s) },
    leg: {
      x: d.leg.x * s,
      front: d.leg.front * s,
      back: d.leg.back * s,
      top: d.leg.top * s,
      knee: d.leg.knee * s,
      bottom: d.leg.bottom * s,
      r: d.leg.r * s,
    },
    paw: { ...d.paw, radii: scaleV(d.paw.radii, s) },
    tail: {
      ...d.tail,
      points: d.tail.points.map((p) => scaleV(p, s)),
      r: [d.tail.r[0] * s, d.tail.r[1] * s],
      tip: d.tail.tip * s,
    },
    collar: { ...d.collar, center: scaleV(d.collar.center, s), major: d.collar.major * s, minor: d.collar.minor * s, tag: d.collar.tag * s },
    bell: { r: d.bell.r * s, center: scaleV(d.bell.center, s) },
    whiskers: { ...d.whiskers, x: d.whiskers.x * s, dy: d.whiskers.dy * s, dz: d.whiskers.dz * s, length: d.whiskers.length * s },
    antenna: { at: scaleV(d.antenna.at, s), length: d.antenna.length * s },
    belly: { w: d.belly.w * s, h: d.belly.h * s },
  };
}

/**
 * Suki is built at 0.85 of her Blender size. At full size she stands 0.88 m to the ear
 * tips, a third taller than Pixel; at 0.85 she is a little taller than him, which reads as
 * a slender cat on long legs next to a loaf.
 */
const SUKI = scaleDims(SUKI_FULL, 0.85);

// ---------- Coats ----------

export const TABBY_COAT: CoatSpec = {
  rule: 'tabby',
  base: { shell: '#f2a04e', joint: '#b9652a', bezel: '#fff1de', glow: '#f4f4f1', dot: '#ffd98a', beacon: '#ffc94a' },
  regions: {
    Stripe: '#c8641c',
    Tip: '#c8641c',
    Inner: '#f6b39c',
    Paw: '#fbe7cf',
    Belly: '#fbe7cf',
    Collar: '#3fae8f',
  },
};

export const POINTS_COAT: CoatSpec = {
  rule: 'points',
  base: { shell: '#efe3cc', joint: '#a99a82', bezel: '#5a4636', glow: '#7ec3ff', dot: '#bfe3ff', beacon: '#9fd4ff' },
  regions: {
    Mask: '#4a382e',
    Ear: '#4a382e',
    Tail: '#4a382e',
    Tip: '#3a2a22',
    Paw: '#4a382e',
    Sock: '#4a382e',
    Inner: '#e3a79f',
    Collar: '#3a8fd0',
    Belly: '#f6eedf',
  },
};

export const SOLID_COAT: CoatSpec = {
  rule: 'solid',
  base: { shell: '#2d2c31', joint: '#4d4c53', bezel: '#e8c63f', glow: '#d8f05a', dot: '#ffd23f', beacon: '#ffd23f' },
  regions: {
    Inner: '#6b5560',
    Collar: '#e04b4b',
  },
};

// ---------- Feels ----------

/**
 * Joint springs, from creatures/src/catbreeds.ts: tail bones get faster and less damped
 * toward the tip, so a swing at the base arrives at the tip late and overshoots. `stiff`
 * scales the tail's frequencies (above 1 a stiffer tail, below 1 a lazier one).
 */
export function feelTable(tails: number, stiff = 1, damp = 0): Record<string, Feel> & { default: Feel } {
  const out: Record<string, Feel> = {
    default: { f: 1.6, zeta: 0.75 },
    root: { f: 2, zeta: 0.8 },
    body: { f: 1.4, zeta: 0.82 },
    head: { f: 1.35, zeta: 0.8, r: 0.12 },
    'ear.L': { f: 2.2, zeta: 0.6 },
    'ear.R': { f: 2.2, zeta: 0.6 },
  };
  for (const leg of ['FL', 'FR', 'BL', 'BR']) {
    out[`leg.${leg}`] = { f: 2, zeta: 0.8 };
    out[`shin.${leg}`] = { f: 2.2, zeta: 0.75 };
  }
  for (let i = 1; i <= tails; i++) {
    out[`tail.${i}`] = { f: (1.2 + (0.55 * i) / tails) * stiff, zeta: 0.55 - (0.1 * i) / tails + damp };
  }
  return out as Record<string, Feel> & { default: Feel };
}

// ---------- Breeds ----------

export const BREED_IDS: readonly BreedId[] = ['tabby', 'siamese', 'black'];

export const BREEDS: Record<BreedId, Breed> = {
  tabby: {
    id: 'tabby',
    name: 'Pixel',
    what: 'Robot tabby with a screen face, a loaf body on short legs and a three-bone tail.',
    dims: {},
    coat: TABBY_COAT,
    feels: feelTable(BASE.tail.bones),
    temperament: { energy: 1, social: 1, napping: 1 },
  },
  siamese: {
    id: 'siamese',
    name: 'Suki',
    what: 'Robot siamese on long legs, with a wedge head, large ears and a five-bone tail.',
    dims: SUKI,
    coat: POINTS_COAT,
    // A whip of a tail in five bones: stiffer springs keep it from trailing like a rope.
    feels: feelTable(SUKI.tail.bones, 1.25),
    temperament: { energy: 1.25, social: 1.3, napping: 0.8 },
  },
  black: {
    id: 'black',
    name: 'Soot',
    what: 'Robot black cat, long and low, with a four-bone tail hooked at the tip.',
    dims: SOOT,
    coat: SOLID_COAT,
    // Slow, well damped tail springs: the tail follows the body late and barely overshoots.
    feels: feelTable(SOOT.tail.bones, 0.75, 0.08),
    temperament: { energy: 0.85, social: 0.7, napping: 1.35 },
  },
};

/** The springs a Puppet needs for a breed, with `default` guaranteed. */
export function feelsFor(breed: Breed): Record<string, Feel> & { default: Feel } {
  return { ...feelTable(dimsOf(breed).tail.bones), ...breed.feels } as Record<string, Feel> & { default: Feel };
}

// ---------- Merging ----------

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Overrides on top of a table: objects merge key by key, arrays and numbers replace. */
function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (over === undefined) return base;
  if (!isPlain(base) || !isPlain(over)) return over as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k], v as DeepPartial<unknown>) : v;
  }
  return out as T;
}

/** A breed's full dimension table: BASE with the breed's overrides on top. */
export function dimsOf(breed: Breed): Dims {
  return merge(BASE, breed.dims);
}
