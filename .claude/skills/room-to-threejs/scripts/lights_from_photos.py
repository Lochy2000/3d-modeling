#!/usr/bin/env python3
"""Find ceiling light fixtures (pot lights, flush mounts) from a House Capture bundle:
detect saturated blobs in upward-facing photos, cast a ray from each photo's pose,
intersect the ceiling (or a soffit), and cluster hits seen from 2+ photos.

usage: lights_from_photos.py <bundle> <room.json> --ceiling 2.20 [--soffit 1.97 --soffits="x0,x1,z0,z1;..."]
Hits outside the room are usually window glare; check against the floor polygon.
"""
import sys as _sys; _sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # Windows consoles default to cp1252
import argparse, json, numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('bundle'); ap.add_argument('room')
ap.add_argument('--ceiling', type=float, required=True)
ap.add_argument('--soffit', type=float, default=None)
ap.add_argument('--soffits', default='')
a = ap.parse_args()
r = json.load(open(a.room)); W2R = np.array(r['transform']['worldToRoom']).reshape(4, 4).T
soffits = [tuple(map(float, s.split(','))) for s in a.soffits.split(';') if s]
P = json.load(open(f'{a.bundle}/photos/photos.json'))
hits = []
for i, p in enumerate(P):
    T = W2R @ np.array(p['transform']).reshape(4, 4).T
    if -T[1, 2] < 0.15: continue  # not looking up
    im = np.asarray(Image.open(f"{a.bundle}/{p['file']}").convert('L').reduce(4), float)  # sensor orientation = intrinsics
    k = np.array(p['intrinsics']).reshape(3, 3).T / 4; k[2, 2] = 1
    ys, xs = np.nonzero(im >= 250)
    cells = {}
    for y, x in zip(ys, xs): cells.setdefault((y // 6, x // 6), []).append((y, x))
    seen = set()
    for c0 in cells:
        if c0 in seen: continue
        stack, pts = [c0], []
        while stack:
            c = stack.pop()
            if c in seen or c not in cells: continue
            seen.add(c); pts += cells[c]
            stack += [(c[0] + dy, c[1] + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]
        if not (8 < len(pts) < 3000): continue
        v, u = np.mean(pts, 0)
        d = T[:3, :3] @ np.array([(u - k[0, 2]) / k[0, 0], -(v - k[1, 2]) / k[1, 1], -1.0]); o = T[:3, 3]
        if d[1] <= 0.05: continue
        for h in ([a.ceiling] + ([a.soffit] if a.soffit else [])):
            t = (h - o[1]) / d[1]; x, z = o[0] + d[0] * t, o[2] + d[2] * t
            inside = any(x0 <= x <= x1 and z0 <= z <= z1 for x0, x1, z0, z1 in soffits)
            if (h == a.soffit) == inside: hits.append((x, z, h, i)); break
H = np.array([(h[0], h[1]) for h in hits]); used = np.zeros(len(H), bool)
print(f'{len(hits)} bright-spot hits')
for i in range(len(H)):
    if used[i]: continue
    m = (np.linalg.norm(H - H[i], axis=1) < 0.3) & ~used
    for _ in range(3):
        c = H[m].mean(0); m = (np.linalg.norm(H - c, axis=1) < 0.3) & ~used
    used |= m
    photos = {hits[j][3] for j in np.nonzero(m)[0]}
    if len(photos) >= 2:
        print(f'light at ({c[0]:.2f}, {c[1]:.2f}) y={hits[np.nonzero(m)[0][0]][2]}  seen in {len(photos)} photos, spread {H[m].std(0).max():.2f} m')
