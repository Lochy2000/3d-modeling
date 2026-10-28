"""Behavior checks for active-scan selection, house placement, and photo ordering.
Run: python3 -m unittest discover -s <skill>/scripts -p 'test_*.py'
Requires Pillow for the photo export checks.
"""
import sys as _sys; _sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # Windows consoles default to cp1252
import json
import math
from pathlib import Path
import tempfile
import unittest

from bundle_to_room import apply, mat, mul
from house_to_rooms import export_house, flatten, rigid
from prepare_photos import prepare
from PIL import Image


def transform(x=0, y=0, z=0, angle=0):
    c, s = math.cos(angle), math.sin(angle)
    return flatten([[c, 0, s, x], [0, 1, 0, y], [-s, 0, c, z], [0, 0, 0, 1]])


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / 'house'
        for session, x in [('old', 99), ('new', 4)]:
            bundle = self.root / 'sessions' / session
            write(bundle / 'rooms/room-1.json', {'walls': [
                {'identifier': 'wall', 'transform': transform(x, 3, 2),
                 'dimensions': [6, 2, 0], 'confidence': {'high': {}}}], 'objects': [
                {'category': {'table': {}}, 'transform': transform(x, 2.5, 2), 'dimensions': [1, 1, 1]}]})
            write(bundle / 'photos/photos.json', [
                {'file': f'photos/{i:04d}.jpg', 'room': room, 'transform': transform(x, 3, 3),
                 'intrinsics': [100, 0, 0, 0, 100, 0, 20, 10, 1], 'width': 40, 'height': 20}
                for i, room in [(2, 0), (9, 1), (3, 1)]])
            for i, color in [(2, 'blue'), (9, 'red'), (3, 'green')]:
                Image.new('RGB', (40, 20), color).save(bundle / f'photos/{i:04d}.jpg')
        self.house = {'format': 'house-project/1', 'id': 'home', 'name': 'Home',
            'zones': [{'id': 'zone', 'name': 'Area', 'aligned': True,
                       'toHouse': transform(10, 1, 20, math.pi / 2)}],
            'sessions': [{'id': s, 'zone': 'zone',
                          'alignment': {'method': 'manual', 'toZone': transform(2, 0, 3)}} for s in ['old', 'new']],
            'rooms': [{'id': 'room-id', 'name': 'Office', 'zone': 'zone',
                       'active': {'session': 'new', 'index': 1},
                       'history': [{'session': 'old', 'index': 1}, {'session': 'new', 'index': 1}]}]}
        self.save()

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        write(self.root / 'house.json', self.house)

    def test_active_scan_and_noncommuting_transform(self):
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        index = export_house(self.root, self.base / 'out')
        r = json.loads((self.base / 'out' / index['rooms'][0]['file']).read_text())
        self.assertEqual(r['housePlacement']['session'], 'new')
        # Session (4,2.5,2) -> zone (6,2.5,5) -> house (15,3.5,14).
        point = apply(mat(r['housePlacement']['roomToHouse']), r['objects'][0]['center'])
        for actual, expected in zip(point, [15, 3.5, 14]):
            self.assertAlmostEqual(actual, expected, places=5)
        self.assertEqual([p['file'] for p in r['photos']], ['photos/0009.jpg', 'photos/0003.jpg'])
        after = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)

    def test_unaligned_session_and_zone_are_blocked(self):
        for mode in ['session', 'zone']:
            if mode == 'session':
                self.house['sessions'][1]['alignment']['method'] = 'unaligned'
            else:
                self.house['sessions'][1]['alignment']['method'] = 'manual'
                self.house['zones'][0]['aligned'] = False
            self.save()
            result = export_house(self.root, self.base / mode)
            self.assertEqual(result['rooms'][0]['status'], 'blocked')
            self.assertNotIn('roomToHouse', result['rooms'][0])
            self.assertEqual(len(list((self.base / mode).glob('room-*.json'))), 0)

    def test_no_active_and_missing_source_reported(self):
        self.house['rooms'].append({'id': 'empty', 'name': 'Empty', 'zone': 'zone'})
        (self.root / 'sessions/new/rooms/room-1.json').unlink()
        self.save()
        result = export_house(self.root, self.base / 'out')
        self.assertEqual([r['status'] for r in result['rooms']], ['blocked', 'blocked'])

    def test_selection_and_no_overwrite(self):
        with self.assertRaises(ValueError):
            export_house(self.root, self.base / 'unknown', 'not-a-room')
        export_house(self.root, self.base / 'out', 'room-id')
        with self.assertRaises(ValueError):
            export_house(self.root, self.base / 'out')

    def test_invalid_transforms(self):
        for values in [[0]*16, transform()[:15], transform(x=float('nan'))]:
            with self.assertRaises(ValueError):
                rigid(values)
        scaled = transform(); scaled[0] = 2
        with self.assertRaises(ValueError):
            rigid(scaled)

    def test_session_path_escape(self):
        self.house['sessions'][1]['id'] = '../../outside'
        self.house['rooms'][0]['active']['session'] = '../../outside'
        self.save()
        result = export_house(self.root, self.base / 'out')
        self.assertEqual(result['rooms'][0]['status'], 'blocked')
        self.assertIn('escapes', result['rooms'][0]['reason'])

    def test_photos_follow_metadata_order_and_rotate_once(self):
        index = export_house(self.root, self.base / 'out')
        room = self.base / 'out' / index['rooms'][0]['file']
        photos = self.base / 'photos'
        self.assertEqual(prepare(self.root / 'sessions/new', room, photos), 2)
        with Image.open(photos / '0000.jpg') as first:
            self.assertEqual(first.size, (20, 40))
            self.assertGreater(first.getpixel((10, 10))[0], 240)
        with Image.open(photos / '0001.jpg') as second:
            self.assertGreater(second.getpixel((10, 10))[1], 100)
        with self.assertRaises(ValueError):
            prepare(self.root / 'sessions/new', room, photos)


if __name__ == '__main__':
    unittest.main()
