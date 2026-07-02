
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
