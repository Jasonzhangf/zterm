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
- 顶部 tab strip 已进入真实状态映射：会反映当前 connection / terminal target 状态，并承载右侧 split preset
- 右侧 Details 已收成轻量 inspector：优先展示 target/session/bridge 概要，再展开连接表单
- 顶部已支持最小真实 open target tabs：
  - saved target 可开成 tab
  - `+` 可进入 new connection tab
  - tab 可关闭
  - 当前阶段仍是 `single runtime · multi tabs`
- 版式已进入 terminal-first 收口：
  - Terminal 列宽显著大于左 rail
  - 顶部 chrome / shell tabs / pane header 已压缩
  - Terminal pane 内不再叠第二层假 tabs/toolbars
  - 左 rail 固定窄列，右侧 workspace 允许按比例切 1 / 2 / 3 个 vertical split panes

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
- 右侧 details 作为 inspector 视图之一，但不再固定死成唯一第二列
- 右侧 workspace 需支持按比例切换 multiple vertical panes（类似 iTerm2 的垂直分屏）
- tab strip 要尽量承载当前 target / inspector 的真实状态，而不是静态占位文案
- shell tabs 当前只保证“多个 open target + 单个 live runtime”的真实闭环；不宣称并发多 websocket / 多 live session
- 桌面排版优先级高于额外壳层装饰：一旦壳层和主终端阅读区域冲突，先压缩 chrome / tab / meta 区，保证 terminal surface 最大化
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
9. 在桌面 workspace 场景下，主舞台必须保持：
   - 左侧窄 Connections rail
   - 右侧 split workspace
   - split workspace 至少支持 `1 / 2 / 3` 个按比例分列的 vertical panes
10. 顶部 tabs 的最小能力验收：
   - 可以打开 saved target 成为 tab
   - 可以 `+` 新建 tab
   - 可以关闭当前 tab
   - active tab 与当前 live runtime 的 target 对应关系明确
11. split preset 的最小能力验收：
   - 可以在 packaged `.app` 中切换 `1 / 2 / 3`
   - 切换后右侧 workspace 的 pane 数和比例会改变
   - 仍保持 terminal-first，不出现上下堆叠主方案
