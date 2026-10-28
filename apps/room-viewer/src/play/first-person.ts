import * as THREE from 'three';
import { Player } from '../../../../packages/room-physics/player';
import { Hands } from '../../../../packages/room-physics/interact';
import type { Physics, DynamicThing } from '../../../../packages/room-physics/physics';

type Events = {
  start(): void; pause(): void; change(): void;
  thrown(thing: DynamicThing): void; error(message: string): void;
};
const movement = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'KeyC']);

/** Pointer-locked exploration; the overhead controls remain an independent mode. */
export class FirstPerson {
  active = false;
  readonly player: Player;
  readonly hands: Hands;
  freeCursor = false;
  private lockPending = false;
  private looking = false;
  private previousPosition = new THREE.Vector3();
  private previousRotation = new THREE.Quaternion();

  constructor(private canvas: HTMLCanvasElement, private physics: Physics, private camera: THREE.PerspectiveCamera,
    private spawn: THREE.Vector3, private look: THREE.Vector3, private events: Events) {
    this.player = new Player(physics, spawn, look);
    this.hands = new Hands(physics, this.player, camera);
    this.player.enabled = false;
    this.player.body.setEnabled(false);
    this.hands.onRelease = (thing, thrown) => { if (thrown) events.thrown(thing); events.change(); };
    document.addEventListener('pointerlockchange', () => {
      if (!this.active) { if (this.locked) document.exitPointerLock(); return; }
      if (this.locked) { this.lockPending = false; this.freeCursor = false; this.hands.aim.set(0, 0); this.player.enabled = true; events.start(); }
      else { this.stop(); events.pause(); }
    });
    document.addEventListener('pointerlockerror', () => {
      this.startFreeCursor();
    });
    document.addEventListener('mousemove', e => {
      if (!this.running) return;
      if (this.freeCursor && !this.looking) {
        this.aimAt(e);
      } else {
        this.player.rotate(e.movementX * .002, e.movementY * .002);
      }
      events.change();
    });
    window.addEventListener('keydown', e => {
      if (!this.running || e.metaKey || e.altKey || e.ctrlKey) return;
      if (movement.has(e.code)) { e.preventDefault(); this.player.keys.add(e.code); }
      else if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) this.player.jump(); }
      else if (e.code === 'KeyE') { e.preventDefault(); if (!e.repeat) this.interact(); }
      else if (e.code === 'KeyR') { e.preventDefault(); if (!e.repeat) this.respawn(); }
      else if (e.code === 'Escape') { e.preventDefault(); this.stop(); events.pause(); }
    });
    window.addEventListener('keyup', e => this.player.keys.delete(e.code));
    // Pointer lock guarantees mouse events; do not depend on Pointer Events support.
    document.addEventListener('mousedown', e => {
      if (!this.active || (!this.locked && e.target !== canvas)) return;
      e.preventDefault();
      if (!this.running) { if (e.button === 0) this.lock(); return; }
      if (this.freeCursor) this.aimAt(e);
      if (e.button === 0) {
        if (this.hands.held || this.hands.grab()) this.hands.throw();
      } else if (e.button === 2) {
        if (this.freeCursor) this.looking = true;
        else this.hands.release(false);
      }
      events.change();
    });
    document.addEventListener('mouseup', e => { if (e.button === 2) this.looking = false; });
    canvas.addEventListener('wheel', e => {
      if (!this.running) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
      this.hands.adjustDistance(Math.max(-.3, Math.min(.3, e.deltaY * unit * .002)));
      events.change();
    }, { passive: false });
  }

  get locked() { return document.pointerLockElement === this.canvas; }
  get running() { return this.active && (this.locked || this.freeCursor) && this.player.enabled; }

  setActive(active: boolean) {
    this.active = active;
    this.stop();
    this.player.body.setEnabled(active);
    if (active) this.respawn();
  }

  lock() {
    if (!this.active) return;
    this.lockPending = true;
    if (!this.canvas.requestPointerLock) { this.startFreeCursor(); return; }
    try {
      const result = this.canvas.requestPointerLock();
      result?.catch(() => this.startFreeCursor());
    } catch { this.startFreeCursor(); }
  }

  private startFreeCursor() {
    if (!this.active || !this.lockPending) return;
    this.lockPending = false;
    this.freeCursor = true;
    this.player.enabled = true;
    this.events.start();
  }

  private aimAt(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    this.hands.aim.set((e.clientX - rect.left) / rect.width * 2 - 1, 1 - (e.clientY - rect.top) / rect.height * 2);
  }

  stop() {
    this.lockPending = false;
    this.freeCursor = false;
    this.looking = false;
    this.player.enabled = false;
    this.player.stop();
    this.hands.clear();
    if (this.locked) document.exitPointerLock();
  }

  respawn() {
    this.hands.clear();
    this.player.stop();
    this.player.teleport(this.spawn.x, this.spawn.z);
    this.player.lookAt(this.look, this.spawn);
    this.player.applyCamera(this.camera, 1);
    this.camera.updateMatrixWorld();
    this.events.change();
  }

  private interact() {
    if (this.hands.held) this.hands.release(false);
    else this.hands.grab();
    this.events.change();
  }

  update() {
    if (!this.active) return false;
    this.previousPosition.copy(this.camera.position);
    this.previousRotation.copy(this.camera.quaternion);
    this.player.applyCamera(this.camera, this.running ? this.physics.alpha : 1);
    this.camera.updateMatrixWorld();
    if (this.running) this.hands.update();
    return this.previousPosition.distanceToSquared(this.camera.position) > 1e-10
      || 1 - Math.abs(this.previousRotation.dot(this.camera.quaternion)) > 1e-10;
  }
}
