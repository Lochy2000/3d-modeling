#!/bin/zsh
# Scan (left) vs rebuilt model (right) from the same camera, stitched into <name>-cmp.png.
# usage: cmp.sh <name> "<camera query without src>"   e.g. cmp.sh fireplace "cam=0.2,1.4,0&look=3.1,1.2,-0.1&fov=62&size=1300x850"
DIR=${0:A:h}
source "$DIR/capture_env.sh"
OUT=$CAP_OUT
$DIR/cap.sh $1-scan "src=scan&$2" >/dev/null && $DIR/cap.sh $1-model "src=model&$2" >/dev/null || { echo FAIL; exit 1; }
"${CAP_PYTHON:-python3}" - "$OUT/$1" <<'PY'
import sys
from PIL import Image
b = sys.argv[1]
a = Image.open(b + '-scan.png').convert('RGB'); m = Image.open(b + '-model.png').convert('RGB')
# cap.sh captures the exact canvas wrapper, including legitimate black/empty scan regions.
if a.size != m.size: raise ValueError(f'Camera frame mismatch: {a.size} vs {m.size}')
s = 0.5 if a.width > 900 else 1
a, m = a.resize((int(a.width * s), int(a.height * s))), m.resize((int(m.width * s), int(m.height * s)))
out = Image.new('RGB', (a.width * 2 + 6, a.height), 'white'); out.paste(a, (0, 0)); out.paste(m, (a.width + 6, 0))
out.save(b + '-cmp.png'); print(b + '-cmp.png')
PY
