#!/usr/bin/env python3
"""Generate RoomPlan-style rooms/room-N.json for an Android (ARCore) capture session.

usage: build_room.py <session_dir> [--room N] [--voxel 0.02] [--max-depth 3.0] [--min-confidence 1]

Android has no RoomPlan, so this derives the same structure from the session's ARCore depth:

  1. TSDF-fuse the depth frames (pose + intrinsics from depth/frames.json) → points with normals,
     and recon/room-N-scan.ply (session-world mesh, reference layer for modeling)
  2. floor / ceiling from horizontal-surface height histograms
  3. dominant wall heading (Manhattan) from vertical-surface normals
  4. wall lines from vertical surfaces above furniture height (≈1.5 m to just below the ceiling)
  5. floor outline from 2D free-space carving along camera→surface rays, cut behind detected walls,
     traced and snapped to the wall lines
  6. openings where rays pass through a wall plane and land beyond it (open doors, windows, passages)
  7. furniture boxes from point clusters away from the walls (category "unknown": label from photos)

Writes rooms/room-N.json (RoomPlan Codable shape: walls/doors/windows/openings/objects/floors, column-major
transforms in session world) so 3d-model-anything's bundle_to_room.py / bundle_plan.py work unchanged, plus
recon/room-N-build.json (measurements + confidence) and recon/room-N-build.png (debug plan).

Closed doors and covered windows are not visible to depth and are not detected; add them from photos.
Needs: pip install open3d numpy scipy scikit-image pillow
"""
import argparse
import json
import math
import os
import sys
import time
import uuid
import zlib

import numpy as np
import open3d as o3d
import open3d.core as o3c
from PIL import Image, ImageDraw
from scipy import ndimage
from skimage import measure

CV = np.diag([1.0, -1.0, -1.0, 1.0])  # camera +y up/−z forward → +y down/+z forward
GRID = 0.03  # 2D plan cell size (m)


def mat(cm):
    return np.array(cm, dtype=np.float64).reshape(4, 4).T  # column-major → row-major


def colmajor(m):
    return [round(float(v), 6) for v in np.asarray(m).T.ravel()]


def load_frames(bundle, room, min_conf, max_depth):
    frames = [f for f in json.load(open(os.path.join(bundle, 'depth/frames.json'))) if f['room'] == room]
    out = []
    for f in frames:
        raw = zlib.decompress(open(os.path.join(bundle, f['file']), 'rb').read(), -15)
        d = np.frombuffer(raw, dtype='<f2').astype(np.float32).reshape(f['height'], f['width']).copy()
        cp = os.path.join(bundle, f['confidence'])
        if min_conf > 0 and os.path.exists(cp):
            d[np.fromfile(cp, dtype=np.uint8).reshape(d.shape) < min_conf] = 0
        d[(d > max_depth) | (d < 0.2) | ~np.isfinite(d)] = 0
        out.append((d, np.array(f['intrinsics']).reshape(3, 3).T, mat(f['transform']) @ CV))
    return out


def fuse(frames, voxel, max_depth):
    """TSDF fusion → legacy triangle mesh. (The legacy ScalableTSDFVolume returns an empty mesh in the
    Open3D 0.20 wheels, so this uses the tensor VoxelBlockGrid.)"""
    grid = o3d.t.geometry.VoxelBlockGrid(('tsdf', 'weight'), (o3c.float32, o3c.float32), ((1), (1)), voxel, 16, 80000, o3c.Device('CPU:0'))
    for d, k, c2w in frames:
        if (d > 0).sum() < 200:
            continue  # the grid aborts on frames that touch no blocks
        D = o3d.t.geometry.Image(o3c.Tensor(np.ascontiguousarray(d)))
        K, E = o3c.Tensor(k, o3c.float64), o3c.Tensor(np.linalg.inv(c2w), o3c.float64)
        grid.integrate(grid.compute_unique_block_coordinates(D, K, E, 1.0, max_depth), D, K, E, 1.0, max_depth, 5.0)
    return grid.extract_triangle_mesh().to_legacy()


def rays(frames, every=3, stride=3):
    """Sampled camera centers and surface points (world) for free-space and opening analysis."""
    cams, pts = [], []
    for d, k, c2w in frames[::every]:
        ys, xs = np.mgrid[0:d.shape[0]:stride, 0:d.shape[1]:stride]
        z = d[ys, xs].ravel()
        ok = z > 0
        p = np.c_[(xs.ravel()[ok] - k[0, 2]) * z[ok] / k[0, 0], (ys.ravel()[ok] - k[1, 2]) * z[ok] / k[1, 1], z[ok], np.ones(ok.sum())]
        pts.append((c2w @ p.T).T[:, :3])
        cams.append(np.repeat(c2w[None, :3, 3], ok.sum(), axis=0))
    return np.concatenate(cams), np.concatenate(pts)


def height_peaks(y, lo, hi, bin_=0.01, min_frac=0.05):
    hist, edges = np.histogram(y, bins=np.arange(lo, hi + bin_, bin_))
    hist = ndimage.uniform_filter1d(hist.astype(float), 3)
    peaks = [i for i in range(1, len(hist) - 1) if hist[i] >= hist[i - 1] and hist[i] >= hist[i + 1] and hist[i] >= min_frac * hist.max()]
    return [(edges[i] + bin_ / 2, hist[i]) for i in peaks]


def runs(values, gap, min_len):
    """Contiguous [start, end] runs of sorted 1D samples with gaps < gap."""
    if len(values) == 0:
        return []
    v = np.sort(values)
    breaks = np.where(np.diff(v) > gap)[0]
    starts = np.r_[0, breaks + 1]
    ends = np.r_[breaks, len(v) - 1]
    return [(v[s], v[e]) for s, e in zip(starts, ends) if v[e] - v[s] >= min_len]


def wall_lines(P2, N2, axis):
    """Wall lines perpendicular to `axis` (0 → a = const, 1 → b = const) from high-band vertical points."""
    sel = np.abs(N2[:, axis]) > 0.85
    coord, along, nsign = P2[sel, axis], P2[sel, 1 - axis], np.sign(N2[sel, axis])
    if len(coord) < 50:
        return []
    hist, edges = np.histogram(coord, bins=np.arange(coord.min() - 0.05, coord.max() + 0.05, 0.01))
    hist = ndimage.gaussian_filter1d(hist.astype(float), 2)
    lines = []
    for i in range(1, len(hist) - 1):
        if hist[i] < hist[i - 1] or hist[i] < hist[i + 1] or hist[i] < 0.08 * hist.max():
            continue
        c = edges[i] + 0.005
        near = np.abs(coord - c) < 0.05
        for s in (1, -1):  # the two faces of a thin wall/partition are separate lines
            m = near & (nsign == s)
            if m.sum() < 40:
                continue
            pos = float(np.median(coord[m]))
            for b0, b1 in runs(along[m], 0.35, 0.4):
                support = ((along[m] >= b0) & (along[m] <= b1)).sum()
                lines.append({'axis': axis, 'pos': pos, 'b0': float(b0), 'b1': float(b1), 'sign': int(s), 'support': int(support)})
    # suppress duplicates (same side, within 6 cm, overlapping)
    lines.sort(key=lambda l: -l['support'])
    kept = []
    for l in lines:
        if any(k['sign'] == l['sign'] and abs(k['pos'] - l['pos']) < 0.06 and min(k['b1'], l['b1']) > max(k['b0'], l['b0']) for k in kept):
            continue
        kept.append(l)
    return kept


def carve(cams2, pts2, origin, shape):
    """Count 2D free-space observations along camera→surface rays (stopping 6 cm short of the surface)."""
    free = np.zeros(shape[0] * shape[1], np.int32)
    for s in range(0, len(cams2), 200_000):
        c, p = cams2[s:s + 200_000], pts2[s:s + 200_000]
        d = p - c
        L = np.linalg.norm(d, axis=1)
        n = np.maximum((L - 0.06) / (GRID * 0.7), 0).astype(int)
        idx = np.repeat(np.arange(len(c)), n)
        t = (np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)) / np.maximum(np.repeat(L / (GRID * 0.7), n), 1e-6)
        q = c[idx] + d[idx] * t[:, None]
        ij = np.floor((q - origin) / GRID).astype(int)
        ok = (ij[:, 0] >= 0) & (ij[:, 0] < shape[0]) & (ij[:, 1] >= 0) & (ij[:, 1] < shape[1])
        free += np.bincount(ij[ok, 0] * shape[1] + ij[ok, 1], minlength=free.size).astype(np.int32)
    return free.reshape(shape)


def douglas_peucker(pts, tol):
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    ab = b - a
    L = np.linalg.norm(ab)
    rel = pts - a
    d = np.abs(ab[0] * rel[:, 1] - ab[1] * rel[:, 0]) / L if L > 1e-9 else np.linalg.norm(rel, axis=1)
    i = int(np.argmax(d))
    if d[i] > tol:
        return np.vstack([douglas_peucker(pts[:i + 1], tol)[:-1], douglas_peucker(pts[i:], tol)])
    return np.vstack([a, b])


def snap_polygon(poly, lines, min_step=0.2, merge_tol=0.15):
    """Regularize a traced outline into walls: axis-align edges (Manhattan; long diagonals survive), merge
    near-collinear runs, drop steps shorter than min_step, and move edges onto detected wall lines."""
    edges = []
    for i in range(len(poly)):
        p, q = poly[i], poly[(i + 1) % len(poly)]
        d = q - p
        L = float(np.linalg.norm(d))
        if L < 1e-6:
            continue
        ang = math.degrees(math.atan2(d[1], d[0])) % 180
        off_a, off_b = min(ang, 180 - ang), abs(ang - 90)
        if min(off_a, off_b) > 30 and L > 1.0:
            nrm = np.array([-d[1], d[0]]) / L
            edges.append({'n': nrm, 'val': float(nrm @ p), 'w': L, 'mid': (p + q) / 2, 'axis': None})
            continue
        axis = 1 if off_a <= off_b else 0  # 1: runs along a (b = const); 0: runs along b (a = const)
        edges.append({'n': np.eye(2)[axis], 'val': float((p[axis] + q[axis]) / 2), 'w': L, 'mid': (p + q) / 2, 'axis': axis})

    def corners_of(es):
        out = []
        for i, e in enumerate(es):
            prev = es[i - 1]
            A = np.array([prev['n'], e['n']])
            if abs(np.linalg.det(A)) > 1e-3:
                out.append(np.linalg.solve(A, [prev['val'], e['val']]))
            else:  # parallel neighbours (a step): perpendicular connector midway between their midpoints
                m = (prev['mid'] + e['mid']) / 2
                out.append(m - prev['n'] * (prev['n'] @ m - prev['val']))
                out.append(m - e['n'] * (e['n'] @ m - e['val']))
        return out

    def merge(e1, e2):
        w = e1['w'] + e2['w']
        return {**e1, 'val': (e1['val'] * e1['w'] + e2['val'] * e2['w']) / w, 'w': w, 'mid': (e1['mid'] * e1['w'] + e2['mid'] * e2['w']) / w}

    def lengths(es):
        # length of edge i = distance between its start corner and the next edge's start corner
        out = []
        for i, e in enumerate(es):
            prev, nxt = es[i - 1], es[(i + 1) % len(es)]
            A1, A2 = np.array([prev['n'], e['n']]), np.array([e['n'], nxt['n']])
            if abs(np.linalg.det(A1)) < 1e-3 or abs(np.linalg.det(A2)) < 1e-3:
                out.append(0.0)  # parallel neighbour: this edge is (part of) a step
                continue
            out.append(float(np.linalg.norm(np.linalg.solve(A2, [e['val'], nxt['val']]) - np.linalg.solve(A1, [prev['val'], e['val']]))))
        return out

    def snap(e):
        if e['axis'] is None:
            return e
        lo_, hi_ = e['mid'][1 - e['axis']] - e['w'] / 2, e['mid'][1 - e['axis']] + e['w'] / 2
        best = None
        for l in lines:
            if l['axis'] != e['axis'] or abs(l['pos'] - e['val']) > 0.4:
                continue
            overlap = min(hi_, l['b1']) - max(lo_, l['b0'])
            if overlap > 0.15 and (best is None or overlap - abs(l['pos'] - e['val']) > best[0]):
                best = (overlap - abs(l['pos'] - e['val']), l)
        return {**e, 'val': best[1]['pos'], 'line': best[1]} if best else {**e, 'line': None}

    for _ in range(60):
        changed = False
        # merge neighbours on (nearly) the same line
        i = 0
        while len(edges) > 3 and i < len(edges):
            a, b = edges[i], edges[(i + 1) % len(edges)]
            if a['axis'] is not None and a['axis'] == b['axis'] and abs(a['val'] - b['val']) < merge_tol:
                edges[i] = merge(a, b)
                del edges[(i + 1) % len(edges)]
                changed = True
            else:
                i += 1
        # remove short edges: a perpendicular jog between two parallel edges, or a tiny sliver
        L = lengths(edges)
        for i in sorted(range(len(edges)), key=lambda k: L[k]):
            if len(edges) <= 4 or L[i] >= min_step:
                break
            prev, nxt = edges[i - 1], edges[(i + 1) % len(edges)]
            if prev['axis'] is not None and prev['axis'] == nxt['axis'] and edges[i]['axis'] != prev['axis']:
                del edges[i]
                changed = True
                break
            if L[i] < 0.08:
                del edges[i]
                changed = True
                break
        if not changed:
            break

    edges = [snap(e) for e in edges]
    for _ in range(10):  # snapping can make neighbours collinear
        i, changed = 0, False
        while len(edges) > 3 and i < len(edges):
            a, b = edges[i], edges[(i + 1) % len(edges)]
            if a['axis'] is not None and a['axis'] == b['axis'] and abs(a['val'] - b['val']) < 0.05:
                edges[i] = {**merge(a, b), 'line': a.get('line') or b.get('line')}
                del edges[(i + 1) % len(edges)]
                changed = True
            else:
                i += 1
        if not changed:
            break

    out = []
    for c in corners_of(edges):
        if not out or np.linalg.norm(c - out[-1]) > 0.03:
            out.append(c)
    if len(out) > 1 and np.linalg.norm(out[0] - out[-1]) < 0.03:
        out.pop()
    return np.array(out), edges


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('bundle')
    ap.add_argument('--room', type=int, default=0)
    ap.add_argument('--voxel', type=float, default=0.02)
    ap.add_argument('--max-depth', type=float, default=3.0, help='ARCore depth-from-motion degrades with distance')
    ap.add_argument('--min-confidence', type=int, default=1, help='0–2; 1 keeps ARCore smoothed depth backed by raw depth')
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    t0 = time.time()
    B, R = a.bundle, a.room
    os.makedirs(os.path.join(B, 'recon'), exist_ok=True)

    # --- 1. fuse -----------------------------------------------------------------------------
    frames = load_frames(B, R, a.min_confidence, a.max_depth)
    if not frames:
        ap.error(f'no depth frames for room {R}')
    mesh = fuse(frames, a.voxel, a.max_depth)
    clusters, counts, _ = mesh.cluster_connected_triangles()
    mesh.remove_triangles_by_mask(np.asarray(counts)[np.asarray(clusters)] < 200)
    mesh.remove_unreferenced_vertices()
    mesh.compute_vertex_normals()
    o3d.io.write_triangle_mesh(os.path.join(B, f'recon/room-{R}-scan.ply'), mesh)
    P = np.asarray(mesh.vertices)
    N = np.asarray(mesh.vertex_normals)
    cam_pos = np.array([c[:3, 3] for _, _, c in frames])
    # TSDF normals face the observed (free) side; make sure they point towards the cameras
    if np.mean(np.sum(N * (cam_pos.mean(0) - P), axis=1) > 0) < 0.5:
        N = -N
    print(f'fused {len(frames)} depth frames → {len(mesh.triangles):,} triangles, {len(P):,} vertices ({time.time() - t0:.0f}s)')

    # --- 2. floor / ceiling ------------------------------------------------------------------------
    up, down = N[:, 1] > 0.9, N[:, 1] < -0.9
    cam_y = float(np.median(cam_pos[:, 1]))
    floor_peaks = height_peaks(P[up, 1], cam_y - 2.5, cam_y - 0.5)
    floorY = floor_peaks[0][0] if floor_peaks else float(np.percentile(P[up, 1], 2))
    ceil_peaks = height_peaks(P[down, 1], cam_y + 0.3, cam_y + 3.0, min_frac=0.15)
    ceilY = ceil_peaks[-1][0] if ceil_peaks else None
    height = (ceilY - floorY) if ceilY else float(np.percentile(P[:, 1], 99.5) - floorY)
    ceiling_measured = ceilY is not None and 1.9 < height < 4.5
    if not ceiling_measured:
        height = max(2.2, min(height, 3.2))
    print(f'floor y={floorY:.3f}, ceiling {"measured" if ceiling_measured else "estimated"} {height:.2f} m above floor, camera ~{cam_y - floorY:.2f} m')

    # --- 3. heading ------------------------------------------------------------------------------
    vert = np.abs(N[:, 1]) < 0.3
    ang = np.arctan2(N[vert, 2], N[vert, 0]) * 4
    theta = math.atan2(np.sin(ang).sum(), np.cos(ang).sum()) / 4  # walls face theta + k·90°
    ca, sa = math.cos(theta), math.sin(theta)
    to2 = lambda X: np.c_[X[:, 0] * ca + X[:, 2] * sa, -X[:, 0] * sa + X[:, 2] * ca]  # world x/z → plan (a, b)
    from2 = lambda A: np.c_[A[:, 0] * ca - A[:, 1] * sa, A[:, 0] * sa + A[:, 1] * ca]  # plan → world x/z

    # --- 4. wall lines ---------------------------------------------------------------------------
    band = vert & (P[:, 1] > floorY + 1.5) & (P[:, 1] < floorY + height - 0.12)
    P2, N2 = to2(P[band]), to2(N[band])
    lines = wall_lines(P2, N2, 0) + wall_lines(P2, N2, 1)
    print(f'{len(lines)} wall line segments from {band.sum():,} high vertical points')

    # --- 5. outline --------------------------------------------------------------------------------
    cams, pts = rays(frames)
    cams2, pts2 = to2(cams), to2(pts)
    lo = np.minimum(cams2.min(0), pts2.min(0)) - 0.3
    hi = np.maximum(cams2.max(0), pts2.max(0)) + 0.3
    shape = tuple(np.ceil((hi - lo) / GRID).astype(int))
    free = carve(cams2, pts2, lo, shape)
    mask = free >= 30  # well-observed free space; single noisy rays don't count
    disk = lambda r: np.hypot(*np.mgrid[-r:r + 1, -r:r + 1]) <= r
    mask = ndimage.binary_opening(mask, structure=disk(int(0.2 / GRID)))  # drop ray spikes through gaps / depth noise
    mask = ndimage.binary_closing(mask, structure=disk(3))
    mask = ndimage.binary_fill_holes(mask)

    def frac(cells_a, cells_b):
        i = np.floor((cells_a - lo[0]) / GRID).astype(int)
        j = np.floor((cells_b - lo[1]) / GRID).astype(int)
        ok = (i >= 0) & (i < shape[0]) & (j >= 0) & (j < shape[1])
        return float(mask[i[ok], j[ok]].sum()) / max(1, len(i))

    # Room walls have free space in front and none behind; tall furniture inside the room has free space
    # on both sides. Keep only boundary lines for snapping.
    boundary = []
    for l in lines:
        if l['b1'] - l['b0'] < 0.5:
            continue
        along = np.arange(l['b0'], l['b1'], GRID)
        front = l['pos'] + l['sign'] * np.linspace(0.1, 0.4, 4)
        back = l['pos'] - l['sign'] * np.linspace(0.15, 0.6, 6)
        grid_pts = lambda offs: (np.repeat(offs, len(along)), np.tile(along, len(offs)))
        fa, fb = grid_pts(front)
        ba, bb = grid_pts(back)
        f_in, b_in = (frac(fa, fb), frac(ba, bb)) if l['axis'] == 0 else (frac(fb, fa), frac(bb, ba))
        if f_in > 0.5 and b_in < 0.35:
            boundary.append(l)
    lines = boundary
    print(f'{len(lines)} of them bound the free space (room walls)')
    lab, nlab = ndimage.label(mask)
    cij = np.floor((to2(cam_pos) - lo) / GRID).astype(int)
    cam_lab = lab[np.clip(cij[:, 0], 0, shape[0] - 1), np.clip(cij[:, 1], 0, shape[1] - 1)]
    keep = np.bincount(cam_lab[cam_lab > 0]).argmax() if (cam_lab > 0).any() else np.bincount(lab.ravel())[1:].argmax() + 1
    mask = lab == keep
    contour = max(measure.find_contours(np.pad(mask, 1).astype(float), 0.5), key=len) - 1
    poly = lo + (contour + 0.5) * GRID
    poly = douglas_peucker(np.vstack([poly, poly[:1]]), 0.12)[:-1]
    poly, edges = snap_polygon(poly, lines)
    area = 0.5 * np.sum(poly[:, 0] * np.roll(poly[:, 1], -1) - np.roll(poly[:, 0], -1) * poly[:, 1])
    if area < 0:  # orient counter-clockwise in (a, b)
        poly = poly[::-1]
    print(f'outline: {len(poly)} corners, {abs(area):.1f} m² floor area')

    # --- 6. walls + openings -----------------------------------------------------------------------
    def inside(p):
        x, y = p
        hit = False
        for i in range(len(poly)):
            (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % len(poly)]
            if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                hit = not hit
        return hit

    cam_rel_y, pt_rel_y = cams[:, 1] - floorY, pts[:, 1] - floorY
    S = {'walls': [], 'doors': [], 'windows': [], 'openings': [], 'objects': [], 'floors': [], 'sections': [], 'version': 2}
    report_walls = []
    for i in range(len(poly)):
        p, q = poly[i], poly[(i + 1) % len(poly)]
        L = float(np.linalg.norm(q - p))
        u = (q - p) / L
        n = np.array([-u[1], u[0]])
        if not inside((p + q) / 2 + n * 0.05):
            n = -n
        # support: high-band wall points on this edge
        rel = P2 - p
        on = (np.abs(rel @ n) < 0.06) & (rel @ u > 0) & (rel @ u < L)
        cover = np.zeros(max(1, int(L / 0.1)), bool)
        cover[np.clip(((rel[on] @ u) / 0.1).astype(int), 0, len(cover) - 1)] = True
        coverage = float(cover.mean())
        conf = 'high' if coverage > 0.6 else 'medium' if coverage > 0.25 else 'low'

        # openings: rays crossing this wall plane and ending beyond it
        # (ARCore depth on black/glossy surfaces such as TVs scatters behind the wall, so require landing
        # well beyond it, repeated observations and a mostly filled rectangle; results stay low-confidence)
        dc, dp = (cams2 - p) @ n, (pts2 - p) @ n
        cross = (dc > 0.1) & (dp < -0.4)
        tt = dc[cross] / (dc[cross] - dp[cross])
        X = cams2[cross] + (pts2[cross] - cams2[cross]) * tt[:, None]
        cu, cv = (X - p) @ u, cam_rel_y[cross] + (pt_rel_y[cross] - cam_rel_y[cross]) * tt
        solid = np.abs(dp) < 0.06
        su, sv = (pts2[solid] - p) @ u, pt_rel_y[solid]
        cell = 0.05
        gu, gv = max(1, int(L / cell)), max(1, int(height / cell))

        def grid(uu, vv):
            ok = (uu > 0) & (uu < L) & (vv > 0) & (vv < height)
            g = np.zeros((gu, gv), np.int32)
            np.add.at(g, (np.minimum((uu[ok] / cell).astype(int), gu - 1), np.minimum((vv[ok] / cell).astype(int), gv - 1)), 1)
            return g

        see, wallg = grid(cu, cv), grid(su, sv)
        open_ = ndimage.binary_closing((see >= 6) & (see > 3 * wallg), iterations=1)
        olab, on_ = ndimage.label(open_)
        wall_id = str(uuid.uuid4()).upper()
        found = []
        for k in range(1, on_ + 1):
            us, vs = np.where(olab == k)
            u0, u1, v0, v1 = us.min() * cell, (us.max() + 1) * cell, vs.min() * cell, (vs.max() + 1) * cell
            if u1 - u0 < 0.45 or v1 - v0 < 0.4 or len(us) < 40:
                continue
            if len(us) * cell * cell < 0.5 * (u1 - u0) * (v1 - v0):
                continue  # ragged scatter, not a rectangular opening
            if v0 < 0.2 and v1 - v0 > 1.5:
                kind = 'openings' if u1 - u0 > 1.3 or v1 > height - 0.15 else 'doors'
                v0 = 0.0
            elif v0 >= 0.2:
                kind = 'windows'
            else:
                continue
            found.append((kind, u0, u1, v0, v1))
        uw = from2(u[None])[0]
        for kind, u0, u1, v0, v1 in found:
            c2 = p + u * (u0 + u1) / 2
            T = np.eye(4)
            T[:3, 0] = [uw[0], 0, uw[1]]
            T[:3, 1] = [0, 1, 0]
            T[:3, 2] = np.cross(T[:3, 0], T[:3, 1])
            cw = from2(c2[None])[0]
            T[:3, 3] = [cw[0], floorY + (v0 + v1) / 2, cw[1]]
            cat = {'door': {'isOpen': True}} if kind == 'doors' else {kind[:-1]: {}}
            S[kind].append({'identifier': str(uuid.uuid4()).upper(), 'parentIdentifier': wall_id, 'category': cat,
                            'confidence': {'low': {}}, 'dimensions': [round(u1 - u0, 3), round(v1 - v0, 3), 0],
                            'transform': colmajor(T), 'completedEdges': [], 'polygonCorners': [], 'curve': None, 'story': 0})

        T = np.eye(4)
        T[:3, 0] = [uw[0], 0, uw[1]]
        T[:3, 1] = [0, 1, 0]
        T[:3, 2] = np.cross(T[:3, 0], T[:3, 1])
        cw = from2(((p + q) / 2)[None])[0]
        T[:3, 3] = [cw[0], floorY + height / 2, cw[1]]
        S['walls'].append({'identifier': wall_id, 'parentIdentifier': None, 'category': {'wall': {}},
                           'confidence': {conf: {}}, 'dimensions': [round(L, 4), round(height, 4), 0],
                           'transform': colmajor(T), 'completedEdges': [], 'polygonCorners': [], 'curve': None, 'story': 0})
        report_walls.append({'index': i, 'length': round(L, 3), 'confidence': conf, 'coverage': round(coverage, 2),
                             'openings': [{'kind': k[:-1], 'u0': round(a_, 2), 'u1': round(b_, 2), 'v0': round(c_, 2), 'v1': round(d_, 2)} for k, a_, b_, c_, d_ in found]})

    # --- 7. furniture -----------------------------------------------------------------------------
    plan_all = to2(P)
    edge_dist = np.full(len(P), np.inf)
    for i in range(len(poly)):
        p, q = poly[i], poly[(i + 1) % len(poly)]
        d = q - p
        t = np.clip(((plan_all - p) @ d) / (d @ d), 0, 1)
        edge_dist = np.minimum(edge_dist, np.linalg.norm(plan_all - (p + t[:, None] * d), axis=1))
    in_poly = mask[np.clip(((plan_all - lo) / GRID).astype(int)[:, 0], 0, shape[0] - 1), np.clip(((plan_all - lo) / GRID).astype(int)[:, 1], 0, shape[1] - 1)]
    # floor noise (ARCore depth ≈ ±3 cm) and rugs would chain everything into one cluster: start 10 cm up
    sel = in_poly & (edge_dist > 0.12) & (P[:, 1] > floorY + 0.10) & (P[:, 1] < floorY + min(2.0, height - 0.2))
    objs = []
    if sel.sum() > 100:
        pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(P[sel])).voxel_down_sample(0.04)
        Q = np.asarray(pc.points)
        lab = np.asarray(pc.cluster_dbscan(eps=0.07, min_points=12))
        for k in range(lab.max() + 1):
            C = Q[lab == k]
            if len(C) < 60:
                continue
            c2 = to2(C)
            (a0, b0), (a1, b1) = np.percentile(c2, 2, axis=0), np.percentile(c2, 98, axis=0)
            y0, y1 = np.percentile(C[:, 1], 1), np.percentile(C[:, 1], 99)
            if y0 < floorY + 0.3:
                y0 = floorY
            if a1 - a0 < 0.15 or b1 - b0 < 0.15 or y1 - y0 < 0.15:
                continue
            if (a1 - a0) * (b1 - b0) > 4.0 or not inside(((a0 + a1) / 2, (b0 + b1) / 2)):
                continue  # still chained across the room, or outside the walls
            ctr2 = from2(np.array([[(a0 + a1) / 2, (b0 + b1) / 2]]))[0]
            T = np.eye(4)
            T[:3, 0] = [ca, 0, sa]
            T[:3, 1] = [0, 1, 0]
            T[:3, 2] = np.cross(T[:3, 0], T[:3, 1])
            T[:3, 3] = [ctr2[0], (y0 + y1) / 2, ctr2[1]]
            objs.append({'identifier': str(uuid.uuid4()).upper(), 'parentIdentifier': None, 'category': {'unknown': {}},
                         'confidence': {'low': {}}, 'dimensions': [round(a1 - a0, 3), round(y1 - y0, 3), round(b1 - b0, 3)],
                         'transform': colmajor(T), 'story': 0, 'attributes': {}})
    S['objects'] = objs

    # --- floor + write -----------------------------------------------------------------------------
    world_poly = from2(poly)
    F = np.eye(4)
    F[1, 3] = floorY
    S['floors'].append({'identifier': str(uuid.uuid4()).upper(), 'parentIdentifier': None, 'category': {'floor': {}},
                        'confidence': {'high': {}}, 'transform': colmajor(F),
                        'dimensions': [round(float(np.ptp(world_poly[:, 0])), 3), round(float(np.ptp(world_poly[:, 1])), 3), 0],
                        'polygonCorners': [[round(float(x), 4), 0.0, round(float(z), 4)] for x, z in world_poly],
                        'completedEdges': [], 'curve': None, 'story': 0})
    S['generator'] = {'tool': 'dt-modeling/tools/build_room.py', 'source': 'ARCore depth (no RoomPlan)'}
    json.dump(S, open(os.path.join(B, f'rooms/room-{R}.json'), 'w'), indent=1)

    report = {'room': R, 'frames': len(frames), 'floorY': round(floorY, 4), 'ceilingHeight': round(height, 3),
              'ceilingMeasured': bool(ceiling_measured), 'headingDeg': round(math.degrees(theta), 2),
              'floorArea': round(abs(area), 2), 'walls': report_walls, 'objects': len(objs),
              'params': vars(a), 'seconds': round(time.time() - t0, 1)}
    json.dump(report, open(os.path.join(B, f'recon/room-{R}-build.json'), 'w'), indent=1)
    draw_debug(os.path.join(B, f'recon/room-{R}-build.png'), free, mask, lo, lines, poly, report_walls, to2(cam_pos), objs, to2)

    print(f'walls: {len(poly)} ({sum(w["confidence"] == "high" for w in report_walls)} high confidence), '
          f'doors {len(S["doors"])}, windows {len(S["windows"])}, openings {len(S["openings"])}, objects {len(objs)}')
    for w in report_walls:
        ops = ', '.join(f"{o['kind']} {o['u0']:.2f}-{o['u1']:.2f}m" for o in w['openings'])
        # Glass returns no depth (the view through it is beyond --max-depth), so glazing shows up as low coverage
        note = 'few depth hits: glass, mirror or unseen; check photos  ' if w['confidence'] == 'low' else ''
        print(f"  wall {w['index']}: {w['length']:.2f} m  {w['confidence']:6s} coverage {w['coverage']:.0%}  {note}{ops}")
    print(f'wrote rooms/room-{R}.json, recon/room-{R}-scan.ply, recon/room-{R}-build.json/.png ({time.time() - t0:.0f}s)')


def draw_debug(path, free, mask, lo, lines, poly, walls, cams2, objs, to2, ppm=60):
    h, w = free.shape
    scale = ppm * GRID
    img = Image.new('RGB', (int(h * scale), int(w * scale)), (20, 20, 24))
    f = np.clip(np.log1p(free) / np.log1p(free.max() + 1) * 255, 0, 255).astype(np.uint8)
    base = np.stack([f // 3, f // 3, f // 2], -1)
    base[mask] = base[mask] // 2 + np.array([30, 60, 30], np.uint8)
    img.paste(Image.fromarray(np.transpose(base, (1, 0, 2))).resize(img.size, Image.NEAREST))
    d = ImageDraw.Draw(img)
    P = lambda a, b: ((a - lo[0]) * ppm, (b - lo[1]) * ppm)
    for l in lines:
        a0, b0 = (l['pos'], l['b0']) if l['axis'] == 0 else (l['b0'], l['pos'])
        a1, b1 = (l['pos'], l['b1']) if l['axis'] == 0 else (l['b1'], l['pos'])
        d.line([P(a0, b0), P(a1, b1)], fill=(255, 170, 40), width=3)
    colors = {'high': (240, 240, 240), 'medium': (150, 170, 255), 'low': (255, 80, 80)}
    for i, wl in enumerate(walls):
        p, q = poly[i], poly[(i + 1) % len(poly)]
        d.line([P(*p), P(*q)], fill=colors[wl['confidence']], width=2)
        m = (p + q) / 2
        d.text(P(*m), str(i), fill=(255, 255, 0))
        for o in wl['openings']:
            u = (q - p) / np.linalg.norm(q - p)
            d.line([P(*(p + u * o['u0'])), P(*(p + u * o['u1']))], fill=(80, 200, 255) if o['kind'] == 'door' else (120, 255, 160), width=6)
    for c in cams2[::10]:
        d.point(P(*c), fill=(255, 60, 200))
    img.save(path)


if __name__ == '__main__':
    main()
