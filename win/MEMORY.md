# zterm Windows Memory

## 2026-07-11 Windows starts from daemon backend truth

- Windows client work must not start by copying terminal runtime, daemon mirror, buffer protocol, or renderer logic into `win/`.
- The first closeout target is `daemon.windows_wezterm_backend`: WezTerm is an external terminal/mux source, and ZTerm owns mirror snapshots and client-facing protocol.
- Windows desktop shell is a later owner under `win/` for window/menu/package/platform integration only.

## 2026-07-14 Daemon backend alpha proof before shell work

- Windows daemon backend now has live daemon protocol proof against `ws://100.75.122.121:3333`: daemon-created WezTerm session, ticketed session WebSocket, decoded `buffer-sync` target marker comparison, input echo, and targeted cleanup all passed.
- Next Windows client work starts at `windows.desktop_shell` architecture/test design. The shell may own Electron window/menu/package/platform integration, but must reuse shared renderer/protocol and must not copy daemon, mirror, buffer, or terminal runtime logic into `win/`.

## 2026-07-14 Windows desktop shell packaged alpha proof

- `windows.desktop_shell` now has an Electron main process, CommonJS sandbox preload, React shell, and a thin Windows session composition over shared `openBridgeConnection`, sparse-buffer application, and `MacTerminalView`; no daemon, mirror, renderer, Mac IPC, or local-tmux implementation was copied into `win/`.
- Packaged Electron preload must compile from `preload.cts` to `preload.cjs`. An ESM preload compiled as `preload.js` fails in the packaged sandbox with `Cannot use import statement outside a module` even though typecheck/build pass.
- Visible-range requests must wait until the first daemon `buffer-sync` revision. Sending `buffer-sync-request` immediately after `connected` races mirror readiness and produces `buffer-sync-request requires a ready mirror`, forcing the shell into error.
- Real Windows packaged L5 passed against daemon `127.0.0.1:3333`: platform bridge present, session connected without error, source input `echo ZTERMWINDOWSLIVE`, rendered DOM matched both command and output rows, and the dedicated gate session/app PIDs/CDP tunnel were precisely cleaned.
- Deployed alpha archive SHA-256 is `b60b5c5b4f27c73dc2e6b1f2dfc007a644d3c4eadaab4e2ad6dbb32d37655cf0`; package path is `D:/zterm-tools/windows-client-alpha/0.1.0-alpha.1/ZTerm.exe`.

## 2026-07-14 Windows session control alpha proof

- Session discovery/create/close UI is owned by `windows.desktop_shell.session_control` and implemented as a thin caller of shared daemon control helpers. Windows UI must not fork the daemon protocol or mutate daemon truth directly.
- Packaged L5 passed: UI refreshed sessions `default` and `zterm-20260630-115307`, created `ztermwinsessioncontrol`, selected it, connected without error, sent `echo ZTERMSESSIONCONTROL`, matched command and output DOM rows, closed the session from UI, and daemon final list omitted it.
- Deployed archive SHA-256 is `df59c1f382179cfe9c7a2834105e6271b865a4f712b7854f52482a1db669397a`. Smoke app PIDs `6628,7544,7884,30628` and CDP port 9333 were precisely cleared.

## 2026-07-14 Windows multi-session workspace packaged proof

- `windows.desktop_shell.workspace` composes shared `PaneStage`, `PaneTabs`, and workspace-model operations. Windows owns only tab target identity and a per-tab runtime registry; it does not copy Mac workspace, `window.ztermMac`, daemon, mirror, sparse-buffer, or renderer semantics.
- The runtime registry creates one `WindowsTerminalSession` per tab id. Pane/tab focus changes only projection; closing a tab disposes only that tab runtime, while explicitly closing a daemon session removes matching workspace tabs after daemon close succeeds.
- Local gates passed: typecheck, 4 files / 11 tests, renderer/main build, and x64 directory package.
- Packaged Windows L5 passed with sessions `ztermwinwsa24906188` and `ztermwinwsb24906188`: both panes independently matched their own source markers and excluded the sibling marker. Daemon health stayed exactly `2 attached / 2 ready` across focus switch, proving no reconnect/recreation on projection change.
- Closing pane A reduced daemon client sessions to `1 attached / 1 ready`; pane B then rendered new marker `ZTERMWINWSB2_24906188`, proving sibling transport/render continuation. Cleanup returned daemon sessions/subscribers to zero, app process count to zero, and CDP listener count to zero.
- Deployed package path is `D:/zterm-tools/windows-client-alpha/0.1.0-alpha.workspace2/ZTerm.exe`; archive SHA-256 is `b11741b53d3c4a0a6c983d93ac0d9f90971c071dcf3277548380a4f8a2b082d1`.

## 2026-07-14 Windows local file browser packaged proof

- `windows.desktop_shell.file_browser` owns only the Windows Electron filesystem adapter and browser UI projection. It reuses shared `FileBrowserCore` for path normalization, sort policy, text/binary preview decisions, and large-text confirmation; it does not import Mac filesystem IPC or touch daemon/runtime state.
- Local gates passed: Windows typecheck, 6 files / 15 tests, renderer/main build, and x64 directory package.
- Packaged Windows L5 passed against fixture `D:/zterm-tools/windows-file-browser-fixture`: `window.ztermWindows.fileSystem` was present, directory listing returned `src`, `image.png`, and `README.md`, Markdown preview DOM contained `WINDOWS_REMOTE_FILE_PREVIEW_SOURCE`, and `image.png` projected `Binary preview is not implemented`.
- Daemon session counts stayed `0 total / 0 attached / 0 ready` before and after file browsing, proving file browsing did not mutate terminal runtime/transport state. App process count and CDP listener count returned to zero after smoke cleanup.
- Deployed package path is `D:/zterm-tools/windows-client-alpha/0.1.0-alpha.files/ZTerm.exe`; archive SHA-256 is `fd42c6beb51847813088343e7b5b69862de9742bae6e385cf7ec1a1ceda14492`.
