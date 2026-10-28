import * as THREE from 'three';

/** Release a replaced scene while retaining resources shared by cached rooms. */
export function disposeObjects(roots: THREE.Object3D[], keep: THREE.Object3D[] = []) {
  const resources = (objects: THREE.Object3D[]) => {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    const shadows = new Set<THREE.LightShadow>();
    for (const root of objects) root.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
      if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
      const shadow = (object as THREE.SpotLight).shadow;
      if (shadow) shadows.add(shadow);
    });
    return { geometries, materials, textures, shadows };
  };
  const removed = resources(roots), retained = resources(keep);
  for (const key of ['geometries', 'materials', 'textures', 'shadows'] as const) {
    for (const resource of removed[key]) if (!(retained[key] as Set<unknown>).has(resource)) resource.dispose();
  }
}
