#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORPUS="${ZTERM_MEMPALACE_CORPUS:-/Volumes/extension/code/memory/zterm-mempalace-corpus-safe}"
MARKER="$CORPUS/.zterm-mempalace-corpus"
cd "$ROOT"

for arg in "$@"; do
  case "$arg" in
    --no-gitignore|--include-ignored|--include-ignored=*)
      echo "Refusing to run mempalace with ignored-path overrides in zterm: $arg" >&2
      exit 2
      ;;
  esac
done

required_ignored=(
  "android/dist/index.html"
  "android/update-dist/latest.json"
  "android/release-dist/zterm-latest-debug.apk"
  "android/release-dist/jsonstudio-zterm-daemon-0.1.3.tgz"
  "android/native/android/app/build/outputs/apk/debug/app-debug.apk"
  "android/evidence/daemon-mirror/2026-07-02/current-daemon.log"
  "android/node_modules/.modules.yaml"
  "node_modules/.modules.yaml"
  ".reasonix/truncated-results/1781184229014-af1ccee4-run_command.txt"
)

rsync_excludes=(
  "--exclude=.DS_Store"
  "--exclude=.git/"
  "--exclude=.beads/"
  "--exclude=.agent-state/"
  "--exclude=.reasonix/"
  "--exclude=.local-index/"
  "--exclude=.mempalace/"
  "--exclude=.vscode/"
  "--exclude=.idea/"
  "--exclude=node_modules/"
  "--exclude=dist/"
  "--exclude=build/"
  "--exclude=target/"
  "--exclude=coverage/"
  "--exclude=.next/"
  "--exclude=.cache/"
  "--exclude=.turbo/"
  "--exclude=.pnpm-store/"
  "--exclude=.yarn/"
  "--exclude=release-dist/"
  "--exclude=update-dist/"
  "--exclude=evidence/"
  "--exclude=docs/wiki/generated/"
  "--exclude=docs/tab-swipe-grid-preview/"
  "--exclude=docs/tab-swipe-grid-session-preview/"
  "--exclude=main/assets/public/"
  "--exclude=main/assets/capacitor.config.json"
  "--exclude=main/assets/capacitor.plugins.json"
  "--exclude=artifacts/"
  "--exclude=tmp/"
  "--exclude=.tmp/"
  "--exclude=backups/"
  "--exclude=archive/"
  "--exclude=*.apk"
  "--exclude=*.tgz"
  "--exclude=*.zip"
  "--exclude=*.tar"
  "--exclude=*.tar.gz"
  "--exclude=*.html"
  "--exclude=*.log"
  "--exclude=*.lock"
  "--exclude=*.png"
  "--exclude=*.jpg"
  "--exclude=*.jpeg"
  "--exclude=*.gif"
  "--exclude=*.webp"
  "--exclude=*.ico"
  "--exclude=*.icns"
  "--exclude=*.mp4"
  "--exclude=*.mov"
  "--exclude=*.webm"
  "--exclude=*.map"
  "--exclude=pnpm-lock.yaml"
  "--exclude=package-lock.json"
  "--exclude=yarn.lock"
  "--exclude=.env*"
  "--exclude=*.pem"
  "--exclude=*.key"
)

missing=0
for path in "${required_ignored[@]}"; do
  if ! git check-ignore --no-index -q "$path"; then
    echo "mempalace guard failed: expected gitignore to exclude $path" >&2
    missing=1
  fi
done

if [[ "$missing" -ne 0 ]]; then
  exit 2
fi

if [[ -e "$CORPUS" && ! -f "$MARKER" ]]; then
  echo "Refusing to update unmarked corpus path: $CORPUS" >&2
  exit 2
fi

mkdir -p "$CORPUS"
printf 'owned-by=zterm-mempalace-mine\n' > "$MARKER"

copy_file() {
  local src="$1"
  if [[ -f "$ROOT/$src" ]]; then
    mkdir -p "$CORPUS/$(dirname "$src")"
    rsync -a "${rsync_excludes[@]}" "$ROOT/$src" "$CORPUS/$src"
  fi
}

copy_tree() {
  local src="$1"
  if [[ -d "$ROOT/$src" ]]; then
    mkdir -p "$CORPUS/$src"
    rsync -a --delete --delete-excluded "${rsync_excludes[@]}" "$ROOT/$src/" "$CORPUS/$src/"
  fi
}

copy_file "AGENTS.md"
copy_file ".ignore"
copy_file "README.md"
copy_file "CHANGELOG.md"
copy_file "MEMORY.md"
copy_file "note.md"
copy_file "mempalace.yaml"
copy_file "package.json"
copy_file "pnpm-workspace.yaml"
copy_file "turbo.json"
copy_file "vitest.workspace.ts"

copy_tree ".agents/skills"
copy_tree "android/docs"
copy_tree "android/src"
copy_tree "android/scripts"
copy_file "android/AGENTS.md"
copy_file "android/README.md"
copy_file "android/MEMORY.md"
copy_file "android/CACHE.md"
copy_file "android/note.md"
copy_file "android/task.md"
copy_file "android/package.json"
copy_file "android/capacitor.config.ts"
copy_file "android/tsconfig.json"
copy_file "android/vite.config.ts"
copy_file "android/vitest.config.ts"
copy_tree "android/native/android/app/src"
copy_file "android/native/android/app/build.gradle"
copy_file "android/native/android/app/capacitor.build.gradle"
copy_file "android/native/android/app/proguard-rules.pro"
copy_file "android/native/android/build.gradle"
copy_file "android/native/android/capacitor.settings.gradle"
copy_file "android/native/android/gradle.properties"
copy_file "android/native/android/settings.gradle"
copy_file "android/native/android/variables.gradle"
copy_file "android/native/android/capacitor-cordova-android-plugins/build.gradle"
copy_file "android/native/android/capacitor-cordova-android-plugins/cordova.variables.gradle"
copy_tree "packages/shared/src"
copy_tree "packages/shared/test"
copy_file "packages/shared/package.json"
copy_tree "mac/docs"
copy_tree "mac/src"
copy_tree "mac/electron"
copy_tree "mac/scripts"
copy_file "mac/README.md"
copy_file "mac/MEMORY.md"
copy_file "mac/CACHE.md"
copy_file "mac/note.md"
copy_file "mac/task.md"
copy_file "mac/package.json"
copy_file "mac/tsconfig.json"
copy_file "mac/tsconfig.node.json"
copy_file "mac/vite.config.ts"
copy_file "mac/vitest.config.ts"

forbidden_corpus_regex='/(node_modules|dist|build|target|coverage|\.next|\.cache|\.turbo|\.pnpm-store|\.yarn|release-dist|update-dist|evidence|artifacts|tmp|\.tmp|backups|archive|\.git|\.reasonix|\.beads)(/|$)|/(docs/wiki/generated|docs/tab-swipe-grid-preview|docs/tab-swipe-grid-session-preview|android/native/android/app/src/main/assets/public)(/|$)|/android/native/android/app/src/main/assets/capacitor\.(config|plugins)\.json$|\.(apk|tgz|zip|tar|gz|html|log|pem|key|png|jpg|jpeg|gif|webp|ico|icns|mp4|mov|webm|map)$|(^|/)\.DS_Store$|(^|/)pnpm-lock\.yaml$|(^|/)package-lock\.json$|(^|/)yarn\.lock$'
forbidden_hits="$(find "$CORPUS" -type f -print | LC_ALL=C grep -E "$forbidden_corpus_regex" || true)"
if [[ -n "$forbidden_hits" ]]; then
  printf '%s\n' "$forbidden_hits" >&2
  echo "mempalace guard failed: generated corpus contains excluded paths" >&2
  exit 2
fi

allowed_source_regex="^$CORPUS/(\\.zterm-mempalace-corpus|AGENTS\\.md|\\.ignore|README\\.md|CHANGELOG\\.md|mempalace\\.yaml|package\\.json|pnpm-workspace\\.yaml|turbo\\.json|vitest\\.workspace\\.ts|note\\.md|\\.agents/skills/[^/]+/SKILL\\.md|android/(AGENTS\\.md|README\\.md|MEMORY\\.md|CACHE\\.md|note\\.md|task\\.md|package\\.json|capacitor\\.config\\.ts|tsconfig\\.json|vite\\.config\\.ts|vitest\\.config\\.ts|docs/|src/|scripts/|native/android/(app/src/|app/(build\\.gradle|capacitor\\.build\\.gradle|proguard-rules\\.pro)|build\\.gradle|capacitor\\.settings\\.gradle|gradle\\.properties|settings\\.gradle|variables\\.gradle|capacitor-cordova-android-plugins/(build\\.gradle|cordova\\.variables\\.gradle)))|packages/shared/(package\\.json|src/|test/)|mac/(README\\.md|MEMORY\\.md|CACHE\\.md|note\\.md|task\\.md|package\\.json|tsconfig\\.json|tsconfig\\.node\\.json|vite\\.config\\.ts|vitest\\.config\\.ts|docs/|src/|electron/|scripts/))"
outside_hits="$(find "$CORPUS" -type f -print | LC_ALL=C grep -Ev "$allowed_source_regex" || true)"
if [[ -n "$outside_hits" ]]; then
  printf '%s\n' "$outside_hits" >&2
  echo "mempalace guard failed: corpus contains files outside code/docs/memory source allowlist" >&2
  exit 2
fi

exec mempalace mine --wing zterm --agent codex "$@" "$CORPUS"
