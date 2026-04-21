#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APK_PATH="$ROOT_DIR/native/android/app/build/outputs/apk/debug/app-debug.apk"

if [[ -z "${JAVA_HOME:-}" ]] && command -v brew >/dev/null 2>&1; then
  if brew --prefix openjdk@21 >/dev/null 2>&1; then
    export JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
  fi
fi

if [[ -z "${JAVA_HOME:-}" ]]; then
  echo "JAVA_HOME is not set. Install JDK 21 or export JAVA_HOME before building Android."
  exit 1
fi

export PATH="$JAVA_HOME/bin:$PATH"

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
