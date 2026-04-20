#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR_REAL="$(python3 - "$ROOT_DIR" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
NODE_BIN="$(command -v node)"
BIN_DIR="${HOME}/.local/bin"
WTERM_HOME="${HOME}/.wterm"
WTERM_BIN_DIR="${WTERM_HOME}/bin"
CLI_RUNNER="${WTERM_BIN_DIR}/wterm-daemon-cli"

mkdir -p "$BIN_DIR" "$WTERM_BIN_DIR"

cat > "${CLI_RUNNER}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${ROOT_DIR_REAL}"

cmd="\${1:-run}"
if [[ "\$cmd" == "run" ]]; then
  chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper 2>/dev/null || true
  exec env -u TMUX -u TMUX_PANE "${NODE_BIN}" --import tsx src/server/server.ts
fi

exec bash "${ROOT_DIR_REAL}/scripts/wterm-mobile-daemon.sh" "\$@"
EOF

chmod +x "${CLI_RUNNER}"

cat > "${BIN_DIR}/wterm-mobile-daemon" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${CLI_RUNNER}" "\$@"
EOF

chmod +x "${BIN_DIR}/wterm-mobile-daemon"

cat > "${BIN_DIR}/wterm" <<EOF
#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" == "daemon" ]]; then
  shift
  exec "${CLI_RUNNER}" "\$@"
fi

case "\${1:-}" in
  start|stop|restart|status|install-service|uninstall-service|service-status|run)
    exec "${CLI_RUNNER}" "\$@"
    ;;
esac

echo "Usage:"
echo "  wterm daemon start|stop|restart|status|install-service|uninstall-service|service-status"
echo "  wterm start|stop|restart|status|install-service|uninstall-service|service-status"
exit 1
EOF

chmod +x "${BIN_DIR}/wterm"

cat > "${BIN_DIR}/wterm-mobile" <<EOF
#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" == "daemon" ]]; then
  shift
  exec "${BIN_DIR}/wterm" daemon "\$@"
fi

echo "Usage:"
echo "  wterm daemon start|stop|restart|status"
echo "  wterm-mobile daemon start|stop|restart|status"
exit 1
EOF

chmod +x "${BIN_DIR}/wterm-mobile"

echo "Installed:"
echo "  ${BIN_DIR}/wterm"
echo "  ${BIN_DIR}/wterm-mobile-daemon"
echo "  ${BIN_DIR}/wterm-mobile"
echo "  ${CLI_RUNNER}"
echo
echo "Examples:"
echo "  wterm daemon restart"
echo "  wterm daemon status"
echo "  wterm restart"
