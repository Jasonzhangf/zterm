#!/usr/bin/env bash
set -euo pipefail
if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found" >&2
  exit 1
fi

rounds="${1:-3}"

current_ime=$(adb shell settings get secure default_input_method 2>/dev/null || echo unknown)
echo "[ime] current=$current_ime"
adb shell ime set com.android.inputmethod.latin/.LatinIME >/dev/null 2>&1 || adb shell ime set com.android.inputmethod.latin.LatinIME >/dev/null 2>&1 || true

focus_terminal() {
  adb shell wm size | awk -F'[:x ]+' '/Physical size/{print $4, $5}' | {
    read -r W H
    [[ -z "${W:-}" || -z "${H:-}" ]] && W=1080 && H=2400
    X=$((W/2)); Y=$((H/2))
    adb shell input tap "$X" "$Y" >/dev/null 2>&1 || true
  }
  sleep 0.3
}

adb shell monkey -p com.zterm.android -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
sleep 1

for r in $(seq 1 "$rounds"); do
  echo "[round $r]"
  focus_terminal
  for i in 1 2 3 4 5 6 7; do
    focus_terminal
    payload="r${r}x${i}"
    adb shell input text "$payload" >/dev/null 2>&1 || true
    adb shell input keyevent 66 >/dev/null 2>&1 || true
    sleep 0.5
  done

  adb shell input swipe 900 1200 200 1200 180 >/dev/null 2>&1 || true
  sleep 0.3
  adb shell input swipe 200 1200 900 1200 180 >/dev/null 2>&1 || true
  sleep 0.3
  adb shell input keyevent 3 >/dev/null 2>&1 || true
  sleep 1
  adb shell monkey -p com.zterm.android -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  sleep 1
done

adb shell ime set "$current_ime" >/dev/null 2>&1 || true
echo "drive-input done rounds=$rounds"
