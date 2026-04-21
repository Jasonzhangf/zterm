#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(python3 - "$ROOT_DIR" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
NODE_BIN="$(command -v node)"
LOG_DIR="${HOME}/.wterm/logs"
WTERM_HOME="${HOME}/.wterm"
WTERM_BIN_DIR="${WTERM_HOME}/bin"
LAUNCH_RUNNER="${WTERM_BIN_DIR}/wterm-daemon-launchd-run"
DIRECT_RUNNER="${WTERM_BIN_DIR}/wterm-daemon-run"
LAUNCH_AGENT_LABEL="com.zterm.android.daemon"
LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
LEGACY_LAUNCH_AGENT_LABEL="com.wterm.mobile.daemon"
LEGACY_LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${LEGACY_LAUNCH_AGENT_LABEL}.plist"
read_config() {
  cd "$ROOT_DIR"
  "$NODE_BIN" --import tsx <<'EOF'
import {
  resolveDaemonRuntimeConfig,
} from './src/server/daemon-config.ts';
import { WTERM_CONFIG_DISPLAY_PATH } from './src/lib/mobile-config.ts';

const config = resolveDaemonRuntimeConfig();
console.log(`HOST=${config.host}`);
console.log(`PORT=${config.port}`);
console.log(`SESSION_NAME=${config.sessionName}`);
console.log(`AUTH_SOURCE=${config.authSource}`);
console.log(`CONFIG_FOUND=${config.configFound ? '1' : '0'}`);
console.log(`CONFIG_DISPLAY_PATH=${WTERM_CONFIG_DISPLAY_PATH}`);
EOF
}

eval "$(read_config)"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/zterm-daemon.sh run
  ./scripts/zterm-daemon.sh start
  ./scripts/zterm-daemon.sh status
  ./scripts/zterm-daemon.sh stop
  ./scripts/zterm-daemon.sh restart
  ./scripts/zterm-daemon.sh install-service
  ./scripts/zterm-daemon.sh uninstall-service
  ./scripts/zterm-daemon.sh service-status
  wterm daemon start|stop|restart|status|install-service|uninstall-service|service-status

Behavior:
  - `run` keeps daemon in foreground (for launchd autostart)
  - start/stop/restart manage launchd service if installed, otherwise fallback to tmux daemon session
  - host / port / auth token are read from ~/.wterm/config.json
  - env still overrides config when explicitly provided
EOF
}

service_installed() {
  [[ -f "$LAUNCH_AGENT_PATH" ]]
}

service_loaded() {
  launchctl print "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1
}

legacy_service_loaded() {
  launchctl print "gui/$(id -u)/${LEGACY_LAUNCH_AGENT_LABEL}" >/dev/null 2>&1
}

service_snapshot() {
  launchctl print "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" 2>/dev/null || true
}

wait_for_service_ready() {
  local attempts=0
  local max_attempts=30

  while (( attempts < max_attempts )); do
    if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
    attempts=$((attempts + 1))
  done

  return 1
}

run_foreground() {
  mkdir -p "$LOG_DIR"
  cd "$ROOT_DIR"
  chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper ../node_modules/node-pty/prebuilds/darwin-*/spawn-helper 2>/dev/null || true
  exec env -u TMUX -u TMUX_PANE HOST="$HOST" PORT="$PORT" ZTERM_HOST="$HOST" ZTERM_PORT="$PORT" ZTERM_AUTH_TOKEN="${ZTERM_AUTH_TOKEN:-}" "$NODE_BIN" --import tsx src/server/server.ts
}

status_tmux() {
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "zterm daemon running: session=${SESSION_NAME} host=${HOST} port=${PORT} auth=${AUTH_SOURCE}"
    return 0
  fi

  echo "zterm daemon not running (${PORT})"
  echo "config=${CONFIG_DISPLAY_PATH} found=${CONFIG_FOUND} auth=${AUTH_SOURCE}"
  return 1
}

status_service() {
  if ! service_installed; then
    echo "zterm autostart service not installed"
    echo "plist=${LAUNCH_AGENT_PATH}"
    return 1
  fi

  local snapshot last_exit active_count
  snapshot="$(service_snapshot)"
  last_exit="$(printf '%s\n' "$snapshot" | awk '/last exit code =/ { print $5; exit }')"
  active_count="$(printf '%s\n' "$snapshot" | awk '/active count =/ { print $4; exit }')"

  if [[ "${active_count:-0}" != "0" ]]; then
    echo "zterm autostart service running: label=${LAUNCH_AGENT_LABEL} host=${HOST} port=${PORT} auth=${AUTH_SOURCE}"
    echo "plist=${LAUNCH_AGENT_PATH}"
    echo "active_count=${active_count:-unknown} last_exit=${last_exit:-unknown}"
    return 0
  fi

  echo "zterm autostart service installed but inactive: label=${LAUNCH_AGENT_LABEL}"
  echo "plist=${LAUNCH_AGENT_PATH}"
  echo "active_count=${active_count:-unknown} last_exit=${last_exit:-unknown}"
  return 1
}

status() {
  if service_installed; then
    status_service
    return $?
  fi

  status_tmux
}

start_tmux() {
  mkdir -p "$LOG_DIR"
  local timestamp log_file
  timestamp="$(date +%Y%m%d-%H%M%S)"
  log_file="${LOG_DIR}/tmux-bridge-${PORT}-${timestamp}.log"

  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "zterm daemon already running: session=${SESSION_NAME} host=${HOST} port=${PORT} auth=${AUTH_SOURCE}"
    echo "log dir: ${LOG_DIR}"
    return 0
  fi

  cd "$ROOT_DIR"
  chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper ../node_modules/node-pty/prebuilds/darwin-*/spawn-helper 2>/dev/null || true

  tmux new-session -d -s "$SESSION_NAME" \
    "cd '$ROOT_DIR' && env -u TMUX -u TMUX_PANE HOST='$HOST' PORT='$PORT' ZTERM_HOST='$HOST' ZTERM_PORT='$PORT' ZTERM_AUTH_TOKEN='${ZTERM_AUTH_TOKEN:-}' '$NODE_BIN' --import tsx src/server/server.ts >>'$log_file' 2>&1"

  echo "zterm daemon started"
  echo "session=${SESSION_NAME}"
  echo "host=${HOST}"
  echo "port=${PORT}"
  echo "auth=${AUTH_SOURCE}"
  echo "config=${CONFIG_DISPLAY_PATH}"
  echo "log=${log_file}"
}

stop_tmux() {
  if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "zterm daemon not running (${PORT})"
    return 0
  fi

  tmux kill-session -t "$SESSION_NAME"
  echo "zterm daemon stopped: session=${SESSION_NAME}"
}

write_launch_agent() {
  mkdir -p "${HOME}/Library/LaunchAgents" "$LOG_DIR" "$WTERM_BIN_DIR"
cat > "$DIRECT_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${ROOT_DIR}"
chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper ../node_modules/node-pty/prebuilds/darwin-*/spawn-helper 2>/dev/null || true
exec env -u TMUX -u TMUX_PANE "${NODE_BIN}" --import tsx src/server/server.ts
EOF
  chmod +x "$DIRECT_RUNNER"
cat > "$LAUNCH_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${ROOT_DIR}"
chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper ../node_modules/node-pty/prebuilds/darwin-*/spawn-helper 2>/dev/null || true
exec env -u TMUX -u TMUX_PANE "${NODE_BIN}" --import tsx src/server/server.ts
EOF
  chmod +x "$LAUNCH_RUNNER"
  cat > "$LAUNCH_AGENT_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${LAUNCH_RUNNER}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/launchd-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/launchd-stderr.log</string>
</dict>
</plist>
EOF
}

stop_legacy_service() {
  if legacy_service_loaded; then
    launchctl bootout "gui/$(id -u)" "$LEGACY_LAUNCH_AGENT_PATH" || launchctl bootout "gui/$(id -u)/${LEGACY_LAUNCH_AGENT_LABEL}" || true
  fi
}

start_service() {
  if ! service_installed; then
    echo "zterm autostart service not installed"
    echo "run: ./scripts/zterm-daemon.sh install-service"
    return 1
  fi

  stop_tmux >/dev/null 2>&1 || true
  stop_legacy_service

  if service_loaded; then
    launchctl kickstart -k "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  else
    launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_PATH"
    launchctl kickstart -k "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi

  wait_for_service_ready || true
  status_service
}

stop_service() {
  if ! service_installed; then
    echo "zterm autostart service not installed"
    return 0
  fi

  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi

  echo "zterm autostart service stopped: label=${LAUNCH_AGENT_LABEL}"
}

restart_service() {
  if ! service_installed; then
    echo "zterm autostart service not installed"
    echo "run: ./scripts/zterm-daemon.sh install-service"
    return 1
  fi

  stop_tmux >/dev/null 2>&1 || true
  stop_legacy_service

  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_PATH"
  launchctl kickstart -k "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  wait_for_service_ready || true
  status_service
}

install_service() {
  stop_tmux >/dev/null 2>&1 || true
  stop_legacy_service
  write_launch_agent
  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_PATH"
  launchctl kickstart -k "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  echo "zterm autostart service installed"
  echo "plist=${LAUNCH_AGENT_PATH}"
  wait_for_service_ready || true
  status_service
}

uninstall_service() {
  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi
  rm -f "$LAUNCH_AGENT_PATH"
  echo "zterm autostart service uninstalled"
  echo "plist=${LAUNCH_AGENT_PATH}"
}

start() {
  if service_installed; then
    start_service
    return
  fi
  start_tmux
}

stop() {
  if service_installed; then
    stop_service
    return
  fi
  stop_tmux
}

restart() {
  if service_installed; then
    restart_service
    return
  fi
  stop_tmux
  start_tmux
}

cmd="${1:-}"
if [[ "$cmd" == "--" ]]; then
  shift
  cmd="${1:-}"
fi

case "$cmd" in
  run) run_foreground ;;
  start) start ;;
  status) status ;;
  stop) stop ;;
  restart) restart ;;
  install-service) install_service ;;
  uninstall-service) uninstall_service ;;
  service-status) status_service ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    echo "unknown command: $cmd" >&2
    usage >&2
    exit 1
    ;;
esac
