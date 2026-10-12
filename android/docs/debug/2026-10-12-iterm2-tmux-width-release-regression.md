# Bug: iTerm2 buffer history disappears after zterm daemon releases adaptive width

Bug ID: `BUG-20261012-ITERM2-TMUX-WIDTH-RELEASE`

## Symptom

iTerm2 is attached to the same tmux session as the zterm Android client.
After the zterm client disconnects, iTerm2 cannot see history and is frozen at
the width the daemon applied for the phone.

## Root cause

`releaseAdaptiveTmuxWidth()` in `src/server/terminal-mirror-runtime.ts` ran the
baseline `resize-window` and only then ran `set-window-option -u window-size`.
When the baseline restore failed, the exception skipped the unset. Tmux stayed
in `window-size=manual`, so a real iTerm2 client kept the daemon's last frame
geometry and its history/reflow stayed broken.

## Owning path

- DAG graph: `android/docs/dagpipe/daemon-mirror-publish.graph.json`
  (`daemon.mirror_writer` / adaptive width lease owner)
- Owner: `releaseAdaptiveTmuxWidth()` in `src/server/terminal-mirror-runtime.ts`
- Gap class: fix a broken release edge so ownership is always handed back to
  the real tmux client

## Fix

The tmux `set-window-option -u window-size` now runs even when the baseline
restore throws. The baseline error is re-raised after the unset so the existing
cleanup retry/journal state still applies.

## Regression gates

- Unit: `src/server/terminal-mirror-runtime.test.ts`
  "unsets window-size even when the baseline restore fails so a real client can
  reflow" (red without the fix)
- Black-box tmux PTY: `src/server/tmux-window-size-semantics.test.ts`
  - "releases real tmux width ownership through the adaptive width owner"
    drives the real `createTerminalMirrorRuntime` adaptive-width owner against a
    scratch tmux session: `adaptive-phone` attach narrows the shared window to
    56 cols and leaves it `manual`, release restores the baseline and unsets
    `window-size`, and a fresh node-pty client reflows to its own size.
  - "unsets real tmux window-size even when the daemon baseline restore fails"
    forces the baseline `resize-window` to throw and proves the `set-window-option
    -u window-size` still reaches tmux, so a real client reflows instead of
    staying frozen.
- Focused result: 2 files / 68 tests passed on
  `fix/iterm2-tmux-buffer-release-1012`

## Evidence

- Red proof: with the runtime fix stashed, the unit regression fails because
  `set-window-option -u window-size` is not called.
- Green proof: same unit plus the real tmux owner-path tests pass after
  restoring the fix.
- Live state before/after release: `zterm-1`, `zterm-2`, and `routecodex-1..4`
  report `window-size=latest`/unset with no window-local `window-size` or
  `alternate-screen` override; the daemon holds no adaptive width lease.
