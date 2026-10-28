import * as THREE from 'three';

/** Keep full-quality shadow maps, invalidating only lights touched by changed objects. */
export class DynamicShadows {
  private lights: (THREE.SpotLight | THREE.DirectionalLight | THREE.PointLight)[] = [];
  private pending = new Set<THREE.LightShadow>();
  private tracked: { object: THREE.Object3D; local: THREE.Sphere; previous: THREE.Sphere; matrix: THREE.Matrix4 }[];
  private current = new THREE.Sphere();
  private lastRefresh = -Infinity;

  constructor(lights: THREE.Object3D, objects: THREE.Object3D[]) {
    lights.traverse(o => {
      if ((o instanceof THREE.SpotLight || o instanceof THREE.DirectionalLight || o instanceof THREE.PointLight) && o.castShadow) {
        this.lights.push(o);
        o.shadow.autoUpdate = false;
      }
    });
    this.tracked = objects.map(object => {
      object.updateWorldMatrix(true, true);
      // A conservative local sphere stays valid through rotation, including offset pivots.
      const local = new THREE.Box3().setFromObject(object)
        .applyMatrix4(object.matrixWorld.clone().invert()).getBoundingSphere(new THREE.Sphere());
      return { object, local, previous: local.clone().applyMatrix4(object.matrixWorld), matrix: object.matrixWorld.clone() };
    });
    this.invalidateAll();
  }

  invalidateAll() {
    for (const light of this.lights) this.pending.add(light.shadow);
  }

  /** Call after interpolation. Test both ends so leaving a light removes the old shadow. */
  track() {
    for (const t of this.tracked) {
      t.object.updateWorldMatrix(true, false);
      if (t.matrix.equals(t.object.matrixWorld)) continue;
      this.current.copy(t.local).applyMatrix4(t.object.matrixWorld);
      for (const light of this.lights) {
        const shadow = light.shadow;
        // Point lights have six frusta. Conservatively refresh them on any motion.
        if (light instanceof THREE.PointLight || !shadow.map
          || shadow.getFrustum().intersectsSphere(t.previous)
          || shadow.getFrustum().intersectsSphere(this.current)) this.pending.add(shadow);
      }
      t.previous.copy(this.current);
      t.matrix.copy(t.object.matrixWorld);
    }
  }

  /** Flush immediately after settling, otherwise retain the existing 10 Hz cadence. */
  flush(renderer: THREE.WebGLRenderer, time: number, settled: boolean) {
    if (!this.pending.size || (!settled && time - this.lastRefresh < 100)) return false;
    for (const shadow of this.pending) shadow.needsUpdate = true;
    renderer.shadowMap.needsUpdate = true;
    this.pending.clear();
    this.lastRefresh = time;
    return true;
  }
}
