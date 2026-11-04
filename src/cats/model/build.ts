import { type Bone, type BufferGeometry, Matrix4, Mesh, type Object3D, SkinnedMesh } from 'three';
import { Face } from '../face/face';
import { mergeByKey, type MergePart } from '../geo/merge';
import { buildSkeleton, chainWeights } from '../rig/skeleton';
import { Puppet } from '../rig/puppet';
import type { BoneName, Breed, CatModel, CoatSpec, PartDef, V3 } from '../types';
import { recoatGeometry } from './coats';
import { dimsOf, feelsFor } from './dims';
import { catMaterials, setLight, tintMaterials } from './materials';
import { catBones, catParts } from './parts';

/**
 * Builds one cat: the skeleton from the breed's dimensions, every part in the cat's frame,
 * then the parts merged into one mesh per (bone, material, system), each parented to its
 * bone. The skeleton is built with the root at the identity, so parts go under their bones
 * through the inverse of each bone's rest world matrix and the skinned tail binds directly.
 *
 * Nothing is posed here. A Puppet built on `model.root` afterwards records the bones'
 * rest rotations as they are, which is what it needs.
 */
export interface BuildOptions {
  /** A coat other than the breed's own (it can also be changed later with `recoat`). */
  coat?: CoatSpec;
  /** Colour of the x-ray look. */
  accent?: string;
  /** False keeps one mesh per part, for inspecting single parts. Default true. */
  merge?: boolean;
}

/** What each mesh carries in userData, read by the stage for isolate, x-ray and explode. */
export interface MeshInfo {
  parts: string[];
  system: string;
  bone: string;
  explode: V3;
}

/** Explode directions rounded so parts flying the same way share a mesh and the two sides do not. */
const dirKey = (v: V3) => v.map((c) => Math.round(c * 20)).join(',');

export function buildCat(breed: Breed, opts: BuildOptions = {}): CatModel {
  const d = dimsOf(breed);
  const coat = opts.coat ?? breed.coat;
  const rig = buildSkeleton(catBones(d));
  rig.root.name = `cat.${breed.id}`;
  rig.root.updateMatrixWorld(true);

  const parts = catParts(d, coat);
  const face = new Face(coat.base.glow);
  const materials = catMaterials(coat, { faceMap: face.texture, accent: opts.accent });
  const meshes: Object3D[] = [];
  const bone = (name: BoneName): Bone => {
    const b = rig.bones.get(name);
    if (!b) throw new Error(`buildCat: no bone ${name}`);
    return b;
  };
  const inverse = new Map<BoneName, Matrix4>();
  const toBone = (name: BoneName) => {
    let m = inverse.get(name);
    if (!m) {
      m = bone(name).matrixWorld.clone().invert();
      inverse.set(name, m);
    }
    return m;
  };

  // The skinned tail: under the root, bound with the bones at rest.
  for (const part of parts) {
    if (!part.skin) continue;
    const geo = part.geometry;
    const { skinIndex, skinWeight } = chainWeights(part.skin.t, part.skin.bones, rig.index);
    geo.setAttribute('skinIndex', skinIndex);
    geo.setAttribute('skinWeight', skinWeight);
    const mesh = new SkinnedMesh(geo, materials[part.role]);
    mesh.name = part.name;
    // The bones move it far from where its bounding sphere was computed.
    mesh.frustumCulled = false;
    mesh.castShadow = !!part.shadow;
    mesh.receiveShadow = true;
    mesh.userData = { parts: [part.name], system: part.system, bone: part.bone, explode: [0, 0, 0] } satisfies MeshInfo;
    rig.root.add(mesh);
    mesh.bind(rig.skeleton, new Matrix4());
    meshes.push(mesh);
  }

  // Everything else is rigid, merged per key and hung on its bone.
  const rigid = parts.filter((p) => !p.skin);
  const keyOf = (p: PartDef, i: number) =>
    opts.merge === false ? `${p.bone}|${p.role}|${p.system}|${i}` : `${p.bone}|${p.role}|${p.system}|${dirKey(p.explode)}`;
  const groups = new Map<string, PartDef[]>();
  const input: MergePart[] = rigid.map((p, i) => {
    const key = keyOf(p, i);
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
    return { geometry: p.geometry, key, matrix: toBone(p.bone) };
  });
  const merged = mergeByKey(input);
  for (const [key, geo] of merged) {
    const group = groups.get(key)!;
    const first = group[0];
    const mesh = new Mesh(geo, materials[first.role]);
    mesh.name = group.length === 1 ? first.name : `${first.system}.${first.role}.${first.bone}`;
    mesh.castShadow = group.some((p) => p.shadow);
    mesh.receiveShadow = true;
    mesh.userData = {
      parts: group.map((p) => p.name),
      system: first.system,
      bone: first.bone,
      explode: [...first.explode] as V3,
    } satisfies MeshInfo;
    bone(first.bone).add(mesh);
    meshes.push(mesh);
  }
  // The part geometries were copied into the merged ones.
  for (const p of rigid) p.geometry.dispose();

  const shells = meshes.filter((m) => (m as Mesh).material === materials.shell) as Mesh[];

  return {
    breed,
    root: rig.root,
    bones: rig.bones as Map<string, Bone>,
    parts,
    meshes,
    materials,
    face,
    recoat(next: CoatSpec) {
      tintMaterials(materials, next);
      face.setGlow(next.base.glow);
      for (const m of shells) recoatGeometry(m.geometry as BufferGeometry, next);
    },
    light(dot: number, level: number) {
      setLight(materials, dot, level);
    },
  };
}

/** A puppet for a built cat, with the breed's spring settings. Build it before posing anything. */
export function puppetOf(model: CatModel): Puppet {
  return new Puppet(model.root, feelsFor(model.breed));
}

/** Mesh and triangle counts of a built cat. */
export function catStats(model: CatModel): { meshes: number; triangles: number; parts: number } {
  let triangles = 0;
  for (const m of model.meshes) {
    const geo = (m as Mesh).geometry;
    if (!geo) continue;
    triangles += (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
  }
  return { meshes: model.meshes.length, triangles: Math.round(triangles), parts: model.parts.length };
}
