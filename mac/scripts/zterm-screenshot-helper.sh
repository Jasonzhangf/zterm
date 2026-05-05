#!/usr/bin/env bash
set -euo pipefail

MAC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MAC_DIR="$(python3 - "$MAC_DIR" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
WTERM_HOME="${HOME}/.wterm"
WTERM_BIN_DIR="${WTERM_HOME}/bin"
WTERM_RUN_DIR="${WTERM_HOME}/run"
WTERM_LOG_DIR="${WTERM_HOME}/logs"
APP_BUNDLE="/Applications/ZTerm.app"
APP_BINARY="${APP_BUNDLE}/Contents/MacOS/ZTerm"
RUNNER_PATH="${WTERM_BIN_DIR}/zterm-screenshot-helper-run"
PID_FILE="${WTERM_RUN_DIR}/remote-screenshot-helper.pid"
STATUS_FILE="${WTERM_RUN_DIR}/remote-screenshot-helper.json"
SOCKET_PATH="${WTERM_RUN_DIR}/remote-screenshot-helper.sock"
LAUNCH_AGENT_LABEL="com.zterm.mac.screenshot-helper"
LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
STDOUT_LOG="${WTERM_LOG_DIR}/screenshot-helper-stdout.log"
STDERR_LOG="${WTERM_LOG_DIR}/screenshot-helper-stderr.log"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/zterm-screenshot-helper.sh start
  ./scripts/zterm-screenshot-helper.sh stop
  ./scripts/zterm-screenshot-helper.sh restart
  ./scripts/zterm-screenshot-helper.sh status
  ./scripts/zterm-screenshot-helper.sh install-service
  ./scripts/zterm-screenshot-helper.sh uninstall-service
EOF
}

ensure_dirs() {
  mkdir -p "${WTERM_BIN_DIR}" "${WTERM_RUN_DIR}" "${WTERM_LOG_DIR}" "${HOME}/Library/LaunchAgents"
}

require_app_binary() {
  if [[ ! -x "${APP_BINARY}" ]]; then
    echo "[screenshot-helper] missing helper binary: ${APP_BINARY}" >&2
    echo "[screenshot-helper] please package the Mac app first: pnpm --dir mac exec electron-builder --mac dir" >&2
    exit 1
  fi
}

ensure_app_bundle_identity() {
  require_app_binary
  find "${APP_BUNDLE}" -name '*.cstemp' -delete >/dev/null 2>&1 || true

  local current_identifier=""
  current_identifier="$(
    codesign -dv --verbose=4 "${APP_BUNDLE}" 2>&1 \
      | sed -n 's/^Identifier=//p' \
      | head -n 1
  )"

  if [[ "${current_identifier}" == "com.zterm.mac" ]]; then
    return 0
  fi

  echo "[screenshot-helper] normalizing app bundle signature to adhoc com.zterm.mac" >&2
  codesign --force --deep --sign - "${APP_BUNDLE}"
}

service_installed() {
  [[ -f "${LAUNCH_AGENT_PATH}" ]]
}

service_loaded() {
  launchctl print "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >/dev/null 2>&1
}

read_helper_pid() {
  [[ -f "${PID_FILE}" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "${PID_FILE}")"
  [[ -n "${pid}" ]] || return 1
  printf '%s\n' "${pid}"
}

helper_pid_running() {
  local pid="${1:-}"
  [[ -n "${pid}" ]] || return 1
  kill -0 "${pid}" >/dev/null 2>&1
}

helper_ready() {
  local pid=""
  if ! pid="$(read_helper_pid 2>/dev/null)"; then
    return 1
  fi
  helper_pid_running "${pid}" || return 1
  [[ -S "${SOCKET_PATH}" ]] || return 1
  [[ -f "${STATUS_FILE}" ]] || return 1
}

wait_for_helper_ready() {
  local attempts=0
  while (( attempts < 50 )); do
    if helper_ready; then
      return 0
    fi
    sleep 0.1
    attempts=$((attempts + 1))
  done
  return 1
}

wait_for_helper_stopped() {
  local attempts=0
  while (( attempts < 50 )); do
    local pid=""
    if ! pid="$(read_helper_pid 2>/dev/null)" || ! helper_pid_running "${pid}"; then
      return 0
    fi
    sleep 0.1
    attempts=$((attempts + 1))
  done
  return 1
}

write_runner() {
  ensure_dirs
  ensure_app_bundle_identity
  cat > "${RUNNER_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/open -n -a "${APP_BUNDLE}" --args --screenshot-helper
EOF
  chmod +x "${RUNNER_PATH}"
}

write_launch_agent_plist() {
  ensure_dirs
  cat > "${LAUNCH_AGENT_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${RUNNER_PATH}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>${STDOUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${STDERR_LOG}</string>
</dict>
</plist>
EOF
}

start_direct() {
  local pid=""
  if pid="$(read_helper_pid 2>/dev/null)" && helper_pid_running "${pid}" && [[ -S "${SOCKET_PATH}" ]]; then
    echo "zterm screenshot helper already running: pid=${pid} mode=direct"
    return 0
  fi

  ensure_dirs
  ensure_app_bundle_identity
  : > "${STDOUT_LOG}"
  : > "${STDERR_LOG}"
  /usr/bin/open -n -a "${APP_BUNDLE}" --args --screenshot-helper >>"${STDOUT_LOG}" 2>>"${STDERR_LOG}" &

  if ! wait_for_helper_ready; then
    echo "[screenshot-helper] helper failed to become ready" >&2
    [[ -f "${STDERR_LOG}" ]] && tail -n 40 "${STDERR_LOG}" >&2 || true
    exit 1
  fi

  pid="$(read_helper_pid)"
  echo "zterm screenshot helper started: pid=${pid} mode=direct socket=${SOCKET_PATH}"
}

start_service() {
  write_runner
  write_launch_agent_plist
  if service_loaded; then
    launchctl kickstart -k "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  else
    launchctl bootstrap "gui/$(id -u)" "${LAUNCH_AGENT_PATH}"
  fi

  if ! wait_for_helper_ready; then
    echo "[screenshot-helper] launch agent started but helper not ready" >&2
    launchctl print "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >&2 || true
    [[ -f "${STDERR_LOG}" ]] && tail -n 40 "${STDERR_LOG}" >&2 || true
    exit 1
  fi

  local pid
  pid="$(read_helper_pid)"
  echo "zterm screenshot helper started: pid=${pid} mode=launch-agent socket=${SOCKET_PATH}"
}

stop_direct() {
  local pid=""
  if ! pid="$(read_helper_pid 2>/dev/null)" || ! helper_pid_running "${pid}"; then
    echo "zterm screenshot helper not running"
    return 0
  fi

  kill "${pid}"
  wait_for_helper_stopped || true
  echo "zterm screenshot helper stopped: pid=${pid}"
}

stop_service() {
  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi

  local pid=""
  if pid="$(read_helper_pid 2>/dev/null)" && helper_pid_running "${pid}"; then
    kill "${pid}"
    wait_for_helper_stopped || true
  fi
  echo "zterm screenshot helper service stopped"
}

show_status() {
  local mode="direct"
  if service_installed; then
    mode="launch-agent"
  fi

  if helper_ready; then
    local pid
    pid="$(read_helper_pid)"
    echo "zterm screenshot helper running: pid=${pid} mode=${mode} socket=${SOCKET_PATH}"
    if service_installed; then
      echo "launch-agent: ${LAUNCH_AGENT_PATH}"
      launchctl print "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" | sed -n '1,24p'
    fi
    return 0
  fi

  echo "zterm screenshot helper not running"
  if service_installed; then
    echo "launch-agent: ${LAUNCH_AGENT_PATH}"
    launchctl print "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" | sed -n '1,24p' || true
  fi
  [[ -f "${STATUS_FILE}" ]] && echo "stale status file: ${STATUS_FILE}" || true
  [[ -S "${SOCKET_PATH}" ]] && echo "stale socket: ${SOCKET_PATH}" || true
  return 1
}

install_service() {
  write_runner
  write_launch_agent_plist
  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi
  launchctl bootstrap "gui/$(id -u)" "${LAUNCH_AGENT_PATH}"
  if ! wait_for_helper_ready; then
    echo "[screenshot-helper] install-service failed to start helper" >&2
    launchctl print "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" >&2 || true
    [[ -f "${STDERR_LOG}" ]] && tail -n 40 "${STDERR_LOG}" >&2 || true
    exit 1
  fi
  local pid
  pid="$(read_helper_pid)"
  echo "zterm screenshot helper service installed: pid=${pid} socket=${SOCKET_PATH}"
}

uninstall_service() {
  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi
  rm -f "${LAUNCH_AGENT_PATH}"
  if [[ -f "${RUNNER_PATH}" ]]; then
    rm -f "${RUNNER_PATH}"
  fi
  local pid=""
  if pid="$(read_helper_pid 2>/dev/null)" && helper_pid_running "${pid}"; then
    kill "${pid}"
    wait_for_helper_stopped || true
  fi
  echo "zterm screenshot helper service uninstalled"
}

command="${1:-}"

case "${command}" in
  start)
    if service_installed; then
      start_service
    else
      start_direct
    fi
    ;;
  stop)
    if service_installed; then
      stop_service
    else
      stop_direct
    fi
    ;;
  restart)
    if service_installed; then
      stop_service
      start_service
    else
      stop_direct
      start_direct
    fi
    ;;
  status)
    show_status
    ;;
  install-service)
    install_service
    ;;
  uninstall-service)
    uninstall_service
    ;;
  *)
    usage
    exit 1
    ;;
esac
