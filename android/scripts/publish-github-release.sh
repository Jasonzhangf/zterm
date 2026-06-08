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
APK_URL="$(node -e "console.log(require('${MANIFEST}').apkUrl)")"
SHA256="$(node -e "console.log(require('${MANIFEST}').sha256)")"
SIZE="$(node -e "console.log(require('${MANIFEST}').size)")"
if [[ "${1:-}" == "--" ]]; then
  shift
fi
TAG="${1:-v${VERSION_NAME}}"
TARGET="${GITHUB_RELEASE_TARGET:-main}"
NOTES_FILE="$(mktemp -t zterm-release-notes.XXXXXX.md)"

APK="${RELEASE_DIST}/${APK_URL}"
DAEMON_ARCHIVE="${RELEASE_DIST}/zterm-daemon-${BASE_VERSION}-darwin-arm64.tar.gz"
DAEMON_ARCHIVE_SHA="${DAEMON_ARCHIVE}.sha256"
DAEMON_NPM="${RELEASE_DIST}/jsonstudio-zterm-daemon-${BASE_VERSION}.tgz"
DAEMON_NPM_SHA="${DAEMON_NPM}.sha256"

node "${ROOT_DIR}/scripts/verify-release-assets.mjs" >/dev/null

cat > "${NOTES_FILE}" <<NOTES
## ZTerm Android ${VERSION_NAME}

### Android installer

- \`${APK_URL}\`
- \`latest.json\` update manifest
- sha256: \`${SHA256}\`
- size: \`${SIZE}\`

### macOS daemon

Install from npm:

\`\`\`bash
npm install -g @jsonstudio/zterm-daemon
printf '%s\n' "$RELAY_PASSWORD" | zterm-daemon configure-relay \\
  --relay-url "$RELAY_BASE_URL" \\
  --username "$RELAY_USERNAME" \\
  --password-stdin \\
  --host-id "$(hostname -s)" \\
  --device-id "$(hostname -s)" \\
  --device-name "$(hostname)"
zterm-daemon install-service
zterm-daemon service-status
\`\`\`

Install from standalone tarball:

\`\`\`bash
tar -xzf zterm-daemon-${BASE_VERSION}-darwin-arm64.tar.gz
cd zterm-daemon-${BASE_VERSION}-darwin-arm64
./bin/install-global.sh
printf '%s\n' "$RELAY_PASSWORD" | zterm-daemon configure-relay \\
  --relay-url "$RELAY_BASE_URL" \\
  --username "$RELAY_USERNAME" \\
  --password-stdin \\
  --host-id "$(hostname -s)" \\
  --device-id "$(hostname -s)" \\
  --device-name "$(hostname)"
zterm-daemon install-service
zterm-daemon service-status
\`\`\`

### Release checks

- Android package built by \`./scripts/build-android-debug.sh\`
- daemon standalone package built by \`pnpm --dir android run daemon:prepare-release\`
- daemon npm package built by \`pnpm --dir android run daemon:prepare-npm\`
- release assets verified by \`pnpm --dir android run release:verify\`
NOTES

ASSETS=(
  "${APK}"
  "${MANIFEST}"
  "${DAEMON_ARCHIVE}"
  "${DAEMON_ARCHIVE_SHA}"
  "${DAEMON_NPM}"
  "${DAEMON_NPM_SHA}"
)

if gh release view "${TAG}" >/dev/null 2>&1; then
  gh release upload "${TAG}" "${ASSETS[@]}" --clobber
  gh release edit "${TAG}" --title "ZTerm Android ${VERSION_NAME}" --notes-file "${NOTES_FILE}" --target "${TARGET}"
else
  gh release create "${TAG}" "${ASSETS[@]}" --target "${TARGET}" --title "ZTerm Android ${VERSION_NAME}" --notes-file "${NOTES_FILE}"
fi

gh release view "${TAG}" --json tagName,url,assets --jq '{tagName,url,assets:[.assets[].name]}'
