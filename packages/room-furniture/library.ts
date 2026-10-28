import * as THREE from 'three';
import { box, cushion, cylinder, lathe, mesh, pillow, tube } from '../room-runtime/helpers';
import { finish, kilim, persianRug } from './materials';
import type { FurnitureItem, FurnitureType } from './types';

// Parametric furniture. Every builder works in the item's local frame (floor centre of the footprint,
// front toward +z) and reads its numbers from the item, falling back to typical proportions.

type Builder = (item: FurnitureItem, g: THREE.Group) => void;

const num = (it: FurnitureItem, key: string, fallback: number) => (typeof it.params?.[key] === 'number' ? (it.params[key] as number) : fallback);
const col = (it: FurnitureItem, key: string, fallback: string) => it.colors?.[key] ?? fallback;

/**
 * Box-framed sofa with flat arms level with the back, loose seat and back cushions, low legs.
 * params: seats, seatHeight (cushion top), armWidth, legHeight, backThickness,
 *         pillows [{ x (m from centre), color, accent? (kilim pattern) }], throw { side: 'left'|'right', width }
 * colors: body, legs, throw, throwStripe
 */
const sofa: Builder = (it, g) => {
  const [W, H, D] = it.size;
  const seats = num(it, 'seats', 3), seatH = num(it, 'seatHeight', 0.45), armW = num(it, 'armWidth', 0.16);
  const legH = num(it, 'legHeight', 0.06), backT = num(it, 'backThickness', 0.15), cushT = 0.15;
  const leather = finish('leather', col(it, 'body', '#b07a45'));
  const wood = finish('wood', col(it, 'legs', '#8a5a33'));
  const r = 0.035;

  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.add(box([0.05, legH, 0.05], [sx * (W / 2 - 0.06), legH / 2, sz * (D / 2 - 0.06)], wood));
  }
  const deckTop = seatH - cushT;
  g.add(cushion([W - 2 * armW + 0.02, deckTop - legH, D], [0, (legH + deckTop) / 2, 0], 0.02, leather));
  for (const sx of [-1, 1]) {
    g.add(cushion([armW, H - legH, D], [sx * (W / 2 - armW / 2), (legH + H) / 2, 0], r, leather));
  }
  const innerW = W - 2 * armW;
  g.add(cushion([innerW + 0.02, H - legH - 0.04, backT], [0, (legH + H - 0.04) / 2, -D / 2 + backT / 2], r, leather));

  const cw = innerW / seats;
  const seatD = D - backT - 0.01;
  for (let i = 0; i < seats; i++) {
    const x = -innerW / 2 + cw * (i + 0.5);
    g.add(cushion([cw - 0.008, cushT, seatD], [x, deckTop + cushT / 2, -D / 2 + backT + seatD / 2], 0.05, leather));
    // back cushion leaning slightly back
    const bh = H - seatH - 0.02, bt = 0.13;
    const bc = cushion([cw - 0.008, bh, bt], [0, 0, 0], 0.05, leather);
    bc.position.set(x, seatH + bh / 2, -D / 2 + backT + bt / 2 - 0.02);
    bc.rotation.x = -0.12;
    g.add(bc);
  }

  const pillows = (it.params?.pillows as { x: number; color: string; accent?: string; size?: number }[] | undefined) ?? [];
  for (const [k, p] of pillows.entries()) {
    const s = p.size ?? 0.45;
    const pm = pillow([s, s, 0.15], p.accent ? kilim(p.color, p.accent, k + 3) : finish('fabric', p.color));
    pm.position.set(p.x, seatH + s / 2 - 0.02, -D / 2 + backT + 0.22);
    pm.rotation.x = -0.3;
    pm.rotation.z = (p.x > 0 ? -1 : 1) * 0.08;
    g.add(pm);
  }

  const th = it.params?.throw as { side: 'left' | 'right'; width?: number } | undefined;
  if (th) {
    const tw = th.width ?? 0.6, t = 0.025;
    const x = (th.side === 'right' ? 1 : -1) * (innerW / 2 - tw / 2 - 0.05);
    const cloth = finish('fabric', col(it, 'throw', '#e9e1d2'));
    const stripe = finish('fabric', col(it, 'throwStripe', '#8c2f2f'));
    // folded over the back cushion and spilling onto the seat, with thin woven stripes near the hem
    const zFace = -D / 2 + backT + 0.15;
    const drape = new THREE.Group();
    drape.add(cushion([tw, H - seatH - 0.02, t], [0, 0, 0], 0.01, cloth));
    for (const dy of [0.1, 0.14, 0.26]) drape.add(box([tw + 0.002, 0.012, t + 0.004], [0, -(H - seatH) / 2 + dy, 0], stripe));
    drape.position.set(x, (H + seatH) / 2, zFace);
    drape.rotation.x = -0.12;
    g.add(drape);
    g.add(cushion([tw, t, 0.3], [x, seatH + t / 2, zFace + 0.16], 0.01, cloth));
    g.add(cushion([tw, t, 0.16], [x, H - 0.01, zFace - 0.06], 0.01, cloth));
  }
};

/**
 * Low cabinet on tapered legs with sliding doors and recessed finger pulls.
 * params: legHeight, doors, topOverhang   colors: body, legs, pull
 */
const sideboard: Builder = (it, g) => {
  const [W, H, D] = it.size;
  const legH = num(it, 'legHeight', 0.16), doors = num(it, 'doors', 2), over = num(it, 'topOverhang', 0.01);
  const wood = finish('wood', col(it, 'body', '#8a4a2a'));
  const legs = finish('wood', col(it, 'legs', col(it, 'body', '#8a4a2a')));
  const pull = finish('matte', col(it, 'pull', '#2a1a12'));
  const top = 0.025;
  g.add(box([W + 2 * over, top, D + over], [0, H - top / 2, over / 2], wood));
  g.add(box([W, H - top - legH, D - 0.02], [0, (legH + H - top) / 2, -0.01], wood));
  g.add(box([W - 0.02, 0.025, D - 0.04], [0, legH + 0.012, -0.02], wood));
  const dw = (W - 0.03) / doors, dh = H - top - legH - 0.03;
  for (let i = 0; i < doors; i++) {
    const x = -W / 2 + 0.015 + dw * (i + 0.5);
    const z = D / 2 - 0.01 + (i % 2) * 0.012; // sliding doors run on two tracks
    g.add(box([dw + (i % 2 ? 0.01 : 0), dh, 0.018], [x, legH + 0.015 + dh / 2, z], wood));
    const px = x + (i < doors / 2 ? dw / 2 - 0.05 : -dw / 2 + 0.05);
    g.add(box([0.02, dh * 0.5, 0.004], [px, legH + 0.015 + dh / 2, z + 0.009], pull));
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = cylinder(0.022, legH, [sx * (W / 2 - 0.08), legH / 2, sz * (D / 2 - 0.07)], legs, 12, 0.014);
    leg.rotation.z = sx * -0.06;
    g.add(leg);
  }
};

/** Flat-panel TV. params: stand (bool)   colors: bezel, screen */
const tv: Builder = (it, g) => {
  const [W, H, D] = it.size;
  const bezel = finish('gloss', col(it, 'bezel', '#141414'));
  const screen = finish('screen', col(it, 'screen', '#06080a'));
  g.add(box([W, H, D], [0, H / 2, 0], bezel));
  g.add(box([W - 0.02, H - 0.02, 0.002], [0, H / 2 + 0.003, D / 2 + 0.001], screen));
  if (it.params?.stand) {
    g.add(box([W * 0.3, 0.012, 0.22], [0, -0.06, 0.02], bezel));
    g.add(box([0.06, 0.07, 0.04], [0, -0.03, 0], bezel));
  }
};

/** Persian rug with fringes on the short ends. colors: field, border, accent, light, fringe */
const rug: Builder = (it, g) => {
  const [W, H, D] = it.size;
  const colors = {
    field: col(it, 'field', '#8e1f22'), border: col(it, 'border', '#1d2a4a'),
    accent: col(it, 'accent', '#c98a3c'), light: col(it, 'light', '#e7dcc4'),
  };
  const t = Math.max(H, 0.006);
  const top = new THREE.Mesh(new THREE.PlaneGeometry(W, D), persianRug(W, D, colors, num(it, 'seed', 7)));
  top.rotation.x = -Math.PI / 2;
  top.position.y = t;
  top.receiveShadow = true;
  g.add(top);
  g.add(box([W, t - 0.001, D], [0, (t - 0.001) / 2, 0], finish('fabric', colors.border)));
  const fringe = finish('fabric', col(it, 'fringe', '#e8e0cf'));
  const long = W >= D;
  for (const s of [-1, 1]) {
    g.add(long ? box([0.06, 0.003, D * 0.96], [s * (W / 2 + 0.03), 0.002, 0], fringe) : box([W * 0.96, 0.003, 0.06], [0, 0.002, s * (D / 2 + 0.03)], fringe));
  }
};

/** Square metal-framed table with a glass top and glass shelf. params: shelfHeight, tube   colors: frame, glass */
const sideTable: Builder = (it, g) => {
  const [W, H, D] = it.size;
  const tube = num(it, 'tube', 0.02), shelfH = num(it, 'shelfHeight', 0.3);
  const frame = finish('metal', col(it, 'frame', '#1b1b1b'));
  const glass = finish('glass', col(it, 'glass', '#cfd8d6'));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.add(box([tube, H, tube], [sx * (W / 2 - tube / 2), H / 2, sz * (D / 2 - tube / 2)], frame));
  }
  for (const y of [H - tube / 2, shelfH]) {
    for (const s of [-1, 1]) {
      g.add(box([W, tube, tube], [0, y, s * (D / 2 - tube / 2)], frame));
      g.add(box([tube, tube, D], [s * (W / 2 - tube / 2), y, 0], frame));
    }
    const pane = box([W - tube, 0.008, D - tube], [0, y + tube / 2 + 0.004, 0], glass);
    pane.castShadow = false;
    g.add(pane);
  }
};

/**
 * Slumped bean bag: a squashed sphere, flat underneath, dished on top, with soft folds.
 * params: finish ('gloss' vinyl by default, or 'leather')   colors: body
 */
const beanBag: Builder = (it, g) => {
  const [W, H, D] = it.size;
  const geo = new THREE.SphereGeometry(0.5, 40, 28);
  const p = geo.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const rr = Math.hypot(x, z);
    if (y < -0.3) y = -0.3 - (y + 0.3) * 0.15; // flattened base
    y -= 0.12 * Math.exp(-(rr * rr) / 0.04) * (y > 0 ? 1 : 0); // dish where you sit
    const a = Math.atan2(z, x);
    const fold = 1 + 0.035 * Math.sin(a * 5 + y * 6) + 0.025 * Math.sin(a * 9 - y * 11);
    const bulge = (1 + 0.12 * Math.max(0, -y)) * fold; // spreads out near the floor
    x *= bulge; z *= bulge;
    p.setXYZ(i, x * W, (y + 0.33) / 0.83 * H, z * D);
  }
  geo.computeVertexNormals();
  g.add(mesh(geo, finish(it.params?.finish === 'leather' ? 'leather' : 'gloss', col(it, 'body', '#151515'))));
};

/** Bookshelf speaker: cabinet, black baffle, tweeter and woofer. colors: body, baffle */
const speaker: Builder = (it, g) => {
  const [W, H, D] = it.size;
  const body = finish('wood', col(it, 'body', '#6a4026'));
  const baffle = finish('matte', col(it, 'baffle', '#151515'));
  g.add(box([W, H, D], [0, H / 2, 0], body));
  g.add(box([W - 0.01, H - 0.01, 0.006], [0, H / 2, D / 2 + 0.003], baffle));
  const driver = (r: number, y: number) => {
    const c = cylinder(r, 0.01, [0, y, D / 2 + 0.008], finish('gloss', '#2a2a2a'), 24);
    c.rotation.x = Math.PI / 2;
    g.add(c);
  };
  driver(Math.min(W * 0.35, 0.07), H * 0.35);
  driver(Math.min(W * 0.14, 0.014), H * 0.78);
};

/**
 * Handleless kitchen island / peninsula: stone top, overhang on the seating side (+z), drawer bank on
 * the kitchen side (-z), optional waterfall end panels and an induction hob set into the top.
 * params: overhang, top (thickness), waterfall ('left'|'right'|'both'), drawerColumns,
 *         hob { x, z, w?, d? } (local, m from centre)
 * colors: top, body, hob
 */
const kitchenIsland: Builder = (it, g) => {
  const [W, H, D] = it.size;
  const over = num(it, 'overhang', 0.3), t = num(it, 'top', 0.03), plinth = 0.1;
  const stone = finish('stone', col(it, 'top', '#f2f1ee'));
  const body = finish('satin', col(it, 'body', '#e6e6e3'));
  const shadow = finish('matte', '#4a4a48');
  const wf = it.params?.waterfall as string | undefined;
  const wl = wf === 'left' || wf === 'both' ? t : 0, wr = wf === 'right' || wf === 'both' ? t : 0;
  g.add(box([W, t, D], [0, H - t / 2, 0], stone));
  if (wl) g.add(box([t, H - t, D], [-W / 2 + t / 2, (H - t) / 2, 0], stone));
  if (wr) g.add(box([t, H - t, D], [W / 2 - t / 2, (H - t) / 2, 0], stone));
  // carcass between the end panels; the seating side is a plain panel set back under the overhang
  const cw = W - wl - wr - 0.004, cx = (wl - wr) / 2, cd = D - over;
  g.add(box([cw, H - t - plinth, cd], [cx, (plinth + H - t) / 2, -D / 2 + cd / 2], body));
  g.add(box([cw, plinth, cd - 0.12], [cx, plinth / 2, -D / 2 + cd / 2 + 0.06], shadow));
  // drawer fronts: columns of three, 3 mm shadow gaps, a grip recess under the top
  const cols = num(it, 'drawerColumns', Math.max(1, Math.round(cw / 0.6)));
  const fw = cw / cols, fh = H - t - plinth - 0.04;
  for (let c = 0; c < cols; c++) {
    const x = cx - cw / 2 + fw * (c + 0.5);
    for (const [y0, y1] of [[0, 0.25], [0.25, 0.6], [0.6, 1]]) {
      const h = fh * (y1 - y0) - 0.003;
      g.add(box([fw - 0.003, h, 0.018], [x, plinth + fh * y0 + h / 2, -D / 2 - 0.009], body));
    }
  }
  g.add(box([cw, 0.035, 0.004], [cx, H - t - 0.02, -D / 2 - 0.016], shadow));
  const hob = it.params?.hob as { x: number; z: number; w?: number; d?: number } | undefined;
  if (hob) g.add(box([hob.w ?? 0.78, 0.006, hob.d ?? 0.52], [hob.x, H + 0.002, hob.z], finish('gloss', col(it, 'hob', '#0c0c0d'))));
};

interface RunSegment { kind: 'base' | 'tall'; width: number; appliance?: 'oven' | 'fridge' | 'sink' | 'dishwasher' }

/**
 * Straight kitchen run against a wall (back at -z): handleless base units with a worktop, wall units
 * above with an LED strip under them, and full-height columns (oven stack, fridge) as segments.
 * params: segments [{ kind: 'base'|'tall', width, appliance? }] (left to right), counterHeight,
 *         upperBottom, upperDepth
 * colors: body, top, appliance, led
 */
const kitchenRun: Builder = (it, g) => {
  const [W, H, D] = it.size;
  const segs = (it.params?.segments as RunSegment[] | undefined) ?? [{ kind: 'base', width: W }];
  const ch = num(it, 'counterHeight', 0.92), ub = num(it, 'upperBottom', 1.45), ud = num(it, 'upperDepth', 0.35);
  const t = 0.03, plinth = 0.1;
  const body = finish('satin', col(it, 'body', '#e6e6e3'));
  const stone = finish('stone', col(it, 'top', '#f2f1ee'));
  const black = finish('gloss', col(it, 'appliance', '#111214'));
  const steel = finish('metal', '#b9bbbd');
  const shadow = finish('matte', '#4a4a48');
  const led = finish('glow', col(it, 'led', '#e9fff4'));
  const fronts = (x0: number, x1: number, y0: number, y1: number, z: number, n: number) => {
    const w = (x1 - x0) / n;
    for (let i = 0; i < n; i++) g.add(box([w - 0.003, y1 - y0 - 0.003, 0.018], [x0 + w * (i + 0.5), (y0 + y1) / 2, z], body));
  };
  let x = -W / 2;
  for (const s of segs) {
    const x0 = x, x1 = x + s.width, xc = (x0 + x1) / 2;
    x = x1;
    const zf = D / 2 - 0.009;
    if (s.kind === 'tall') {
      g.add(box([s.width, H - plinth, D - 0.02], [xc, (plinth + H) / 2, -0.01], body));
      g.add(box([s.width, plinth, D - 0.08], [xc, plinth / 2, -0.04], shadow));
      if (s.appliance === 'oven') {
        // single oven with a compact combi above it, framed by panels
        fronts(x0, x1, plinth, 0.82, zf, 1);
        g.add(box([s.width - 0.02, 0.6, 0.02], [xc, 1.13, zf + 0.002], black));
        g.add(box([s.width - 0.02, 0.45, 0.02], [xc, 1.69, zf + 0.002], black));
        for (const y of [1.36, 1.86]) g.add(box([s.width - 0.12, 0.012, 0.025], [xc, y, zf + 0.015], steel));
        fronts(x0, x1, 1.93, H, zf, 1);
      } else {
        const split = s.appliance === 'fridge' ? 1.0 : H * 0.55;
        fronts(x0, x1, plinth, split, zf, 1);
        fronts(x0, x1, split, H, zf, 1);
      }
      continue;
    }
    g.add(box([s.width, ch - t - plinth, D - 0.02], [xc, (plinth + ch - t) / 2, -0.01], body));
    g.add(box([s.width, plinth, D - 0.08], [xc, plinth / 2, -0.04], shadow));
    g.add(box([s.width, t, D + 0.02], [xc, ch - t / 2, 0.01], stone));
    fronts(x0, x1, plinth, ch - t - 0.04, zf, s.appliance === 'dishwasher' ? 1 : Math.max(1, Math.round(s.width / 0.5)));
    g.add(box([s.width, 0.035, 0.004], [xc, ch - t - 0.02, zf - 0.007], shadow));
    if (s.appliance === 'sink') {
      g.add(box([0.5, 0.004, 0.4], [xc, ch + 0.001, 0.02], steel));
      g.add(tube([[xc + 0.18, ch, -D / 2 + 0.08], [xc + 0.18, ch + 0.32, -D / 2 + 0.1], [xc + 0.18, ch + 0.3, -D / 2 + 0.26], [xc + 0.18, ch + 0.2, -D / 2 + 0.28]], 0.012, steel, 16));
    }
    // wall units and the light strip under them
    g.add(box([s.width, H - ub, ud], [xc, (ub + H) / 2, -D / 2 + ud / 2], body));
    fronts(x0, x1, ub, H, -D / 2 + ud + 0.009, Math.max(1, Math.round(s.width / 0.5)));
    const strip = box([s.width - 0.04, 0.008, 0.02], [xc, ub - 0.004, -D / 2 + ud - 0.04], led);
    strip.castShadow = false;
    g.add(strip);
  }
};

/** Tall wooden bar stool: dished round seat, four splayed legs, metal foot ring. colors: body, ring */
const barStool: Builder = (it, g) => {
  const [W, H] = it.size;
  const wood = finish('wood', col(it, 'body', '#a8673a'));
  const ring = finish('metal', col(it, 'ring', '#6f6a64'));
  const r = W / 2;
  g.add(lathe([[0, H - 0.035], [r * 0.6, H - 0.035], [r, H - 0.03], [r, H - 0.005], [r * 0.95, H], [r * 0.5, H - 0.012], [0, H - 0.012]], wood, 40));
  const top = r * 0.55, foot = r * 1.15;
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2, c = Math.cos(a), s = Math.sin(a);
    g.add(tube([[c * top, H - 0.035, s * top], [c * foot, 0, s * foot]], 0.018, wood, 4));
  }
  const ry = H * 0.4, rr = top + (foot - top) * (1 - ry / (H - 0.035));
  const torus = mesh(new THREE.TorusGeometry(rr, 0.009, 8, 48), ring);
  torus.rotation.x = Math.PI / 2;
  torus.position.y = ry;
  g.add(torus);
};

/**
 * Rectangular dining table: top, apron, tapered legs. params: top (thickness)
 * colors: body, split (a second table butted against the first: the +x half in another tone)
 */
const diningTable: Builder = (it, g) => {
  const [W, H, D] = it.size;
  const t = num(it, 'top', 0.03);
  const wood = finish('wood', col(it, 'body', '#5e3a22'));
  const split = it.colors?.split;
  if (split) {
    g.add(box([W / 2 - 0.002, t, D], [-W / 4, H - t / 2, 0], wood));
    g.add(box([W / 2 - 0.002, t, D], [W / 4, H - t / 2, 0], finish('wood', split)));
  } else g.add(box([W, t, D], [0, H - t / 2, 0], wood));
  const ah = 0.08, ins = 0.06;
  for (const s of [-1, 1]) {
    g.add(box([W - 2 * ins, ah, 0.02], [0, H - t - ah / 2, s * (D / 2 - ins)], wood));
    g.add(box([0.02, ah, D - 2 * ins], [s * (W / 2 - ins), H - t - ah / 2, 0], wood));
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    g.add(cylinder(0.025, H - t, [sx * (W / 2 - ins - 0.01), (H - t) / 2, sz * (D / 2 - ins - 0.01)], wood, 12, 0.017));
  }
};

/**
 * Danish dining chair: rear legs that sweep up and back into the back posts, a bowed top rail and a
 * lower back rail, tapered front legs, upholstered seat. params: seatHeight   colors: frame, seat
 */
const diningChair: Builder = (it, g) => {
  const [W, H, D] = it.size;
  const sh = num(it, 'seatHeight', 0.45);
  const wood = finish('wood', col(it, 'frame', '#b06a3a'));
  const seat = finish('leather', col(it, 'seat', '#a85a32'));
  const fx = W / 2 - 0.035, fz = D / 2 - 0.04;
  for (const s of [-1, 1]) {
    g.add(cylinder(0.018, sh - 0.04, [s * fx, (sh - 0.04) / 2, fz], wood, 10, 0.013));
    g.add(tube([[s * (fx - 0.01), 0, -D / 2 + 0.02], [s * (fx - 0.005), sh - 0.05, -D / 2 + 0.07], [s * (fx - 0.03), sh + 0.2, -D / 2 + 0.03], [s * (fx - 0.05), H, -D / 2 - 0.02]], 0.016, wood, 16));
    g.add(box([0.02, 0.05, D - 0.1], [s * (fx - 0.005), sh - 0.07, 0.01], wood));
  }
  g.add(box([2 * fx, 0.05, 0.02], [0, sh - 0.07, fz], wood));
  const rail = (y: number, z: number, bow: number, r: number) =>
    g.add(tube([[-(fx - 0.04), y, z], [0, y + 0.01, z - bow], [fx - 0.04, y, z]], r, wood, 16));
  rail(H - 0.035, -D / 2 - 0.01, 0.05, 0.022);
  rail(sh + 0.17, -D / 2 + 0.04, 0.04, 0.012);
  g.add(cushion([W - 0.03, 0.06, D - 0.05], [0, sh - 0.03, 0.01], 0.02, seat));
};

/** Pendant: domed shade on a cord from the ceiling; elevation = shade rim height. params: ceiling   colors: shade, inner */
const pendant: Builder = (it, g) => {
  const [W, H] = it.size;
  const drop = num(it, 'ceiling', 2.76) - (it.elevation ?? 0);
  const r = W / 2;
  const shadeMat = finish('satin', col(it, 'shade', '#151515'));
  shadeMat.side = THREE.DoubleSide;
  g.add(lathe([[r, 0], [r * 0.93, H * 0.35], [r * 0.6, H * 0.75], [r * 0.25, H * 0.95], [0.012, H]], shadeMat, 40));
  const bulb = mesh(new THREE.SphereGeometry(r * 0.3, 16, 12), finish('glow', col(it, 'inner', '#fff2d6')));
  bulb.position.y = H * 0.35;
  bulb.castShadow = false;
  g.add(bulb);
  g.add(cylinder(0.003, drop - H, [0, H + (drop - H) / 2, 0], finish('matte', '#111111'), 6));
  g.add(cylinder(0.045, 0.015, [0, drop - 0.0075, 0], shadeMat, 24));
};

/**
 * Floor lamp: weighted base, a pole that hooks over at the top, and a drum shade hanging from it.
 * size = [shade diameter, height, shade diameter]. params: baseDiameter, shadeHeight   colors: shade, metal
 */
const floorLamp: Builder = (it, g) => {
  const [W, H] = it.size;
  const metal = finish('metal', col(it, 'metal', '#2b2622'));
  const bd = num(it, 'baseDiameter', 0.28), sh = num(it, 'shadeHeight', 0.3);
  g.add(cylinder(bd / 2, 0.025, [0, 0.0125, 0], metal, 32, bd / 2 + 0.005));
  g.add(tube([[0, 0.02, 0], [0, H - 0.25, 0], [0, H - 0.06, 0.02], [0, H, 0.1], [0, H - 0.06, 0.16]], 0.011, metal, 24));
  const shadeMat = finish('fabric', col(it, 'shade', '#ebe1c8'));
  shadeMat.side = THREE.DoubleSide;
  const shade = lathe([[W / 2, 0], [W / 2 - 0.035, sh]], shadeMat, 40);
  shade.position.set(0, H - 0.08 - sh, 0.16);
  g.add(shade);
  const bulb = mesh(new THREE.SphereGeometry(0.035, 12, 8), finish('glow', '#fff2d6'));
  bulb.position.set(0, H - 0.08 - sh * 0.5, 0.16);
  bulb.castShadow = false;
  g.add(bulb);
};

const BUILDERS: Record<FurnitureType, Builder> = {
  sofa, sideboard, tv, rug, sideTable, beanBag, speaker,
  kitchenIsland, kitchenRun, barStool, diningTable, diningChair, pendant, floorLamp,
};

export function buildItem(it: FurnitureItem): THREE.Group {
  const g = new THREE.Group();
  g.name = `furniture:${it.type}:${it.id}`;
  BUILDERS[it.type](it, g);
  g.position.set(it.at[0], it.elevation ?? 0, it.at[1]);
  g.rotation.y = THREE.MathUtils.degToRad(it.rotY ?? 0);
  g.userData.furniture = it; // the data stays queryable on the object (digital twin)
  return g;
}

export function buildFurniture(items: FurnitureItem[]): THREE.Group {
  const g = new THREE.Group();
  g.name = 'furniture';
  for (const it of items) g.add(buildItem(it));
  return g;
}

export type { FurnitureFile, FurnitureItem } from './types';
