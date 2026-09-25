#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAGPIPE_DIR="${ROOT_DIR}/native/dagpipe"
SDK_LINK="${DAGPIPE_DIR}/sdk"

if [[ -L "${SDK_LINK}" ]]; then
  if [[ -d "${SDK_LINK}" ]]; then
    exit 0
  fi
  rm "${SDK_LINK}"
fi

SDK_PATH="$(dagpipe sdk path 2>/dev/null || true)"
if [[ -z "${SDK_PATH}" || ! -d "${SDK_PATH}" ]]; then
  echo "dagpipe sdk path is required and must be readable: ${SDK_PATH}" >&2
  exit 1
fi

ln -s "${SDK_PATH}" "${SDK_LINK}"
echo "linked dagpipe sdk: ${SDK_LINK} -> ${SDK_PATH}"
