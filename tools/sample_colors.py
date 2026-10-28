#!/usr/bin/env python3
"""Fill furniture colours from the capture photos (no guessing, no tokens).

For every item in a furniture.json with a `sample` list, points on the named surface are projected
into the photos that see them best: in frame, close, facing the camera, and not hidden behind other
geometry (ray cast against the scan mesh). The median pixel colour over all those views is written
back into the item's `colors`.

Photos include the room's lighting and the camera's exposure and white balance. Each photo is
calibrated against the white walls it sees (projected the same way): pixel / wall pixel * wall
albedo, in linear light. The result approximates the material's own colour, which the renderer
then lights again.

usage: sample_colors.py <furniture.json> <room.json> <scan_room.ply> <photo dir> [--dry-run] [--views 8]
"""
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import open3d as o3d
from PIL import Image

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

WALL_ALBEDO = np.array([0xeb, 0xe9, 0xe4]) / 255  # white emulsion, sRGB


def lin(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def wall_points(room):
    """Points on the painted walls (above furniture, clear of openings)."""
    pts = []
    for w in room['walls']:
        o, u, n = map(np.array, (w['origin'], w['u'], w['n']))
        for a in np.arange(0.2, w['length'] - 0.2, 0.3):
            if any(op['u0'] - 0.1 < a < op['u1'] + 0.1 for op in w['openings']):
                continue
            for v in (1.5, 1.9, 2.3):
                pts.append(o + u * a + np.array([0, v, 0]) + n * 0.01)
    return np.array(pts)


def surfaces(it):
    """Sample points per colour name, in the item's local frame: (points Nx3, normal)."""
    W, H, D = it['size']
    p = it.get('params', {})
    grid = lambda xs, zs, y: np.array([[x, y, z] for x in xs for z in zs])
    t = it['type']
    if t == 'sofa':
        arm, seat = p.get('armWidth', 0.16), p.get('seatHeight', 0.45)
        inner = W / 2 - arm - 0.1
        # seat cushion tops (front half, clear of the pillows) and the outer faces of the arms
        out = {'body': [(grid(np.linspace(-inner, inner, 7), [0.1 * D, 0.25 * D], seat), (0, 1, 0)),
                        (np.array([[W / 2, y, z] for y in (0.3, 0.5) for z in (-0.2, 0.0, 0.2)]), (1, 0, 0)),
                        (np.array([[-W / 2, y, z] for y in (0.3, 0.5) for z in (-0.2, 0.0, 0.2)]), (-1, 0, 0))]}
    elif t == 'sideboard':
        out = {'body': [(np.array([[x, y, D / 2 + 0.01] for x in np.linspace(-0.4 * W, 0.4 * W, 7)
                                   for y in np.linspace(0.35 * H, 0.75 * H, 3)]), (0, 0, 1)),
                        (grid(np.linspace(-0.45 * W, 0.45 * W, 9), [0.3 * D, 0.42 * D], H + 0.005), (0, 1, 0))]}
    elif t == 'rug':
        out = {'field': [(grid(np.linspace(-0.3 * W, 0.3 * W, 6), np.linspace(-0.3 * D, 0.3 * D, 4), 0.01), (0, 1, 0))]}
    elif t == 'diningTable':
        # table top; with a `split` colour the two butted tables are sampled separately (-x / +x half)
        top = lambda x0, x1: [(grid(np.linspace(x0, x1, 5), np.linspace(-0.35 * D, 0.35 * D, 4), H + 0.002), (0, 1, 0))]
        out = {'body': top(-0.45 * W, -0.05 * W), 'split': top(0.05 * W, 0.45 * W)}
    elif t == 'diningChair':
        out = {'seat': [(grid(np.linspace(-0.25 * W, 0.25 * W, 3), np.linspace(-0.15 * D, 0.25 * D, 3), p.get('seatHeight', 0.45) + 0.005), (0, 1, 0))]}
    elif t == 'beanBag':
        out = {'body': [(grid(np.linspace(-0.25 * W, 0.25 * W, 3), np.linspace(-0.25 * D, 0.25 * D, 3), 0.8 * H), (0, 1, 0))]}
    else:
        out = {}
    return out


def project(ph, P):
    """Image fractions (sx, sy in -1..1), depth along the view and distance for points P (Nx3)."""
    pos, f, up = map(np.array, (ph['position'], ph['forward'], ph['up']))
    right = np.cross(f, up)
    V = P - pos
    d = V @ f
    th = math.tan(math.radians(ph['fovY'] / 2))
    with np.errstate(divide='ignore', invalid='ignore'):
        sx, sy = (V @ right) / d / (th * ph['aspect']), (V @ up) / d / th
    return sx, sy, d, np.linalg.norm(V, axis=1)


def visible(scene, ph, P, dist):
    pos = np.array(ph['position'])
    rays = np.hstack([np.repeat(pos[None], len(P), 0), (P - pos) / dist[:, None]]).astype(np.float32)
    t = scene.cast_rays(o3d.core.Tensor(rays))['t_hit'].numpy()
    return t >= dist - 0.06


def pixel(img, sx, sy):
    h, w = img.shape[:2]
    px, py = int((sx + 1) / 2 * w), int((1 - sy) / 2 * h)
    return np.median(img[max(0, py - 3):py + 4, max(0, px - 3):px + 4].reshape(-1, 3), 0) / 255


def to_room(it, pts, normal):
    a = math.radians(it.get('rotY', 0))
    c, s = math.cos(a), math.sin(a)
    R = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])  # rotation about +y (three.js convention)
    off = np.array([it['at'][0], it.get('elevation', 0), it['at'][1]])
    return pts @ R.T + off, R @ np.array(normal, float)


def dumps(data):
    """Indented JSON with short lists and small objects kept on one line, so the file stays hand-editable."""
    text = json.dumps(data, indent=2, ensure_ascii=False)
    one_line = lambda m: re.sub(r'\s*\n\s*', ' ', m.group(0)).replace('[ ', '[').replace(' ]', ']')
    text = re.sub(r'\[[^\[\]{}]*\]', one_line, text)          # flat lists
    return re.sub(r'\{[^\[\]{}]{0,140}\}', one_line, text)   # small flat objects


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) != 4:
        sys.exit(__doc__)
    fpath, rpath, mesh_path, photo_dir = map(Path, args)
    views = int(sys.argv[sys.argv.index('--views') + 1]) if '--views' in sys.argv else 8
    data = json.loads(fpath.read_text(encoding='utf-8'))
    photos = json.loads(rpath.read_text(encoding='utf-8'))['photos']

    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(o3d.io.read_triangle_mesh(str(mesh_path))))
    cache, white = {}, {}
    walls = wall_points(json.loads(rpath.read_text(encoding='utf-8')))

    def image(i):
        if i not in cache:
            cache[i] = np.asarray(Image.open(photo_dir / f'{i:04d}.jpg').convert('RGB'))
        return cache[i]

    def wall_white(i):
        """Linear RGB of the white walls in photo i (None if it sees too little wall)."""
        if i not in white:
            sx, sy, d, dist = project(photos[i], walls)
            k = (d > 0.3) & (np.abs(sx) < 0.95) & (np.abs(sy) < 0.95)
            k[k] = visible(scene, photos[i], walls[k], dist[k])
            px = [pixel(image(i), a, b) for a, b in zip(sx[k], sy[k])]
            white[i] = lin(np.median(px, 0)) if len(px) >= 8 else None
        return white[i]

    for it in data['items']:
        for name in it.get('sample', []):
            parts = surfaces(it).get(name)
            if not parts:
                print(f'{it["id"]}.{name}: no sample surface defined for type {it["type"]}')
                continue
            pixels, used = [], set()
            for pts, nrm in parts:
                P, n = to_room(it, pts, nrm)
                for p in P:
                    cands = []
                    for i, ph in enumerate(photos):
                        sx, sy, d, dist = (a[0] for a in project(ph, p[None]))
                        if d < 0.3 or dist > 4 or abs(sx) > 0.9 or abs(sy) > 0.9:
                            continue
                        facing = -float(np.dot((p - np.array(ph['position'])) / dist, n))
                        if facing < 0.25:
                            continue
                        cands.append((dist / facing * (1 + 0.5 * (sx * sx + sy * sy)), i, sx, sy, dist))
                    cands.sort()
                    cands = cands[:views * 3]
                    if not cands:
                        continue
                    taken = 0
                    for score, i, sx, sy, dist in cands:
                        ph = photos[i]
                        if not visible(scene, ph, p[None], np.array([dist]))[0]:
                            continue
                        wh = wall_white(i)
                        if wh is None:
                            continue
                        pixels.append(lin(pixel(image(i), sx, sy)) / wh * lin(WALL_ALBEDO))
                        used.add(i)
                        taken += 1
                        if taken >= views:
                            break
            if not pixels:
                print(f'{it["id"]}.{name}: no unobstructed views')
                continue
            px = np.array(pixels)
            # Things the scan missed (cables, a monitor, a white table) can sit in front of a surface.
            # When most samples are coloured, drop the near-grey ones before taking the median.
            sat = (px.max(1) - px.min(1)) / np.maximum(px.max(1), 1e-6)
            if (sat > 0.3).mean() > 0.5:
                px = px[sat > 0.3]
            rgb = (srgb(np.median(px, 0)) * 255).round().astype(int)
            hexc = '#%02x%02x%02x' % tuple(rgb)
            old = it.setdefault('colors', {}).get(name)
            it['colors'][name] = hexc
            print(f'{it["id"]}.{name}: {old} -> {hexc}  ({len(pixels)} samples, {len(used)} photos: {sorted(used)[:12]})')

    if '--dry-run' not in sys.argv:
        fpath.write_text(dumps(data) + '\n', encoding='utf-8')
        print(f'wrote {fpath}')


if __name__ == '__main__':
    main()
