import type { BufferGeometry, Bone, Material, Object3D } from 'three';

/** A point in metres, three.js axes (x the cat's left, y up, z its front). */
export type V3 = [number, number, number];
export type V2 = [number, number];

/** Degrees in the bone's own frame: pitch about x, yaw about y, roll about z. */
export type Turn = [pitch: number, yaw: number, roll: number];

/** Spring settings for a bone: f in Hz, zeta damping, r initial response. */
export interface Feel {
  f: number;
  zeta: number;
  r?: number;
}

export type BoneName =
  | 'root'
  | 'body'
  | 'head'
  | 'ear.L'
  | 'ear.R'
  | `tail.${number}`
  | 'leg.FL'
  | 'leg.FR'
  | 'leg.BL'
  | 'leg.BR'
  | 'shin.FL'
  | 'shin.FR'
  | 'shin.BL'
  | 'shin.BR';

export type LegName = 'FL' | 'FR' | 'BL' | 'BR';
export const LEGS: LegName[] = ['FL', 'FR', 'BL', 'BR'];

/** Which subsystem a part belongs to. The cliché buttons, isolate and x-ray select by this. */
export type SystemId =
  | 'ears'
  | 'head'
  | 'eyes'
  | 'whiskers'
  | 'body'
  | 'belly'
  | 'paws'
  | 'kneading'
  | 'legs'
  | 'righting'
  | 'tail'
  | 'collar'
  | 'voice'
  | 'keyboard'
  | 'bedding'
  | 'antenna'
  | 'lights';

/** Material roles. Coat regions ride on `shell` as vertex colours. */
export type MaterialRole =
  | 'shell'
  | 'joint'
  | 'bezel'
  | 'screen'
  | 'beacon'
  | 'pad'
  | 'inner'
  | `dot${number}`;

export interface PartDef {
  name: string;
  system: SystemId;
  bone: BoneName;
  geometry: BufferGeometry;
  role: MaterialRole;
  /** Only the tail tube: bone names along the chain and a 0..1 parameter per vertex. */
  skin?: { bones: BoneName[]; t: Float32Array };
  /** Unit direction the part flies in the exploded view, in the cat's frame. */
  explode: V3;
  /** Whether the part casts a shadow (bolts and rings do not, to save the shadow pass). */
  shadow?: boolean;
}

export interface BoneDef {
  name: BoneName;
  head: V3;
  tail: V3;
  parent: BoneName | null;
}

/** The dimension table that shapes a cat. Numbers are metres, three.js axes. */
export interface Dims {
  head: { radii: V3; center: V3; e: number; taper?: number };
  screen: { radii: V3; bezel: number; e?: number; dz?: number };
  ear: {
    x: number;
    y: number;
    z: number;
    tilt: number;
    flat: number;
    profile: [r: number, h: number][];
    bone: number;
    pitch?: number;
    inset?: number;
  };
  body: { radii: V3; center: V3; e: number; spine: number };
  leg: { x: number; front: number; back: number; top: number; knee: number; bottom: number; r: number };
  paw: { radii: V3; e: number };
  tail: { points: V3[]; r: [number, number]; bones: number; rings: [number, number][]; tip: number };
  collar: { center: V3; major: number; minor: number; tilt: number; tag: number };
  bell: { r: number; center: V3 };
  whiskers: { x: number; dy: number; dz: number; length: number; n: number };
  antenna: { at: V3; length: number };
  belly: { w: number; h: number };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export type BreedId = 'tabby' | 'siamese' | 'black';

export type CoatRule = 'tabby' | 'points' | 'solid';

export interface CoatSpec {
  rule: CoatRule;
  /** Hex colours by material role for the base look. */
  base: { shell: string; joint: string; bezel: string; glow: string; dot: string; beacon: string };
  /** Hex colours by coat region (Stripe, Patch, Spot, Tail, Tip, Ear, Inner, Paw, Sock, Collar, Mask). */
  regions: Record<string, string>;
}

export interface Breed {
  id: BreedId;
  name: string;
  what: string;
  dims: DeepPartial<Dims>;
  coat: CoatSpec;
  feels: Partial<Record<string, Feel>>;
  /** Multipliers for act weights: energy, social, napping. */
  temperament: { energy: number; social: number; napping: number };
}

/** What `buildCat` returns: a posable model with named parts under bones. */
export interface CatModel {
  breed: Breed;
  root: Object3D;
  bones: Map<string, Bone>;
  parts: PartDef[];
  /** Merged meshes by (bone, material, system); what is actually in the scene. */
  meshes: Object3D[];
  materials: Record<string, Material>;
  /** Rewrite the coat without rebuilding geometry. */
  recoat(coat: CoatSpec): void;
  /** The screen's canvas face. */
  face: FaceLike;
  /** Set emissive level of a light group, 0..1. */
  light(dot: number, level: number): void;
}

export interface FaceLike {
  expression: Expression;
  look: { x: number; y: number };
  blink: number;
  dilate: number;
  talk: number;
  update(time: number, rng: RngLike): void;
  /** Back to the state a new face starts in, for a world that starts over on the same model. */
  reset?(): void;
}

export const EXPRESSIONS = [
  'neutral',
  'happy',
  'surprised',
  'love',
  'wink',
  'sleepy',
  'asleep',
  'dizzy',
  'focused',
  'sad',
  'cross',
  'starry',
  'sheepish',
  'determined',
] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export interface RngLike {
  /** Uniform in [0, 1). */
  next(): number;
  range(a: number, b: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

export type Posture = 'stand' | 'sit' | 'lie';

export type Mood =
  | 'calm'
  | 'happy'
  | 'curious'
  | 'playful'
  | 'sleepy'
  | 'cross'
  | 'startled'
  | 'love'
  | 'focused';

/** Something a cat does for a while, chosen by weight. Same shape as the creatures package. */
export interface Act {
  weight: number;
  /** Seconds, picked between the two. */
  length: [number, number];
  face?: Expression;
  mood?: Mood;
  when?: () => boolean;
  start?: () => void;
  /** Every step with seconds since the act began. */
  pose?: (t: number) => void;
  end?: () => void;
}

/** What a director has a cat doing: it picks no acts of its own while directed. */
export interface Role {
  pose?: (t: number, dt: number) => void;
  face?: Expression;
  mood?: Mood;
  posture?: Posture;
  hurry?: number;
  /** Heading in degrees when standing still. */
  facing?: number;
  /** Where to look, on the floor, or null for nothing in particular. */
  look?: () => V3 | null;
  /** Walk target on the floor, or null to stand. */
  goal?: () => V3 | null;
}

/** Live numbers one cat publishes every step. The console reads these; nothing is typed in. */
export interface CatReadout {
  id: BreedId;
  name: string;
  mood: Mood;
  act: string;
  actT: number;
  posture: Posture;
  position: V3;
  heading: number;
  speed: number;
  gaitPhase: number;
  gait: 'still' | 'walk' | 'trot' | 'run';
  paws: Record<LegName, boolean>;
  /** Servo load per bone group, 0..1. */
  load: Record<'head' | 'body' | 'ears' | 'FL' | 'FR' | 'BL' | 'BR' | 'tail', number>;
  tailEnergy: number;
  tailCarriage: number;
  tailState: string;
  earAzimuth: [number, number];
  headYaw: number;
  gazeTarget: 'owner' | 'box' | 'nothing' | 'toy' | 'cat' | 'bird';
  attention: { owner: number; box: number; nothing: number; toy: number };
  pupil: number;
  blinkMs: number;
  squash: number;
  purrHz: number;
  liquid: boolean;
  bellyArmed: boolean;
  whiskerSpan: number;
}

export interface Counters {
  biscuits: number;
  cups: number;
  lives: number;
  birds: number;
  boxes: number;
  grabs: number;
  laps: number;
  keys: number;
  blinks: number;
}

/** Everything the console draws, rebuilt each step as plain data. */
export interface WorldReadout {
  time: number;
  cats: CatReadout[];
  selected: BreedId;
  subsystem: SystemId | null;
  counters: Counters;
  /** The fake wall clock shown on the zoomies panel, 'HH:MM'. */
  clock: string;
  toys: { kind: string; position: V3; active: boolean }[];
  game: string | null;
  typed: string;
  cupOnLedge: boolean;
  laser: V3 | null;
}

/** What the page or the tour feeds the world each step. */
export interface Input {
  select?: BreedId;
  trigger?: string;
  subsystem?: SystemId | null;
  /** Cursor projected on the floor, or null when off the floor. */
  cursor?: V3 | null;
  /** Cursor over the selected cat's belly. */
  bellyTouch?: boolean;
  resetCounters?: boolean;
}

/** One cliché, written as a mock spec sheet. Buttons, callouts and the tour read this. */
export interface SpecRow {
  label: string;
  value?: string;
  /** Key into CatReadout or Counters for a live value. */
  live?: keyof CatReadout | keyof Counters;
  unit?: string;
  format?: (v: unknown) => string;
}

export interface Subsystem {
  id: SystemId;
  title: string;
  /** Part name prefixes to isolate or x-ray. Empty means the whole cat. */
  parts: string[];
  line: string;
  specs: SpecRow[];
  demo: string;
  props?: string[];
  chart?: 'semaphore' | 'donut' | 'clock' | 'counter';
}

/** The toys and props the world simulates (brain/toys.ts) and the stage draws (geo/props.ts). */
export type ToyKind = 'ball' | 'yarn' | 'laser' | 'cup' | 'ledge' | 'box' | 'bed' | 'keyboard' | 'cushion' | 'bird';

/** One entry of WorldReadout.toys. */
export type ToyReadout = WorldReadout['toys'][number];

/** What a cat is looking at, as the attention panel names it. */
export type Gaze = CatReadout['gazeTarget'];

/** The group games the director runs; the behaviour buttons of the same names start them. */
export type GameName = 'chase' | 'wrestle' | 'tag' | 'yarn' | 'laser';
export const GAME_NAMES: readonly GameName[] = ['chase', 'wrestle', 'tag', 'yarn', 'laser'];
