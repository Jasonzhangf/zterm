#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ANDROID_ROOT}"
pnpm exec vite build
npx cap sync android

cd native/android
source "${ANDROID_ROOT}/scripts/setup-android-java.sh"
./gradlew app:testDebugUnitTest \
  --tests com.zterm.android.AndroidConnectionServiceTransportTest \
  assembleDebug \
  --no-daemon
