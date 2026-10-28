import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export type V3 = [number, number, number];

export function mesh(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], name?: string) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = true;
  if (name) m.name = name;
  return m;
}

export function place<T extends THREE.Object3D>(obj: T, pos: V3, rotY = 0): T {
  obj.position.set(...pos);
  obj.rotation.y = rotY;
  return obj;
}

/** Box by center + size, with UVs in meters */
export function box(size: V3, center: V3, material: THREE.Material, uvScale = 1) {
  const g = new THREE.BoxGeometry(...size);
  boxUV(g, uvScale);
  return place(mesh(g, material), center);
}

/** Box spanning min..max corners */
export function boxSpan(min: V3, max: V3, material: THREE.Material) {
  const size: V3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const center: V3 = [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2];
  return box(size, center, material);
}

/** Soft upholstered block */
export function cushion(size: V3, center: V3, radius: number, material: THREE.Material, segments = 4) {
  const r = Math.min(radius, size[0] / 2 - 0.001, size[1] / 2 - 0.001, size[2] / 2 - 0.001);
  const g = new RoundedBoxGeometry(size[0], size[1], size[2], segments, r);
  boxUV(g);
  return place(mesh(g, material), center);
}

/**
 * Replace UVs with a box projection in meters so tiled textures
 * keep a constant real-world scale regardless of the object's size.
 */
export function boxUV(geometry: THREE.BufferGeometry, scale = 1) {
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u: number, v: number;
    if (nx >= ny && nx >= nz) [u, v] = [z, y];
    else if (ny >= nx && ny >= nz) [u, v] = [x, z];
    else [u, v] = [x, y];
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/**
 * Sweep a 2D profile along a polyline with mitered corners.
 * Profile points are [s, t]: s is the in-plane offset to the left of the
 * travel direction (planeNormal × direction), t is the offset along planeNormal.
 * Repeat a profile point to get a hard edge there.
 */
export function sweep(
  profile: [number, number][],
  path: THREE.Vector3[],
  planeNormal: THREE.Vector3,
  { closed = false, caps = true } = {},
): THREE.BufferGeometry {
  const n = planeNormal.clone().normalize();
  const count = path.length;
  const segs = closed ? count : count - 1;
  const dir = (i: number) => path[(i + 1) % count].clone().sub(path[i]).normalize();
  const perp = (d: THREE.Vector3) => new THREE.Vector3().crossVectors(n, d).normalize();

  // miter vector + scale for each vertex
  const miters: { m: THREE.Vector3; k: number }[] = [];
  for (let i = 0; i < count; i++) {
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < count - 1;
    const pIn = hasPrev ? perp(dir((i - 1 + count) % count)) : null;
    const pOut = hasNext ? perp(dir(i)) : null;
    if (pIn && pOut) {
      const m = pIn.clone().add(pOut).normalize();
      miters.push({ m, k: 1 / Math.max(0.2, m.dot(pIn)) });
    } else {
      miters.push({ m: (pIn ?? pOut)!, k: 1 });
    }
  }

  // profile arc-length for v coordinate
  const pv = [0];
  for (let j = 1; j < profile.length; j++) {
    pv.push(pv[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ring = (i: number) => {
    const { m, k } = miters[i];
    return profile.map(([s, t]) => path[i].clone().addScaledVector(m, s * k).addScaledVector(n, t));
  };

  let along = 0;
  for (let s = 0; s < segs; s++) {
    const a = s, b = (s + 1) % count;
    const ra = ring(a), rb = ring(b);
    const len = path[b].distanceTo(path[a]);
    const base = positions.length / 3;
    for (let j = 0; j < profile.length; j++) {
      positions.push(ra[j].x, ra[j].y, ra[j].z);
      uvs.push(along, pv[j]);
    }
    for (let j = 0; j < profile.length; j++) {
      positions.push(rb[j].x, rb[j].y, rb[j].z);
      uvs.push(along + len, pv[j]);
    }
    const P = profile.length;
    for (let j = 0; j < P - 1; j++) {
      indices.push(base + j, base + P + j, base + j + 1);
      indices.push(base + j + 1, base + P + j, base + P + j + 1);
    }
    along += len;
  }

  if (!closed && caps) {
    const tri = THREE.ShapeUtils.triangulateShape(profile.map(([x, y]) => new THREE.Vector2(x, y)), []);
    for (const [i, flip] of [[0, true], [count - 1, false]] as const) {
      const r = ring(i);
      const base = positions.length / 3;
      r.forEach((p) => { positions.push(p.x, p.y, p.z); uvs.push(0, 0); });
      for (const [x, y, z] of tri) indices.push(...(flip ? [base + x, base + z, base + y] : [base + x, base + y, base + z]));
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** Lathe from [radius, y] pairs */
export function lathe(points: [number, number][], material: THREE.Material, segments = 32) {
  const g = new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
  return mesh(g, material);
}

export function tube(points: V3[], radius: number, material: THREE.Material, tubular = 32) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return mesh(new THREE.TubeGeometry(curve, tubular, radius, 8, false), material);
}

export function cylinder(radius: number, height: number, center: V3, material: THREE.Material, segments = 24, radiusBottom = radius) {
  return place(mesh(new THREE.CylinderGeometry(radius, radiusBottom, height, segments), material), center);
}

export function sphere(radius: number, center: V3, material: THREE.Material, scale: V3 = [1, 1, 1]) {
  const m = place(mesh(new THREE.SphereGeometry(radius, 24, 16), material), center);
  m.scale.set(...scale);
  return m;
}

/** Quarter/half circle points for profiles: center, radius, from→to angle (radians) */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, steps = 6): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/**
 * Pillow: an ellipsoid whose round footprint is stretched onto a square,
 * so it's puffy in the middle with pinched corners. size = [w, h, thickness].
 */
export function pillow(size: V3, material: THREE.Material) {
  const g = new THREE.SphereGeometry(0.5, 32, 24);
  g.rotateX(Math.PI / 2); // poles on ±z so the equator is the pillow's outline
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) * 2, v = pos.getY(i) * 2, z = pos.getZ(i) * 2;
    // disc → square (elliptical grid mapping)
    const t = 2 * Math.SQRT2;
    const a = 2 + u * u - v * v, b = 2 - u * u + v * v;
    const x = 0.5 * Math.sqrt(Math.max(0, a + t * u)) - 0.5 * Math.sqrt(Math.max(0, a - t * u));
    const y = 0.5 * Math.sqrt(Math.max(0, b + t * v)) - 0.5 * Math.sqrt(Math.max(0, b - t * v));
    // thinner toward the seams; sides pulled in so the corners poke out
    const edge = Math.max(Math.abs(x), Math.abs(y));
    const k = Math.sqrt(Math.max(0, 1 - edge * edge)) * 0.7 + 0.3;
    const px = x * (1 - 0.07 * (1 - y * y)) * (1 + 0.04 * (1 - z * z));
    const py = y * (1 - 0.07 * (1 - x * x)) * (1 + 0.04 * (1 - z * z));
    pos.setXYZ(i, (px * size[0]) / 2, (py * size[1]) / 2, (z * size[2] * k) / 2);
  }
  g.computeVertexNormals();
  boxUV(g);
  return mesh(g, material);
}
