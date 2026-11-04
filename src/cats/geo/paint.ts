/**
 * Face painting for coats. Each triangle is classified once into a named region; the
 * region index is kept per triangle so a coat can be swapped later by rewriting colours
 * from the table, without classifying again.
 *
 * Colours are written to a `color` attribute in linear RGB (three's working colour
 * space), parsed from sRGB hex strings. Use them with `vertexColors: true` on a material
 * whose own colour is white.
 */
import { BufferAttribute, BufferGeometry, Color, ColorManagement, Float32BufferAttribute } from 'three';
import type { V3 } from '../types';

/** The region index of a face that keeps the base colour. */
export const BASE_REGION = 255;

/** Names a region for a face from its centre, mean `param` and mean `t`, or null for the base colour. */
export type Classify = (centre: V3, param: V3, t: number) => string | null;

/** What `paintFaces` stores in `geometry.userData`. */
export interface RegionTable {
  /** One entry per triangle: an index into `regionNames`, or BASE_REGION. */
  regions: Uint8Array;
  regionNames: string[];
}

/** An sRGB hex (or any CSS colour) in three's working colour space, which is linear. */
export function linearColour(style: string, out = new Color()): Color {
  // With colour management on, setStyle converts sRGB to the working space itself.
  out.setStyle(style);
  if (!ColorManagement.enabled) out.convertSRGBToLinear();
  return out;
}

function faceCount(geo: BufferGeometry, what: string): number {
  if (geo.index) throw new Error(`${what}: geometry must be non-indexed`);
  return Math.floor(geo.getAttribute('position').count / 3);
}

/**
 * Classifies every triangle and writes its region's colour (or `base`, also for a region
 * missing from `colours`) to all three of its vertices. Stores the region table in
 * `geo.userData.regions` and `geo.userData.regionNames`. Returns the same geometry.
 */
export function paintFaces(
  geo: BufferGeometry,
  classify: Classify,
  colours: Record<string, string>,
  base: string,
): BufferGeometry {
  const faces = faceCount(geo, 'paintFaces');
  const pos = geo.getAttribute('position') as BufferAttribute;
  const param = geo.getAttribute('param') as BufferAttribute | undefined;
  const tAttr = geo.getAttribute('t') as BufferAttribute | undefined;

  const regions = new Uint8Array(faces);
  const regionNames: string[] = [];
  const lookup = new Map<string, number>();
  const centre: V3 = [0, 0, 0];
  const mean: V3 = [0, 0, 0];

  for (let f = 0; f < faces; f++) {
    const i = f * 3;
    for (let k = 0; k < 3; k++) {
      centre[k] = (pos.getComponent(i, k) + pos.getComponent(i + 1, k) + pos.getComponent(i + 2, k)) / 3;
      mean[k] = param ? (param.getComponent(i, k) + param.getComponent(i + 1, k) + param.getComponent(i + 2, k)) / 3 : 0;
    }
    const t = tAttr ? (tAttr.getX(i) + tAttr.getX(i + 1) + tAttr.getX(i + 2)) / 3 : 0;
    const name = classify([...centre], [...mean], t);
    if (name === null) {
      regions[f] = BASE_REGION;
      continue;
    }
    let index = lookup.get(name);
    if (index === undefined) {
      index = regionNames.length;
      if (index >= BASE_REGION) throw new Error('paintFaces: more than 255 regions');
      regionNames.push(name);
      lookup.set(name, index);
    }
    regions[f] = index;
  }

  // Replace userData rather than mutate it: clones share the object with their source.
  geo.userData = { ...geo.userData, regions, regionNames } satisfies RegionTable & Record<string, unknown>;
  return recolour(geo, colours, base);
}

/**
 * Rewrites the colours of a painted geometry from its stored region table. A geometry
 * that was never painted is left as it is. Returns the same geometry.
 */
export function recolour(geo: BufferGeometry, colours: Record<string, string>, base: string): BufferGeometry {
  const table = geo.userData as Partial<RegionTable>;
  if (!table.regions || !table.regionNames) return geo;
  const faces = faceCount(geo, 'recolour');
  if (table.regions.length !== faces) throw new Error('recolour: region table does not match the geometry');

  const baseColour = linearColour(base);
  const palette = table.regionNames.map((name) => (colours[name] !== undefined ? linearColour(colours[name]) : baseColour));

  const count = faces * 3;
  let attr = geo.getAttribute('color') as BufferAttribute | undefined;
  if (!attr || attr.itemSize !== 3 || !(attr.array instanceof Float32Array) || attr.count !== count) {
    attr = new Float32BufferAttribute(new Float32Array(count * 3), 3);
    geo.setAttribute('color', attr);
  }
  const arr = attr.array as Float32Array;
  for (let f = 0; f < faces; f++) {
    const r = table.regions[f];
    const c = r === BASE_REGION ? baseColour : palette[r];
    for (let v = 0; v < 3; v++) {
      const j = (f * 3 + v) * 3;
      arr[j] = c.r;
      arr[j + 1] = c.g;
      arr[j + 2] = c.b;
    }
  }
  attr.needsUpdate = true;
  return geo;
}
