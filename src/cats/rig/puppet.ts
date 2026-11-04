import { type Bone, Matrix4, type Object3D, PropertyBinding, Quaternion, Vector3 } from 'three';
import { Spring } from '../math/spring';
import type { Feel, Turn } from '../types';

export type { Feel, Turn };

interface Joint {
  bone: Bone;
  rest: Quaternion;
  restWorld: Quaternion;
  restWorldInv: Quaternion;
  restPosition: Vector3;
  restScale: Vector3;
  springs: [Spring, Spring, Spring];
  target: Turn;
}

const DEG = Math.PI / 180;
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
const qa = new Quaternion();
const qb = new Quaternion();
const qc = new Quaternion();
const v = new Vector3();

/**
 * A rigged cat, posed live. Ported from the creatures package. Nothing is pre-animated:
 * each frame the cat's code sets a target turn for every joint it cares about, and a
 * spring per joint and axis chases it. Changing a target is all it takes to animate; the
 * springs supply the easing, the overshoot and the follow-through.
 *
 * Turns are in the cat's own axes (three.js): +X is the cat's left, +Y up, +Z its front.
 * Degrees, applied roll, then pitch, then yaw, relative to the bone's rest pose, and
 * riding on the parent's turn:
 *   pitch (about X): + tips an upright bone forward and swings a hanging one back;
 *   yaw   (about Y): + turns it toward its left;
 *   roll  (about Z): + tips an upright bone toward its right (the viewer's left) and
 *                    swings a hanging one out to its left.
 *
 * Works on any Object3D tree with Bones in it: plain bones from buildSkeleton (names such
 * as `leg.FL`) or a GLTF scene (whose loader strips the dots: `legFL`). Names passed in
 * are matched exactly first and then in sanitized form, so `leg.FL` finds either.
 */
export class Puppet {
  readonly root: Object3D;
  private joints = new Map<string, Joint>();
  /** Sanitized name to the bone's actual name. */
  private aliases = new Map<string, string>();

  /** feels: spring settings per bone name; `default` covers the rest. */
  constructor(root: Object3D, feels: Partial<Record<string, Feel>> & { default: Feel }) {
    this.root = root;
    root.updateMatrixWorld(true);
    const rootInv = root.getWorldQuaternion(new Quaternion()).invert();
    root.traverse((obj) => {
      const bone = obj as Bone;
      if (!bone.isBone) return;
      const restWorld = rootInv.clone().multiply(bone.getWorldQuaternion(new Quaternion()));
      this.joints.set(bone.name, {
        bone,
        rest: bone.quaternion.clone(),
        restWorld,
        restWorldInv: restWorld.clone().invert(),
        restPosition: bone.position.clone(),
        restScale: bone.scale.clone(),
        springs: [new Spring(1, 1), new Spring(1, 1), new Spring(1, 1)],
        target: [0, 0, 0],
      });
      if (!this.aliases.has(sanitize(bone.name))) this.aliases.set(sanitize(bone.name), bone.name);
    });
    const keys = Object.keys(feels).filter((k) => k !== 'default');
    for (const [name, joint] of this.joints) {
      const key =
        keys.find((k) => k === name) ?? keys.find((k) => sanitize(k) === sanitize(name));
      const feel = (key && feels[key]) || feels.default;
      joint.springs = [0, 1, 2].map(
        () => new Spring(feel.f, feel.zeta, feel.r ?? 1),
      ) as Joint['springs'];
    }
  }

  has(name: string): boolean {
    return this.find(name) !== undefined;
  }

  bone(name: string): Bone {
    return this.joint(name).bone;
  }

  /** The names of every bone the puppet drives, in tree order. */
  names(): string[] {
    return [...this.joints.keys()];
  }

  /** A bone's rest pose in the model's space (the frame its children are in: the model as it
   * was made, x across, y up, z front), however it is posed now. */
  restMatrix(name: string): Matrix4 {
    const out = new Matrix4();
    const local = new Matrix4();
    for (let o: Object3D | null = this.joint(name).bone; o && o !== this.root; o = o.parent) {
      const joint = this.joints.get(o.name);
      if (joint) local.compose(joint.restPosition, joint.rest, joint.restScale);
      else local.copy(o.matrix);
      out.premultiply(local);
    }
    return out;
  }

  private find(name: string): Joint | undefined {
    const direct = this.joints.get(name);
    if (direct) return direct;
    const alias = this.aliases.get(sanitize(name));
    return alias === undefined ? undefined : this.joints.get(alias);
  }

  private joint(name: string): Joint {
    const joint = this.find(name);
    if (!joint) throw new Error(`no bone ${name}`);
    return joint;
  }

  /** Every bone back to its rest pose and every spring at rest, as when the puppet was made. */
  reset() {
    for (const joint of this.joints.values()) {
      joint.target.fill(0);
      for (const spring of joint.springs) spring.snap(0);
      joint.bone.quaternion.copy(joint.rest);
      joint.bone.position.copy(joint.restPosition);
      joint.bone.scale.copy(joint.restScale);
    }
  }

  /** Start a frame: every joint's target goes back to rest. */
  begin() {
    for (const joint of this.joints.values()) joint.target.fill(0);
  }

  /** Add to a joint's target this frame (several layers can add to one joint). */
  add(name: string, pitch = 0, yaw = 0, roll = 0) {
    const t = this.joint(name).target;
    t[0] += pitch;
    t[1] += yaw;
    t[2] += roll;
  }

  /** Replace a joint's target this frame, discarding what earlier layers added. */
  set(name: string, pitch = 0, yaw = 0, roll = 0) {
    const t = this.joint(name).target;
    t[0] = pitch;
    t[1] = yaw;
    t[2] = roll;
  }

  /** The target a joint is chasing this frame, in degrees. */
  target(name: string): Turn {
    const t = this.joint(name).target;
    return [t[0], t[1], t[2]];
  }

  /** Knock a joint (degrees per second on pitch, yaw, roll), for bumps and landings. */
  kick(name: string, pitch = 0, yaw = 0, roll = 0) {
    const s = this.joint(name).springs;
    s[0].kick(pitch);
    s[1].kick(yaw);
    s[2].kick(roll);
  }

  /** Where a joint actually is right now (after its spring), in degrees. */
  current(name: string): Turn {
    const s = this.joint(name).springs;
    return [s[0].y, s[1].y, s[2].y];
  }

  /**
   * How hard a joint's servos are working: the sum of the absolute spring velocities on
   * its three axes, in degrees per second. 0 when the joint is still.
   */
  load(name: string): number {
    const s = this.joint(name).springs;
    return Math.abs(s[0].v) + Math.abs(s[1].v) + Math.abs(s[2].v);
  }

  /** load summed over every bone whose name starts with `prefix` (`leg.`, `tail.`, `ear.`). */
  loadOf(prefix: string): number {
    const alt = sanitize(prefix);
    let sum = 0;
    for (const [name, joint] of this.joints) {
      if (!name.startsWith(prefix) && !name.startsWith(alt)) continue;
      const s = joint.springs;
      sum += Math.abs(s[0].v) + Math.abs(s[1].v) + Math.abs(s[2].v);
    }
    return sum;
  }

  /** The motion left in a joint's springs (Spring.energy summed over its axes), degrees². */
  energy(name: string): number {
    const s = this.joint(name).springs;
    return s[0].energy() + s[1].energy() + s[2].energy();
  }

  /** Move the springs, then pose the bones. snap skips the motion (first frame). */
  update(dt: number, snap = false) {
    for (const joint of this.joints.values()) {
      for (let i = 0; i < 3; i++) {
        if (snap) joint.springs[i].snap(joint.target[i]);
        else joint.springs[i].update(dt, joint.target[i]);
      }
      pose(joint);
    }
  }

  /**
   * Jump one joint (or every joint, with no name) to its current target, at rest, and
   * pose it there. For teleports and the first frame of a scene.
   */
  snap(name?: string) {
    const joints = name === undefined ? this.joints.values() : [this.joint(name)];
    for (const joint of joints) {
      for (let i = 0; i < 3; i++) joint.springs[i].snap(joint.target[i]);
      pose(joint);
    }
  }

  /**
   * Turn a joint further this frame, in character axes (degrees), after update: direct,
   * not sprung, for motion too quick for a spring to follow (a paw flick).
   */
  turn(name: string, pitch = 0, yaw = 0, roll = 0) {
    const joint = this.joint(name);
    qa.setFromAxisAngle(Y, yaw * DEG)
      .multiply(qb.setFromAxisAngle(X, pitch * DEG))
      .multiply(qc.setFromAxisAngle(Z, roll * DEG));
    joint.bone.quaternion.multiply(
      qb.copy(joint.restWorldInv).multiply(qa).multiply(joint.restWorld),
    );
  }

  /**
   * Scale a bone along one direction in character space (e.g. [0,-1,0] for a part that
   * points down) and by `across` in the other two. Direct, not sprung.
   */
  stretch(name: string, along: number, direction: [number, number, number], across = 1) {
    const joint = this.joint(name);
    v.set(...direction).applyQuaternion(joint.restWorldInv);
    const axis = dominant(v);
    joint.bone.scale.copy(joint.restScale).multiplyScalar(across);
    joint.bone.scale[axis] = joint.restScale[axis] * along;
  }

  /**
   * Swing a joint about the character's up axis (degrees), outside its other turns, after
   * update: direct, and it may go round and round (an ear spinning like a propeller).
   */
  swing(name: string, yaw: number) {
    const joint = this.joint(name);
    qa.setFromAxisAngle(Y, yaw * DEG);
    qb.copy(joint.restWorldInv).multiply(qa).multiply(joint.restWorld);
    // rest · A · rest⁻¹ · (current)
    joint.bone.quaternion.premultiply(qc.copy(joint.rest).multiply(qb).multiply(qa.copy(joint.rest).invert()));
  }

  /** Offset a bone from its rest position, in character space (metres). Direct. */
  shift(name: string, x: number, y: number, z: number) {
    const joint = this.joint(name);
    const parent = joint.bone.parent;
    v.set(x, y, z);
    const parentJoint = parent && (parent as Bone).isBone ? this.joints.get(parent.name) : undefined;
    if (parentJoint) v.applyQuaternion(parentJoint.restWorldInv);
    else if (parent && parent !== this.root)
      v.applyQuaternion(
        parent
          .getWorldQuaternion(qa)
          .premultiply(this.root.getWorldQuaternion(qb).invert())
          .invert(),
      );
    joint.bone.position.copy(joint.restPosition).add(v);
  }
}

/** Set a joint's bone from its springs: q = yaw · pitch · roll in character axes, then into the bone's frame. */
function pose(joint: Joint) {
  const [p, y, r] = joint.springs;
  qa.setFromAxisAngle(Y, y.y * DEG)
    .multiply(qb.setFromAxisAngle(X, p.y * DEG))
    .multiply(qc.setFromAxisAngle(Z, r.y * DEG));
  joint.bone.quaternion
    .copy(joint.rest)
    .multiply(qb.copy(joint.restWorldInv).multiply(qa).multiply(joint.restWorld));
}

/** A name as three.js's GLTF loader stores it (spaces to underscores, `[].:/` removed). */
export function sanitize(name: string): string {
  return PropertyBinding.sanitizeNodeName(name);
}

function dominant(v: Vector3): 'x' | 'y' | 'z' {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = Math.abs(v.z);
  return ax > ay && ax > az ? 'x' : ay > az ? 'y' : 'z';
}
