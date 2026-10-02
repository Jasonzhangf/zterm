---
name: zterm-windows-dev
description: zterm Windows Electron 客户端与 WezTerm daemon 开发闭环，覆盖共享核心边界、packaged preload、真实 Windows CDP/source-to-DOM gate 和精确资源清理。
---

# zterm Windows Dev

## 节点笔记与必读

先审计本任务已有节点笔记和证据，判明当前状态与缺口，再按受影响范围读取真源；已记录且未失效的事实不重复读取、不重复验证。

```
0. 任务独占 run notes        → 当前节点状态与已有证据（先读）
1. `win/docs/architecture.md`
2. `android/docs/dagpipe/windows-remote-access-client.graph.json`
3. `android/docs/dagpipe/README.md`
4. `win/docs/testing/windows-desktop-shell-test-design.md`
5. `win/MEMORY.md`
```

重读触发仅限：代码、输入、配置、依赖、产物或必要环境变化，证据缺失/冲突/过期，或需刷新 main/远端/PID/runtime 等可变状态；换轮、换 agent、单纯不放心不触发重读。

节点笔记是阶段状态唯一载体：开发/修复/重构的每个流程节点完成、失败或阻塞时立即写 `时间/节点｜结论或状态｜证据路径｜输入版本及必要环境｜下一步`；未证实的判断标假设，失败保留原错。进入下一节点、重试、恢复或交接前先读笔记再动作；已有有效证据直接复用，不重复检查。

## 边界

- `win/` 只拥有 Electron 窗口、preload、Windows 平台适配、iTerm2 风格 sidebar/workspace/statusbar 目标 UI、桌面组合和打包。
- 复用 shared transport、sparse buffer、renderer；禁止复制 daemon、mirror、renderer、Mac IPC 或 local tmux。
- daemon backend 变更仍由 `daemon.windows_wezterm_backend` owner 处理。
- DAGPipe 当前真源是 `android/docs/dagpipe/windows-remote-access-client.graph.json`；旧 Windows function map / mainline map / shell manifest 已删除，不再作为 owner 真源。

## Packaged 门禁

- Sandbox preload 源用 `.cts`，main 只加载生成的 `preload.cjs`。typecheck/build 不能证明 packaged preload 可加载。
- `connected` 不等于 mirror ready。首个 `buffer-sync` revision 前禁止发 visible-range request，否则 daemon 会显式报 mirror not ready。
- 完成必须在真实 Windows packaged app 上自动证明：bridge 存在、连接无 error、输入唯一 marker、DOM rows 匹配命令和输出。
- Smoke 使用固定专用 session 或唯一明确 sessionName；结束按 sessionName 清理。App/helper、CDP tunnel、SSH holder 只按明确 PID/session 关闭，禁止 broad kill。
- Session discovery/create/close UI must call shared daemon control helpers. Do not fork control wire semantics in Windows UI; verify UI list and daemon final list agree after close.
- Desktop pane/tab composition must use shared `PaneStage`, `PaneTabs`, and workspace-model operations. Keep one stable runtime per tab id; focus switches must not reconnect. Packaged proof records daemon attached/ready counts before and after focus switch, isolated markers in each pane, then closes one tab and proves the sibling still receives a new marker.
- Windows file browser must keep provider IO in `win/electron/windows-file-system.ts`, UI projection in `win/src/WindowsFileBrowserPanel.tsx`, and preview/path policy in shared `FileBrowserCore`. Packaged proof opens a real Windows fixture, compares Markdown source-to-DOM, proves binary disabled, and confirms daemon session counts stay unchanged.
- 生成物 `win/dist/`、`win/dist-electron/`、`win/out/`、evidence 不进 git/MemPalace。

## 最小验证

```bash
pnpm --dir win run type-check
pnpm --dir win test -- --reporter dot
pnpm --dir win run build
pnpm --dir win run package
```

随后部署真实 Windows 包并跑 source-to-DOM marker gate；只完成本地命令不得宣称 packaged alpha 闭环。

## iTerm2-style Remote Access Gate

- 先更新 `android/docs/dagpipe/windows-remote-access-client.graph.json`，确认 host/profile、session catalog、sidebar projection、workspace projection、shared terminal rendering、statusbar projection 的入口、依赖、success/failure/cleanup 终点。
- 当前静态 DAG 已通过 Phase 0；它只证明 Windows remote-access composition 的形状，不证明 profile/sidebar/statusbar 已实现，也不证明 shared renderer 内部 graph。
- 再改 `win/src` / `win/electron` / `win/docs`。禁止在 Windows UI fork daemon session truth、transport、buffer、renderer、mirror 或 file preview policy。
- Packaged smoke 必须证明：sidebar profile/session projection、workspace split/tab projection、terminal marker source-to-DOM、statusbar projection、file browser fixture、daemon session cleanup。
