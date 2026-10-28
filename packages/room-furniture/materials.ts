import * as THREE from 'three';
import { mulberry32, textured } from '../room-runtime/materials';

// Materials by finish + colour, shared between items so equal colours batch together.
const cache = new Map<string, THREE.Material>();

// The oak texture is brown itself (mean sRGB 161,126,87) and multiplies the colour; divide it out so
// a wood item averages the colour sampled from the photos while keeping the grain.
const OAK_MEAN = [161, 126, 87];
function unTint(color: string, mean: number[]) {
  const c = new THREE.Color(color);
  const lin = mean.map(v => new THREE.Color().setRGB(v / 255, v / 255, v / 255, THREE.SRGBColorSpace).r);
  return new THREE.Color(Math.min(1, c.r / lin[0]), Math.min(1, c.g / lin[1]), Math.min(1, c.b / lin[2])).getStyle();
}

export type Finish = 'leather' | 'wood' | 'fabric' | 'matte' | 'satin' | 'gloss' | 'stone' | 'metal' | 'glass' | 'screen' | 'glow';

export function finish(kind: Finish, color: string): THREE.Material {
  const key = `${kind}:${color}`;
  let m = cache.get(key);
  if (m) return m;
  switch (kind) {
    case 'leather': m = textured({ color, set: 'leather', repeat: 1.5, roughness: 0.75, normalScale: 0.6 }); break;
    case 'wood': m = textured({ color: unTint(color, OAK_MEAN), set: 'oak', repeat: 1.2, roughness: 0.55 }); break;
    case 'fabric': m = textured({ color, set: 'linen', repeat: 3, normalScale: 1.2 }); break;
    case 'matte': m = new THREE.MeshStandardMaterial({ color, roughness: 0.85 }); break;
    case 'satin': m = new THREE.MeshStandardMaterial({ color, roughness: 0.45 }); break;
    case 'gloss': m = new THREE.MeshStandardMaterial({ color, roughness: 0.25, metalness: 0.05 }); break;
    case 'stone': m = new THREE.MeshStandardMaterial({ color, roughness: 0.22 }); break;
    case 'metal': m = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.7 }); break;
    case 'glass':
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.25, depthWrite: false });
      break;
    case 'screen': m = new THREE.MeshStandardMaterial({ color, roughness: 0.08, metalness: 0.3 }); break;
    case 'glow': m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5, roughness: 1 }); break;
  }
  cache.set(key, m);
  return m;
}

function canvas(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * Persian rug: dense floral field, a scalloped central medallion with pendants, corner spandrels, a
 * main border of rosettes between guard stripes, and a little wear noise so it reads as woven.
 * Drawn once per rug; the texture spans the whole rug (no tiling).
 */
export function persianRug(width: number, depth: number, colors: { field: string; border: string; accent: string; light: string }, seed = 7) {
  const ppm = 320;
  const W = Math.round(width * ppm), H = Math.round(depth * ppm);
  const map = canvas(W, H, ctx => {
    const rand = mulberry32(seed);
    const { field, border, accent, light } = colors;
    const band = Math.min(W, H) * 0.12;
    const blob = (x: number, y: number, r: number, c: string, petals = 6, rot = 0) => {
      ctx.fillStyle = c;
      for (let k = 0; k < petals; k++) {
        const a = rot + (k / petals) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.42, r * 0.2, a, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    const dot = (x: number, y: number, r: number, c: string) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    const frame = (inset: number, c: string, w: number) => {
      ctx.strokeStyle = c;
      ctx.lineWidth = w;
      ctx.strokeRect(inset, inset, W - 2 * inset, H - 2 * inset);
    };

    // border: dark ground, guard stripes, a vine line and rosettes
    ctx.fillStyle = border;
    ctx.fillRect(0, 0, W, H);
    frame(band * 0.08, field, band * 0.07);
    frame(band * 0.2, light, band * 0.03);
    frame(band * 0.8, light, band * 0.03);
    frame(band * 0.92, field, band * 0.07);
    const mid = band * 0.5, step = band * 0.72;
    frame(mid, accent, band * 0.035);
    let n = 0;
    const rosette = (x: number, y: number) => {
      blob(x, y, band * 0.24, n % 2 ? field : light, 8);
      dot(x, y, band * 0.07, n % 2 ? accent : field);
    };
    for (let x = step / 2; x < W; x += step, n++) { rosette(x, mid); rosette(x, H - mid); }
    for (let y = step / 2; y < H; y += step, n++) { rosette(mid, y); rosette(W - mid, y); }

    // field: dense small florals and arabesques
    ctx.fillStyle = field;
    ctx.fillRect(band, band, W - 2 * band, H - 2 * band);
    ctx.save();
    ctx.beginPath();
    ctx.rect(band, band, W - 2 * band, H - 2 * band);
    ctx.clip();
    const palette = [border, accent, light, border, '#5a6e8c'];
    const cell = band * 0.24;
    for (let y = band; y < H - band + cell; y += cell) {
      for (let x = band + (Math.round(y / cell) % 2) * cell * 0.5; x < W - band + cell; x += cell) {
        const c = palette[Math.floor(rand() * palette.length)];
        ctx.globalAlpha = 0.45 + rand() * 0.35;
        if (rand() < 0.5) blob(x, y, cell * (0.28 + rand() * 0.12), c, 4 + Math.floor(rand() * 3) * 2, rand() * Math.PI);
        else {
          ctx.strokeStyle = c;
          ctx.lineWidth = cell * 0.06;
          ctx.beginPath();
          ctx.moveTo(x - cell * 0.35, y + cell * 0.2);
          ctx.quadraticCurveTo(x, y - cell * 0.4, x + cell * 0.35, y + cell * 0.2);
          ctx.stroke();
          dot(x, y - cell * 0.1, cell * 0.08, c);
        }
      }
    }
    ctx.globalAlpha = 1;

    // medallion: scalloped layers stretched along the long axis, with pendants
    const cx = W / 2, cy = H / 2, wide = W > H;
    const mr = Math.min(W, H) * 0.17;
    const [rx, ry] = wide ? [mr * 1.5, mr] : [mr, mr * 1.5];
    const layer = (sx: number, sy: number, c: string) => {
      ctx.fillStyle = c;
      ctx.beginPath();
      for (let k = 0; k <= 96; k++) {
        const a = (k / 96) * Math.PI * 2;
        const sc = 1 + 0.07 * Math.cos(a * 16);
        const x = cx + Math.cos(a) * sx * sc, y = cy + Math.sin(a) * sy * sc;
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.fill();
    };
    layer(rx, ry, border);
    layer(rx * 0.86, ry * 0.86, light);
    layer(rx * 0.72, ry * 0.72, field);
    layer(rx * 0.42, ry * 0.42, border);
    blob(cx, cy, mr * 0.32, accent, 8);
    dot(cx, cy, mr * 0.08, light);
    for (const s of [-1, 1]) {
      const px = wide ? cx + s * rx * 1.18 : cx, py = wide ? cy : cy + s * ry * 1.18;
      blob(px, py, mr * 0.2, border, 6);
      dot(px, py, mr * 0.05, accent);
    }
    // corner spandrels
    for (const [x, y] of [[band, band], [W - band, band], [band, H - band], [W - band, H - band]]) {
      dot(x, y, band * 2.4, border);
      ctx.strokeStyle = light;
      ctx.lineWidth = band * 0.03;
      ctx.beginPath();
      ctx.arc(x, y, band * 2.25, 0, Math.PI * 2);
      ctx.stroke();
      blob(x + (x < cx ? 1 : -1) * band * 1.2, y + (y < cy ? 1 : -1) * band * 1.2, band * 0.4, accent, 8);
    }
    ctx.restore();

    // wear: per-pixel brightness noise and faint pile rows
    const img = ctx.getImageData(0, 0, W, H);
    for (let p = 0; p < img.data.length; p += 4) {
      const k = 1 + (rand() - 0.5) * 0.22 + (Math.floor(p / 4 / W) % 3 === 0 ? -0.04 : 0);
      img.data[p] *= k;
      img.data[p + 1] *= k;
      img.data[p + 2] *= k;
    }
    ctx.putImageData(img, 0, 0);
  });
  return new THREE.MeshStandardMaterial({ map, roughness: 1 });
}

/** Kilim cushion cover: rows of stepped diamonds between zigzag bands on a ground colour. */
export function kilim(ground: string, accent: string, seed = 3) {
  const key = `kilim:${ground}:${accent}:${seed}`;
  let m = cache.get(key);
  if (m) return m;
  const map = canvas(256, 256, ctx => {
    const rand = mulberry32(seed);
    const dark = '#2a1a1e';
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, 256, 256);
    for (let row = 0; row < 4; row++) {
      const y = 32 + row * 64;
      ctx.fillStyle = row % 2 ? accent : dark;
      for (let x = 0; x < 256; x += 16) ctx.fillRect(x, y - 30 + ((x / 16) % 2) * 4, 8, 4);
      for (let x = 32; x < 256; x += 64) {
        const rings: [number, string][] = [[22, row % 2 ? dark : accent], [14, ground], [7, rand() < 0.5 ? accent : '#e8dcc4']];
        for (const [r, c] of rings) {
          ctx.fillStyle = c;
          for (let s = -r; s <= r; s += 4) ctx.fillRect(x - (r - Math.abs(s)), y + s, 2 * (r - Math.abs(s)), 4);
        }
      }
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(2.2, 2.2); // UVs are in meters: one pattern tile per 45 cm cushion
  m = new THREE.MeshStandardMaterial({ map, roughness: 0.95 });
  cache.set(key, m);
  return m;
}
