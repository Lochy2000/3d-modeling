#!/usr/bin/env node
// Measures a room scan (GLB/GLTF, e.g. Polycam export) and prints what you need
// to set up room coordinates: floor/ceiling heights, wall orientation, wall planes.
//
// usage: node measure_scan.mjs <scan.glb> [--out <dir>]
//   --out   also writes plan-height.png / plan-walls.png (top-down, 2cm/px, grid every 0.5m)
//
// Needs (in the project): npm i -D @gltf-transform/core gl-matrix pngjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const { NodeIO } = await import(require.resolve('@gltf-transform/core'));
const { vec3 } = await import(require.resolve('gl-matrix'));

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
if (!file) {
  console.error('usage: node measure_scan.mjs <scan.glb> [--out <dir>]');
  process.exit(1);
}

// --- load world-space triangles -------------------------------------------
const doc = await new NodeIO().read(file);
const tris = [];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const idx = prim.getIndices();
    const count = idx ? idx.getCount() : pos.getCount();
    const p = (i) => vec3.transformMat4([], pos.getElement(i, []), m);
    for (let t = 0; t < count; t += 3) {
      const [ia, ib, ic] = idx ? [idx.getScalar(t), idx.getScalar(t + 1), idx.getScalar(t + 2)] : [t, t + 1, t + 2];
      const a = p(ia), b = p(ib), c = p(ic);
      const cr = vec3.cross([], vec3.sub([], b, a), vec3.sub([], c, a));
      const len = vec3.length(cr);
      if (len > 0) tris.push({ a, b, c, n: vec3.scale([], cr, 1 / len), area: len / 2 });
    }
  }
}
console.log(`${tris.length} triangles`);

const centroid = (t) => [0, 1, 2].map((k) => (t.a[k] + t.b[k] + t.c[k]) / 3);
const top = (map, n = 8, min = 0) =>
  [...map.entries()].filter(([, v]) => v > min).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `${k}: ${v.toFixed(2)}m²`).join('   ');
const add = (map, k, v) => map.set(k, (map.get(k) || 0) + v);

// --- 1. horizontal surfaces: floor = biggest up-facing area, ceiling = down-facing ---
const up = new Map(), down = new Map();
const az = new Float64Array(180);
for (const t of tris) {
  const [, cy] = centroid(t);
  if (Math.abs(t.n[1]) > 0.9) add(t.n[1] > 0 ? up : down, (Math.round(cy / 0.05) * 0.05).toFixed(2), t.area);
  else if (Math.abs(t.n[1]) < 0.2) {
    let a = (Math.atan2(t.n[2], t.n[0]) * 180) / Math.PI;
    a = ((a % 90) + 90) % 90; // walls are orthogonal, so fold to 0..90
    az[Math.floor(a * 2) % 180] += t.area;
  }
}
console.log('\nUP-facing surfaces by height (floor is usually the largest; others = furniture tops):\n  ' + top(up));
console.log('DOWN-facing surfaces by height (ceiling; several values = tray/soffit/beams):\n  ' + top(down));
const azTop = [...az].map((v, i) => [i / 2, v]).sort((x, y) => y[1] - x[1]).slice(0, 5);
console.log('Wall azimuth mod 90° (≈0 means walls already align with X/Z; otherwise rotate by -angle):\n  ' +
  azTop.map(([a, v]) => `${a}°: ${v.toFixed(1)}`).join('   '));

// the floor often straddles two 5cm bins: area-weighted mean of the top bin and its neighbours
const upSorted = [...up.entries()].map(([k, v]) => [Number(k), v]).sort((x, y) => y[1] - x[1]);
const near = upSorted.filter(([k]) => Math.abs(k - upSorted[0][0]) <= 0.051);
const floorY = Number((near.reduce((s, [k, v]) => s + k * v, 0) / near.reduce((s, [, v]) => s + v, 0)).toFixed(3));

// --- 2. wall planes: vertical faces above furniture height --------------------
const hx = new Map(), hz = new Map();
for (const t of tris) {
  const [cx, cy, cz] = centroid(t);
  if (cy - floorY < 1.0 || cy - floorY > 3.2) continue;
  if (Math.abs(t.n[0]) > 0.9) add(hx, (Math.round(cx / 0.02) * 0.02).toFixed(2) + (t.n[0] > 0 ? ' (faces +x)' : ' (faces -x)'), t.area);
  if (Math.abs(t.n[2]) > 0.9) add(hz, (Math.round(cz / 0.02) * 0.02).toFixed(2) + (t.n[2] > 0 ? ' (faces +z)' : ' (faces -z)'), t.area);
}
console.log(`\nfloor ≈ y ${floorY}`);
console.log('X wall planes (x = …; a wall facing +x is the room\'s -x side):\n  ' + top(hx, 10, 0.15));
console.log('Z wall planes:\n  ' + top(hz, 10, 0.15));
console.log('\nNext: pick the dominant +/- plane on each axis → room width/depth; center = midpoint;');
console.log('SCAN_OFFSET = (-centerX, -floorY, -centerZ). Ceiling height = ceilingY - floorY.');

// --- 3. optional top-down images ------------------------------------------------
if (outDir) {
  const { PNG } = await import(require.resolve('pngjs'));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const t of tris) for (const v of [t.a, t.b, t.c]) {
    minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]); minZ = Math.min(minZ, v[2]); maxZ = Math.max(maxZ, v[2]);
  }
  const RES = 0.02;
  const W = Math.ceil((maxX - minX) / RES), H = Math.ceil((maxZ - minZ) / RES);
  const height = new Float32Array(W * H).fill(-1);
  const wall = new Float32Array(W * H);
  for (const t of tris) {
    const steps = Math.max(1, Math.ceil(Math.sqrt(t.area) / RES) * 2);
    for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps - i; j++) {
      const u = i / steps, v = j / steps, w = 1 - u - v;
      const x = t.a[0] * w + t.b[0] * u + t.c[0] * v;
      const y = t.a[1] * w + t.b[1] * u + t.c[1] * v - floorY;
      const z = t.a[2] * w + t.b[2] * u + t.c[2] * v;
      const px = Math.floor((x - minX) / RES), pz = Math.floor((z - minZ) / RES);
      if (px < 0 || pz < 0 || px >= W || pz >= H) continue;
      const k = pz * W + px;
      if (y < 3.2 && y > height[k]) height[k] = y;
      if (y > 2.2 && Math.abs(t.n[1]) < 0.3) wall[k] = 1;
    }
  }
  const save = (name, color) => {
    const png = new PNG({ width: W, height: H });
    for (let pz = 0; pz < H; pz++) for (let px = 0; px < W; px++) {
      const k = pz * W + px;
      let [r, g, b] = color(k);
      const x = minX + px * RES, z = minZ + pz * RES;
      const onX = Math.abs(x - Math.round(x * 2) / 2) < RES / 2, onZ = Math.abs(z - Math.round(z * 2) / 2) < RES / 2;
      if ((onX && Math.abs(x) < RES / 2) || (onZ && Math.abs(z) < RES / 2)) [r, g, b] = [255, 0, 0];
      else if (onX || onZ) [r, g, b] = [r * 0.6 + 32, g * 0.6 + 64, b * 0.6 + 100];
      png.data.set([r, g, b, 255], k * 4);
    }
    fs.writeFileSync(path.join(outDir, name), PNG.sync.write(png));
  };
  save('plan-height.png', (k) => {
    const y = height[k];
    if (y < 0) return [0, 0, 0];
    const t = Math.min(1, y / 1.2);
    return [40 + 215 * t, 40 + 150 * t * t, 60 + 60 * (1 - t)];
  });
  save('plan-walls.png', (k) => (wall[k] ? [255, 255, 255] : height[k] >= 0 ? [50, 50, 50] : [0, 0, 0]));
  console.log(`\nwrote ${outDir}/plan-height.png and plan-walls.png (${W}x${H}px, origin x ${minX.toFixed(2)} z ${minZ.toFixed(2)}, ${RES}m/px, red = world axes)`);
}
