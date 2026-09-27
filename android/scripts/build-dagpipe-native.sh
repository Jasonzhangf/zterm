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
  if [[ -f target/release/libzterm_dagpipe.dylib ]]; then
    cp target/release/libzterm_dagpipe.dylib index.node
  else
    cp target/release/libzterm_dagpipe.so index.node
  fi
else
  cargo build
  if [[ -f target/debug/libzterm_dagpipe.dylib ]]; then
    cp target/debug/libzterm_dagpipe.dylib index.node
  else
    cp target/debug/libzterm_dagpipe.so index.node
  fi
fi

echo "zterm-dagpipe native built: ${DAGPIPE_DIR}/index.node (profile=${PROFILE})"
