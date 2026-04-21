# zterm Mac Architecture

## 真源层级

1. `mac/docs/spec.md`：Mac 最小包目标与验收
2. `mac/docs/architecture.md`：Mac 模块边界
3. `mac/docs/dev-workflow.md`：Mac 验证入口与证据要求
4. `android/docs/decisions/0001-cross-platform-layout-profile.md`：跨尺寸布局与共享 pane 真源
5. `android/task.md`：跨尺寸 / Mac 任务板与 Beads 映射
6. `mac/MEMORY.md`：Mac 长期经验
7. `mac/evidence/`：构建与打包证据

## 最小包模块边界

- Main Process
  - 创建 BrowserWindow
  - 区分 dev / packaged 入口
  - 生命周期管理

- Renderer App
  - React 根组件
  - terminal-first workspace：
    - compact window chrome
    - 极薄 workspace/tab strip（真实映射当前 target + split preset 状态）
    - 默认单工作区；无连接时中央显示 `+`
    - new/edit connection 走按需 modal / sheet，不常驻占位
    - workspace 当前只做 vertical split
    - 默认单 pane；split 时插入新的 column pane，初始均分
    - pane ratio 支持 drag resize，但不做任意嵌套 / 横向分屏
    - open target tabs 当前采用 `single runtime · multi tabs`：
      - 可以同时维护多个 open target descriptor
      - 每个 pane 内可以挂多个 tabs，空 tab 显示 `+`
      - 但 app-level bridge websocket/runtime 同时只服务一个 active pane 的 active target
      - 切 pane / 切 tab 时如 target 变更，则切换 active target 并重连
    - 低频 profile / export 走顶部菜单，不常驻 rail
    - 快捷输入 / 剪贴板走 overlay palette，不常驻右栏
  - 单行多列 + 垂直分屏布局
  - terminal pane 是主真相；连接配置只是进入动作，不是常驻主视图

- Shared Connection Truth
  - `packages/shared/src/connection/*`
  - `packages/shared/src/react/*`
  - 统一承载 Host / BridgeSettings / bridge URL / tmux discovery / localStorage hook
  - 统一承载 bridge endpoint 归一：
    - `bridgeHost` 若已带 `ws://` / `wss://` 与端口，display / preset id / effective port 都以显式 URL 为真源
    - 禁止再把独立 `bridgePort` 二次拼到文案或 key 上

- Shared Terminal Truth
  - `packages/shared/src/connection/protocol.ts`
  - `packages/shared/src/connection/bridge-connection.ts`
  - `packages/shared/src/connection/terminal-buffer.ts`
  - `packages/shared/src/react/terminal-view.tsx`
  - 统一承载 websocket 协议、buffer reducer、snapshot render
  - **协议必须与 daemon 同步演进**；客户端若仍只消费 `snapshot / viewport-update / scrollback-update`，而 daemon 已切到 `buffer-sync / buffer-delta / buffer-range`，就会出现“能列 session，但连接后黑屏”

- Mac App-level Bridge Orchestration
  - `mac/src/lib/use-bridge-terminal.ts`
  - App 级持有 websocket 生命周期、heartbeat、buffer state、active target
  - Details 只发 connect request，不再自己持有 socket
  - Terminal 只消费 app-level bridge state 与 shared terminal view

- Build / Package
  - Vite 构建 renderer
  - TypeScript 构建 main/preload
  - electron-builder 打包最小 `.app`

## 布局原则

- 直接复用仓库已冻结的跨尺寸布局决策：
  - 默认一行多列
  - pane 之间垂直分屏
  - 不以上下堆叠多 pane 作为主方案

- Tabby 只作为桌面壳层参考，不作为布局真源：
  - 可以借用紧凑 chrome、顶部 tab strip、主终端优先的视觉组织
  - 不照搬其左 rail / inspector 常驻 / 自由拖拽布局
  - 真正的 pane 编排仍由 shared `layout profile + PaneStage` 决定

- Mac 第一阶段只先做桌面壳上的 stage：
  - 窄窗：单列
  - 中窗：双列
  - 大窗：三列

## 边界规则

- 现在已证明 shell / package / live render 主链闭环
- 不复制 Android runtime 源码
- 业务连接能力继续优先下沉到 shared app-layer
- session discovery != live connect：`list-sessions` 只能证明可发现，真正 attach 必须显式发送 `connect + stream-mode(active)`
