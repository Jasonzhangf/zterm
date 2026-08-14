#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_BIN="${HOME}/.local/bin"
TARGET="${LOCAL_BIN}/zterm-herdr"

mkdir -p "$LOCAL_BIN"
ln -sf "${SCRIPT_DIR}/zterm-herdr.sh" "$TARGET"
chmod +x "${SCRIPT_DIR}/zterm-herdr.sh"
echo "Installed ${TARGET}"
echo "Run: ${TARGET} --help"
