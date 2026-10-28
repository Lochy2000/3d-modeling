# Project layout (dt-modeling)

- `apps/android-capture/`: Kotlin + ARCore capture app (house-capture/5-compatible sessions, variant `android-arcore/1`).
- `apps/room-viewer/`: viewer (dollhouse, layout, knolling, walk) and the matched-camera capture page `tools/capture.html`.
- `packages/room-runtime/`: geometry helpers, wall builders, materials, lighting, rendering and types.
- `packages/room-physics/`: optional interactive physics (`play.html`).
- `rooms/index.ts`: registry; discovers `rooms/*/index.ts` and, in the dev server only, `rooms/private/*/index.ts`.
- `rooms/layout-room.ts`: generic measured baseline from a converted layout.
- `rooms/example/`: invented example room (tracked, public).
- `rooms/private/<id>/`: personal room modules and their converted layouts (git-ignored).
- `data/web-assets/`: browser assets served at the URL root by the dev server only: `textures/` (CC0, `npm run textures`), `<id>/scan_room.glb`, `<id>/photos/NNNN.jpg` (git-ignored).
- `captures/<session>/`: sessions pulled from the phone with `python tools/pull_scans.py` (git-ignored); `recon/` inside holds build outputs.
- `tools/`: `pull_scans.py`, `check_bundle.py`, `build_room.py` (ARCore depth → RoomPlan-style layout), `check_private.py` (commit guard).

Run `npm ci`, `npm run textures`, then `npm run dev` (http://127.0.0.1:5188). `npm run build` type-checks and builds without any personal rooms or assets. The playground is `/play.html?room=<id>&mode=fpv`.

Python helpers need NumPy, Pillow, Open3D, SciPy and scikit-image for reconstruction; conversion scripts use the standard library. On Windows the copied scripts force UTF-8 console output.

New clone setup: `git config core.hooksPath .githooks` enables the privacy pre-commit hook.
