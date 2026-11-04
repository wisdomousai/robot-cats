import { Bone, Float32BufferAttribute, Matrix4, Object3D, Skeleton, Uint16BufferAttribute, Vector3 } from 'three';
import type { BoneDef, BoneName, V3 } from '../types';

/**
 * The cat's bones, built from a table of heads and tails in the cat's frame (metres,
 * three.js axes: +x the cat's left, +y up, +z its front).
 *
 * Each Bone sits at its head, in its parent's frame. Its rest orientation turns local +y
 * along the bone, head to tail, as Blender's bones do. The roll about that axis comes
 * from a look-at frame: local +z is the up hint with its component along the bone
 * removed. The hint is the cat's +z (its front) for most bones, so an upright bone has the
 * identity rotation and a leg's +z faces forward. The tail, and any bone within 30° of the
 * z axis (the body, which runs hips to shoulders), use world +y instead, since +z would be
 * nearly along them and the roll would flip with small changes in slope. When a bone lies
 * almost exactly along its hint, the other hint is used.
 *
 * The puppet turns bones in the cat's own axes (it converts through each bone's rest
 * frame), so these orientations matter only to parts parented to the bones: a part made
 * in the cat's frame goes under its bone through the inverse of the bone's world matrix.
 *
 * Every bone's userData carries `length` (metres) and `head` / `tail` (rest, cat frame).
 */
export interface SkeletonBuild {
  /** A plain Object3D holding the top-level bones (those with no parent). */
  root: Object3D;
  bones: Map<BoneName, Bone>;
  /** Bind pose computed with `root` at the identity, so a SkinnedMesh under root binds directly. */
  skeleton: Skeleton;
  /** Each bone's index in skeleton.bones, for skinIndex attributes. */
  index: Map<BoneName, number>;
}

const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

export function buildSkeleton(defs: BoneDef[]): SkeletonBuild {
  const root = new Object3D();
  root.name = 'rig';
  const byName = new Map<BoneName, BoneDef>();
  for (const d of defs) {
    if (byName.has(d.name)) throw new Error(`bone ${d.name} defined twice`);
    byName.set(d.name, d);
  }
  const bones = new Map<BoneName, Bone>();
  const world = new Map<BoneName, Matrix4>();

  // Parents may come after children in the table, so build on demand.
  const build = (d: BoneDef, trail: BoneName[]): Bone => {
    const done = bones.get(d.name);
    if (done) return done;
    if (trail.includes(d.name)) throw new Error(`bone loop: ${[...trail, d.name].join(' > ')}`);
    const bone = new Bone();
    bone.name = d.name;
    const m = restMatrix(d);
    world.set(d.name, m);
    let parentWorld = new Matrix4();
    if (d.parent) {
      const pd = byName.get(d.parent);
      if (!pd) throw new Error(`bone ${d.name}: no parent ${d.parent}`);
      build(pd, [...trail, d.name]).add(bone);
      parentWorld = world.get(d.parent)!;
    } else root.add(bone);
    const local = parentWorld.clone().invert().multiply(m);
    local.decompose(bone.position, bone.quaternion, bone.scale);
    bone.scale.set(1, 1, 1);
    bone.userData = {
      length: Math.hypot(d.tail[0] - d.head[0], d.tail[1] - d.head[1], d.tail[2] - d.head[2]),
      head: [...d.head] as V3,
      tail: [...d.tail] as V3,
    };
    bones.set(d.name, bone);
    return bone;
  };
  for (const d of defs) build(d, []);

  // The Skeleton constructor computes the bone inverses from the world matrices, so
  // they must be current first.
  root.updateMatrixWorld(true);
  const list = defs.map((d) => bones.get(d.name)!);
  const skeleton = new Skeleton(list);
  const index = new Map<BoneName, number>(list.map((b, i) => [b.name as BoneName, i]));
  return { root, bones, skeleton, index };
}

/** A bone's rest pose in the cat's frame: at its head, local +y along it. */
function restMatrix(d: BoneDef): Matrix4 {
  const head = new Vector3(...d.head);
  const along = new Vector3(...d.tail).sub(head);
  if (along.lengthSq() < 1e-16) along.copy(Y);
  along.normalize();
  const tail = d.name.startsWith('tail.') || Math.abs(along.z) > Math.cos(Math.PI / 6);
  let hint = tail ? Y : Z;
  if (Math.abs(along.dot(hint)) > 0.999) hint = hint === Y ? Z : Y;
  const z = hint.clone().addScaledVector(along, -along.dot(hint)).normalize();
  const x = new Vector3().crossVectors(along, z);
  const m = new Matrix4().makeBasis(x, along, z);
  m.setPosition(head);
  return m;
}

/**
 * Skin weights that hand a tube over from bone to bone along a chain, as kit.chain does:
 * t holds each vertex's position along the tube (0..1) and bones the chain in order. A
 * vertex is shared between the two chain bones nearest its t, blended by a smoothstep, so
 * the tube bends smoothly across each joint. Bone indices come from `boneIndex` (the
 * order of skeleton.bones).
 */
export function chainWeights(
  t: Float32Array,
  bones: BoneName[],
  boneIndex: Map<BoneName, number>,
): { skinIndex: Uint16BufferAttribute; skinWeight: Float32BufferAttribute } {
  const n = bones.length;
  if (n === 0) throw new Error('chainWeights: no bones');
  const ids = bones.map((b) => {
    const i = boneIndex.get(b);
    if (i === undefined) throw new Error(`chainWeights: no index for ${b}`);
    return i;
  });
  const index = new Uint16Array(t.length * 4);
  const weight = new Float32Array(t.length * 4);
  for (let v = 0; v < t.length; v++) {
    if (n === 1) {
      index[v * 4] = ids[0];
      weight[v * 4] = 1;
      continue;
    }
    const u = Math.min(Math.max(t[v] * n - 0.5, 0), n - 1);
    const k = Math.min(Math.floor(u), n - 2);
    let f = u - k;
    f = f * f * (3 - 2 * f);
    index[v * 4] = ids[k];
    index[v * 4 + 1] = ids[k + 1];
    weight[v * 4] = 1 - f;
    weight[v * 4 + 1] = f;
  }
  return {
    skinIndex: new Uint16BufferAttribute(index, 4),
    skinWeight: new Float32BufferAttribute(weight, 4),
  };
}
