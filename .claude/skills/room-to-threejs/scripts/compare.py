#!/usr/bin/env python3
"""Render views of a room from the viewer's capture page and stitch comparisons (Windows/macOS/Linux).
Replaces cap.sh / cmp.sh / cmp_photo.sh (zsh + agent-browser) with Playwright driving installed Chrome.

  compare.py photo <room> <index> [<index> ...] [--scan]
      Real photo | model rendered from that photo's exact camera [| scan from the same camera].
  compare.py plan <room> [--ppm 110]
      Top-down orthographic view of the model (and scan with --scan).
  compare.py cmp <name> "<camera query>"     e.g. "room=living-room&cam=0,1.5,2&look=0,1,0&fov=60&size=1300x850"
      Scan (left) vs model (right) from the same camera.
  compare.py cap <name> "<query>"
      One raw capture (any capture.html query).

Images go to captures/compare/ (git-ignored). Starts the dev server if it isn't running.
Needs: pip install playwright pillow   (uses your installed Chrome; no browser download)
"""
import argparse
import os
import subprocess
import sys
import time
import urllib.request

from PIL import Image

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../..'))
OUT = os.environ.get('CAP_OUT', os.path.join(ROOT, 'captures', 'compare'))
URL = os.environ.get('CAP_URL', 'http://127.0.0.1:5188')
PHOTOS = os.path.join(ROOT, 'data', 'web-assets')


def server_up():
    try:
        urllib.request.urlopen(URL, timeout=2)
        return True
    except Exception:
        return False


def ensure_server():
    if server_up():
        return None
    print('starting the viewer dev server...', flush=True)
    proc = subprocess.Popen('npm run dev', cwd=ROOT, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        if server_up():
            return proc
        time.sleep(1)
    sys.exit('dev server did not start (try `npm run dev` yourself to see the error)')


class Capturer:
    def __init__(self):
        from playwright.sync_api import sync_playwright
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch(channel='chrome', args=['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'])
        self.page = self.browser.new_page(viewport={'width': 1400, 'height': 1100})
        self.errors = []
        self.page.on('console', lambda m: m.type == 'error' and self.errors.append(m.text))
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))

    def cap(self, name, query, timeout_s=300):
        """Render capture.html?query and save the canvas wrapper as <name>.png."""
        self.errors.clear()
        self.page.set_viewport_size({'width': 1400, 'height': 1100})
        self.page.goto(f'{URL}/tools/capture.html?{query}')
        try:
            self.page.wait_for_function("document.body.dataset.ready === '1'", timeout=timeout_s * 1000)
        except Exception:
            raise SystemExit(f'capture failed for "{query}":\n  ' + '\n  '.join(self.errors[-8:] or ['timed out']))
        w, h = self.page.evaluate('(() => { const r = document.querySelector("#wrap").getBoundingClientRect(); return [Math.ceil(r.width), Math.ceil(r.height)]; })()')
        self.page.set_viewport_size({'width': max(1, w) + 40, 'height': max(1, h) + 40})
        path = os.path.join(OUT, f'{name}.png')
        self.page.locator('#wrap').screenshot(path=path)
        return path

    def close(self):
        self.browser.close()
        self.pw.stop()


def side_by_side(images, path, gap=6):
    h = min(im.height for im in images)
    ims = [im.convert('RGB').resize((round(im.width * h / im.height), h)) for im in images]
    out = Image.new('RGB', (sum(i.width for i in ims) + gap * (len(ims) - 1), h), 'white')
    x = 0
    for im in ims:
        out.paste(im, (x, 0))
        x += im.width + gap
    out.save(path, quality=88)
    return path


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('photo'); p.add_argument('room'); p.add_argument('index', type=int, nargs='+'); p.add_argument('--scan', action='store_true'); p.add_argument('--size', type=int, default=540)
    p = sub.add_parser('plan'); p.add_argument('room'); p.add_argument('--ppm', type=int, default=110); p.add_argument('--scan', action='store_true')
    p = sub.add_parser('cmp'); p.add_argument('name'); p.add_argument('query')
    p = sub.add_parser('cap'); p.add_argument('name'); p.add_argument('query')
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    server = ensure_server()
    c = Capturer()
    try:
        if a.cmd == 'cap':
            print(c.cap(a.name, a.query))
        elif a.cmd == 'cmp':
            s = Image.open(c.cap(f'{a.name}-scan', f'src=scan&{a.query}'))
            m = Image.open(c.cap(f'{a.name}-model', f'src=model&{a.query}'))
            print(side_by_side([s, m], os.path.join(OUT, f'{a.name}-cmp.jpg')))
        elif a.cmd == 'plan':
            panels = [Image.open(c.cap(f'plan-{a.room}-model', f'room={a.room}&src=model&view=top&ppm={a.ppm}'))]
            if a.scan:
                panels.insert(0, Image.open(c.cap(f'plan-{a.room}-scan', f'room={a.room}&src=scan&view=top&ppm={a.ppm}')))
            print(side_by_side(panels, os.path.join(OUT, f'plan-{a.room}.jpg')))
        else:
            for n in a.index:
                # prepared photos are named in the room's photo order: NNNN.jpg
                photo = Image.open(os.path.join(PHOTOS, a.room, 'photos', f'{n:04d}.jpg'))
                panels = [photo, Image.open(c.cap(f'ph-{a.room}-{n}-model', f'room={a.room}&src=model&photo={n}&size={a.size}'))]
                if a.scan:
                    panels.append(Image.open(c.cap(f'ph-{a.room}-{n}-scan', f'room={a.room}&src=scan&photo={n}&size={a.size}')))
                print(side_by_side(panels, os.path.join(OUT, f'ph-{a.room}-{n}.jpg')), flush=True)
    finally:
        c.close()
        if server:
            server.terminate()


if __name__ == '__main__':
    main()
