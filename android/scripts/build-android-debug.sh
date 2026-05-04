#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APK_PATH="$ROOT_DIR/native/android/app/build/outputs/apk/debug/app-debug.apk"

source "$SCRIPT_DIR/setup-android-java.sh"

cd "$ROOT_DIR"
pnpm build
npx cap sync android

cd "$ROOT_DIR/native/android"
./gradlew assembleDebug

cd "$ROOT_DIR"
node ./scripts/prepare-update-bundle.mjs "$APK_PATH"

echo "[build-android-debug] APK built and published to update channel"
echo "- apk: $APK_PATH"
echo "- updates dir: $HOME/.wterm/updates"
