#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MAC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TSX_BIN="$MAC_DIR/node_modules/.bin/tsx"

if [[ ! -x "$TSX_BIN" ]]; then
  echo "[run-daemon-loopback] tsx not found at $TSX_BIN" >&2
  exit 1
fi

HOST="${ZTERM_LAB_HOST:-127.0.0.1}"
PORT="${ZTERM_LAB_PORT:-3333}"
TOKEN="${ZTERM_AUTH_TOKEN:-wterm-4123456}"

echo "[run-daemon-loopback] host=$HOST port=$PORT"

exec "$TSX_BIN" "$SCRIPT_DIR/daemon-loopback.ts" \
  --host="$HOST" --port="$PORT" --token="$TOKEN" "$@"
