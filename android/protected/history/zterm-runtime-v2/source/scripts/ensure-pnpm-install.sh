#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_ROOT="$(cd "${ROOT_DIR}/.." && pwd)"
MODULES_STATE="${WORKSPACE_ROOT}/node_modules/.modules.yaml"
LOCKFILE="${WORKSPACE_ROOT}/pnpm-lock.yaml"
ROOT_PACKAGE="${WORKSPACE_ROOT}/package.json"
ANDROID_PACKAGE="${ROOT_DIR}/package.json"

needs_install=0
if [[ ! -f "${MODULES_STATE}" ]]; then
  needs_install=1
elif [[ "${LOCKFILE}" -nt "${MODULES_STATE}" || "${ROOT_PACKAGE}" -nt "${MODULES_STATE}" || "${ANDROID_PACKAGE}" -nt "${MODULES_STATE}" ]]; then
  needs_install=1
fi

if [[ "${needs_install}" == "0" ]]; then
  echo "[ensure-pnpm-install] dependencies already installed"
  exit 0
fi

echo "[ensure-pnpm-install] installing workspace dependencies"
cd "${WORKSPACE_ROOT}"
pnpm install --frozen-lockfile
