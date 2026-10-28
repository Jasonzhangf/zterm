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
PACKAGE_VERSION="$(node -p "require('${ROOT_DIR}/package.json').version")"
TARGET_OS="darwin"
TARGET_ARCH="$(uname -m)"
RELEASE_NAME="zterm-daemon-${PACKAGE_VERSION}-${TARGET_OS}-${TARGET_ARCH}"
RELEASE_DIST_DIR="${ROOT_DIR}/release-dist"
RELEASE_DIR="${RELEASE_DIST_DIR}/${RELEASE_NAME}"
RUNTIME_DIR="${RELEASE_DIR}/runtime"
SUPPORT_DIR="${RELEASE_DIR}/support"
BIN_DIR="${RELEASE_DIR}/bin"
PACKAGE_MANIFEST_PATH="${RELEASE_DIR}/zterm-package.json"
ARCHIVE_PATH="${RELEASE_DIST_DIR}/${RELEASE_NAME}.tar.gz"
SHA_PATH="${ARCHIVE_PATH}.sha256"
NODE_PTY_SOURCE="${ROOT_DIR}/node_modules/node-pty"
NATIVE_DAEMON_SOURCE="${ROOT_DIR}/scripts/native/zterm-daemon.swift"
NATIVE_DAEMON_BIN="${SUPPORT_DIR}/zterm-daemon"
REMOTE_WINDOW_CAPTURE_SOURCE="${ROOT_DIR}/src/server/remote-window-screen-capture-script.ts"
REMOTE_WINDOW_CAPTURE_EXTRACTOR="${ROOT_DIR}/scripts/native/extract-remote-window-capture-swift.mjs"
REMOTE_WINDOW_CAPTURE_SWIFT="${RELEASE_DIST_DIR}/.remote-window-capture.swift"
TERMINAL_CONFIG_COMMAND_SOURCE="${ROOT_DIR}/src/server/terminal-config-command.ts"

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
  "${NODE_BIN}" -e "console.log('@roamhq/wrtc-' + process.platform + '-' + process.arch)"
}

resolve_esbuild_bin() {
  local candidate
  candidate="$(
    {
      ls "${ROOT_DIR}"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null || true
      ls "${WORKSPACE_ROOT}"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 2>/dev/null || true
    } | sort -V | tail -n 1
  )"
  if [[ -z "${candidate}" ]]; then
    echo "missing esbuild under ${ROOT_DIR}/node_modules/.pnpm or ${WORKSPACE_ROOT}/node_modules/.pnpm" >&2
    return 1
  fi
  printf '%s\n' "${candidate}"
}

stage_runtime() {
  local esbuild_bin wrtc_package_dir wrtc_platform_package_name wrtc_platform_package_dir
  esbuild_bin="$(resolve_esbuild_bin)"
  wrtc_package_dir="$(resolve_node_package_dir '@roamhq/wrtc')"
  wrtc_platform_package_name="$(resolve_wrtc_platform_package_name)"
  wrtc_platform_package_dir="$(resolve_node_package_dir "${wrtc_platform_package_name}")"
  mkdir -p "${RUNTIME_DIR}/node_modules" "${RUNTIME_DIR}/node_modules/@roamhq"
  "${esbuild_bin}" "${ROOT_DIR}/src/server/server.ts" \
    --bundle \
    --platform=node \
    --format=cjs \
    --target=node20 \
    --outfile="${RUNTIME_DIR}/server.cjs" \
    --external:node-pty >/dev/null
  rm -rf "${RUNTIME_DIR}/node_modules/node-pty"
  cp -RL "${NODE_PTY_SOURCE}" "${RUNTIME_DIR}/node_modules/"
  rm -rf "${RUNTIME_DIR}/node_modules/@roamhq/wrtc" "${RUNTIME_DIR}/node_modules/@roamhq/${wrtc_platform_package_name##*/}"
  cp -RL "${wrtc_package_dir}" "${RUNTIME_DIR}/node_modules/@roamhq/wrtc"
  cp -RL "${wrtc_platform_package_dir}" "${RUNTIME_DIR}/node_modules/@roamhq/${wrtc_platform_package_name##*/}"
  # Native artifact selection is delegated to the single strict stage helper. It
  # requires the explicit typed release input manifest (no prebuilt fallback) and
  # fail-closes on missing/invalid/tampered input before writing provenance.
  "${NODE_BIN}" "${ROOT_DIR}/scripts/prepare-daemon-release-wrtc-input.mjs" \
    --manifest "${ZTERM_DAEMON_WRTC_INPUT_MANIFEST:-}" \
    --runtime-dir "${RUNTIME_DIR}"
  DAGPIPE_PROFILE=release bash "${ROOT_DIR}/scripts/build-dagpipe-native.sh"
  cp "${ROOT_DIR}/native/dagpipe/index.node" "${RUNTIME_DIR}/dagpipe.node"
  chmod +x "${RUNTIME_DIR}"/node_modules/node-pty/prebuilds/darwin-*/spawn-helper 2>/dev/null || true
}

run_phase7_release_gate() {
  local artifact_name="$1"
  local expected_sha="$2"
  "$NODE_BIN" - "$ROOT_DIR" "$artifact_name" "$expected_sha" <<'NODE'
const path = require('path');
const [rootDir, artifactName, expectedSha] = process.argv.slice(2);
const dagpipe = require(path.join(rootDir, 'native', 'dagpipe', 'index.node'));
const inputJson = JSON.stringify({
  execution_id: `release:${artifactName}`,
  attempt_id: '1',
  inputs: {
    'arc.build_artifact': { name: artifactName, sha256: expectedSha },
    'arc.release_policy': { expectedSha256: expectedSha },
  },
});
const raw = dagpipe.runPhase7Release(inputJson);
const result = JSON.parse(raw);
if (!result.ok) {
  console.error('[prepare-global-daemon-release] phase7 release gate failed:', result.error || 'unknown');
  process.exit(1);
}
const started = result.outputs && result.outputs['arc.runtime_started'];
if (!started || started.state !== 'started') {
  console.error('[prepare-global-daemon-release] phase7 release gate did not reach runtime_started');
  process.exit(1);
}
console.log(`[prepare-global-daemon-release] phase7 release gate passed artifact=${artifactName} sha256=${expectedSha}`);
NODE
}

stage_native_daemon_binary() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 0
  fi
  if ! command -v swiftc >/dev/null 2>&1; then
    echo "zterm-daemon native screenshot binary requires swiftc; install Xcode command line tools" >&2
    return 1
  fi
  mkdir -p "${SUPPORT_DIR}"
  if [[ -x "${NATIVE_DAEMON_BIN}" && "${NATIVE_DAEMON_BIN}" -nt "${NATIVE_DAEMON_SOURCE}" && "${NATIVE_DAEMON_BIN}" -nt "${REMOTE_WINDOW_CAPTURE_SOURCE}" ]]; then
    return 0
  fi
  "${NODE_BIN}" "${REMOTE_WINDOW_CAPTURE_EXTRACTOR}" "${REMOTE_WINDOW_CAPTURE_SOURCE}" "${REMOTE_WINDOW_CAPTURE_SWIFT}"
  swiftc -swift-version 5 -strict-concurrency=minimal "${NATIVE_DAEMON_SOURCE}" "${REMOTE_WINDOW_CAPTURE_SWIFT}" -o "${NATIVE_DAEMON_BIN}"
  chmod +x "${NATIVE_DAEMON_BIN}"
}

stage_terminal_config_command() {
  local esbuild_bin
  esbuild_bin="$(resolve_esbuild_bin)"
  mkdir -p "${SUPPORT_DIR}"
  "${esbuild_bin}" "${TERMINAL_CONFIG_COMMAND_SOURCE}" \
    --bundle \
    --platform=node \
    --format=cjs \
    --target=node20 \
    --outfile="${SUPPORT_DIR}/terminal-config-command.cjs" >/dev/null
  chmod +x "${SUPPORT_DIR}/terminal-config-command.cjs"
}

write_support_script() {
  cat > "${SUPPORT_DIR}/zterm-daemon.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_ROOT="$(python3 - "$PACKAGE_ROOT" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
NODE_BIN="$(command -v node)"
LOG_DIR="${HOME}/.zterm/logs"
WTERM_HOME="${HOME}/.zterm"
WTERM_BIN_DIR="${WTERM_HOME}/bin"
RUNTIME_STATE_DIR="${WTERM_HOME}/run"
UPLOAD_DIR="${WTERM_HOME}/uploads"
DOWNLOADS_DIR="${HOME}/Downloads/zterm"
RUNTIME_DIR="${PACKAGE_ROOT}/runtime"
DAEMON_PID_FILE="${RUNTIME_STATE_DIR}/zterm-daemon.pid"
DIRECT_RUNNER="${WTERM_BIN_DIR}/zterm-daemon-run"
LAUNCH_RUNNER="${WTERM_BIN_DIR}/zterm-daemon-launchd-run"
LAUNCH_AGENT_LABEL="com.zterm.android.zterm-daemon"
LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
PREVIOUS_LAUNCH_AGENT_LABEL="com.zterm.android.daemon"
PREVIOUS_LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${PREVIOUS_LAUNCH_AGENT_LABEL}.plist"
LEGACY_LAUNCH_AGENT_LABEL="com.zterm.mobile.daemon"
LEGACY_LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${LEGACY_LAUNCH_AGENT_LABEL}.plist"
STAGED_DAEMON_ENTRY="${RUNTIME_DIR}/server.cjs"
TERMINAL_CONFIG_COMMAND="${PACKAGE_ROOT}/support/terminal-config-command.cjs"
STAGED_NODE_PTY_HELPER_GLOB="${RUNTIME_DIR}/node_modules/node-pty/prebuilds/darwin-*/spawn-helper"
NATIVE_DAEMON_BIN="${WTERM_BIN_DIR}/zterm-daemon"
DAGPIPE_NATIVE_BIN="${RUNTIME_DIR}/dagpipe.node"
ITERM2_PYTHON_VENV="${WTERM_HOME}/python/iterm2"
ITERM2_PYTHON_BIN="${ITERM2_PYTHON_VENV}/bin/python3"

read_config() {
  "$NODE_BIN" "$TERMINAL_CONFIG_COMMAND" daemon-config --shell
}

config_output="$(read_config)"
eval "$config_output"

PROBE_SOCKET_HOST="$HOST"
PROBE_URL_HOST="$HOST"
case "$PROBE_SOCKET_HOST" in
  0.0.0.0|::|\[::\])
    PROBE_SOCKET_HOST="127.0.0.1"
    PROBE_URL_HOST="127.0.0.1"
    ;;
  \[*\])
    PROBE_SOCKET_HOST="${PROBE_SOCKET_HOST#[}"
    PROBE_SOCKET_HOST="${PROBE_SOCKET_HOST%]}"
    PROBE_URL_HOST="[${PROBE_SOCKET_HOST}]"
    ;;
  *:*)
    PROBE_URL_HOST="[${PROBE_SOCKET_HOST}]"
    ;;
esac

usage() {
  cat <<'USAGE'
Usage:
  zterm-daemon run
  zterm-daemon start
  zterm-daemon status
  zterm-daemon config
  zterm-daemon stop
  zterm-daemon restart
  zterm-daemon configure-relay --relay-url URL --username USER --password-stdin --host-id HOST_ID [--device-name NAME] [--restart-service]
  zterm-daemon install-service
  zterm-daemon uninstall-service
  zterm-daemon service-status
USAGE
}

configure_relay() {
  local relay_url=""
  local relay_username=""
  local relay_password=""
  local relay_host_id=""
  local relay_device_id=""
  local relay_device_name=""
  local password_stdin="0"
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
        echo "relay passwords are accepted only with --password-stdin" >&2
        return 1
        ;;
      --password-stdin)
        IFS= read -r relay_password
        password_stdin="1"
        shift
        ;;
      --password-env)
        echo "relay passwords are accepted only with --password-stdin" >&2
        return 1
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

  if [[ -z "$relay_url" || -z "$relay_username" || -z "$relay_password" || -z "$relay_host_id" || "$password_stdin" != "1" ]]; then
    echo "configure-relay requires --relay-url, --username, --password-stdin, and --host-id" >&2
    return 1
  fi

  local -a configure_args=(
    "$TERMINAL_CONFIG_COMMAND"
    configure-relay
    --relay-url "$relay_url"
    --username "$relay_username"
    --host-id "$relay_host_id"
    --password-stdin
  )
  if [[ -n "$relay_device_id" ]]; then
    configure_args+=(--device-id "$relay_device_id")
  fi
  if [[ -n "$relay_device_name" ]]; then
    configure_args+=(--device-name "$relay_device_name")
  fi
  printf '%s\n' "$relay_password" | "$NODE_BIN" "${configure_args[@]}"
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
  local max_attempts=150
  while (( attempts < max_attempts )); do
    if daemon_health_ready; then
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
  nc -z "${PROBE_SOCKET_HOST}" "${PORT}" >/dev/null 2>&1
}

daemon_health_ready() {
  curl --silent --show-error --fail --max-time 2 "http://${PROBE_URL_HOST}:${PORT}/health" >/dev/null 2>&1
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
  exec env -u TMUX -u TMUX_PANE HOST="$HOST" PORT="$PORT" ZTERM_HOST="$HOST" ZTERM_PORT="$PORT" ZTERM_AUTH_TOKEN="${ZTERM_AUTH_TOKEN:-}" ZTERM_DAEMON_NATIVE="$NATIVE_DAEMON_BIN" ZTERM_DAGPIPE_NATIVE="${DAGPIPE_NATIVE_BIN}" "$NODE_BIN" "$STAGED_DAEMON_ENTRY"
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
  if [[ "${active_count:-0}" != "0" ]] && daemon_health_ready; then
    echo "zterm autostart service running: label=${LAUNCH_AGENT_LABEL} host=${HOST} port=${PORT} auth=${AUTH_SOURCE}"
    echo "plist=${LAUNCH_AGENT_PATH}"
    echo "active_count=${active_count:-unknown} last_exit=${last_exit:-unknown}"
    return 0
  fi
  echo "zterm autostart service installed but unhealthy: label=${LAUNCH_AGENT_LABEL}"
  echo "plist=${LAUNCH_AGENT_PATH}"
  echo "active_count=${active_count:-unknown} last_exit=${last_exit:-unknown}"
  echo "health=down url=http://${PROBE_URL_HOST}:${PORT}/health"
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

prepare_iterm2_python_env() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 0
  fi
  mkdir -p "${WTERM_HOME}/python"
  if [[ ! -x "$ITERM2_PYTHON_BIN" ]]; then
    python3 -m venv "$ITERM2_PYTHON_VENV"
  fi
  if "$ITERM2_PYTHON_BIN" - <<'PY' >/dev/null 2>&1
import iterm2
PY
  then
    return 0
  fi
  "$ITERM2_PYTHON_BIN" -m pip install --upgrade pip >/dev/null
  "$ITERM2_PYTHON_BIN" -m pip install --upgrade iterm2
}

write_launch_agent() {
  prepare_iterm2_python_env || echo "[zterm-daemon] iTerm2 Python API environment unavailable; remote-window pane catalog will report an explicit error" >&2
  mkdir -p "${HOME}/Library/LaunchAgents" "$LOG_DIR" "$WTERM_BIN_DIR" "$RUNTIME_STATE_DIR"
  cat > "$DIRECT_RUNNER" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
cd "${HOME}"
export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
chmod +x ${STAGED_NODE_PTY_HELPER_GLOB} 2>/dev/null || true
exec env -u TMUX -u TMUX_PANE ZTERM_ITERM2_PYTHON="${ITERM2_PYTHON_BIN}" ZTERM_DAEMON_NATIVE="${NATIVE_DAEMON_BIN}" ZTERM_DAGPIPE_NATIVE="${DAGPIPE_NATIVE_BIN}" "${NODE_BIN}" "${STAGED_DAEMON_ENTRY}"
RUNNER
  chmod +x "$DIRECT_RUNNER"

  cat > "$LAUNCH_RUNNER" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
PORT="${PORT}"
PROBE_URL_HOST="${PROBE_URL_HOST}"
STATE_DIR="${RUNTIME_STATE_DIR}"
CRASH_FILE="${RUNTIME_STATE_DIR}/zterm-daemon-launch-crashes.log"
mkdir -p "\$STATE_DIR"
health_ready() {
  curl --silent --show-error --fail --max-time 2 "http://\${PROBE_URL_HOST}:\${PORT}/health" >/dev/null 2>&1
}
if health_ready; then
  echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] launchd preflight: health ok on port \$PORT, skip duplicate start" >> "${LOG_DIR}/launchd-stdout.log"
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
export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
chmod +x ${STAGED_NODE_PTY_HELPER_GLOB} 2>/dev/null || true
child_pid=""
terminate_child() {
  [[ -n "\${child_pid}" ]] || return 0
  kill -0 "\${child_pid}" >/dev/null 2>&1 || return 0
  kill -TERM "\${child_pid}" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    kill -0 "\${child_pid}" >/dev/null 2>&1 || break
    sleep 1
  done
  if kill -0 "\${child_pid}" >/dev/null 2>&1; then
    kill -KILL "\${child_pid}" >/dev/null 2>&1 || true
  fi
  wait "\${child_pid}" >/dev/null 2>&1 || true
}
cleanup_child() {
  terminate_child
}
trap cleanup_child TERM INT
env -u TMUX -u TMUX_PANE ZTERM_ITERM2_PYTHON="${ITERM2_PYTHON_BIN}" ZTERM_DAEMON_NATIVE="${NATIVE_DAEMON_BIN}" ZTERM_DAGPIPE_NATIVE="${DAGPIPE_NATIVE_BIN}" "${NODE_BIN}" "${STAGED_DAEMON_ENTRY}" &
child_pid="\$!"
missed_health_checks=0
child_start_epoch="\$(date +%s)"
STARTUP_HEALTH_GRACE_SECONDS=45
while kill -0 "\${child_pid}" >/dev/null 2>&1; do
  if health_ready; then
    missed_health_checks=0
  else
    now_epoch="\$(date +%s)"
    child_age=\$((now_epoch - child_start_epoch))
    if [[ "\${child_age}" -lt "\${STARTUP_HEALTH_GRACE_SECONDS}" ]]; then
      echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] launchd watchdog: waiting for startup health child=\${child_pid} age=\${child_age}s" >> "${LOG_DIR}/launchd-stderr.log"
      missed_health_checks=0
    else
      missed_health_checks=\$((missed_health_checks + 1))
      echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] launchd watchdog: missed health check \${missed_health_checks}/3 for child \${child_pid}" >> "${LOG_DIR}/launchd-stderr.log"
      if [[ "\${missed_health_checks}" -ge 3 ]]; then
        echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] launchd watchdog: restarting unhealthy child \${child_pid}" >> "${LOG_DIR}/launchd-stderr.log"
        terminate_child
        exit 1
      fi
    fi
  fi
  sleep 10
done
wait "\${child_pid}"
exit "\$?"
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

prime_daemon_install_permissions() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 0
  fi

  echo "zterm daemon install permission preflight"
  echo "- macOS file sync uses this daemon process to read/write user-selected paths."
  echo "- Grant file access to Terminal/iTerm or the installed daemon runner when macOS prompts."
  echo "- Screen Recording and remote window capture use zterm-daemon directly."

  mkdir -p "$WTERM_HOME" "$UPLOAD_DIR" "$DOWNLOADS_DIR"
  ZTERM_DAEMON_NATIVE="$NATIVE_DAEMON_BIN" "$NODE_BIN" - <<'NODE'
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

try {
  if (!process.env.ZTERM_DAEMON_NATIVE) {
    throw new Error('installed ScreenCaptureKit capture binary is required');
  }
  execFileSync(process.env.ZTERM_DAEMON_NATIVE, ['--permission-probe'], {
    stdio: 'pipe',
    timeout: 180000,
  });
} catch (error) {
  const stderr = error && error.stderr ? String(error.stderr) : '';
  const message = error && error.message ? String(error.message) : String(error);
  const timedOut = /ETIMEDOUT|timed out/u.test(message);
  console.error(timedOut
    ? 'ScreenCaptureKit permission was not granted before the 180s deadline.'
    : 'ScreenCaptureKit permission preflight failed.');
  console.error('Grant Screen Recording to ' + process.env.ZTERM_DAEMON_NATIVE + ' in System Settings -> Privacy & Security -> Screen & System Audio Recording by clicking + and adding that exact file. macOS 26 refused to show a grant dialog for this binary, so the add button is the supported path.');
  if (stderr.trim()) console.error(stderr.trim());
  if (message.trim()) console.error(message.trim());
  process.exit(1);
}
NODE
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
  config) "$NODE_BIN" "$TERMINAL_CONFIG_COMMAND" daemon-config ;;
  configure-relay) configure_relay "$@" ;;
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
EOF
  chmod +x "${SUPPORT_DIR}/zterm-daemon.sh"
}

write_installer() {
  cat > "${BIN_DIR}/install-global.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_ROOT="$(python3 - "$PACKAGE_ROOT" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
VERSION="$(cat "${PACKAGE_ROOT}/VERSION")"
INSTALL_ROOT="${HOME}/.zterm/releases/zterm-daemon/${VERSION}"
LOCAL_BIN="${HOME}/.local/bin"
NODE_BIN="$(command -v node)"

"${NODE_BIN}" - "${PACKAGE_ROOT}" <<'NODE'
const fs = require('fs');
const path = require('path');

const packageRoot = process.argv[2];
const manifestPath = path.join(packageRoot, 'zterm-package.json');
if (!fs.existsSync(manifestPath)) {
  throw new Error('missing daemon package platform manifest: ' + manifestPath);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const minimum = String((manifest.platform && manifest.platform.node && manifest.platform.node.minimum) || '')
  .split('.')
  .map(Number);
const actual = process.versions.node.split('.').map(Number);
const supported =
  minimum.length === 3 &&
  minimum.every(Number.isFinite) &&
  (actual[0] > minimum[0] ||
    (actual[0] === minimum[0] &&
      (actual[1] > minimum[1] ||
        (actual[1] === minimum[1] && actual[2] >= minimum[2]))));
if (
  manifest.schemaVersion !== 1 ||
  !manifest.package ||
  manifest.package.name !== '@jsonstudio/zterm-daemon' ||
  !manifest.platform ||
  manifest.platform.os !== process.platform ||
  manifest.platform.arch !== process.arch ||
  manifest.platform.node.abi !== process.versions.modules ||
  !supported
) {
  throw new Error(
    'daemon package platform mismatch: expected ' +
      JSON.stringify(manifest.platform) +
      ', actual=' +
      JSON.stringify({
        os: process.platform,
        arch: process.arch,
        node: process.versions.node,
        abi: process.versions.modules,
      }),
  );
}
const missing = (manifest.runtimeComponents || []).filter(
  (component) => !fs.existsSync(path.join(packageRoot, component)),
);
if (missing.length > 0) {
  throw new Error('daemon package is missing runtime components: ' + missing.join(', '));
}
NODE

mkdir -p "${INSTALL_ROOT}" "${LOCAL_BIN}" "${HOME}/.zterm/bin"
rm -rf "${INSTALL_ROOT}/runtime" "${INSTALL_ROOT}/support"
cp -R "${PACKAGE_ROOT}/runtime" "${INSTALL_ROOT}/runtime"
cp -R "${PACKAGE_ROOT}/support" "${INSTALL_ROOT}/support"
cp "${PACKAGE_ROOT}/VERSION" "${INSTALL_ROOT}/VERSION"
cp "${PACKAGE_ROOT}/zterm-package.json" "${INSTALL_ROOT}/zterm-package.json"

NATIVE_TMP="${HOME}/.zterm/bin/.zterm-daemon.$$"
cp "${INSTALL_ROOT}/support/zterm-daemon" "${NATIVE_TMP}"
chmod +x "${NATIVE_TMP}"
mv "${NATIVE_TMP}" "${HOME}/.zterm/bin/zterm-daemon"

DAEMON_TMP="${LOCAL_BIN}/.zterm-daemon.shim.$$"
cat > "${DAEMON_TMP}" <<WRAP
#!/usr/bin/env bash
set -euo pipefail
exec "${INSTALL_ROOT}/support/zterm-daemon.sh" "\$@"
WRAP
chmod +x "${DAEMON_TMP}"
mv "${DAEMON_TMP}" "${LOCAL_BIN}/zterm-daemon"

WTERM_TMP="${LOCAL_BIN}/.wterm.shim.$$"
cat > "${WTERM_TMP}" <<WRAP
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "daemon" ]]; then
  shift
  exec "${INSTALL_ROOT}/support/zterm-daemon.sh" "\$@"
fi
case "\${1:-}" in
  start|stop|restart|status|config|configure-relay|install-service|uninstall-service|service-status|run)
    exec "${INSTALL_ROOT}/support/zterm-daemon.sh" "\$@"
    ;;
esac
echo "Usage:"
echo "  wterm daemon start|stop|restart|status|config|configure-relay|install-service|uninstall-service|service-status"
echo "  wterm start|stop|restart|status|config|configure-relay|install-service|uninstall-service|service-status"
exit 1
WRAP
chmod +x "${WTERM_TMP}"
mv "${WTERM_TMP}" "${LOCAL_BIN}/wterm"

echo "Installed zterm-daemon release ${VERSION}"
echo "  installRoot=${INSTALL_ROOT}"
echo "  cli=${LOCAL_BIN}/zterm-daemon"
echo "  alias=${LOCAL_BIN}/wterm"
echo
echo "Next:"
echo "  zterm-daemon install-service"
echo "  zterm-daemon service-status"
EOF
  chmod +x "${BIN_DIR}/install-global.sh"
}

write_package_manifest() {
  "${NODE_BIN}" - "${PACKAGE_MANIFEST_PATH}" "${PACKAGE_VERSION}" "${TARGET_OS}" "${TARGET_ARCH}" <<'NODE'
const fs = require('fs');
const path = require('path');

const [manifestPath, version, targetOs, targetArch] = process.argv.slice(2);
const releaseRoot = path.dirname(manifestPath);
const runtimeComponents = [
  'runtime/server.cjs',
  'runtime/dagpipe.node',
  'runtime/node_modules/node-pty',
  'runtime/node_modules/@roamhq/wrtc',
  `runtime/node_modules/@roamhq/wrtc-${targetOs}-${targetArch}/wrtc.node`,
  'support/zterm-daemon.sh',
  'support/zterm-daemon',
  'support/terminal-config-command.cjs',
];
if (targetOs === 'win32') {
  runtimeComponents.push('support/windows/zterm-daemon.ps1');
}
const missing = runtimeComponents.filter((component) => !fs.existsSync(path.join(releaseRoot, component)));
if (missing.length > 0) {
  throw new Error('daemon release is missing runtime components: ' + missing.join(', '));
}
fs.writeFileSync(manifestPath, `${JSON.stringify({
  schemaVersion: 1,
  package: {
    name: '@jsonstudio/zterm-daemon',
    version,
  },
  platform: {
    os: targetOs,
    arch: targetArch,
    node: {
      minimum: '20.0.0',
      abi: process.versions.modules,
    },
  },
  runtimeComponents,
}, null, 2)}\n`);
NODE
}

write_readme() {
  cat > "${RELEASE_DIR}/README.txt" <<EOF
ZTerm daemon standalone release
version: ${PACKAGE_VERSION}
target: ${TARGET_OS}-${TARGET_ARCH}

Install:
  ./bin/install-global.sh

Then:
  zterm-daemon install-service
  zterm-daemon service-status
EOF
  printf '%s\n' "${PACKAGE_VERSION}" > "${RELEASE_DIR}/VERSION"
}

normalize_release_tree_metadata() {
  local release_tree="$1"
  find "${release_tree}" -type d -exec chmod 0755 {} +
  find "${release_tree}" -type f -exec chmod 0644 {} +
  find "${release_tree}/runtime/node_modules" -type f \( -name 'spawn-helper' -o -name '*.node' \) -exec chmod 0755 {} +
  chmod 0755 \
    "${release_tree}/bin/install-global.sh" \
    "${release_tree}/support/zterm-daemon" \
    "${release_tree}/support/zterm-daemon.sh" \
    "${release_tree}/support/terminal-config-command.cjs"
  find "${release_tree}" -exec touch -h -t 200001010000 {} +
}

create_deterministic_archive() {
  local release_parent="$1"
  local output_path="$2"
  local release_tree="${release_parent}/${RELEASE_NAME}"
  normalize_release_tree_metadata "${release_tree}"
  (
    cd "${release_parent}"
    find "${RELEASE_NAME}" -print0 \
      | LC_ALL=C sort -z \
      | COPYFILE_DISABLE=1 tar \
          --null \
          --no-recursion \
          --format ustar \
          --uid 0 \
          --gid 0 \
          --uname root \
          --gname root \
          -cf - \
          -T -
  ) | gzip -n > "${output_path}"
}

verify_deterministic_archive() {
  local check_root="${RELEASE_DIST_DIR}/.daemon-release-determinism-check"
  local check_path="${check_root}/${RELEASE_NAME}.tar.gz"
  rm -rf "${check_root}"
  mkdir -p "${check_root}/${RELEASE_NAME}"
  (
    umask 077
    cp -RL "${RELEASE_DIR}/." "${check_root}/${RELEASE_NAME}/"
  )
  chmod -R go-rwx "${check_root}/${RELEASE_NAME}"
  create_deterministic_archive "${RELEASE_DIST_DIR}" "${ARCHIVE_PATH}"
  create_deterministic_archive "${check_root}" "${check_path}"
  if ! cmp -s "${ARCHIVE_PATH}" "${check_path}"; then
    echo "[prepare-global-daemon-release] nondeterministic archive output" >&2
    exit 1
  fi
  rm -rf "${check_root}"
}

if [[ "${1:-}" == "--stage-platform-support" ]]; then
  if [[ -z "${2:-}" ]]; then
    echo "usage: $0 --stage-platform-support <output-dir>" >&2
    exit 2
  fi
  RELEASE_DIR="$2"
  RUNTIME_DIR="${RELEASE_DIR}/runtime"
  SUPPORT_DIR="${RELEASE_DIR}/support"
  NATIVE_DAEMON_BIN="${SUPPORT_DIR}/zterm-daemon"
  REMOTE_WINDOW_CAPTURE_SWIFT="${RELEASE_DIR}/.remote-window-capture.swift"
  mkdir -p "${RUNTIME_DIR}" "${SUPPORT_DIR}"
  stage_native_daemon_binary
  stage_terminal_config_command
  write_support_script
  echo "[prepare-global-daemon-release] Darwin platform support staged"
  echo "- support: ${SUPPORT_DIR}"
  exit 0
fi

if [[ -z "${ZTERM_DAEMON_WRTC_INPUT_MANIFEST:-}" ]]; then
  echo "[prepare-global-daemon-release] ZTERM_DAEMON_WRTC_INPUT_MANIFEST is required; refusing to build a daemon release without the strict stage manifest" >&2
  exit 1
fi
if [[ ! -f "${ZTERM_DAEMON_WRTC_INPUT_MANIFEST}" ]]; then
  echo "[prepare-global-daemon-release] manifest not found: ${ZTERM_DAEMON_WRTC_INPUT_MANIFEST}" >&2
  exit 1
fi

mkdir -p "${RELEASE_DIST_DIR}"
rm -rf "${RELEASE_DIR}" "${ARCHIVE_PATH}" "${SHA_PATH}"
mkdir -p "${RUNTIME_DIR}" "${SUPPORT_DIR}" "${BIN_DIR}"

stage_runtime
stage_native_daemon_binary
stage_terminal_config_command
write_support_script
write_installer
write_readme
write_package_manifest

verify_deterministic_archive
shasum -a 256 "${ARCHIVE_PATH}" > "${SHA_PATH}"
EXPECTED_RELEASE_SHA="$(awk '{print $1}' "${SHA_PATH}")"
run_phase7_release_gate "${RELEASE_NAME}.tar.gz" "${EXPECTED_RELEASE_SHA}"

echo "[prepare-global-daemon-release] ready"
echo "- dir: ${RELEASE_DIR}"
echo "- archive: ${ARCHIVE_PATH}"
echo "- sha256: ${SHA_PATH}"
