#!/usr/bin/env bash
set -euo pipefail

BEFORE_DIR="${1:-}"
AFTER_DIR="${2:-}"
OUT_FILE="${3:-android/evidence/daemon-mirror/latency-compare-$(date +%Y-%m-%d-%H%M%S).md}"

if [[ -z "$BEFORE_DIR" || -z "$AFTER_DIR" ]]; then
  echo "Usage: $0 <before_dir> <after_dir> [out_file]"
  exit 1
fi

extract_count() {
  local file="$1"
  local pattern="$2"
  if [[ ! -f "$file" ]]; then
    echo 0
    return
  fi
  grep -cE "$pattern" "$file" || true
}

mkdir -p "$(dirname "$OUT_FILE")"

before_timeline="$BEFORE_DIR/timeline.txt"
after_timeline="$AFTER_DIR/timeline.txt"

before_send=$(extract_count "$before_timeline" "sendInput")
after_send=$(extract_count "$after_timeline" "sendInput")
before_sync=$(extract_count "$before_timeline" "buffer-sync")
after_sync=$(extract_count "$after_timeline" "buffer-sync")
before_render=$(extract_count "$before_timeline" "render commit|renderer commit")
after_render=$(extract_count "$after_timeline" "render commit|renderer commit")
before_req=$(extract_count "$before_timeline" "session\\.buffer\\.request")
after_req=$(extract_count "$after_timeline" "session\\.buffer\\.request")

cat > "$OUT_FILE" <<EOR
# Weak Network Latency Compare

- before: \
  \
  $BEFORE_DIR
- after: \
  \
  $AFTER_DIR

## Raw Marker Counts

| marker | before | after |
|---|---:|---:|
| sendInput | $before_send | $after_send |
| buffer-sync | $before_sync | $after_sync |
| render-commit | $before_render | $after_render |
| buffer-request | $before_req | $after_req |

## Gate Check

1. sendInput → buffer-sync → render commit marker existence
   - before: $( [[ $before_send -gt 0 && $before_sync -gt 0 && $before_render -gt 0 ]] && echo PASS || echo FAIL )
   - after:  $( [[ $after_send -gt 0 && $after_sync -gt 0 && $after_render -gt 0 ]] && echo PASS || echo FAIL )
2. hidden tab non-preemption (proxy: request flood)
   - before request count: $before_req
   - after request count:  $after_req

## Notes
- This comparison is structural evidence only.
- True latency delta (ms) still requires timestamped timeline with explicit interactive actions.
EOR

echo "compare report => $OUT_FILE"
