#!/usr/bin/env python3
"""Refuse to commit personal data: scans, photos, meshes, room models of real places.

usage: check_private.py --staged   # pre-commit hook (.githooks/pre-commit)
       check_private.py --all      # every tracked file (CI backstop)

Blocks: anything under captures/, data/ or rooms/private/; image/video/mesh/depth/scan file types
(except under docs/public/); files over 1 MB; JSON that looks like capture data (camera poses,
intrinsics, house-capture manifests). Exit code 1 lists the offending files.
"""
import os
import subprocess
import sys

PRIVATE_DIRS = ('captures/', 'data/', 'rooms/private/')
MEDIA = {'.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.mp4', '.mov',
         '.ply', '.glb', '.gltf', '.obj', '.usdz', '.f16', '.f16z', '.conf', '.npy', '.arworldmap', '.zip'}
PUBLIC_MEDIA = ('docs/public/',)
MAX_BYTES = 1_000_000
SCAN_MARKERS = ('"intrinsics"', 'house-capture', '"rgbIntrinsics"', '"worldToRoom"', '"polygonCorners"', '"centerPose"')


def git(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True, check=True).stdout


def staged_bytes(path, staged):
    if staged:
        return subprocess.run(['git', 'show', f':{path}'], capture_output=True, check=True).stdout
    with open(path, 'rb') as f:
        return f.read()


def problems_for(path, staged):
    p = path.replace('\\', '/')
    if p.startswith(PRIVATE_DIRS):
        return 'personal data folder'
    ext = os.path.splitext(p)[1].lower()
    if ext in MEDIA and not p.startswith(PUBLIC_MEDIA):
        return f'{ext} file (photos/scans/meshes stay local; deliberate public images go in docs/public/)'
    data = staged_bytes(p, staged)
    if len(data) > MAX_BYTES:
        return f'{len(data) / 1e6:.1f} MB (over 1 MB: probably data, not source)'
    if ext == '.json':
        text = data[:200_000].decode('utf-8', 'replace')
        hit = next((m for m in SCAN_MARKERS if m in text), None)
        if hit:
            return f'looks like capture data (contains {hit})'
    return None


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('--staged', '--all'):
        sys.exit(__doc__)
    staged = sys.argv[1] == '--staged'
    files = git('diff', '--cached', '--name-only', '--diff-filter=ACMR').split('\n') if staged else git('ls-files').split('\n')
    bad = [(f, why) for f in files if f and (why := problems_for(f, staged))]
    if not bad:
        return
    print('Blocked: these files look like personal data and must not be committed:\n')
    for f, why in bad:
        print(f'  {f}  ({why})')
    if staged:
        print('\nUnstage them with:  git rm --cached <file>   (the file stays on disk)')
    sys.exit(1)


if __name__ == '__main__':
    main()
