---
name: zterm-windows-dev
description: zterm Windows Electron 客户端与 WezTerm daemon 开发闭环，覆盖共享核心边界、packaged preload、真实 Windows CDP/source-to-DOM gate 和精确资源清理。
---

# zterm Windows Dev

## 必读

1. `win/docs/architecture.md`
2. `win/docs/function-map.md`
3. `win/docs/windows-desktop-shell-manifest.json`
4. `win/docs/testing/windows-desktop-shell-test-design.md`
5. `win/MEMORY.md`

## 边界

- `win/` 只拥有 Electron 窗口、preload、Windows 平台适配、桌面组合和打包。
- 复用 shared transport、sparse buffer、renderer；禁止复制 daemon、mirror、renderer、Mac IPC 或 local tmux。
- daemon backend 变更仍由 `daemon.windows_wezterm_backend` owner 处理。

## Packaged 门禁

- Sandbox preload 源用 `.cts`，main 只加载生成的 `preload.cjs`。typecheck/build 不能证明 packaged preload 可加载。
- `connected` 不等于 mirror ready。首个 `buffer-sync` revision 前禁止发 visible-range request，否则 daemon 会显式报 mirror not ready。
- 完成必须在真实 Windows packaged app 上自动证明：bridge 存在、连接无 error、输入唯一 marker、DOM rows 匹配命令和输出。
- Smoke 使用固定专用 session 或唯一明确 sessionName；结束按 sessionName 清理。App/helper、CDP tunnel、SSH holder 只按明确 PID/session 关闭，禁止 broad kill。
- Session discovery/create/close UI must call shared daemon control helpers. Do not fork control wire semantics in Windows UI; verify UI list and daemon final list agree after close.
- Desktop pane/tab composition must use shared `PaneStage`, `PaneTabs`, and workspace-model operations. Keep one stable runtime per tab id; focus switches must not reconnect. Packaged proof records daemon attached/ready counts before and after focus switch, isolated markers in each pane, then closes one tab and proves the sibling still receives a new marker.
- 生成物 `win/dist/`、`win/dist-electron/`、`win/out/`、evidence 不进 git/MemPalace。

## 最小验证

```bash
pnpm --dir win run type-check
pnpm --dir win test -- --reporter dot
pnpm --dir win run build
pnpm --dir win run package
```

随后部署真实 Windows 包并跑 source-to-DOM marker gate；只完成本地命令不得宣称 packaged alpha 闭环。
