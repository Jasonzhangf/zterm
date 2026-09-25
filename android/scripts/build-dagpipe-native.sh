#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAGPIPE_DIR="${ROOT_DIR}/native/dagpipe"
PROFILE="${DAGPIPE_PROFILE:-debug}"

if [[ ! -d "${DAGPIPE_DIR}" ]]; then
  echo "missing dagpipe crate: ${DAGPIPE_DIR}" >&2
  exit 1
fi

cd "${DAGPIPE_DIR}"

if [[ "${PROFILE}" == "release" ]]; then
  cargo build --release
  cp target/release/libzterm_dagpipe.dylib index.node
else
  cargo build
  cp target/debug/libzterm_dagpipe.dylib index.node
fi

echo "zterm-dagpipe native built: ${DAGPIPE_DIR}/index.node (profile=${PROFILE})"
