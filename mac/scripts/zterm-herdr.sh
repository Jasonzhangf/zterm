#!/usr/bin/env bash
set -euo pipefail

# zterm Herdr session helper.
# Herdr itself owns session lifecycle; this wrapper only normalizes the
# zterm-visible namespace and forwards to the official Herdr CLI.

HERDR_BIN="${HERDR_BIN:-$(command -v herdr || true)}"
ZTERM_HERDR_PREFIX="${ZTERM_HERDR_PREFIX:-}"

usage() {
  cat <<'EOF'
Usage:
  zterm-herdr new -s NAME       Create-or-attach a zterm Herdr session
  zterm-herdr a -t NAME         Attach to a zterm Herdr session
  zterm-herdr attach -t NAME    Same as `a`
  zterm-herdr ls                List zterm Herdr sessions
  zterm-herdr stop -t NAME      Stop a Herdr session
  zterm-herdr kill -t NAME      Same as `stop`
  zterm-herdr delete -t NAME    Delete a stopped Herdr session

If ZTERM_HERDR_PREFIX is set, names are normalized to that prefix.
By default names are passed to official Herdr verbatim, so manually-created
sessions such as hd-codex-89 remain discoverable by zterm.
The official Herdr CLI owns the create/attach behavior: `new` creates the
session when absent and attaches when it already exists.
EOF
}

fail() {
  echo "zterm-herdr: $*" >&2
  exit 2
}

require_herdr() {
  [[ -n "$HERDR_BIN" && -x "$HERDR_BIN" ]] || fail "official herdr CLI not found; set HERDR_BIN=/path/to/herdr"
}

require_jq() {
  command -v jq >/dev/null 2>&1 || fail "jq is required for zterm Herdr session enumeration"
}

normalize_name() {
  local name="$1"
  [[ -n "$name" ]] || fail "session name is required"
  [[ -n "$ZTERM_HERDR_PREFIX" ]] || {
    printf '%s\n' "$name"
    return 0
  }
  if [[ "$name" == "$ZTERM_HERDR_PREFIX"* ]]; then
    printf '%s\n' "$name"
  else
    printf '%s%s\n' "$ZTERM_HERDR_PREFIX" "$name"
  fi
}

parse_target() {
  local target_flag="$1"
  shift
  [[ "${1:-}" == "$target_flag" ]] || fail "expected $target_flag NAME"
  [[ -n "${2:-}" ]] || fail "session name is required"
  [[ -z "${3:-}" ]] || fail "unexpected argument: $3"
  normalize_name "$2"
}

main() {
  local action="${1:-help}"
  if [[ "$action" == "-h" || "$action" == "--help" ]]; then
    action="help"
  else
    shift || true
  fi

  if [[ "$action" == "help" ]]; then
    usage
    return 0
  fi

  require_herdr

  case "$action" in
    new)
      local name
      name="$(parse_target -s "$@")"
      exec "$HERDR_BIN" --session "$name"
      ;;
    a|attach)
      local name
      name="$(parse_target -t "$@")"
      exec "$HERDR_BIN" --session "$name"
      ;;
    ls|list)
      [[ "$#" -eq 0 ]] || fail "ls does not accept arguments"
      require_jq
      if [[ -n "$ZTERM_HERDR_PREFIX" ]]; then
        "$HERDR_BIN" session list --json | jq --arg prefix "$ZTERM_HERDR_PREFIX" '
          .sessions | map(select(.name | startswith($prefix)))
        '
      else
        exec "$HERDR_BIN" session list --json
      fi
      ;;
    stop|kill)
      local name
      name="$(parse_target -t "$@")"
      exec "$HERDR_BIN" session stop "$name"
      ;;
    delete)
      local name
      name="$(parse_target -t "$@")"
      exec "$HERDR_BIN" session delete "$name"
      ;;
    *)
      usage >&2
      fail "unknown command: $action"
      ;;
  esac
}

main "$@"
