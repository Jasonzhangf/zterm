#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR_REAL="$(python3 - "$ROOT_DIR" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
BIN_DIR="${HOME}/.local/bin"
WTERM_HOME="${HOME}/.wterm"
WTERM_BIN_DIR="${WTERM_HOME}/bin"
CLI_RUNNER="${WTERM_BIN_DIR}/wterm-daemon-cli"
DIRECT_RUNNER="${WTERM_BIN_DIR}/zterm-daemon-run"

mkdir -p "$BIN_DIR" "$WTERM_BIN_DIR"

cat > "${CLI_RUNNER}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "${HOME}"

cmd="\${1:-run}"
if [[ "\$cmd" == "run" ]]; then
  exec bash "${ROOT_DIR_REAL}/scripts/zterm-daemon.sh" run
fi

exec bash "${ROOT_DIR_REAL}/scripts/zterm-daemon.sh" "\$@"
EOF

chmod +x "${CLI_RUNNER}"

cat > "${DIRECT_RUNNER}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec bash "${ROOT_DIR_REAL}/scripts/zterm-daemon.sh" run
EOF

chmod +x "${DIRECT_RUNNER}"

cat > "${BIN_DIR}/zterm-daemon" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${CLI_RUNNER}" "\$@"
EOF

chmod +x "${BIN_DIR}/zterm-daemon"

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

echo "Installed:"
echo "  ${BIN_DIR}/wterm"
echo "  ${BIN_DIR}/zterm-daemon"
echo "  ${CLI_RUNNER}"
echo "  ${DIRECT_RUNNER}"
echo
echo "Examples:"
echo "  zterm-daemon restart"
echo "  zterm-daemon status"
echo "  wterm daemon restart"
echo "  wterm daemon status"
echo "  wterm restart"
