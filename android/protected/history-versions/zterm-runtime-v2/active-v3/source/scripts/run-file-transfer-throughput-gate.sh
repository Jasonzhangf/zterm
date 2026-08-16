#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ANDROID_ROOT}"
pnpm exec vitest run \
  src/components/terminal/FileTransferSheet.test.tsx \
  src/lib/file-transfer-session-runtime.test.ts \
  src/lib/file-transfer-throughput-contract.test.ts \
  src/lib/file-transfer-throughput-runtime.test.ts \
  src/server/terminal-file-transfer-binary-runtime.test.ts \
  src/server/file-transfer-throughput-loopback.test.ts \
  src/server/server.file-transfer-truth.test.ts \
  --reporter dot

cd "${ANDROID_ROOT}/native/android"
source "${ANDROID_ROOT}/scripts/setup-android-java.sh"
./gradlew app:testDebugUnitTest \
  --tests com.zterm.android.StorageFileWriteLogicTest \
  --no-daemon
