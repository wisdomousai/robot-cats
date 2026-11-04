import { clamp } from '../math/ease';
import type { Expression, Mood, Posture } from '../types';

/**
 * How a cat feels, and how that shows. Ported from the creatures package (pet.ts and the
 * mood table in cat.ts), with two changes for a world that runs on its own:
 *
 * - Moods are levels that decay. An act, a trigger (a poke, the laser, a bird) or the
 *   situation (lying down, the cursor close by) raises a level; each level falls back to
 *   its baseline with its own half-life. The mood is the highest level, so a cat stays
 *   playful for a while after the laser goes off and a startle wears off in seconds.
 * - The mood set is this library's: creatures' `alarmed` is `startled` here, `annoyed`
 *   is `cross`, `asleep` is the sleepy mood with the asleep face, and `playful` and
 *   `focused` are new for games and hunting. Creatures' `sad` is left out because nothing
 *   in the showcase makes a cat sad.
 *
 * The Feeling table says how each mood shows in the tail, ears, face and pupils. A cat
 * shows her mood mostly in the height of her tail and rarely wags it.
 */

export const MOODS: readonly Mood[] = ['calm', 'happy', 'curious', 'playful', 'sleepy', 'cross', 'startled', 'love', 'focused'];

/** How a mood shows. Angles in degrees, rates in Hz. Same fields as creatures' Feeling. */
export interface Feeling {
  face: Expression;
  /** How high the tail is carried (+ up from its rest shape), and a slow rise and fall. */
  carriage: number;
  bob?: [degrees: number, hz: number];
  /** Side to side. Cats barely use it; a lashing tail is a cross cat. */
  wag?: [degrees: number, hz: number];
  /** The tip: curled forward (+) or pulled straight (-), quivering, sudden flicks per second. */
  hook?: number;
  quiver?: number;
  flicks?: number;
  /** Fluffed up like a bottle brush, 0..1. */
  puff?: number;
  /** Ears forward (+) or back (-), out to the sides, and how far they turn after the cursor. */
  ears: number;
  out: number;
  swivel: number;
  /** Pupil dilation, 0..1. */
  pupil: number;
  /** Colour the collar tag and the lights take, or none for the breed's own. */
  tone?: string;
  /** Name of the tail carriage, for the tail gauge. */
  tail: string;
}

/**
 * The mood table. calm, curious, happy, love, startled (alarmed), cross (annoyed) and
 * sleepy are creatures' numbers; playful and focused are new. Tones are creatures'
 * beacon colours for the matching face.
 */
export const FEELINGS: Record<Mood, Feeling> = {
  calm: { face: 'neutral', carriage: -50, bob: [5, 0.2], hook: 15, flicks: 0.1, ears: 0, out: 0, swivel: 0.3, pupil: 0.2, tail: 'Level' },
  curious: { face: 'neutral', carriage: -12, hook: 35, flicks: 1, ears: 14, out: -4, swivel: 0.9, pupil: 0.45, tail: 'Hooked' },
  happy: { face: 'happy', carriage: 8, hook: 28, ears: 12, out: -6, swivel: 0.3, pupil: 0.3, tone: '#ffb347', tail: 'Upright' },
  love: { face: 'love', carriage: 8, hook: 20, quiver: 1, ears: 10, out: -8, swivel: 0, pupil: 0.5, tone: '#ff5fa2', tail: 'Quivering' },
  playful: {
    face: 'starry',
    carriage: 0,
    bob: [10, 0.9],
    hook: 30,
    flicks: 0.6,
    puff: 0.15,
    ears: 16,
    out: -2,
    swivel: 0.6,
    pupil: 0.7,
    tone: '#ffd76a',
    tail: 'Upright',
  },
  focused: { face: 'focused', carriage: -40, hook: -5, quiver: 0.6, flicks: 2, ears: 18, out: -10, swivel: 0, pupil: 0.95, tone: '#6fdc8c', tail: 'Low' },
  startled: { face: 'surprised', carriage: 4, hook: -30, puff: 1, ears: -20, out: 14, swivel: 0, pupil: 1, tone: '#5ec8ff', tail: 'Puffed' },
  cross: {
    face: 'cross',
    carriage: -65,
    bob: [16, 1.4],
    hook: -10,
    flicks: 0.6,
    puff: 0.3,
    ears: -25,
    out: 55,
    swivel: 0,
    pupil: 0.15,
    tone: '#5ec8ff',
    tail: 'Lashing',
  },
  sleepy: { face: 'sleepy', carriage: -75, bob: [3, 0.12], hook: 5, ears: -5, out: 20, swivel: 0.1, pupil: 0.1, tail: 'Low' },
};

/** Acts that come with their own mood, from creatures' actMoods, plus the acts new in this library. */
export const ACT_MOODS: Record<string, Mood> = {
  purr: 'love',
  startle: 'startled',
  hiss: 'startled',
  annoyed: 'cross',
  groom: 'happy',
  groomNap: 'happy',
  stretch: 'sleepy',
  yawn: 'sleepy',
  nap: 'sleepy',
  sleep: 'sleepy',
  loaf: 'sleepy',
  knead: 'love',
  slowBlink: 'love',
  scratch: 'happy',
  tailFlick: 'cross',
  chatter: 'focused',
  pounce: 'focused',
  prowl: 'focused',
  wallWatch: 'curious',
  lookOver: 'curious',
  batPointer: 'playful',
  listen: 'curious',
  sniff: 'calm',
  knock: 'curious',
  headbutt: 'happy',
  corner: 'calm',
  fits: 'happy',
  fitsCheck: 'curious',
  roll: 'happy',
  zoomies: 'playful',
  tailChase: 'playful',
  prance: 'happy',
  dizzy: 'calm',
  sphinx: 'sleepy',
  suddenBath: 'happy',
  bonk: 'curious',
  stareAtNothing: 'focused',
  ignore: 'calm',
  bellyTrap: 'playful',
  dropTest: 'calm',
  keyboard: 'happy',
  boxOverBed: 'happy',
  laserChase: 'focused',
  ballBat: 'playful',
  yarnTangle: 'playful',
};

/** Acts whose face differs from their mood's: asleep while napping, dizzy after a spin. */
export const ACT_FACES: Record<string, Expression> = {
  nap: 'asleep',
  sleep: 'asleep',
  dizzy: 'dizzy',
  slowBlink: 'love',
  zoomies: 'determined',
  fits: 'sheepish',
  knock: 'determined',
  ignore: 'neutral',
};

/**
 * The six tail carriages the tail semaphore steps through, high to low, each with the mood
 * that holds the tail there.
 */
export const SEMAPHORE: readonly { name: string; mood: Mood; carriage: number }[] = [
  { name: 'Upright', mood: 'happy', carriage: FEELINGS.happy.carriage },
  { name: 'Hooked', mood: 'curious', carriage: FEELINGS.curious.carriage },
  { name: 'Puffed', mood: 'startled', carriage: FEELINGS.startled.carriage },
  { name: 'Level', mood: 'calm', carriage: FEELINGS.calm.carriage },
  { name: 'Lashing', mood: 'cross', carriage: FEELINGS.cross.carriage },
  { name: 'Low', mood: 'sleepy', carriage: FEELINGS.sleepy.carriage },
];

/** Half-life of each mood's level in seconds: how long it lingers after its cause has gone. */
export const HALF_LIFE: Record<Mood, number> = {
  calm: 1,
  happy: 10,
  curious: 4,
  playful: 9,
  sleepy: 25,
  cross: 6,
  startled: 1.5,
  love: 8,
  focused: 5,
};

/** Named events that move moods, and by how much (levels are 0..1). */
export const TRIGGERS = {
  /** The cursor or a hand pets the cat. */
  pet: { love: 0.3, happy: 0.2 },
  /** A poke; the reaction act comes from `MoodState.poke`. */
  poke: { cross: 0.35 },
  /** A sudden noise, a cup landing nearby, a cat landing next to it. */
  noise: { startled: 0.8 },
  /** The laser dot turns on or darts past. */
  laser: { focused: 0.6, playful: 0.3 },
  /** A bird on the back wall. */
  bird: { focused: 0.5, curious: 0.3 },
  /** A toy moves within reach. */
  toy: { playful: 0.5, curious: 0.2 },
  /** Something knocked off a ledge reached the floor. */
  knocked: { happy: 0.3 },
  /** A slow blink returned. */
  blink: { love: 0.25 },
  /** Another cat starts a game with it. */
  invite: { playful: 0.45 },
  /** A game got rough. */
  rough: { cross: 0.25, playful: 0.1 },
  /** The belly trap closed on a hand. */
  grab: { playful: 0.4, cross: 0.15 },
  /** A treat bag at 50 m. */
  treat: { happy: 0.8, focused: 0.3 },
  /** Long awake, or a warm spot. */
  tired: { sleepy: 0.25 },
  /** Woken up. */
  wake: { sleepy: -0.5, startled: 0.2 },
} satisfies Record<string, Partial<Record<Mood, number>>>;

export type MoodTrigger = keyof typeof TRIGGERS;

/**
 * How much a mood favours an act: multiplies the act's weight. Acts not listed keep their
 * weight. Breed temperament multiplies on top of this in the act picker.
 */
export const MOOD_BIAS: Record<Mood, Record<string, number>> = {
  calm: { sit: 1.3, loaf: 1.3, groom: 1.2, sniff: 1.2, stareAtNothing: 1.2 },
  happy: { groom: 1.5, roll: 1.6, headbutt: 1.8, prance: 1.5, knead: 1.3, sleep: 0.6 },
  curious: { sniff: 2, prowl: 1.6, listen: 1.8, stareAtNothing: 1.6, fitsCheck: 1.8, knock: 1.5, sleep: 0.4 },
  playful: { pounce: 2.2, zoomies: 2, tailChase: 2, ballBat: 2.5, yarnTangle: 2.5, roll: 1.4, sleep: 0.2, loaf: 0.5 },
  sleepy: { sleep: 3, loaf: 2.5, yawn: 2.5, stretch: 1.6, knead: 1.5, zoomies: 0.15, pounce: 0.3, run: 0.3 },
  cross: { tailFlick: 3, ignore: 2.5, groom: 1.5, headbutt: 0.2, purr: 0.2, knead: 0.3 },
  startled: { zoomies: 1.5, sit: 0.5, sleep: 0.1, loaf: 0.2 },
  love: { knead: 3, slowBlink: 3, purr: 2.5, headbutt: 2.5, groom: 1.3, tailFlick: 0.3 },
  focused: { prowl: 2.5, pounce: 2.5, chatter: 2, stareAtNothing: 1.8, laserChase: 3, sleep: 0.2, groom: 0.5 },
};

/** The multiplier `MOOD_BIAS` gives an act in a mood. */
export function moodBias(mood: Mood, act: string): number {
  return MOOD_BIAS[mood][act] ?? 1;
}

/** The face for a mood, or the act's own face when it has one. */
export function faceFor(mood: Mood, act?: string): Expression {
  return (act && ACT_FACES[act]) || FEELINGS[mood].face;
}

/** The name of the nearest semaphore carriage to a tail angle. */
export function tailState(carriage: number): string {
  let best = SEMAPHORE[0];
  for (const s of SEMAPHORE) if (Math.abs(s.carriage - carriage) < Math.abs(best.carriage - carriage)) best = s;
  return best.name;
}

/** What the cat is up to this step, as far as its mood is concerned. */
export interface MoodContext {
  /** The current act's name. */
  act?: string;
  /** A director's mood for the cat, which wins over everything else while it lasts. */
  role?: Mood | null;
  posture?: Posture;
  /** The cursor is over the cat. */
  hovered?: boolean;
  /** The cursor moved close to the cat within the last moment. */
  cursorNear?: boolean;
}

export type PokeReaction = 'purr' | 'startle' | 'hiss' | 'dizzy';

/** Levels a mood is held at while its cause lasts. */
const HOLD = { role: 0.9, act: 0.85, lying: 0.6, hovered: 0.6, cursor: 0.5 };
/** The current mood keeps this much of a lead, so two close levels do not flicker. */
const STICKY = 0.04;
/** The calm floor: every other mood has to rise above this to show. */
const CALM = 0.35;

export class MoodState {
  readonly levels: Record<Mood, number>;
  mood: Mood;
  /** Seconds in the current mood. */
  held = 0;
  private readonly baseline: Record<Mood, number>;
  private time = 0;
  private pokes: number[] = [];

  /**
   * `temperament` is the breed's: energy raises the playful baseline, napping the sleepy
   * one, social the love one. All stay below the calm floor, so a cat left alone is calm.
   */
  constructor(opts: { temperament?: { energy: number; social: number; napping: number }; start?: Mood } = {}) {
    const t = opts.temperament ?? { energy: 1, social: 1, napping: 1 };
    this.baseline = {
      calm: CALM,
      happy: 0.05,
      curious: 0.05,
      playful: clamp(0.06 * t.energy, 0, 0.3),
      sleepy: clamp(0.08 * t.napping, 0, 0.3),
      cross: 0,
      startled: 0,
      love: clamp(0.04 * t.social, 0, 0.3),
      focused: 0,
    };
    this.levels = { ...this.baseline };
    this.mood = opts.start ?? 'calm';
    if (opts.start) this.levels[opts.start] = Math.max(this.levels[opts.start], HOLD.act);
  }

  /** Apply a named trigger, scaled. */
  trigger(name: MoodTrigger, scale = 1): void {
    const deltas: Partial<Record<Mood, number>> = TRIGGERS[name];
    for (const m of MOODS) {
      const d = deltas[m];
      if (d) this.raise(m, d * scale);
    }
  }

  /** Add to one mood's level (negative lowers it), kept in 0..1. */
  raise(mood: Mood, amount: number): void {
    this.levels[mood] = clamp(this.levels[mood] + amount, 0, 1);
  }

  /**
   * A poke, as creatures' Cat.poke: the third within 2.5 s makes her dizzy, the second
   * makes her hiss, one while lying down or cross startles her, and otherwise she purrs.
   * Returns the act to play.
   */
  poke(posture: Posture = 'stand'): PokeReaction {
    this.pokes = [...this.pokes.filter((at) => this.time - at < 2.5), this.time];
    const n = this.pokes.length;
    if (n >= 3) this.pokes = [];
    this.trigger('poke');
    if (n >= 3) return 'dizzy';
    if (n === 2) {
      this.trigger('noise', 0.6);
      return 'hiss';
    }
    if (posture === 'lie' || this.mood === 'cross') {
      this.trigger('noise');
      return 'startle';
    }
    this.trigger('pet');
    return 'purr';
  }

  /** Decay every level, hold the ones the context keeps up, and pick the mood. */
  step(dt: number, ctx: MoodContext = {}): Mood {
    if (!(dt > 0)) return this.mood;
    this.time += dt;
    for (const m of MOODS) {
      const k = Math.exp((-Math.LN2 * dt) / HALF_LIFE[m]);
      this.levels[m] = this.baseline[m] + (this.levels[m] - this.baseline[m]) * k;
    }
    const hold = (m: Mood, level: number) => {
      if (this.levels[m] < level) this.levels[m] = level;
    };
    const actMood = ctx.act ? ACT_MOODS[ctx.act] : undefined;
    if (actMood) hold(actMood, HOLD.act);
    if (ctx.posture === 'lie' && !actMood) hold('sleepy', HOLD.lying);
    if (ctx.hovered) hold('happy', HOLD.hovered);
    if (ctx.cursorNear) hold('curious', HOLD.cursor);

    let next: Mood;
    if (ctx.role) {
      hold(ctx.role, HOLD.role);
      next = ctx.role;
    } else {
      next = this.mood;
      let best = this.levels[this.mood] + STICKY;
      for (const m of MOODS) {
        if (this.levels[m] > best) {
          best = this.levels[m];
          next = m;
        }
      }
    }
    if (next !== this.mood) {
      this.mood = next;
      this.held = 0;
    } else this.held += dt;
    return this.mood;
  }

  get feeling(): Feeling {
    return FEELINGS[this.mood];
  }

  /** The face for the current mood and act. */
  face(act?: string): Expression {
    return faceFor(this.mood, act);
  }

  readout(): { mood: Mood; held: number; levels: Record<Mood, number> } {
    return { mood: this.mood, held: this.held, levels: { ...this.levels } };
  }
}
