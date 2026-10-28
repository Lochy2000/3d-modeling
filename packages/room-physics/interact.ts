import * as THREE from 'three';
import { DEFAULT_GROUPS, FIXED_DT, HELD_GROUPS, type DynamicThing, type Physics } from './physics';
import type { Player } from './player';

const REACH = 3.2; // m
const MIN_HOLD = 0.55;
const MAX_HOLD = 3.0;
const THROW_ENERGY = 70; // J put into a throw (light things are capped by MAX_THROW)
const MAX_THROW = 16; // m/s
const MIN_THROW = 2.2;

/**
 * Grab / drag / throw. The held body is velocity-driven toward a point in front of the camera
 * (a stiff critically-damped spring done in velocity space), so the solver still resolves its
 * contacts: it slides along walls and desks instead of tunnelling, and CCD covers fast swings.
 */
export class Hands {
  hovered?: DynamicThing;
  held?: DynamicThing;
  holdDist = 1.4;
  /** grab point in the body's local frame */
  private grabLocal = new THREE.Vector3();
  /** body orientation relative to the camera yaw at grab time (kept while held) */
  private relQuat = new THREE.Quaternion();
  private targetHist: THREE.Vector3[] = [];
  private stuckTime = 0;
  private restoreGroups: { thing: DynamicThing; at: number }[] = [];
  /** set by main: whether the aim comes from the screen center or the mouse position */
  aim = new THREE.Vector2(0, 0);
  private raycastDir = new THREE.Vector3();
  private raycastOrigin = new THREE.Vector3();
  onGrab?: (t: DynamicThing) => void;
  onRelease?: (t: DynamicThing, thrown: boolean) => void;

  constructor(
    private physics: Physics,
    private player: Player,
    private camera: THREE.PerspectiveCamera,
  ) {
    physics.beforeStep.push((dt) => this.step(dt));
  }

  /** ray from the camera through the aim point */
  private ray() {
    this.raycastOrigin.copy(this.camera.position);
    this.raycastDir.set(this.aim.x, this.aim.y, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    return { o: this.raycastOrigin, d: this.raycastDir };
  }

  private cast() {
    const R = this.physics.R;
    const { o, d } = this.ray();
    const ray = new R.Ray(o, d);
    const hit = this.physics.world.castRay(ray, REACH, true, R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, this.player.collider, undefined);
    if (!hit) return undefined;
    const thing = this.physics.thingForCollider(hit.collider);
    const point = new THREE.Vector3().copy(o).addScaledVector(d, hit.timeOfImpact);
    return { thing, point, toi: hit.timeOfImpact };
  }

  /** Track the current target for interaction and HUD text. */
  update() {
    if (this.held) {
      this.setHover(this.held);
      return;
    }
    const hit = this.cast();
    this.setHover(hit?.thing);
  }

  clear() {
    this.release(false);
    this.setHover(undefined);
  }

  private setHover(t: DynamicThing | undefined) {
    this.hovered = t;
  }

  /** grab whatever is under the crosshair (or a given thing) */
  grab(thing?: DynamicThing, point?: THREE.Vector3) {
    if (this.held) this.release(false);
    let p = point;
    if (!thing) {
      const hit = this.cast();
      if (!hit?.thing) return false;
      thing = hit.thing;
      p = hit.point;
    }
    this.physics.unfreeze(thing);
    const b = thing.body;
    const tr = b.translation();
    const rot = b.rotation();
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const com = new THREE.Vector3(tr.x, tr.y, tr.z);
    p ??= com.clone();
    // hold near the center of mass: stable, and heavy things don't swing wildly
    const wc = b.worldCom();
    const centerW = new THREE.Vector3(wc.x, wc.y, wc.z);
    const grabW = p.clone().lerp(centerW, 0.7);
    this.grabLocal.copy(grabW).sub(com).applyQuaternion(q.clone().invert());
    this.holdDist = THREE.MathUtils.clamp(grabW.distanceTo(this.camera.position), MIN_HOLD + thing.size * 0.3, 1.3 + thing.size * 0.5);
    this.relQuat.copy(this.yawQuat().invert().multiply(q));
    this.held = thing;
    this.targetHist = [];
    this.stuckTime = 0;
    b.wakeUp();
    for (const c of thing.colliders) c.setCollisionGroups(HELD_GROUPS);
    this.restoreGroups = this.restoreGroups.filter((r) => r.thing !== thing);
    this.player.ignoreBody = b;
    this.onGrab?.(thing);
    return true;
  }

  release(thrown: boolean, velocity?: THREE.Vector3) {
    const t = this.held;
    if (!t) return;
    this.held = undefined;
    this.player.ignoreBody = undefined;
    const b = t.body;
    if (velocity) b.setLinvel(velocity, true);
    else {
      // let go: keep the hand's motion, but not the spring's full correction speed
      const v = b.linvel();
      const vel = new THREE.Vector3(v.x, v.y, v.z);
      if (vel.length() > 8) vel.setLength(8);
      b.setLinvel(vel, true);
    }
    // collide with the player again once it's clear of them
    this.restoreGroups.push({ thing: t, at: performance.now() + 250 });
    this.onRelease?.(t, thrown);
  }

  /** throw what you're holding (dir defaults to the aim), speed in m/s (defaults from its mass) */
  throw(dir?: THREE.Vector3, speed?: number) {
    const t = this.held;
    if (!t) return false;
    const d = (dir ?? this.ray().d).clone().normalize();
    const s = speed ?? THREE.MathUtils.clamp(Math.sqrt((2 * THROW_ENERGY) / t.mass), MIN_THROW, MAX_THROW);
    const hand = this.handVelocity();
    const v = d.multiplyScalar(s).addScaledVector(hand, 0.6);
    // a little tumble, like a real throw
    const spin = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(Math.min(8, s * 0.5) / Math.max(0.3, t.size * 3));
    t.body.setAngvel(spin, true);
    this.release(true, v);
    return true;
  }

  /** shove what's under the crosshair */
  push(strength = 1) {
    const hit = this.cast();
    if (!hit?.thing) return false;
    const d = this.ray().d.clone();
    this.physics.unfreeze(hit.thing);
    const impulse = d.multiplyScalar(Math.min(hit.thing.mass * 4, 6 + hit.thing.mass * 1.2) * strength);
    hit.thing.body.applyImpulseAtPoint(impulse, hit.point, true);
    return true;
  }

  adjustDistance(delta: number) {
    const min = MIN_HOLD + (this.held?.size ?? 0) * 0.3;
    this.holdDist = THREE.MathUtils.clamp(this.holdDist + delta, min, MAX_HOLD);
  }

  private yawQuat() {
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.player.yaw);
  }

  handVelocity() {
    const h = this.targetHist;
    if (h.length < 2) return new THREE.Vector3();
    const a = h[0];
    const b = h[h.length - 1];
    return b.clone().sub(a).divideScalar((h.length - 1) * FIXED_DT);
  }

  private step(dt: number) {
    const now = performance.now();
    this.restoreGroups = this.restoreGroups.filter((r) => {
      if (now < r.at) return true;
      if (this.overlapsPlayer(r.thing)) {
        r.at = now + 100;
        return true;
      }
      for (const c of r.thing.colliders) c.setCollisionGroups(DEFAULT_GROUPS);
      return false;
    });

    const t = this.held;
    if (!t) return;
    const b = t.body;
    // hold target: in front of the (current, non-interpolated) eye
    const eye = this.player.eye(1);
    // Use the same cursor ray for picking and holding in drag-to-look mode.
    const dir = new THREE.Vector3(this.aim.x, this.aim.y, .5)
      .applyMatrix4(this.camera.projectionMatrixInverse).normalize()
      .applyEuler(new THREE.Euler(this.player.pitch, this.player.yaw, 0, 'YXZ'));
    const target = eye.clone().addScaledVector(dir, this.holdDist);
    // keep things above the floor you're standing on
    target.y = Math.max(target.y, 0.05 + t.size * 0.3);
    this.targetHist.push(target.clone());
    if (this.targetHist.length > 7) this.targetHist.shift();

    const tr = b.translation();
    const rot = b.rotation();
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const grabW = this.grabLocal.clone().applyQuaternion(q).add(new THREE.Vector3(tr.x, tr.y, tr.z));
    const err = target.clone().sub(grabW);

    // heavier things follow more lazily and slower
    const heavy = THREE.MathUtils.clamp(t.mass / 12, 0, 1);
    const tau = THREE.MathUtils.lerp(0.045, 0.14, heavy);
    const maxSpeed = THREE.MathUtils.lerp(14, 4, heavy);
    const v = err.clone().divideScalar(tau);
    if (v.length() > maxSpeed) v.setLength(maxSpeed);
    // cancel gravity for this step (we set velocity directly)
    b.setLinvel(v, true);

    // orientation: keep the pose it had relative to your yaw when you grabbed it
    const want = this.yawQuat().multiply(this.relQuat);
    const dq = want.clone().multiply(q.clone().invert()).normalize();
    if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
    const angle = 2 * Math.acos(Math.min(1, dq.w));
    const s = Math.sqrt(Math.max(0, 1 - dq.w * dq.w));
    const axis = s < 1e-4 ? new THREE.Vector3() : new THREE.Vector3(dq.x / s, dq.y / s, dq.z / s);
    const rotTau = THREE.MathUtils.lerp(0.08, 0.25, heavy);
    const w = axis.multiplyScalar(Math.min(angle / rotTau, 12));
    if (Number.isFinite(w.x + w.y + w.z)) b.setAngvel(w, true);

    // dragged behind a wall / wedged: let go
    if (err.length() > 1.0) this.stuckTime += dt;
    else this.stuckTime = 0;
    if (this.stuckTime > 0.35) this.release(false);
  }

  private overlapsPlayer(t: DynamicThing) {
    const pc = this.player.collider;
    let hit = false;
    for (const c of t.colliders) {
      this.physics.world.contactPair(pc, c, () => (hit = true));
      if (!hit) {
        // contact pairs are only computed when groups allow it: fall back to a distance check
        const a = pc.translation();
        const bb = c.translation();
        const dx = a.x - bb.x;
        const dz = a.z - bb.z;
        if (Math.hypot(dx, dz) < 0.3 + t.size * 0.5 && Math.abs(a.y - bb.y) < 1.0 + t.size * 0.5) hit = true;
      }
      if (hit) break;
    }
    return hit;
  }
}
