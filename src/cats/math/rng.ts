import type { RngLike } from '../types';

/**
 * A seeded random stream (mulberry32). Everything random in the cats draws from one of
 * these, so a run replays exactly from its seed.
 *
 * fork(label) gives a child stream derived from this stream's seed and the label only,
 * not from how far this stream has run. Subsystems (blinks, act choice, tail flicks) each
 * take a fork, so adding a draw in one does not shift the numbers another one sees.
 */
export class Rng implements RngLike {
  /** The 32-bit seed this stream started from. */
  readonly seed: number;
  private state: number;

  constructor(seed = 1) {
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** An integer in 0..n-1. */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /**
   * A normal sample (Box–Muller, the cosine half; two uniforms per call, nothing cached,
   * so the stream position depends only on the number of calls).
   */
  gauss(mean = 0, sd = 1): number {
    const u = 1 - this.next(); // (0, 1], so the log is finite
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** A child stream for one subsystem, from this seed and a label. */
  fork(label: string): Rng {
    return new Rng(mix(this.seed ^ hash(label)));
  }
}

/** FNV-1a over the label's UTF-16 code units. */
export function hash(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3's finaliser: spreads every input bit over the whole word. */
function mix(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}
