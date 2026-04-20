# zterm Mac Spec

## 目标

先做一个 **Mac 最小可执行桌面壳**，保证：

- 能构建
- 能打包
- 能启动窗口
- 能展示 `zterm` 的单行多列 + 垂直分屏布局 stage

当前阶段先证明桌面壳与布局真源成立，并把 Android 已有的连接配置流程接进桌面壳；真正的 tmux live session 仍后置。
当前阶段已从“最小壳 + 连接配置”推进到：

- 共享连接配置真源已接入 Mac
- 真实 bridge websocket attach 已接入 Mac
- 共享 terminal render 已能消费 snapshot / viewport-update / scrollback-update

## 当前范围

- Electron 主进程
- Vite + React 渲染进程
- 最小窗口壳
- 单行多列 + 垂直分屏 stage
- 基础标题栏 / pane 标题 / profile 标识
- 可构建的 `.app` 或 unpacked 可执行目录
- 基于 shared truth 的连接配置流程：
  - saved hosts
  - bridge settings / remembered servers
  - Android 同构的 connection properties form
- 基于 shared truth 的 live terminal 主链：
  - websocket `connect(payload)`
  - `stream-mode(active)`
  - shared terminal buffer reducer
  - shared terminal renderer

## 不在范围

- 多 session / 多 tab 的完整桌面态 closeout
- 原生菜单细化
- 快捷键体系
- 后台保活
- 安装包签名 / notarization
- 与 Android 完整共享 page/component 真正收口

## 验收标准

1. `pnpm --filter @zterm/mac type-check` 通过
2. `pnpm --filter @zterm/mac build` 通过
3. `pnpm --filter @zterm/mac package` 生成最小可执行包或 unpacked `.app`
4. 应用启动后能看到单行多列 + 垂直分屏 stage
5. Connections / Details / Terminal 三个 pane 使用同一 shared truth
6. Mac renderer 能完成：
   - session discovery
   - `connect + stream-mode(active)`
   - live terminal snapshot render
7. 证据落到 `mac/evidence/`
