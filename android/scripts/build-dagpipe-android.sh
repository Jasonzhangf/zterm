#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAGPIPE_DIR="${ROOT_DIR}/native/dagpipe"
SDK_ROOT="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
NDK="${ANDROID_NDK_HOME:-}"
if [[ -z "${NDK}" ]]; then
  shopt -s nullglob
  ndk_candidates=("${SDK_ROOT}"/ndk/*)
  shopt -u nullglob
  if [[ ${#ndk_candidates[@]} -gt 0 ]]; then
    NDK="$(printf '%s\n' "${ndk_candidates[@]}" | sort -V | tail -n 1)"
  fi
fi
if [[ -z "${NDK}" ]]; then
  echo "missing Android NDK; set ANDROID_NDK_HOME or install one under ${SDK_ROOT}/ndk" >&2
  exit 1
fi
TOOLCHAIN="${NDK}/toolchains/llvm/prebuilt/darwin-x86_64"
CLANG="${TOOLCHAIN}/bin/aarch64-linux-android24-clang"
LLVM_AR="${TOOLCHAIN}/bin/llvm-ar"
JNI_LIBS="${ROOT_DIR}/native/android/app/src/main/jniLibs/arm64-v8a"

if [[ ! -x "${CLANG}" ]]; then
  echo "missing Android NDK clang: ${CLANG}" >&2
  exit 1
fi

bash "${ROOT_DIR}/scripts/ensure-dagpipe-sdk.sh"
cd "${DAGPIPE_DIR}"
CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="${CLANG}" \
CC_aarch64_linux_android="${CLANG}" \
AR_aarch64_linux_android="${LLVM_AR}" \
cargo build --offline --target aarch64-linux-android --no-default-features --features android-jni

mkdir -p "${JNI_LIBS}"
cp target/aarch64-linux-android/debug/libzterm_dagpipe.so "${JNI_LIBS}/libzterm_dagpipe.so"
echo "zterm-dagpipe android built: ${JNI_LIBS}/libzterm_dagpipe.so"
