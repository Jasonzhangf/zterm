#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(python3 - "$ROOT_DIR" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
WORKSPACE_ROOT="$(cd "${ROOT_DIR}/.." && pwd)"
NODE_BIN="$(command -v node)"
LOG_DIR="${HOME}/.wterm/logs"
WTERM_HOME="${HOME}/.wterm"
WTERM_BIN_DIR="${WTERM_HOME}/bin"
RUNTIME_STATE_DIR="${WTERM_HOME}/run"
DAEMON_RUNTIME_DIR="${WTERM_HOME}/daemon-runtime"
LAUNCH_RUNNER="${WTERM_BIN_DIR}/zterm-daemon-launchd-run"
DIRECT_RUNNER="${WTERM_BIN_DIR}/zterm-daemon-run"
DAEMON_ENTRY="${ROOT_DIR}/src/server/server.ts"
ROOT_NODE_PTY_HELPER_GLOB="${ROOT_DIR}/node_modules/node-pty/prebuilds/darwin-*/spawn-helper"
WORKSPACE_NODE_PTY_HELPER_GLOB="${WORKSPACE_ROOT}/node_modules/node-pty/prebuilds/darwin-*/spawn-helper"
STAGED_NODE_PTY_HELPER_GLOB="${DAEMON_RUNTIME_DIR}/node_modules/node-pty/prebuilds/darwin-*/spawn-helper"
STAGED_DAEMON_ENTRY="${DAEMON_RUNTIME_DIR}/server.cjs"
LAUNCH_AGENT_LABEL="com.zterm.android.zterm-daemon"
LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
PREVIOUS_LAUNCH_AGENT_LABEL="com.zterm.android.daemon"
PREVIOUS_LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${PREVIOUS_LAUNCH_AGENT_LABEL}.plist"
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
  zterm-daemon start|stop|restart|status|install-service|uninstall-service|service-status
  wterm daemon start|stop|restart|status|install-service|uninstall-service|service-status  # legacy alias

Behavior:
  - `run` keeps daemon in foreground (for launchd autostart)
  - start/stop/restart manage launchd service if installed, otherwise use tmux daemon session
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

reset_launch_crash_guard() {
  rm -f "${RUNTIME_STATE_DIR}/zterm-daemon-launch-crashes.log"
}

resolve_esbuild_bin() {
  local candidate
  candidate="$(
    {
      ls "${ROOT_DIR}"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null || true
      ls "${WORKSPACE_ROOT}"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null || true
    } | sort -V | tail -n 1
  )"
  if [[ -n "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
    return 0
  fi
  return 1
}

resolve_node_package_dir() {
  local package_name="${1:-}"
  [[ -n "${package_name}" ]] || return 1
  if "$NODE_BIN" - "$ROOT_DIR" "$WORKSPACE_ROOT" "$package_name" <<'EOF'
const path = require('path');

const [rootDir, workspaceRoot, packageName] = process.argv.slice(2);
let lastError = null;
for (const base of [rootDir, workspaceRoot]) {
  try {
    const resolved = require.resolve(`${packageName}/package.json`, { paths: [base] });
    console.log(path.dirname(resolved));
    process.exit(0);
  } catch (error) {
    lastError = error;
  }
}
if (lastError) {
  console.error(`[zterm-daemon] unable to resolve ${packageName}: ${lastError.message || String(lastError)}`);
}
process.exit(1);
EOF
  then
    return 0
  fi

  local namespace package_basename candidate
  namespace="${package_name%/*}"
  package_basename="${package_name##*/}"
  candidate="$(
    {
      find "${ROOT_DIR}/node_modules/.pnpm" -path "*/node_modules/${namespace}/${package_basename}" -type d 2>/dev/null || true
      find "${WORKSPACE_ROOT}/node_modules/.pnpm" -path "*/node_modules/${namespace}/${package_basename}" -type d 2>/dev/null || true
    } | sort -V | tail -n 1
  )"
  if [[ -n "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
    return 0
  fi

  return 1
}

resolve_wrtc_platform_package_name() {
  "$NODE_BIN" -e "console.log('@roamhq/wrtc-' + process.platform + '-' + process.arch)"
}

stage_daemon_runtime() {
  local esbuild_bin wrtc_package_dir wrtc_platform_package_name wrtc_platform_package_dir
  esbuild_bin="$(resolve_esbuild_bin)" || {
    echo "missing esbuild binary under ${ROOT_DIR}/node_modules/.pnpm or ${WORKSPACE_ROOT}/node_modules/.pnpm" >&2
    return 1
  }
  wrtc_package_dir="$(resolve_node_package_dir '@roamhq/wrtc')" || {
    echo "missing @roamhq/wrtc package in ${ROOT_DIR} or ${WORKSPACE_ROOT}" >&2
    return 1
  }
  wrtc_platform_package_name="$(resolve_wrtc_platform_package_name)"
  wrtc_platform_package_dir="$(resolve_node_package_dir "${wrtc_platform_package_name}")" || {
    echo "missing ${wrtc_platform_package_name} package in ${ROOT_DIR} or ${WORKSPACE_ROOT}" >&2
    return 1
  }

  mkdir -p "${DAEMON_RUNTIME_DIR}/node_modules" "${DAEMON_RUNTIME_DIR}/node_modules/@roamhq"
  "${esbuild_bin}" "${DAEMON_ENTRY}" \
    --bundle \
    --platform=node \
    --format=cjs \
    --target=node20 \
    --outfile="${STAGED_DAEMON_ENTRY}" \
    --external:node-pty >/dev/null
  rm -rf "${DAEMON_RUNTIME_DIR}/node_modules/node-pty"
  cp -RL "${ROOT_DIR}/node_modules/node-pty" "${DAEMON_RUNTIME_DIR}/node_modules/"
  rm -rf "${DAEMON_RUNTIME_DIR}/node_modules/@roamhq/wrtc" "${DAEMON_RUNTIME_DIR}/node_modules/@roamhq/${wrtc_platform_package_name##*/}"
  cp -RL "${wrtc_package_dir}" "${DAEMON_RUNTIME_DIR}/node_modules/@roamhq/wrtc"
  cp -RL "${wrtc_platform_package_dir}" "${DAEMON_RUNTIME_DIR}/node_modules/@roamhq/${wrtc_platform_package_name##*/}"
  chmod +x ${STAGED_NODE_PTY_HELPER_GLOB} 2>/dev/null || true
}

run_foreground() {
  mkdir -p "$LOG_DIR"
  stage_daemon_runtime
  chmod +x ${ROOT_NODE_PTY_HELPER_GLOB} ${WORKSPACE_NODE_PTY_HELPER_GLOB} ${STAGED_NODE_PTY_HELPER_GLOB} 2>/dev/null || true
  cd "${HOME}"
  exec env -u TMUX -u TMUX_PANE HOST="$HOST" PORT="$PORT" ZTERM_HOST="$HOST" ZTERM_PORT="$PORT" ZTERM_AUTH_TOKEN="${ZTERM_AUTH_TOKEN:-}" "$NODE_BIN" "$STAGED_DAEMON_ENTRY"
}

status_tmux() {
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null && port_listening; then
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
    status_tmux
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

  stage_daemon_runtime
  chmod +x ${ROOT_NODE_PTY_HELPER_GLOB} ${WORKSPACE_NODE_PTY_HELPER_GLOB} ${STAGED_NODE_PTY_HELPER_GLOB} 2>/dev/null || true

  tmux new-session -d -s "$SESSION_NAME" \
    "cd '${HOME}' && env -u TMUX -u TMUX_PANE HOST='$HOST' PORT='$PORT' ZTERM_HOST='$HOST' ZTERM_PORT='$PORT' ZTERM_AUTH_TOKEN='${ZTERM_AUTH_TOKEN:-}' '$NODE_BIN' '$STAGED_DAEMON_ENTRY' >>'$log_file' 2>&1"

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
  stage_daemon_runtime
  mkdir -p "${HOME}/Library/LaunchAgents" "$LOG_DIR" "$WTERM_BIN_DIR" "$RUNTIME_STATE_DIR"
cat > "$DIRECT_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${HOME}"
chmod +x ${STAGED_NODE_PTY_HELPER_GLOB} 2>/dev/null || true
exec env -u TMUX -u TMUX_PANE "${NODE_BIN}" "${STAGED_DAEMON_ENTRY}"
EOF
  chmod +x "$DIRECT_RUNNER"
cat > "$LAUNCH_RUNNER" <<EOF
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
EOF
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
    echo "run: ./scripts/zterm-daemon.sh install-service"
    return 1
  fi

  stop_tmux >/dev/null 2>&1 || true
  remove_legacy_service
  write_launch_agent

  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1 || true
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
    echo "run: ./scripts/zterm-daemon.sh install-service"
    return 1
  fi

  stop_tmux >/dev/null 2>&1 || true
  remove_legacy_service
  write_launch_agent

  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
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
  stop_tmux >/dev/null 2>&1 || true
  remove_legacy_service
  write_launch_agent
  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
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
