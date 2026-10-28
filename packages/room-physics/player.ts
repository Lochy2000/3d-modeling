import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { FIXED_DT, GRAVITY, GROUP, groups, type Physics } from './physics';

const RADIUS = 0.24;
const STAND_HALF = 0.61; // capsule total 1.7 m
const CROUCH_HALF = 0.26; // capsule total 1.0 m
const EYE_BELOW_TOP = 0.12;
const WALK = 1.7;
const RUN = 3.6;
const CROUCH_SPEED = 0.9;
const JUMP = 3.9; // m/s → ~0.78 m hop

/**
 * First-person walker: a capsule driven by Rapier's KinematicCharacterController
 * (slides along walls, steps up small ledges, snaps to the floor, pushes dynamic things).
 */
export class Player {
  readonly body: RAPIER_NS.RigidBody;
  readonly collider: RAPIER_NS.Collider;
  readonly controller: RAPIER_NS.KinematicCharacterController;
  enabled = true;
  yaw = 0;
  pitch = 0;
  crouching = false;
  wantCrouch = false;
  grounded = false;
  private vy = 0;
  private half = STAND_HALF;
  private eyeHalf = STAND_HALF; // smoothed, for the camera
  readonly keys = new Set<string>();
  /** body center, previous and current fixed step (for interpolation) */
  private prev = new THREE.Vector3();
  private curr = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** collider to ignore while moving (the thing in your hands) */
  ignoreBody?: RAPIER_NS.RigidBody;
  private jumpQueued = false;
  private spawn = new THREE.Vector3();

  constructor(
    private physics: Physics,
    start: THREE.Vector3,
    look: THREE.Vector3,
  ) {
    const R = physics.R;
    const w = physics.world;
    const center = new THREE.Vector3(start.x, RADIUS + STAND_HALF + 0.02, start.z);
    this.spawn.copy(center);
    this.body = w.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(center.x, center.y, center.z));
    this.collider = w.createCollider(
      R.ColliderDesc.capsule(STAND_HALF, RADIUS).setCollisionGroups(groups(GROUP.player, 0xffff & ~GROUP.held)).setFriction(0),
      this.body,
    );
    this.controller = w.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.enableAutostep(0.28, 0.12, false);
    this.controller.enableSnapToGround(0.25);
    this.controller.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(50));
    this.controller.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(35));
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(75);
    this.controller.setSlideEnabled(true);
    this.prev.copy(center);
    this.curr.copy(center);
    this.lookAt(look, new THREE.Vector3(start.x, 1.58, start.z));
    physics.beforeStep.push((dt) => this.step(dt));
  }

  lookAt(target: THREE.Vector3, from = this.eye()) {
    const d = target.clone().sub(from);
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  }

  teleport(x: number, z: number, y = 0) {
    const c = new THREE.Vector3(x, y + RADIUS + this.half + 0.02, z);
    this.body.setTranslation(c, true);
    this.body.setNextKinematicTranslation(c);
    this.prev.copy(c);
    this.curr.copy(c);
    this.vy = 0;
  }

  stop() {
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    this.jumpQueued = false;
  }

  jump() {
    this.jumpQueued = true;
  }

  /** mouse look (radians) */
  rotate(dx: number, dy: number) {
    this.yaw -= dx;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy, -1.5, 1.5);
  }

  // Small possessions should not turn a messy floor into an impassable obstacle course.
  // Use the same filter for walking and standing up, including frozen and sleeping props.
  private blocksPlayer = (collider: RAPIER_NS.Collider) => {
    if (this.ignoreBody && collider.parent()?.handle === this.ignoreBody.handle) return false;
    const thing = this.physics.thingForCollider(collider);
    return !thing || thing.size > 1;
  };

  private step(dt: number) {
    if (!this.enabled) return;
    const k = this.keys;
    const fwd = Number(k.has('KeyW') || k.has('ArrowUp')) - Number(k.has('KeyS') || k.has('ArrowDown'));
    const right = Number(k.has('KeyD') || k.has('ArrowRight')) - Number(k.has('KeyA') || k.has('ArrowLeft'));
    this.wantCrouch = k.has('KeyC');
    this.updateCrouch();
    const speed = this.crouching ? CROUCH_SPEED : k.has('ShiftLeft') || k.has('ShiftRight') ? RUN : WALK;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // forward = -z rotated by yaw
    const len = Math.hypot(fwd, right) || 1;
    const vx = ((-sin * fwd + cos * right) / len) * speed;
    const vz = ((-cos * fwd - sin * right) / len) * speed;
    // ease horizontal velocity (a bit of inertia, not ice)
    const a = 1 - Math.exp(-dt * (this.grounded ? 28 : 8));
    this.velocity.x += (vx - this.velocity.x) * a;
    this.velocity.z += (vz - this.velocity.z) * a;

    if (this.grounded && this.jumpQueued && !this.crouching) this.vy = JUMP;
    this.jumpQueued = false;
    this.vy += GRAVITY * dt;
    this.vy = Math.max(this.vy, -20);

    const desired = { x: this.velocity.x * dt, y: this.vy * dt, z: this.velocity.z * dt };
    this.controller.computeColliderMovement(
      this.collider,
      desired,
      this.physics.R.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      this.blocksPlayer,
    );
    const move = this.controller.computedMovement();
    // walked into something frozen: it joins the simulation (and gets pushed next step)
    for (let i = 0; i < this.controller.numComputedCollisions(); i++) {
      const hit = this.controller.computedCollision(i);
      const thing = this.physics.thingForCollider(hit?.collider);
      if (thing?.wakeOnImpact) this.physics.unfreeze(thing);
    }
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this.vy < 0) this.vy = 0;
    // bonked the ceiling
    if (!this.grounded && this.vy > 0 && move.y < desired.y * 0.5) this.vy = 0;

    const t = this.body.translation();
    const next = { x: t.x + move.x, y: t.y + move.y, z: t.z + move.z };
    if (next.y < -5) {
      // fell out through a doorway into the void
      next.x = this.spawn.x;
      next.y = this.spawn.y;
      next.z = this.spawn.z;
      this.vy = 0;
    }
    this.body.setNextKinematicTranslation(next);
    this.prev.copy(this.curr);
    this.curr.set(next.x, next.y, next.z);
    void FIXED_DT;
  }

  private updateCrouch() {
    if (this.wantCrouch === this.crouching) return;
    const shape = this.collider.shape as RAPIER_NS.Capsule;
    if (this.wantCrouch) {
      this.crouching = true;
      this.setHalf(CROUCH_HALF, shape);
    } else {
      // stand up only if there's headroom
      const t = this.body.translation();
      const R = this.physics.R;
      const probe = new R.Capsule(STAND_HALF, RADIUS * 0.95);
      const center = { x: t.x, y: t.y + (STAND_HALF - CROUCH_HALF) + 0.01, z: t.z };
      let blocked = false;
      this.physics.world.intersectionsWithShape(
        center,
        { x: 0, y: 0, z: 0, w: 1 },
        probe,
        () => {
          blocked = true;
          return false;
        },
        R.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.collider,
        undefined,
        this.blocksPlayer,
      );
      if (blocked) return;
      this.crouching = false;
      this.setHalf(STAND_HALF, shape);
    }
  }

  private setHalf(half: number, _shape: RAPIER_NS.Capsule) {
    const dy = half - this.half;
    this.half = half;
    this.collider.setHalfHeight(half);
    // keep the feet where they are
    const t = this.body.translation();
    const c = { x: t.x, y: t.y + dy, z: t.z };
    this.body.setTranslation(c, true);
    this.curr.y += dy;
    this.prev.y += dy;
  }

  /** interpolated eye position */
  eye(alpha = this.physics.alpha, target = new THREE.Vector3()) {
    target.lerpVectors(this.prev, this.curr, alpha);
    // smooth the crouch camera
    this.eyeHalf += (this.half - this.eyeHalf) * 0.25;
    const feet = target.y - this.half - RADIUS;
    target.y = feet + RADIUS + this.eyeHalf * 2 + RADIUS - EYE_BELOW_TOP;
    return target;
  }

  applyCamera(camera: THREE.PerspectiveCamera, alpha: number) {
    this.eye(alpha, camera.position);
    camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }
}
