import { type BufferGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { bake, boltGeo, cut, lathe, placed, screenPair, stretch, superellipsoid, torus, tube } from '../geo/primitives';
import { catmullRom, resample } from '../math/curve';
import { LEGS, type BoneDef, type BoneName, type CoatSpec, type Dims, type LegName, type MaterialRole, type PartDef, type SystemId, type V3 } from '../types';
import { bodyCoat, byRule, type CoatLayout, headCoat, paintCoat, PLAIN, shinCoat, splitAlong, tailCoat, whole } from './coats';

/**
 * The cat's bones and parts, all from a Dims table, in the cat's frame (+x its left, +y
 * up, +z its front). Positions on the head and body are found on the actual surfaces
 * (rays against the superellipsoids), so a breed that reshapes the head or body carries its
 * bolts, plates, hubs and whiskers along.
 *
 * Part names are the prefixes the cliché table selects by (`Ear.L`, `Whisker.L0`,
 * `Toe.FL.1`); keep them stable. Explode directions are shared per bone and system, with
 * left and right split where both sides of one bone would otherwise fly the same way.
 */

// ---------- Small vector helpers ----------

const v3 = (v: V3) => new Vector3(v[0], v[1], v[2]);
const arr = (v: Vector3): V3 => [v.x, v.y, v.z];
const plus = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];
const ZERO: V3 = [0, 0, 0];
const turn = (from: V3, to: V3) => new Quaternion().setFromUnitVectors(v3(unit(from)), v3(unit(to)));
const rotate = (v: V3, q: Quaternion): V3 => arr(v3(v).applyQuaternion(q));

/** A copy of geo turned by q, then moved to `at`. */
function orient(geo: BufferGeometry, at: V3, q: Quaternion): BufferGeometry {
  return bake(geo, new Matrix4().compose(v3(at), q, new Vector3(1, 1, 1)));
}

const SIDES: [side: 'L' | 'R', s: 1 | -1][] = [
  ['L', 1],
  ['R', -1],
];

// ---------- Surfaces ----------

/**
 * A superellipsoid as the primitive builds it, for placing parts on its surface: the
 * inside-outside function, where a ray from inside leaves it, and the outward normal.
 */
class Shape {
  private readonly a: number;
  private readonly b: number;
  private readonly c: number;

  constructor(
    readonly radii: V3,
    readonly center: V3,
    readonly e1: number,
    readonly e2: number,
    readonly taper = 0,
    axis: 'y' | 'z' = 'y',
  ) {
    [this.a, this.b, this.c] = axis === 'y' ? [1, 2, 0] : [2, 0, 1];
  }

  /** Below 1 inside, 1 on the surface. */
  f(p: V3): number {
    const r = this.radii;
    const q = [p[0] - this.center[0], p[1] - this.center[1], p[2] - this.center[2]];
    const s = q[this.a] / r[this.a];
    const k = Math.max(1e-3, 1 - (this.taper * s) / 2);
    const u = Math.abs(q[this.b] / (r[this.b] * k)) ** (2 / this.e2) + Math.abs(q[this.c] / (r[this.c] * k)) ** (2 / this.e2);
    return u ** (this.e2 / this.e1) + Math.abs(s) ** (2 / this.e1);
  }

  inside(p: V3): boolean {
    return this.f(p) < 1;
  }

  /** Where a ray from `from` (inside) along `dir` leaves the surface. From outside, `from` itself. */
  exit(from: V3, dir: V3): V3 {
    const d = unit(dir);
    let lo = 0;
    let hi = 0.05;
    while (this.f(plus(from, d, hi)) < 1 && hi < 4) hi *= 2;
    if (this.f(from) >= 1) hi = 0;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (this.f(plus(from, d, mid)) < 1) lo = mid;
      else hi = mid;
    }
    return plus(from, d, (lo + hi) / 2);
  }

  normal(p: V3): V3 {
    const h = 1e-4;
    const g: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const a: V3 = [...p];
      const b: V3 = [...p];
      a[k] += h;
      b[k] -= h;
      g[k] = this.f(a) - this.f(b);
    }
    return unit(g);
  }
}

/** The radius of a lathe profile at height h. */
function profileRadius(profile: [number, number][], h: number): number {
  const pts = [...profile].sort((p, q) => p[1] - q[1]);
  if (h <= pts[0][1]) return pts[0][0];
  for (let i = 1; i < pts.length; i++) {
    if (h <= pts[i][1]) {
      const f = (h - pts[i - 1][1]) / (pts[i][1] - pts[i - 1][1] || 1);
      return pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f;
    }
  }
  return pts[pts.length - 1][0];
}

/** The profile with its open end closed by a pole on the axis, so the cone has a floor. */
const closed = (profile: [number, number][]): [number, number][] =>
  profile[profile.length - 1][0] > 0 ? [...profile, [0, profile[profile.length - 1][1]]] : profile;

// ---------- Bones ----------

/** x and z of a leg's hip, knee and ankle. */
export function legXZ(d: Dims, leg: LegName): [x: number, z: number] {
  return [(leg.endsWith('L') ? 1 : -1) * d.leg.x, leg.startsWith('F') ? d.leg.front : d.leg.back];
}

/** The tail's joints: bones+1 points evenly spaced along the same curve the tail tube follows. */
export function tailJoints(d: Dims): V3[] {
  return catmullRom(d.tail.points, d.tail.bones + 1);
}

export function tailBoneNames(d: Dims): BoneName[] {
  return Array.from({ length: d.tail.bones }, (_, i) => `tail.${i + 1}` as BoneName);
}

/**
 * The skeleton, as catbreed.rig_bones with the legs split at the knee: `leg.*` from the
 * hip to the knee, `shin.*` from the knee to the ankle. The body bone runs from the rump to
 * the chest, the head bone from inside the neck up through the head, so the head nods
 * about the neck and the body pitches about the hips.
 */
export function catBones(d: Dims): BoneDef[] {
  const { head: h, ear: e, body: b, leg: lg } = d;
  const [, cy, cz] = b.center;
  const rz = b.radii[2];
  const bones: BoneDef[] = [
    { name: 'root', head: [0, 0, 0], tail: [0, 0.1, 0], parent: null },
    { name: 'body', head: [0, cy, cz - rz * 0.9], tail: [0, cy + 0.02, cz + rz * 0.5], parent: 'root' },
    {
      name: 'head',
      head: [0, h.center[1] - h.radii[1] - 0.04, h.center[2] - h.radii[2] * 0.2],
      tail: [0, h.center[1] + h.radii[1] * 0.6, h.center[2]],
      parent: 'body',
    },
  ];
  for (const [side, s] of SIDES) {
    bones.push({
      name: `ear.${side}`,
      head: [s * e.x, e.y, e.z],
      tail: [s * (e.x + e.bone * Math.sin(e.tilt)), e.y + e.bone * Math.cos(e.tilt), e.z],
      parent: 'head',
    });
  }
  const joints = tailJoints(d);
  const names = tailBoneNames(d);
  names.forEach((name, i) => bones.push({ name, head: joints[i], tail: joints[i + 1], parent: i ? names[i - 1] : 'body' }));
  for (const leg of LEGS) {
    const [x, z] = legXZ(d, leg);
    bones.push({ name: `leg.${leg}`, head: [x, lg.top, z], tail: [x, lg.knee, z], parent: 'body' });
    bones.push({ name: `shin.${leg}`, head: [x, lg.knee, z], tail: [x, lg.bottom, z], parent: `leg.${leg}` });
  }
  return bones;
}

// ---------- Parts ----------

class PartList {
  readonly list: PartDef[] = [];
  constructor(private readonly coat: CoatSpec) {}

  add(name: string, system: SystemId, bone: BoneName, role: MaterialRole, geometry: BufferGeometry, explode: V3, shadow = false) {
    this.list.push({ name, system, bone, role, geometry, explode: unit0(explode), shadow });
  }

  /** Splits a shell part (in its own frame) along its coat borders and paints it. */
  paint(geo: BufferGeometry, layout: CoatLayout): BufferGeometry {
    const g = splitAlong(geo, layout.splits);
    geo.dispose();
    return paintCoat(g, layout, this.coat);
  }
}

/** A unit direction, or zero for a part that stays where it is. */
function unit0(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l < 1e-9 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l];
}

// Explode directions in the cat's frame, by system.
const UP: V3 = [0, 1, 0];
const FORWARD: V3 = [0, 0, 1];
// Each side of the whiskers explodes out its own way, so each side merges into its own
// mesh, which the cat turns about the whisker root to fold the whiskers back in the box.
const whiskersOut = (s: number): V3 => [0.3 * s, -0.25, 1];
const COLLAR_OUT: V3 = [0, -0.35, 1];
const DOWN: V3 = [0, -1, 0];
const BACK: V3 = [0, 0.35, -1];

/**
 * Every part of one cat, painted for `coat` (and classified for the other coats too, so a
 * coat switch needs no rebuild). The tail tube is the only skinned part; the rest are
 * rigid under their bones.
 */
export function catParts(d: Dims, coat: CoatSpec): PartDef[] {
  const P = new PartList(coat);
  head(P, d);
  ears(P, d);
  body(P, d);
  collar(P, d);
  legs(P, d);
  tail(P, d);
  return P.list;
}

function headShape(d: Dims): Shape {
  const H = d.head;
  return new Shape(H.radii, H.center, H.e, H.e, H.taper ?? 0);
}

function bodyShape(d: Dims): Shape {
  const B = d.body;
  return new Shape(B.radii, B.center, B.e, B.e, 0, 'z');
}

/** The screen's centre: the glass stands a fifth of its depth proud of the head's front. */
function screenCentre(d: Dims): V3 {
  const H = d.head;
  const y = H.center[1] + (d.screen.dz ?? 0);
  const front = headShape(d).exit([0, y, H.center[2]], Z);
  return [0, y, front[2] - d.screen.radii[2] * 0.82];
}

function head(P: PartList, d: Dims): void {
  const H = d.head;
  const S = d.screen;
  const hs = headShape(d);
  const [rx, ry, rz] = H.radii;
  const [, cy, cz] = H.center;
  const size = ry / 0.15;

  // Shell, with the coat's borders built in.
  const layout = headCoat(d);
  const shell = P.paint(superellipsoid(H.radii, H.e, H.e, [40, 28], H.taper ?? 0, { rows: layout.rows }), layout);
  P.add('Head', 'head', 'head', 'shell', placed(shell, H.center), ZERO, true);

  // Screen and bezel, and a lip plate round them lying on the head's front.
  const se = S.e ?? H.e;
  const sc = screenCentre(d);
  const { glass, rim } = screenPair(S.radii, S.bezel, se, [40, 24]);
  P.add('Screen', 'eyes', 'head', 'screen', placed(glass, sc), FORWARD);
  P.add('Bezel', 'eyes', 'head', 'bezel', placed(rim, sc), FORWARD);
  const lip: V3 = [S.radii[0] + S.bezel + 0.007, S.radii[1] + S.bezel + 0.007, 0.0035];
  const lipZ = Math.min(hs.exit([lip[0] * 0.95, sc[1], cz], Z)[2], hs.exit([0, sc[1] + lip[1] * 0.95, cz], Z)[2]);
  P.add('ScreenLip', 'eyes', 'head', 'joint', placed(superellipsoid(lip, 0.5, se, [40, 4], 0, { axis: 'z' }), [0, sc[1], lipZ + lip[2] * 0.4]), FORWARD);

  // Crown seam: a cord over the middle of the head from above the screen to the back.
  const seam: V3[] = [];
  for (let i = 0; i <= 120; i++) {
    const phi = (Math.PI * i) / 120;
    const p = hs.exit(H.center, [0, Math.sin(phi), Math.cos(phi)]);
    if (p[2] < cz + 0.8 * rz && p[1] > cy + 0.25 * ry) seam.push(plus(p, hs.normal(p), 0.0018));
  }
  if (seam.length > 4) {
    const cord = resample(seam, 26);
    P.add('CrownSeam', 'head', 'head', 'joint', tube(cord, 0.0032, 6), ZERO);
    [0.22, 0.52, 0.82].forEach((f, i) => {
      const p = cord[Math.round(f * (cord.length - 1))];
      const n = hs.normal(p);
      P.add(`CrownBolt${i}`, 'head', 'head', 'bezel', orient(boltGeo(0.0065, 0.7), plus(p, n, 0.001), turn(Z, n)), ZERO);
    });
  }

  // Vent slats low on the back of the head.
  for (let i = 0; i < 3; i++) {
    const y = cy - ry * (0.05 + 0.2 * i);
    const p = hs.exit([0, y, cz], [0, 0, -1]);
    const n = hs.normal(p);
    const slat = superellipsoid([rx * 0.32, 0.0045 * size, 0.004], 0.4, 0.4, [16, 4], 0, { axis: 'z' });
    P.add(`Head.Vent${i}`, 'head', 'head', 'joint', orient(slat, plus(p, n, 0.001), turn(Z, n)), ZERO);
  }

  // Temple bolts beside the lip, two a side.
  for (const [side, s] of SIDES) {
    [-1, 1].forEach((k, i) => {
      const from: V3 = [s * (lip[0] + 0.011), sc[1] + k * S.radii[1] * 0.42, cz];
      if (!hs.inside(from)) return;
      const p = hs.exit(from, Z);
      const n = hs.normal(p);
      P.add(`TempleBolt.${side}${i}`, 'head', 'head', 'bezel', orient(boltGeo(0.0065, 0.7), p, turn(Z, n)), ZERO);
    });
  }

  // Cheek wedges: two plates stacked low on each cheek, in the coat (stripes, or the mask).
  for (const [side, s] of SIDES) {
    for (let k = 0; k < 2; k++) {
      const p = hs.exit([0, cy - ry * (0.66 + 0.17 * k), cz + rz * (0.3 + 0.1 * k)], [s, 0, 0]);
      const n = hs.normal(p);
      const plate = P.paint(superellipsoid([0.0065, 0.016 * size, (0.03 - 0.006 * k) * size], 0.5, 0.5, [12, 6]), byRule({ tabby: 'Stripe', points: 'Mask' }));
      P.add(`Fluff.${side}${k}`, 'head', 'head', 'shell', orient(plate, plus(p, n, 0.002), turn(X, n)), ZERO);
    }
  }

  // Whisker pods on the cheeks, each with lit-tipped whiskers fanning out and forward.
  const W = d.whiskers;
  const py = sc[1] + W.dy;
  const pz = sc[2] + W.dz;
  const pod = Math.min(1, Math.max(0.7, rx / 0.2));
  for (const [side, s] of SIDES) {
    const cheek = hs.exit([0, py, pz], [s, 0, 0]);
    const px = Math.min(W.x, Math.abs(cheek[0]) - 0.003);
    const root: V3 = [s * px, py, pz];
    P.add(`Pod.${side}`, 'whiskers', 'head', 'joint', placed(superellipsoid([0.016 * pod, 0.016 * pod, 0.022 * pod], 0.5, 0.5, [12, 8]), root), whiskersOut(s));
    for (let k = 0; k < W.n; k++) {
      const dzk = [0.03, 0, -0.03][k % 3] * size;
      const mid: V3 = [s * (px + W.length * 0.5), py + dzk, pz + 0.012];
      const end: V3 = [s * (px + W.length), py + dzk * 1.6, pz + 0.035 + 0.006 * k];
      P.add(`Whisker.${side}${k}`, 'whiskers', 'head', 'bezel', tube([root, mid, end], [0.0032, 0.0022], 5, { samples: 6 }), whiskersOut(s));
      P.add(`WTip.${side}${k}`, 'whiskers', 'head', 'dot4', placed(superellipsoid([0.0055, 0.0055, 0.0055], 1, 1, [8, 5]), end), whiskersOut(s));
    }
  }

  // Antenna: a foot on the crown, a stalk leaning back, a lit ball on top.
  const A = d.antenna;
  const foot = hs.exit([A.at[0], cy, A.at[2]], Y);
  const n = hs.normal(foot);
  const base = plus(foot, n, A.at[1]);
  const back: V3 = [0, 0, -1];
  const stalk = [base, plus(plus(base, n, A.length * 0.5), back, 0.008), plus(plus(base, n, A.length), back, 0.025)];
  P.add('Antenna.Base', 'antenna', 'head', 'joint', orient(superellipsoid([0.015, 0.005, 0.015], 0.35, 1, [14, 4]), plus(base, n, 0.002), turn(Y, n)), UP);
  P.add('Antenna.Stalk', 'antenna', 'head', 'joint', tube(stalk, [0.0035, 0.0022], 6, { samples: 7 }), UP);
  const ringAt = plus(plus(base, n, A.length * 0.3), back, 0.003);
  P.add('Antenna.Ring', 'antenna', 'head', 'joint', orient(torus(0.0048, 0.0016, [12, 4]), ringAt, turn(Y, n)), UP);
  const tipDir = unit([stalk[2][0] - stalk[1][0], stalk[2][1] - stalk[1][1], stalk[2][2] - stalk[1][2]]);
  P.add('Antenna.Tip', 'antenna', 'head', 'dot5', placed(superellipsoid([0.009, 0.009, 0.009], 1, 1, [10, 8]), plus(stalk[2], tipDir, 0.005)), UP);
}

/**
 * Ears: a flattened cone cut flat at the front, with a lit rim and the inner ear set on
 * that flat face, standing in a hinge puck that sits on the head where the cone goes in.
 */
function ears(P: PartList, d: Dims): void {
  const E = d.ear;
  const hs = headShape(d);
  const maxR = Math.max(...E.profile.map(([r]) => r));
  const scale = maxR / 0.078;
  const zc = 0.35 * E.flat * maxR;
  const sink = 0.02;

  for (const [side, s] of SIDES) {
    const bone = `ear.${side}` as BoneName;
    const q = new Quaternion()
      .setFromAxisAngle(v3(Z), -s * E.tilt)
      .multiply(new Quaternion().setFromAxisAngle(v3(X), E.pitch ?? 0));
    const at: V3 = [s * E.x, E.y - sink, E.z];
    const out = unit([s * 0.45, 0.9, 0]);

    const cone = cut(stretch(lathe(closed(E.profile), 22), 1, 1, E.flat), [0, 0, -1], -zc);
    P.add(`Ear.${side}`, 'ears', bone, 'shell', orient(P.paint(cone, whole('Ear')), at, q), out, true);

    const innerProfile = E.profile.map(([r, h]) => [r * 0.62, h * 0.72 + 0.014 * scale] as [number, number]);
    const inner = placed(stretch(lathe(closed(innerProfile), 22), 1, 1, 0.16), [0, 0, zc]);
    P.add(`InnerEar.${side}`, 'ears', bone, 'shell', orient(P.paint(inner, whole('Inner')), at, q), out);

    const rimProfile = E.profile.map(([r, h]) => [r * 0.72, h * 0.8 + 0.01 * scale] as [number, number]);
    const rim = placed(stretch(lathe(closed(rimProfile), 22), 1, 1, 0.1), [0, 0, zc]);
    P.add(`EarRim.${side}`, 'ears', bone, 'dot3', orient(rim, at, q), out);

    // The hinge: a cord round the line where the cone goes into the head, so it lies on both
    // surfaces whatever the head's curve there. For each angle round the cone, the point is
    // found by walking up the cone's side until it leaves the head.
    const minor = 0.0045 * scale;
    const top = Math.max(...E.profile.map(([, h]) => h)) * 0.8;
    const onCone = (th: number, h: number, off: number): V3 => {
      const r = profileRadius(E.profile, h) + off;
      return plus(at, rotate([r * Math.cos(th), h, Math.min(r * E.flat * Math.sin(th), zc + off)], q));
    };
    const ring: V3[] = [];
    const N = 40;
    for (let i = 0; i <= N; i++) {
      // Start at the back, so the seam where the cord closes is out of sight.
      const th = -Math.PI / 2 + (2 * Math.PI * (i % N)) / N;
      let lo = 0;
      let hi = top;
      if (!hs.inside(onCone(th, 0, 0))) hi = 0;
      else if (hs.inside(onCone(th, top, 0))) lo = top;
      else {
        for (let k = 0; k < 30; k++) {
          const mid = (lo + hi) / 2;
          if (hs.inside(onCone(th, mid, 0))) lo = mid;
          else hi = mid;
        }
      }
      ring.push(onCone(th, (lo + hi) / 2, minor * 0.4));
    }
    P.add(`EarHinge.${side}`, 'ears', bone, 'joint', tube(ring, minor, 6, { caps: false }), out);
    // The LED sits on the cord at the outer side of the ear.
    const led = plus(ring[s > 0 ? N / 4 : (3 * N) / 4], rotate([s, 0, 0], q), minor * 0.9);
    P.add(`EarLed.${side}`, 'ears', bone, 'dot3', placed(superellipsoid([0.0055, 0.0055, 0.0055], 1, 1, [8, 5]), led), out);
  }
}

function body(P: PartList, d: Dims): void {
  const B = d.body;
  const bs = bodyShape(d);
  const [rx, ry, rz] = B.radii;
  const [cx, cy, cz] = B.center;
  const lg = d.leg;

  const layout = bodyCoat(d);
  const shell = P.paint(superellipsoid(B.radii, B.e, B.e, [40, 26], 0, { axis: 'z', rows: layout.rows }), layout);
  P.add('Body', 'body', 'body', 'shell', placed(shell, B.center), ZERO, true);

  // A neck, only where the head floats above the front of the body (Suki's long neck).
  const hs = headShape(d);
  const H = d.head;
  const nz = H.center[2] - H.radii[2] * 0.25;
  const from: V3 = [0, cy, nz];
  if (bs.inside(from) && hs.inside([0, H.center[1], nz])) {
    const top = bs.exit(from, Y)[1];
    const chin = hs.exit([0, H.center[1], nz], [0, -1, 0])[1];
    if (chin - top > 0.012) {
      // Thin enough that the tilted collar clears it all the way round.
      const C = d.collar;
      const r = Math.min(Math.min(H.radii[0], rx) * 0.6, (C.major - C.minor - 0.003) * Math.cos(C.tilt));
      const neck = P.paint(tube([[0, top - 0.03, nz + 0.012], [0, chin + 0.03, nz - 0.012]], r, 16), PLAIN);
      P.add('Body.Neck', 'body', 'body', 'shell', neck, ZERO, true);
    }
  }

  // Seam plates round the body, a hair proud of it, between the legs.
  [0.4, -0.05, -0.45].forEach((zp, j) => {
    const k = (1 - Math.abs(zp) ** (2 / B.e)) ** (B.e / 2);
    const slab = superellipsoid([rx * k + 0.0035, ry * k + 0.0035, 0.004], 0.4, B.e, [32, 4], 0, { axis: 'z' });
    const z = cz + zp * rz;
    P.add(`Seam.${j}`, 'body', 'body', 'joint', placed(slab, [cx, cy, z]), ZERO);
    // A bolt on each flank where the seam crosses the middle.
    for (const [side, s] of SIDES) {
      const p = bs.exit([cx, cy, z], [s, 0, 0]);
      P.add(`Seam.${j}.Bolt.${side}`, 'body', 'body', 'bezel', orient(boltGeo(0.0055, 0.7), plus(p, [s, 0, 0], 0.0035), turn(Z, [s, 0, 0])), ZERO);
    }
  });

  // Spine plates down the back.
  for (let j = 0; j < B.spine; j++) {
    const top = bs.exit([0, cy, cz + rz * (0.2 - 0.2 * j)], Y);
    const n = bs.normal(top);
    const plate = superellipsoid([0.035 * (rx / 0.14), 0.0055, 0.022 * (rz / 0.24)], 0.5, 0.5, [14, 4]);
    P.add(`Back.${j}`, 'body', 'body', 'joint', orient(plate, plus(top, n, 0.0015), turn(Y, n)), ZERO);
  }

  // Chest plate on the front, with a bolt each side.
  const chest = bs.exit([0, cy, cz], Z);
  const cn = bs.normal(chest);
  const cw = 0.045 * (rx / 0.14);
  P.add('ChestPlate', 'body', 'body', 'joint', orient(superellipsoid([cw, 0.05 * (ry / 0.12), 0.005], 0.45, 0.6, [18, 6], 0, { axis: 'z' }), plus(chest, cn, 0.001), turn(Z, cn)), ZERO);
  for (const [side, s] of SIDES) {
    const p = plus(plus(chest, cn, 0.006), [s * cw * 0.62, 0, 0]);
    P.add(`ChestPlate.Bolt.${side}`, 'body', 'body', 'bezel', orient(boltGeo(0.005, 0.7), p, turn(Z, cn)), ZERO);
  }

  // Belly plate between the legs, with four bolts.
  const zMid = (lg.front + lg.back) / 2;
  const w = Math.min(d.belly.w, 2 * (lg.x - lg.r) - 0.006);
  const h = Math.min(d.belly.h, lg.front - lg.back - 2 * lg.r - 0.012);
  const under = bs.exit([0, cy, zMid], [0, -1, 0]);
  const belly = P.paint(superellipsoid([w / 2, 0.0045, h / 2], 0.4, 0.45, [24, 4]), whole('Belly'));
  P.add('BellyPlate', 'belly', 'body', 'shell', placed(belly, plus(under, [0, -0.0015, 0])), DOWN);
  [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ].forEach(([sx, sz], i) => {
    const p: V3 = [sx * w * 0.34, under[1] - 0.0058, zMid + sz * h * 0.39];
    P.add(`BellyPlate.Bolt${i}`, 'belly', 'body', 'bezel', orient(boltGeo(0.0045, 0.7), p, turn(Z, [0, -1, 0])), DOWN);
  });

  // Hip hubs on the flanks over each leg, on the body: the leg turns inside its hub.
  for (const leg of LEGS) {
    const [x, z] = legXZ(d, leg);
    const s = Math.sign(x);
    const p = bs.exit([0, lg.top - 0.005, z], [s, 0, 0]);
    const n = bs.normal(p);
    const hr = lg.r * 0.78;
    const hub = superellipsoid([0.0075, hr, hr], 0.3, 1, [16, 4], 0, { axis: 'x' });
    P.add(`Hub.${leg}`, 'legs', 'body', 'joint', orient(hub, plus(p, n, 0.003), turn(X, n)), [s, 0, 0], true);
    P.add(`HubBolt.${leg}`, 'legs', 'body', 'bezel', orient(boltGeo(hr * 0.32, 0.7), plus(p, n, 0.0105), turn(Z, n)), [s, 0, 0]);
  }
}

/** The collar round the neck with studs, a bell at the front, a lit tag to one side and charms to the other. */
function collar(P: PartList, d: Dims): void {
  const C = d.collar;
  const q = new Quaternion().setFromAxisAngle(v3(X), C.tilt);
  const R = C.major;
  const k = R / 0.105;
  const on = (deg: number, r: number): V3 => {
    const a = (deg * Math.PI) / 180;
    return plus(C.center, rotate([r * Math.cos(a), 0, r * Math.sin(a)], q));
  };
  const outward = (deg: number): V3 => {
    const a = (deg * Math.PI) / 180;
    return rotate([Math.cos(a), 0, Math.sin(a)], q);
  };
  const down: V3 = [0, -1, 0];

  P.add('Collar', 'collar', 'body', 'shell', orient(P.paint(torus(R, C.minor, [36, 8]), whole('Collar')), C.center, q), COLLAR_OUT, true);
  [20, 38, 56, 74, 106, 124, 142, 160].forEach((deg, i) => {
    const n = outward(deg);
    P.add(`Stud.${i}`, 'collar', 'body', 'bezel', orient(boltGeo(0.0055 * k, 0.8), on(deg, R + C.minor * 0.85), turn(Z, n)), COLLAR_OUT);
  });

  // The bell hangs from the bottom of the collar at the front.
  const front = plus(on(90, R), [0, -C.minor * 0.9, C.minor * 0.3]);
  const bell = plus(front, d.bell.center);
  const r = d.bell.r;
  P.add('BellCrown', 'collar', 'body', 'bezel', placed(superellipsoid([0.0065 * k, 0.006 * k, 0.0065 * k], 0.6, 1, [10, 5]), plus(bell, [0, r * 0.95, 0])), COLLAR_OUT);
  P.add('Bell', 'collar', 'body', 'beacon', placed(superellipsoid([r, r, r], 1, 1, [16, 12]), bell), COLLAR_OUT);
  P.add('BellSlit', 'collar', 'body', 'bezel', placed(torus(r * 0.955 + 0.0008, 0.0024, [18, 4]), plus(bell, [0, -r * 0.3, 0])), COLLAR_OUT);

  // The tag: a lit disc in a rim, on a ring, to the cat's left of the bell.
  const tagDeg = 63;
  const tg = C.tag;
  const face = turn(Z, unit([outward(tagDeg)[0], 0, outward(tagDeg)[2]]));
  const ringAt = plus(on(tagDeg, R), down, C.minor + 0.004);
  const tagAt = plus(ringAt, down, 0.006 + tg);
  P.add('TagRing', 'collar', 'body', 'bezel', orient(torus(0.0075 * k, 0.0024, [12, 4], { axis: 'z' }), ringAt, face), COLLAR_OUT);
  P.add('Tag', 'collar', 'body', 'beacon', orient(superellipsoid([tg, tg, 0.0035], 0.5, 1, [18, 4], 0, { axis: 'z' }), tagAt, face), COLLAR_OUT);
  P.add('TagRim', 'collar', 'body', 'bezel', orient(torus(tg, 0.0022, [20, 4], { axis: 'z' }), tagAt, face), COLLAR_OUT);

  // Charms to the right: a small ring with a heart of two lobes under it.
  const charmDeg = 117;
  const cface = turn(Z, unit([outward(charmDeg)[0], 0, outward(charmDeg)[2]]));
  const cring = plus(on(charmDeg, R), down, C.minor + 0.003);
  P.add('Charm.Ring', 'collar', 'body', 'bezel', orient(torus(0.005 * k, 0.0018, [10, 4], { axis: 'z' }), cring, cface), COLLAR_OUT);
  [-1, 1].forEach((sx, i) => {
    const lobe = superellipsoid([0.0055 * k, 0.0075 * k, 0.003], 0.8, 0.8, [10, 5]);
    const tilt = new Quaternion().setFromAxisAngle(v3(Z), -0.5 * sx);
    const at = plus(cring, rotate([sx * 0.0035 * k, -0.011 * k, 0], cface));
    P.add(`Charm.${i}`, 'collar', 'body', 'bezel', orient(lobe, at, cface.clone().multiply(tilt)), COLLAR_OUT);
  });
}

function legs(P: PartList, d: Dims): void {
  const lg = d.leg;
  const [pr0, pr1, pr2] = d.paw.radii;
  const rs = lg.r / 0.037;
  const ahead = 0.012 * (pr2 / 0.056);
  const sockLayout = shinCoat();

  for (const leg of LEGS) {
    const [x, z] = legXZ(d, leg);
    const s = Math.sign(x);
    const f = leg.startsWith('F') ? 1 : -1;
    const upper = `leg.${leg}` as BoneName;
    const lower = `shin.${leg}` as BoneName;

    P.add(`Leg.${leg}`, 'legs', upper, 'shell', P.paint(tube([[x, lg.top, z], [x, lg.knee, z]], [lg.r, lg.r * 0.95], 14), PLAIN), [s, 0.15, 0], true);

    const shin = tube([[x, lg.knee, z], [x, lg.bottom, z]], [lg.r * 0.95, lg.r * 0.88], 14, { rows: sockLayout.rows });
    P.add(`Shin.${leg}`, 'legs', lower, 'shell', P.paint(shin, sockLayout), [s, -0.25, 0.35 * f], true);

    // The knee ring sits on the joint, with a bolt on the outside.
    const kneeR = lg.r * 0.95 + 0.0045;
    P.add(`Knee.${leg}`, 'legs', lower, 'joint', placed(torus(kneeR, 0.007 * rs, [16, 5]), [x, lg.knee, z]), [s, -0.25, 0.35 * f]);
    P.add(`Knee.${leg}.Bolt`, 'legs', lower, 'joint', orient(boltGeo(0.0055 * rs, 0.8), [x + s * (kneeR + 0.004 * rs), lg.knee, z], turn(Z, [s, 0, 0])), [s, -0.25, 0.35 * f]);

    // Anklet just above the paw.
    const sockY = pr1 * 2 + 0.016 * rs;
    const along = (lg.knee - sockY) / (lg.knee - lg.bottom);
    const sockR = lg.r * (0.95 + (0.88 - 0.95) * along) + 0.0035;
    P.add(`Sock.${leg}`, 'legs', lower, 'joint', placed(torus(sockR, 0.0075 * rs, [16, 5]), [x, sockY, z]), [s, -0.25, 0.35 * f]);

    // Paw on the floor, three toe beads at its front and a lit pad underneath.
    const pz = z + ahead;
    P.add(`Paw.${leg}`, 'paws', lower, 'shell', placed(P.paint(superellipsoid(d.paw.radii, d.paw.e, 0.6, [18, 10]), whole('Paw')), [x, pr1, pz]), [0.45 * s, -0.1, f], true);
    for (let k = -1; k <= 1; k++) {
      const toe = P.paint(superellipsoid([pr0 * 0.24, 0.008 * (pr1 / 0.03), 0.008 * (pr1 / 0.03)], 1, 1, [8, 6]), whole('Toe'));
      P.add(`Toe.${leg}.${k + 1}`, 'paws', lower, 'shell', placed(toe, [x + k * pr0 * 0.42, pr1 * 0.73 - 0.003 * Math.abs(k), pz + pr2 * 0.92]), [0.45 * s, -0.1, f]);
    }
    P.add(`Pad.${leg}`, 'kneading', lower, 'dot2', placed(superellipsoid([pr0 * 0.5, 0.0035, pr2 * 0.55], 0.5, 0.5, [14, 4]), [x, 0.0025, pz - 0.006]), [s, 0, 0.2 * f]);
  }
}

function tail(P: PartList, d: Dims): void {
  const T = d.tail;
  const n = 30;
  const pts = catmullRom(T.points, n);
  const radius = (t: number) => T.r[0] + (T.r[1] - T.r[0]) * t;
  const bones = tailBoneNames(d);
  const last = bones[bones.length - 1];

  const layout = tailCoat(d);
  const geo = P.paint(tube(pts, pts.map((_, i) => radius(i / (n - 1))), 12, { rows: layout.rows }), layout);
  const t = new Float32Array((geo.getAttribute('t').array as Float32Array).slice());
  P.list.push({ name: 'Tail', system: 'tail', bone: bones[0], role: 'shell', geometry: geo, skin: { bones, t }, explode: ZERO, shadow: true });

  const at = (u: number): V3 => {
    const x = Math.min(Math.max(u, 0), 1) * (n - 1);
    const i = Math.min(Math.floor(x), n - 2);
    const f = x - i;
    return plus(pts[i], [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]], f);
  };
  const tangent = (u: number): V3 => {
    const a = at(Math.max(0, u - 0.02));
    const b = at(Math.min(1, u + 0.02));
    return unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  };
  const thin = T.r[1] / 0.02;

  // Lit bands at the joints between the bones, each on the bone it starts.
  for (let i = 1; i < bones.length; i++) {
    const u = i / bones.length;
    P.add(`TailBand.${i}`, 'tail', bones[i], 'dot1', orient(torus(radius(u) + 0.0035, 0.0045 * thin, [18, 5]), at(u), turn(Y, tangent(u))), BACK);
  }
  P.add('TailCap', 'tail', last, 'joint', orient(torus(radius(0.93) + 0.003, 0.005 * thin, [18, 5]), at(0.93), turn(Y, tangent(0.93))), BACK);
  const end = pts[n - 1];
  P.add('TailTip', 'tail', last, 'dot0', placed(superellipsoid([T.tip, T.tip, T.tip], 1, 1, [12, 10]), plus(end, tangent(1), T.r[1] * 0.55)), BACK);

  // The hub where the tail leaves the rump, flat on the body there.
  const bs = bodyShape(d);
  let exit = pts[0];
  for (let i = 1; i < n; i++) {
    if (!bs.inside(pts[i])) {
      exit = bs.exit(pts[i - 1], [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]]);
      break;
    }
  }
  const hn = bs.normal(exit);
  const hub = superellipsoid([T.r[0] * 1.45, T.r[0] * 1.45, 0.006], 0.35, 1, [18, 4], 0, { axis: 'z' });
  P.add('TailHub', 'tail', 'body', 'joint', orient(hub, plus(exit, hn, 0.001), turn(Z, hn)), BACK);
}
