#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(python3 - "$ROOT_DIR" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
WORKSPACE_DIR="$(python3 - "$ROOT_DIR" <<'PY'
import os, sys
print(os.path.realpath(os.path.join(sys.argv[1], '..', '..')))
PY
)"
NODE_BIN="$(command -v node)"
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PNPM_BIN="$(command -v pnpm || true)"
LOG_DIR="${HOME}/.wterm/logs"
WTERM_HOME="${HOME}/.wterm"
WTERM_BIN_DIR="${WTERM_HOME}/bin"
CLI_RUNNER="${WTERM_BIN_DIR}/wterm-daemon-cli"
LAUNCH_RUNNER="${WTERM_BIN_DIR}/wterm-daemon-launchd-run"
LAUNCH_AGENT_LABEL="com.wterm.mobile.daemon"
LAUNCH_AGENT_PATH="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
AUTH_TOKEN_MASKED=""

refresh_masked_auth_token() {
  AUTH_TOKEN_MASKED=""
  if [[ -z "${AUTH_TOKEN:-}" ]]; then
    return 0
  fi

  local token_len
  token_len=${#AUTH_TOKEN}
  if (( token_len <= 6 )); then
    AUTH_TOKEN_MASKED="${AUTH_TOKEN}"
  else
    AUTH_TOKEN_MASKED="${AUTH_TOKEN:0:3}***${AUTH_TOKEN: -3}"
  fi
}

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
console.log(`AUTH_TOKEN=${JSON.stringify(config.authToken)}`);
console.log(`AUTH_SOURCE=${config.authSource}`);
console.log(`CONFIG_FOUND=${config.configFound ? '1' : '0'}`);
console.log(`CONFIG_DISPLAY_PATH=${WTERM_CONFIG_DISPLAY_PATH}`);
EOF
}

eval "$(read_config)"
refresh_masked_auth_token

resolve_pnpm_binary() {
  if [[ -n "$PNPM_BIN" ]]; then
    echo "$PNPM_BIN"
    return 0
  fi

  for candidate in /opt/homebrew/bin/pnpm /usr/local/bin/pnpm; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

ensure_runtime_ready() {
  local pnpm_path core_dist
  core_dist="${WORKSPACE_DIR}/packages/@wterm/core/dist/index.js"
  if [[ -f "$core_dist" ]]; then
    :
  else
    pnpm_path="$(resolve_pnpm_binary || true)"
    if [[ -z "$pnpm_path" ]]; then
      echo "pnpm not found. Install pnpm before starting wterm daemon."
      return 1
    fi

    echo "Preparing @wterm/core runtime artifacts..."
    "$pnpm_path" --dir "$WORKSPACE_DIR" --filter @wterm/core build
  fi

  cd "$ROOT_DIR"
  "$NODE_BIN" --import tsx ./scripts/prepare-runtime.ts
}

generate_auth_token() {
  "$NODE_BIN" --input-type=module <<'EOF'
import { randomBytes } from 'node:crypto';
console.log(randomBytes(24).toString('base64url'));
EOF
}

write_daemon_config() {
  local next_host="$1"
  local next_port="$2"
  local next_auth_token="$3"
  local next_cache_lines="$4"
  local next_session_name="$5"

  mkdir -p "$WTERM_HOME"
  export WTERM_INSTALL_HOST="$next_host"
  export WTERM_INSTALL_PORT="$next_port"
  export WTERM_INSTALL_AUTH_TOKEN="$next_auth_token"
  export WTERM_INSTALL_CACHE_LINES="$next_cache_lines"
  export WTERM_INSTALL_SESSION_NAME="$next_session_name"
  export WTERM_INSTALL_CONFIG_PATH="${WTERM_HOME}/config.json"

  "$NODE_BIN" --input-type=module <<'EOF'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const configPath = process.env.WTERM_INSTALL_CONFIG_PATH;
const host = process.env.WTERM_INSTALL_HOST;
const port = Number.parseInt(process.env.WTERM_INSTALL_PORT || '', 10);
const authToken = process.env.WTERM_INSTALL_AUTH_TOKEN || '';
const terminalCacheLines = Number.parseInt(process.env.WTERM_INSTALL_CACHE_LINES || '', 10);
const sessionName = process.env.WTERM_INSTALL_SESSION_NAME || '';

let current = {};
try {
  current = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') {
    throw error;
  }
}

if (!current || typeof current !== 'object' || Array.isArray(current)) {
  current = {};
}

const next = {
  ...current,
  mobile: {
    ...(current.mobile && typeof current.mobile === 'object' && !Array.isArray(current.mobile) ? current.mobile : {}),
    daemon: {
      ...(
        current.mobile?.daemon &&
        typeof current.mobile.daemon === 'object' &&
        !Array.isArray(current.mobile.daemon)
          ? current.mobile.daemon
          : {}
      ),
      host,
      port,
      authToken,
      terminalCacheLines,
      sessionName,
    },
  },
};

mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
EOF
}

prompt_with_default() {
  local prompt="$1"
  local default_value="$2"
  local current=""
  read -r -p "$prompt [$default_value]: " current
  if [[ -z "$current" ]]; then
    printf '%s\n' "$default_value"
    return 0
  fi
  printf '%s\n' "$current"
}

interactive_install() {
  local default_host default_port default_cache_lines default_session_name next_host next_port next_auth_token next_cache_lines next_session_name
  default_host="${HOST}"
  default_port="${PORT}"
  default_cache_lines="${WTERM_MOBILE_TERMINAL_CACHE_LINES:-3000}"
  default_session_name="${SESSION_NAME}"
  if [[ -f "${WTERM_HOME}/config.json" ]]; then
    default_cache_lines="$("$NODE_BIN" --input-type=module <<'EOF'
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const path = join(homedir(), '.wterm', 'config.json');
try {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const value = json?.mobile?.daemon?.terminalCacheLines;
  console.log(Number.isFinite(value) ? value : 3000);
} catch {
  console.log(3000);
}
EOF
)"
  fi

  echo "wterm daemon interactive install"
  echo "All config will be written to ${WTERM_HOME}/config.json"
  echo

  next_host="$(prompt_with_default 'Daemon host' "$default_host")"
  next_port="$(prompt_with_default 'Daemon port' "$default_port")"
  next_cache_lines="$(prompt_with_default 'Terminal cache lines' "$default_cache_lines")"
  next_session_name="$(prompt_with_default 'Daemon session name' "$default_session_name")"

  if [[ -n "${AUTH_TOKEN:-}" ]]; then
    echo "Existing auth token: ${AUTH_TOKEN_MASKED}"
  else
    echo "No existing auth token found."
  fi

  read -r -s -p "Daemon auth token [leave blank to keep existing / auto-generate]: " next_auth_token
  echo
  if [[ -z "$next_auth_token" ]]; then
    if [[ -n "${AUTH_TOKEN:-}" ]]; then
      next_auth_token="$AUTH_TOKEN"
    else
      next_auth_token="$(generate_auth_token)"
      echo "Generated auth token: $next_auth_token"
    fi
  fi

  write_daemon_config "$next_host" "$next_port" "$next_auth_token" "$next_cache_lines" "$next_session_name"
  eval "$(read_config)"
  refresh_masked_auth_token

  echo "Saved daemon config -> ${CONFIG_DISPLAY_PATH}"
  echo "host=${HOST}"
  echo "port=${PORT}"
  echo "session=${SESSION_NAME}"
  echo "auth=${AUTH_TOKEN_MASKED:-set}"
  echo

  install_service
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/wterm-mobile-daemon.sh install
  ./scripts/wterm-mobile-daemon.sh run
  ./scripts/wterm-mobile-daemon.sh start
  ./scripts/wterm-mobile-daemon.sh status
  ./scripts/wterm-mobile-daemon.sh stop
  ./scripts/wterm-mobile-daemon.sh restart
  ./scripts/wterm-mobile-daemon.sh install-service
  ./scripts/wterm-mobile-daemon.sh uninstall-service
  ./scripts/wterm-mobile-daemon.sh service-status
  wterm daemon install|start|stop|restart|status|install-service|uninstall-service|service-status

Behavior:
  - `install` interactively configures auth/host/port under ~/.wterm/config.json and then installs autostart
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
  ensure_runtime_ready
  cd "$ROOT_DIR"
  exec env -u TMUX -u TMUX_PANE HOST="$HOST" PORT="$PORT" WTERM_MOBILE_HOST="$HOST" WTERM_MOBILE_PORT="$PORT" WTERM_MOBILE_AUTH_TOKEN="${WTERM_MOBILE_AUTH_TOKEN:-}" "$NODE_BIN" --import tsx src/server/server.ts
}

status_tmux() {
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "wterm-mobile daemon running: session=${SESSION_NAME} host=${HOST} port=${PORT} auth=${AUTH_SOURCE}"
    return 0
  fi

  echo "wterm-mobile daemon not running (${PORT})"
  echo "config=${CONFIG_DISPLAY_PATH} found=${CONFIG_FOUND} auth=${AUTH_SOURCE}"
  return 1
}

status_service() {
  if ! service_installed; then
    echo "wterm-mobile autostart service not installed"
    echo "plist=${LAUNCH_AGENT_PATH}"
    return 1
  fi

  local snapshot last_exit active_count
  snapshot="$(service_snapshot)"
  last_exit="$(printf '%s\n' "$snapshot" | awk '/last exit code =/ { print $5; exit }')"
  active_count="$(printf '%s\n' "$snapshot" | awk '/active count =/ { print $4; exit }')"

  if [[ -n "$snapshot" ]] && lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "wterm-mobile autostart service running: label=${LAUNCH_AGENT_LABEL} host=${HOST} port=${PORT} auth=${AUTH_SOURCE}"
    echo "plist=${LAUNCH_AGENT_PATH}"
    echo "active_count=${active_count:-unknown} last_exit=${last_exit:-unknown}"
    return 0
  fi

  echo "wterm-mobile autostart service installed but not listening: label=${LAUNCH_AGENT_LABEL}"
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
    echo "wterm-mobile daemon already running: session=${SESSION_NAME} host=${HOST} port=${PORT} auth=${AUTH_SOURCE}"
    echo "log dir: ${LOG_DIR}"
    return 0
  fi

  ensure_runtime_ready
  cd "$ROOT_DIR"

  tmux new-session -d -s "$SESSION_NAME" \
    "cd '$ROOT_DIR' && env -u TMUX -u TMUX_PANE HOST='$HOST' PORT='$PORT' WTERM_MOBILE_HOST='$HOST' WTERM_MOBILE_PORT='$PORT' WTERM_MOBILE_AUTH_TOKEN='${WTERM_MOBILE_AUTH_TOKEN:-}' '$NODE_BIN' --import tsx src/server/server.ts >>'$log_file' 2>&1"

  echo "wterm-mobile daemon started"
  echo "session=${SESSION_NAME}"
  echo "host=${HOST}"
  echo "port=${PORT}"
  echo "auth=${AUTH_SOURCE}"
  echo "config=${CONFIG_DISPLAY_PATH}"
  echo "log=${log_file}"
}

stop_tmux() {
  if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "wterm-mobile daemon not running (${PORT})"
    return 0
  fi

  tmux kill-session -t "$SESSION_NAME"
  echo "wterm-mobile daemon stopped: session=${SESSION_NAME}"
}

write_launch_agent() {
  mkdir -p "${HOME}/Library/LaunchAgents" "$LOG_DIR" "$WTERM_BIN_DIR"
  cat > "$LAUNCH_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${CLI_RUNNER}" run
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

start_service() {
  if ! service_installed; then
    echo "wterm-mobile autostart service not installed"
    echo "run: ./scripts/wterm-mobile-daemon.sh install-service"
    return 1
  fi

  stop_tmux >/dev/null 2>&1 || true

  if service_loaded; then
    launchctl kickstart -k "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  else
    launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT_PATH" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_PATH"
    launchctl kickstart -k "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi

  wait_for_service_ready || true
  status_service
}

stop_service() {
  if ! service_installed; then
    echo "wterm-mobile autostart service not installed"
    return 0
  fi

  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi
  launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT_PATH" >/dev/null 2>&1 || true

  echo "wterm-mobile autostart service stopped: label=${LAUNCH_AGENT_LABEL}"
}

restart_service() {
  if ! service_installed; then
    echo "wterm-mobile autostart service not installed"
    echo "run: ./scripts/wterm-mobile-daemon.sh install-service"
    return 1
  fi

  stop_tmux >/dev/null 2>&1 || true

  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi
  launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT_PATH" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_PATH"
  launchctl kickstart -k "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  wait_for_service_ready || true
  status_service
}

install_service() {
  ensure_runtime_ready
  stop_tmux >/dev/null 2>&1 || true
  write_launch_agent
  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi
  launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT_PATH" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_PATH"
  launchctl kickstart -k "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  echo "wterm-mobile autostart service installed"
  echo "plist=${LAUNCH_AGENT_PATH}"
  wait_for_service_ready || true
  status_service
}

uninstall_service() {
  if service_loaded; then
    launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}"
  fi
  launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT_PATH" >/dev/null 2>&1 || true
  rm -f "$LAUNCH_AGENT_PATH"
  echo "wterm-mobile autostart service uninstalled"
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
  install) interactive_install ;;
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
