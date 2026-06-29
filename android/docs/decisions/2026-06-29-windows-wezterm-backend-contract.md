# Windows WezTerm backend contract

Status: initial adapter contract, not a production daemon backend.

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
- The initial adapter must not patch `server.ts`, `terminal-mirror-runtime.ts`, or tmux capture behavior.

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
- `pnpm --dir android exec tsx scripts/wezterm-backend-remote-smoke.ts`
- `pnpm --dir android exec tsx scripts/wezterm-backend-input-smoke.ts`
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
