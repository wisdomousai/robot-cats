/**
 * The auto tour: a SCRIPT of timed beats and a player that walks the fake cursor to each
 * beat's button and presses it. One beat per SUBSYSTEMS row is generated from the table,
 * so adding a row adds a beat. The tour loops; a visitor's input stops it (live.ts), and
 * after a quiet spell it resumes at the next beat.
 *
 * Everything the player does is scheduled on tour time, so `seek(t)` can rebuild the
 * page at any point of the tour by resetting the world and replaying the beats up to t.
 */
import { SUBSYSTEMS, type Input, type SystemId, type ToyKind } from '../cats/index';
import type { Console } from './console';
import { travel, type TourCursor } from './cursor';
import type { Shot, ViewId } from './stage';

/** A beat's camera adjustment. `toward` names a prop, which the page turns into a point. */
export type BeatShot = Omit<Shot, 'toward'> & { toward?: ToyKind };

// ---------- Script ----------

export interface Beat {
  /** Stable name, used for stills file names. */
  name: string;
  /** Seconds from the start of the tour at which the beat fires (the cursor presses). */
  time: number;
  /** Button id the cursor walks to before the beat fires. */
  target?: string;
  /** Whether the cursor presses the target when the beat fires. */
  press: boolean;
  /**
   * For toggles (`xray`, `sys:*`) 1 sets the toggle on and 0 off, so a tour that resumes
   * after a visitor changed things still ends up where the script says. For the explode
   * slider it is the value the cursor drags the knob to.
   */
  value?: number;
  /** Seconds the slider drag takes. */
  drag?: number;
  /** World input that is not a button's own effect, fed when the beat fires. */
  input?: Input;
  /** Camera adjustment for this beat; none means the view as it is. */
  shot?: BeatShot;
  /** Seconds until the next beat. */
  hold: number;
  caption: string;
}

/** Seconds the cursor takes to reach a button before it presses. */
const WALK = 0.9;
/** Seconds of lead when the tour resumes, so the cursor has time to walk to the next button. */
const LEAD = 1.5;
/** The first beat fires here, after the cursor has walked onto the stage. */
const START = 1.2;
const SUBSYSTEM_HOLD = 7.5;
/** Extra seconds for demos that take longer to play out: the bed, then the walk to the box. */
const SUBSYSTEM_EXTRA: Partial<Record<SystemId, number>> = { bedding: 2.5 };

/** The camera view each subsystem's beat is shown from. Rows not listed use three-quarter. */
const SUBSYSTEM_VIEW: Partial<Record<SystemId, ViewId>> = {
  ears: 'head',
  head: 'head',
  eyes: 'head',
  whiskers: 'head',
  body: 'follow',
  belly: 'follow',
  paws: 'follow',
  kneading: 'follow',
  legs: 'follow',
  righting: 'side',
  tail: 'side',
  collar: 'head',
  voice: 'head',
};

/** The follow view's azimuth on the tour: the default camera's, so the demos face it. */
const FOLLOW_HEADING = 32;

/**
 * Beats whose demo does not read from the plain view. The ignore demo turns the cat's back
 * on the owner, so the camera goes behind it, where the box it stares at is in frame. The
 * whisker check has the head in the box opening, which the head view would see from inside
 * the box. The liquid cat lies inside the box walls, so the camera looks down into it. The
 * belly faces up when the cat rolls over, so the camera looks down onto it. The chatter
 * demo looks up at the bird on the back wall, so the camera stands off to the side and
 * frames the head and the bird together.
 */
const SUBSYSTEM_SHOT: Partial<Record<SystemId, BeatShot>> = {
  head: { azimuth: 160, elevation: 22, zoom: 1.5 },
  whiskers: { azimuth: 140, elevation: 26, zoom: 0.95 },
  body: { heading: 12, elevation: 30, zoom: 0.85 },
  belly: { elevation: 40, zoom: 0.8 },
  voice: { heading: 70, elevation: 14, zoom: 1.35, toward: 'bird', mix: 0.5 },
};

/**
 * The tag and yarn games: the top view tilted down to 66 degrees on the default camera's
 * side (azimuth 32), where the yarn game's watchers sit away from the camera, and drawn
 * back to take in the floor. Steep enough that a cat does not stand in front of another
 * cat or the yarn, low enough that the tap and the jump of a tag show.
 */
const GAME_SHOT: BeatShot = { azimuth: 32, elevation: -22, zoom: 1.35 };

const VIEW_CAPTION: Record<ViewId, string> = {
  'three-quarter': 'Three-quarter view of the floor.',
  front: 'Front view of the floor.',
  side: 'Side view of the selected cat.',
  top: 'Top view of the floor.',
  head: 'Close view of the selected cat’s head.',
  follow: 'The camera follows the selected cat.',
};

const firstSentence = (s: string) => {
  const m = /^.*?[.!?](\s|$)/.exec(s);
  return (m ? m[0] : s).trim();
};

function buildScript(): { script: Beat[]; duration: number } {
  const beats: Beat[] = [];
  let t = START;
  const add = (b: Omit<Beat, 'time' | 'press'> & { press?: boolean }) => {
    beats.push({ ...b, press: b.press ?? b.target !== undefined, time: Math.round(t * 100) / 100 });
    t += b.hold;
  };
  let view: ViewId = 'three-quarter';
  // In the follow view every beat names the azimuth, so one beat's turn does not carry over.
  const shotFor = (own?: BeatShot): BeatShot | undefined => (view === 'follow' ? { heading: FOLLOW_HEADING, ...own } : own);
  const toView = (v: ViewId) => {
    if (v === view) return;
    view = v;
    add({ name: `view-${v}`, target: `view:${v}`, hold: 2.4, caption: VIEW_CAPTION[v], shot: shotFor() });
  };

  add({
    name: 'establishing',
    target: 'view:three-quarter',
    hold: 6,
    caption: 'Three robot cats on a floor 3 m wide and 2 m deep.',
    input: { resetCounters: true },
  });
  add({ name: 'select-pixel', target: 'cat:tabby', hold: 4, caption: 'Pixel, the tabby, is selected.' });

  for (const s of SUBSYSTEMS) {
    toView(SUBSYSTEM_VIEW[s.id] ?? 'three-quarter');
    add({
      name: `sys-${s.id}`,
      target: `sys:${s.id}`,
      value: 1,
      hold: SUBSYSTEM_HOLD + (SUBSYSTEM_EXTRA[s.id] ?? 0),
      caption: firstSentence(s.line),
      shot: shotFor(SUBSYSTEM_SHOT[s.id]),
    });
  }

  toView('three-quarter');
  const last = SUBSYSTEMS[SUBSYSTEMS.length - 1];
  add({ name: 'clear', target: `sys:${last.id}`, value: 0, hold: 2.2, caption: 'No subsystem is selected, so the whole cat is shown.' });
  add({ name: 'xray-on', target: 'xray', value: 1, hold: 4.2, caption: 'X-ray draws the selected cat through everything in front of it.' });
  add({ name: 'explode-out', target: 'explode', value: 1, drag: 1.6, hold: 5, caption: 'Explode moves each part out along its own direction.' });
  add({ name: 'explode-in', target: 'explode', value: 0, drag: 1.2, hold: 3, caption: 'The parts go back onto their bones.' });
  add({ name: 'xray-off', target: 'xray', value: 0, hold: 2.2, caption: 'X-ray is off.' });

  toView('top');
  add({
    name: 'tag',
    target: 'act:tag',
    hold: 12,
    caption: 'In tag, the cat that is it chases the nearest cat other than the one that just tagged it.',
    shot: GAME_SHOT,
  });
  add({ name: 'yarn', target: 'act:yarn', hold: 11, caption: 'The yarn is a rope of 24 points. It sticks to the paw that touches it.', shot: GAME_SHOT });
  toView('three-quarter');
  add({ name: 'laser', target: 'act:laser', hold: 11, caption: 'The laser dot moves on a Lissajous path. All three cats follow it.' });

  // Settle: each cat is selected and sent to sleep through the same buttons a visitor uses.
  add({ name: 'sleep-tabby', target: 'act:sleep', hold: 2.6, caption: 'Pixel goes to sleep.' });
  add({ name: 'select-siamese', target: 'cat:siamese', hold: 1.6, caption: 'The siamese is selected.' });
  add({ name: 'sleep-siamese', target: 'act:sleep', hold: 2.6, caption: 'The siamese goes to sleep.' });
  add({ name: 'select-black', target: 'cat:black', hold: 1.6, caption: 'The black cat is selected.' });
  add({ name: 'sleep-black', target: 'act:sleep', hold: 7, caption: 'All three cats are asleep. The tour starts again.' });

  return { script: beats, duration: Math.round(t * 100) / 100 };
}

const built = buildScript();

/** The tour, about 210 s, looped. */
export const SCRIPT: readonly Beat[] = built.script;
/** Length of one loop of the tour, seconds. */
export const DURATION: number = built.duration;

// ---------- Player ----------

/** What the player needs from the page. */
export interface FilmHost {
  /** Apply a button exactly as a visitor's press would (value as in Beat.value). */
  press(id: string, value?: number): void;
  /** Feed world input for the next step. */
  input(input: Input): void;
  /** Show a caption, or none. */
  caption(text: string | null): void;
  /** Set the beat's camera adjustment, or clear it with null. */
  shot(shot: BeatShot | null): void;
  /** The current value of a slider or toggle (explode 0..1, toggles 0 or 1). */
  value(id: string): number;
  /** Put the world and the page back to their state at the start of the tour (for seek). */
  reset(): void;
  /** Advance the world by dt without drawing (for seek). */
  step(dt: number): void;
  /** Draw one frame now, with springs and eases settled. */
  render(): void;
}

export interface Player {
  readonly running: boolean;
  /** Tour time, seconds into the current loop. */
  readonly time: number;
  readonly duration: number;
  /** Index of the last beat that fired in this loop, -1 before the first. */
  readonly beat: number;
  readonly script: readonly Beat[];
  /** Start the tour at page time `at`, `from` seconds into it. */
  start(at: number, from?: number): void;
  /** Hand control to the visitor: the cursor fades out and the caption clears. */
  stop(at?: number): void;
  /** Pick the tour up again at the next beat after the point where it stopped. */
  resume(at?: number): void;
  /** Advance to page time t: fires due beats and moves the cursor. Call once per frame. */
  update(t: number): void;
  /** Rebuild the page at tour time t by resetting and replaying the beats, then draw. */
  seek(t: number): void;
  /** seek(t), then resolve after the browser has painted the frame. */
  renderAt(t: number): Promise<void>;
}

export interface PlayerOptions {
  cursor: TourCursor;
  console: Console;
  host: FilmHost;
  script?: readonly Beat[];
  duration?: number;
}

interface Cue {
  at: number;
  kind: 'walk' | 'fire' | 'rest';
  beat: number;
}

/** Where the cursor waits between beats, console px over the stage. */
const REST: [number, number][] = [
  [820, 450],
  [700, 520],
  [930, 400],
  [760, 560],
  [640, 440],
  [980, 500],
];

/** Fixed step for replay, matching the page's world step. */
const SEEK_STEP = 1 / 120;

export function createPlayer(opts: PlayerOptions): Player {
  const { cursor, host } = opts;
  const con = opts.console;
  const script = opts.script ?? SCRIPT;
  const duration = opts.duration ?? DURATION;

  // Cues in tour time: walk to the button, fire the beat, and drift off to rest when the
  // next button is far enough away in time.
  const cues: Cue[] = [];
  script.forEach((b, i) => {
    if (b.target) cues.push({ at: Math.max(0, b.time - WALK), kind: 'walk', beat: i });
    cues.push({ at: b.time, kind: 'fire', beat: i });
    if (b.target) {
      const end = b.time + (b.drag ?? 0) + 0.3;
      const next = script[i + 1];
      const nextWalk = next ? (next.target ? next.time - WALK : next.time) : duration;
      if (nextWalk - end > 1.8) cues.push({ at: end + 0.35, kind: 'rest', beat: i });
    }
  });
  const order = { walk: 0, fire: 1, rest: 2 } as const;
  cues.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);

  let running = false;
  let lastT = 0;
  /** Page time of tour time 0 in the current loop. */
  let origin = 0;
  let cueIndex = 0;
  let beat = -1;
  let stoppedAt = 0;
  let drag: { id: string; from: number; to: number; start: number; length: number } | null = null;

  const restPoint = (i: number): [number, number] => {
    const [x, y] = REST[((i % REST.length) + REST.length) % REST.length];
    return con.toClient(x, y);
  };
  const pointFor = (b: Beat): [number, number] | null => {
    if (!b.target) return null;
    return con.point(b.target, b.target === 'explode' ? host.value('explode') : undefined);
  };

  const run = (cue: Cue) => {
    const b = script[cue.beat];
    const at = origin + cue.at;
    switch (cue.kind) {
      case 'walk': {
        const p = pointFor(b);
        if (p) {
          cursor.show(at);
          cursor.walkTo(p, WALK - 0.1, at);
        }
        break;
      }
      case 'fire': {
        beat = cue.beat;
        if (b.target && b.press) {
          cursor.press(at);
          if (b.drag && b.value !== undefined) {
            drag = { id: b.target, from: host.value(b.target), to: b.value, start: b.time, length: b.drag };
            const p = con.point(b.target, b.value);
            if (p) cursor.walkTo(p, b.drag, at);
          } else host.press(b.target, b.value);
        }
        if (b.input) host.input(b.input);
        host.shot(b.shot ?? null);
        host.caption(b.caption);
        break;
      }
      case 'rest':
        cursor.walkTo(restPoint(cue.beat), 1.1, at);
        break;
    }
  };

  const advance = (tour: number) => {
    while (cueIndex < cues.length && cues[cueIndex].at <= tour) run(cues[cueIndex++]);
    if (drag) {
      const u = Math.min(1, Math.max(0, (tour - drag.start) / drag.length));
      host.press(drag.id, drag.from + (drag.to - drag.from) * travel(u));
      if (u >= 1) drag = null;
    }
  };

  /** Moves the clock to tour time `tour` in the current loop, wrapping into the next. */
  const runTo = (tour: number) => {
    while (tour >= duration) {
      advance(duration);
      origin += duration;
      tour -= duration;
      cueIndex = 0;
      beat = -1;
    }
    advance(tour);
  };

  const firstCueFrom = (tour: number) => {
    const i = cues.findIndex((c) => c.at >= tour);
    return i < 0 ? cues.length : i;
  };

  const player: Player = {
    get running() {
      return running;
    },
    get time() {
      return running ? Math.max(0, lastT - origin) % duration : stoppedAt;
    },
    duration,
    get beat() {
      return beat;
    },
    script,
    start(at, from = 0) {
      lastT = at;
      origin = at - from;
      cueIndex = firstCueFrom(from);
      beat = -1;
      drag = null;
      running = true;
      cursor.place(restPoint(0));
      cursor.show(at);
    },
    stop(at = lastT) {
      if (!running) return;
      stoppedAt = Math.max(0, at - origin) % duration;
      running = false;
      drag = null;
      cursor.hide(at);
      host.caption(null);
      host.shot(null);
    },
    resume(at = lastT) {
      if (running) return;
      lastT = at;
      let i = script.findIndex((b) => b.time > stoppedAt + 0.05);
      if (i < 0) i = 0;
      const from = i === 0 ? 0 : Math.max(0, script[i].time - LEAD);
      origin = at - from;
      cueIndex = firstCueFrom(from);
      beat = i - 1;
      drag = null;
      running = true;
      cursor.place(restPoint(i));
      cursor.show(at);
    },
    update(t) {
      lastT = t;
      if (!running) return;
      runTo(t - origin);
    },
    seek(t) {
      const target = Math.min(Math.max(0, t), duration - 1e-3);
      host.reset();
      con.clearHistory();
      origin = lastT - target;
      cueIndex = 0;
      beat = -1;
      drag = null;
      running = true;
      cursor.place(restPoint(0));
      cursor.show(origin);
      let now = 0;
      while (now < target - 1e-9) {
        const next = Math.min(target, now + SEEK_STEP);
        advance(next);
        host.step(next - now);
        now = next;
      }
      advance(target);
      cursor.update(lastT);
      host.render();
    },
    renderAt(t) {
      player.seek(t);
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    },
  };
  return player;
}

// ---------- Debug hook ----------

export interface FilmHook {
  readonly script: readonly Beat[];
  readonly duration: number;
  readonly time: number;
  readonly running: boolean;
  seek(t: number): void;
  renderAt(t: number): Promise<void>;
  stop(): void;
  resume(): void;
}

declare global {
  interface Window {
    __film?: FilmHook;
  }
}

/** Puts the player on `window.__film`, only when the URL has `?debug`. Returns the hook or null. */
export function exposeFilm(player: Player): FilmHook | null {
  if (typeof window === 'undefined' || !new URLSearchParams(window.location.search).has('debug')) return null;
  const hook: FilmHook = {
    script: player.script,
    duration: player.duration,
    get time() {
      return player.time;
    },
    get running() {
      return player.running;
    },
    seek: (t) => player.seek(t),
    renderAt: (t) => player.renderAt(t),
    stop: () => player.stop(),
    resume: () => player.resume(),
  };
  window.__film = hook;
  return hook;
}
