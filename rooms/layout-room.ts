import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { batchStatic } from '../packages/room-runtime/batch';
import { box } from '../packages/room-runtime/helpers';
import { loadTextures, materials } from '../packages/room-runtime/materials';
import type { BuiltRoom, PhotoPose, RoomLayout, RoomModule, V3 } from '../packages/room-runtime/types';
import { buildWall, type Opening, type WallDef } from '../packages/room-runtime/walls';

/** bundle_to_room.py output: room-local meters, floor at y = 0 */
export interface ScanLayout {
  polygon: number[][];
  walls: {
    index: number; a: number[]; b: number[]; height: number; origin: number[]; u: number[]; n: number[];
    length: number; confidence?: string;
    openings: { kind: string; u0: number; u1: number; v0: number; v1: number; isOpen?: boolean | null }[];
  }[];
  objects: { category: string; center: number[]; size: number[]; rotY: number }[];
  photos?: { file: string; position: number[]; forward: number[]; up: number[]; fovY: number; aspect: number }[];
}

export interface LayoutRoomOptions {
  id: string;
  label: string;
  layout: ScanLayout;
  /** URL of the colored scan (GLB, room coordinates) for the Scan/Overlay modes */
  referenceUrl?: string;
  /** folder URL of prepare_photos.py output (NNNN.jpg in layout.photos order) for photo comparisons */
  photoBase?: string;
  wallThickness?: number;
}

const v3 = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);

function insidePolygon(poly: number[][], x: number, z: number) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[j];
    if ((z1 > z) !== (z2 > z) && x < x1 + ((z - z1) * (x2 - x1)) / (z2 - z1)) hit = !hit;
  }
  return hit;
}

/** Flat polygon at height y (floor faces up, ceiling faces down); UVs in meters */
function flat(poly: number[][], y: number, material: THREE.Material, up: boolean) {
  const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, up ? -z : z)));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(up ? -Math.PI / 2 : Math.PI / 2);
  geo.translate(0, y, 0);
  const m = new THREE.Mesh(geo, material);
  m.receiveShadow = true;
  return m;
}

/**
 * A first-pass room straight from a scan layout: measured walls (with openings), floor, ceiling and
 * furniture bounding boxes. It is the measured baseline the modeling skill refines, not the final model.
 */
export function layoutRoom(o: LayoutRoomOptions): RoomModule {
  return { id: o.id, label: o.label, build: () => buildLayoutRoom(o) };
}

async function buildLayoutRoom(o: LayoutRoomOptions): Promise<BuiltRoom> {
  await loadTextures();
  const m = materials();
  const L = o.layout;
  const top = Math.max(...L.walls.map(w => w.height));
  const group = new THREE.Group();
  const lights = new THREE.Group();

  // Walls run past their ends to close corners, except where that would poke into the room
  // (reflex corners: the next wall's inward normal points along this wall's direction).
  const near = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05;
  const walls = L.walls.map(w => {
    const next = L.walls.find(x => x !== w && near(x.a, w.b));
    const prev = L.walls.find(x => x !== w && near(x.b, w.a));
    const ext = (other: typeof w | undefined, dir: number): number =>
      other && dir * (other.n[0] * w.u[0] + other.n[2] * w.u[2]) > 0.1 ? 0 : 0.3;
    const def: WallDef = {
      name: `w${w.index}`,
      origin: v3(w.origin), u: v3(w.u), n: v3(w.n),
      length: w.length,
      thickness: o.wallThickness ?? 0.12,
      height: w.height,
      crown: false,
      panels: [],
      ext: [ext(prev, -1), ext(next, 1)],
      openings: w.openings.map((op): Opening => ({ kind: 'rect', u0: op.u0, u1: op.u1, v0: op.v0, v1: op.v1, casing: op.kind === 'door' })),
    };
    return { def, group: buildWall(def, m) };
  });

  const floor = flat(L.polygon, 0, m.woodFloor, true);
  floor.name = 'floor';
  const ceiling = flat(L.polygon, top, m.ceiling, false);
  ceiling.name = 'ceiling';
  group.add(floor, ceiling, ...walls.map(w => w.group));

  // Scan furniture boxes are bounds only: neutral placeholders until modeled from photos
  const placeholder = new THREE.MeshStandardMaterial({ color: '#c9bfb2', roughness: 0.85 });
  for (const [i, ob] of L.objects.entries()) {
    const b = box(ob.size as V3, ob.center as V3, placeholder);
    b.rotation.y = ob.rotY;
    b.name = `placeholder:${ob.category}:${i}`;
    b.castShadow = b.receiveShadow = true;
    group.add(b);
  }

  // Even, neutral light until real fixtures are modeled
  const xs = L.polygon.map(p => p[0]), zs = L.polygon.map(p => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const [cx, cz] = [(x0 + x1) / 2, (z0 + z1) / 2];
  lights.add(new THREE.HemisphereLight('#f4f1ea', '#b9a58c', 1.2));
  for (const fx of [0.3, 0.7]) for (const fz of [0.3, 0.7]) {
    const p = new THREE.PointLight('#fff1dc', 4, 0, 2);
    p.position.set(x0 + (x1 - x0) * fx, top - 0.3, z0 + (z1 - z0) * fz);
    if (insidePolygon(L.polygon, p.position.x, p.position.z)) lights.add(p);
  }

  const layout: RoomLayout = {
    polygon: L.polygon,
    walls: L.walls.map(w => ({ a: w.a, b: w.b, u: w.u, length: w.length, openings: w.openings.map(op => ({ kind: op.kind, u0: op.u0, u1: op.u1 })) })),
    objects: L.objects,
  };
  const photos: PhotoPose[] | undefined = o.photoBase && L.photos
    ? L.photos.map((p, i) => ({ url: `${o.photoBase}/${String(i).padStart(4, '0')}.jpg`, position: p.position, forward: p.forward, up: p.up, fovY: p.fovY, aspect: p.aspect }))
    : undefined;
  const span = Math.max(x1 - x0, z1 - z0);
  const inside = (x: number, z: number) => insidePolygon(L.polygon, x, z);

  return {
    layout,
    group,
    lights,
    walls,
    ceiling: [ceiling],
    wallTop: top,
    walkable: (x, z) => inside(x, z) && inside(x + 0.2, z) && inside(x - 0.2, z) && inside(x, z + 0.2) && inside(x, z - 0.2),
    camera: { orbit: [cx + span * 0.7, span * 1.1, cz + span * 0.9], target: [cx, 0.8, cz], walk: [cx, 1.6, cz], walkLook: [x1, 1.3, cz] },
    environment: { center: [cx, 1.2, cz], intensity: 1 },
    referenceAvailable: !!o.referenceUrl,
    referenceKind: 'scan',
    loadReference: async onProgress => {
      if (!o.referenceUrl) throw new Error('No reference scan configured for this room.');
      const gltf = await new GLTFLoader().loadAsync(o.referenceUrl, e => onProgress?.(e.total ? e.loaded / e.total : 0));
      return gltf.scene;
    },
    optimize: opts => batchStatic(group, [...walls.map(w => w.group), ceiling], { mergeDynamic: !!opts?.static }),
    photos,
  };
}
