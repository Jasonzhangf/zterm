# Mac Alpha Readiness

## Status

Current verdict: not alpha-ready yet.

The Mac client has crossed the architecture-refactor baseline: the production path now has explicit owners for entrypoint, workspace identity, runtime registry, server directory, Electron window lifecycle, local file browser, local filesystem bridge, and legacy workspace removal. It is suitable for focused internal engineering smoke, but not yet suitable for Jason alpha testing as a daily terminal client.

## Verified Baseline

Evidence-backed completed areas:

- Entrypoint: `App -> MacDesktopApp -> MacAppShell`; old `ShellWorkspace` production source removed.
- Workspace: `MacWorkspaceStore` owns window/workspace/pane/tab identity and persists by renderer `windowId`.
- Tab restore: packaged `smoke:alpha-p0 -- --case=header-restore` proved cold reopen restores the same `windowId`, active tab, and hidden tab; active runtime is eager-connected while hidden runtime is prepare-only.
- Runtime: `MacRuntimeRegistry` owns `runtimeKey -> TerminalRuntimeController`; pane UI routes input/viewport/resize by runtime key.
- Terminal header: packaged `smoke:alpha-p0 -- --case=header-restore` proved header status/session/size/reconnect/disconnect controls for a local tmux terminal. The same smoke proved disconnect changes `connected -> idle` and reconnect returns to `connected` on the active runtime without touching the hidden runtime.
- Local tmux: packaged A/B smoke proved two dedicated sessions connected, input isolation, resize, switch, close, and B input after A close.
- Terminal buffer black-box: packaged `blackbox:terminal-buffer -- --case=all` passed for controlled sequence and continuously refreshing TUI screen, comparing `tmux capture-pane` / `pipe-pane` truth with packaged DOM rendered rows.
- Window lifecycle: `MacWindowManager` owns BrowserWindow create/focus/restore, New Window IPC/menu, stable `windowId`, and restore after app quit/reopen.
- Server rail: `MacServerDirectory` owns saved/live session projection; read-only refresh against Mac Studio daemon updates rail without opening/pruning workspace tabs.
- Local file browser: shared `FileBrowserCore`, Electron filesystem adapter, and `MacFileBrowserPanel` browse/preview local fixtures in packaged app.
- Legacy cleanup: old all-in-one workspace source files are deleted and architecture-gated.

Recorded evidence:

- `mac/evidence/2026-07-04-runtime-live-isolation-smoke/`
- `mac/evidence/2026-07-04-mac-alpha-p0-closeout/buffer-gate-all-fixed-lifecycle-1/`
- `mac/evidence/2026-07-04-window-manager-smoke/`
- `mac/evidence/2026-07-04-server-refresh-smoke/`
- `mac/evidence/2026-07-04-file-browser-smoke/`
- `mac/evidence/2026-07-04-legacy-cleanup-smoke/`
- `mac/evidence/2026-07-05-mac-alpha-p0-closeout/header-restore-final2/`

Committed refactor baseline:

- `2c5cbac feat(mac): share workspace layout runtime`
- `3edbc74 refactor(mac): rebuild desktop workspace owners`

## Alpha Blockers

P0 blockers before Jason alpha:

- `T-A1` QuickConnect/session discovery flow: connect should discover sessions, preselect a useful session, and open terminal with one explicit action.
- `T-A4` Buffer follow/reading verification: large output, scrollback reading mode, gap repair, return-to-follow, and session-truth-vs-render-output comparison need packaged live proof.
  - Current black-box gate status: `sequence` and `tui` passed in packaged app under `mac/evidence/2026-07-04-mac-alpha-p0-closeout/buffer-gate-all-fixed-lifecycle-1/`. Remaining T-A4 work is large-output reading mode, gap repair, and return-to-follow packaged proof.
- `T-A5` Disconnect/reconnect: daemon restart and network/session close must surface explicit error and recover through reconnect.
- Remote terminal path: server rail refresh is read-only verified, but opening a remote daemon session from rail through the full bridge path still needs packaged live smoke.
- Alpha package handoff: no signed/notarized distributable, install/update path, release notes, or clean user-data migration plan is verified.

Closed P0 items:

- `T-A2` Tab restore: packaged `header-restore-final2` smoke restored hidden + active tabs after app close/reopen under the same `windowId`, with hidden `ensureRuntime(connect:false)` and zero hidden `runtimeConnectCalls`.
- `T-A3` Terminal header: packaged `header-restore-final2` smoke showed `connected`, `Local tmux · zterm_mac_alpha_active`, `80x24`, reconnect and disconnect controls; disconnect/reconnect changed active runtime state and did not connect the hidden runtime.
- Evidence retention: generated `mac/evidence/**` artifacts are ignored by git; only `mac/evidence/README.md` is committed. Evidence paths may be referenced in docs, but artifacts are local verification output and must not be staged.

P1 blockers for a useful alpha:

- Settings surface for theme/font/cache/width mode.
- Remote screenshot UI re-entry.
- File transfer UI re-entry for remote upload/download.
- Schedule modal re-entry.
- Connection properties editing flow in the new owner model.

## Distance Estimate

Alpha distance: medium.

Engineering estimate from current state:

- Minimal internal alpha: about 3-5 focused slices if scope is local tmux + basic remote open + restart recovery.
- Practical Jason alpha: about 5-8 focused slices because terminal restore, reconnect, header controls, remote open, settings basics, and package handoff all need packaged smoke evidence.

Do not call the Mac client alpha-ready until all P0 blockers above are closed with:

```bash
pnpm --dir mac test -- --reporter dot
pnpm --dir mac run type-check
pnpm --dir mac run build
pnpm --dir mac run package
```

Plus packaged smoke evidence for:

- cold launch and open tab restore
- local tmux terminal input/output
- terminal buffer black-box gate: `tmux capture-pane` / `pipe-pane` truth compared with packaged app rendered DOM rows, including a continuously refreshing bottom TUI case
- remote daemon session open
- split pane runtime isolation
- large-output follow/reading
- daemon disconnect/reconnect
- file browser local preview
- app quit with no orphan process

## Next Slice Order

1. P0 QuickConnect/session discovery.
2. P0 remote daemon open from server rail.
3. P0 follow/reading/gap repair packaged smoke.
4. P0 daemon/transport disconnect/reconnect recovery.
5. P0 alpha package handoff.
