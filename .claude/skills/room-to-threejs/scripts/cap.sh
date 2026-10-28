#!/bin/zsh
# Render one view of the capture page to a PNG with agent-browser.
# usage: cap.sh <name> "<query>"       e.g. cap.sh north "view=n&ppm=180&cut=0.2"
#        cap.sh sofa "src=model&cam=0.8,1.5,-1.2&look=-1.2,0.4,1.6&fov=60&size=1300x850"
# env:   CAP_OUT (output dir, default data/captures in this project, ./captures elsewhere)  CAP_URL (default http://localhost:5173)
#        CAP_SESSION (agent-browser session name: use a distinct one per parallel worker)
#        CAP_QUERY (extra query appended to every capture, e.g. "parts=desk")
source "${0:A:h}/capture_env.sh"
OUT=$CAP_OUT
URL=${CAP_URL:-http://localhost:5173}
SESSION=$CAP_SESSION
Q="$2${CAP_QUERY:+&$CAP_QUERY}"
mkdir -p "$OUT"
fail_capture() {
  echo "FAIL (check the console below; a missing import makes Vite serve an error page)"
  agent-browser --session "$SESSION" console | tail -8
  exit 1
}
agent-browser --session "$SESSION" batch --bail "set viewport 1400 1100" "open $URL/tools/capture.html?$Q" \
  "wait --fn \"document.body.dataset.ready==='1'\"" >/dev/null 2>&1 || fail_capture
# An element screenshot does not guarantee WebGL pixels outside the viewport are captured.
# Fit the actual rendered canvas, including tall native-resolution photo comparisons.
CAP_DIMENSIONS=$(agent-browser --session "$SESSION" eval \
  '[Math.ceil(document.querySelector("#wrap").getBoundingClientRect().width),Math.ceil(document.querySelector("#wrap").getBoundingClientRect().height)]' --json) || fail_capture
CAP_VIEWPORT=$(print -r -- "$CAP_DIMENSIONS" | "${CAP_PYTHON:-python3}" -c \
  'import json,sys; r=json.load(sys.stdin); assert r["success"]; w,h=r["data"]["result"]; print(max(1,w)+40,max(1,h)+40)') || fail_capture
agent-browser --session "$SESSION" batch --bail "set viewport $CAP_VIEWPORT" \
  "screenshot #wrap $OUT/$1.png" >/dev/null 2>&1 || fail_capture
echo "$OUT/$1.png"
