#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAGPIPE_DIR="${ROOT_DIR}/native/dagpipe"

bash "${ROOT_DIR}/scripts/build-dagpipe-native.sh"
bash "${ROOT_DIR}/scripts/build-dagpipe-android.sh"

JNI_SO="${ROOT_DIR}/native/android/app/src/main/jniLibs/arm64-v8a/libzterm_dagpipe.so"
if ! nm -gD "${JNI_SO}" 2>/dev/null | grep -q "Java_com_zterm_android_DagpipeCoreBridge_compilePhase0"; then
  echo "missing JNI export Java_com_zterm_android_DagpipeCoreBridge_compilePhase0 in ${JNI_SO}" >&2
  exit 1
fi

cd "${DAGPIPE_DIR}"
cargo fmt --check
cargo clippy --no-default-features -- -D warnings
cargo test --no-default-features

cd "${ROOT_DIR}"
pnpm --dir "${ROOT_DIR}" exec vitest run src/lib/dagpipe-bridge.test.ts src/lib/dagpipe-phase1-parity.test.ts --reporter dot
pnpm --dir "${ROOT_DIR}" run test:dagpipe-phase0
