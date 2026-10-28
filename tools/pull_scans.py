#!/usr/bin/env python3
"""Copy capture sessions from the phone (USB debugging on) into dt-modeling/captures/ and check them.

usage: python tools/pull_scans.py            # pull sessions not yet on the PC
       python tools/pull_scans.py --all      # pull every session again

Finds adb in the Android SDK automatically.
"""
import os
import shutil
import subprocess
import sys

PACKAGE = 'dev.dtmodeling.capture'
REMOTE = f'/sdcard/Android/data/{PACKAGE}/files/Sessions'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAPTURES = os.path.join(ROOT, 'captures')


def find_adb():
    candidates = [shutil.which('adb')]
    for base in (os.environ.get('ANDROID_HOME'), os.environ.get('ANDROID_SDK_ROOT'),
                 os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk'),
                 os.path.expanduser('~/Library/Android/sdk'), os.path.expanduser('~/Android/Sdk')):
        if base:
            candidates.append(os.path.join(base, 'platform-tools', 'adb.exe' if os.name == 'nt' else 'adb'))
    for c in candidates:
        if c and os.path.exists(c):
            return c
    sys.exit('adb not found: install Android SDK platform-tools')


def main():
    adb = find_adb()
    devices = [l.split()[0] for l in subprocess.run([adb, 'devices'], capture_output=True, text=True).stdout.splitlines()[1:]
               if l.strip().endswith('device')]
    if not devices:
        sys.exit('No phone found. Plug it in, unlock it, and accept "Allow USB debugging".')
    listing = subprocess.run([adb, 'shell', 'ls', REMOTE], capture_output=True, text=True)
    sessions = sorted(s.strip() for s in listing.stdout.split() if s.strip())
    if listing.returncode != 0 or not sessions:
        sys.exit('No sessions on the phone yet (scan a room and tap Finish session first).')

    os.makedirs(CAPTURES, exist_ok=True)
    pulled = []
    for s in sessions:
        local = os.path.join(CAPTURES, s)
        if os.path.exists(local) and '--all' not in sys.argv:
            print(f'{s}: already on PC')
            continue
        print(f'{s}: copying...', flush=True)
        r = subprocess.run([adb, 'pull', f'{REMOTE}/{s}', CAPTURES], capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stderr.strip())
            continue
        pulled.append(local)

    for local in pulled:
        print(f'\n=== {os.path.relpath(local, ROOT)}', flush=True)
        subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'check_bundle.py'), local])


if __name__ == '__main__':
    main()
