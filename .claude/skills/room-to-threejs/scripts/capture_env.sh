# Shared defaults. Source from the capture scripts; explicit environment values win.
# Search upwards from the working directory for this project's reorganized layout.
SCAN_PROJECT_ROOT=""
scan_dir="$PWD"
while [[ "$scan_dir" != / ]]; do
  if [[ -f "$scan_dir/apps/room-viewer/vite.config.ts" && -d "$scan_dir/packages/room-runtime" ]]; then
    SCAN_PROJECT_ROOT="$scan_dir"
    break
  fi
  scan_dir="${scan_dir:h}"
done
if [[ -n "$SCAN_PROJECT_ROOT" ]]; then
  : ${CAP_OUT:="$SCAN_PROJECT_ROOT/data/captures"}
  : ${PHOTO_ROOT:="$SCAN_PROJECT_ROOT/data/web-assets"}
else
  : ${CAP_OUT:="$PWD/captures"}
  : ${PHOTO_ROOT:="$PWD/public"}
fi
: ${CAP_URL:=http://localhost:5173}
: ${CAP_SESSION:=scan-to-threejs}
