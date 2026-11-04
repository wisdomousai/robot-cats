/**
 * Geometry primitives, ported from the Blender kit (creatures/blender/kit.py).
 *
 * Every builder returns a non-indexed BufferGeometry, so each triangle owns its three
 * vertices and can later be painted a flat colour of its own. Normals are smooth: they
 * are averaged on the indexed mesh first and then copied out with the vertices.
 *
 * Attributes on every primitive:
 * - `position`, `normal`
 * - `param` (3 floats): where the vertex sits across the part, -1..1 on each axis, in the
 *   part's own proportions. Coat rules classify faces by it, so it is not transformed by
 *   `stretch` or `placed`.
 * - `t` (1 float): how far along the part the vertex sits, 0..1. Along the path for a
 *   tube, along the profile for a lathe, along the polar axis for a superellipsoid, 0 for
 *   a torus.
 * The screen glass also carries `uv`.
 */
import { BufferAttribute, BufferGeometry, Euler, Float32BufferAttribute, Matrix4, Quaternion, Vector3 } from 'three';
import type { V3 } from '../types';

export type Axis = 'x' | 'y' | 'z';

/** Axis indices [polar, b, c] with b × c = polar, so rings built from b to c wind outward. */
function frame(axis: Axis): [number, number, number] {
  if (axis === 'x') return [0, 1, 2];
  if (axis === 'y') return [1, 2, 0];
  return [2, 0, 1];
}

function spow(x: number, e: number): number {
  return Math.sign(x) * Math.abs(x) ** e;
}

/** Collects an indexed mesh, then hands it out non-indexed with smooth normals. */
class Builder {
  pos: number[] = [];
  param: number[] = [];
  t: number[] = [];
  index: number[] = [];

  vertex(p: ArrayLike<number>, param: ArrayLike<number> | null, t: number): number {
    this.pos.push(p[0], p[1], p[2]);
    if (param) this.param.push(param[0], param[1], param[2]);
    this.t.push(t);
    return this.t.length - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.index.push(a, b, c);
  }

  /**
   * Joins consecutive rings into a band of quads. A ring is a closed loop of vertex
   * indices, or a single pole index. Rings run along the shape's axis and each loop runs
   * so that (axis, first step around) is right-handed; the faces then point outward.
   */
  strip(rings: number[][], wrap = false): void {
    const m = rings.length;
    const bands = wrap ? m : m - 1;
    for (let j = 0; j < bands; j++) {
      const A = rings[j];
      const B = rings[(j + 1) % m];
      if (A.length === 1 && B.length === 1) continue;
      if (A.length > 1 && B.length > 1 && A.length !== B.length) throw new Error('strip: rings differ in size');
      const n = Math.max(A.length, B.length);
      for (let i = 0; i < n; i++) {
        const k = (i + 1) % n;
        if (A.length === 1) this.tri(A[0], B[k], B[i]);
        else if (B.length === 1) this.tri(A[i], A[k], B[0]);
        else {
          this.tri(A[i], A[k], B[k]);
          this.tri(A[i], B[k], B[i]);
        }
      }
    }
  }

  /** Fills `param` from the bounding box: -1..1 across each axis about the box centre. */
  boundsParam(): void {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], this.pos[i + k]);
        hi[k] = Math.max(hi[k], this.pos[i + k]);
      }
    }
    this.param = [];
    for (let i = 0; i < this.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const half = (hi[k] - lo[k]) / 2;
        this.param.push(half > 0 ? (this.pos[i + k] - (lo[k] + half)) / half : 0);
      }
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('param', new Float32BufferAttribute(this.param, 3));
    g.setAttribute('t', new Float32BufferAttribute(this.t, 1));
    g.setIndex(this.index);
    g.computeVertexNormals();
    const flat = g.toNonIndexed();
    g.dispose();
    return flat;
  }
}

// ---------- Curves ----------
// A private Catmull-Rom spline and arc-length resampler, the same as kit.spline and
// kit.resample. They can be swapped for catmullRom and resample from ../math/curve.ts
// once that module lands.

function resamplePolyline(points: V3[], n: number): V3[] {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    lengths.push(lengths[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = lengths[lengths.length - 1];
  const out: V3[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = (total * i) / (n - 1);
    while (j < points.length - 2 && lengths[j + 1] < d) j++;
    const span = lengths[j + 1] - lengths[j];
    const f = span ? (d - lengths[j]) / span : 0;
    const [a, b] = [points[j], points[j + 1]];
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
  }
  return out;
}

function splinePoints(points: V3[], n: number): V3[] {
  if (points.length < 2) return points.map((p) => [...p] as V3);
  const first = points[0];
  const second = points[1];
  const last = points[points.length - 1];
  const before = points[points.length - 2];
  const p: V3[] = [
    [2 * first[0] - second[0], 2 * first[1] - second[1], 2 * first[2] - second[2]],
    ...points,
    [2 * last[0] - before[0], 2 * last[1] - before[1], 2 * last[2] - before[2]],
  ];
  const dense: V3[] = [];
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]];
    for (let k = 0; k < 16; k++) {
      const t = k / 16;
      const t2 = t * t;
      const t3 = t2 * t;
      const q = [0, 1, 2].map(
        (c) =>
          0.5 *
          (2 * p1[c] +
            (-p0[c] + p2[c]) * t +
            (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 +
            (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3),
      );
      dense.push([q[0], q[1], q[2]]);
    }
  }
  dense.push([...p[p.length - 2]] as V3);
  return resamplePolyline(dense, n);
}

// ---------- Shapes ----------

export interface SuperellipsoidOptions {
  /** The polar axis, through both poles. Default 'y'. */
  axis?: Axis;
  /**
   * Extra latitude rings, as normalised polar coordinates in -1..1 (the same numbers the
   * `param` attribute carries along the polar axis). Coat borders placed here fall on mesh
   * edges. Values outside the open interval, or on an existing ring, add nothing.
   */
  rows?: number[];
}

/**
 * A closed superellipsoid: a sphere at e1 = e2 = 1, a rounded box below 1, a puck at
 * e1 near 0.3. e1 squares the pole-to-pole profile, e2 the profile around the waist.
 * taper > 0 narrows the top and widens the bottom, like an egg. `seg` is
 * [around the waist, pole to pole].
 */
export function superellipsoid(
  radii: V3,
  e1 = 1,
  e2 = 1,
  seg: [nu: number, nv: number] = [48, 32],
  taper = 0,
  opts: SuperellipsoidOptions = {},
): BufferGeometry {
  const [a, b, c] = frame(opts.axis ?? 'y');
  const [nu, nv] = seg;

  // Each latitude as s, the normalised polar coordinate, and w, the waist scale there.
  const levels: { s: number; w: number }[] = [];
  for (let j = 1; j < nv; j++) {
    const phi = -Math.PI / 2 + (Math.PI * j) / nv;
    levels.push({ s: spow(Math.sin(phi), e1), w: spow(Math.cos(phi), e1) });
  }
  for (const p of opts.rows ?? []) {
    if (!(p > -1 && p < 1)) continue;
    if (levels.some((l) => Math.abs(l.s - p) < 1e-6)) continue;
    // s = sin(phi)^e1, so cos(phi) = sqrt(1 - |s|^(2/e1)).
    levels.push({ s: p, w: Math.sqrt(Math.max(0, 1 - Math.abs(p) ** (2 / e1))) ** e1 });
  }
  levels.sort((l, m) => l.s - m.s);

  const m = new Builder();
  const p = [0, 0, 0];
  const q = [0, 0, 0];
  const vertex = (t: number): number => {
    for (let k = 0; k < 3; k++) q[k] = radii[k] ? p[k] / radii[k] : 0;
    return m.vertex(p, q, t);
  };

  const rings: number[][] = [];
  p[a] = -radii[a];
  p[b] = p[c] = 0;
  rings.push([vertex(0)]);
  for (const { s, w } of levels) {
    const k = 1 - (taper * s) / 2;
    const ring: number[] = [];
    for (let i = 0; i < nu; i++) {
      const th = (2 * Math.PI * i) / nu;
      p[a] = radii[a] * s;
      p[b] = radii[b] * w * spow(Math.cos(th), e2) * k;
      p[c] = radii[c] * w * spow(Math.sin(th), e2) * k;
      ring.push(vertex((s + 1) / 2));
    }
    rings.push(ring);
  }
  p[a] = radii[a];
  p[b] = p[c] = 0;
  rings.push([vertex(1)]);

  m.strip(rings);
  return m.geometry();
}

/** A ring around `axis` (default 'y', so it lies flat in the xz plane). `seg` is [around, across]. */
export function torus(major: number, minor: number, seg: [nu: number, nv: number] = [48, 12], opts: { axis?: Axis } = {}): BufferGeometry {
  const [a, b, c] = frame(opts.axis ?? 'y');
  const [nu, nv] = seg;
  const m = new Builder();
  const p = [0, 0, 0];
  const rings: number[][] = [];
  for (let j = 0; j < nv; j++) {
    const beta = (2 * Math.PI * j) / nv;
    const r = major + minor * Math.cos(beta);
    const ring: number[] = [];
    for (let i = 0; i < nu; i++) {
      const alpha = (2 * Math.PI * i) / nu;
      p[a] = minor * Math.sin(beta);
      p[b] = r * Math.cos(alpha);
      p[c] = r * Math.sin(alpha);
      ring.push(m.vertex(p, null, 0));
    }
    rings.push(ring);
  }
  m.strip(rings, true);
  m.boundsParam();
  return m.geometry();
}

export interface TubeOptions {
  /** Close both ends with a domed cap. Default true. */
  caps?: boolean;
  /** Resample a Catmull-Rom spline through the points to this many points first. */
  samples?: number;
  /**
   * Extra rings at these values of t (0..1 along the path), placed on the path's own
   * chords so the shape does not change. Ring borders painted by t fall on mesh edges
   * only where a ring sits; without one, the two triangles of a quad straddling a border
   * get different mean t and the border zigzags.
   */
  rows?: number[];
}

/**
 * A smooth tube swept along a polyline, with parallel-transport frames so the rings do
 * not twist. `radii` is one radius, one per point (after `samples`), or any other number
 * of radii spread evenly along the length. `t` runs 0..1 along the path by arc length;
 * the start cap has t = 0 and the end cap t = 1.
 */
export function tube(points: V3[], radii: number | number[], ring = 16, opts: TubeOptions = {}): BufferGeometry {
  let pts = opts.samples ? splinePoints(points, opts.samples) : points.map((p) => [...p] as V3);
  // Repeated points give no tangent.
  pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1], p[2] - pts[i - 1][2]) > 1e-9);
  if (pts.length < 2) throw new Error('tube: needs two distinct points');
  let P = pts.map((p) => new Vector3(...p));

  const lengths = [0];
  for (let i = 1; i < P.length; i++) lengths.push(lengths[i - 1] + P[i].distanceTo(P[i - 1]));
  const total = lengths[lengths.length - 1];
  let ts = lengths.map((l) => l / total);

  let rs = ts.map((t, i) => {
    if (typeof radii === 'number') return radii;
    if (radii.length === P.length) return radii[i];
    if (radii.length === 1) return radii[0];
    const u = t * (radii.length - 1);
    const k = Math.min(Math.floor(u), radii.length - 2);
    return radii[k] + (radii[k + 1] - radii[k]) * (u - k);
  });

  const extra = (opts.rows ?? []).filter((r) => r > 0 && r < 1 && !ts.some((t) => Math.abs(t - r) < 1e-6));
  if (extra.length) {
    const items = ts.map((t, i) => ({ t, p: P[i], r: rs[i] }));
    for (const r of extra) {
      let k = 0;
      while (k < ts.length - 2 && ts[k + 1] < r) k++;
      const f = (r - ts[k]) / (ts[k + 1] - ts[k]);
      items.push({ t: r, p: P[k].clone().lerp(P[k + 1], f), r: rs[k] + (rs[k + 1] - rs[k]) * f });
    }
    items.sort((a, b) => a.t - b.t);
    P = items.map((x) => x.p);
    ts = items.map((x) => x.t);
    rs = items.map((x) => x.r);
  }
  const radius = (i: number): number => rs[i];

  const tangents = P.map((_, i) => new Vector3().subVectors(P[Math.min(i + 1, P.length - 1)], P[Math.max(i - 1, 0)]).normalize());
  const ref = Math.abs(tangents[0].y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const normal = new Vector3().crossVectors(tangents[0], ref).normalize();
  const turn = new Quaternion();
  const binormal = new Vector3();
  const offset = new Vector3();
  const v = new Vector3();

  const m = new Builder();
  const rings: number[][] = [];
  const sides: Vector3[][] = [];
  for (let i = 0; i < P.length; i++) {
    const T = tangents[i];
    if (i) {
      // Carry the normal over by the turn between tangents, then square it up again.
      normal.applyQuaternion(turn.setFromUnitVectors(tangents[i - 1], T));
      normal.addScaledVector(T, -normal.dot(T)).normalize();
    }
    binormal.crossVectors(T, normal);
    const r = radius(i);
    const loop: number[] = [];
    const side: Vector3[] = [];
    for (let k = 0; k < ring; k++) {
      const ang = (2 * Math.PI * k) / ring;
      offset.copy(normal).multiplyScalar(Math.cos(ang)).addScaledVector(binormal, Math.sin(ang)).multiplyScalar(r);
      v.copy(P[i]).add(offset);
      side.push(offset.clone());
      loop.push(m.vertex([v.x, v.y, v.z], null, ts[i]));
    }
    rings.push(loop);
    sides.push(side);
  }

  if (opts.caps ?? true) {
    // Domed caps: one ring pulled in towards the axis and out along it, then a pole.
    const dome = (end: number, sign: number): number[][] => {
      const T = tangents[end].clone().multiplyScalar(sign);
      const r = radius(end);
      const t = end > 0 ? 1 : 0;
      const mid = sides[end].map((o) => {
        v.copy(P[end]).addScaledVector(o, 0.7).addScaledVector(T, r * 0.7);
        return m.vertex([v.x, v.y, v.z], null, t);
      });
      v.copy(P[end]).addScaledVector(T, r);
      const pole = [m.vertex([v.x, v.y, v.z], null, t)];
      return sign < 0 ? [pole, mid] : [mid, pole];
    };
    rings.unshift(...dome(0, -1));
    rings.push(...dome(P.length - 1, 1));
  }

  m.strip(rings);
  m.boundsParam();
  return m.geometry();
}

/**
 * A surface of revolution around +y from [radius, height] pairs. A radius of 0 closes
 * that end with a single pole. Profiles run top to bottom as in the kit; one given
 * bottom to top is built the same way. `t` runs 0..1 along the profile from its first
 * point, by arc length.
 */
export function lathe(profile: [r: number, h: number][], seg = 32): BufferGeometry {
  const n = profile.length;
  if (n < 2) throw new Error('lathe: needs two profile points');
  const lengths = [0];
  for (let i = 1; i < n; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  }
  const total = lengths[n - 1] || 1;

  const m = new Builder();
  const [a, b, c] = frame('y');
  const p = [0, 0, 0];
  let rings: number[][] = profile.map(([r, h], i) => {
    const t = lengths[i] / total;
    p[a] = h;
    if (Math.abs(r) < 1e-12) {
      p[b] = p[c] = 0;
      return [m.vertex(p, null, t)];
    }
    const loop: number[] = [];
    for (let k = 0; k < seg; k++) {
      const ang = (2 * Math.PI * k) / seg;
      p[b] = r * Math.cos(ang);
      p[c] = r * Math.sin(ang);
      loop.push(m.vertex(p, null, t));
    }
    return loop;
  });
  // The strip winds outward when rings run up the axis.
  if (profile[0][1] > profile[n - 1][1]) rings = rings.reverse();
  m.strip(rings);
  m.boundsParam();
  return m.geometry();
}

/**
 * A flat panel facing +z: a superellipsoid `w` wide (x), `h` high (y) and `thick` deep
 * (z), all full sizes in metres. `round` rounds both the outline and the edge profile.
 * `seg` is [around the outline, through the thickness].
 */
export function plate(w: number, h: number, thick: number, round = 0.3, seg: [nu: number, nv: number] = [24, 8]): BufferGeometry {
  return superellipsoid([w / 2, h / 2, thick / 2], round, round, seg, 0, { axis: 'z' });
}

/**
 * A face screen set into a head, as kit.screen: `glass`, the front half of a
 * superellipsoid with planar UVs (u along +x, v along +y, so a canvas texture reads
 * upright to a viewer in front, looking down -z), and `rim`, the front half of a shell
 * `bezel` wider and taller, set `bezel` behind the glass so only its edge shows. Both are
 * cut flat at the back and capped. The glass centre is the origin.
 */
export function screenPair(
  radii: V3,
  bezel: number,
  e = 0.35,
  seg: [nu: number, nv: number] = [64, 40],
): { glass: BufferGeometry; rim: BufferGeometry } {
  const glass = cut(superellipsoid(radii, e, e, seg, 0, { axis: 'z', rows: [0] }), [0, 0, 1], 0);
  planarUV(glass, 0, 1);
  const outer: V3 = [radii[0] + bezel, radii[1] + bezel, radii[2]];
  const shell = cut(superellipsoid(outer, e, e, seg, 0, { axis: 'z', rows: [0] }), [0, 0, 1], 0);
  const rim = placed(shell, [0, 0, -bezel]);
  shell.dispose();
  return { glass, rim };
}

const bolts = new Map<string, BufferGeometry>();

/**
 * A rounded bolt head: a dome of radius `r`, `r * flat` high, standing on the origin and
 * facing +z, with a flat underside. One geometry is shared per (r, flat), so treat it as
 * read-only; `placed` and `stretch` return copies.
 */
export function boltGeo(r: number, flat = 1): BufferGeometry {
  const key = `${r}:${flat}`;
  let geo = bolts.get(key);
  if (!geo) {
    geo = cut(superellipsoid([r, r, r * flat], 0.8, 1, [12, 6], 0, { axis: 'z' }), [0, 0, 1], 0);
    bolts.set(key, geo);
  }
  return geo;
}

// ---------- Transforms ----------

/** Reverses every triangle, for a transform that mirrors the shape. */
function flipWinding(geo: BufferGeometry): void {
  if (geo.index) {
    const idx = geo.index;
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, b);
    }
    idx.needsUpdate = true;
    return;
  }
  for (const name of Object.keys(geo.attributes)) {
    const attr = geo.getAttribute(name) as BufferAttribute;
    const arr = attr.array;
    const s = attr.itemSize;
    for (let i = 0; i + 2 < attr.count; i += 3) {
      for (let k = 0; k < s; k++) {
        const j1 = (i + 1) * s + k;
        const j2 = (i + 2) * s + k;
        const tmp = arr[j1];
        arr[j1] = arr[j2];
        arr[j2] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
}

/**
 * A copy of the geometry with the matrix baked in. Normals go through the normal matrix;
 * a mirroring matrix also reverses the triangles so they still face outward. `param`
 * and `t` are left as they are.
 */
export function bake(geo: BufferGeometry, matrix: Matrix4): BufferGeometry {
  const out = geo.clone();
  // clone() shares the userData object; give the copy its own.
  out.userData = { ...geo.userData };
  out.applyMatrix4(matrix);
  if (matrix.determinant() < 0) flipWinding(out);
  return out;
}

/** A copy scaled about the origin, as kit.stretch (flatten an ear, widen a paw). */
export function stretch(geo: BufferGeometry, sx = 1, sy = 1, sz = 1): BufferGeometry {
  return bake(geo, new Matrix4().makeScale(sx, sy, sz));
}

/** A copy scaled, then turned by `rotation` (Euler radians, XYZ order), then moved to `position`. */
export function placed(geo: BufferGeometry, position: V3, rotation: V3 = [0, 0, 0], scale: number | V3 = 1): BufferGeometry {
  const s = typeof scale === 'number' ? new Vector3(scale, scale, scale) : new Vector3(...scale);
  const q = new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], 'XYZ'));
  return bake(geo, new Matrix4().compose(new Vector3(...position), q, s));
}

// ---------- Cutting ----------

const PLANE_EPS = 1e-7;

/**
 * Slices a part flat, as kit.cut: keeps the side `normal` points to (the plane sits
 * `offset` along the normal from the origin) and, with `cap`, closes the opening with a
 * flat face whose edge stays sharp. Every attribute is interpolated along cut edges.
 * Returns a new non-indexed geometry; region tables from painting do not carry over, so
 * cut before painting.
 */
export function cut(geo: BufferGeometry, normal: V3, offset = 0, cap = true): BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const names = Object.keys(src.attributes);
  const attrs = names.map((k) => src.getAttribute(k) as BufferAttribute);
  const offsets: number[] = [];
  let width = 0;
  for (const attr of attrs) {
    offsets.push(width);
    width += attr.itemSize;
  }
  const po = offsets[names.indexOf('position')];
  const ni = names.indexOf('normal');
  const no = ni >= 0 ? offsets[ni] : -1;
  const n = new Vector3(...normal).normalize();

  const read = (i: number): number[] => {
    const out = new Array<number>(width);
    attrs.forEach((attr, a) => {
      for (let k = 0; k < attr.itemSize; k++) out[offsets[a] + k] = attr.getComponent(i, k);
    });
    return out;
  };
  const dist = (v: number[]): number => {
    const d = v[po] * n.x + v[po + 1] * n.y + v[po + 2] * n.z - offset;
    return Math.abs(d) < PLANE_EPS ? 0 : d;
  };
  // Always interpolated from the kept end, so both triangles on an edge get the same point.
  const between = (keep: number[], drop: number[], dk: number, dd: number): number[] => {
    const f = dk / (dk - dd);
    const v = keep.map((x, k) => x + (drop[k] - x) * f);
    if (no >= 0) {
      const l = Math.hypot(v[no], v[no + 1], v[no + 2]) || 1;
      for (let k = 0; k < 3; k++) v[no + k] /= l;
    }
    return v;
  };
  const key = (v: number[]): string =>
    `${Math.round(v[po] * 1e7)},${Math.round(v[po + 1] * 1e7)},${Math.round(v[po + 2] * 1e7)}`;

  const out: number[][] = names.map(() => []);
  const emit = (v: number[]): void => {
    attrs.forEach((attr, a) => {
      for (let k = 0; k < attr.itemSize; k++) out[a].push(v[offsets[a] + k]);
    });
  };

  // Edges of the kept surface lying in the plane. An edge met in both directions is
  // shared by two kept faces and is not part of the opening.
  interface Edge { a: number[]; ka: string; kb: string }
  const edges = new Map<string, Edge>();
  const addEdge = (a: number[], b: number[]): void => {
    const ka = key(a);
    const kb = key(b);
    if (ka === kb) return;
    if (edges.delete(`${kb}|${ka}`)) return;
    edges.set(`${ka}|${kb}`, { a, ka, kb });
  };

  const count = src.getAttribute('position').count;
  for (let f = 0; f + 2 < count; f += 3) {
    const V = [read(f), read(f + 1), read(f + 2)];
    const D = V.map(dist);
    // A face lying in the plane is dropped; the cap replaces it.
    if (D[0] === 0 && D[1] === 0 && D[2] === 0) continue;
    const poly: number[][] = [];
    const on: boolean[] = [];
    for (let e = 0; e < 3; e++) {
      const [p, q, dp, dq] = [V[e], V[(e + 1) % 3], D[e], D[(e + 1) % 3]];
      if (dp >= 0) {
        poly.push(p);
        on.push(dp === 0);
      }
      if (dp > 0 && dq < 0) {
        poly.push(between(p, q, dp, dq));
        on.push(true);
      } else if (dp < 0 && dq > 0) {
        poly.push(between(q, p, dq, dp));
        on.push(true);
      }
    }
    if (poly.length < 3) continue;
    for (let i = 1; i + 1 < poly.length; i++) {
      emit(poly[0]);
      emit(poly[i]);
      emit(poly[i + 1]);
    }
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      if (on[i] && on[j]) addEdge(poly[i], poly[j]);
    }
  }

  if (cap && edges.size) {
    const byStart = new Map<string, Edge[]>();
    for (const e of edges.values()) {
      const list = byStart.get(e.ka);
      if (list) list.push(e);
      else byStart.set(e.ka, [e]);
    }
    const used = new Set<Edge>();
    const down = n.clone().negate();
    for (const first of edges.values()) {
      if (used.has(first)) continue;
      const loop: number[][] = [];
      let e: Edge | undefined = first;
      while (e && !used.has(e)) {
        used.add(e);
        loop.push(e.a);
        e = byStart.get(e.kb)?.find((x) => !used.has(x));
      }
      if (loop.length < 3) continue;
      const ring = loop.map((v) => v.slice());
      const centre = new Array<number>(width).fill(0);
      for (const v of ring) for (let k = 0; k < width; k++) centre[k] += v[k] / ring.length;
      if (no >= 0) {
        for (const v of [centre, ...ring]) {
          v[no] = down.x;
          v[no + 1] = down.y;
          v[no + 2] = down.z;
        }
      }
      // Wind the fan so the cap faces away from the kept side (Newell's normal).
      const newell = new Vector3();
      for (let i = 0; i < ring.length; i++) {
        const [p, q] = [ring[i], ring[(i + 1) % ring.length]];
        newell.x += (p[po + 1] - q[po + 1]) * (p[po + 2] + q[po + 2]);
        newell.y += (p[po + 2] - q[po + 2]) * (p[po] + q[po]);
        newell.z += (p[po] - q[po]) * (p[po + 1] + q[po + 1]);
      }
      const forward = newell.dot(down) > 0;
      for (let i = 0; i < ring.length; i++) {
        const [p, q] = [ring[i], ring[(i + 1) % ring.length]];
        emit(centre);
        emit(forward ? p : q);
        emit(forward ? q : p);
      }
    }
  }

  const result = new BufferGeometry();
  names.forEach((name, a) => result.setAttribute(name, new Float32BufferAttribute(out[a], attrs[a].itemSize)));
  if (src !== geo) src.dispose();
  return result;
}

// ---------- UVs ----------

/** Projects UVs flat along two axes, normalised to the geometry's bounds. */
function planarUV(geo: BufferGeometry, u: number, v: number): void {
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const lo = box.min.toArray();
  const hi = box.max.toArray();
  const pos = geo.getAttribute('position') as BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[2 * i] = (pos.getComponent(i, u) - lo[u]) / (hi[u] - lo[u] || 1);
    uv[2 * i + 1] = (pos.getComponent(i, v) - lo[v]) / (hi[v] - lo[v] || 1);
  }
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
}
