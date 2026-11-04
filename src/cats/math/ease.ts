/**
 * Timing curves for acts. ease, span and pulse have the same meaning as the local helpers
 * in the creatures package's cat.ts, so acts port line for line.
 */

/** A sine at `hz` cycles per second, `phase` in cycles (0..1). */
export const sin = (t: number, hz: number, phase = 0) => Math.sin(2 * Math.PI * (hz * t + phase));

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 0 before a, 1 after b, smoothstepped between. With a = b it is a step at a. */
export function ease(t: number, a: number, b: number): number {
  if (b === a) return t < a ? 0 : 1;
  const u = clamp((t - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
}

/** Fades in over a..b, holds at 1, and fades out over c..d. */
export function span(t: number, a: number, b: number, c: number, d: number): number {
  return ease(t, a, b) * (1 - ease(t, c, d));
}

/** A bump: up over a..b, down over b..c. */
export function pulse(t: number, a: number, b: number, c: number): number {
  return ease(t, a, b) * (1 - ease(t, b, c));
}

/**
 * A linear 0→1→0 envelope over an act of `length` seconds: rises for `ease` seconds at the
 * start and falls for as long at the end. Same as `envelope` in the creatures character.ts.
 */
export function envelope(t: number, length: number, ease = 0.25): number {
  return clamp(Math.min(t / ease, (length - t) / ease), 0, 1);
}

/**
 * Moves a toward b by the fraction an exponential decay at rate `lambda` (per second)
 * covers in dt. Calling it every frame gives the same curve at any frame rate: two steps
 * of dt land where one step of 2·dt does.
 */
export function damp(a: number, b: number, lambda: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}
