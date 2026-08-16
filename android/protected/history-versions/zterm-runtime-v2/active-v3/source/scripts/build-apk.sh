#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$SCRIPT_DIR/setup-android-java.sh"

cd "$ROOT_DIR"
pnpm build
npx cap sync android
(
  cd native/android
  ./gradlew assembleDebug
)

echo "APK ready:"
echo "$ROOT_DIR/native/android/app/build/outputs/apk/debug/app-debug.apk"
