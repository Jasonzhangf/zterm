#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${ZTERM_LAB_HOST:-127.0.0.1}"
PORT="${ZTERM_LAB_PORT:-45761}"
LOG_DIR="$ROOT_DIR/evidence/daemon-mirror/$(date +%F)"
LOG_FILE="$LOG_DIR/current-daemon.log"

mkdir -p "$LOG_DIR"

cd "$ROOT_DIR"

ZTERM_HOST="$HOST" \
ZTERM_PORT="$PORT" \
ZTERM_AUTH_TOKEN="" \
pnpm exec tsx src/server/server.ts >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

READY=0
for _ in $(seq 1 50); do
  if curl -fsS "http://$HOST:$PORT/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.2
done

if [ "$READY" -ne 1 ]; then
  echo "[run-daemon-mirror-lab] current daemon failed to become ready: $HOST:$PORT" >&2
  echo "[run-daemon-mirror-lab] log: $LOG_FILE" >&2
  exit 1
fi

echo "[run-daemon-mirror-lab] current daemon ready at ws://$HOST:$PORT/ws"
echo "[run-daemon-mirror-lab] log: $LOG_FILE"

ZTERM_HOST="$HOST" \
ZTERM_PORT="$PORT" \
ZTERM_AUTH_TOKEN="" \
pnpm exec tsx scripts/daemon-mirror-lab.ts "$@"
