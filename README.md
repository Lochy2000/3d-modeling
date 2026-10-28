# dt-modeling

Scan a room with an Android phone (ARCore), turn the scan into a measured room layout, and rebuild it
as an editable Three.js model, as a step towards digital twins.

| Part | What it does |
|------|--------------|
| `apps/android-capture/` | Kotlin + ARCore app: posed photos, depth frames, planes per room |
| `tools/pull_scans.py` | copy sessions from the phone over USB and check them |
| `tools/build_room.py` | ARCore depth → floor, ceiling, walls, openings, furniture boxes (replaces Apple's RoomPlan) |
| `apps/room-viewer/` + `packages/` | viewer: dollhouse, layout, walk-through, matched-camera captures |
| `rooms/` | room modules; `layout-room.ts` builds a measured baseline from any scan layout |
| `.claude/skills/room-to-threejs/` | agent skill + scripts for photo-guided detailed modeling |

The viewer, runtime packages and skill scripts started as copies of the MIT-licensed
[3d-model-anything](https://github.com/wesbos/3d-model-anything) by Wes Bos
(see `THIRD_PARTY_LICENSE-3d-model-anything.txt`). Its office demo, images and iPhone app are not included.

## Your data stays local

Scans, photos, meshes and models of real rooms never go into git:

- `captures/`, `data/` and `rooms/private/` are git-ignored, and so are image, video, mesh and depth file types.
- **Pre-commit hook:** `tools/check_private.py` blocks commits containing those paths or file types, files
  over 1 MB, or JSON that looks like capture data, even if you force-add them. Enable it once per clone:
  `git config core.hooksPath .githooks`
- **CI:** GitHub Actions runs the same check on every push, as a backstop.
- **Builds:** private rooms and `data/` are served only by the dev server. `npm run build` output
  contains only the invented example room, so it's safe to publish.

## Setup

```sh
npm ci
npm run textures                 # CC0 textures (Poly Haven / ambientCG) into data/web-assets/textures
pip install numpy pillow open3d scipy scikit-image
git config core.hooksPath .githooks
```

## 1. Install the capture app (Galaxy S10e or any ARCore phone)

1. Phone: *Settings → About phone → Software information*, tap **Build number** 7 times, then enable
   *Developer options → USB debugging*. Plug in and accept the prompt.
2. `cd apps/android-capture` then `.\gradlew.bat installDebug` (needs JDK 17+, e.g. set
   `JAVA_HOME=C:\Program Files\Android\Android Studio\jbr`).

## 2. Scan

- **Lights on.** Tracking fails in dim light ("NOT RECORDING (INSUFFICIENT_LIGHT)").
- Wait for `tracking OK`, tap **Start room**, walk slowly sweeping each wall at chest and overhead height.
  Plain walls: keep an edge or furniture in view and move sideways.
- **Finish room**, then **Finish session**. Measure one or two distances with a tape to check accuracy.

## 3. Pull and build

```sh
python tools/pull_scans.py                              # → captures/<session>, checked
python tools/build_room.py captures/<session> --room 0  # → rooms/room-0.json + recon/
S=.claude/skills/room-to-threejs/scripts
python $S/bundle_to_room.py captures/<session> --room 0 -o rooms/private/<id>/room.json
python $S/prepare_photos.py captures/<session> rooms/private/<id>/room.json data/web-assets/<id>/photos
python $S/reconstruct_bundle.py captures/<session> --mesh captures/<session>/recon/room-0-scan.ply \
  --room rooms/private/<id>/room.json -o captures/<session>/recon/colored
cp captures/<session>/recon/colored/scan_room.glb data/web-assets/<id>/
```

Then create `rooms/private/<id>/index.ts`:

```ts
import { layoutRoom, type ScanLayout } from '../../layout-room';
import layout from './room.json';

const base = `${import.meta.env.BASE_URL}<id>`;
export const room = layoutRoom({ id: '<id>', label: 'My room', layout: layout as ScanLayout,
  referenceUrl: `${base}/scan_room.glb`, photoBase: `${base}/photos` });
```

## 4. View and model

`npm run dev` → http://127.0.0.1:5188. Use **Scan** and **Overlay** to compare with the colored scan.
For detailed modeling, ask the agent to use the **room-to-threejs** skill on `rooms/private/<id>`.

### What ARCore depth gives you

| | Reliability |
|---|---|
| Floor level, ceiling height, solid walls | good (a few cm) |
| Glass walls, mirrors, walls never seen within 3 m | `low` confidence: add from photos |
| Doors / windows | only clear see-through openings; others come from photos |
| Furniture | rough boxes to model from photos |

## Bundle format

Sessions follow the iPhone `house-capture/5` layout (variant `android-arcore/1`):

```text
manifest.json             format, variant, device, rooms, diagnostics events
photos/photos.json        file, room, timestamp, width, height, transform, intrinsics, blurPixels, exposure
photos/NNNN.jpg           sensor orientation (landscape); rotate 90° clockwise for portrait
depth/frames.json         file, confidence, rawDepth, rgb, rgbIntrinsics, transform, intrinsics
depth/NNNNN.f16z          ARCore smoothed depth, Float16 meters, raw DEFLATE (zlib.decompress(d, -15))
depth/NNNNN-raw.f16z      ARCore raw depth when available
depth/NNNNN.conf          UInt8 0–2 (from raw-depth confidence; 1 where only smoothed depth exists)
depth/NNNNN.jpg           ~640 px color of the same frame
rooms/room-N-planes.json  ARCore planes at the end of room N
rooms/room-N.json         generated on the PC by tools/build_room.py
```

Transforms are column-major 4×4 camera-to-world (camera looks down −Z, +Y up, sensor orientation);
world is metric, right-handed, +Y up. Intrinsics are `[fx,0,0,0,fy,0,cx,cy,1]` for their image.
The app picks the highest photo resolution with ARCore depth support (1920×1080 on a Galaxy S10e;
its 1440×1080 mode is a different camera without depth).
