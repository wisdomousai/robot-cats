/**
 * Quality tiers and the governor that moves between them. Tier 0 is the full look (AO,
 * 2048 shadow map, MSAA in the composer); tier 3 is the floor for weak GPUs. The page
 * starts on `startTier()` and feeds `sample(dt)` every frame; the governor steps down
 * when the frame rate sags and creeps back up only after a long stretch of headroom.
 *
 * This is showcase code, so it may read the wall clock (for the perf log only).
 */

export type TierId = 0 | 1 | 2 | 3;

export interface Tier {
  id: TierId;
  /** Upper bound on the device pixel ratio; the ratio used is min(dpr, this). */
  maxPixelRatio: number;
  /** Shadow map edge in texels. */
  shadow: number;
  /** Ambient occlusion pass through the composer. Off means a direct render. */
  ao: boolean;
  /** MSAA samples on the composer's render targets (the direct path uses the canvas MSAA). */
  samples: number;
  /** Redraw the console every n frames. */
  consoleEvery: number;
}

export const TIERS: readonly Tier[] = [
  { id: 0, maxPixelRatio: 2, shadow: 2048, ao: true, samples: 4, consoleEvery: 1 },
  { id: 1, maxPixelRatio: 1.5, shadow: 1024, ao: true, samples: 2, consoleEvery: 1 },
  { id: 2, maxPixelRatio: 1, shadow: 1024, ao: false, samples: 0, consoleEvery: 2 },
  { id: 3, maxPixelRatio: 1, shadow: 512, ao: false, samples: 0, consoleEvery: 2 },
];

export function tierOf(id: number): Tier {
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, Math.round(id)))];
}

/** The pixel ratio a tier renders at on this display. */
export function pixelRatio(tier: Tier, dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1): number {
  return Math.min(dpr, tier.maxPixelRatio);
}

/**
 * Where to begin. Touch devices and small screens start at tier 2, everything else at 0.
 * `?tier=N` in the URL overrides, for testing.
 */
export function startTier(): TierId {
  if (typeof window === 'undefined') return 0;
  const forced = new URLSearchParams(window.location.search).get('tier');
  if (forced !== null && /^[0-3]$/.test(forced)) return Number(forced) as TierId;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const small = Math.min(window.innerWidth, window.innerHeight) < 600 || window.innerWidth < 820;
  return coarse || small ? 2 : 0;
}

export interface Governor {
  /** The current tier. */
  readonly tier: TierId;
  /** The smoothed frame rate, frames per second. */
  readonly fps: number;
  /** Feed one frame's length in seconds; returns the tier to use from now on. */
  sample(dt: number): TierId;
  /** Pin the tier (null releases it to the governor again). */
  pin(tier: TierId | null): void;
}

/** Frame rate below which the governor steps down. */
const LOW_FPS = 45;
/** Frame rate the governor must see, for UP_SECONDS on end, before it steps up. */
const HIGH_FPS = 58;
const UP_SECONDS = 20;
/** Time constant of the frame rate average, in seconds. */
const TAU = 2;
/** After any change the new tier gets this long before it is judged (reallocations hitch). */
const SETTLE = 3;

export function createGovernor(initial: TierId = 0): Governor {
  let tier: TierId = initial;
  let pinned: TierId | null = null;
  let fps = 60;
  let primed = false;
  let settle = SETTLE;
  let high = 0;
  // Each step down from a tier doubles the time needed to climb back into it, so a GPU
  // that sits on the edge does not flip between two tiers every twenty seconds.
  const failures = [0, 0, 0, 0];

  const change = (next: TierId) => {
    tier = next;
    settle = SETTLE;
    high = 0;
  };

  return {
    get tier() {
      return pinned ?? tier;
    },
    get fps() {
      return fps;
    },
    pin(t) {
      pinned = t;
      if (t !== null) change(t);
    },
    sample(dt) {
      // Skip nonsense and long pauses (a hidden tab, a debugger stop): they say nothing
      // about how fast the GPU draws.
      if (!(dt > 0) || dt > 0.5) return pinned ?? tier;
      const now = 1 / dt;
      if (!primed) {
        fps = now;
        primed = true;
      } else {
        // A time-weighted average of the instantaneous rate is frames counted over the
        // last TAU seconds, so one long frame costs what it should and no more.
        const a = 1 - Math.exp(-dt / TAU);
        fps += a * (now - fps);
      }
      if (pinned !== null) return pinned;
      if (settle > 0) {
        settle -= dt;
        return tier;
      }
      if (fps < LOW_FPS && tier < 3) {
        failures[tier]++;
        change((tier + 1) as TierId);
        // Start the average over in the new tier at the threshold, so the decision there
        // needs fresh evidence either way.
        fps = LOW_FPS + 1;
        return tier;
      }
      high = fps > HIGH_FPS ? high + dt : 0;
      if (tier > 0 && high > UP_SECONDS * 2 ** failures[tier - 1]) change((tier - 1) as TierId);
      return tier;
    },
  };
}

export interface PerfSample {
  /** Seconds since the log started. */
  t: number;
  fps: number;
  tier: TierId;
  /** Longest frame in the last second, milliseconds. */
  worstMs: number;
}

export interface PerfRecord {
  samples: PerfSample[];
  tiers: { t: number; from: TierId; to: TierId }[];
  gpu: string;
}

declare global {
  interface Window {
    __perf?: PerfRecord;
  }
}

/**
 * Collects one fps sample per second into `window.__perf`, only when the URL has `?debug`.
 * The headless fps tool reads it.
 */
export const perfLog = (() => {
  const enabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug');
  const start = typeof performance === 'undefined' ? 0 : performance.now();
  let frames = 0;
  let span = 0;
  let worst = 0;
  let last: TierId | null = null;
  const record: PerfRecord = { samples: [], tiers: [], gpu: '' };
  if (enabled) window.__perf = record;

  return {
    enabled,
    /** Note which GPU and driver the page got. */
    gpu(name: string) {
      record.gpu = name;
    },
    /** Feed every frame. */
    frame(dt: number, tier: TierId) {
      if (!enabled || !(dt > 0)) return;
      const t = (performance.now() - start) / 1000;
      if (last !== null && last !== tier) record.tiers.push({ t, from: last, to: tier });
      last = tier;
      frames++;
      span += dt;
      worst = Math.max(worst, dt);
      if (span >= 1) {
        record.samples.push({ t, fps: frames / span, tier, worstMs: worst * 1000 });
        if (record.samples.length > 900) record.samples.shift();
        frames = 0;
        span = 0;
        worst = 0;
      }
    },
  };
})();
