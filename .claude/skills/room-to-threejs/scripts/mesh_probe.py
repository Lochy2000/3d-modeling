#!/usr/bin/env python3
"""Measure the reconstructed scan inside a box (room coordinates).

usage: mesh_probe.py <scan_room.ply> x0 x1 y0 y1 z0 z1 [--slices]
Prints point count, tight extents, percentiles, and (with --slices) a height profile:
for each 5 cm height band, the x/z extents of the surface there. Use it to get exact
furniture dimensions: e.g. desk top height = the dense band of up-facing points.
"""
import sys as _sys; _sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # Windows consoles default to cp1252
import sys, numpy as np, open3d as o3d
path, *rest = sys.argv[1:]
x0, x1, y0, y1, z0, z1 = map(float, rest[:6])
m = o3d.io.read_triangle_mesh(path)
m.compute_vertex_normals()
V = np.asarray(m.vertices); N = np.asarray(m.vertex_normals)
k = (V[:, 0] >= x0) & (V[:, 0] <= x1) & (V[:, 1] >= y0) & (V[:, 1] <= y1) & (V[:, 2] >= z0) & (V[:, 2] <= z1)
P, Q = V[k], N[k]
print(f'{len(P)} vertices in box')
if len(P):
    for i, a in enumerate('xyz'):
        lo, p5, p50, p95, hi = np.percentile(P[:, i], [0, 5, 50, 95, 100])
        print(f'  {a}: min {lo:.3f}  p5 {p5:.3f}  median {p50:.3f}  p95 {p95:.3f}  max {hi:.3f}')
    up = P[Q[:, 1] > 0.85]
    if len(up):
        h, e = np.histogram(up[:, 1], bins=np.arange(y0, y1 + 0.02, 0.02))
        top = np.argsort(h)[::-1][:4]
        print('  up-facing surfaces at y ≈ ' + ', '.join(f'{e[t] + 0.01:.2f} ({h[t]} pts)' for t in top if h[t]))
    if '--slices' in rest:
        for b in np.arange(y0, y1, 0.05):
            s = P[(P[:, 1] >= b) & (P[:, 1] < b + 0.05)]
            if len(s) > 10:
                print(f'  y {b:.2f}-{b + 0.05:.2f}: x {np.percentile(s[:, 0], 2):.2f}..{np.percentile(s[:, 0], 98):.2f}  z {np.percentile(s[:, 2], 2):.2f}..{np.percentile(s[:, 2], 98):.2f}  ({len(s)})')
