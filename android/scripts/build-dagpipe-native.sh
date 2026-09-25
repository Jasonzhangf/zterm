#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAGPIPE_DIR="${ROOT_DIR}/native/dagpipe"
PROFILE="${DAGPIPE_PROFILE:-debug}"

if [[ ! -d "${DAGPIPE_DIR}" ]]; then
  echo "missing dagpipe crate: ${DAGPIPE_DIR}" >&2
  exit 1
fi

DAGPIPE_SDK_PATH="${DAGPIPE_SDK_PATH:-${HOME}/.local/share/dagpipe/sdk}"
if [[ ! -d "${DAGPIPE_SDK_PATH}" ]]; then
  echo "missing dagpipe SDK path: ${DAGPIPE_SDK_PATH}" >&2
  echo "run: dagpipe sdk path, or install the DAGpipe SDK from the DAGpipe checkout" >&2
  exit 1
fi

mkdir -p "${DAGPIPE_DIR}/vendor"
rm -rf "${DAGPIPE_DIR}/vendor/pipeline_runtime"
ln -s "${DAGPIPE_SDK_PATH}" "${DAGPIPE_DIR}/vendor/pipeline_runtime"

cd "${DAGPIPE_DIR}"

if [[ "${PROFILE}" == "release" ]]; then
  cargo build --release
  cp target/release/libzterm_dagpipe.dylib index.node
else
  cargo build
  cp target/debug/libzterm_dagpipe.dylib index.node
fi

echo "zterm-dagpipe native built: ${DAGPIPE_DIR}/index.node (profile=${PROFILE})"
