#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_ROOT="$(python3 - "$PACKAGE_ROOT" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
NODE_BIN="$(command -v node)"
LOG_DIR="${HOME}/.wterm/logs"
WTERM_HOME="${HOME}/.wterm"
WTERM_BIN_DIR="${WTERM_HOME}/bin"
RUNTIME_STATE_DIR="${WTERM_HOME}/run"
RUNTIME_DIR="${PACKAGE_ROOT}/runtime"
DAEMON_PID_FILE="${RUNTIME_STATE_DIR}/zterm-daemon.pid"
DIRECT_RUNNER="${WTERM_BIN_DIR}/zterm-daemon-run"
LAUNCH_RUNNER="${WTERM_BIN_DIR}/zterm-daemon-launchd-run"
LAUNCH_AGENT_LABEL="com.zterm.android.zterm-daemon"
LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
PREVIOUS_LAUNCH_AGENT_LABEL="com.zterm.android.daemon"
PREVIOUS_LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${PREVIOUS_LAUNCH_AGENT_LABEL}.plist"
LEGACY_LAUNCH_AGENT_LABEL="com.wterm.mobile.daemon"
LEGACY_LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${LEGACY_LAUNCH_AGENT_LABEL}.plist"
STAGED_DAEMON_ENTRY="${RUNTIME_DIR}/server.cjs"
STAGED_NODE_PTY_HELPER_GLOB="${RUNTIME_DIR}/node_modules/node-pty/prebuilds/darwin-*/spawn-helper"

read_config() {
  "$NODE_BIN" <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_BRIDGE_PORT = 3333;
const DEFAULT_DAEMON_HOST = '0.0.0.0';
const home = os.homedir();
const configPath = path.join(home, '.wterm', 'config.json');
let config = {};
let found = false;
if (fs.existsSync(configPath)) {
  found = true;
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}
const daemonConfig = ((config.zterm || {}).android || {}).daemon || ((config.mobile || {}).daemon || {});
const env = process.env;
const asString = (value) => typeof value === 'string' ? value.trim() : '';
const asPositiveInteger = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.floor(value));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return Math.max(1, parsed);
  }
  return undefined;
};
const host = asString(env.ZTERM_HOST) || asString(env.HOST) || asString(daemonConfig.host) || DEFAULT_DAEMON_HOST;
const port = asPositiveInteger(env.ZTERM_PORT) || asPositiveInteger(env.PORT) || asPositiveInteger(daemonConfig.port) || DEFAULT_BRIDGE_PORT;
const authTokenFromEnv = asString(env.ZTERM_AUTH_TOKEN);
const authTokenFromConfig = asString(daemonConfig.authToken);
const authSource = authTokenFromEnv ? 'env' : (authTokenFromConfig ? 'config' : 'default');
const sessionName = asString(env.ZTERM_DAEMON_SESSION) || asString(daemonConfig.sessionName) || `zterm-daemon-${port}`;
console.log(`HOST=${host}`);
console.log(`PORT=${port}`);
console.log(`SESSION_NAME=${sessionName}`);
console.log(`AUTH_SOURCE=${authSource}`);
console.log(`CONFIG_FOUND=${found ? '1' : '0'}`);
console.log(`CONFIG_DISPLAY_PATH=${configPath}`);
NODE
}

eval "$(read_config)"

usage() {
  cat <<'USAGE'
Usage:
  zterm-daemon run
  zterm-daemon start
  zterm-daemon status
  zterm-daemon stop
  zterm-daemon restart
  zterm-daemon install-service
  zterm-daemon uninstall-service
  zterm-daemon service-status
USAGE
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

previous_service_loaded() {
  launchctl print "gui/$(id -u)/${PREVIOUS_LAUNCH_AGENT_LABEL}" >/dev/null 2>&1
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

port_listening() {
  nc -z 127.0.0.1 "${PORT}" >/dev/null 2>&1
}

wait_for_port_closed() {
  local attempts=0
  local max_attempts=30
  while (( attempts < max_attempts )); do
    if ! port_listening; then
      return 0
    fi
    sleep 0.2
    attempts=$((attempts + 1))
  done
  return 1
}

reset_launch_crash_guard() {
  rm -f "${RUNTIME_STATE_DIR}/zterm-daemon-launch-crashes.log"
}

read_daemon_pid() {
  [[ -f "${DAEMON_PID_FILE}" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "${DAEMON_PID_FILE}")"
  [[ -n "${pid}" ]] || return 1
  printf '%s\n' "${pid}"
}

is_process_running() {
  local pid="${1:-}"
  [[ -n "${pid}" ]] || return 1
  kill -0 "${pid}" >/dev/null 2>&1
}

run_foreground() {
  mkdir -p "$LOG_DIR"
  chmod +x ${STAGED_NODE_PTY_HELPER_GLOB} 2>/dev/null || true
  cd "${HOME}"
  exec env -u TMUX -u TMUX_PANE HOST="$HOST" PORT="$PORT" ZTERM_HOST="$HOST" ZTERM_PORT="$PORT" ZTERM_AUTH_TOKEN="${ZTERM_AUTH_TOKEN:-}" "$NODE_BIN" "$STAGED_DAEMON_ENTRY"
}

status_direct() {
  local pid=""
  if pid="$(read_daemon_pid 2>/dev/null)" && is_process_running "${pid}" && port_listening; then
    echo "zterm daemon running: pid=${pid} host=${HOST} port=${PORT} auth=${AUTH_SOURCE}"
    return 0
  fi
  if [[ -n "${pid}" ]] && ! is_process_running "${pid}"; then
    rm -f "${DAEMON_PID_FILE}"
  fi
  if port_listening; then
    echo "zterm daemon listener is up on port ${PORT}, but managed pid truth is missing"
    echo "pidFile=${DAEMON_PID_FILE} host=${HOST} auth=${AUTH_SOURCE}"
    return 1
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
  if [[ "${active_count:-0}" != "0" ]] && port_listening; then
    echo "zterm autostart service running: label=${LAUNCH_AGENT_LABEL} host=${HOST} port=${PORT} auth=${AUTH_SOURCE}"
    echo "plist=${LAUNCH_AGENT_PATH}"
    echo "active_count=${active_count:-unknown} last_exit=${last_exit:-unknown}"
    return 0
  fi
  echo "zterm autostart service installed but unhealthy: label=${LAUNCH_AGENT_LABEL}"
  echo "plist=${LAUNCH_AGENT_PATH}"
  echo "active_count=${active_count:-unknown} last_exit=${last_exit:-unknown}"
  echo "listener=down port=${PORT}"
  return 1
}

status() {
  if service_installed; then
    if status_service; then
      return 0
    fi
    status_direct
    return $?
  fi
  status_direct
}

start_direct() {
  mkdir -p "$LOG_DIR" "$RUNTIME_STATE_DIR"
  local timestamp log_file
  timestamp="$(date +%Y%m%d-%H%M%S)"
  log_file="${LOG_DIR}/daemon-${PORT}-${timestamp}.log"
  local existing_pid=""
  if existing_pid="$(read_daemon_pid 2>/dev/null)" && is_process_running "${existing_pid}" && port_listening; then
    echo "zterm daemon already running: pid=${existing_pid} host=${HOST} port=${PORT} auth=${AUTH_SOURCE}"
    echo "pidFile=${DAEMON_PID_FILE}"
    return 0
  fi
  if [[ -n "${existing_pid}" ]] && ! is_process_running "${existing_pid}"; then
    rm -f "${DAEMON_PID_FILE}"
  fi
  if port_listening; then
    echo "zterm daemon listener already exists on port ${PORT}, but managed pid truth is missing"
    echo "pidFile=${DAEMON_PID_FILE}"
    return 1
  fi
  chmod +x ${STAGED_NODE_PTY_HELPER_GLOB} 2>/dev/null || true
  (
    cd "${HOME}"
    env -u TMUX -u TMUX_PANE HOST="$HOST" PORT="$PORT" ZTERM_HOST="$HOST" ZTERM_PORT="$PORT" ZTERM_AUTH_TOKEN="${ZTERM_AUTH_TOKEN:-}" \
      "$NODE_BIN" "$STAGED_DAEMON_ENTRY" >>"$log_file" 2>&1
  ) &
  local daemon_pid=$!
  printf '%s\n' "${daemon_pid}" > "${DAEMON_PID_FILE}"
  if ! wait_for_service_ready; then
    if is_process_running "${daemon_pid}"; then
      kill "${daemon_pid}" >/dev/null 2>&1 || true
      wait "${daemon_pid}" 2>/dev/null || true
    fi
    rm -f "${DAEMON_PID_FILE}"
    echo "zterm daemon failed to become ready on port ${PORT}"
    echo "log=${log_file}"
    return 1
  fi
  echo "zterm daemon started"
  echo "pid=${daemon_pid}"
  echo "host=${HOST}"
  echo "port=${PORT}"
  echo "auth=${AUTH_SOURCE}"
  echo "config=${CONFIG_DISPLAY_PATH}"
  echo "pidFile=${DAEMON_PID_FILE}"
  echo "log=${log_file}"
}

stop_direct() {
  local pid=""
  if ! pid="$(read_daemon_pid 2>/dev/null)"; then
    if port_listening; then
      echo "zterm daemon listener is up on port ${PORT}, but managed pid truth is missing"
      echo "pidFile=${DAEMON_PID_FILE}"
      return 1
    fi
    echo "zterm daemon not running (${PORT})"
    return 0
  fi
  if ! is_process_running "${pid}"; then
    rm -f "${DAEMON_PID_FILE}"
    if port_listening; then
      echo "zterm daemon listener is up on port ${PORT}, but pid ${pid} is stale"
      return 1
    fi
    echo "zterm daemon not running (${PORT})"
    return 0
  fi
  kill "${pid}"
  if ! wait_for_port_closed; then
    echo "zterm daemon did not stop listening on port ${PORT} after pid ${pid} was terminated"
    return 1
  fi
  wait "${pid}" 2>/dev/null || true
  rm -f "${DAEMON_PID_FILE}"
  echo "zterm daemon stopped: pid=${pid}"
}

write_launch_agent() {
  mkdir -p "${HOME}/Library/LaunchAgents" "$LOG_DIR" "$WTERM_BIN_DIR" "$RUNTIME_STATE_DIR"
  cat > "$DIRECT_RUNNER" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
cd "${HOME}"
chmod +x ${STAGED_NODE_PTY_HELPER_GLOB} 2>/dev/null || true
exec env -u TMUX -u TMUX_PANE "${NODE_BIN}" "${STAGED_DAEMON_ENTRY}"
RUNNER
  chmod +x "$DIRECT_RUNNER"

  cat > "$LAUNCH_RUNNER" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
PORT="${PORT}"
STATE_DIR="${RUNTIME_STATE_DIR}"
CRASH_FILE="${RUNTIME_STATE_DIR}/zterm-daemon-launch-crashes.log"
mkdir -p "\$STATE_DIR"
if lsof -nP -iTCP:"\$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] launchd preflight: port \$PORT already listening, skip duplicate start" >> "${LOG_DIR}/launchd-stdout.log"
  exit 0
fi
RECENT_LAUNCHES="\$(
  if [[ -f "\$CRASH_FILE" ]]; then
    python3 - "\$CRASH_FILE" "\$(date +%s)" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
now = int(sys.argv[2])
cutoff = now - 120
entries = []
for line in path.read_text().splitlines():
    try:
        value = int(line.strip())
    except ValueError:
        continue
    if value >= cutoff:
        entries.append(value)
entries.append(now)
path.write_text("\n".join(str(item) for item in entries[-8:]) + "\n")
print(len(entries))
PY
  else
    printf '%s\n' "\$(date +%s)" > "\$CRASH_FILE"
    echo 1
  fi
)"
if [[ "\${RECENT_LAUNCHES:-0}" -ge 5 ]]; then
  echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] launchd preflight: crash-loop guard tripped (\${RECENT_LAUNCHES} launches/120s), stop auto-restart" >> "${LOG_DIR}/launchd-stderr.log"
  exit 0
fi
cd "${HOME}"
chmod +x ${STAGED_NODE_PTY_HELPER_GLOB} 2>/dev/null || true
exec env -u TMUX -u TMUX_PANE "${NODE_BIN}" "${STAGED_DAEMON_ENTRY}"
RUNNER
  chmod +x "$LAUNCH_RUNNER"

  cat > "$LAUNCH_AGENT_PATH" <<PLIST
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
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/launchd-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/launchd-stderr.log</string>
</dict>
</plist>
PLIST
}

stop_legacy_service() {
  if previous_service_loaded; then
    launchctl bootout "gui/$(id -u)" "$PREVIOUS_LAUNCH_AGENT_PATH" || launchctl bootout "gui/$(id -u)/${PREVIOUS_LAUNCH_AGENT_LABEL}" || true
  fi
  if legacy_service_loaded; then
    launchctl bootout "gui/$(id -u)" "$LEGACY_LAUNCH_AGENT_PATH" || launchctl bootout "gui/$(id -u)/${LEGACY_LAUNCH_AGENT_LABEL}" || true
  fi
}

remove_legacy_service() {
  stop_legacy_service
  rm -f "$PREVIOUS_LAUNCH_AGENT_PATH"
  rm -f "$LEGACY_LAUNCH_AGENT_PATH"
}

bootstrap_service() {
  reset_launch_crash_guard
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_PATH"
}

start_service() {
  if ! service_installed; then
    echo "zterm autostart service not installed"
    echo "run: zterm-daemon install-service"
    return 1
  fi
  stop_direct >/dev/null 2>&1 || true
  remove_legacy_service
  write_launch_agent
  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1 || true
    wait_for_service_unloaded || {
      echo "zterm autostart service failed to unload before start"
      return 1
    }
  fi
  bootstrap_service
  if wait_for_service_ready; then
    status_service
    return 0
  fi
  echo "zterm autostart service unhealthy after start"
  launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1 || true
  return 1
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
    echo "run: zterm-daemon install-service"
    return 1
  fi
  stop_direct >/dev/null 2>&1 || true
  remove_legacy_service
  write_launch_agent
  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
    wait_for_service_unloaded || {
      echo "zterm autostart service failed to unload before restart"
      return 1
    }
  fi
  bootstrap_service
  if wait_for_service_ready; then
    status_service
    return 0
  fi
  echo "zterm autostart service unhealthy after restart"
  launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1 || true
  return 1
}

install_service() {
  stop_direct >/dev/null 2>&1 || true
  remove_legacy_service
  write_launch_agent
  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
    wait_for_service_unloaded || {
      echo "zterm autostart service failed to unload before install"
      return 1
    }
  fi
  bootstrap_service
  echo "zterm autostart service installed"
  echo "plist=${LAUNCH_AGENT_PATH}"
  if wait_for_service_ready; then
    status_service
    return 0
  fi
  echo "zterm autostart service unhealthy after install"
  launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1 || true
  return 1
}

uninstall_service() {
  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi
  remove_legacy_service
  rm -f "$LAUNCH_AGENT_PATH"
  echo "zterm autostart service uninstalled"
  echo "plist=${LAUNCH_AGENT_PATH}"
}

cmd="${1:-}"
if [[ "$cmd" == "--" ]]; then
  shift
  cmd="${1:-}"
fi

case "$cmd" in
  run) run_foreground ;;
  start) start_service ;;
  status) status ;;
  stop) stop_service ;;
  restart) restart_service ;;
  install-service) install_service ;;
  uninstall-service) uninstall_service ;;
  service-status) status_service ;;
  ""|-h|--help|help) usage ;;
  *)
    echo "unknown command: $cmd" >&2
    usage >&2
    exit 1
    ;;
esac
