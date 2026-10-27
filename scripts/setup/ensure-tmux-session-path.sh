#!/usr/bin/env bash
# Standardize this host on the zterm tmux session path.
#
# Standard layout:
#   TMUX_TMPDIR=$HOME/.tmux/run
#   socket       $HOME/.tmux/run/tmux-<uid>/default
#
# The script is idempotent. It adds the TMUX_TMPDIR export when no shell startup
# file sets it, and repoints an existing export to the standard root. It never
# starts, stops, kills, or migrates a tmux server: a live server keeps its
# current socket until that server exits.
#
# Usage:
#   scripts/setup/ensure-tmux-session-path.sh          # apply
#   scripts/setup/ensure-tmux-session-path.sh --check  # read-only report

set -euo pipefail

MODE="apply"
case "${1:-}" in
  "") ;;
  --check) MODE="check" ;;
  -h|--help)
    sed -n '2,18p' "$0"
    exit 0
    ;;
  *)
    printf 'usage: %s [--check]\n' "$0" >&2
    exit 64
    ;;
esac

STANDARD_ROOT="$HOME/.tmux/run"
STANDARD_ROOT_LITERAL='"$HOME/.tmux/run"'
UID_VALUE="$(id -u)"
STANDARD_SOCKET="$STANDARD_ROOT/tmux-$UID_VALUE/default"
STARTUP_FILES=(
  "$HOME/.zshenv"
  "$HOME/.zprofile"
  "$HOME/.zshrc"
  "$HOME/.bash_profile"
  "$HOME/.bash_login"
  "$HOME/.profile"
  "$HOME/.bashrc"
)

say() {
  printf '%s\n' "$*"
}

# Print the first non-comment TMUX_TMPDIR value declared in one file.
read_declared_value() {
  python3 - "$1" "$HOME" <<'PY'
import re
import sys

path, home = sys.argv[1], sys.argv[2]
pattern = re.compile(r'^\s*(?:export\s+)?TMUX_TMPDIR=')
try:
    with open(path, 'r', encoding='utf-8') as handle:
        for line in handle:
            if line.lstrip().startswith('#'):
                continue
            if pattern.match(line):
                value = line.split('=', 1)[1].strip()
                # Read the quoted value first; an inline comment after the
                # closing quote is not part of the declaration.
                if value.startswith(('"', "'")):
                    quote = value[0]
                    end = value.find(quote, 1)
                    if end != -1:
                        value = value[1:end]
                else:
                    value = re.split(r'\s+#', value, maxsplit=1)[0].strip()
                if value == '$HOME' or value.startswith('$HOME/'):
                    value = home + value[len('$HOME'):]
                print(value)
                break
except FileNotFoundError:
    pass
PY
}

# Repoint every TMUX_TMPDIR assignment in one file at the standard root.
repoint_file() {
  python3 - "$1" "$STANDARD_ROOT_LITERAL" <<'PY'
import re
import sys

path, literal = sys.argv[1], sys.argv[2]
pattern = re.compile(r'^\s*(?:export\s+)?TMUX_TMPDIR=')
try:
    with open(path, 'r', encoding='utf-8') as handle:
        lines = handle.readlines()
except FileNotFoundError:
    print('missing')
    raise SystemExit(0)

changed = False
rewritten = []
for line in lines:
    if not line.lstrip().startswith('#') and pattern.match(line):
        indent = line[: len(line) - len(line.lstrip())]
        replacement = f'{indent}export TMUX_TMPDIR={literal}\n'
        current = line
        # A declaration whose value already equals the standard root is
        # correct even with a trailing comment; keep such lines untouched.
        if pattern.match(line):
            raw = line.split('=', 1)[1].strip()
            if raw.startswith(('"', "'")):
                quote = raw[0]
                end = raw.find(quote, 1)
                if end != -1 and raw[1:end] == literal.strip('"'):
                    replacement = line
            elif raw == literal.strip('"'):
                replacement = line
        if replacement != current:
            changed = True
        rewritten.append(replacement)
    else:
        rewritten.append(line)

if not changed:
    print('unchanged')
    raise SystemExit(0)

with open(path, 'w', encoding='utf-8') as handle:
    handle.writelines(rewritten)
print('repointed')
PY
}

append_export() {
  local file="$1"
  {
    printf '\n# zterm: keep tmux server sockets in a stable user directory.\n'
    printf 'export TMUX_TMPDIR=%s\n' "$STANDARD_ROOT_LITERAL"
  } >> "$file"
  say "added  $file"
}

choose_startup_file() {
  if [[ "${SHELL:-}" == */zsh ]] || [[ -f "$HOME/.zshenv" ]]; then
    printf '%s\n' "$HOME/.zshenv"
    return
  fi
  if [[ -f "$HOME/.bash_profile" ]]; then
    printf '%s\n' "$HOME/.bash_profile"
    return
  fi
  printf '%s\n' "$HOME/.profile"
}

report_server() {
  if tmux -S "$STANDARD_SOCKET" list-sessions >/dev/null 2>&1; then
    local count
    count="$(tmux -S "$STANDARD_SOCKET" list-sessions 2>/dev/null | wc -l | tr -d ' ')"
    say "server  live at $STANDARD_SOCKET ($count session(s))"
    return
  fi
  say "server  no server running at $STANDARD_SOCKET yet"
  local other
  for other in "$HOME/.zterm/tmux/tmux-$UID_VALUE/default" "/tmp/tmux-$UID_VALUE/default"; do
    if [[ -S "$other" ]] && tmux -S "$other" list-sessions >/dev/null 2>&1; then
      say "note    another live server uses $other; it keeps its sessions until it exits"
    fi
  done
}

say "standard root   $STANDARD_ROOT"
say "standard socket $STANDARD_SOCKET"

if [[ "$MODE" == "check" ]]; then
  status=0
  if [[ -d "$STANDARD_ROOT" ]]; then
    say "dir     present"
  else
    say "dir     missing"
    status=1
  fi
  declared=0
  for file in "${STARTUP_FILES[@]}"; do
    [[ -f "$file" ]] || continue
    value="$(read_declared_value "$file")"
    [[ -n "$value" ]] || continue
    declared=1
    if [[ "$value" == "$STANDARD_ROOT" ]]; then
      say "config  $file -> $value"
    else
      say "config  $file -> $value (should be $STANDARD_ROOT)"
      status=1
    fi
  done
  if [[ "$declared" -eq 0 ]]; then
    say "config  no shell startup file exports TMUX_TMPDIR"
    status=1
  fi
  report_server
  exit "$status"
fi

mkdir -p "$STANDARD_ROOT"
chmod 700 "$STANDARD_ROOT"
say "dir     $STANDARD_ROOT ready"

declared=0
for file in "${STARTUP_FILES[@]}"; do
  [[ -f "$file" ]] || continue
  if [[ -n "$(read_declared_value "$file")" ]]; then
    declared=1
    result="$(repoint_file "$file")"
    say "config  $file $result"
  fi
done

if [[ "$declared" -eq 0 ]]; then
  target="$(choose_startup_file)"
  append_export "$target"
fi

report_server
say "next    open a new shell, then run 'tmux ls' to confirm the standard socket"
