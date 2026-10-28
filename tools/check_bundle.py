#!/usr/bin/env python3
"""Sanity-check a capture session bundle (Android dt-capture or iPhone house-capture/5).

usage: check_bundle.py <session_dir>

Reports rooms, photo/depth counts, missing files, blur, depth ranges and confidence mix, and
checks that consecutive depth frames agree in world space (a pose/intrinsics consistency test).
Needs: numpy
"""
import json
import os
import sys
import zlib

import numpy as np


def mat(cm):
    return np.array(cm, dtype=np.float64).reshape(4, 4).T  # column-major → row-major


CV = np.diag([1.0, -1.0, -1.0, 1.0])  # camera +y up/−z forward → +y down/+z forward


def load_depth(bundle, f):
    raw = zlib.decompress(open(os.path.join(bundle, f['file']), 'rb').read(), -15)
    return np.frombuffer(raw, dtype='<f2').astype(np.float32).reshape(f['height'], f['width'])


def world_points(depth, f, step=4):
    k = np.array(f['intrinsics']).reshape(3, 3).T
    ys, xs = np.mgrid[0:depth.shape[0]:step, 0:depth.shape[1]:step]
    z = depth[ys, xs].ravel()
    ok = (z > 0.2) & (z < 4)
    p = np.c_[(xs.ravel()[ok] - k[0, 2]) * z[ok] / k[0, 0], (ys.ravel()[ok] - k[1, 2]) * z[ok] / k[1, 1], z[ok], np.ones(ok.sum())]
    return (mat(f['transform']) @ CV @ p.T).T[:, :3]


def project(points, f, shape):
    k = np.array(f['intrinsics']).reshape(3, 3).T
    pc = (np.linalg.inv(mat(f['transform']) @ CV) @ np.c_[points, np.ones(len(points))].T).T
    z = pc[:, 2]
    ok = z > 0.1
    u = np.round(k[0, 0] * pc[ok, 0] / z[ok] + k[0, 2]).astype(int)
    v = np.round(k[1, 1] * pc[ok, 1] / z[ok] + k[1, 2]).astype(int)
    inside = (u >= 0) & (u < shape[1]) & (v >= 0) & (v < shape[0])
    return u[inside], v[inside], z[ok][inside]


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    b = sys.argv[1]
    m = json.load(open(os.path.join(b, 'manifest.json')))
    print(f"format {m.get('format')} {m.get('variant', '')}  device {m.get('device', {}).get('model', '?')}")
    photos = json.load(open(os.path.join(b, 'photos/photos.json')))
    fp = os.path.join(b, 'depth/frames.json')
    frames = json.load(open(fp)) if os.path.exists(fp) else []
    problems = []

    for r in m.get('rooms', []):
        i = r['index']
        rp = [p for p in photos if p['room'] == i]
        rf = [f for f in frames if f['room'] == i]
        blur = [p['blurPixels'] for p in rp if p.get('blurPixels') is not None]
        geo = 'yes' if os.path.exists(os.path.join(b, f'rooms/room-{i}.json')) else 'not yet'
        planes = os.path.join(b, f'rooms/room-{i}-planes.json')
        n_planes = len(json.load(open(planes))['planes']) if os.path.exists(planes) else 0
        print(f"room {i} {r.get('name')!r}: {len(rp)} photos, {len(rf)} depth frames, {n_planes} ARCore planes, "
              f"room-{i}.json {geo}" + (f", median blur {np.median(blur):.1f}px" if blur else ''))
        if not rp:
            problems.append(f'room {i} has no photos (tracking never started? check manifest diagnostics.events)')
        elif not rf and m.get('device', {}).get('arcoreDepth', True):
            problems.append(f'room {i} has no depth frames')
        if 'finished' not in r:
            problems.append(f'room {i} was never finished (app closed mid-room?)')

    for p in photos:
        if not os.path.exists(os.path.join(b, p['file'])):
            problems.append(f"missing {p['file']}")
    if photos:
        p = photos[0]
        print(f"photos: {p['width']}x{p['height']}, fx {p['intrinsics'][0]:.1f}")

    if frames:
        f0 = frames[len(frames) // 2]
        d = load_depth(b, f0)
        conf = np.fromfile(os.path.join(b, f0['confidence']), dtype=np.uint8)
        valid = d[d > 0]
        print(f"depth: {f0['width']}x{f0['height']} ({f0.get('intrinsicsSource', 'n/a')} intrinsics), "
              f"valid {valid.size / d.size:.0%}, range {valid.min() if valid.size else 0:.2f}-{valid.max() if valid.size else 0:.2f} m, "
              f"confidence 0/1/2 = {[int((conf == c).sum()) for c in (0, 1, 2)]}")
        # consistency: reproject frame i's points into frame i+3 and compare depth
        errs = []
        for i in range(0, len(frames) - 3, max(1, len(frames) // 25)):
            fa, fb = frames[i], frames[i + 3]
            if fa['room'] != fb['room']:
                continue
            db = load_depth(b, fb)
            u, v, z = project(world_points(load_depth(b, fa), fa), fb, db.shape)
            obs = db[v, u]
            ok = obs > 0
            if ok.sum() > 50:
                errs.append(np.median(np.abs(obs[ok] - z[ok])))
        if errs:
            e = float(np.median(errs))
            print(f"depth/pose consistency (frame i -> i+3): median {e * 100:.1f} cm")
            if e > 0.08:
                problems.append(f'depth frames disagree by {e * 100:.0f} cm: check depth intrinsics/orientation')

    print('\n' + ('\n'.join('PROBLEM: ' + p for p in problems) if problems else 'OK'))


if __name__ == '__main__':
    main()
