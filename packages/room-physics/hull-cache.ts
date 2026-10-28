import type RAPIER_NS from '@dimforge/rapier3d-compat';

/**
 * V-HACD convex decomposition is slow (100 ms – seconds per object), so the resulting
 * convex parts are cached: in memory for this page, and in IndexedDB across reloads.
 * Keyed by object name + triangle count + local size, so an edited model recomputes.
 */
const VERSION = 1;
const memory = new Map<string, Float32Array[]>();

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('house-play-hulls', VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore('parts');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
let dbPromise: Promise<IDBDatabase | null> | undefined;

async function dbGet(key: string): Promise<Float32Array[] | undefined> {
  const db = await (dbPromise ??= openDb());
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const req = db.transaction('parts').objectStore('parts').get(key);
      req.onsuccess = () => resolve(req.result as Float32Array[] | undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function dbPut(key: string, parts: Float32Array[]) {
  const db = await (dbPromise ??= openDb());
  if (!db) return;
  try {
    db.transaction('parts', 'readwrite').objectStore('parts').put(parts, key);
  } catch {
    /* storage full / blocked: fine, it's only a cache */
  }
}

/** Convex parts (each a flat xyz point list, in the body frame) of a triangle soup */
export async function decomposeCached(R: typeof RAPIER_NS, key: string, verts: number[], idx: number[]): Promise<Float32Array[]> {
  const hit = memory.get(key) ?? (await dbGet(key));
  if (hit) {
    memory.set(key, hit);
    return hit;
  }
  const t0 = performance.now();
  const desc = R.ColliderDesc.convexDecomposition(new Float32Array(verts), new Uint32Array(idx), {
    resolution: 48,
    maxConvexHulls: 12,
    concavity: 0.02,
    convexHullApproximation: true,
  });
  const parts: Float32Array[] = [];
  const shape = desc?.shape as RAPIER_NS.Compound | undefined;
  if (shape?.shapes) {
    shape.shapes.forEach((s, i) => {
      const v = (s as RAPIER_NS.ConvexPolyhedron).vertices;
      if (!v?.length) return;
      // bake the sub-shape's placement into its points
      const p = shape.positions[i];
      const r = shape.rotations[i];
      const out = new Float32Array(v.length);
      for (let k = 0; k < v.length; k += 3) {
        const [x, y, z] = rotate(r, v[k], v[k + 1], v[k + 2]);
        out[k] = x + p.x;
        out[k + 1] = y + p.y;
        out[k + 2] = z + p.z;
      }
      parts.push(out);
    });
  }
  console.info(`[play] convex decomposition of ${key.split('|')[0]}: ${parts.length} parts in ${Math.round(performance.now() - t0)} ms (computed; cached for next time)`);
  memory.set(key, parts);
  void dbPut(key, parts);
  return parts;
}

function rotate(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number): [number, number, number] {
  // v' = q v q*
  const ix = q.w * x + q.y * z - q.z * y;
  const iy = q.w * y + q.z * x - q.x * z;
  const iz = q.w * z + q.x * y - q.y * x;
  const iw = -q.x * x - q.y * y - q.z * z;
  return [
    ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  ];
}
