#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DAGPIPE_DIR="${ROOT_DIR}/native/dagpipe"

bash "${ROOT_DIR}/scripts/build-dagpipe-native.sh"

cd "${DAGPIPE_DIR}"
cargo fmt --check
cargo clippy --no-default-features -- -D warnings
cargo test --no-default-features

cd "${ROOT_DIR}"
pnpm --dir "${ROOT_DIR}" exec vitest run src/server/dagpipe-bridge.test.ts --reporter dot
pnpm --dir "${ROOT_DIR}" run test:dagpipe-phase0
