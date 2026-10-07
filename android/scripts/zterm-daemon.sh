#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(python3 - "$ROOT_DIR" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
NODE_BIN="$(command -v node)"
PACKAGE_VERSION="$("$NODE_BIN" -p "require('${ROOT_DIR}/package.json').version")"
INSTALLED_SUPPORT="${HOME}/.zterm/releases/zterm-daemon/${PACKAGE_VERSION}/support/zterm-daemon.sh"

if [[ ! -f "${INSTALLED_SUPPORT}" ]]; then
  echo "zterm-daemon: installed support script not found at ${INSTALLED_SUPPORT}" >&2
  echo "run daemon:install-global first" >&2
  exit 1
fi

exec bash "${INSTALLED_SUPPORT}" "$@"
