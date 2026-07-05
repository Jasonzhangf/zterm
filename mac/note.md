
## 2026-07-02 Mac client core connection gate
- Jason 纠正：daemon/tmux 闭环不能替代本地客户端连接证明；zterm 已有 Mac 客户端，至少要跑 Mac client 核心连接测试套件。
- 现状缺口：Mac 之前没有直接覆盖 `bridge-transport` / `local-tmux-transport` owner 的测试文件；`terminal-runtime.same-end-refresh` 只证明 runtime 消费 local tmux 消息后的 buffer sync 策略，不证明 transport 连接层。
- 已补 owner 测试：
  - `mac/src/lib/bridge-transport.test.ts`：锁远端 daemon WebSocket 两阶段握手 `session-open -> session-ticket -> connect -> connected`，以及 `buffer-head-request` / `buffer-sync-request` / `input` 发到 live socket；反向锁 reconnect 后 stale socket message 不得污染当前 state。
  - `mac/src/lib/local-tmux-transport.test.ts`：锁 Mac Electron local tmux API `connect`、`connected` event materialize、head/body request 转发、input/resize/activity/disconnect 使用同一 clientId。
- 验证：
  - `pnpm --dir mac exec vitest run src/lib/bridge-transport.test.ts src/lib/local-tmux-transport.test.ts src/lib/terminal-runtime.same-end-refresh.test.ts src/lib/terminal-runtime-lifecycle.test.ts src/app/MacPaneWorkbench.test.tsx --reporter dot` PASS（5 files / 19 tests）。
  - `pnpm --dir mac run type-check` PASS。
  - `pnpm --dir mac test -- --reporter dot` PASS（14 files / 59 tests）。

## 2026-06-02 mac terminal display investigation
- Goal: fix Mac terminal bottom visibility, input echo, ANSI colors; require screenshot evidence.
- Current lead: MacTerminalView DOM renderer maps rows/cells; inspect row view model and layout before patch.

## 2026-06-02 mac terminal display/color investigation

- 发现：`mac/src/pages/TerminalSlot.tsx` 使用 `slot-stack terminal-slot-shell` / `terminal-surface-shell` / `terminal-surface live`，但 `mac/src/styles.css` 无对应 CSS；只有旧 `.mac-terminal-*` 样式存在，导致 terminal surface 高度/底部布局不受控。
- 发现：`MacTerminalView` 默认 `allowDomFocus=false`，`TerminalSlot` 未传入，真实可见 DOM 输入面无法稳定获得键盘焦点；输入/回显链路因此可能看似断开。
- 证据：wire probe 到 daemon `buffer-sync` 里彩色行包含 compact `s` spans，例如 RED/GREEN/BLUEBG 分别带 fg/bg style；颜色丢失不在 daemon wire，优先查 DOM/CSS/focus/render surface。

## 2026-06-02 Mac terminal display/color/input follow-up
- 单实例规则落地：本轮收敛到唯一 dev Electron `--remote-debugging-port=9340` + 单一 tmux session `zterm_mac_color`，避免多窗口/CDP 串线。
- 已修颜色根因：`mac/electron/local-tmux.ts` 原先 `tmux capture-pane -p` + `lineToCells()` 把 fg/bg 全写成 256；改为 `capture-pane -e` 并解析 SGR，DOM probe 得到 RED `rgb(244,71,71)`、GREEN `rgb(106,153,85)`、BLUEBG 背景 `rgb(86,156,214)`。
- 底部显示：唯一 dev Electron probe 显示 `lastInViewport=true`、`clientHeight=739 scrollHeight=739 scrollTop=0`，bottom-line-ready 可见，截图在 `mac/evidence/2026-06-02-mac-electron-terminal-fullscreen.png`。
- 输入回显仍未完全闭环：synthetic `KeyboardEvent` 可到达 `MacTerminalView.handleKeyDown` 并解析输入；但 CDP `Input.dispatchKeyEvent` 在本 dev 实例未触发 React onKeyDown，`hasEcho=false`。需要手动键盘或更合适的 app-level automation 验证后才能宣称完成输入回显。
- [2026-06-02] 单实例收口后：唯一 dev Electron (PID 36349, port 9340)，唯一 tmux `zterm_mac_color`，颜色 + 底部已真实截图；输入回显需 Jason 手测或在 packaged app 里跑。
- [2026-06-02 22:50] 严重反模式：曾为绕过 React keydown 自动化失败，在 main.ts 给"所有 local tmux session" 写 input。这种写法对环境有破坏性，已撤并禁止。
- 后续调试时只能在 main 端**只**针对当前 active session（用 manager.clients 唯一 client）做注入；不能对所有 session 写。

## 2026-07-01 Mac iTerm2 gap review
- 当前真实入口仍是 `mac/src/App.tsx -> ShellWorkspace`，但 `mac/docs/spec.md` / `mac/docs/architecture.md` 已把旧 `ShellWorkspace` 明确列为废止方向；主入口与架构文档不一致。
- `ShellWorkspace` 已有 split tree、per-resource runtime registry、local tmux/remote runtime，能比旧 `MacAppShell` 更接近多 live pane；但新版 `MacAppShell/MacPaneWorkbench` 仍是旁路，且其设计是单 runtime 传入所有 panes，不适合 iTerm2 式独立 pane。
- Electron main 只创建一个业务 `BrowserWindow`，activate 仅在无窗口时恢复；没有 New Window / 多窗口 workspace owner / window-scoped persistence。
- 多服务器管理仍停在 QuickConnect modal：remembered servers 是小卡片，remote sessions 需要手动加载；没有类似 Android 抽屉的 server directory / live session catalog / server 色彩身份 / 多 daemon 分组。
- 视觉 gap：全局仍使用 Inter/system 字体、圆角卡片、状态栏和每 pane 常驻 split/open 控件，终端主空间被 chrome 占用；缺 iTerm2/现代桌面终端的紧凑 tab strip、可隐藏 toolbar、profile/status/badge 体系。

## 2026-07-01 Mac desktop workspace Slice 1 entrypoint
- 已按 `docs/goals/mac-desktop-workspace-slice1-plan.md` 做 Slice 1：`mac/src/App.tsx` 只渲染 `MacDesktopApp`，不再直接依赖 `ShellWorkspace`。
- 旧 `ShellWorkspace` 暂时只通过 `MacWorkspaceTransitionalShell` 被生产入口消费，命名明确为 transitional；本轮不改 runtime、不接多窗口、不接 server rail。
- `MacAppShell/MacPaneWorkbench` 未接入 production entrypoint，避免把单 runtime 多 pane 争用路径作为新主线。
- targeted 验证：`pnpm --filter @zterm/mac test -- MacDesktopApp App.test` PASS（2 files / 2 tests）。

## 2026-07-01 Mac packaged smoke bottom display follow-up
- Packaged app CDP target: `file:///Volumes/extension/code/zterm/mac/out/mac-arm64/ZTerm.app/Contents/Resources/app.asar/dist/index.html` on port `9341`.
- 现场视觉混乱的直接证据：`localStorage["zterm:mac:shell-workspace:v1"]` 恢复了 5 pane split tree，其中包含空 pane 与 `rcc-routecodex2` error pane；这会把主 terminal 区域压小。
- 修正 DOM selector 后的行级证据：terminal row selector 是 `[data-terminal-row="true"]`；有内容的 pane `viewportAtBottomDelta=0`，最后一行距离 viewport 底部约 `0.2-0.4px`，暂未证明 buffer follow 未到底。
- 截图证据：`mac/evidence/2026-07-01-mac-entrypoint-smoke/zterm-front-current.png`；CDP `Page.captureScreenshot` 在 packaged app 中 timeout，系统截图可用。

## 2026-07-01 Mac bottom residual fix
- 根因确认：Mac renderer 用 `Math.floor(viewportHeight / rowHeight)` 计算整行 viewportRows；当 viewport 高度不是 17px 整数倍且 buffer 短于 viewport 时，grid 只对齐到整行槽，真实底部会留下 `height % rowHeight` 的空白（现场 zterm pane residual `15.40625px`）。
- 修复：`MacTerminalView` 记录真实 viewport clientHeight，对 short-buffer follow frame 把 residual 加到 grid top padding；不改变 buffer truth、scrollback 或 tmux capture 语义。
- Packaged smoke 新证据：`mac/evidence/2026-07-01-mac-bottom-render-smoke/visible-bottom-metrics.json` 中 zterm pane bottom visible row delta `0.40625px`；其它有内容 pane visual bottom delta `0.203125px`。`pane-bottom-metrics.json` 里长 buffer last DOM row 可在 viewport 下方是 overscan，不再用 last DOM row 判定底部。

## 2026-07-01 Mac content truth correction
- Jason 纠正：底部几何对齐不是 terminal 正确性证据；本问题必须比较 `tmux capture-pane` 原始尾部、Mac local tmux/runtime buffer、DOM 可见尾部。
- 已发现 packaged app DOM visible tail 与 `tmux capture-pane -p -t zterm -S -20 -E -1` 不一致：tmux 已有最新内容，但 DOM 仍停在旧内容，说明 Mac local tmux client 刷新链路 stale，不是单纯窗口底部 padding 问题。
- 当前首要假设：`terminal-runtime` 的 `lastBufferSyncKey` 只按 request payload 去重，未把 `buffer-head.revision` 变化纳入；当 `latestEndIndex` 不变但同一可见窗口内容更新时，会吞掉应有的 `buffer-sync-request`。
- 已修：`buffer-head` revision 变化时清掉去重键，并把 `targetHeadRevision` 写入 `buffer-sync-request`，保证 same-end 新 revision 会重新拉正文。
- 新增回归：`terminal-runtime.same-end-refresh.test.ts` 锁住两个方向，`revision` 变必须重拉，`revision` 不变不能重复刷。
- 二次根因：Mac local tmux 的 `buffer-head` 曾用 visible-only capture，把尾窗编号成 `0..rows`；`buffer-sync` 用 full-history capture，编号是 `0..N`，导致 sync request 按 full-history 开头切片，active pane 显示旧内容。修复为 head/sync 都使用同一 full-history capture index 真源。
- 三次根因：内容到 DOM 后，follow scroll 用整行 viewportRows 公式，真实 viewport 高度非 17px 整数倍时会落后真实 DOM max scroll，导致最后两三行在视口下方。修复为 follow 模式在 DOM 提供有效 scrollHeight 时贴真实 DOM bottom。

## 2026-07-01 shared session group layout truth
- Jason 指出 Mac 不能继续复制 Android UI 逻辑；session group / boundary viewport projection 已上移到 @zterm/shared，Android 只保留 re-export 薄壳。后续 Mac/Android 必须消费 shared core，不允许在 ShellWorkspace 或 TerminalPage 内补第二套边界投影语义。

## 2026-07-04 Mac architecture review
- 证据：`pnpm --dir mac test -- --reporter dot` PASS（14 files / 59 tests），`pnpm --dir mac run type-check` PASS，`pnpm --dir mac run build` PASS；未跑 packaged/live smoke，不能宣称真实窗口/终端体验闭环。
- 入口真相：源码是 `App -> MacDesktopApp -> MacAppShell`，不是文档里的 `App -> ShellWorkspace`；`mac/docs/spec.md` / `mac/docs/architecture.md` / `mac/docs/desktop-workspace-plan.md` 的 current baseline 已滞后。
- 架构风险：`MacAppShell` 仍只创建一个 `TerminalRuntimeController` 并传给所有 panes；`MacPaneWorkbench` 每个 pane 又会用同一个 runtime 发 connect，本质还是 single runtime multi-pane，不满足 `MacRuntimeRegistry runtimeKey -> controller` 目标。
- 能力分叉：旧 `ShellWorkspace` 才有 per-resource runtime registry、nested split、schedule/screenshot/file-transfer；新 production entry 没迁完这些 owner。继续补 UI 前，应先收口 `MacWorkspaceStore` / `MacRuntimeRegistry` / `MacServerDirectory`，再迁移文件浏览/预览。

## 2026-07-04 Mac desktop workspace Slice 0
- 已修正 `mac/docs/spec.md` / `mac/docs/architecture.md` / `mac/docs/desktop-workspace-plan.md` 的 current baseline：当前生产入口是 `App -> MacDesktopApp -> MacAppShell`，不是 `App -> ShellWorkspace`。
- 已新增 `mac/docs/function-map.md`、`mac/docs/mainline-call-map.json`、`mac/docs/testing/mac-desktop-workspace-test-design.md`，未实现 owner 均显式标 `binding pending`。
- 已新增 `mac/src/lib/mac-architecture-truth.test.ts`：锁 App 不回旧入口、docs 不含 stale entrypoint、function map feature IDs、mainline map parseability/node/edge/queryability、goal plan 存在。
- 验证：`pnpm --dir mac exec vitest run src/lib/mac-architecture-truth.test.ts --reporter dot` PASS（1 file / 6 tests）；`pnpm --dir mac test -- --reporter dot` PASS（15 files / 65 tests）；`pnpm --dir mac run type-check` PASS；`pnpm --dir mac run build` PASS。
- 未跑 packaged/live smoke；本轮无 Electron main/preload/fs/window/runtime 行为改动，不能宣称 packaged app 或 live terminal 体验闭环。

## 2026-07-04 Mac desktop workspace Slice 1 workspace store
- 已新增 `mac/src/app/workspace/workspace-store.ts`：`MacWorkspaceStore` / `MacPaneTree` 纯 owner，负责 window/workspace/pane/tab identity、split、resize、move、activate、close、windowId scoped storage；记录只允许 `runtimeKey` identity，不允许 runtime/buffer/transport/render state。
- 已新增 `mac/src/app/workspace/workbench-model.ts`，并把 `mac/src/app/workbench.ts` 降为薄 re-export，生产 UI 兼容旧 import，但纯语义已下沉到 workspace owner 路径。
- 已新增 `mac/src/app/workspace/workspace-store.test.ts`：覆盖 load/save by windowId、split right/down、resize、move tab、activate pane/tab、close tab/pane、invalid persisted record 显式失败、runtime-owned state 反向拒绝。
- 已同步 `mac/docs/function-map.md`、`mac/docs/mainline-call-map.json`、`mac/docs/testing/mac-desktop-workspace-test-design.md`、`mac/docs/desktop-workspace-plan.md`、`mac/task.md`，并把 architecture truth gate 升级到锁 `MacWorkspaceStore` anchored binding。
- 验证：`pnpm --dir mac exec vitest run src/lib/mac-architecture-truth.test.ts src/app/workspace/workspace-store.test.ts src/app/workbench.test.ts --reporter dot` PASS（3 files / 31 tests）；`pnpm --dir mac test -- --reporter dot` PASS（16 files / 76 tests）；`pnpm --dir mac run type-check` PASS；`pnpm --dir mac run build` PASS。
- 未跑 packaged/live smoke；本轮无 Electron main/preload/window/fs/runtime 行为改动。剩余：`MacDesktopApp` 尚未按 real `windowId` bootstrap `MacWorkspaceStore`，`MacAppShell` 仍是单 runtime，下一步进入 `MacRuntimeRegistry` 或先做 workspace store renderer integration。

## 2026-07-04 Mac desktop workspace Slice 3 runtime registry
- 已新增 `mac/src/app/runtime/MacRuntimeRegistry.ts`：`MacRuntimeRegistry` 是当前生产路径唯一 runtime owner，负责 `runtimeKey -> TerminalRuntimeController`、connect signature 去重、active/idle、release/dispose、runtime projection subscription、input/viewport/resize 按 key 路由。
- 已改 `MacAppShell`：不再 `createTerminalRuntime` / `useTerminalRuntimeState`，改为创建 `createMacRuntimeRegistry()`；根据 workbench live tabs ensure runtime，根据 active tab 设置 active runtime key，关闭 tab 后 release 不再存在的 runtime key。
- 已改 `MacPaneWorkbench`：pane UI 不再调用 `connectRemote` / `connectLocalTmux`；`MacTerminalPane` 只用 `useMacRuntimeState(registry, runtimeKey)` 消费投影，并把 input/viewport/resize 交给 registry。
- 已改 `workbench-model`：connection/local tmux tab 带 client-side `runtimeKey` identity；不保存 controller/buffer/render state。
- 已新增/同步测试：`MacRuntimeRegistry.test.ts` 覆盖 distinct/reuse/connect once/local tmux/active idle/same active no reconnect/hidden no dispose/release only target/stale event isolation/input viewport resize routing；Pane/Shell 测试改为验证 registry owner 边界。
- 已同步 `function-map`、`mainline-call-map`、test design、desktop plan、task，并升级 architecture truth gate：`MacAppShell` 禁 `createTerminalRuntime`，`MacPaneWorkbench` 禁 `.connectRemote` / `.connectLocalTmux`。
- 已通过 targeted：`pnpm --dir mac exec vitest run src/app/runtime/MacRuntimeRegistry.test.ts src/app/MacPaneWorkbench.test.tsx src/app/MacPaneWorkbench.split.test.tsx src/app/MacPaneWorkbench.pane-ratios.test.tsx src/app/MacAppShell.layout.test.tsx src/app/workbench.test.ts --reporter dot` PASS（6 files / 47 tests）。
- 后续验证：targeted architecture/runtime/workspace gate PASS（6 files / 56 tests）；Mac core connection gate PASS（4 files / 12 tests）；Mac full tests PASS（17 files / 89 tests）；`pnpm --dir mac run type-check` PASS；`pnpm --dir mac run build` PASS；`git diff --check` PASS。
- Live smoke：创建专用 `zterm_mac_goal_a` / `zterm_mac_goal_b`，单 dev Electron + CDP 9342 打开；UI 成功 split 出两个 pane，分别显示 `Local tmux · zterm_mac_goal_a` / `Local tmux · zterm_mac_goal_b` 且两个 runtime pill 均为 `connected`。证据：`mac/evidence/2026-07-04-runtime-registry-smoke/two-pane-connected.png` 和 `two-pane-connected-dom.json`。
- Live smoke 缺口：dev Electron 下 DOM synthetic KeyboardEvent 与 CDP `page.keyboard` 均未让 React terminal input 写入 tmux（tmux capture 仍为空），符合 2026-06-02 记录的 dev automation 限制。OS-level `System Events` 前台应用查询卡住，已 Ctrl-C 停止，未发送按键。不能声明 input/echo A-B isolation 已 live 闭环；只能声明 two-pane connect/render surface 已 live 观察。

## 2026-07-04 Mac desktop workspace Slice 4 server directory
- 已新增 `mac/src/app/server-directory/MacServerDirectory.ts`：`MacServerDirectory` 是 projection-only owner，负责 saved server/session projection、optional live session snapshot projection、open session 标记、explicit open intent builder；不导入 workspace mutator、runtime registry 或 terminal runtime。
- 已新增 `MacServerDirectoryRail` 并接入 `MacAppShell` 左 rail：rail refresh/projection 不创建 tab，只有 explicit session click 才经 `resolveMacServerDirectoryOpenIntent` -> `openConnectionInWorkbench` 打开 workspace tab。
- 已同步 `function-map`、`mainline-call-map`、test design、spec/architecture/desktop plan/task；`MAC-05-ServerDirectory`、`MAC-06-OpenTabIntent`、`MAC-EDGE-0006`、`MAC-EDGE-0007` 均 anchored。
- 已新增/同步测试：`MacServerDirectory.test.ts` 覆盖 server identity grouping、optional live snapshots、projection-only refresh、open unavailable saved session 不被关闭、duplicate endpoint dedupe、explicit open intent 不变异 projection、unknown server 显式错误；`MacAppShell.layout.test.tsx` 覆盖 rail 渲染和 explicit click open。
- 验证：targeted `src/lib/mac-architecture-truth.test.ts src/app/server-directory/MacServerDirectory.test.ts src/app/MacAppShell.layout.test.tsx` PASS（3 files / 25 tests）；Mac full tests PASS（18 files / 99 tests）；`pnpm --dir mac run type-check` PASS；`pnpm --dir mac run build` PASS；`git diff --check` PASS。
- 未跑 packaged smoke；本轮未改 Electron main/preload/window/local fs。剩余：remote daemon live refresh wiring 未接生产路径，file browser/multi-window/legacy cleanup 仍 pending。

## 2026-07-04 Mac desktop workspace Slice 5 window manager
- 已新增 `mac/electron/window-manager.ts`：`MacWindowManager` 是 BrowserWindow/windowId owner，负责 create/focus/restore、New Window menu 模板、renderer URL/file query 注入 `windowId`、open window record store、quit 前保留 open records、重启 `restoreWindows()`。
- 已改 `mac/electron/main.ts`：正常 app 创建 `MacWindowManager`，`app ready` 走 `restoreWindows()`，`activate` 走 `restoreOrCreateWindow()`，`before-quit` 走 `prepareForQuit()`；新增 `zterm:window:create` IPC，preload 暴露 `window.ztermMac.windowManager.createWindow()`。
- 已改 renderer bootstrap：`MacDesktopApp` 从 URL query 读取 `windowId`；`MacAppShell` 用 `MacWorkspaceStore` 按 `zterm:mac:workspace:v1:<windowId>` load/save workspace identity，不写旧 `zterm:mac:shell-workspace:v1`，不保存 runtime/buffer/transport state。
- 已新增/同步测试：`window-manager.test.ts` 覆盖 dev/file windowId 注入、create/focus/closed、New Window menu、quit 保留 records 并按同 windowId restore；`window-id.test.ts` 覆盖 renderer query；`MacDesktopApp` / `MacAppShell` 测试覆盖 windowId 透传、window-scoped workspace save、New Window IPC；architecture truth gate 锁 `MacWindowManager` anchored。
- 验证：targeted window/architecture/layout PASS（5 files / 30 tests，后续 record restore targeted 3 files / 28 tests）；Mac full tests PASS（20 files / 111 tests）；`pnpm --dir mac run type-check` PASS；`pnpm --dir mac run build` PASS；`pnpm --dir mac run package` PASS；`git diff --check` PASS。
- Packaged smoke：`mac/evidence/2026-07-04-window-manager-smoke/restore-before-quit.json` 证明 IPC 创建第二窗口，两个窗口 `windowId` 为 `mac-window-33350880-a8eb-4afe-922d-c419aebd0520` / `mac-window-ea3e0530-0c47-4e5c-9a80-7c3e8949905a`；`restore-after-reopen.json` 证明 quit/reopen 后恢复同两个 `windowId`；`restore-after-reopen.png` 是截图；资源证据 `restore-top-86062.txt` 显示 PID 86062 两次 top CPU 0.0、约 42MB；退出后 `restore-cdp-after-quit.txt` / `restore-main-process-after-quit.txt` / `restore-process-after-quit.txt` 证明 9343 端口和明确 PID 消失。
- 自动化缺口：`System Events` Cmd+N 注入卡住，已 Ctrl-C 中断明确 osascript 会话；本轮改用正式 preload IPC 走同一个 `MacWindowManager.createWindow()` owner 做 packaged smoke，不用辅助功能权限作为验证真源。

## 2026-07-04 14:17 Mac desktop workspace Slice file browser plan
- 本轮 owner：`mac.file_browser_core` -> `packages/shared/src/files/file-browser-core.ts`；`mac.platform_fs` -> `mac/electron/file-system.ts` + preload `window.ztermMac.fileSystem`；`mac.file_browser_ui` -> `mac/src/app/file-browser/MacFileBrowserPanel.tsx`。
- 架构边界：FileBrowserCore 只做路径/排序/预览 policy，不导入 React/Electron/terminal/runtime/platform fs；Electron adapter 只做 local fs IO/dialog IPC，不做文本/二进制/大文件预览策略；React UI 只持有打开面板、目录、选中文件、confirm/error/loading projection。
- 主线：`MAC-04-WorkspaceShell -> MAC-12-FileBrowserOpen -> MAC-13-FileProviderRead -> MAC-14-FilePreview`。显式 toolbar/command 打开，不能由 terminal runtime connect/disconnect 触发。
- 测试先行：shared core unit 覆盖 normalize/join/sort/text/binary/large-confirm/provider-error；Electron adapter test 覆盖 readdir/read/select-dir/mkdir/save-file raw result；UI component test 覆盖 browse fixture、text preview、binary disabled、large confirm、no runtime connect；architecture gate 锁 core import 与 adapter policy 边界。
- 必跑验证：targeted shared/core + mac fs/UI/architecture；full Mac test/type-check/build/diff-check；因 main/preload/local fs 改动，必须 package + packaged fs smoke。Live runtime A/B input/resize/switch/close 仍是后续缺口，不用本地 file browser smoke 替代。

## 2026-07-04 Mac desktop workspace file browser closeout
- 已新增 `packages/shared/src/files/file-browser-core.ts`：唯一拥有 local path normalize/join/parent、directory-first sort、provider error projection、text/binary/large-text preview policy；不导入 React/Electron/terminal/runtime。
- 已新增 `mac/electron/file-system.ts`：唯一 local fs IPC adapter owner，注册 `zterm:fs:*` 与 `select-directory`，只返回 raw fs facts/错误；`mac/electron/main.ts` 不再散落 fs handlers；`preload.ts` 与 packaged 真入口 `preload.cts` 均暴露 `window.ztermMac.fileSystem`。
- 已新增 `mac/src/app/file-browser/MacFileBrowserPanel.tsx` 并接入 `MacAppShell` 的显式 `Files` 按钮；UI 只消费 shared policy + platform provider，不调用 runtime connect/disconnect。
- 已同步 `function-map`、`mainline-call-map`、test design、spec/architecture/desktop plan/task；`MAC-12/13/14` 与 `MAC-EDGE-0013/0014/0015` 均 anchored。
- 验证：shared full tests PASS（33 files / 276 tests）；Mac full tests PASS（22 files / 123 tests）；targeted file/architecture PASS（4 files / 33 tests）；type-check PASS；build PASS；package PASS；`git diff --check` PASS。
- Packaged fs smoke：新包以 CDP 9344 启动，真实 `window.ztermMac.fileSystem` readdir/readFile/selectDirectory 可用；fixture 列表包含 `src/image.png/large.log/README.md`；README 文本预览显示 `text preview ok`；PNG 预览 disabled；`large.log` 先出现 confirm，再显示文本。证据：`mac/evidence/2026-07-04-file-browser-smoke/file-browser-dom.json`、`file-browser.png`、`ipc-race.json`。
- 资源/退出：PID `5248` 资源采样写入 `top-before-quit.txt`；通过 CDP `Browser.close` 退出；`cdp-after-quit.txt` 为空，`process-after-quit.txt` 只有 header，证明 9344 端口和明确 PID 消失。
- 自动化经验：packaged React controlled input 不能靠直接 `input.value = ...` 作为 smoke 真源，需先 focus/select 再用 CDP `Input.insertText`，否则 React state 可能不更新；Electron packaged 实际 preload 是 `preload.cts -> preload.cjs`，改 bridge 必须同时更新 `.ts` 与 `.cts`。

## 2026-07-04 Mac runtime live isolation closeout
- Packaged app + CDP 自动化下，`tmux capture-pane` 不能稳定作为 detached `cat` fixture 的输入 oracle；本轮改用专用 session 的 `tmux pipe-pane -o` 日志，且只操作 `zterm_mac_goal_a` / `zterm_mac_goal_b`，不写用户已有 session。
- 发现并修复 shared `PaneStage` 生产 resize bug：divider 实际包在 `display: contents` wrapper 下，旧代码用 `event.currentTarget.parentElement` 取到 wrapper，`stageWidth=0` 导致 drag resize 无效；改为 `closest('[data-testid="pane-stage-split"]')`，并补 `MacPaneWorkbench.pane-ratios.test.tsx` 生产结构回归。
- 发现并修复 close active pane root 清空 bug：`MacPaneWorkbench` UI 层手写 close pane 时绕过 `workbench-model.closeTab`，删除 active pane 后留下 dangling `activePaneId`，随后 `MacWorkspaceStore.parse` 抛错导致 React root 空白；改为 UI close 调 `closeTab` owner，并补 `workbench.test.ts` 与 `MacPaneWorkbench.test.tsx` 回归。
- Packaged live4 smoke 已闭环：正式 launcher 打开 `zterm_mac_goal_a/b`，A/B 均 connected；B marker 只进 B pipe，A marker 只进 A pipe；divider drag 后 pane 宽度 `1752/1752 -> 2249.164/1254.836`，workspace size `0.5/0.5 -> 0.641884/0.358116`，marker 仍隔离；切 B/A active 状态正确；关闭 A 后只剩 B pane，root 仍 mounted，B after-close marker 只进 B。证据：`mac/evidence/2026-07-04-runtime-live-isolation-smoke/live4-full-runtime-isolation-result.json`、`live4-after-close-b-input.png`、`live4-pipe-a.log`、`live4-pipe-b.log`。
- 资源/退出：live4 packaged app 端口 owner PID `75136`，`live4-top-before-quit-75136.txt` 采样完成；CDP `Browser.close` 后 `live4-cdp-after-quit.txt` / `live4-lsof-after-quit.txt` 为空，`live4-ps-after-quit-75136.txt` 只有 header。

## 2026-07-04 Mac server directory remote refresh slice
- 本片 owner：`mac.server_directory`；主线追加 `MAC-17-ServerLiveRefresh`。唯一允许链路是 `MacServerDirectoryRail refresh click -> MacAppShell thin async orchestration -> fetchMacServerDirectoryLiveSessionSnapshot -> projectMacServerDirectory`。
- 架构边界：refresh 只能更新 `liveSessions` 和每 server refresh status/error 投影；不得调用 `openConnectionInWorkbench`、`addHost`、`setBridgeSettings`、`MacRuntimeRegistry.ensureRuntime`，不得 close/prune 已打开或 saved sessions。
- 测试设计：正向锁 refresh 成功后 live sessions 出现在 rail；反向锁缺 token/daemon error 显式显示错误且保留 saved/open sessions，不包装成 empty success。
- Live smoke 只做 read-only daemon `list-sessions` 观测；Jason 已允许用 Mac Studio daemon 和现有 sessions 做观测，但不能向现有用户 sessions 写 input。

## 2026-07-04 Mac legacy cleanup closeout
- 本片 owner：`mac.legacy_cleanup`；主线 `MAC-16-LegacyRemoval -> MAC-04-WorkspaceShell` 已从 pending 升级为 anchored，验证入口是 `mac/src/lib/mac-architecture-truth.test.ts`。
- 已物理删除旧 all-in-one `ShellWorkspace` 页面/lib/旧 split-tree 测试：`mac/src/pages/ShellWorkspace.tsx`、`mac/src/pages/ShellWorkspace.split-tree.test.tsx`、`mac/src/lib/shell-workspace.ts`；同时删除孤立 `.shell-workspace-root` CSS。
- 保留范围：`QuickConnectSheet`、`DetailsSlot`、`TerminalSlot`、`SessionScheduleModal`、`RemoteScreenshotSheet`、`FileTransferSheet`、`bridge-transport` 等独立组件/协议 helper 未删除；它们不是 workspace fallback，后续需按各自 owner 重新接入。
- 旧 `localStorage["zterm:mac:shell-workspace:v1"]` 在用户数据里可能仍残留，但新 production 路径不读写。当前 hard gate 锁文件不存在、生产源码无 `ShellWorkspace` 引用、packaged DOM 无 `.shell-workspace-root`。
- 验证：targeted cleanup/workspace/runtime/server/file 11 files / 99 tests PASS；Mac full 21 files / 124 tests PASS；shared full 33 files / 276 tests PASS；type-check/build/package/diff-check PASS；final packaged smoke 9348 证明新包渲染新 shell 且旧 root 不存在，资源/退出证据在 `mac/evidence/2026-07-04-legacy-cleanup-smoke/`。

## 2026-07-04 Mac terminal buffer black-box gate
- Jason 纠正：Mac terminal packaged smoke 不能只看 connected/status/截图，必须比较 session truth 和 app render output。
- 新 gate owner 映射：`mac.runtime_registry` / `mac.terminal_pane` 的 L5 packaged gate 增加 `pnpm --dir mac run blackbox:terminal-buffer -- --case=all`。
- gate 设计：专用 tmux session；`tmux capture-pane` 是 session output truth；`tmux pipe-pane` 是 input oracle；packaged app DOM `data-terminal-row-text` 是 output target；覆盖 controlled sequence 和持续刷新底部 TUI。
- 当前状态：脚本和 docs/gate 映射已补，尚需跑 packaged gate；未通过前不能关闭 T-A4，也不能宣称 alpha-ready。

## 2026-07-04 Mac terminal buffer black-box red follow-up
- 复验红点：`buffer-gate-sequence-5/sequence-comparison.json` 显示 packaged app 已 connected，`pipe-pane` saw input token，pipe 与 `tmux capture-pane` 均有 `_001.._080`，但 app DOM rows 只到 `_057`，因此是有效 session truth -> output target 不一致。
- 架构映射：问题属于 `mac.local_tmux_provider`，唯一 owner 是 `mac/electron/local-tmux.ts` 的 `LocalTmuxManager/readSessionCapture/captureToBufferPayload`；不是 `MacTerminalPane` / renderer 补偿点。
- 处理方式：物理移除 head/sync canonical capture 的 `capture-pane -E -1` 可见尾部裁断语义；allowed path 是 Electron local tmux provider + map/gate/test 设计，forbidden path 是 renderer/UI 二次拉取或本地补 tail。
- 必跑 gate：先 architecture/local tmux/terminal runtime 白盒，再 full Mac/type/build/package，最后 packaged `blackbox:terminal-buffer -- --case=all`，sequence 与 TUI 均绿前不能关闭 T-A4。

## 2026-07-04 Mac terminal buffer black-box closeout
- 固定 session 生命周期：gate 改为复用 `zterm_mac_gate_sequence` / `zterm_mac_gate_tui`，用 tmux option marker 标识 owner/case；已存在但无 marker 的同名 session 直接拒绝；每轮 respawn + `clear-history`，默认保留固定 session，不再 timestamp 新建一堆 session。
- TUI 黑盒根因：fixture 刷新和 provider full-history capture 会把历史帧累进到 DOM，造成 lag 假红/真实刷新风险；`LocalTmuxManager` 检测 `alternate_on` 后用 bounded visible capture（`-S -<paneRows>`）作为 current screen truth，避免 full-history live payload。
- 验证：targeted architecture/local tmux 18/18 PASS；Mac full tests 132/132 PASS；type-check/build/package/diff-check PASS；packaged `blackbox:terminal-buffer -- --case=all --port=9362 --evidence=mac/evidence/2026-07-04-mac-alpha-p0-closeout/buffer-gate-all-fixed-lifecycle-1` PASS。sequence/tui 都自动对比 session truth 与 app DOM，无人工确认。
- 剩余：T-A4 只关闭黑盒 gate 子项；large-output reading mode、gap repair、return-to-follow packaged proof 仍未完成。

## 2026-07-04 Mac tmux lifecycle correction
- 用户纠正：测试不能每轮新开一串 tmux session 后不管生命周期；必须复用已打开的固定 session，并在结束时精确收口。
- 已复核并精确关闭旧临时测试 session：`zterm_mac_alpha_a`、`zterm_mac_alpha_b`、`zterm_mac_alpha_large`、`zterm_mac_buffer_222327`、`zterm_mac_goal_a`、`zterm_mac_goal_b`。
- 保留且只保留固定 gate 复用池：`zterm_mac_gate_sequence` / `zterm_mac_gate_tui`，二者 tmux option marker 均为 `@zterm_mac_gate_owner=terminal-buffer-blackbox`。
- 规则已同步到 `.agents/skills/zterm-mac-dev/SKILL.md` 与 `mac/MEMORY.md`：后续 smoke/blackbox 必须先盘点、优先复用、结束复核；关闭只能逐个明确 session 名，禁止 broad kill。

## 2026-07-05 Mac alpha P0 header/restore packaged closeout
- 新增 packaged smoke gate：`mac/scripts/alpha-p0-packaged-smoke.mjs`，npm 入口 `pnpm --dir mac run smoke:alpha-p0 -- --case=header-restore`。
- 架构映射：`mac.workspace_store` / `MAC-EDGE-0003` 证明 window-scoped workspace 冷恢复；`mac.runtime_registry` / `MAC-EDGE-0009/0010` 证明 active-only eager connect；`mac.terminal_pane` / `MAC-EDGE-0011/0012` 证明 header/status/control projection。
- 白盒新增：`MacAppShell.layout.test.tsx` 锁 smoke diagnostics 只记录 active-only ensure；`MacRuntimeRegistry.test.ts` 锁 smoke diagnostics 的实际 connect/disconnect；`MacPaneWorkbench.test.tsx` 锁 error header 不包装成 connected。
- Packaged smoke fresh evidence：`mac/evidence/2026-07-05-mac-alpha-p0-closeout/header-restore-final2/summary.json`。结果：同一 `windowId` 冷重启恢复 hidden + active tabs；hidden ensure connect=0、hidden actual runtime connect=0；active actual runtime connect=2；Disconnect 后 header idle，Reconnect 后 connected。
- 生命周期复核：9363 CDP/ZTerm/Electron helper 为空；`zterm_mac_alpha_active` / `zterm_mac_alpha_hidden` 临时 tmux session 已按 marker 精确清理；现有用户 tmux session 只读未写入。

## 2026-07-05 Mac alpha P0 T-A1 QuickConnect closeout
- 本片 owner：`mac.quick_connect`。`ConnectionLauncher` 负责 remote target input、显式 Discover sessions、session 预选和 save/open intent；禁止在 launcher 里创建 runtime 或调用 `openConnectionInWorkbench`。
- 主线映射：`MAC-04-WorkspaceShell -> MAC-19-QuickConnectDiscovery -> MAC-20-QuickConnectOpen -> MAC-03-WorkspaceLoad`；call map 边为 `MAC-EDGE-0022/0023/0024`。
- 实现要点：`ConnectionLauncher` 使用 test-injectable `sessionFetcher`，production 默认 `fetchTmuxSessions`；host/port/token 变化会清掉 stale discovered session，避免旧 session 被打开到新 endpoint。
- 白盒：`ConnectionLauncher.test.tsx` 覆盖 discovery success + latest saved matching preselect、discovery error 不 open、remote target 改变清 stale selected session；`MacAppShell.layout.test.tsx` 覆盖 Discover 不 create runtime、Save & connect 才 ensure remote runtime；architecture truth gate 锁 QuickConnect branch。
- Packaged smoke：`mac/evidence/2026-07-05-mac-alpha-p0-closeout/quick-connect-discovery-final3/summary.json`。真实 daemon config route `127.0.0.1:3333`；dedicated tmux `zterm_mac_alpha_quick` owner `alpha-p0-quick-connect`；UI 通过 `Input.insertText` 输入 host/port/token；Discover 后 radio 预选 `zterm_mac_alpha_quick` 且 runtime calls=0；Save & connect 后 remote runtime connected。
- 生命周期/安全：final evidence 中 `authToken` / `targetAuthToken` 已 redacted；`rg "wterm-4123456|targetAuthToken|authToken" quick-connect-discovery-final3` 无输出；9364/ZTerm process after close 为空；`zterm_mac_alpha_quick` 已按 marker 清理；用户 tmux session 只读列举未写入。

## 2026-07-05 Mac alpha P0 remote server rail open closeout
- 本片 owner：`mac.server_directory` + `MacAppShell` thin orchestration。Refresh 仍只允许 live projection/status/error，不得创建 runtime；explicit rail session click 才能 open workspace tab/runtime。
- 主线映射：`MAC-05-ServerDirectory -> MAC-17-ServerLiveRefresh -> MAC-05-ServerDirectory` 做 read-only refresh；`MAC-05-ServerDirectory -> MAC-06-OpenTabIntent -> MAC-03-WorkspaceLoad -> MAC-08-RuntimeEnsure` 做 explicit open。
- 白盒：`MacAppShell.layout.test.tsx` 新增 refresh 后 `ensureRuntime` 未调用、点击 live session 后 remote runtime `connect:true`；`mac-architecture-truth.test.ts` 锁 `server-rail-remote-open` smoke 和 mainline gate。
- Packaged smoke：`mac/evidence/2026-07-05-mac-alpha-p0-closeout/server-rail-remote-open-final2/summary.json`。真实 daemon `list-sessions` 返回 dedicated `zterm_mac_alpha_remote_open`；Refresh 后 rail project live 且 `runtimeEnsureCalls=0`；点击后 remote runtime connected once，DOM rows 渲染 `ZTERM_ALPHA_REMOTE_OPEN_READY`。
- 生命周期/安全：final evidence 中 token 字段已 redacted；`rg "wterm-4123456|targetAuthToken|authToken" server-rail-remote-open-final2` 无输出；9365/ZTerm process after close 为空；`zterm_mac_alpha_remote_open` 已按 marker 精确清理；用户 tmux session 只读未写入。

## 2026-07-05 Mac alpha P0 T-A4 buffer follow/reading closeout
- 本片 owner：`mac.terminal_pane` + shared renderer demand path；runtime 只接收并透传 renderer `missingRanges`，不在 runtime 里猜 gap。
- 修复：`buildTerminalViewportDemandWithRepair` 用 visible range + projection `gapRanges` 计算 repair ranges；`MacTerminalView` follow/reading demand 不再硬清 `missingRanges`；`MacRuntimeRegistry` 增加 smoke-only viewport diagnostics；`.mac-terminal-surface/.mac-terminal-canvas` 增加 flex height 约束，修 packaged 下 `clientHeight === scrollHeight` 导致无法进入 reading 的真实布局缺口。
- 白盒：shared renderer/gap/MacTerminalView 33/33 PASS；Mac runtime/registry/pane/layout targeted 47/47 PASS；type-check/build/package PASS。
- Packaged gate：`pnpm --dir mac run blackbox:terminal-buffer -- --case=all --port=9366 --evidence=mac/evidence/2026-07-05-mac-alpha-p0-closeout/buffer-gate-all-t-a4-final` PASS。sequence pipe/tmux/app tail `_001.._080` 一致；TUI current screen max lag 1、final exact；large-reading 进入 reading、append 后 scroll/rows 稳定、scroll-to-bottom 回 follow、app/tmux append tail 一致、runtime viewport diagnostics 记录 reading demand。
- 生命周期：9366 packaged app close 后 process 文件为空；固定 gate session 保留为复用池：`zterm_mac_gate_sequence` / `zterm_mac_gate_tui` / `zterm_mac_gate_large`，均需 marker 校验后复用或 cleanup。

## 2026-07-05 Mac alpha P0 T-A5 disconnect/reconnect closeout
- 本片 owner：`mac.runtime_registry` + transport owners。`MacTerminalPane` 只发 Reconnect intent；`MacRuntimeRegistry.reconnectRuntime(runtimeKey)` 使用 stored target 重新 connect 指定 runtime；`bridge-transport` / `local-tmux-transport` 负责把 unexpected close 投影为 explicit error。
- 修复：unexpected WebSocket close 和 local tmux closed event 不再静默变 idle；manual disconnect 仍走 idle。新增 smoke-only local tmux clientId diagnostics 与 `forceCloseForSmoke(clientId)`，main handler 只在 `--zterm-alpha-smoke` 下允许，用于 packaged 黑盒诱发真实 transport owner close/error。
- Docs/map：补 `MAC-CALL-RUNTIME-004`、`MAC-CALL-LOCAL-TMUX-004`、`MAC-21-ReconnectRecovery`、`MAC-22-LocalTmuxSmokeClose`、`MAC-EDGE-0025/0026/0027`，test design 加入 T-A5 白盒/黑盒和 packaged gate。
- 白盒：`mac-architecture-truth` + bridge/local transport + runtime registry targeted 41/41 PASS。覆盖 unexpected close -> error、manual disconnect -> idle、target-only reconnect、missing target reconnect false。
- Packaged smoke：`pnpm --dir mac run smoke:alpha-p0 -- --case=disconnect-reconnect --port=9367 --evidence=mac/evidence/2026-07-05-mac-alpha-p0-closeout/disconnect-reconnect-final2` PASS。证据证明 active local tmux transport close 后 header/runtime error，点击官方 Reconnect 后 connected；active runtime connect count `2`，hidden runtime connect count `0`，`windowIdStable=true`。
- 生命周期：9367 packaged app close 后 ZTerm/CDP process 文件为空；`zterm_mac_alpha_reconnect*` 临时 tmux session 已按 marker 清理；固定 gate session 只保留 `zterm_mac_gate_sequence` / `zterm_mac_gate_tui` / `zterm_mac_gate_large`。
