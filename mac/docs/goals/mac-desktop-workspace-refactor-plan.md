# Mac Desktop Workspace Refactor Plan

## 1. Goal

把 Mac 客户端重构成 terminal-first 的现代桌面终端复用器：

- 支持多 window / workspace / split pane / tab。
- 每个 live pane/tab 有独立 runtime，不共享 terminal buffer / transport 真相。
- 提供本地文件浏览与文本预览能力，并保留后续 remote session cwd 浏览扩展点。
- UI 与 terminal core / workspace core / platform adapter 分离，最大化复用 `packages/shared`。
- 所有关键主线有 function map、mainline call ID、黑盒测试、白盒测试和运行态证据。

本任务不是继续打补丁；先建立 owner/map/gate，再按切片迁移能力。

## 2. Acceptance Criteria

1. `App -> MacDesktopApp` 是唯一 production renderer entrypoint。
2. `MacAppShell` 不再创建全局 `TerminalRuntimeController`。
3. `MacRuntimeRegistry` 是唯一 `runtimeKey -> TerminalRuntimeController` owner。
4. `MacPaneWorkbench` / pane UI 只消费 runtime projection，不直接 `connectRemote/connectLocalTmux`。
5. `MacWorkspaceStore` 只保存 window/workspace/pane/tab identity，不保存 runtime state / buffer / transport。
6. `MacServerDirectory` 是 server/session projection owner；refresh 不创建、不关闭、不 prune workspace tabs。
7. `MacFileBrowser` 有 shared core + Mac Electron adapter；本地 browse/preview 不依赖 terminal renderer，不污染 terminal buffer。
8. 旧 `ShellWorkspace` 生产语义被物理删除，或只剩明确命名且有删除计划的 transitional adapter；完成态不得保留双生产入口。
9. `mac/docs/function-map.md` 和 `mac/docs/mainline-call-map.json` 存在，mainline call ID 能反查真实 symbol/path/test。
10. 相关白盒、黑盒、package/live smoke 全部按本计划通过；未跑真实 smoke 时不得宣称体验闭环。

## 3. Scope

### In Scope

- Mac renderer entrypoint / shell / workspace / pane / tab owner refactor。
- Mac runtime registry 与 active/idle/dispose lifecycle。
- Mac server directory rail 与 launcher owner 拆分。
- 本地文件浏览、文本预览、大文件确认、二进制预览禁用。
- Electron window manager、windowId、window-scoped workspace persistence。
- Function map、mainline call map、architecture truth gate、test design。
- 旧 `ShellWorkspace` 能力迁移和死语义删除。

### Out Of Scope

- daemon/server terminal protocol 大改。
- 桌面专属 terminal wire 协议。
- broadcast input。
- 未验证 owner 前的视觉大改。
- iTerm2 全量功能 parity。
- 回退到旧 `ShellWorkspace` 作为 fallback。

## 4. Truth Sources

执行前必须读：

- `mac/docs/spec.md`
- `mac/docs/architecture.md`
- `mac/docs/desktop-workspace-plan.md`
- `mac/docs/dev-workflow.md`
- `mac/MEMORY.md`
- `mac/task.md`
- `mac/docs/goals/mac-desktop-workspace-slice1-plan.md`
- `android/docs/architecture.md`
- `android/docs/decisions/0001-cross-platform-layout-profile.md`
- `.agents/skills/zterm-mac-dev/SKILL.md`

第一步先修正已滞后的 truth：

- `mac/docs/spec.md`
- `mac/docs/architecture.md`
- `mac/docs/desktop-workspace-plan.md`
- `mac/task.md`
- `mac/note.md`

## 5. Architecture

### 5.1 Target Ownership

```text
Electron Platform Shell
  owns BrowserWindow / menu / preload IPC / windowId

MacDesktopApp
  owns renderer root bootstrap

MacWindowManager
  owns window record + create/focus/restore

MacWorkspaceStore
  owns workspace/pane/tab identity and persistence

MacPaneTree
  owns split tree, resize, move tab, activate pane

MacServerDirectory
  owns server/session projection only

MacRuntimeRegistry
  owns runtimeKey -> TerminalRuntimeController lifecycle

MacTerminalPane
  consumes runtime projection and sends user input to assigned runtime only

MacFileBrowser
  owns file browser UI state; consumes FileBrowserCore + platform providers

Shared Terminal Renderer
  owns render projection display; no workspace mutation
```

### 5.2 Runtime Key Contract

```ts
type MacRuntimeKey =
  | `remote:${serverId}:${sessionName}`
  | `local-tmux:${sessionName}`;
```

Rules:

- Runtime key is client-side only.
- Daemon must not know windowId/paneId/tabId/runtimeKey.
- Workspace tab may reference `runtimeKey`; it must not store runtime state.
- Switching pane/tab sets old runtime `idle`, new runtime `active`.
- Closing last tab for a runtime disposes only that runtime.

### 5.3 File Browser Contract

Owners:

- `packages/shared/src/files/file-browser-core.ts`: path, sorting, text/binary preview policy, transfer/preview state machine.
- `mac/src/app/file-browser/*`: React shell and Mac UI projection.
- `mac/electron/file-system.ts` or equivalent: Electron local filesystem adapter.
- Future remote provider: daemon file-list/file-download protocol adapter.

Rules:

- UI does not read local files directly.
- Electron adapter does not own preview policy.
- File browser does not touch terminal buffer/renderer/runtime truth.
- If active session cwd is unavailable, show explicit unavailable state; do not silently use home/downloads as fallback.
- Preview text only through size/type policy. Binary preview disabled unless a dedicated preview adapter is implemented.

## 6. Required Function Map

Create/update `mac/docs/function-map.md`.

Minimum rows:

| feature_id | owner symbols | owns | forbidden | required gates |
| --- | --- | --- | --- | --- |
| `mac.entrypoint` | `MacDesktopApp`; `App` | renderer root | runtime creation | App/MacDesktopApp tests, type-check, build |
| `mac.window_lifecycle` | `MacWindowManager`; Electron `createWindow` | BrowserWindow/windowId | runtime/buffer truth | window tests, package smoke |
| `mac.workspace_store` | `MacWorkspaceStore`; `MacPaneTree` | window/workspace/pane/tab identity | transport/buffer/runtime state | pure model tests, architecture gate |
| `mac.runtime_registry` | `MacRuntimeRegistry` | runtimeKey -> controller lifecycle | pane layout, server projection | registry unit tests, runtime smoke |
| `mac.server_directory` | `MacServerDirectory` | server/session projection | open tab mutation on refresh | projection tests, refresh negative tests |
| `mac.terminal_pane` | `MacTerminalPane` | projection consumption/input to assigned runtime | connect orchestration | pane integration tests, live smoke |
| `mac.file_browser_core` | `FileBrowserCore` | path/sort/preview policy | Electron IPC, terminal runtime | core unit tests |
| `mac.file_browser_ui` | `MacFileBrowserPanel` | browser UI state | terminal buffer, daemon truth | component tests, packaged smoke |
| `mac.platform_fs` | Electron fs IPC adapter | local fs operations/dialogs | preview policy/UI state | IPC tests, packaged fs smoke |
| `mac.legacy_cleanup` | removal gate | deletes obsolete production semantics | fallback adapter | architecture scan |

Each row must include real symbol path, file path, caller/callee, semantic input/output, and test command. If implementation is not ready, mark `binding pending`; do not invent symbols.

## 7. Mainline Call Map IDs

Create/update `mac/docs/mainline-call-map.json`.

Required lifecycle: `mac_desktop_mainline`.

Required node IDs:

| ID | Node |
| --- | --- |
| `MAC-00-AppEntry` | `mac/src/App.tsx` |
| `MAC-01-DesktopBootstrap` | `MacDesktopApp` |
| `MAC-02-WindowRecord` | `MacWindowManager` / `windowId` |
| `MAC-03-WorkspaceLoad` | `MacWorkspaceStore.load(windowId)` |
| `MAC-04-WorkspaceShell` | workspace shell render |
| `MAC-05-ServerDirectory` | `MacServerDirectory` projection |
| `MAC-06-OpenTabIntent` | explicit open session/file intent |
| `MAC-07-PaneTreeUpdate` | split/move/resize/activate |
| `MAC-08-RuntimeEnsure` | `MacRuntimeRegistry.ensureRuntime(runtimeKey)` |
| `MAC-09-RuntimeActivity` | active/idle/dispose lifecycle |
| `MAC-10-TerminalProjection` | `MacTerminalPane` projection consumption |
| `MAC-11-Renderer` | shared terminal renderer |
| `MAC-12-FileBrowserOpen` | file browser open intent |
| `MAC-13-FileProviderRead` | local/remote provider request |
| `MAC-14-FilePreview` | preview policy + projection |
| `MAC-15-WindowRestore` | restore workspace by windowId |
| `MAC-16-LegacyRemoval` | dead production path removal gate |

Required edges:

- `MAC-00-AppEntry -> MAC-01-DesktopBootstrap`
- `MAC-01-DesktopBootstrap -> MAC-02-WindowRecord`
- `MAC-02-WindowRecord -> MAC-03-WorkspaceLoad`
- `MAC-03-WorkspaceLoad -> MAC-04-WorkspaceShell`
- `MAC-05-ServerDirectory -> MAC-06-OpenTabIntent`
- `MAC-06-OpenTabIntent -> MAC-03-WorkspaceLoad`
- `MAC-03-WorkspaceLoad -> MAC-07-PaneTreeUpdate`
- `MAC-03-WorkspaceLoad -> MAC-08-RuntimeEnsure`
- `MAC-08-RuntimeEnsure -> MAC-09-RuntimeActivity`
- `MAC-09-RuntimeActivity -> MAC-10-TerminalProjection`
- `MAC-10-TerminalProjection -> MAC-11-Renderer`
- `MAC-04-WorkspaceShell -> MAC-12-FileBrowserOpen`
- `MAC-12-FileBrowserOpen -> MAC-13-FileProviderRead`
- `MAC-13-FileProviderRead -> MAC-14-FilePreview`
- `MAC-02-WindowRecord -> MAC-15-WindowRestore`
- `MAC-16-LegacyRemoval` links to removed paths and replacement nodes.

Each edge must include:

- `edge_id`
- `from`
- `to`
- `owner_feature`
- `caller`
- `callee`
- `semantic_input`
- `semantic_output`
- `status`: `anchored` or `binding pending`
- `verification_gates`

## 8. Test Design

Create/update `mac/docs/testing/mac-desktop-workspace-test-design.md`.

### 8.1 White-Box Tests

#### Architecture Truth Gate

Add `mac/src/lib/mac-architecture-truth.test.ts` or equivalent.

Must fail if:

- `App.tsx` imports or renders `ShellWorkspace`.
- `MacAppShell` calls `createTerminalRuntime`.
- `MacPaneWorkbench` calls `connectRemote` / `connectLocalTmux`.
- Pane/workspace records contain runtime state, transport state, buffer state, or render projection.
- Any file outside `MacRuntimeRegistry` creates `TerminalRuntimeController`.
- `MacServerDirectory` mutates workspace tabs during refresh.
- File browser core imports React/Electron/terminal runtime.
- Electron fs adapter implements preview policy.
- Old `ShellWorkspace` production imports remain after cleanup slice.

#### Pure Model Unit Tests

- `MacWorkspaceStore`:
  - load/save by `windowId`
  - split right/down
  - resize ratios
  - move tab across panes
  - close tab/pane
  - restore active pane/tab
  - reject invalid persisted workspace explicitly

- `MacRuntimeRegistry`:
  - two runtime keys create two controllers
  - same runtime key reuses controller
  - pane switch sets active/idle
  - hidden tab not disposed
  - close last tab disposes only that runtime
  - same tab switch does not reconnect
  - stale runtime event cannot update another runtime projection

- `MacServerDirectory`:
  - saved servers group by shared identity
  - live sessions project under server
  - refresh updates projection only
  - unavailable session does not close open tab
  - duplicate endpoint alias resolves to one server identity

- `FileBrowserCore`:
  - normalize local paths
  - directory-first sort by name/time asc/desc
  - text extension detection
  - binary preview disabled
  - large text preview requires explicit confirm
  - provider error surfaces as error, not empty directory

#### Component White-Box Tests

- `MacTerminalPane` consumes runtime projection matching its `runtimeKey`.
- Input from pane A calls runtime A only.
- Pane B render is unchanged when runtime A emits.
- File browser open intent does not call terminal runtime connect/disconnect.
- Server rail refresh does not call workspace open/close actions.

### 8.2 Black-Box Tests

#### Renderer/App Black-Box

Use Testing Library or current Mac harness:

- App boots to one desktop workspace shell.
- Empty workspace shows terminal-first open affordance.
- Split creates independent visual pane containers.
- Opening two local tmux sessions creates two tabs/panes with distinct status surfaces.
- Switching tabs does not clear previous render projection.
- Server rail shows saved servers and live sessions.
- Opening session from server rail creates tab only on explicit click.
- File browser opens from command/toolbar and lists fixture directory.
- Text file preview displays content.
- Binary file preview action is disabled.
- Large text file requires confirm.

#### Runtime Black-Box

Use dedicated tmux sessions only, never user sessions:

- `zterm_mac_goal_a`
- `zterm_mac_goal_b`

Cases:

- local tmux A connect -> input echo in A.
- local tmux B connect -> input echo in B.
- input A does not appear in B.
- resize A does not reset B.
- switch A idle / B active keeps A buffer.
- close A disposes A runtime only.

Remote daemon cases if active daemon is available:

- remote session open through bridge two-stage handshake.
- file-list request returns real directory facts.
- file preview/download works against a fixture file.

If daemon/route unavailable, report missing live remote coverage; do not fake it with local-only proof.

#### Packaged Smoke

Required when Electron main/preload/window/fs changes:

1. `pnpm --filter @zterm/mac package`
2. Quit old app by app-level quit or explicit PID only.
3. Open new packaged app.
4. Capture screenshot.
5. Open local file browser fixture and preview text.
6. Open two dedicated local tmux sessions in separate panes.
7. Verify input/resize/switch behavior.
8. Capture `ps/top` resource snapshot.
9. Quit app and verify no orphan ZTerm/Electron helper process.

Evidence path:

```text
mac/evidence/<date>-mac-desktop-workspace-refactor/
```

## 9. Implementation Slices

### Slice 0: Docs And Gates

- Fix stale baseline in Mac docs.
- Create `mac/docs/function-map.md`.
- Create `mac/docs/mainline-call-map.json`.
- Create `mac/docs/testing/mac-desktop-workspace-test-design.md`.
- Add architecture truth gate skeleton.

Verification:

```bash
pnpm --dir mac test -- --reporter dot
pnpm --dir mac run type-check
pnpm --dir mac run build
```

### Slice 1: Workspace Store

- Add `MacWorkspaceStore`.
- Add `MacPaneTree` pure operations.
- Migrate current workbench pure model into owner path.
- Persist by `windowId/workspaceId`, not global `shell-workspace`.

White-box gates:

- workspace unit tests
- architecture truth gate

### Slice 2: Runtime Registry

- Add `MacRuntimeRegistry`.
- Move all `createTerminalRuntime` usage into registry.
- Remove global runtime from `MacAppShell`.
- Remove `connectRemote/connectLocalTmux` from pane UI.

White-box gates:

- runtime registry positive/negative tests
- stale event isolation test

Black-box gates:

- two local tmux sessions independent runtime smoke

### Slice 3: Terminal Pane Integration

- `MacTerminalPane` consumes runtime projection by `runtimeKey`.
- Input/resize/viewport events route only to assigned runtime.
- Shared terminal renderer remains the only visible projection owner.

Gates:

- component tests
- local tmux live smoke
- no renderer-owned business decisions scan

### Slice 4: Server Directory

- Add persistent left rail.
- Reuse shared server identity where possible; if Android owner is not shared yet, first extract shared identity helper.
- Move launcher to add/edit flow.
- Refresh live sessions as projection only.

Gates:

- projection tests
- refresh negative tests
- server color/label consistency tests

### Slice 5: File Browser

- Add shared `FileBrowserCore`.
- Add Mac local fs provider via Electron IPC.
- Add `MacFileBrowserPanel`.
- Add text preview / binary disabled / large text confirm.
- Add remote provider only if daemon cwd/list truth is available and tested.

Gates:

- file core unit tests
- IPC tests
- component black-box tests
- packaged fs smoke if preload/main changes

### Slice 6: Electron Window Manager

- Add `MacWindowManager`.
- Add New Window menu/shortcut.
- Pass `windowId` to renderer.
- Persist/restore workspace per window.

Gates:

- Electron unit tests
- package
- packaged multi-window smoke

### Slice 7: Legacy Cleanup

- Migrate remaining useful `ShellWorkspace` behavior.
- Delete obsolete production code/tests.
- Keep only tests that bind new mainline.

Gates:

- architecture scan proves no old production import.
- full Mac tests/type-check/build.
- package/live smoke if packaged behavior changed.

### Slice 8: Visual Closeout

Only after owners pass:

- thin top chrome
- compact pane tabs
- hover pane controls
- stable server rail colors
- file browser side panel polish
- command palette entry

Gates:

- screenshot evidence
- no text overlap at target desktop sizes
- terminal-first layout preserved

## 10. Risk And Mitigation

| Risk | Mitigation |
| --- | --- |
| Single runtime leaks back into pane UI | architecture truth gate forbids runtime creation/connect outside registry/actions |
| File browser becomes Electron-only logic | shared core owns policy; Electron only IO |
| Server refresh mutates tabs | negative tests lock refresh projection-only |
| Old ShellWorkspace remains fallback | no fallback; after replacement tests, delete old production semantics |
| Packaged behavior differs from dev | package smoke required for main/preload/window/fs changes |
| Live tests pollute user tmux sessions | only use dedicated `zterm_mac_goal_*` sessions |
| Daemon unavailable | mark remote smoke missing; no local-only closure claim |

## 11. Required Commands

Baseline after every slice:

```bash
pnpm --dir mac test -- --reporter dot
pnpm --dir mac run type-check
pnpm --dir mac run build
```

Runtime-affecting slices:

```bash
pnpm --dir mac exec vitest run src/lib/bridge-transport.test.ts src/lib/local-tmux-transport.test.ts src/lib/terminal-runtime.same-end-refresh.test.ts src/lib/terminal-runtime-lifecycle.test.ts --reporter dot
```

Packaged slices:

```bash
pnpm --filter @zterm/mac package
```

Live smoke commands/scripts must write evidence into:

```text
mac/evidence/<date>-mac-desktop-workspace-refactor/
```

## 12. Definition Of Done

- Docs current baseline matches source.
- Function map and mainline call map exist and bind real symbols.
- Architecture truth gate prevents duplicate runtime owners, stale entrypoints, and file browser policy leakage.
- New workspace/runtime/server/file owners are in place.
- Two live panes can run independent dedicated tmux sessions without cross-input/render pollution.
- Local file browser can browse a fixture directory and preview text in packaged app.
- Old production `ShellWorkspace` semantics removed.
- All required static, white-box, black-box, packaged, and live smoke gates pass.
- Final report includes exact commands, evidence paths, uncovered risks, and next action.
