/**
 * Merging parts into one geometry per key (for example bone + material + system), so the
 * scene holds a few meshes instead of hundreds.
 */
import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Matrix4 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BASE_REGION, type RegionTable } from './paint';
import { bake } from './primitives';

/** The attributes every merged geometry carries, with their sizes and fill values. */
export const MERGE_ATTRIBUTES: Record<string, { size: number; fill: number }> = {
  position: { size: 3, fill: 0 },
  normal: { size: 3, fill: 0 },
  color: { size: 3, fill: 1 },
  param: { size: 3, fill: 0 },
  t: { size: 1, fill: 0 },
  uv: { size: 2, fill: 0 },
};

export interface MergePart {
  geometry: BufferGeometry;
  key: string;
  /** Baked into a copy before merging. */
  matrix?: Matrix4;
}

/**
 * Brings a geometry to the shape mergeGeometries needs: non-indexed, exactly the
 * attributes in MERGE_ATTRIBUTES, all Float32. Missing normals are computed; a missing
 * colour is filled white, missing param, t and uv with 0. Other attributes, morph
 * targets and groups are dropped. Works in place and returns the geometry, except that
 * an indexed input comes back as a new non-indexed geometry.
 */
export function conform(geo: BufferGeometry): BufferGeometry {
  if (!geo.getAttribute('position')) throw new Error('conform: geometry has no position');
  if (geo.index) {
    const flat = geo.toNonIndexed();
    flat.userData = { ...geo.userData };
    geo = flat;
  }
  for (const name of Object.keys(geo.attributes)) {
    if (!(name in MERGE_ATTRIBUTES)) geo.deleteAttribute(name);
  }
  geo.morphAttributes = {};
  geo.clearGroups();

  const count = geo.getAttribute('position').count;
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  for (const [name, { size, fill }] of Object.entries(MERGE_ATTRIBUTES)) {
    const attr = geo.getAttribute(name) as BufferAttribute | undefined;
    if (!attr) {
      geo.setAttribute(name, new Float32BufferAttribute(new Float32Array(count * size).fill(fill), size));
      continue;
    }
    if (attr.itemSize !== size) throw new Error(`conform: ${name} has item size ${attr.itemSize}, expected ${size}`);
    if (!(attr.array instanceof Float32Array) || attr.normalized) {
      const values = new Float32Array(count * size);
      for (let i = 0; i < count; i++) for (let k = 0; k < size; k++) values[i * size + k] = attr.getComponent(i, k);
      geo.setAttribute(name, new Float32BufferAttribute(values, size));
    }
  }
  return geo;
}

/**
 * Merges parts into one geometry per key, in the order keys first appear. Inputs are
 * not changed. Region tables from painting are carried over: the merged geometry gets
 * the union of region names, and faces from unpainted parts get BASE_REGION. A key with
 * no painted part gets no table.
 */
export function mergeByKey(parts: MergePart[]): Map<string, BufferGeometry> {
  const groups = new Map<string, MergePart[]>();
  for (const part of parts) {
    const list = groups.get(part.key);
    if (list) list.push(part);
    else groups.set(part.key, [part]);
  }

  const merged = new Map<string, BufferGeometry>();
  for (const [key, list] of groups) {
    const ready = list.map((p) => {
      const copy = p.matrix ? bake(p.geometry, p.matrix) : p.geometry.clone();
      copy.userData = { ...p.geometry.userData };
      return conform(copy);
    });

    const geo = mergeGeometries(ready, false);
    if (!geo) throw new Error(`mergeByKey: could not merge parts for "${key}"`);

    const painted = ready.some((g) => (g.userData as Partial<RegionTable>).regions);
    if (painted) {
      const regionNames: string[] = [];
      const lookup = new Map<string, number>();
      const regions = new Uint8Array(geo.getAttribute('position').count / 3);
      let f = 0;
      for (const g of ready) {
        const table = g.userData as Partial<RegionTable>;
        const faces = g.getAttribute('position').count / 3;
        if (!table.regions || !table.regionNames) {
          regions.fill(BASE_REGION, f, f + faces);
        } else {
          const remap = table.regionNames.map((name) => {
            let index = lookup.get(name);
            if (index === undefined) {
              index = regionNames.length;
              if (index >= BASE_REGION) throw new Error(`mergeByKey: more than 255 regions for "${key}"`);
              regionNames.push(name);
              lookup.set(name, index);
            }
            return index;
          });
          for (let i = 0; i < faces; i++) {
            const r = table.regions[i];
            regions[f + i] = r === BASE_REGION ? BASE_REGION : remap[r];
          }
        }
        f += faces;
      }
      geo.userData = { regions, regionNames } satisfies RegionTable;
    }

    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    for (const g of ready) g.dispose();
    merged.set(key, geo);
  }
  return merged;
}
