# 2026-04-21 Mac shell workspace implementation evidence

## Commands

```bash
pnpm --filter @zterm/mac type-check
pnpm --filter @zterm/mac package
osascript -e 'if application "ZTerm" is running then tell application "ZTerm" to quit'
open /Volumes/extension/code/zterm/mac/out/mac-arm64/ZTerm.app
```

## Results

- `type-check`: passed
- `package`: passed, output at `/Volumes/extension/code/zterm/mac/out/mac-arm64/ZTerm.app`
- packaged app visual smoke: passed
  - default shell screenshot: `/Volumes/extension/code/zterm/mac/evidence/2026-04-21-shell-workspace-default.png`
  - restored multi-pane live workspace screenshot: `/Volumes/extension/code/zterm/mac/evidence/2026-04-21-shell-workspace-split-live.png`
  - connection picker overlay screenshot: `/Volumes/extension/code/zterm/mac/evidence/2026-04-21-shell-workspace-connection-picker.png`

## Verified behaviors

- 默认 terminal-first shell 启动
- workspace 会恢复上次 panes / tabs / connection 布局
- active pane 显示 live terminal，inactive pane 显示激活提示
- 空 pane 显示 `+`，点击后弹出 connection picker overlay
- packaged `.app` 中可看到多 pane + pane tabs 壳层
