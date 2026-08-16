#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK_PATH="${1:-$ROOT_DIR/native/android/app/build/outputs/apk/debug/app-debug.apk}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found"
  exit 1
fi

if [ ! -f "$APK_PATH" ]; then
  echo "apk not found: $APK_PATH"
  exit 1
fi

adb install -r "$APK_PATH"
echo "installed: $APK_PATH"
