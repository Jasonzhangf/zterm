#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAGPIPE_DIR="${ROOT_DIR}/native/dagpipe"
PROFILE="${DAGPIPE_PROFILE:-debug}"

if [[ ! -d "${DAGPIPE_DIR}" ]]; then
  echo "missing dagpipe crate: ${DAGPIPE_DIR}" >&2
  exit 1
fi

bash "${ROOT_DIR}/scripts/ensure-dagpipe-sdk.sh"
cd "${DAGPIPE_DIR}"

if [[ "${PROFILE}" == "release" ]]; then
  cargo build --release
  BUILD_DIR="target/release"
else
  cargo build
  BUILD_DIR="target/debug"
fi

if [[ -f "${BUILD_DIR}/zterm_dagpipe.dll" ]]; then
  cp "${BUILD_DIR}/zterm_dagpipe.dll" index.node
elif [[ -f "${BUILD_DIR}/libzterm_dagpipe.dylib" ]]; then
  cp "${BUILD_DIR}/libzterm_dagpipe.dylib" index.node
else
  cp "${BUILD_DIR}/libzterm_dagpipe.so" index.node
fi

echo "zterm-dagpipe native built: ${DAGPIPE_DIR}/index.node (profile=${PROFILE})"
