#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR_REAL="$(python3 - "$ROOT_DIR" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
NODE_BIN="$(command -v node)"
PACKAGE_VERSION="$("$NODE_BIN" -p "require('${ROOT_DIR_REAL}/package.json').version")"
TARGET_OS="darwin"
TARGET_ARCH="$(uname -m)"
PREPARE_RELEASE_SCRIPT="${ROOT_DIR_REAL}/scripts/prepare-global-daemon-release.sh"
RELEASE_INSTALLER="${ROOT_DIR_REAL}/release-dist/zterm-daemon-${PACKAGE_VERSION}-${TARGET_OS}-${TARGET_ARCH}/bin/install-global.sh"

bash "$PREPARE_RELEASE_SCRIPT"

if [[ ! -x "${RELEASE_INSTALLER}" ]]; then
  echo "missing daemon release installer: ${RELEASE_INSTALLER}" >&2
  exit 1
fi

bash "${RELEASE_INSTALLER}"
