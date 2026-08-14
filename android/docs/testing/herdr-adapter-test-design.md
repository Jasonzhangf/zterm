# Herdr adapter test design

## Scope

`daemon.herdr_backend` owns only the official Herdr single terminal-session
observe/control attachment and the zterm-side stateful VT canonicalizer.
Herdr pane split, tab, workspace, focus, and layout state stay outside this
feature and outside daemon truth.

## Required evidence

- The new-session picker renders exactly the explicit `tmux` and `Herdr` choices; selecting Herdr sends `terminalBackend: 'herdr'` only as a creation-time adapter intent, then opens the created session by name through the daemon-owned unified catalog.
- Normal session-list, persisted-tab restore, mux-channel-open, rename, and kill requests are backend-opaque. The daemon unions tmux and configured running Herdr names and resolves the adapter by exact name; zero matches and same-name ambiguity fail explicitly.
- File-transfer operations are outside the Herdr single terminal-surface contract. They must return the explicit `herdr_file_transfer_unsupported` error and must never call a tmux write/path owner for a Herdr session.

- Full frame initializes the stateful VT baseline.
- `full=false` delta requires the same attachment geometry and exact next
  attachment-local sequence.
- Duplicate, reorder, missing, malformed, and geometry-invalid deltas reject
  without advancing zterm revision or canonical rows.
- zterm revision increments only after an accepted frame and does not reuse
  Herdr sequence, including after resize or reconnect attachment reset.
- ANSI/VT cursor movement, erase, scroll, SGR, Unicode width, wrap, alternate
  screen, OSC, and kitty graphics fixtures run through the same canonicalizer
  owner used by the formal adapter.
- The source-reported viewport cursor is retained as local metadata; absolute
  mirror rows/range are projected from the canonicalizer-owned VT scrollback
  plus visible grid. Host-scroll metrics never define absolute identities.
  Absolute cursor while the host viewport is scrolled away from the
  canonicalizer bottom is an explicit capability gap. No synthetic host-offset
  index is allowed.
- Input, resize, release, reconnect, and multi-client control tests stay on
  typed control resources and never enter terminal business payload metadata.
- Process transport may attach typed host-scroll metrics from the single
  mapped pane as viewport metadata; missing or invalid metrics preserve the
  frame and never become workspace/layout state.
- Selecting `ZTERM_TERMINAL_BACKEND=herdr` must use the official process
  transport and must never enter tmux or WezTerm through an implicit fallback.
- Named-session discovery after daemon restart must use the official Herdr
  session list and pane list; an in-memory map is insufficient.
- Official Herdr named-session rename is an explicit capability gap and must
  fail rather than mutate only zterm memory.
- The canonicalizer may retain full VT-owned scrollback, but the single
  Herdr-to-mirror projection edge must apply the daemon `terminalCacheLines`
  window and advance `bufferStartIndex` from the canonical absolute range;
  range repair must not use the untrimmed attachment body as a hidden second
  cache.

## Current gate state

The playground and formal daemon probe have real Herdr 0.8.0 full/delta, VT,
input, resize, release, reconnect, same-geometry multi-client observer, and
daemon `buffer-sync` evidence. A separate daemon restart probe has also
rediscovered a running named Herdr session and replayed its mirror. The formal
canonicalizer owns attachment-local absolute rows via its VT
scrollback API; pane metrics are not used to derive absolute ranges.
The same-sample parity probe
`playground/herdr-adapter-experiment-20260812/tmux-herdr-canonical-parity-probe.ts`
replays one identical ANSI sample through tmux `capture-pane -e` and the
official Herdr frame stream, then compares canonical rows, wide-cell shape,
geometry, and cursor position. The sample includes SGR, CJK/emoji width,
erase-to-end-of-line, scroll, alternate-screen enter/leave, OSC title, and a
kitty-graphics control sequence. The probe passed with `rowsEqual`,
`sampleCellShapeEqual`, `geometryEqual`, and `cursorEqual` all true. The tmux
capture is explicitly normalized from row-snapshot LF to CRLF and its terminal
terminator row is removed before VT replay; it is not treated as raw PTY bytes.
The probe compares revision namespaces and does not map tmux or Herdr transport
sequence to zterm revision.
The dedicated Herdr source/contract side-channel gate passes: terminal frame
business bytes contain no Codex/OpenCode/Reasonix routing/provider/retry/debug
fields. This is a static owner-boundary audit, not evidence that external
agent integrations have been exercised; that separate operational audit and
the Windows ConPTY/cleanup gate remain pending. This feature must remain
`status: pending` until those gates pass.
