#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"
pnpm type-check

cat <<'EOF'
Web verify checklist:
1. run: pnpm dev
2. open the portless *.localhost URL printed in terminal
3. verify host create -> save -> connect
4. store screenshots/logs under evidence/<date-task>/
EOF

