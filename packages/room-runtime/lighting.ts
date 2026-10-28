import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Keep the render targets, not just their textures: disposing only a texture leaks
// framebuffer/renderbuffer allocations every time a room's environment is rebaked.
const environments = new WeakMap<THREE.Scene, THREE.WebGLRenderTarget>();
const mirrors = new WeakMap<THREE.MeshStandardMaterial, THREE.WebGLCubeRenderTarget>();
export function disposeMirror(material?: THREE.MeshStandardMaterial) {
  if (!material) return;
  mirrors.get(material)?.dispose();
  mirrors.delete(material);
  material.envMap = null;
}
function replaceEnvironment(scene: THREE.Scene, target: THREE.WebGLRenderTarget) {
  const previous = environments.get(scene);
  scene.environment = target.texture;
  environments.set(scene, target);
  previous?.dispose();
}

/** Shared renderer setup: shadows, tone mapping, a neutral starting environment */
export function configureRenderer(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const studio = new RoomEnvironment();
  replaceEnvironment(scene, pmrem.fromScene(studio, 0.04));
  studio.dispose();
  pmrem.dispose();
  scene.environmentIntensity = 0.18;
}

/**
 * Replace the generic studio environment with a cube capture of the room
 * itself: materials pick up the warm walls as bounce light, and the mirror
 * gets a (non-parallax) reflection of the room from its own position.
 */
export function bakeEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  mirror?: THREE.MeshStandardMaterial,
  center = new THREE.Vector3(0, 1.4, 0),
  mirrorAt = new THREE.Vector3(2.7, 1.9, 0),
  intensity = 0.55,
  size = 256,
  bounces = 1,
) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  // The previous room may have frozen the renderer's shadow maps. Refresh for
  // this room before capturing its indirect lighting. Cube-camera faces share
  // the same static lights and geometry, so they can reuse those shadow maps.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  const capture = (pos: THREE.Vector3, size: number) => {
    const target = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType });
    const cam = new THREE.CubeCamera(0.05, 30, target);
    cam.position.copy(pos);
    scene.add(cam);
    cam.update(renderer, scene);
    scene.remove(cam);
    return target;
  };
  // each extra pass re-captures the room lit by the previous capture (one more light bounce)
  for (let b = 0; b < bounces; b++) {
    const room = capture(center, size);
    replaceEnvironment(scene, pmrem.fromCubemap(room.texture));
    scene.environmentIntensity = intensity;
    room.dispose();
  }
  pmrem.dispose();
  scene.environmentIntensity = intensity;
  // nothing in the room moves, so render the shadow maps once
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  if (mirror) {
    const view = capture(mirrorAt, 512);
    mirrors.get(mirror)?.dispose();
    mirrors.set(mirror, view);
    mirror.envMap = view.texture;
    mirror.envMapIntensity = 1;
    mirror.needsUpdate = true;
  }
}
