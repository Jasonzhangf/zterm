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
- 壳层视觉参考 Tabby：更紧凑的桌面终端 chrome、左侧 profile rail、顶部 tab strip、主终端画布优先
- 顶部 tab strip 已进入真实状态映射：会反映当前 connection / terminal target / inspector 状态，2-col 下可直接切 Terminal / Inspector
- 右侧 Details 已收成轻量 inspector：优先展示 target/session/bridge 概要，再展开连接表单

## 当前范围

- Electron 主进程
- Vite + React 渲染进程
- 最小窗口壳
- 单行多列 + 垂直分屏 stage
- 基础标题栏 / pane 标题 / profile 标识
- Tabby-inspired 壳层特征：
  - 紧凑顶部 window chrome
  - 左侧连接 / profile rail
  - 顶部 tab strip
  - 主 terminal 画布优先
  - 右侧 details 作为 inspector，而不是主阅读区
  - tab strip 要尽量承载当前 target / inspector 的真实状态，而不是静态占位文案
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
- 完整复刻 Tabby 的自由拖拽 / 任意嵌套分屏
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
8. 视觉壳层需体现 Tabby 风格参考，但不能破坏仓库唯一布局真源：
   - 仍然是一行多列
   - 仍然是垂直分屏
   - 不引入第二套 desktop-only 编排语义
9. 在 2-col 场景下，顶部 shell tabs 至少要能切换：
   - Connections + Terminal
   - Connections + Inspector
