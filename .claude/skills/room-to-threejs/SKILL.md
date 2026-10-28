---
name: room-to-threejs
description: Rebuild editable Three.js rooms in this repo from Android (ARCore) capture sessions, iPhone house-capture exports, RoomPlan JSON, or GLB/glTF scans. Use for scan-based reconstruction and photo-guided refinement of a room in rooms/private/.
---

# Room to Three.js

Use captured geometry as measurement evidence and posed photos as visual evidence. Build editable geometry, then compare it against those inputs. Conversion produces a measured baseline; detailed reconstruction requires modeling and visual review.

Adapted from the MIT-licensed `scan-to-threejs` skill in 3d-model-anything (see THIRD_PARTY_LICENSE-3d-model-anything.txt).

## Privacy (read first)

Everything about a real room is personal: captures, photos, meshes, textures sampled from photos, measurements and the room module itself. Keep it in `captures/`, `data/` or `rooms/private/<id>/`, all git-ignored and blocked by `.githooks/pre-commit` (`tools/check_private.py`). Never move such content into tracked folders, never commit with `--no-verify`, and never copy photos into `docs/public/`. Private rooms load only in the dev server, so production builds contain only `rooms/example/`.

## Inputs and coordinates

- **Android session** (`manifest.json` with `variant: android-arcore/1`): there is no RoomPlan. Run `python tools/build_room.py captures/<session> --room N` first; it writes `rooms/room-N.json` (RoomPlan shape) and `recon/room-N-scan.ply`. Read its `recon/room-N-build.json`: walls marked `low` had few depth hits (glass, mirrors, unseen) and openings are only clear see-through gaps, so take glazing, closed doors and windows behind blinds from photos. Furniture boxes are category `unknown`.
- **iPhone export / any session with `manifest.json`**: see [house-capture.md](references/house-capture.md); for `house.json` use `scripts/house_to_rooms.py`.
- Then for any session: `scripts/bundle_to_room.py` → room-local layout (+ photo poses), `scripts/prepare_photos.py` → upright photos, `scripts/reconstruct_bundle.py --mesh <scan.ply>` → colored `scan_room.glb`.
- **GLB/glTF**: `scripts/measure_scan.mjs`. Preserve original files and texture coordinates.

Use meters, +Y up and floor zero. Apply the same transformations to geometry, photo poses, lights and reference layers. Never infer session alignment from matching room names.

## Project setup

Read [project-layout.md](references/project-layout.md). A new room is `rooms/private/<id>/index.ts` exporting `room: RoomModule`; start from `rooms/layout-room.ts` (`layoutRoom({ layout, referenceUrl, photoBase })`), which builds measured walls, floor, ceiling and placeholder boxes from the converted layout, then replace placeholders and surfaces with modeled geometry. Put the converted layout next to the module, and the colored scan and prepared photos in `data/web-assets/<id>/`.

## Measure, model, compare

Establish the floor, wall planes, openings, ceiling steps and object dimensions before adding detail. Use orthographic scan renders and multiple photos to resolve ambiguous shapes. Record uncertainty rather than inventing measurements. ARCore depth-from-motion is noisier than LiDAR (a few cm); prefer photos plus the user's tape measurements for small details.

Read [modeling.md](references/modeling.md) for geometry, materials and wall cutaways; read [advanced-modeling.md](references/advanced-modeling.md) for detailed modeling and performance. Match the user's requested fidelity. RoomPlan-style boxes are bounds, not finished furniture.

Matched-camera comparisons use the viewer's capture page: `http://127.0.0.1:5188/tools/capture.html?room=<id>&photo=<index>&src=model|scan&size=720` renders from photo `<index>`'s exact pose (photos in `data/web-assets/<id>/photos/NNNN.jpg`, same order). The bundled `cap.sh`/`cmp*.sh` helpers are zsh + `agent-browser` and do not run on Windows yet; until they are ported, capture with headless Chrome (`--headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --screenshot`) and stitch with Pillow. Large scan GLBs may not finish loading under headless virtual time; compare model renders against photos, and check Scan in a normal browser.

These tools capture; they do not evaluate similarity. Inspect results, identify concrete discrepancies, fix the largest, and repeat. Preserve visual quality while optimizing: favor batching, instancing and idle rendering.

## Delivery

Register by exporting `room` from `rooms/private/<id>/index.ts` (no central list to edit). Use `referenceAvailable: false` when no scan is available. Run `npm run build` (type check; the build excludes private rooms by design) and check the dev viewer's modes and browser console. Include matched-camera evidence and explain which details are measured, modeled or approximate.
