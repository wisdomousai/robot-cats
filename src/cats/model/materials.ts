import { Color, type Material, MeshBasicMaterial, MeshStandardMaterial, type Texture } from 'three';
import { linearColour } from '../geo/paint';
import type { CoatSpec, MaterialRole } from '../types';

/**
 * The cat's materials by role. The shell carries the coat as vertex colours, so one
 * shell material serves every coat; the other roles are single colours set from the coat
 * (`tintMaterials`). Lights are the dots and the beacon: emissive, with a level the brain
 * sets per frame through `setLight`.
 *
 * Dots, as in the creatures cats plus two new ones:
 */
export const DOT = {
  tailTip: 0,
  tailBands: 1,
  pads: 2,
  ears: 3,
  whiskers: 4,
  antenna: 5,
  charms: 6,
  spare: 7,
} as const;
export const DOT_COUNT = 8;

/** Emissive intensity at light level 1. Above 1 so the dots bloom a little under ACES tone mapping. */
const DOT_GAIN = 2.4;
const BEACON_GAIN = 1.6;
/** The dark glass a dot shows when it is off. */
const DOT_OFF = '#1e1f24';

export interface MaterialOptions {
  /** The face canvas, shown by the screen as its emissive map. */
  faceMap?: Texture | null;
  /** Colour of the x-ray look. */
  accent?: string;
}

export const MATERIAL_ROLES: readonly MaterialRole[] = [
  'shell',
  'joint',
  'bezel',
  'screen',
  'beacon',
  'pad',
  'inner',
  ...Array.from({ length: DOT_COUNT }, (_, i) => `dot${i}` as MaterialRole),
];

/** A fresh material set for one cat in a coat. Keys are the roles plus `ghost` and `xray`. */
export function catMaterials(coat: CoatSpec, opts: MaterialOptions = {}): Record<string, Material> {
  const m: Record<string, Material> = {
    shell: new MeshStandardMaterial({ name: 'shell', color: '#ffffff', vertexColors: true, roughness: 0.5, metalness: 0 }),
    joint: new MeshStandardMaterial({ name: 'joint', roughness: 0.38, metalness: 0.15 }),
    bezel: new MeshStandardMaterial({ name: 'bezel', roughness: 0.3, metalness: 0.25 }),
    screen: new MeshStandardMaterial({
      name: 'screen',
      color: '#07080a',
      roughness: 0.18,
      metalness: 0,
      emissive: '#ffffff',
      emissiveMap: opts.faceMap ?? null,
      emissiveIntensity: opts.faceMap ? 1.2 : 0,
    }),
    beacon: new MeshStandardMaterial({ name: 'beacon', roughness: 0.3, metalness: 0.1 }),
    pad: new MeshStandardMaterial({ name: 'pad', color: '#3a3532', roughness: 0.85, metalness: 0 }),
    inner: new MeshStandardMaterial({ name: 'inner', roughness: 0.6, metalness: 0 }),
    // Parts not in the isolated set: faint, and never in front of the parts that are.
    ghost: new MeshBasicMaterial({ name: 'ghost', color: '#a7acb4', transparent: true, opacity: 0.14, depthWrite: false }),
    // Drawn through everything else. Lit, so the shape still reads where parts overlap.
    xray: new MeshStandardMaterial({
      name: 'xray',
      color: opts.accent ?? '#ff5a1f',
      emissive: opts.accent ?? '#ff5a1f',
      emissiveIntensity: 0.35,
      roughness: 0.6,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
      depthWrite: false,
    }),
  };
  for (let i = 0; i < DOT_COUNT; i++) {
    m[`dot${i}`] = new MeshStandardMaterial({ name: `dot${i}`, color: DOT_OFF, roughness: 0.25, metalness: 0 });
  }
  tintMaterials(m, coat);
  for (let i = 0; i < DOT_COUNT; i++) setLight(m, i, 0.6);
  setLight(m, 'beacon', 0.6);
  return m;
}

const tint = (mat: Material | undefined, hex: string) => {
  if (mat instanceof MeshStandardMaterial) linearColour(hex, mat.color);
};

/** Sets every single-colour role from a coat. The shell is left alone: its colours are in the geometry. */
export function tintMaterials(m: Record<string, Material>, coat: CoatSpec): void {
  tint(m.joint, coat.base.joint);
  tint(m.bezel, coat.base.bezel);
  tint(m.inner, coat.regions.Inner ?? coat.base.joint);
  const beacon = m.beacon;
  if (beacon instanceof MeshStandardMaterial) {
    linearColour(coat.base.beacon, beacon.color);
    linearColour(coat.base.beacon, beacon.emissive);
  }
  const dot = linearColour(coat.base.dot, new Color());
  for (let i = 0; i < DOT_COUNT; i++) {
    const mat = m[`dot${i}`];
    if (mat instanceof MeshStandardMaterial) mat.emissive.copy(dot);
  }
}

/** Sets a light's level, 0 off to 1 full: a dot by number, or the beacon (tag and bell). */
export function setLight(m: Record<string, Material>, which: number | 'beacon', level: number): void {
  const l = Math.max(0, level);
  if (which === 'beacon') {
    const mat = m.beacon;
    if (mat instanceof MeshStandardMaterial) mat.emissiveIntensity = l * BEACON_GAIN;
    return;
  }
  const mat = m[`dot${which}`];
  if (mat instanceof MeshStandardMaterial) mat.emissiveIntensity = l * DOT_GAIN;
}
