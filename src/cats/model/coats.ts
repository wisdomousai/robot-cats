import type { BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { paintFaces, recolour, type Classify, type RegionTable } from '../geo/paint';
import { cut } from '../geo/primitives';
import type { CoatRule, CoatSpec, Dims, V3 } from '../types';

/**
 * Coats as paint on the shell. Every shell face is classified once, for all three coat
 * rules at the same time, into a compound region name such as `Stripe|Mask|`: the tabby
 * rule's region, the points rule's and the solid rule's, '' where a rule leaves the base
 * colour. A coat switch then only rewrites the colour attribute, picking the part of each
 * name that belongs to the new coat's rule, so a siamese can wear a tabby coat without
 * rebuilding a mesh.
 *
 * Borders stay straight because they fall on mesh edges: rows inserted into the shape
 * along its own axis (latitudes of a superellipsoid, rings of a tube), and planes the
 * part is split along before painting, as the Blender coats bisect the mesh.
 */

export const COAT_RULES: readonly CoatRule[] = ['tabby', 'points', 'solid'];

/** What each coat rule calls a face of one part; a missing rule leaves the base colour. */
export type Painter = Partial<Record<CoatRule, Classify>>;

export interface CoatLayout {
  /** Rows along the part's own axis: normalised polar coordinate, or t along a tube. */
  rows: number[];
  /** Planes in the part's local frame (unit normal, offset along it) that borders run along. */
  splits: [V3, number][];
  paint: Painter;
}

// Region tables in the part's own proportions (param, -1..1 across each radius), from
// creatures/blender/cat.py with Blender's y (chest -1 to rump +1) turned into three's z.
const BODY_STRIPES: [number, number][] = [
  [0.18, 0.36],
  [-0.16, 0.02],
  [-0.5, -0.32],
  [-0.82, -0.66],
];
/** Stripes run down the flanks to here (param y). */
const BODY_LOW = -0.3;
const HEAD_STRIPES: [number, number][] = [
  [-0.4, -0.22],
  [-0.08, 0.08],
  [0.22, 0.4],
];
/** Head stripes start above the brow (param y) and stop short of the back of the head (param z). */
const HEAD_BROW = 0.62;
const HEAD_BACK = -0.35;
/** The siamese mask is the front of the head ahead of this plane (param z). */
const MASK_FRONT = 0.55;
/** On the points coat the tail darkens to its tip from here (t), and the socks start here on the shin. */
const POINT_TIP = 0.8;
const SOCK_FROM = 0.35;

const within = (v: number, bands: [number, number][]) => bands.some(([a, b]) => a < v && v < b);

/** One region for the whole part, the same for every rule (an ear, a paw, the collar). */
export function whole(region: string): CoatLayout {
  const all: Classify = () => region;
  return { rows: [], splits: [], paint: { tabby: all, points: all, solid: all } };
}

/** One region for the whole part per rule; rules not named leave the base colour. */
export function byRule(regions: Partial<Record<CoatRule, string>>): CoatLayout {
  const paint: Painter = {};
  for (const rule of COAT_RULES) {
    const region = regions[rule];
    if (region) paint[rule] = () => region;
  }
  return { rows: [], splits: [], paint };
}

/** The base colour everywhere (still painted, so the merged mesh has a region table). */
export const PLAIN: CoatLayout = { rows: [], splits: [], paint: {} };

/**
 * The head, built with its polar axis up: tabby stripes over the crown (the brow is a
 * row, the stripe sides and back edge are planes) and the siamese mask on the face.
 */
export function headCoat(d: Dims): CoatLayout {
  const [rx, , rz] = d.head.radii;
  const splits: [V3, number][] = HEAD_STRIPES.flat().map((v) => [[1, 0, 0], v * rx] as [V3, number]);
  splits.push([[0, 0, 1], HEAD_BACK * rz], [[0, 0, 1], MASK_FRONT * rz]);
  return {
    rows: [HEAD_BROW],
    splits,
    paint: {
      tabby: (_c, p) => (p[1] > HEAD_BROW && p[2] > HEAD_BACK && within(p[0], HEAD_STRIPES) ? 'Stripe' : null),
      points: (_c, p) => (p[2] > MASK_FRONT ? 'Mask' : null),
    },
  };
}

/** The body, built with its polar axis along z so each stripe border is a row; the flank limit is a plane. */
export function bodyCoat(d: Dims): CoatLayout {
  const ry = d.body.radii[1];
  return {
    rows: BODY_STRIPES.flat(),
    splits: [[[0, 1, 0], BODY_LOW * ry]],
    paint: {
      tabby: (_c, p) => (p[1] > BODY_LOW && within(p[2], BODY_STRIPES) ? 'Stripe' : null),
    },
  };
}

/** The tail tube, by t: tabby rings from the breed's table, the points coat dark with a darker tip. */
export function tailCoat(d: Dims): CoatLayout {
  const rings = d.tail.rings;
  const rows = [...rings.flat(), POINT_TIP].filter((v) => v > 0 && v < 1);
  return {
    rows,
    splits: [],
    paint: {
      tabby: (_c, _p, t) => (rings.some(([a, b]) => a <= t && t < b) ? 'Tip' : 'Tail'),
      points: (_c, _p, t) => (t >= POINT_TIP ? 'Tip' : 'Tail'),
      solid: () => 'Tail',
    },
  };
}

/** The lower leg, by t from the knee: the points coat's socks. */
export function shinCoat(): CoatLayout {
  return {
    rows: [SOCK_FROM],
    splits: [],
    paint: { points: (_c, _p, t) => (t > SOCK_FROM ? 'Sock' : null) },
  };
}

// ---------- Splitting ----------

/**
 * Cuts a part along each plane and keeps both sides, so the plane becomes a line of mesh
 * edges and a border painted there is straight. Every attribute is interpolated along the
 * new edges. Planes that miss the part are skipped. Returns a new geometry.
 */
export function splitAlong(geo: BufferGeometry, planes: [V3, number][]): BufferGeometry {
  let g = geo;
  for (const [n, offset] of planes) {
    const front = cut(g, n, offset, false);
    const back = cut(g, [-n[0], -n[1], -n[2]], -offset, false);
    const fc = front.getAttribute('position').count;
    const bc = back.getAttribute('position').count;
    let next: BufferGeometry;
    if (fc === 0 || bc === 0) {
      next = fc === 0 ? back : front;
      (fc === 0 ? front : back).dispose();
    } else {
      const merged = mergeGeometries([front, back], false);
      if (!merged) throw new Error('splitAlong: halves do not merge');
      next = merged;
      front.dispose();
      back.dispose();
    }
    if (g !== geo) g.dispose();
    g = next;
  }
  return g === geo ? geo.clone() : g;
}

// ---------- Painting ----------

const SEPARATOR = '|';

/** One classifier from a painter: the compound name of every rule's region, or null for base everywhere. */
function compound(paint: Painter): Classify {
  const rules = COAT_RULES.map((r) => paint[r]);
  return (centre, param, t) => {
    let any = false;
    const names = rules.map((classify) => {
      const name = classify ? classify(centre, param, t) : null;
      if (name) any = true;
      return name ?? '';
    });
    return any ? names.join(SEPARATOR) : null;
  };
}

/**
 * The colour of a coat region. A region the coat does not name falls back the way the
 * Blender looks do: inner ears, toes and the collar to the joint colour, a tail tip to the
 * tail, socks to the paws, everything else to the shell.
 */
export function regionColour(coat: CoatSpec, region: string): string {
  const named = coat.regions[region];
  if (named) return named;
  switch (region) {
    case 'Inner':
    case 'Toe':
    case 'Collar':
      return coat.base.joint;
    case 'Tip':
      return coat.regions.Tail ?? coat.base.shell;
    case 'Sock':
      return coat.regions.Paw ?? coat.base.shell;
    default:
      return coat.base.shell;
  }
}

/** Rewrites a painted geometry's colours for a coat, from its stored compound region names. */
export function recoatGeometry(geo: BufferGeometry, coat: CoatSpec): BufferGeometry {
  const table = geo.userData as Partial<RegionTable>;
  if (!table.regionNames) return geo;
  const k = COAT_RULES.indexOf(coat.rule);
  const colours: Record<string, string> = {};
  for (const name of table.regionNames) {
    const region = name.split(SEPARATOR)[k] ?? '';
    colours[name] = region ? regionColour(coat, region) : coat.base.shell;
  }
  return recolour(geo, colours, coat.base.shell);
}

/** Classifies a part's faces for every rule and colours them for `coat`. Returns the same geometry. */
export function paintCoat(geo: BufferGeometry, layout: CoatLayout, coat: CoatSpec): BufferGeometry {
  paintFaces(geo, compound(layout.paint), {}, coat.base.shell);
  return recoatGeometry(geo, coat);
}
