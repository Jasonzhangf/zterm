#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAGPIPE_DIR="${ROOT_DIR}/native/dagpipe"
SDK_LINK="${DAGPIPE_DIR}/sdk"
VENDOR_LINK="${DAGPIPE_DIR}/vendor/pipeline_runtime"

SDK_PATH="${DAGPIPE_SDK_PATH:-}"
if [[ -z "${SDK_PATH}" ]]; then
  SDK_PATH="$(dagpipe sdk path 2>/dev/null || true)"
fi
if [[ -z "${SDK_PATH}" || ! -d "${SDK_PATH}" ]]; then
  echo "dagpipe sdk path is required and must be readable: ${SDK_PATH}" >&2
  exit 1
fi

if [[ -L "${SDK_LINK}" && ! -d "${SDK_LINK}" ]]; then
  rm "${SDK_LINK}"
fi
if [[ ! -e "${SDK_LINK}" ]]; then
  mkdir -p "$(dirname "${SDK_LINK}")"
  ln -s "${SDK_PATH}" "${SDK_LINK}"
  echo "linked dagpipe sdk: ${SDK_LINK} -> ${SDK_PATH}"
fi

mkdir -p "${DAGPIPE_DIR}/vendor"
if [[ -L "${VENDOR_LINK}" && ! -d "${VENDOR_LINK}" ]]; then
  rm "${VENDOR_LINK}"
fi
if [[ ! -e "${VENDOR_LINK}" ]]; then
  ln -s "${SDK_PATH}" "${VENDOR_LINK}"
  echo "linked dagpipe vendor: ${VENDOR_LINK} -> ${SDK_PATH}"
fi
