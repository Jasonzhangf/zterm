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
WTERM_HOME="${HOME}/.zterm"
WTERM_BIN_DIR="${WTERM_HOME}/bin"
RUNTIME_STATE_DIR="${WTERM_HOME}/run"
UPLOAD_DIR="${WTERM_HOME}/uploads"
DOWNLOADS_DIR="${HOME}/Downloads/zterm"
DAEMON_RUNTIME_DIR="${WTERM_HOME}/daemon-runtime"
DAEMON_PID_FILE="${RUNTIME_STATE_DIR}/zterm-daemon.pid"
LAUNCH_RUNNER="${WTERM_BIN_DIR}/zterm-daemon-launchd-run"
DIRECT_RUNNER="${WTERM_BIN_DIR}/zterm-daemon-run"
USER_BIN_DIR="${HOME}/.local/bin"
DAEMON_ENTRY="${ROOT_DIR}/src/server/server.ts"
ROOT_NODE_PTY_HELPER_GLOB="${ROOT_DIR}/node_modules/node-pty/prebuilds/darwin-*/spawn-helper"
WORKSPACE_NODE_PTY_HELPER_GLOB="${WORKSPACE_ROOT}/node_modules/node-pty/prebuilds/darwin-*/spawn-helper"
STAGED_NODE_PTY_HELPER_GLOB="${DAEMON_RUNTIME_DIR}/node_modules/node-pty/prebuilds/darwin-*/spawn-helper"
STAGED_DAEMON_ENTRY="${DAEMON_RUNTIME_DIR}/server.cjs"
NATIVE_DAEMON_BIN="${WTERM_BIN_DIR}/zterm-daemon"
NATIVE_DAEMON_SOURCE="${ROOT_DIR}/scripts/native/zterm-daemon.swift"
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
  ./scripts/zterm-daemon.sh configure-relay --relay-url URL --username USER --password PASS --host-id HOST_ID [--device-name NAME] [--restart-service]
  ./scripts/zterm-daemon.sh install-service
  ./scripts/zterm-daemon.sh uninstall-service
  ./scripts/zterm-daemon.sh service-status
  zterm-daemon start|stop|restart|status|configure-relay|install-service|uninstall-service|service-status
  wterm daemon start|stop|restart|status|configure-relay|install-service|uninstall-service|service-status  # legacy alias

Behavior:
  - `run` keeps daemon in foreground (for launchd autostart)
  - start/stop/restart manage launchd service if installed, otherwise use a direct background daemon process
  - host / port / auth token are read from ~/.zterm/config.json
  - relay account config is written to ~/.zterm/config.json by configure-relay
  - env still overrides config when explicitly provided
EOF
}

configure_relay() {
  local relay_url=""
  local relay_username=""
  local relay_password=""
  local relay_host_id=""
  local relay_device_id=""
  local relay_device_name=""
  local restart_after_config="0"

  if [[ "${1:-}" == "configure-relay" ]]; then
    shift
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --relay-url)
        relay_url="${2:-}"
        shift 2
        ;;
      --username)
        relay_username="${2:-}"
        shift 2
        ;;
      --password)
        relay_password="${2:-}"
        shift 2
        ;;
      --password-stdin)
        IFS= read -r relay_password
        shift
        ;;
      --password-env)
        local password_env_name="${2:-}"
        if [[ -z "$password_env_name" ]]; then
          echo "--password-env requires an environment variable name" >&2
          return 1
        fi
        relay_password="${!password_env_name:-}"
        shift 2
        ;;
      --host-id)
        relay_host_id="${2:-}"
        shift 2
        ;;
      --device-id)
        relay_device_id="${2:-}"
        shift 2
        ;;
      --device-name)
        relay_device_name="${2:-}"
        shift 2
        ;;
      --restart-service)
        restart_after_config="1"
        shift
        ;;
      --no-restart)
        restart_after_config="0"
        shift
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        echo "unknown configure-relay option: $1" >&2
        return 1
        ;;
    esac
  done

  if [[ -z "$relay_url" || -z "$relay_username" || -z "$relay_password" || -z "$relay_host_id" ]]; then
    echo "configure-relay requires --relay-url, --username, --password/--password-stdin/--password-env, and --host-id" >&2
    return 1
  fi

  mkdir -p "$WTERM_HOME"
  CONFIG_PATH="${WTERM_HOME}/config.json" \
  RELAY_URL="$relay_url" \
  RELAY_USERNAME="$relay_username" \
  RELAY_PASSWORD="$relay_password" \
  RELAY_HOST_ID="$relay_host_id" \
  RELAY_DEVICE_ID="$relay_device_id" \
  RELAY_DEVICE_NAME="$relay_device_name" \
  "$NODE_BIN" <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');

const configPath = process.env.CONFIG_PATH;
const relayUrl = process.env.RELAY_URL;
const username = process.env.RELAY_USERNAME;
const password = process.env.RELAY_PASSWORD;
const hostId = process.env.RELAY_HOST_ID;
const deviceId = process.env.RELAY_DEVICE_ID || hostId;
const deviceName = process.env.RELAY_DEVICE_NAME || os.hostname();

let config = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, 'utf8');
  config = raw.trim() ? JSON.parse(raw) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${configPath} root must be a JSON object`);
  }
}

config.mobile = config.mobile && typeof config.mobile === 'object' && !Array.isArray(config.mobile)
  ? config.mobile
  : {};
config.mobile.relay = {
  relayUrl,
  username,
  password,
  hostId,
  deviceId,
  deviceName,
  platform: process.platform,
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(configPath, 0o600);
NODE

  echo "zterm relay configured: path=${WTERM_HOME}/config.json relayUrl=${relay_url} username=${relay_username} hostId=${relay_host_id} deviceName=${relay_device_name:-$(hostname)} passwordSet=true"
  if [[ "$restart_after_config" == "1" ]]; then
    restart_service
  else
    echo "run 'zterm-daemon restart' after configuration to reconnect relay"
  fi
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

wait_for_service_unloaded() {
  local attempts=0
  local max_attempts=30

  while (( attempts < max_attempts )); do
    if ! service_loaded; then
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

install_user_shims() {
  mkdir -p "$USER_BIN_DIR"
  rm -f "${USER_BIN_DIR}/zterm-daemon" "${USER_BIN_DIR}/wterm"
cat > "${USER_BIN_DIR}/zterm-daemon" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec bash "${ROOT_DIR}/scripts/zterm-daemon.sh" "\$@"
EOF
  chmod +x "${USER_BIN_DIR}/zterm-daemon"
cat > "${USER_BIN_DIR}/wterm" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "daemon" ]]; then
  shift
fi
exec bash "${ROOT_DIR}/scripts/zterm-daemon.sh" "\$@"
EOF
  chmod +x "${USER_BIN_DIR}/wterm"
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
for (const base of [rootDir, workspaceRoot]) {
  try {
    const resolved = require.resolve(`${packageName}/package.json`, { paths: [base] });
    console.log(path.dirname(resolved));
    process.exit(0);
  } catch {}
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

  echo "[zterm-daemon] unable to resolve ${package_name} in ${ROOT_DIR} or ${WORKSPACE_ROOT}" >&2
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

stage_native_daemon_binary() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 0
  fi
  if [[ -x "$NATIVE_DAEMON_BIN" && "$NATIVE_DAEMON_BIN" -nt "$NATIVE_DAEMON_SOURCE" ]]; then
    return 0
  fi
  if ! command -v swiftc >/dev/null 2>&1; then
    echo "zterm-daemon native screenshot binary requires swiftc; install Xcode command line tools" >&2
    return 1
  fi
  mkdir -p "$WTERM_BIN_DIR"
  swiftc "$NATIVE_DAEMON_SOURCE" -o "$NATIVE_DAEMON_BIN"
  chmod +x "$NATIVE_DAEMON_BIN"
}

run_foreground() {
  mkdir -p "$LOG_DIR"
  stage_daemon_runtime
  stage_native_daemon_binary
  chmod +x ${ROOT_NODE_PTY_HELPER_GLOB} ${WORKSPACE_NODE_PTY_HELPER_GLOB} ${STAGED_NODE_PTY_HELPER_GLOB} 2>/dev/null || true
  cd "${HOME}"
  exec env -u TMUX -u TMUX_PANE HOST="$HOST" PORT="$PORT" ZTERM_HOST="$HOST" ZTERM_PORT="$PORT" ZTERM_AUTH_TOKEN="${ZTERM_AUTH_TOKEN:-}" ZTERM_DAEMON_NATIVE="$NATIVE_DAEMON_BIN" "$NODE_BIN" "$STAGED_DAEMON_ENTRY"
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

  stage_daemon_runtime
  stage_native_daemon_binary
  chmod +x ${ROOT_NODE_PTY_HELPER_GLOB} ${WORKSPACE_NODE_PTY_HELPER_GLOB} ${STAGED_NODE_PTY_HELPER_GLOB} 2>/dev/null || true

  (
    cd "${HOME}"
    env -u TMUX -u TMUX_PANE HOST="$HOST" PORT="$PORT" ZTERM_HOST="$HOST" ZTERM_PORT="$PORT" ZTERM_AUTH_TOKEN="${ZTERM_AUTH_TOKEN:-}" ZTERM_DAEMON_NATIVE="$NATIVE_DAEMON_BIN" \
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
  install_user_shims
  stage_daemon_runtime
  stage_native_daemon_binary
  mkdir -p "${HOME}/Library/LaunchAgents" "$LOG_DIR" "$WTERM_BIN_DIR" "$RUNTIME_STATE_DIR"
cat > "$DIRECT_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${HOME}"
chmod +x ${STAGED_NODE_PTY_HELPER_GLOB} 2>/dev/null || true
exec env -u TMUX -u TMUX_PANE ZTERM_DAEMON_NATIVE="${NATIVE_DAEMON_BIN}" "${NODE_BIN}" "${STAGED_DAEMON_ENTRY}"
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
exec env -u TMUX -u TMUX_PANE ZTERM_DAEMON_NATIVE="${NATIVE_DAEMON_BIN}" "${NODE_BIN}" "${STAGED_DAEMON_ENTRY}"
EOF
  chmod +x "$LAUNCH_RUNNER"
  (
    cd "$ROOT_DIR"
    export ZTERM_LAUNCH_AGENT_PATH="$LAUNCH_AGENT_PATH"
    export ZTERM_LAUNCH_AGENT_LABEL="$LAUNCH_AGENT_LABEL"
    export ZTERM_LAUNCH_RUNNER="$LAUNCH_RUNNER"
    export ZTERM_LAUNCH_STDOUT_PATH="${LOG_DIR}/launchd-stdout.log"
    export ZTERM_LAUNCH_STDERR_PATH="${LOG_DIR}/launchd-stderr.log"
    "$NODE_BIN" --import tsx <<EOF
import { writeFileSync } from 'node:fs';
import { buildLaunchAgentPlistXml } from './src/server/launch-agent-plist.ts';

writeFileSync(
  process.env.ZTERM_LAUNCH_AGENT_PATH!,
  buildLaunchAgentPlistXml({
    label: process.env.ZTERM_LAUNCH_AGENT_LABEL!,
    launchRunner: process.env.ZTERM_LAUNCH_RUNNER!,
    stdoutPath: process.env.ZTERM_LAUNCH_STDOUT_PATH!,
    stderrPath: process.env.ZTERM_LAUNCH_STDERR_PATH!,
  }),
);
EOF
  )
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

prime_daemon_install_permissions() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 0
  fi

  echo "zterm daemon install permission preflight"
  echo "- macOS file sync uses this daemon process to read/write user-selected paths."
  echo "- Grant file access to Terminal/iTerm or the installed daemon runner when macOS prompts."
  echo "- Remote screenshot uses zterm-daemon directly; grant Screen & System Audio Recording when macOS prompts."

  mkdir -p "$WTERM_HOME" "$UPLOAD_DIR" "$DOWNLOADS_DIR"
  stage_native_daemon_binary
  ZTERM_DAEMON_NATIVE="$NATIVE_DAEMON_BIN" "$NODE_BIN" - <<'EOF'
const { accessSync, constants, mkdirSync, rmSync, writeFileSync, unlinkSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { homedir } = require('node:os');

const dirs = [
  join(homedir(), '.zterm'),
  join(homedir(), 'Downloads', 'zterm'),
];

for (const dir of dirs) {
  mkdirSync(dir, { recursive: true });
  accessSync(dir, constants.R_OK | constants.W_OK);
  const probe = join(dir, '.zterm-permission-preflight');
  writeFileSync(probe, 'ok\n');
  unlinkSync(probe);
}

const screenshotProbe = join(homedir(), '.zterm', '.zterm-screenshot-permission-preflight.png');
try {
  execFileSync(process.env.ZTERM_DAEMON_NATIVE, ['capture-screen', screenshotProbe], {
    stdio: 'pipe',
    timeout: 15000,
  });
  rmSync(screenshotProbe, { force: true });
} catch (error) {
  rmSync(screenshotProbe, { force: true });
  const stderr = error && error.stderr ? String(error.stderr) : '';
  const message = error && error.message ? String(error.message) : String(error);
  console.error('zterm-daemon screenshot permission preflight failed.');
  console.error('Open macOS System Settings -> Privacy & Security -> Screen & System Audio Recording, allow zterm-daemon/Terminal, then rerun zterm-daemon install-service.');
  if (stderr.trim()) console.error(stderr.trim());
  if (message.trim()) console.error(message.trim());
  process.exit(1);
}
EOF
}

start_service() {
  if ! service_installed; then
    echo "zterm autostart service not installed"
    echo "run: ./scripts/zterm-daemon.sh install-service"
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
    echo "run: ./scripts/zterm-daemon.sh install-service"
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
  prime_daemon_install_permissions
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

start() {
  if service_installed; then
    start_service
    return
  fi
  start_direct
}

stop() {
  if service_installed; then
    stop_service
    return
  fi
  stop_direct
}

restart() {
  if service_installed; then
    restart_service
    return
  fi
  stop_direct
  start_direct
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
  configure-relay) configure_relay "$@" ;;
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
