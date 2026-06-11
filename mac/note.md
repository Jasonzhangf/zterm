
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
