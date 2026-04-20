#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"
pnpm build
npx cap sync android

cat <<'EOF'
Android verify checklist:
1. install APK or run `npx cap run android`
2. verify host create -> save -> connect on device
3. capture screenshot / logcat / APK path
4. store evidence under evidence/<date-task>/
EOF

