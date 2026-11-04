import type { V3 } from '../types';

/**
 * Polyline helpers for tubes and paths: the tail, cables, walk routes. Ported from
 * kit.spline, kit.resample and the frames in kit.tube (creatures/blender/kit.py), in
 * three.js axes.
 */

export function lerpV3(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Distance on the floor, ignoring height. */
export function distXZ(a: V3, b: V3): number {
  return Math.hypot(b[0] - a[0], b[2] - a[2]);
}

function dist(a: V3, b: V3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/** Cumulative length at each point, divided by the total: 0 at the start, 1 at the end. */
export function arcParams(points: V3[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + dist(points[i - 1], points[i]));
  const total = out[out.length - 1];
  return out.map((l) => (total > 0 ? l / total : 0));
}

/** n evenly spaced points along a polyline (by arc length), both ends included. */
export function resample(points: V3[], n: number): V3[] {
  if (points.length === 0) return [];
  if (points.length === 1 || n < 2) return Array.from({ length: Math.max(n, 1) }, () => [...points[0]] as V3);
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + dist(points[i - 1], points[i]));
  const total = lengths[lengths.length - 1];
  const out: V3[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = (total * i) / (n - 1);
    while (j < points.length - 2 && lengths[j + 1] < d) j++;
    const seg = lengths[j + 1] - lengths[j];
    out.push(lerpV3(points[j], points[j + 1], seg ? (d - lengths[j]) / seg : 0));
  }
  return out;
}

/**
 * A uniform Catmull-Rom curve through the points. The ends are clamped as in kit.spline:
 * a phantom point is mirrored past each end, so the curve starts and ends on the first and
 * last points heading along the end segments.
 *
 * With `even` (the default, as kit.spline) it returns n points evenly spaced by arc length:
 * the curve is sampled 16 times per segment and resampled, so the inner control points lie
 * on the curve but need not be among the n outputs. With `even = false` the n points are
 * evenly spaced in the curve parameter; when n − 1 is a multiple of the number of
 * segments, every control point is one of them exactly.
 */
export function catmullRom(points: V3[], n: number, even = true): V3[] {
  if (points.length < 2) return resample(points, n);
  const segments = points.length - 1;
  if (even) {
    const dense: V3[] = [];
    for (let i = 0; i < segments; i++) for (let k = 0; k < 16; k++) dense.push(segmentAt(points, i, k / 16));
    dense.push([...points[segments]] as V3);
    return resample(dense, n);
  }
  if (n < 2) return [[...points[0]] as V3];
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const u = (i * segments) / (n - 1);
    const s = Math.min(Math.floor(u), segments - 1);
    out.push(segmentAt(points, s, u - s));
  }
  return out;
}

/** The point at t (0..1) on segment i, from points[i] to points[i + 1]. */
function segmentAt(points: V3[], i: number, t: number): V3 {
  const last = points.length - 1;
  const p1 = points[i];
  const p2 = points[i + 1];
  // Mirrored phantoms past the ends: 2·p0 − p1 before the start, 2·pn − pn−1 after.
  const p0: V3 = i > 0 ? points[i - 1] : [2 * p1[0] - p2[0], 2 * p1[1] - p2[1], 2 * p1[2] - p2[2]];
  const p3: V3 =
    i + 2 <= last ? points[i + 2] : [2 * p2[0] - p1[0], 2 * p2[1] - p1[1], 2 * p2[2] - p1[2]];
  const t2 = t * t;
  const t3 = t2 * t;
  const out: V3 = [0, 0, 0];
  for (let a = 0; a < 3; a++)
    out[a] =
      0.5 *
      (2 * p1[a] +
        (-p0[a] + p2[a]) * t +
        (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 +
        (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3);
  return out;
}

/** An orthonormal frame at a point on a path: binormal = tangent × normal. */
export interface Frame {
  tangent: V3;
  normal: V3;
  binormal: V3;
}

/**
 * Frames that ride along a path without twisting, as kit.tube builds its rings: tangents by
 * central differences, the first normal at right angles to the tangent and the up axis (+y,
 * or +x when the path starts nearly vertical), and each later normal the previous one with
 * its component along the new tangent removed. A tube ring at point i is
 * p + r·(normal·cos a + binormal·sin a).
 */
export function frames(points: V3[]): Frame[] {
  const n = points.length;
  if (n === 0) return [];
  const tangents: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(i - 1, 0)];
    const b = points[Math.min(i + 1, n - 1)];
    tangents.push(normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [0, 1, 0]));
  }
  const t0 = tangents[0];
  const ref: V3 = Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let normal = normalize(cross(t0, ref), [1, 0, 0]);
  const out: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    if (i) {
      const d = dot(normal, t);
      normal = normalize([normal[0] - t[0] * d, normal[1] - t[1] * d, normal[2] - t[2] * d], normal);
    }
    out.push({ tangent: t, normal, binormal: cross(t, normal) });
  }
  return out;
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** v scaled to unit length, or `fallback` when v has none. */
function normalize(v: V3, fallback: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [...fallback];
}
