#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_ROOT="$(python3 - "$PACKAGE_ROOT" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
VERSION="$(cat "${PACKAGE_ROOT}/VERSION")"
INSTALL_ROOT="${HOME}/.wterm/releases/zterm-daemon/${VERSION}"
LOCAL_BIN="${HOME}/.local/bin"

mkdir -p "${INSTALL_ROOT}" "${LOCAL_BIN}"
rm -rf "${INSTALL_ROOT}/runtime" "${INSTALL_ROOT}/support"
cp -R "${PACKAGE_ROOT}/runtime" "${INSTALL_ROOT}/runtime"
cp -R "${PACKAGE_ROOT}/support" "${INSTALL_ROOT}/support"
cp "${PACKAGE_ROOT}/VERSION" "${INSTALL_ROOT}/VERSION"

cat > "${LOCAL_BIN}/zterm-daemon" <<WRAP
#!/usr/bin/env bash
set -euo pipefail
exec "${INSTALL_ROOT}/support/zterm-daemon.sh" "\$@"
WRAP
chmod +x "${LOCAL_BIN}/zterm-daemon"

cat > "${LOCAL_BIN}/wterm" <<WRAP
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "daemon" ]]; then
  shift
  exec "${INSTALL_ROOT}/support/zterm-daemon.sh" "\$@"
fi
case "\${1:-}" in
  start|stop|restart|status|install-service|uninstall-service|service-status|run)
    exec "${INSTALL_ROOT}/support/zterm-daemon.sh" "\$@"
    ;;
esac
echo "Usage:"
echo "  wterm daemon start|stop|restart|status|install-service|uninstall-service|service-status"
echo "  wterm start|stop|restart|status|install-service|uninstall-service|service-status"
exit 1
WRAP
chmod +x "${LOCAL_BIN}/wterm"

echo "Installed zterm-daemon release ${VERSION}"
echo "  installRoot=${INSTALL_ROOT}"
echo "  cli=${LOCAL_BIN}/zterm-daemon"
echo "  alias=${LOCAL_BIN}/wterm"
echo
echo "Next:"
echo "  zterm-daemon install-service"
echo "  zterm-daemon service-status"
