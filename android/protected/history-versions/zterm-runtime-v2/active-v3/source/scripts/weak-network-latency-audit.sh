#!/usr/bin/env bash
set -euo pipefail
PHASE="${1:-after}"
TS="$(date +%Y-%m-%d-%H%M%S)"
OUT_DIR="android/evidence/daemon-mirror/${TS}-${PHASE}-latency"
mkdir -p "$OUT_DIR"

echo "[1/6] git head + status"
{
  echo "phase=$PHASE"
  echo "timestamp=$TS"
  git -C /Volumes/extension/code/zterm rev-parse HEAD
  git -C /Volumes/extension/code/zterm status --short
} > "$OUT_DIR/summary.txt"

echo "[2/6] vitest"
(
  cd android
  pnpm -s vitest run src/contexts/session-context-activity-runtime.test.ts src/contexts/session-context-buffer-runtime.test.ts
) | tee "$OUT_DIR/vitest.txt"

echo "[3/6] adb logcat (45s real-time capture)"
adb logcat -c 2>/dev/null || true
adb logcat -v threadtime | tee "$OUT_DIR/logcat.txt" &
ADBPID=$!
cleanup() { kill $ADBPID 2>/dev/null || true; }
trap cleanup EXIT
sleep 45
kill $ADBPID 2>/dev/null || true
wait $ADBPID 2>/dev/null || true
echo "[4/6] extract timeline"
grep -aE "session\.input\.(send|skip|transport-unavailable)|session\.buffer\.(head|pull\.reset|pull\.request|pull\.stale|pull\.superseded|applied|request\.debounced|window\.invalid|revision-reset)|session\.transport\.(ws\.(connect|reconnect|probe)|control\.(open|session-open)|explicit-resume|active-resume|active-reentry|tab-switch)" "$OUT_DIR/logcat.txt" > "$OUT_DIR/timeline.txt" || true

echo "[5/6] metrics"
python3 - <<'PY'
import json, re
from pathlib import Path
out = Path("/dev/null")
for d in sorted(Path("android/evidence/daemon-mirror").iterdir()):
    if d.is_dir() and (d/"logcat.txt").exists() and (d/"logcat.txt").stat().st_size > 1024:
        out = d
OUT_TS = sorted(Path("android/evidence/daemon-mirror").iterdir())
for d in OUT_TS:
    if d.is_dir() and d.name.endswith(f"-{'$PHASE'}-latency"):
        out = d
        break
tl = (out/"timeline.txt").read_text(errors="ignore") if (out/"timeline.txt").exists() else ""
counts = {
    "input.send":     len(re.findall(r"session\.input\.send", tl)),
    "buffer.head":    len(re.findall(r"session\.buffer\.head\b", tl)),
    "buffer.pull.reset": len(re.findall(r"session\.buffer\.pull\.reset", tl)),
    "buffer.request":  len(re.findall(r"session\.buffer\.request(?!\.)", tl)),
    "buffer.applied": len(re.findall(r"session\.buffer\.applied", tl)),
    "tab-switch":     len(re.findall(r"tab-switch", tl)),
    "active-resume":  len(re.findall(r"active-resume|explicit-resume|active-reentry", tl)),
    "transport.probe":len(re.findall(r"transport\.ws\.(connect|reconnect|probe)", tl)),
}
counts["log_lines"] = len((out/"logcat.txt").read_text(errors="ignore").splitlines()) if (out/"logcat.txt").exists() else 0
counts["dir"] = str(out)
print(json.dumps(counts, indent=2))
with open("android/evidence/daemon-mirror/latest-metrics.json","w") as f:
    json.dump(counts, f, indent=2)
PY

echo "[6/6] checklist + done"
cat > "$OUT_DIR/checklist.txt" << 'EOC'
Gate checks:
1. input.send > 0 AND buffer.applied > 0
2. tab-switch > 0 AND buffer.pull.reset > 0
3. buffer.request not flooding
EOC
echo "=> $OUT_DIR"
