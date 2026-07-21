#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APK_PATH="$ROOT_DIR/native/android/app/build/outputs/apk/debug/app-debug.apk"
UPDATES_DIR_DEFAULT="$HOME/.zterm/updates"
UPDATES_DIR="${WTERM_UPDATES_DIR:-$UPDATES_DIR_DEFAULT}"

source "$SCRIPT_DIR/setup-android-java.sh"

cd "$ROOT_DIR"
"$SCRIPT_DIR/ensure-pnpm-install.sh"
pnpm run deps:check-wterm-published
pnpm build
pnpm run daemon:prepare-release
rm -rf "$ROOT_DIR/native/android/app/src/main/assets/public/assets"
npx cap sync android
cd "$ROOT_DIR/native/android"
./gradlew :capacitor-cordova-android-plugins:parseDebugLocalResources
./gradlew :capacitor-cordova-android-plugins:processDebugManifest assembleDebug

cd "$ROOT_DIR"
WTERM_UPDATES_DIR="$UPDATES_DIR" node ./scripts/prepare-update-bundle.mjs "$APK_PATH"
node ./scripts/check-relay-default-address-leak.mjs "$ROOT_DIR/dist" "$ROOT_DIR/native/android/app/src/main/assets/public" "$APK_PATH"

echo "[build-android-debug] verify manifests"
test -f "$ROOT_DIR/update-dist/latest.json"
test -f "$ROOT_DIR/release-dist/latest.json"
test -f "$UPDATES_DIR/latest.json"
WTERM_UPDATES_DIR="$UPDATES_DIR" node ./scripts/verify-update-bundle.mjs

echo "[build-android-debug] APK built and published to update channel"
echo "- apk: $APK_PATH"
echo "- updates dir: $UPDATES_DIR"
