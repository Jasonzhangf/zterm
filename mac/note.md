
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
