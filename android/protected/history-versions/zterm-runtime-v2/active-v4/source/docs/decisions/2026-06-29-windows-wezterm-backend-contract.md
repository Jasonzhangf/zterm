# Windows WezTerm backend contract

Status: daemon backend closeout candidate with live Windows daemon protocol proof. It is complete for daemon backend alpha only when local, mock protocol, typecheck, direct Windows WezTerm remote/input, and live Windows daemon protocol gates pass in the current worktree. Windows desktop shell packaging remains separate.

## Decision

Windows support will start in ZTerm, not by forking WezTerm.

WezTerm is treated as an external terminal/mux source. ZTerm owns the daemon-facing mirror truth:

```text
WezTerm mux pane
  -> wezterm cli get-text --escapes
  -> ZTerm WezTermBackend adapter
  -> ZTerm absolute mirror snapshot
  -> existing buffer-head / buffer-sync protocol
```

This path does not change the existing tmux backend. The tmux path remains:

```text
tmux truth -> daemon mirror -> buffer-sync
```

The Windows WezTerm path is:

```text
WezTerm exported pane text -> ZTerm adapter-owned absolute mirror -> buffer-sync
```

## Frozen Contracts

- WezTerm CLI output is input material, not daemon truth.
- ZTerm must own `revision`, `bufferStartIndex`, `bufferLines`, `cols`, `rows`, cursor metadata, and the `buffer-head / buffer-sync` projection.
- `wezterm cli list` may only enter through `parseWezTermPaneList()`.
- `wezterm cli get-text --escapes` may only enter through `buildWezTermMirrorSnapshot()`.
- `get-text` relative line indexes must not leak into client protocol; ZTerm must convert them to daemon-owned absolute line indexes.
- `cli send-text` is only accepted through `send-text --no-paste` with raw bytes written to stdin. Passing user input through shell arguments remains forbidden.
- `requireWezTermInputContract()` documents the verified input subset and must stay explicit about limitations.
- Production code may only route terminal input through WezTerm using `buildWezTermSendTextArgs(paneId)` and stdin payload bytes.
- Ctrl+C is verified as raw ETX delivery to raw-mode/TUI programs, but not as a Windows console control event for child processes such as `cmd.exe /k ping -t ...`.
- The WezTerm backend must not patch tmux capture behavior. Server/runtime integration may select the backend, but mirror truth still comes from the WezTerm adapter-owned snapshot contract.
- `kill-pane` success must be verified by a fresh pane list. If the pane is still listed, cleanup is an explicit failure and local session state must not be silently deleted.

## Verified Initial Probe

Remote host:

```text
Jason-HW-Desktop / 100.75.122.121 / huawei
```

Portable WezTerm:

```text
D:\zterm-tools\wezterm\portable\WezTerm-windows-20240203-110809-5046fc22\wezterm.exe
```

Observed capabilities:

- `wezterm.exe --version` works over SSH.
- `wezterm cli --prefer-mux list` starts `wezterm-mux-server.exe --daemonize`.
- `cli spawn` creates panes.
- `cli list` enumerates window/tab/pane/workspace.
- `cli get-text` exports pane text.
- `cli get-text --escapes` preserves ANSI styles.
- scrollback ranges can be exported.
- `cli send-text --no-paste` with stdin payload executes Enter in `cmd.exe`.
- Backspace/DEL edits `cmd.exe` command line input.
- Up Arrow escape sequence replays `cmd.exe` command history.
- Raw-mode Node TUI receives Esc, DEL, Up Arrow, and ETX bytes.
- Codex TUI text entry receives typed text without shell argument quoting.

Observed limitation:

- ETX / Ctrl+C reaches raw-mode programs, but did not interrupt `cmd.exe` child process `ping -t 127.0.0.1` as a Windows console control event.

## Required Gates

- `pnpm --dir android exec vitest run src/server/wezterm-backend.test.ts --reporter dot`
- `pnpm --dir android exec vitest run src/server/wezterm-backend-runtime.test.ts --reporter dot`
- `pnpm --dir android exec vitest run src/server/terminal-backend-selection.test.ts src/server/terminal-control-runtime.input-queue.test.ts --reporter dot`
- `pnpm --dir android exec tsx scripts/wezterm-daemon-protocol-smoke.ts`
- `pnpm --dir android exec tsx scripts/wezterm-daemon-remote-protocol-smoke.ts`
- `pnpm --dir android exec tsx scripts/wezterm-backend-remote-smoke.ts`
- `pnpm --dir android exec tsx scripts/wezterm-backend-input-smoke.ts`
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`

## Live daemon protocol proof

The strongest daemon gate is `scripts/wezterm-daemon-remote-protocol-smoke.ts` against the Windows daemon endpoint. It creates one uniquely named session through the daemon control WebSocket, connects through the ticketed session WebSocket, decodes real `buffer-sync` wire lines, sends one source marker as terminal input, proves the target `buffer-sync` contains the marker, then removes only that created session through the daemon control path.

The gate intentionally fails if cleanup returns an explicit error. That caught stale deployed daemon runtime where `tmux-kill-session` still attempted tmux cleanup in WezTerm mode. The selected backend close path is now `TerminalControlRuntime#closeDetachedTerminalSession`, which delegates to `WezTermBackendRuntime#closeSession` when the daemon backend is WezTerm and to `tmux kill-session` only in tmux mode.
