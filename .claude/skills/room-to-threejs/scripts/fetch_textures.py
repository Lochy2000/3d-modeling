#!/usr/bin/env python3
"""Find and download CC0 PBR textures (Poly Haven, ambientCG) for a room rebuild.

  fetch_textures.py search <word> [<word> ...]
      List matching asset ids on both sites (e.g. `search leather carpet boucle`).

  fetch_textures.py sheet <out.png> <site>:<asset> ...
      Contact sheet of color maps. Look before choosing: names lie
      (polyhaven "wool_boucle" is a houndstooth check, not boucle).

  fetch_textures.py get <out_dir> <name>=<site>:<asset>[:neutral[:mean[:contrast]]] ...
      Download 1K maps and save <name>_diff.jpg, <name>_nor.jpg (OpenGL normal), <name>_rough.jpg.
      `neutral` turns the color map into a grayscale detail map re-centered on `mean`
      (default 0.82), so material.color (sampled from the scan) sets the real hue.
      Use it for fabrics/carpet/leather; keep color maps for wood, stone, patterns.

      e.g. fetch_textures.py get public/textures \\
             carpet=ambientcg:Carpet012:neutral:0.85:1.6 \\
             leather=polyhaven:fabric_leather_02:neutral:0.8:1.3 \\
             oak=polyhaven:oak_veneer_01 plaster=polyhaven:white_plaster_02

Downloads go through curl because Poly Haven rejects Python's default user agent.
Browse visually at https://polyhaven.com/textures and https://ambientcg.com/list.
"""
import sys as _sys; _sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # Windows consoles default to cp1252
import io
import json
import os
import subprocess
import sys
import zipfile

from PIL import Image, ImageOps, ImageStat

SIZE = 1024


def curl(url):
    return subprocess.run(['curl', '-sL', '-m', '120', url], check=True, capture_output=True).stdout


def polyhaven(asset):
    files = json.loads(curl(f'https://api.polyhaven.com/files/{asset}'))
    return {k: Image.open(io.BytesIO(curl(files[k]['1k']['jpg']['url']))) for k in ('Diffuse', 'nor_gl', 'Rough') if k in files}


def ambientcg(asset):
    z = zipfile.ZipFile(io.BytesIO(curl(f'https://ambientcg.com/get?file={asset}_1K-JPG.zip')))
    get = lambda suffix: Image.open(io.BytesIO(z.read(f'{asset}_1K-JPG_{suffix}.jpg')))
    return {'Diffuse': get('Color'), 'nor_gl': get('NormalGL'), 'Rough': get('Roughness')}


def neutral(img, mean=0.82, contrast=1.0):
    g = ImageOps.grayscale(img)
    m = ImageStat.Stat(g).mean[0]
    return g.point(lambda v: max(0, min(255, round(mean * 255 + (v - m) * contrast))))


def search(words):
    ph = json.loads(curl('https://api.polyhaven.com/assets?t=textures'))
    for w in words:
        hits = sorted(k for k in ph if w.lower() in k.lower())
        print(f'polyhaven "{w}": {" ".join(hits) or "-"}')
        acg = json.loads(curl(f'https://ambientcg.com/api/v2/full_json?type=Material&q={w}&limit=30'))
        print(f'ambientcg "{w}": {" ".join(a["assetId"] for a in acg.get("foundAssets", [])) or "-"}')


def sheet(out, specs):
    from PIL import ImageDraw
    T = 256
    cols = min(5, len(specs))
    rows = (len(specs) + cols - 1) // cols
    img = Image.new('RGB', (T * cols, (T + 18) * rows), 'black')
    d = ImageDraw.Draw(img)
    for i, spec in enumerate(specs):
        site, asset = spec.split(':')[:2]
        maps = polyhaven(asset) if site == 'polyhaven' else ambientcg(asset)
        x, y = (i % cols) * T, (i // cols) * (T + 18)
        img.paste(maps['Diffuse'].convert('RGB').resize((T, T)), (x, y + 18))
        d.text((x + 4, y + 3), asset, fill='white')
    img.save(out)
    print(out)


def get(out, specs):
    os.makedirs(out, exist_ok=True)
    for spec in specs:
        name, rest = spec.split('=', 1)
        parts = rest.split(':')
        site, asset = parts[0], parts[1]
        maps = polyhaven(asset) if site == 'polyhaven' else ambientcg(asset)
        diffuse = maps.get('Diffuse')
        if diffuse is not None:
            if len(parts) > 2 and parts[2] == 'neutral':
                mean = float(parts[3]) if len(parts) > 3 else 0.82
                contrast = float(parts[4]) if len(parts) > 4 else 1.0
                diffuse = neutral(diffuse, mean, contrast)
            diffuse.convert('RGB').resize((SIZE, SIZE)).save(f'{out}/{name}_diff.jpg', quality=85)
        if 'nor_gl' in maps:
            maps['nor_gl'].convert('RGB').resize((SIZE, SIZE)).save(f'{out}/{name}_nor.jpg', quality=90)
        if 'Rough' in maps:
            ImageOps.grayscale(maps['Rough']).resize((SIZE, SIZE)).save(f'{out}/{name}_rough.jpg', quality=85)
        print(f'saved {name} ({site}:{asset})')


if __name__ == '__main__':
    cmds = {'search': lambda a: search(a), 'sheet': lambda a: sheet(a[0], a[1:]), 'get': lambda a: get(a[0], a[1:])}
    if len(sys.argv) < 3 or sys.argv[1] not in cmds:
        print(__doc__)
        sys.exit(1)
    cmds[sys.argv[1]](sys.argv[2:])
