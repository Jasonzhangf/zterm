# Mac Alpha P0 Closeout Plan

## 1. Goal

Close the Mac client P0 alpha loop so Jason can run a limited alpha against the packaged app with real terminal sessions.

This is not a broad UI polish task. The goal is to make the critical terminal lifecycle usable and evidence-backed:

- Open a remote daemon session from the server rail.
- Discover remote daemon sessions from QuickConnect and open the selected session only after an explicit user action.
- Restore open tabs on cold launch with active-only eager connect.
- Show terminal status and reconnect/disconnect controls.
- Prove follow/reading/gap repair with large output.
- Prove daemon disconnect/reconnect recovery.
- Produce an alpha handoff package with evidence and retention policy.

## 2. Acceptance Criteria

The Mac client can be called P0-alpha-ready only when all items below are true:

1. Server rail can open a real remote daemon session through the production packaged app.
2. QuickConnect can discover remote daemon sessions, preselect a useful saved match, and open the selected session only after explicit Save & connect.
3. Cold launch restores open tabs and active tab; hidden tabs do not eager-connect.
4. Terminal header shows session identity, runtime status, size, reconnect, and disconnect controls.
5. Large-output terminal smoke proves follow mode, reading mode, gap repair, and return-to-follow.
6. Terminal buffer black-box gate compares `tmux capture-pane` / `tmux pipe-pane` session truth with packaged app rendered DOM rows for both controlled sequence output and continuously refreshing bottom TUI output.
7. Daemon restart or transport close surfaces explicit error and recovers through reconnect.
8. `mac/docs/alpha-readiness.md`, `mac/task.md`, `mac/docs/function-map.md`, and `mac/docs/mainline-call-map.json` are updated to mark only verified work as anchored.
9. Packaged smoke evidence exists under `mac/evidence/<date>-mac-alpha-p0-closeout/`.
10. Evidence retention decision is recorded; untracked evidence is not deleted or moved without Jason approval.

## 2.1 Current Verified Progress

Verified and closed by 2026-07-05:

- `T-A1` QuickConnect/session discovery: packaged `quick-connect-discovery-final3` smoke.
- `T-A2` cold restore active-only eager connect and `T-A3` terminal header controls: packaged `header-restore-final2` smoke.
- Remote server rail open: packaged `server-rail-remote-open-final2` smoke proved Refresh is projection-only with zero runtime creation, then explicit rail session click opens a connected remote runtime and renders dedicated session output.
- Evidence retention: generated `mac/evidence/**` artifacts are ignored by git; evidence paths are referenced as local verification output only.

Remaining P0 closeout work:

- `T-A4` large-output follow/reading/gap/return-follow packaged proof.
- `T-A5` daemon/transport disconnect/reconnect packaged proof.
- Alpha package handoff.

## 3. Scope

### In Scope

- `mac.server_directory` explicit remote open path.
- `mac.quick_connect` explicit remote session discovery and open path.
- `mac.workspace_store` cold restore and open tab identity.
- `mac.runtime_registry` reconnect/disconnect lifecycle as consumed by UI.
- `mac.terminal_pane` header/status/control projection.
- Mac terminal follow/reading/gap repair verification.
- Packaged app smoke, resource sampling, and orphan-process check.
- Function map, mainline call map, alpha readiness, test design, task board, memory updates.

### Out Of Scope

- Full iTerm2 parity.
- Visual redesign beyond minimal status/header controls.
- Remote screenshot UI re-entry.
- Remote file transfer UI re-entry.
- Schedule modal re-entry.
- Settings page, profiles, arrangements, notarized public release.
- Any fallback path to old `ShellWorkspace`.

## 4. Required Truth Sources

Read before editing:

- `.agents/skills/zterm-mac-dev/SKILL.md`
- `mac/docs/alpha-readiness.md`
- `mac/docs/spec.md`
- `mac/docs/architecture.md`
- `mac/docs/desktop-workspace-plan.md`
- `mac/docs/function-map.md`
- `mac/docs/mainline-call-map.json`
- `mac/docs/testing/mac-desktop-workspace-test-design.md`
- `mac/task.md`
- `mac/MEMORY.md`
- `android/docs/architecture.md`
- `android/docs/decisions/0001-cross-platform-layout-profile.md`
- `android/docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md`

## 5. Design Principles

- Keep terminal truth layered: server session truth -> client buffer/runtime -> renderer -> UI shell.
- UI shell may show status and send explicit user intents; it must not merge buffer truth or reinterpret daemon payloads.
- Runtime reconnect/disconnect belongs to `MacRuntimeRegistry` / terminal runtime owners, not server directory projection.
- Server directory refresh remains projection-only. Opening a session requires explicit user action.
- Workspace records may store identity and `runtimeKey`, never transport, buffer, render projection, or live runtime state.
- No fallback or silent downgrade. Failures must be explicit in UI and tests.
- Use dedicated test sessions for input smoke. Do not write to existing user sessions.

## 6. Technical Plan

### 6.1 Remote Open From Server Rail

Owner:

- `mac.server_directory`
- `mac.workspace_store`
- `mac.runtime_registry`

Expected work:

- Verify `resolveMacServerDirectoryOpenIntent(...)` produces enough target identity for `openConnectionInWorkbench(...)`.
- Ensure rail click opens a remote tab in active pane only after explicit click.
- Ensure remote tab creates or reuses a `remote:<serverId>:<sessionName>` runtime key.
- Add positive and negative tests for no auto-open during refresh and explicit open on click.

Likely files:

- `mac/src/app/server-directory/MacServerDirectory.ts`
- `mac/src/app/server-directory/MacServerDirectoryRail.tsx`
- `mac/src/app/MacAppShell.tsx`
- `mac/src/app/workspace/workbench-model.ts`
- `mac/src/app/runtime/MacRuntimeRegistry.ts`
- `mac/src/app/server-directory/MacServerDirectory.test.ts`
- `mac/src/app/MacAppShell.layout.test.tsx`

### 6.2 QuickConnect Session Discovery

Owner:

- `mac.quick_connect`
- `mac.workspace_store`
- `mac.runtime_registry`

Expected work:

- `ConnectionLauncher` discovers remote sessions only after explicit user action.
- Discovery requires host/token and reports daemon errors explicitly.
- Discovery preselects the most recently saved matching session when available.
- Discovery itself must not create a terminal runtime.
- Save & connect opens the selected or typed session through `MacAppShell.handleSaveDraft(...)` and `openConnectionInWorkbench(...)`.

Likely files:

- `mac/src/components/ConnectionLauncher.tsx`
- `mac/src/components/ConnectionLauncher.test.tsx`
- `mac/src/app/MacAppShell.tsx`
- `mac/src/app/MacAppShell.layout.test.tsx`
- `mac/scripts/alpha-p0-packaged-smoke.mjs`

### 6.3 Cold Restore And Active-Only Eager Connect

Owner:

- `mac.workspace_store`
- `mac.runtime_registry`

Expected work:

- Restore persisted window workspace tabs on packaged cold launch.
- Eager-connect only the active tab.
- Keep hidden restored tabs as shell identity until activation.
- Add negative test proving hidden tabs do not connect on cold launch.

Likely files:

- `mac/src/app/workspace/workspace-store.ts`
- `mac/src/app/workspace/workbench-model.ts`
- `mac/src/app/MacAppShell.tsx`
- `mac/src/app/MacDesktopApp.tsx`
- `mac/src/app/workspace/workspace-store.test.ts`
- `mac/src/app/MacAppShell.layout.test.tsx`

### 6.4 Terminal Header Status And Controls

Owner:

- `mac.terminal_pane`
- `mac.runtime_registry`

Expected work:

- Add compact terminal header projection for session name, status, size, reconnect, and disconnect.
- Controls call runtime owner methods, not direct transport primitives from UI.
- Error state must be visible and not wrapped as connected.

Likely files:

- `mac/src/app/MacPaneWorkbench.tsx`
- optional `mac/src/app/terminal/*`
- `mac/src/app/runtime/MacRuntimeRegistry.ts`
- `mac/src/app/MacPaneWorkbench.test.tsx`
- `mac/src/app/runtime/MacRuntimeRegistry.test.ts`

### 6.5 Follow / Reading / Gap Repair

Owner:

- terminal runtime / renderer projection path.

Expected work:

- Prove current runtime/renderer can consume large output without stealing reading position.
- Prove scroll back enters reading mode, new output does not force follow, and scroll-to-bottom returns to follow.
- Prove missing range or gap repair requests propagate from renderer to runtime/transport.
- Fix only the unique owner if a gap is found.

Likely files:

- `mac/src/lib/terminal-runtime.ts`
- `packages/shared/src/terminal/mac-terminal-view.tsx`
- `mac/src/app/MacPaneWorkbench.tsx`
- runtime and renderer tests already present in `mac/src/lib/*` and `packages/shared/src/terminal/*`

### 6.6 Disconnect / Reconnect Recovery

Owner:

- `mac.runtime_registry`
- `mac/src/lib/terminal-runtime.ts`
- transport owner for local/remote path.

Expected work:

- Daemon/transport close projects explicit error.
- Reconnect control restarts the correct runtime target without recreating unrelated panes.
- Reconnect success returns terminal to connected state and preserves workspace identity.
- Add positive/negative tests for target-only reconnect.

Likely files:

- `mac/src/app/runtime/MacRuntimeRegistry.ts`
- `mac/src/lib/bridge-transport.ts`
- `mac/src/lib/local-tmux-transport.ts`
- `mac/src/lib/terminal-runtime.ts`
- relevant tests under `mac/src/app/runtime` and `mac/src/lib`

## 7. Function Map And Mainline Requirements

Before or with implementation:

- Update `mac/docs/function-map.md` if any owner symbol, allowed path, required gate, or current debt changes.
- Update `mac/docs/mainline-call-map.json` for each new or changed adjacent call edge.
- Use existing lifecycle node IDs where possible:
  - `MAC-05-ServerDirectory`
  - `MAC-06-OpenTabIntent`
  - `MAC-03-WorkspaceLoad`
  - `MAC-08-RuntimeEnsure`
  - `MAC-09-RuntimeActivity`
  - `MAC-10-TerminalProjection`
  - `MAC-11-Renderer`
- If a new branch is needed, add an adjacent node and edge with real caller/callee symbols. Do not invent pending symbols as anchored.
- Update `mac/src/lib/mac-architecture-truth.test.ts` only for facts that are actually implemented.

## 8. Test Plan

### White-Box

- Architecture truth gate covers alpha readiness and new anchored owner edges.
- Server directory tests:
  - refresh stays projection-only
  - explicit remote open creates open intent
  - refresh failure keeps saved/open sessions visible
- Workspace tests:
  - cold load restores tabs
  - invalid records fail explicitly
  - hidden restored tabs do not store live runtime state
- Runtime registry tests:
  - active-only eager connect
  - hidden tab no connect
  - reconnect only target runtime
  - disconnect/error visible
- Terminal tests:
  - input routes only to assigned runtime
  - follow/reading demand propagates
  - gap request is not dropped

### Module Black-Box

- App shell opens remote session only after rail click.
- Header status changes idle -> connecting -> connected -> error -> reconnecting -> connected.
- Closing/disconnecting one pane does not clear another pane.
- Cold restart restores visible shell before transport connects hidden tabs.

### Project / Packaged Smoke

Run in packaged app, not only dev server:

1. Package app.
2. Quit old app using app-level quit or explicit PID only.
3. Open new packaged app.
4. Refresh Mac Studio server rail read-only.
5. Open one existing remote daemon session from rail.
6. Open one local tmux session in another pane.
7. Verify input/output isolation with dedicated test session only.
8. Generate large output, test follow/reading/return-to-follow.
9. Run `pnpm --dir mac run blackbox:terminal-buffer -- --case=all` and keep `sequence-comparison.json`, `tui-refresh-comparison.json`, screenshots, tmux captures, pipe logs, and resource samples.
10. Restart or close daemon/transport and prove error then reconnect.
11. Quit app and verify no orphan ZTerm/Electron helper process.

Evidence path:

```text
mac/evidence/<date>-mac-alpha-p0-closeout/
```

## 9. Required Commands

Use `rtk` for shell commands.

Minimum:

```bash
rtk pnpm --dir mac exec vitest run src/lib/mac-architecture-truth.test.ts --reporter dot
rtk pnpm --dir mac test -- --reporter dot
rtk pnpm --dir mac run type-check
rtk pnpm --dir mac run build
rtk pnpm --dir mac run package
rtk git diff --check
```

Add targeted shared tests if `packages/shared` terminal/file/workspace code changes.

## 10. Risks And Guardrails

- Do not touch existing user tmux sessions with input. Use dedicated smoke sessions.
- Do not delete or move current `mac/evidence/2026-07-04-*` without Jason approval.
- Do not use `pkill`, `killall`, `kill $(...)`, or broad `xargs kill`.
- Do not claim packaged readiness from unit tests.
- Do not claim remote open readiness from read-only server refresh alone; remote open readiness requires packaged `server-rail-remote-open` proof.
- Do not leave direct connect calls in pane UI if the runtime registry should own them.
- Do not revive `ShellWorkspace`.

## 11. Completion Definition

The task is complete when:

- All P0 blockers in `mac/docs/alpha-readiness.md` are either closed with evidence or explicitly left open with reason.
- The alpha readiness doc says whether Mac is P0-alpha-ready and why.
- Function map and mainline call map match real code.
- White-box, module black-box, and packaged smoke evidence are recorded.
- The final report lists:
  - changed files
  - verification commands
  - packaged smoke evidence path
  - remaining risks
  - whether Jason can start alpha testing
