import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Draw-call reduction for a finished room: merges static meshes that share a material into a
 * few big meshes (one per material × visibility root × shadow flags × physics class).
 *
 * Dynamic bodies (`userData.physics.type === 'dynamic'`) stay separate objects: their meshes are
 * only merged among themselves, inside the body (skipped entirely for shape 'compound', which
 * needs one hull per mesh). Left untouched: transparent materials (they need per-object sorting),
 * multi-material meshes, instanced/skinned/batched meshes, meshes with children or custom
 * drawRange/onBeforeRender, and anything under a node with `userData.noMerge`.
 * `roots` are the nodes whose visibility is toggled at runtime (walls for the dollhouse cutaway,
 * the ceiling): meshes are only merged with others under the same root.
 * `mergeDynamic` (viewer only, where nothing moves) merges the bodies too, so every shelf prop,
 * book and can stops being its own draw call; never use it where physics will move them.
 * Run it once, before the first render (the originals then never upload to the GPU).
 */
export function batchStatic(root: THREE.Object3D, roots: THREE.Object3D[] = [], { mergeDynamic = false } = {}) {
  root.updateMatrixWorld(true);
  const rootSet = new Set(roots);
  const groups = new Map<string, { vroot: THREE.Object3D; material: THREE.Material; meshes: THREE.Mesh[]; none: boolean; cast: boolean; receive: boolean; order: number }>();
  let before = 0;
  const noop = THREE.Object3D.prototype.onBeforeRender;

  const visit = (o: THREE.Object3D, vroot: THREE.Object3D, none: boolean) => {
    if (!o.visible) return;
    const tag = o.userData.physics as { type?: string; shape?: string } | undefined;
    if (o !== root && (o.userData.noMerge || (!mergeDynamic && tag?.type === 'dynamic' && tag.shape === 'compound'))) return;
    if (tag?.type === 'none') none = true;
    // a dynamic body is its own root: its meshes merge only with each other, in its local space,
    // so it stays one separate, throwable object (nested bodies start their own root).
    // mergeDynamic: nothing moves (the viewer), so bodies merge with everything else too.
    if (rootSet.has(o) || (o !== root && !mergeDynamic && tag?.type === 'dynamic')) vroot = o;
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      before++;
      const mat = m.material as THREE.Material;
      const g = m.geometry;
      const ok =
        !Array.isArray(m.material) && !mat.transparent && !(m as THREE.InstancedMesh).isInstancedMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh &&
        !(m as unknown as { isBatchedMesh?: boolean }).isBatchedMesh && !m.morphTargetInfluences && m.children.length === 0 &&
        m.onBeforeRender === noop && g.drawRange.count === Infinity && g.drawRange.start === 0 && !!g.getAttribute('position') &&
        Object.keys(g.morphAttributes).length === 0;
      if (ok) {
        const sig = Object.keys(g.attributes).filter((k) => ['position', 'normal', 'uv', 'uv1', 'color', 'tangent'].includes(k)).sort()
          .map((k) => `${k}${g.getAttribute(k).itemSize}`).join(',');
        const key = [vroot.id, fingerprint(mat), sig, none, m.castShadow, m.receiveShadow, m.renderOrder, m.layers.mask, m.frustumCulled].join('|');
        let e = groups.get(key);
        if (!e) groups.set(key, (e = { vroot, material: mat, meshes: [], none, cast: m.castShadow, receive: m.receiveShadow, order: m.renderOrder }));
        e.meshes.push(m);
      }
    }
    for (const c of [...o.children]) visit(c, vroot, none);
  };
  visit(root, root, false);

  const inv = new THREE.Matrix4(), rel = new THREE.Matrix4();
  let merged = 0, removed = 0;
  for (const e of groups.values()) {
    if (e.meshes.length < 2) continue;
    inv.copy(e.vroot.matrixWorld).invert();
    const geos = e.meshes.map((m) => {
      rel.multiplyMatrices(inv, m.matrixWorld);
      return bakeGeometry(m.geometry, rel);
    });
    const geo = mergeGeometries(geos, false);
    if (!geo) continue;
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const out = new THREE.Mesh(geo, e.material);
    out.name = `batch:${e.material.name || e.material.type}`;
    out.castShadow = e.cast;
    out.receiveShadow = e.receive;
    out.renderOrder = e.order;
    if (e.none) out.userData.physics = { type: 'none' };
    // keep the static collider chunking of the play mode meaningful: remember what went in
    out.userData.batched = e.meshes.length;
    e.vroot.add(out);
    for (const m of e.meshes) m.removeFromParent();
    merged++;
    removed += e.meshes.length;
  }
  return { meshesBefore: before, meshesAfter: before - removed + merged, batches: merged };
}

const fingerprints = new WeakMap<THREE.Material, string>();
const IGNORE = new Set(['uuid', 'id', 'name', 'userData', 'version', '_listeners', 'type', 'isMaterial']);
/**
 * Materials that are separate objects but identical (items often build per-mesh clones) merge
 * together: a fingerprint of every parameter, textures by image source + transform.
 * Shader/custom-compiled materials only match themselves.
 */
function fingerprint(mat: THREE.Material): string {
  let f = fingerprints.get(mat);
  if (f) return f;
  const custom = (mat as THREE.ShaderMaterial).isShaderMaterial || mat.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile;
  if (custom) f = mat.uuid;
  else {
    const parts: string[] = [mat.type];
    const rec = mat as unknown as Record<string, unknown>;
    for (const k of Object.keys(rec).sort()) {
      if (IGNORE.has(k) || k.startsWith('_') && k !== '_anisotropy' && k !== '_clearcoat' && k !== '_sheen' && k !== '_iridescence' && k !== '_transmission' && k !== '_dispersion' && k !== '_dashSize') continue;
      const v = rec[k];
      let s: string;
      if (v === null || v === undefined) s = '-';
      else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') s = String(v);
      else if ((v as THREE.Color).isColor) s = (v as THREE.Color).getHexString() + (v as THREE.Color).r.toFixed(4);
      else if ((v as THREE.Vector2).isVector2) s = `${(v as THREE.Vector2).x},${(v as THREE.Vector2).y}`;
      else if ((v as THREE.Texture).isTexture) {
        const t = v as THREE.Texture;
        s = `${t.source.uuid}:${t.offset.x},${t.offset.y},${t.repeat.x},${t.repeat.y},${t.rotation},${t.center.x},${t.center.y},${t.wrapS},${t.wrapT},${t.channel},${t.flipY},${t.colorSpace},${t.version}`;
      } else if ((v as THREE.Euler).isEuler) s = (v as THREE.Euler).toArray().join(',');
      else if (Array.isArray(v)) s = JSON.stringify(v);
      else if (typeof v === 'function') s = 'fn';
      else s = mat.uuid; // unknown object-valued parameter: don't risk it
      parts.push(`${k}=${s}`);
    }
    f = parts.join(';');
  }
  fingerprints.set(mat, f);
  return f;
}

/** Float32 copy of a geometry's standard attributes, transformed, indexed, with winding fixed for mirrored transforms */
function bakeGeometry(src: THREE.BufferGeometry, m: THREE.Matrix4) {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'uv1', 'color', 'tangent']) {
    const a = src.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    if (!a) continue;
    const arr = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) arr[i * a.itemSize + k] = a.getComponent(i, k);
    g.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
  }
  const count = g.getAttribute('position').count;
  let index: number[] | THREE.TypedArray;
  if (src.index) index = src.index.array.slice();
  else {
    index = new Uint32Array(count);
    for (let i = 0; i < count; i++) index[i] = i;
  }
  if (m.determinant() < 0) {
    for (let i = 0; i + 2 < index.length; i += 3) {
      const t = index[i + 1];
      index[i + 1] = index[i + 2];
      index[i + 2] = t;
    }
  }
  g.setIndex(new THREE.BufferAttribute(index instanceof Uint32Array ? index : new Uint32Array(index), 1));
  g.applyMatrix4(m);
  return g;
}
