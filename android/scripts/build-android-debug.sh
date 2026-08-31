#!/usr/bin/env bash
set -euo pipefail

RESUME_BUILD_NUMBER=""
if [[ "$#" -eq 2 && "$1" == "--resume-build" ]]; then
  RESUME_BUILD_NUMBER="$2"
elif [[ "$#" -ne 0 ]]; then
  echo "usage: $0 [--resume-build <expected-build-number>]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APK_PATH="$ROOT_DIR/native/android/app/build/outputs/apk/debug/app-debug.apk"
APK_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/zterm-apk.XXXXXX")"
NORMAL_APK_PATH="$APK_WORK_DIR/app-normal-debug.apk"
ROLLBACK_APK_PATH="$APK_WORK_DIR/app-rollback-debug.apk"
UPDATES_DIR_DEFAULT="$HOME/.zterm/updates"
UPDATES_DIR="${WTERM_UPDATES_DIR:-$UPDATES_DIR_DEFAULT}"
RELAY_SSH_HOST="${ZTERM_RELAY_SSH_HOST:-159.75.134.56}"
RELAY_SSH_USER="${ZTERM_RELAY_SSH_USER:-root}"
RELAY_SSH_KEY="${ZTERM_RELAY_SSH_KEY:-$HOME/.ssh/claw.pem}"
RELAY_UPDATES_DIR="${ZTERM_RELAY_UPDATES_DIR:-/var/lib/zterm-traversal-relay/updates}"
RELAY_MANIFEST_URL="${ZTERM_RELAY_MANIFEST_URL:-https://relay.codewhisper.cc:18443/relay/updates/latest.json}"
PUBLISH_RELAY="${ZTERM_PUBLISH_RELAY:-false}"

cleanup() {
  rm -rf "$APK_WORK_DIR"
}
trap cleanup EXIT

source "$SCRIPT_DIR/setup-android-java.sh"

cd "$ROOT_DIR"
"$SCRIPT_DIR/ensure-pnpm-install.sh"
pnpm run deps:check-wterm-published
if [[ -n "$RESUME_BUILD_NUMBER" ]]; then
  node ./scripts/bump-build-version.mjs --resume "$RESUME_BUILD_NUMBER"
else
  node ./scripts/bump-build-version.mjs
fi
BUILD_NUMBER="$(node -p "JSON.parse(require('fs').readFileSync('./.build-meta.json', 'utf8')).buildNumber")"
pnpm run daemon:prepare-release
pnpm build
node ./scripts/verify-web-assets-version.mjs dist "$BUILD_NUMBER"
rm -rf "$ROOT_DIR/native/android/app/src/main/assets/public/assets"
npx cap sync android
node ./scripts/verify-web-assets-version.mjs native/android/app/src/main/assets/public "$BUILD_NUMBER"
cd "$ROOT_DIR/native/android"
./gradlew :capacitor-cordova-android-plugins:parseDebugLocalResources
./gradlew :capacitor-cordova-android-plugins:processDebugManifest assembleDebug
node "$ROOT_DIR/scripts/verify-web-assets-version.mjs" "$ROOT_DIR/native/android/app/build/outputs/apk/debug/app-debug.apk" "$BUILD_NUMBER"
cp "$APK_PATH" "$NORMAL_APK_PATH"
./gradlew :app:assembleDebug -PztermRollbackVariant=true
cp "$APK_PATH" "$ROLLBACK_APK_PATH"
cp "$NORMAL_APK_PATH" "$APK_PATH"

cd "$ROOT_DIR"
WTERM_UPDATES_DIR="$UPDATES_DIR" node ./scripts/prepare-update-bundle.mjs "$APK_PATH" "$ROLLBACK_APK_PATH"
node ./scripts/check-relay-default-address-leak.mjs "$ROOT_DIR/dist" "$ROOT_DIR/native/android/app/src/main/assets/public" "$APK_PATH"

echo "[build-android-debug] verify manifests"
test -f "$ROOT_DIR/update-dist/latest.json"
test -f "$ROOT_DIR/release-dist/latest.json"
test -f "$UPDATES_DIR/latest.json"
WTERM_UPDATES_DIR="$UPDATES_DIR" node ./scripts/verify-update-bundle.mjs

if [[ "$PUBLISH_RELAY" == "true" ]]; then
  echo "[build-android-debug] publish Relay update channel"
  PACKAGE_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('./package.json', 'utf8')).version")"
  BUILD_NUMBER="$(node -p "JSON.parse(require('fs').readFileSync('./.build-meta.json', 'utf8')).buildNumber")"
  NORMAL_VERSION_CODE="$(node -p "JSON.parse(require('fs').readFileSync('./update-dist/latest.json', 'utf8')).versionCode")"
  NORMAL_APK_NAME="zterm-${PACKAGE_VERSION}.${BUILD_NUMBER}.apk"
  ROLLBACK_APK_NAME="zterm-${PACKAGE_VERSION}.${BUILD_NUMBER}.1.apk"
  PREVIOUS_ROLLBACK_APK_NAME="$(node -e "const m=JSON.parse(require('fs').readFileSync('./update-dist/latest.json','utf8')); if (m.rollbackToPrevious?.apkUrl) process.stdout.write(m.rollbackToPrevious.apkUrl)")"
  RELAY_APK_NAMES=("$NORMAL_APK_NAME" "$ROLLBACK_APK_NAME" "zterm-latest-debug.apk")
  if [[ -n "$PREVIOUS_ROLLBACK_APK_NAME" ]]; then
    RELAY_APK_NAMES+=("$PREVIOUS_ROLLBACK_APK_NAME")
  fi
  scp -o IdentitiesOnly=yes -i "$RELAY_SSH_KEY" \
    "$ROOT_DIR/update-dist/latest.json" \
    "${RELAY_APK_NAMES[@]/#/$ROOT_DIR/update-dist/}" \
    "$RELAY_SSH_USER@$RELAY_SSH_HOST:$RELAY_UPDATES_DIR/"
  curl -fsS "$RELAY_MANIFEST_URL" \
    | node "$SCRIPT_DIR/verify-update-manifest-version.mjs" "$NORMAL_VERSION_CODE"
  curl -fsSI "${RELAY_MANIFEST_URL%/latest.json}/$NORMAL_APK_NAME" >/dev/null
  echo "[build-android-debug] Relay update channel published"
else
  echo "[build-android-debug] Relay update channel skipped (set ZTERM_PUBLISH_RELAY=true to publish)"
fi

echo "[build-android-debug] APK built and published to update channel"
echo "- apk: $APK_PATH"
echo "- updates dir: $UPDATES_DIR"
