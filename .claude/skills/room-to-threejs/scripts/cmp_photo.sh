#!/bin/zsh
# Real photo (left) vs the model rendered from that photo's exact camera (right).
# usage: cmp_photo.sh <room-id> <photo index...>     e.g. cmp_photo.sh office 0 5 13
#   env: CAP_OUT, CAP_URL (as cap.sh), PHOTO_DIR (default $PHOTO_ROOT/<room-id>/photos, upright JPEGs)
DIR=${0:A:h}
source "$DIR/capture_env.sh"
OUT=$CAP_OUT
ROOM=$1; shift
PHOTOS=${PHOTO_DIR:-$PHOTO_ROOT/$ROOM/photos}
FAILED=0
for N in "$@"; do
  $DIR/cap.sh ph-$ROOM-$N-model "room=$ROOM&src=model&photo=$N&size=540" >/dev/null || { echo "FAIL render $N"; FAILED=1; continue; }
  "${CAP_PYTHON:-python3}" - "$OUT/ph-$ROOM-$N" "$PHOTOS" "$N" <<'PY' || FAILED=1
import sys, json, glob
from PIL import Image
base, photos, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
files = sorted(glob.glob(f'{photos}/*.jpg'))
ph = Image.open(files[n]).convert('RGB')
m = Image.open(base + '-model.png').convert('RGB')
# cap.sh captures #wrap exactly. Never crop black scene pixels: that changes the camera framing.
ph = ph.resize((int(ph.width * m.height / ph.height), m.height))
out = Image.new('RGB', (ph.width + m.width + 6, m.height), 'white')
out.paste(ph, (0, 0)); out.paste(m, (ph.width + 6, 0))
out.save(base + '-cmp.jpg', quality=85)
print(base + '-cmp.jpg')
PY
done

exit "$FAILED"
