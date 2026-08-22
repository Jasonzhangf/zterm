#!/usr/bin/env bash
set -euo pipefail

DEVICE="${1:-100.127.23.27:1234}"
APP_PKG="com.zterm.android"
APP_ACT="com.zterm.android/.MainActivity"
DAEMON_URL="${DAEMON_URL:-http://100.66.1.82:3333}"
TS="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="android/evidence/daemon-mirror/${TS}-tab-persist-kill-verify"
mkdir -p "$OUT_DIR"

echo "[1/7] capture before runtime logs"
/usr/bin/curl -s -X POST -H 'Content-Type: application/json' -d '{"enabled":true}' "$DAEMON_URL/debug/runtime/control" > "$OUT_DIR/runtime-control-before.json" || true
/usr/bin/curl -s "$DAEMON_URL/debug/runtime/logs?limit=3000" > "$OUT_DIR/runtime-before.json" || true

echo "[2/7] force-stop app"
adb -s "$DEVICE" shell am force-stop "$APP_PKG"

sleep 1

echo "[3/7] cold start app"
adb -s "$DEVICE" shell am start -W -n "$APP_ACT" > "$OUT_DIR/app-restart.txt" 2>&1 || true

sleep 4

echo "[4/7] capture after runtime logs"
/usr/bin/curl -s "$DAEMON_URL/debug/runtime/logs?limit=4000" > "$OUT_DIR/runtime-after.json" || true

echo "[5/7] capture ui dump"
adb -s "$DEVICE" exec-out screencap -p > "$OUT_DIR/screen-after-restart.png" || true
adb -s "$DEVICE" shell uiautomator dump /sdcard/zterm-ui-after.xml >/dev/null 2>&1 || true
adb -s "$DEVICE" pull /sdcard/zterm-ui-after.xml "$OUT_DIR/ui-after.xml" >/dev/null 2>&1 || true

echo "[6/7] extract open-tabs scopes"
python3 - <<'PY' "$OUT_DIR"
import json,sys,pathlib
out=pathlib.Path(sys.argv[1])
path=out/'runtime-after.json'
try:
    data=json.load(open(path))
except Exception:
    data={'entries':[]}
entries=data.get('entries',[])
interesting=[e for e in entries if 'open-tabs' in str(e.get('scope','')) or 'session-group' in str(e.get('scope',''))]
(out/'open-tabs-events.json').write_text(json.dumps(interesting,ensure_ascii=False,indent=2))
summary={
  'event_count': len(interesting),
  'scopes': sorted({str(e.get('scope','')) for e in interesting}),
}
(out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
print(json.dumps(summary,ensure_ascii=False,indent=2))
PY

echo "[7/7] done -> $OUT_DIR"
