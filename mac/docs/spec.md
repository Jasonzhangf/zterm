# zterm Mac Spec

## 目标

先做一个 **Mac 最小可执行桌面壳**，保证：

- 能构建
- 能打包
- 能启动窗口
- 能展示 `zterm` 的单行多列 + 垂直分屏布局 stage

当前阶段先证明桌面壳与布局真源成立，并直接收口到 **terminal-first workspace**。  
桌面端不再以“左 rail + inspector + demo shell”为主，而是以 **干净终端 + 按需连接 + 竖向分屏** 为主。

当前冻结方向：

- 共享连接配置真源已接入 Mac
- 真实 bridge websocket attach 已接入 Mac
- 但桌面 UI 方向重新冻结为：
  - 默认只显示一个干净 terminal workspace
  - 无连接时中间显示一个 `+`
  - 点击 `+` 才进入 new connection / edit connection
  - 成功连接后主视图应尽量只剩 terminal
  - 宽屏优先用于 `1 / 2 / 3` 个 **vertical split panes**
  - 不再把左 rail / inspector / 厚 chrome 当成主视觉

## 当前范围

- Electron 主进程
- Vite + React 渲染进程
- 最小窗口壳
- 单工作区 terminal-first stage
- 基础标题栏 / 极薄 pane 标题
- 顶部 tab strip（只保留必要状态，不做厚重 shell）
- 中央空态 `+`
- 连接配置 sheet / modal（按需出现，不常驻占空间）
- 主 workspace 默认单 pane；按需 split 成多个 vertical panes
- split 新增时默认均分，支持拖拽调整比例
- 每个 pane 默认就是 terminal 视角，尽量避免无关装饰
- 每个 pane 内支持多个 tabs；workspace 默认恢复上次 panes/tabs/connection 布局
- shell tabs 当前只保证“多个 open target + 单个 live runtime”的真实闭环；不宣称并发多 websocket / 多 live session
- profiles 为低频菜单动作：保存 / 恢复 / 导出，不常驻侧栏
- 快捷菜单为 overlay：`快捷输入 / 剪贴板` 两个 tab，不常驻右栏
- 桌面排版优先级高于额外壳层装饰：一旦壳层和主终端阅读区域冲突，先压缩或移除 chrome / tab / meta 区，保证 terminal surface 最大化
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
4. 应用启动后能看到单工作区 terminal-first stage
5. 连接配置与 terminal workspace 使用同一 shared truth
6. Mac renderer 能完成：
   - session discovery
   - `connect + stream-mode(active)`
   - live terminal render
7. 证据落到 `mac/evidence/`
8. 宽屏场景下必须优先服务 terminal 视角，而不是 rail / inspector / demo chrome
9. workspace 最小能力验收：
   - 无连接时中央可见 `+`
   - 点击后能进入连接配置
   - 连接后主视图为 terminal
   - split workspace 至少支持 `1 / 2 / 3` 个按比例分列的 vertical panes
10. 顶部 tabs 的最小能力验收：
   - 可以打开 saved target 成为 tab
   - 可以 `+` 新建 tab
   - 可以关闭当前 tab
   - active tab 与当前 live runtime 的 target 对应关系明确
11. shell 交互的最小能力验收：
   - 每个 pane 可维护多个 tab
   - 关闭最后一个 tab 后回到空 `+` tab
   - packaged `.app` 中可以 split / drag / restore last workspace
   - 仍保持 terminal-first，不出现上下堆叠主方案
