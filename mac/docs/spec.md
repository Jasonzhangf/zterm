# zterm Mac Spec

## 目标

按 **与 Android 相同的 terminal 契约模型**，完全重写 Mac 客户端。

唯一允许的主链是：

```text
Server(session truth)
-> Client Buffer Worker
-> Renderer Container
-> UI Shell
```

Mac 不能再维护第二套 desktop-only terminal 真相；只能在 **平台壳** 上补桌面能力（窗口、菜单、快捷键、后续 split/tab 管理），不能改写 buffer/render ownership。

## 当前阶段目标（Phase 1）

先切掉旧的 demo shell / workspace 编排，建立新的 **terminal-first 单工作区骨架**：

- Electron 壳继续保留
- App-level 入口改成新的 terminal-first workbench
- 空态只显示一个干净的 terminal workspace + `Open connection`
- 连接入口改成轻量 launcher / editor
- active connection 只服务一个 terminal surface
- terminal surface 继续走真实 runtime，不允许静态假 terminal 占位
- 先证明新的 app shell / tab ownership / runtime ownership 成立，再继续切 buffer worker / split / local tmux

## 范围

- Electron main / preload 继续作为平台壳
- Mac renderer 完全切离旧 `ShellWorkspace` 主编排
- 新的 app shell：
  - terminal-first header
  - minimal tab strip
  - launcher / editor overlay
  - 单 terminal surface
- saved hosts / bridge settings 继续复用 shared truth
- active terminal 继续连接真实 websocket runtime
- 证据继续落到 `mac/evidence/`

## 暂不范围（本阶段不宣称）

- 多 pane vertical split closeout
- local tmux closeout
- schedule modal closeout
- 多 live session 并发
- packaged app 的完整桌面交互 polish
- 新 buffer worker / server head 协议最终收口

## 契约要求

1. server truth 只认 tmux / daemon session truth
2. client buffer 只能是 sparse absolute-index mirror
3. renderer 只能消费 index window，不能直接驱动 transport
4. UI shell 只改呈现，不改内容真相
5. Mac 侧禁止再回到“workspace/shell 组件顺手维护 terminal 状态”的旧方向

## 本轮验收标准

1. `mac/docs/spec.md / architecture.md / dev-workflow.md` 已按 contract model 重写
2. `mac/task.md / mac/CACHE.md` 建立本轮 rewrite 追踪
3. `pnpm --filter @zterm/mac type-check` 通过
4. `pnpm --filter @zterm/mac build` 通过
5. Mac renderer 入口已切到新的 terminal-first shell，不再依赖旧 `ShellWorkspace` 作为主入口
6. 空态可打开 launcher
7. 选中 saved host 或新建 host 后，active tab 能进入真实 terminal runtime
8. 本轮报告只宣称“app shell 第一刀 + ownership 重置完成”；不宣称 buffer worker / split closeout
