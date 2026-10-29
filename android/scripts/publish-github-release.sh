#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIST="${ROOT_DIR}/release-dist"
MANIFEST="${RELEASE_DIST}/latest.json"

if [[ ! -f "${MANIFEST}" ]]; then
  echo "missing ${MANIFEST}; run ./scripts/build-android-debug.sh first" >&2
  exit 1
fi

VERSION_NAME="$(node -e "console.log(require('${MANIFEST}').versionName)")"
BASE_VERSION="$(node -e "console.log(require('${ROOT_DIR}/package.json').version)")"
CLI_VERSION="$(node -e "console.log(require('${ROOT_DIR}/../packages/cli/package.json').version)")"
APK_URL="$(node -e "console.log(require('${MANIFEST}').apkUrl)")"
ROLLBACK_APK_URL="$(node -e "console.log(require('${MANIFEST}').preparedRollback?.apkUrl || '')")"
SHA256="$(node -e "console.log(require('${MANIFEST}').sha256)")"
SIZE="$(node -e "console.log(require('${MANIFEST}').size)")"
if [[ "${1:-}" == "--" ]]; then
  shift
fi
TAG="${1:-v${VERSION_NAME}}"
TARGET="${GITHUB_RELEASE_TARGET:-main}"
NOTES_FILE="$(mktemp -t zterm-release-notes.XXXXXX.md)"

APK="${RELEASE_DIST}/$(basename "${APK_URL}")"
ROLLBACK_APK="${RELEASE_DIST}/$(basename "${ROLLBACK_APK_URL:-zterm-${VERSION_NAME}.1.apk}")"
DAEMON_ARCHIVE="${RELEASE_DIST}/zterm-daemon-${BASE_VERSION}-darwin-arm64.tar.gz"
DAEMON_ARCHIVE_SHA="${DAEMON_ARCHIVE}.sha256"
DAEMON_PACKAGE_SET="${ZTERM_DAEMON_PACKAGES_DIR:-${RELEASE_DIST}/npm/zterm-daemon-${BASE_VERSION}}"
DAEMON_NPM="${DAEMON_PACKAGE_SET}/jsonstudio-zterm-daemon-${BASE_VERSION}.tgz"
DAEMON_NPM_DARWIN="${DAEMON_PACKAGE_SET}/jsonstudio-zterm-daemon-darwin-arm64-${BASE_VERSION}.tgz"
DAEMON_NPM_LINUX="${DAEMON_PACKAGE_SET}/jsonstudio-zterm-daemon-linux-x64-${BASE_VERSION}.tgz"
DAEMON_NPM_WIN32="${DAEMON_PACKAGE_SET}/jsonstudio-zterm-daemon-win32-x64-${BASE_VERSION}.tgz"
CLI_NPM="${RELEASE_DIST}/jsonstudio-zterm-cli-${CLI_VERSION}.tgz"

node "${ROOT_DIR}/scripts/verify-release-assets.mjs" \
  --release-dist "${RELEASE_DIST}" \
  --daemon-packages-dir "${DAEMON_PACKAGE_SET}" >/dev/null

cat > "${NOTES_FILE}" <<NOTES
## ZTerm Android ${VERSION_NAME} (CLI ${CLI_VERSION} / Daemon ${BASE_VERSION})

### Android installer

- \`$(basename "${APK_URL}")\`
- \`latest.json\` update manifest
- sha256: \`${SHA256}\`
- size: \`${SIZE}\`

### Remote CLI & Daemon (Node.js 22 LTS, ABI 127)

Install from npm:

\`\`\`bash
npm install -g @jsonstudio/zterm-cli@${CLI_VERSION}
zterm daemon install --version ${BASE_VERSION}
\`\`\`

### macOS daemon service setup

Install from npm:

\`\`\`bash
npm install -g @jsonstudio/zterm-daemon@${BASE_VERSION}
printf '%s\n' "\$RELAY_PASSWORD" | zterm-daemon configure-relay \\
  --relay-url "\$RELAY_BASE_URL" \\
  --username "\$RELAY_USERNAME" \\
  --password-stdin \\
  --host-id "\$(hostname -s)" \\
  --device-id "\$(hostname -s)" \\
  --device-name "\$(hostname)"
zterm-daemon install-service
zterm-daemon service-status
\`\`\`

Install from standalone tarball:

\`\`\`bash
tar -xzf zterm-daemon-${BASE_VERSION}-darwin-arm64.tar.gz
cd zterm-daemon-${BASE_VERSION}-darwin-arm64
./bin/install-global.sh
printf '%s\n' "\$RELAY_PASSWORD" | zterm-daemon configure-relay \\
  --relay-url "\$RELAY_BASE_URL" \\
  --username "\$RELAY_USERNAME" \\
  --password-stdin \\
  --host-id "\$(hostname -s)" \\
  --device-id "\$(hostname -s)" \\
  --device-name "\$(hostname)"
zterm-daemon install-service
zterm-daemon service-status
\`\`\`

### Release checks

- Android package built by \`./scripts/build-android-debug.sh\`
- daemon standalone package built by \`pnpm --dir android run daemon:prepare-release\`
- daemon npm package set supplied by the CLI Platform aggregate-pack artifact
- release assets verified by \`pnpm --dir android run release:verify\`
NOTES

ASSETS=(
  "${APK}"
  "${MANIFEST}"
  "${DAEMON_ARCHIVE}"
  "${DAEMON_ARCHIVE_SHA}"
  "${DAEMON_NPM}"
  "${DAEMON_NPM_DARWIN}"
  "${DAEMON_NPM_LINUX}"
  "${DAEMON_NPM_WIN32}"
)
if [[ -f "${ROLLBACK_APK}" ]]; then
  ASSETS+=("${ROLLBACK_APK}")
fi
if [[ -f "${CLI_NPM}" ]]; then
  ASSETS+=("${CLI_NPM}")
fi

if ! gh release view "${TAG}" >/dev/null 2>&1; then
  gh release create "${TAG}" --target "${TARGET}" --title "ZTerm Android ${VERSION_NAME}" --notes-file "${NOTES_FILE}"
else
  gh release edit "${TAG}" --title "ZTerm Android ${VERSION_NAME}" --notes-file "${NOTES_FILE}" --target "${TARGET}"
fi

for asset in "${ASSETS[@]}"; do
  gh release upload "${TAG}" "${asset}" --clobber
done

gh release view "${TAG}" --json tagName,url,assets --jq '{tagName,url,assets:[.assets[].name]}'
