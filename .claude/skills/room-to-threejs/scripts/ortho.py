#!/usr/bin/env python3
"""Tools for the orthographic captures made by tools/capture.html (see cap.sh).

Pixel <-> world mapping matches capture.ts: pad = 0.25 m around the room,
image top = ROOM.height + 0.1, ppm pixels per meter.

  view  horizontal axis (left → right)      vertical (top → bottom)
  top   x: -W/2-pad → +W/2+pad              z: -D/2-pad → +D/2+pad
  up    x: -W/2-pad → +W/2+pad              z: +D/2+pad → -D/2-pad
  n     x: -W/2-pad → +W/2+pad              y: H+0.1 → -0.1
  s     x: +W/2+pad → -W/2-pad              y
  e     z: -D/2-pad → +D/2+pad              y
  w     z: +D/2+pad → -D/2-pad              y

usage:
  ortho.py highpass <img> --view n --room 6.21,4.84,3.575 [--ppm 180] [-o out.png]
      Removes the lighting gradient so faint moldings/panel edges pop; redraws a labeled grid.
  ortho.py sample <img> --view top --room W,D,H [--ppm 180] name=h0,h1,v0,v1 ...
      Median sRGB color of each world-space rectangle (h = horizontal axis coord, v = vertical axis coord).
  ortho.py px <img> --view n --room W,D,H [--ppm 180] <px> <py>
      World coordinates of a pixel.
"""
import sys as _sys; _sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # Windows consoles default to cp1252
import argparse
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps, ImageStat

PAD = 0.25


def mapping(view, room):
    W, D, H = room
    hx, hz = W / 2 + PAD, D / 2 + PAD
    return {
        #      h-axis, h at px 0, h sign, v-axis, v at py 0, v sign (world change per +py)
        'top': ('x', -hx, 1, 'z', -hz, 1),
        'up': ('x', -hx, 1, 'z', hz, -1),
        'n': ('x', -hx, 1, 'y', H + 0.1, -1),
        's': ('x', hx, -1, 'y', H + 0.1, -1),
        'e': ('z', -hz, 1, 'y', H + 0.1, -1),
        'w': ('z', hz, -1, 'y', H + 0.1, -1),
    }[view]


def to_px(m, ppm, h, v):
    _, h0, hs, _, v0, vs = m
    return (h - h0) * hs * ppm, (v - v0) * vs * ppm


def to_world(m, ppm, px, py):
    _, h0, hs, _, v0, vs = m
    return h0 + hs * px / ppm, v0 + vs * py / ppm


def highpass(a):
    m = mapping(a.view, a.room)
    im = Image.open(a.image).convert('L')
    blur = im.filter(ImageFilter.GaussianBlur(12))
    out = ImageOps.autocontrast(ImageChops.subtract(im, blur, scale=1, offset=128), cutoff=2).convert('RGB')
    d = ImageDraw.Draw(out)
    for i in range(-40, 41):
        c = i * 0.25
        x, _ = to_px(m, a.ppm, c, m[4])
        if 0 <= x < out.width:
            d.line([(x, 0), (x, out.height)], fill=(0, 160, 255) if i % 2 == 0 else (0, 70, 120))
            if i % 2 == 0:
                d.text((x + 2, 2), f'{m[0]}{c:.1f}', fill=(0, 255, 255))
        _, y = to_px(m, a.ppm, m[1], c)
        if 0 <= y < out.height:
            d.line([(0, y), (out.width, y)], fill=(255, 180, 0) if i % 2 == 0 else (110, 80, 0))
            if i % 2 == 0:
                d.text((2, y - 12), f'{m[3]}{c:.1f}', fill=(255, 255, 0))
    path = a.o or a.image.replace('.png', '-hp.png')
    out.save(path)
    print(path)


def sample(a):
    m = mapping(a.view, a.room)
    im = Image.open(a.image).convert('RGB')
    for spec in a.rects:
        name, coords = spec.split('=')
        h0, h1, v0, v1 = map(float, coords.split(','))
        (x0, y0), (x1, y1) = to_px(m, a.ppm, h0, v0), to_px(m, a.ppm, h1, v1)
        box = (int(min(x0, x1)), int(min(y0, y1)), int(max(x0, x1)), int(max(y0, y1)))
        med = ImageStat.Stat(im.crop(box)).median
        print(f'{name:16s} #{int(med[0]):02x}{int(med[1]):02x}{int(med[2]):02x}   (box px {box})')


def px(a):
    m = mapping(a.view, a.room)
    h, v = to_world(m, a.ppm, a.coords[0], a.coords[1])
    print(f'{m[0]} = {h:.3f}   {m[3]} = {v:.3f}')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    for name in ('highpass', 'sample', 'px'):
        s = sub.add_parser(name)
        s.add_argument('image')
        s.add_argument('--view', required=True, choices=['top', 'up', 'n', 's', 'e', 'w'])
        s.add_argument('--room', required=True, type=lambda v: tuple(map(float, v.split(','))), help='width,depth,height')
        s.add_argument('--ppm', type=float, default=180)
        if name == 'highpass':
            s.add_argument('-o')
        elif name == 'sample':
            s.add_argument('rects', nargs='+')
        else:
            s.add_argument('coords', nargs=2, type=float)
    a = p.parse_args()
    {'highpass': highpass, 'sample': sample, 'px': px}[a.cmd](a)
