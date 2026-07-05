# Mac Alpha Readiness

## Status

Current verdict: not alpha-ready yet.

The Mac client has crossed the architecture-refactor baseline: the production path now has explicit owners for entrypoint, workspace identity, runtime registry, server directory, Electron window lifecycle, local file browser, local filesystem bridge, and legacy workspace removal. It is suitable for focused internal engineering smoke, but not yet suitable for Jason alpha testing as a daily terminal client.

## Verified Baseline

Evidence-backed completed areas:

- Entrypoint: `App -> MacDesktopApp -> MacAppShell`; old `ShellWorkspace` production source removed.
- Workspace: `MacWorkspaceStore` owns window/workspace/pane/tab identity and persists by renderer `windowId`.
- QuickConnect: packaged `smoke:alpha-p0 -- --case=quick-connect-discovery` proved explicit remote session discovery through the real daemon `list-sessions` path, latest saved matching session preselection, no runtime creation during discovery, and remote runtime creation only after Save & connect.
- Tab restore: packaged `smoke:alpha-p0 -- --case=header-restore` proved cold reopen restores the same `windowId`, active tab, and hidden tab; active runtime is eager-connected while hidden runtime is prepare-only.
- Runtime: `MacRuntimeRegistry` owns `runtimeKey -> TerminalRuntimeController`; pane UI routes input/viewport/resize by runtime key.
- Terminal header: packaged `smoke:alpha-p0 -- --case=header-restore` proved header status/session/size/reconnect/disconnect controls for a local tmux terminal. The same smoke proved disconnect changes `connected -> idle` and reconnect returns to `connected` on the active runtime without touching the hidden runtime.
- Disconnect/reconnect: packaged `smoke:alpha-p0 -- --case=disconnect-reconnect` proved a transport-owner close surfaces explicit `error`, the header Reconnect control returns the active runtime to `connected`, the hidden runtime is not connected, and the same `windowId` is preserved.
- Local tmux: packaged A/B smoke proved two dedicated sessions connected, input isolation, resize, switch, close, and B input after A close.
- Terminal buffer black-box: packaged `blackbox:terminal-buffer -- --case=all` passed for controlled sequence, continuously refreshing TUI screen, and large-output reading/return-to-follow, comparing `tmux capture-pane` / `pipe-pane` truth with packaged DOM rendered rows.
- Window lifecycle: `MacWindowManager` owns BrowserWindow create/focus/restore, New Window IPC/menu, stable `windowId`, and restore after app quit/reopen.
- Server rail: `MacServerDirectory` owns saved/live session projection; read-only refresh against Mac Studio daemon updates rail without opening/pruning workspace tabs.
- Server rail remote open: packaged `smoke:alpha-p0 -- --case=server-rail-remote-open` proved refresh projects live sessions with zero runtime creation, then explicit rail session click creates a connected remote runtime and renders the dedicated tmux session output.
- Local file browser: shared `FileBrowserCore`, Electron filesystem adapter, and `MacFileBrowserPanel` browse/preview local fixtures in packaged app.
- Legacy cleanup: old all-in-one workspace source files are deleted and architecture-gated.

Recorded evidence:

- `mac/evidence/2026-07-04-runtime-live-isolation-smoke/`
- `mac/evidence/2026-07-04-mac-alpha-p0-closeout/buffer-gate-all-fixed-lifecycle-1/`
- `mac/evidence/2026-07-05-mac-alpha-p0-closeout/buffer-gate-all-t-a4-final/`
- `mac/evidence/2026-07-04-window-manager-smoke/`
- `mac/evidence/2026-07-04-server-refresh-smoke/`
- `mac/evidence/2026-07-04-file-browser-smoke/`
- `mac/evidence/2026-07-04-legacy-cleanup-smoke/`
- `mac/evidence/2026-07-05-mac-alpha-p0-closeout/header-restore-final2/`
- `mac/evidence/2026-07-05-mac-alpha-p0-closeout/quick-connect-discovery-final3/`
- `mac/evidence/2026-07-05-mac-alpha-p0-closeout/server-rail-remote-open-final2/`
- `mac/evidence/2026-07-05-mac-alpha-p0-closeout/disconnect-reconnect-final2/`

Committed refactor baseline:

- `2c5cbac feat(mac): share workspace layout runtime`
- `3edbc74 refactor(mac): rebuild desktop workspace owners`

## Alpha Blockers

P0 blockers before Jason alpha:

- Alpha package handoff: no signed/notarized distributable, install/update path, release notes, or clean user-data migration plan is verified.

Closed P0 items:

- `T-A1` QuickConnect/session discovery: packaged `quick-connect-discovery-final3` smoke used the real Mac Studio daemon route, discovered `zterm_mac_alpha_quick`, preselected the latest saved matching session, proved discovery did not create runtime, and created a connected remote runtime only after Save & connect. The dedicated tmux session was marker-cleaned, 9364/ZTerm processes were gone after close, and storage/evidence token fields were redacted.
- Remote server rail open: packaged `server-rail-remote-open-final2` smoke used the real daemon route, refreshed live sessions with `runtimeEnsureCalls=0`, then explicitly clicked `zterm_mac_alpha_remote_open` from the rail. The remote runtime connected once, the packaged DOM rendered `ZTERM_ALPHA_REMOTE_OPEN_READY`, token fields were redacted, 9365/ZTerm processes were gone after close, and the dedicated tmux session was marker-cleaned.
- `T-A2` Tab restore: packaged `header-restore-final2` smoke restored hidden + active tabs after app close/reopen under the same `windowId`, with hidden `ensureRuntime(connect:false)` and zero hidden `runtimeConnectCalls`.
- `T-A3` Terminal header: packaged `header-restore-final2` smoke showed `connected`, `Local tmux · zterm_mac_alpha_active`, `80x24`, reconnect and disconnect controls; disconnect/reconnect changed active runtime state and did not connect the hidden runtime.
- Evidence retention: generated `mac/evidence/**` artifacts are ignored by git; only `mac/evidence/README.md` is committed. Evidence paths may be referenced in docs, but artifacts are local verification output and must not be staged.
- `T-A4` Buffer follow/reading: packaged `buffer-gate-all-t-a4-final` smoke passed `sequence`, `tui`, and `large-reading`. `large-reading` proved scrollback reading mode, no scroll steal while new output arrives, return-to-follow, app/tmux append tail equality, and runtime viewport reading diagnostics.
- `T-A5` Disconnect/reconnect: packaged `disconnect-reconnect-final2` smoke used a smoke-only local transport owner close to project explicit `error`, then clicked the official Reconnect control and recovered to `connected`. It proved active runtime reconnect count `2`, hidden runtime reconnect count `0`, stable `windowId`, no 9367/ZTerm process after close, and marker-cleaned dedicated tmux sessions. White-box tests cover bridge/local unexpected close -> error and manual disconnect -> idle.

P1 blockers for a useful alpha:

- Settings surface for theme/font/cache/width mode.
- Remote screenshot UI re-entry.
- File transfer UI re-entry for remote upload/download.
- Schedule modal re-entry.
- Connection properties editing flow in the new owner model.

## Distance Estimate

Alpha distance: low-to-medium.

Engineering estimate from current state:

- Minimal internal alpha: 1 focused slice if scope accepts the current unsigned local package.
- Practical Jason alpha: about 1-4 focused slices because package handoff still needs explicit install/release notes/user-data boundary, while settings basics remain P1.

Do not call the Mac client alpha-ready until all P0 blockers above are closed with:

```bash
pnpm --dir mac test -- --reporter dot
pnpm --dir mac run type-check
pnpm --dir mac run build
pnpm --dir mac run package
```

Plus packaged smoke evidence for:

- cold launch and open tab restore
- QuickConnect remote session discovery/open
- local tmux terminal input/output
- terminal buffer black-box gate: `tmux capture-pane` / `pipe-pane` truth compared with packaged app rendered DOM rows, including a continuously refreshing bottom TUI case
- remote daemon session open
- split pane runtime isolation
- daemon/transport disconnect/reconnect
- file browser local preview
- app quit with no orphan process

## Next Slice Order

1. P0 alpha package handoff.
