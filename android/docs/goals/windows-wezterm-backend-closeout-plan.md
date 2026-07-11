# Windows WezTerm backend closeout — 实现计划

## 目标与验收标准

把当前 Windows WezTerm 初始 adapter 收口为可生产选择的 daemon backend，并为后续 `win/` 桌面客户端骨架建立最小架构真源。

验收标准：

- Windows backend 不再停留在“初始 adapter contract”，而是能通过 daemon backend selection 作为 Windows 默认 backend 跑通协议主线。
- WezTerm CLI 仍只作为外部 terminal/mux 输入源；ZTerm 继续拥有 daemon mirror truth、buffer-head / buffer-sync projection 和 client-facing protocol。
- `win/` 不复制 runtime / daemon / terminal renderer 逻辑；Windows app 只拥有窗口、菜单、打包和平台集成。
- 本地单测、mock protocol smoke、真实 Windows remote smoke、typecheck 全部通过并有证据。
- 已知 Ctrl+C / Windows console-control 语义要么被真实解决并锁测试，要么在 contract、feature registry、task 中保留为显式 alpha 风险，不允许假装闭环。

## 范围与边界

In scope：

- 收口 `daemon.windows_wezterm_backend`：backend selection、WezTerm runtime、snapshot/input/close lifecycle、错误语义、远程 smoke。
- 校准 `android/docs/decisions/2026-06-29-windows-wezterm-backend-contract.md`、`android/docs/feature-registry.json`、`android/docs/function-map.md`、`android/docs/feature-gates.md`。
- 建立 `win/` 最小文档骨架：`win/docs/spec.md`、`win/docs/architecture.md`、`win/docs/function-map.md`、`win/task.md`、`win/MEMORY.md`。
- 明确 Windows client shell 的后续 owner 和禁止路径。

Out of scope：

- 不在本阶段实现完整 Windows desktop UI。
- 不 fork WezTerm。
- 不把 `../wterm` runtime 源码复制进本仓库。
- 不为 Windows 引入第二套 terminal renderer、daemon mirror 或 buffer protocol。

## 设计原则

- 唯一真源：WezTerm pane text 是输入材料；daemon mirror truth 仍由 ZTerm backend adapter 构造。
- 单 owner：Windows backend owner 是 `daemon.windows_wezterm_backend`；Windows shell owner 后续独立登记，不接管 daemon/backend 职责。
- 无 fallback：Windows backend 失败必须显式报错，不允许静默回 tmux 或吞成成功。
- 输入安全：用户输入只能走 `wezterm cli --prefer-mux send-text --pane-id <id> --no-paste` + stdin payload。
- 生命周期显式：spawn/list/read/write/close 必须以 pane/session 映射为准，清理失败必须暴露。

## 技术方案与文件清单

现有真源与代码：

- `android/docs/decisions/2026-06-29-windows-wezterm-backend-contract.md`
- `android/docs/feature-registry.json`
- `android/docs/function-map.md`
- `android/docs/feature-gates.md`
- `android/src/server/terminal-backend-selection.ts`
- `android/src/server/wezterm-backend.ts`
- `android/src/server/wezterm-backend.test.ts`
- `android/src/server/wezterm-backend-runtime.test.ts`
- `android/src/server/terminal-control-runtime.input-queue.test.ts`
- `android/scripts/wezterm-backend-remote-smoke.ts`
- `android/scripts/wezterm-backend-input-smoke.ts`
- `android/scripts/wezterm-daemon-protocol-smoke.ts`
- `android/scripts/windows/zterm-daemon.ps1`

需要补齐或校准：

- 更新 decision doc status：从 initial adapter contract 推进到 closeout 状态，并保留未闭环风险。
- 补 `feature-registry.json` gate：unit、runtime、mock protocol、remote smoke、input smoke、typecheck。
- 补 `function-map.md` / wiki call map 绑定：backend selection -> WezTerm runtime -> mirror snapshot -> buffer protocol。
- 增加必要红测：不 fallback 到 tmux、缺 pane 显式错误、send-text 不走 shell args、closeSession 清理失败显式暴露。
- 建立 `win/` 文档骨架，声明 Windows client shell 只复用 shared/Mac desktop pane stage 和 renderer。

## 风险与规避

- Ctrl+C / console-control：当前只验证 ETX 到 raw-mode/TUI，不等价于 Windows console control event；必须保持显式风险或实现专门控制事件路径并加正反测试。
- WezTerm mux pane 泄漏：remote smoke 必须创建专用 workspace/pane 并验证 cleanup；禁止 broad kill。
- 后端选择误回 tmux：Windows 默认选择 wezterm，显式 env 可选 backend；失败必须报错。
- 远程主机不可达：不能宣称真实闭环，只能交付本地/mock 证据并列明 remote 缺口。
- Windows client 过早开工：backend 未闭环前不进入 UI 产品化，避免把 daemon 缺口转嫁给 shell。

## 测试计划

本地必跑：

```bash
pnpm --dir android exec vitest run src/server/wezterm-backend.test.ts --reporter dot
pnpm --dir android exec vitest run src/server/wezterm-backend-runtime.test.ts --reporter dot
pnpm --dir android exec vitest run src/server/terminal-backend-selection.test.ts src/server/terminal-control-runtime.input-queue.test.ts --reporter dot
pnpm --dir android exec tsx scripts/wezterm-daemon-protocol-smoke.ts
pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false
```

真实 Windows 必跑：

```bash
pnpm --dir android exec tsx scripts/wezterm-backend-remote-smoke.ts
pnpm --dir android exec tsx scripts/wezterm-backend-input-smoke.ts
```

验证证据要求：

- 记录命令、时间、退出码和关键输出。
- 远程 smoke 必须说明 host、WezTerm exe、workspace/pane cleanup 结果。
- 若 remote 不可达，最终汇报必须写明“未完成真实 Windows 闭环”。

## 实施步骤

1. 复查 `~/.codex/USER.md`、项目 AGENTS、`android/docs/architecture.md`、architecture boundary remediation、Windows WezTerm decision、feature registry、function map、mainline call map。
2. 搜 MemoryPalace `wing=zterm` 中 Windows / WezTerm / backend selection / remote smoke 经验，结果只作定位，必须打开源文件确认。
3. 跑当前基线 gate，记录哪些已过、哪些失败。
4. 修 backend closeout 缺口：backend selection、runtime lifecycle、explicit errors、input contract、snapshot projection、cleanup。
5. 补/改正反测试，锁住 no fallback、stdin-only input、missing pane explicit error、cleanup failure、Ctrl+C 已知边界。
6. 跑本地 gate 和 mock protocol smoke。
7. 跑真实 Windows remote/input smoke；若失败，追唯一真源并修，不做降级。
8. 更新 docs、feature registry、function map、mainline call map、`win/` 文档骨架、`note.md` / `MEMORY.md`。
9. 最后检查 git diff，只提交本任务相关文件；commit 并 push。

## 完成定义

- `daemon.windows_wezterm_backend` 的代码、docs、feature registry、function map、gate 互相一致。
- 本地单测、mock protocol、typecheck 通过。
- 真实 Windows remote/input smoke 通过；若环境不可达，不得标记 closeout 完成。
- `win/` 有最小架构骨架，且明确禁止复制 runtime/daemon/renderer。
- `note.md` 提炼到 `MEMORY.md`，MemoryPalace 同 wing mine 后可检索新短语。
- git commit/push 完成，最终汇报包含：改了什么、怎么验证、剩余风险/未完成、下一步。
