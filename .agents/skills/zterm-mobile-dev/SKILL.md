---
name: zterm-mobile-dev
description: "zterm Android 客户端开发工作流 - 基于 Capacitor + @jsonstudio/wtermmod-react，含完整开发闭环"
---

# zterm-mobile Dev Skill

## 项目概要

- **目标**: zterm Android 客户端，通过 Tailscale 访问本地 Mac/PC
- **技术栈**: Capacitor + React + @jsonstudio/wtermmod-react (WASM 终端)
- **服务端**: WebSocket → tmux 桥接（本地 Mac/PC 运行）
- **核心功能**: 多 terminal Tab、主机管理、后台保活、WebDAV 同步

---

## 一、必读文档顺序

每次开发前必须按顺序阅读：

```
1. ~/.codex/AGENTS.md               → 全局入口、硬护栏
2. ~/.codex/USER.md                 → 用户偏好（称呼 Jason）
3. coding-principals/SKILL.md       → 开发方法论
4. android/docs/spec.md     → 项目范围与验收
5. android/docs/architecture.md → 模块边界与数据流
6. android/docs/decisions/0001-cross-platform-layout-profile.md → 跨尺寸布局 / Mac 共享壳决策
7. android/docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md → terminal head / sparse buffer / render / UI 真源
8. android/docs/dev-workflow.md → 执行门禁与验证
9. android/task.md          → 当前任务板
10. android/docs/ui-slices.md → 页面切片与 ownership
11. 本 SKILL.md                     → 项目约束、可复用门禁
```

---

## 二、项目特有约束

### 2.1 禁止修改的代码
- 不直接把 runtime 源码复制进 zterm
- runtime 发布包的真源在 `../wterm`，需要改底层时去 fork repo 改
- 不修改 `mac/`、`win/` 下其他客户端骨架
- 不在 app repo 内复制 runtime 源码；runtime 变更改 `../wterm`
- skill / 文档 / AGENTS 真源以 `zterm` 命名，不再沿用 `wterm-mobile-*` 旧命名
- 只复用，只扩展

### 2.2 真源分工
- `spec.md`：产品范围与验收
- `architecture.md`：模块边界、数据流、ownership
- `docs/decisions/0001-cross-platform-layout-profile.md`：跨尺寸布局 / Mac 共享壳唯一决策
- `dev-workflow.md`：执行顺序、验证门禁、证据要求
- `ui-slices.md`：页面级切片与文件 ownership
- `task.md`：当前任务状态
- `CACHE.md`：本轮短期上下文
- `MEMORY.md`：长期可复用经验
- `evidence/`：截图、日志、APK、真机证据
  - 说明：`android/evidence/` 是本地证据仓，默认不进 Git 主线；Git 中只保留目录说明文件

### 2.3 旧文档处理
- `android/note.md` 是 agent 自己看的工作笔记，不是主真源
- 新任务不再往 `note.md` 追加流程说明

### 2.4 不在本项目范围
- screen 集成（用户自行管理）
- Tailscale 客户端集成（用户已有 Tailscale App）
- 密钥导入/生成（后续扩展）
- 数据加密存储（后续扩展）
- 生物识别解锁（后续扩展）

### 2.5 服务端位置
- WebSocket 服务端必须运行在本地 Mac/PC（不是手机）
- 手机端纯客户端角色

### 2.6 UI 参考图规则
- UI 开发前先冻结主参考图与次参考图
- 先对齐信息结构和交互结构，再做视觉细节
- 当前项目的主 UI 主线是：`Connections` 页 + 终端页，不是网页式主机列表页
- Jason 当前已明确认可的视觉真方向：**简洁、闭合、分区明确的 capsule/block UI**。后续按钮、快捷栏、卡片、面板默认优先使用低噪声配色 + 清晰边界 + 成组区域 + 闭合块状设计，除非该页面有明确反例需求。

### 2.7 页面级切片规则
- 页面级重构先看 `docs/ui-slices.md`
- App Shell、Connections、Connection Properties、Terminal 必须分层
- 不跨页混改；先壳后功能，先 ownership 后细节

### 2.8 卡片与预览区规则
- Connections 卡片的 preview 区在没有真实 preview 时，不要回退渲染 subtitle
- preview 和摘要信息必须分层：上半区负责 preview / 占位，下半区负责 title / subtitle / action
- 否则同一 host 摘要会在卡片内重复出现，容易被误判成渲染 bug

### 2.9 连接模型拆分规则
- mobile 的连接真源必须显式区分 `bridgeHost / bridgePort / sessionName`；禁止再用 `host/username` 混装 server 与 tmux session 语义
- terminal header / live session / tab 文案必须能直接看出 `server + session` 组合，否则多 server / 多 tmux session 场景会失真
- 若 `bridgeHost` 已显式写成 `ws://host:port` / `wss://host:port`，Android / Mac / shared storage 都必须把这个 endpoint 当成 display / preset id / effective port 的唯一真源；表单也要同步把 `Bridge Port` 刷成同一个端口，禁止出现双端口假象

### 2.10 daemon 收敛规则
- server 侧启动入口要收敛成单一 daemon CLI，默认监听地址/端口由统一配置真源决定（当前 `0.0.0.0:3333`）
- 验证过程中产生的临时 tmux session 需要及时清掉，只保留一个明确实验 session，避免把测试垃圾当成真实 session 列表
- `bridgePort` / daemon 端口 / daemon tmux session 名必须共用同一配置真源；不要在 UI、server、shell script、文案里散落硬编码
- daemon restart/status 只证明 tmux session 存在，不等于 socket 已 ready；验证时至少补一次端口监听检查或真实 WebSocket probe
- terminal 排版真源在 daemon / tmux；client 只上报 viewport(`cols / rows`) 并渲染镜像，不能在 keyboard 显隐 / pinch / rotate 时自行 replay buffer
- `wterm daemon start/restart/install-service` 不能只看 launchd loaded；必须至少等到 daemon 端口真正监听，再允许回报 ready，避免手机首连撞启动窗口
- websocket bridge 必须做双向 heartbeat：client 需要 `pong timeout -> close -> reconnect`，server 需要 protocol ping/pong 回收僵尸 socket；不能让失联 tab 长时间占住 session
- websocket reconnect 的 `ws.onopen` 必须同步发送 `stream-mode`，否则 active tab 会暂时退化成 idle/backfill 频率，表现为“秒级延迟”
- scrollback 若通过 DOM prepend/trim 历史行，client 在“未贴底”时必须保 scrollTop 锚点；否则持续输出后回滚会像 buffer 丢失
- 手势滚动进入历史阅读态后，scroll lock 要做成 latch，直到真实输入发生才允许恢复 bottom-follow；不能靠“回到底部”自动解锁
- terminal 单指手势要先做 axis lock：竖向滚动在“确认纵向手势的那一刻”重取 `startScrollTop`，横向手势再切 tab；否则会出现“不是从当前底部开始滚”的跳变
- 多 tab terminal 在 hidden → active 切换时，不能拿 hidden 期间最后一次 `bufferUpdateKind` 去重算滚动锚点；inactive tab 应冻结 scroll/layout 推导，切回后只按“贴底/保留原 scrollTop”恢复
- mobile 光标不要额外开本地 blink 动画；只消费 bridge/buffer 的 cursor 位置，避免字体/viewport 变化后出现视觉错位
- 若要让 mobile 光标忠实镜像 tmux，`CellData` 真源必须包含 `width(0/1/2)`：client 只能按远程 cell 宽度/continuation 渲染 cursor，不能再按本地字符宽度猜位置
- 多 tab terminal 不允许只保留一个 active TerminalView 再靠 `outputHistory` replay；每个 session 必须常驻自己的 terminal 实例和本地 buffer
- terminal 持久化缓存不允许只拼 raw output chunk；应从本地 terminal buffer 抽取按行 snapshot（scrollback + visible rows）后再持久化
- daemon 的 `sendInitialSnapshot()` 不能让 `tmux capture-pane` 异常冒泡到进程级；最多只允许日志告警 + fallback snapshot
- daemon 的 buffer 真源必须按 **tmux session mirror** 维护：一个 websocket/tab 只是客户端，不得拥有自己的 authoritative buffer；客户端 detach/reattach 不能重建 session 镜像
- 2026-04-23 新冻结：daemon 对外职责收敛为 **30Hz session head 广播 + range request 响应**；不再主动 push buffer 内容，consumer 不得把自己的消费状态写回 producer 作为长期真相
- 2026-04-23 新冻结：client buffer 必须是 **sparse absolute-index buffer**，允许不连续；worker 不为“完整性”主动补洞，只围绕当前工作集补缺：follow 维护尾部 3 屏热区，reading 只补当前窗口
- 2026-04-23 新冻结：renderer 只按 latest bottom-relative window 消费 buffer；UI shell 只负责容器位置/裁切；IME/keyboard 不得进入 buffer/render truth 链
- runtime 远程排障接口应收敛到 daemon HTTP：client 侧 runtime debug 只负责上送有界日志队列，daemon 侧统一缓存并通过 `/debug/runtime`、`/debug/runtime/logs` 暴露现场快照；接口复用 daemon auth token，便于服务器端直接拉取现场证据
- Node/daemon 侧若要复用 `packages/shared`，只允许 import **叶子模块**（如 `schedule/next-fire.ts`、`connection/types.ts`）；禁止从 `@zterm/shared` 根入口取模块，因为根入口会连带 React/CSS，直接把 daemon 运行时打崩
- 悬浮球快捷菜单的语义是“文本 snippet 注入”；方向键 / Esc / Tab / Backspace 属于常驻快捷栏，不要和自定义 snippet 共用同一概念模型
- session 级“定时发送”入口不要挂在 tab strip / header 这种易被理解成全局 tab 动作的位置；Android 侧优先放在当前 session 的 quick input/composer 入口里
- 悬浮球若持久化的是绝对拖拽坐标，mount / viewport resize 时必须自动 re-clamp 到可视区；不能只在拖动瞬间 clamp，否则旋转/尺寸变化后用户会丢入口
- 悬浮菜单打开时可以隐藏底部 shell rows，但关闭后必须立刻恢复；keyboard 弹起时只上抬 shell rows，本体悬浮球/面板不要跟着复用同一 transform
- 悬浮菜单内的快捷输入列表点击语义是“立即发送 snippet”，默认补 `\r` 执行；只有剪贴板注入才追加到 draft，不要混成同一路径
- terminal follow 态不要在每次 buffer/input 到来时直接同步硬改 `scrollTop`；应合并成单向 cadence（如 rAF）贴底，并屏蔽程序化 scroll 反向触发 onScroll，避免底部抖动/拉扯
- `TerminalView` 的 follow 对齐若会被 active/reset/layout/audit 多个入口复用，必须先收成单一 helper；scrollTop -> follow/reading 判定也要保持纯 helper，避免同一真相在多个 effect 里分叉
- `updateSessionViewport()` 这类 worker 入口必须对完全相同的 reading viewport 去重；若从 reading 切回 follow，要同步清掉已排队的 reading sync，不要让旧 request 在 follow 态晚到
- follow viewport state / bootstrap 这类 transport 决策若会被 `active switch`、`follow reset` 等多个入口复用，必须先收成单点 helper；不要让同一 follow 真相在两个分支各算一遍
- `connectSession` / reconnect 若重复的是 socket 握手、heartbeat、公共 message switch，就抽 transport helper；但 `connected` 后的状态推进、bucket 排队、副作用仍保留在各自分支，不要为了去重把两条链混成一条
- 若 connect / reconnect 在 `connected` 后共享的是同一份 baseline 推进（connected state、schedule-list、active bootstrap、watchdog、connectedCount），可以再抽一层公共 helper；但 bucket reset / pending input drain / retry 队列推进仍留在各自外层
- `finalizeFailure` 若共享的是完成位、cleanup、schedule error、manual-close 终止，也可以再抽一层 failure baseline；但 retry、bucket attempt、pending requeue 仍留在各自外层
- `TerminalView` 缩 effect 面时，若重复的是 viewport refresh 调度或当前 viewport emit，先抽本地 helper（如 `scheduleViewportRefresh` / `emitCurrentViewportState`）；先单点化动作，再决定是否减少 effect 数量
- 同理，reading viewport emit 若在 prepend 历史重锚和 near-edge reading 两处重复，也先抽本地 helper（如 `emitReadingViewportState`）；renderer 收口先做动作单点化，不急着硬合并 effect
- follow reset、prepend 历史锚定、near-edge reading emit 这类 viewport action 若还散在 effect 里，也继续抽本地 action helper（如 `resetViewportToFollow` / `anchorReadingViewportAfterPrepend` / `emitReadingViewportIfNearEdge`）；先把动作名字化，再看 effect 是否还能继续收
- 若 `becameActive` 与 `viewportResetNonce` 最终都只是在触发同一 follow reset 动作，可以继续并成一个 reset effect；但要保住 session 切换时 ref 初始化的语义，不要把 reset 信号提前吃掉
- 同理，若‘当前 viewport emit’与‘reading near-edge emit’只是同一阶段里的两次 emit，也可并成一个 effect；前提是 `emitViewportState` 的 dedupe key 仍能兜住重复发送
- tab strip / shell header 不要保留浏览器默认 focus ring；移动端若无键盘导航需求，容器与 tab 按钮默认 `tabIndex=-1 + blur + outline none`
- 拖拽排序类交互若在 `pointerMove` 更新 React state、`pointerUp` 立即提交，必须用 ref 同步保存最新 dragState；release 不能只读 state 闭包，否则会出现“拖了但顺序没生效”
- keyboard 关闭态不要在 quick bar / bottom overlay 外层保留空 `transform`（如 `translateY(0)`）；这会让内部 `position: fixed` 的悬浮球/面板改绑到容器坐标系，导致入口“消失”
- 快捷按键编辑器里，组合键默认名必须来自最终组合 preview，而不是第一个被点击的 modifier token；否则 `Ctrl + C` 会被错误保存成 `Ctrl`
- Android / Mac 若都要消费快捷按键组合规则，编码/反解/默认 label 必须下沉到 shared 纯函数；平台 UI 只保留 token 编辑与展示，禁止再复制一份组合算法
- Android WebView 若出现“sheet/表单看起来不能滚”，先不要凭截图猜高度；应先附着 `webview_devtools_remote_<pid>` 给目标滚动容器打 `touchstart/touchmove/scrollTop` probe，并用 `adb logcat` 验证 `defaultPrevented` 与 `scrollTop` 是否真实变化，再决定改事件捕获还是布局
- foreground 恢复不要无差别重连所有 session；默认先恢复 active session，其余只补非健康 session，避免 hidden tabs 被一起拉起放大带宽
- foreground reconnect 若对同 host 多 session 走串行 bucket，必须把 active session 排在第一位；reconnect 成功后要立刻补一条 tail refresh request，但 **hidden->active / foreground refresh 不要无脑 bootstrap 整个 tail**：本地尾窗连续时只发带本地 revision/window 的 follow request，只有尾窗缺口或空 buffer 才 bootstrap；同时补一发 `ping` 做短超时 watchdog，避免“切回 tab 还是旧画面却迟迟不重连”
- active + follow tab 不能只赌 tmux observer push；必须保留一个**低频 tail probe**（follow delta request + ping + 短 watchdog）作为漏通知自愈链路，否则会出现“终端实际在更新，但 UI 只有等本地输入/切换后才动”的假静止
- 若 daemon 代码已更新但 `~/.wterm/daemon-runtime/server.cjs` 仍残留旧符号（如 `stream-mode` / `scheduleMirrorFlush`）或 `/debug/runtime` 仍 404，先判定为 **staged runtime 未切新**；必要时本地执行 `prepare-global-daemon-release.sh`，覆盖 `~/.wterm/daemon-runtime/` 后只对 `com.zterm.android.zterm-daemon` 做单服务 `launchctl bootstrap/kickstart`，不要继续让客户端保留 legacy fallback
- `refreshSessionTail()` 若显式把 session sync state 切回 follow，UI renderer 也必须同步收到一个 follow-reset signal；只改 transport/store、不改 `TerminalView` 本地 `followMode/scrollTop`，就会出现“恢复后看到旧 buffer，输入一下才跳到最新”的假刷新
- Android renderer 新冻结：唯一状态是 `renderBottomIndex`；`renderTopIndex` 只能派生，reading/follow 都只改 bottom pointer，renderer 不得参与 buffer 生产或把 producer bottom 写回 source
- active tab 的 follow 三屏窗口允许存在 gap；`TerminalView` 不能因 visible/precheck window 不连续而冻结上一帧，必须先渲染最新 tail + gap marker；**follow 态禁止 prefetch/request 补洞**，只等 live tail 或显式切到 reading
- active 页的 gap repair 只针对 reading 态当前三屏窗口命中的缺口；不要从旧 stop point 连续追到最新，窗口外内容允许保持不连续以控制带宽
- reading 贴近缓存顶部时，3 屏只是 cache window，不是滚动上限；要先预取前两屏并显示 loading，再继续上滚，不能把顶部卡成固定三屏
- client 本地 cache window 必须围绕当前 reading viewport 动态移动；禁止 trim 时永远只保最新 tail，否则向前补到的历史会被立刻愚蠢扔掉
- terminal 主题切换的真源是“默认前景/背景 + ANSI 16 色 preset”，不是只换容器背景；主题 id 应持久化到 shared `BridgeSettings`，Settings 只做 preset 选择
- Android / Mac 若都要支持 terminal 主题，preset 与颜色算法必须下沉到 shared 纯模块，平台 TerminalView 只消费同一份 preset，避免 ANSI 映射再次分叉
- 若 Settings UI 把主题卡片标成“正在使用/Active”，点击卡片就必须立即写入真实持久化存储；不能只停留在本页 draft，否则用户切出去再回来会恢复默认主题，属于典型假状态
- 若当前 repo 是 fork runtime 真源，发布 npm 时必须直接发布 **本 fork 源码编译产物**；禁止通过 wrapper / alias / “套一层别人已发布包” 来冒充 fork 发布，这会破坏后续升级与维护链路

---

### 2.11 Session Picker 统一入口规则
- `New connection` 入口必须先进入 session picker：先列历史连接，再列当前 tmux sessions，最后才是 clean session / full form
- session picker 顶部必须支持手动输入 Tailscale IP / token，并在输入后立即尝试拉 tmux sessions
- tmux session 列表需要支持最小 CRUD（list/create/rename/kill）以及 multi-select 直接开多个 tabs
- terminal 顶部 `+` 的长按必须复用同一个 session picker，用于 quick new tab；普通点击再回 Connections

### 2.12 Bridge Auth 规则
- daemon / websocket bridge 必须支持共享 token 鉴权；server 真源优先为 `~/.wterm/config.json -> mobile.daemon.authToken`，`WTERM_MOBILE_AUTH_TOKEN` 只作为显式 override
- client 的 remembered server / host / picker target 都要携带 `authToken`，并在 websocket 连接阶段透传
- 验证时必须补一条“无 token 失败 / 正确 token 成功”的证据

### 2.13 跨尺寸布局统一规则
- phone / tablet / foldable / split-screen / future Mac 只允许共享**一套** layout profile 真源；禁止在 `ConnectionsPage` / `ConnectionPropertiesPage` / `TerminalPage` 各自散落 breakpoint
- 大屏效果优先通过 **单行多列 + 垂直分屏** 的 phone-sized pane 编排获得统一体验；不要先做 desktop-only 页面再回头兼容 mobile
- future Mac 复用 shared app-layer 的页面、会话、存储和 layout primitives；平台壳只补窗口 / 菜单 / 快捷键 / 原生输入差异
- 触发信号：一旦需求里出现 pad / foldable / split-screen / Mac / 多 pane / 多 active tab，就先回到 `0001-cross-platform-layout-profile.md` 冻结设计，再进入实现
- Jason 当前新增冻结：统一布局默认是一行多列，不以上下堆叠多 pane 作为主方案
- 桌面 packaged/dev 验证若需要重开 `ZTerm.app`，必须先退出旧实例，再打开新实例；不要直接 `open -n` 叠多个 app 进程污染证据
- 若参考 Tabby 一类桌面终端，借用的是紧凑 chrome / 顶部状态 tab strip / 左侧 profile rail / 右侧 inspector 的壳层组织；tab strip 至少要承载真实 target / inspector 状态，不能只是静态装饰
- 若桌面端继续推进多 tab，当前最小真边界应优先写成 `single runtime · multi tabs`：可以维护多个 open target tab，但同一时刻只允许一个 live websocket/runtime；不要把“可切换 tabs”误报成“并发多 live sessions”
- Jason 新冻结：桌面右侧不要先做抽屉；应收成“固定左 rail + 右侧按比例切 multiple vertical panes”的 split workspace，优先给 `1 / 2 / 3` preset，风格靠近 iTerm2/Tabby，但不要上来做自由拖拽

## 三、开发闭环流程

### 3.1 流程图

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│ 1.规划  │───▶│ 2.开发  │───▶│ 3.测试  │───▶│ 4.提交  │───▶│ 5.沉淀  │
└─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘
     │              │              │              │              │
     ▼              ▼              ▼              ▼              ▼
 更新task/CACHE 读skill        运行验证       Git commit    更新skill
 定义成功       最小切片       证据记录       检查清单      经验沉淀
```

### 3.2 Phase 1: 规划阶段

**目标**: 明确任务范围、定义成功标准、冻结边界

#### 规划输出模板

每次任务开始前，必须先更新 `android/task.md` 和 `android/CACHE.md`：

```markdown
## Task-XXX
- 目标：
- 成功标准：
- 验证入口：
- 范围：
- 不在范围：
- 风险：
- 证据输出位置：
```

#### 进入开发前的冻结检查

| 检查项 | 必须确认 |
|--------|---------|
| 成功标准是否可验证？ | ✅ |
| 验证入口是否明确？ | ✅ |
| 是否有唯一真源？ | ✅ |
| 是否只改本轮切片？ | ✅ |

### 3.3 Phase 2: 开发阶段

**目标**: 最小切片实现，每步可验证

#### 开发顺序（Foundation Modules）

```
1. Config Module        → Host/Session 类型定义、存储方式
2. Provider/Adapter     → WebSocket 消息协议
3. Minimal Debug Entry  → 最小 UI 可见
4. Observability        → 状态变更 event
5. Testing/Harness      → 验证入口
6. Build/Install        → Capacitor 配置
```

#### 最小切片规则

```
最小切片 = 1个文件 + 1个功能 + 1次验证

示例：
- 切片1: 创建 src/lib/types.ts → 定义 Host 类型 → tsc 编译通过
- 切片2: 创建 src/hooks/useHostStorage.ts → localStorage 存取 → 浏览器验证
- 切片3: 创建 src/components/HostList.tsx → 显示主机列表 → 浏览器查看
```

#### 禁止事项

| 禁止 | 原因 |
|------|------|
| 一次改多个文件 | 违反最小切片原则 |
| 添加未请求的功能 | 违反 Simplicity First |
| 重构未要求的代码 | 违反 Surgical Changes |
| 修改 @wterm 核心包 | 项目约束 |

### 3.4 Phase 3: 测试阶段

**目标**: 四层验证，证据记录

#### 四层验证框架

| 层级 | 验证内容 | 验证方式 |
|------|---------|---------|
| **L1: Unit** | 纯函数、类型、状态机 | `tsc --noEmit` + vitest |
| **L2: Function** | 模块主路径功能 | 浏览器手动验证 |
| **L3: Orchestration** | 跨模块推进、多 Tab | 多场景手动验证 |
| **L4: Runtime** | Android 运行态 | 模拟器/真机验证 |

#### 远程 runtime 调试闭环（必须记住）

当出现下面这类问题时，优先走 daemon 远程调试接口，而不是只靠猜：

- active tab 假活 / 不主动刷新 / 只有输入后才刷新
- 底部缺行 / prompt 漂移 / 键盘弹出后才正常
- reconnect 看起来 connected，但 buffer 不推进
- 想确认当前 client session / mirror / lastBufferSyncRequest 到底是什么

**唯一真源入口：**

- `GET /debug/runtime`
  - 返回 daemon health + clientSessions + mirrors + clientDebug summary
- `GET /debug/runtime/logs`
  - 返回最近 client runtime debug entries，可按 `sessionId / tmuxSessionName / scope` 过滤
- `GET /debug/runtime/control?enabled=1`
  - 远程打开 client runtime debug

**鉴权规则：**

- 统一复用 daemon auth token
- query 参数：`?token=<auth>`
- 或 HTTP header：`Authorization: Bearer <auth>`

**优先用脚本，不手搓 curl：**

```bash
cd android
pnpm daemon:runtime:remote snapshot --host 100.x.x.x --port 3333 --token <auth>
pnpm daemon:runtime:remote logs --host 100.x.x.x --port 3333 --token <auth> --limit 200
pnpm daemon:runtime:remote enable --host 100.x.x.x --port 3333 --token <auth> --reason ime-refresh-debug
pnpm daemon:runtime:remote logs --host 100.x.x.x --port 3333 --token <auth> --sessionId <session-id> --scope follow
```

**现场排障最小顺序：**

1. 先 `snapshot`
   - 看 `clientSessions[].state/streamMode/lastBufferSyncRequest`
   - 看 `mirrors[].revision/bufferStartIndex/bufferEndIndex/lastFlushCompletedAt`
2. 若日志不够，再 `enable`
3. 在手机上复现一次
4. 立刻 `logs`
5. 只根据 snapshot + logs 下结论，不靠主观猜

**针对当前两类高频问题的看法：**

- “输入一下就恢复”  
  先看：
  - active session 是否真的处于 `streamMode=active`
  - `lastBufferSyncRequest.mode` 是否仍在 `follow`
  - mirror revision 是否在涨、但 client logs 没 follow sync

- “键盘弹出就正常，不弹就不正常”  
  先看：
  - layout/viewport 相关日志是否只在 keyboard change 后出现
  - follow viewport sync 是否漏了无键盘场景
  - snapshot 里的 last request rows / viewportEndIndex 是否与当前真实底部一致

#### 验证入口定义

```bash
# L1: Unit 验证
pnpm --filter @wterm/mobile type-check
pnpm --filter @wterm/mobile test  # vitest 单元测试（如脚本存在）

# L2: Function 验证（本地开发）
pnpm --filter @wterm/mobile dev
# 结构验证：浏览器访问 portless 输出的 *.localhost 地址
# 真连通验证：pnpm --filter @wterm/mobile preview -- --host 127.0.0.1 --port 4173
# 手动操作：添加主机 → 连接 bridge → 验证终端显示

# L3: Orchestration 验证
# 多 Tab 操作：新建 Tab1 → 新建 Tab2 → 切换 → 关闭

# L4: Runtime Smoke（Android）
pnpm --filter @wterm/mobile build
npx cap sync android     # 同步到 Android
npx cap run android      # 启动模拟器/真机
```

#### 证据记录模板

每次验证后在 `android/evidence/<date-task>/` 保存：

- 截图
- 命令输出
- APK 路径
- 必要时 logcat / console

#### 完成证据最低标准

- 截图
- 命令输出
- APK 路径
- 必要时 logcat

### 3.5 Phase 4: 提交阶段

**目标**: 清晰的 commit，检查清单

#### Git Commit 规范

```bash
# Commit message 格式
<type>: <subject>

<body>

# type 范围
feat:     新功能
fix:      修复
refactor: 重构（仅限请求的重构）
docs:     文档更新
test:     测试添加/修改
chore:    配置/构建变更

# 示例
feat: 添加 HostList 组件和 useHostStorage hook

- 创建 src/lib/types.ts 定义 Host 类型
- 创建 src/hooks/useHostStorage.ts 实现本地存储
- 创建 src/components/HostList.tsx 显示主机列表

验证: pnpm --filter @wterm/mobile dev → 浏览器访问 → 添加主机成功
```

#### 提交前检查清单

| 检查项 | 命令 |
|--------|------|
| 类型检查通过 | `pnpm --filter @wterm/mobile type-check` |
| 无未使用代码 | 手动检查 |
| task.md 已更新 | `git diff android/task.md` |
| CACHE/MEMORY 是否需要更新 | 检查是否有新约束 |
| SKILL.md 是否需要更新 | 检查是否有新门禁 |

### 3.6 Phase 5: 经验沉淀

**目标**: 新约束/经验写入 Skill

#### Skill 更新时机

| 触发条件 | 更新内容 |
|---------|---------|
| 发现新的项目约束 | 写入 "禁止事项" |
| 发现新的验证入口 | 写入 "验证入口" |
| 发现反模式/坑 | 写入 "常见问题" |
| 发现可复用模式 | 写入 "最佳实践" |

### 3.7 回归验证（下次启动）

每次开发前执行：

```bash
# 1. 检查上次提交状态
git log --oneline -5

# 2. 运行基础验证
pnpm --filter @wterm/mobile type-check

# 3. 本地启动验证
pnpm --filter @wterm/mobile dev

# 4. 如有 Android 项目
cd examples/mobile && npx cap run android --livereload
```

---

## 四、完整功能规格

### 4.1 主机管理

| 字段 | 说明 |
|------|------|
| id | UUID |
| name | 显示名称 |
| bridgeHost | IP 或 Tailscale 域名 |
| bridgePort | bridge 端口（默认由统一配置决定，当前 3333） |
| sessionName | tmux session 名 |
| authType | password / key |
| password/privateKey | 凭据（暂不加密） |
| tags | 分组标签（数组） |
| pinned | 是否置顶首页 |
| lastConnected | 最后连接时间戳 |
| autoCommand | 连接后自动执行的命令 |

- **分组/标签**: 支持（如"工作服务器"、"个人服务器"）
- **搜索/过滤**: 不需要
- **备注/描述**: 不需要

### 4.2 虚拟键盘工具栏

| 功能 | 说明 |
|------|------|
| 位置 | 底部，手机键盘上方 |
| 基础按键 | Ctrl, Alt, Tab, ESC, 方向键 |
| 扩展按键 | F1-F12（电脑键盘模式全显示） |
| 自定义组合键 | 支持（如 Ctrl+C, Ctrl+D），可增删 |
| 预设模板 | 默认提供 Ctrl+C/D/Z |
| 拖拽排序 | 支持 |
| 存储 | 用户配置文件 + WebDAV 导入导出 |

### 4.3 应用启动行为

| 功能 | 说明 |
|------|------|
| 自动连接 | 启动时自动连接上次活跃 Session |
| Tab 状态恢复 | 保存上次关闭时的 Tab 状态 |
| 快速重连 | 一键连接最近 3 个主机 |
| 自动命令 | 主机级别默认 + 连接时可临时覆盖 |
| 命令历史 | 每个 Tab 保存 host+autoCommand，WebDAV 同步 |

### 4.4 Tab 栏设计

| 功能 | 说明 |
|------|------|
| 位置 | 顶部 |
| 显示内容 | 动态标题（来自 tmux / shell 标题），可手动重命名 |
| 重命名持久化 | 支持 |
| 最大 Tab 数 | 10 |

### 4.5 后台保活

| 功能 | 说明 |
|------|------|
| 通知栏 | 显示每个 Tab 连接状态 |
| 自动重连 | 网络恢复后自动重连 |
| 重连次数 | 可配置，默认 3 次 |
| 心跳间隔 | 30 秒 |

### 4.6 Session 历史

| 功能 | 说明 |
|------|------|
| Tab 状态保存 | 上次关闭时的 Tab 配置 |
| Session 快照 | 保存完整终端输出历史 |

### 4.7 网络状态提示

| 功能 | 说明 |
|------|------|
| 断开提示 | Toast 提示网络断开 |
| 错误详情 | 显示具体错误（认证失败、超时、网络不可达） |

### 4.8 Android 特有功能

| 功能 | 说明 |
|------|------|
| 横屏模式 | 支持，终端尺寸自动调整 |
| 外接键盘 | 支持 USB/蓝牙键盘 |
| 分享功能 | 分享终端输出/命令 |

### 4.9 数据同步

| 功能 | 说明 |
|------|------|
| 配置导入导出 | WebDAV 支持 |
| 快捷键配置 | WebDAV 同步 |
| 命令历史 | WebDAV 同步 |

---

## 五、WebSocket 消息协议

### 客户端 → 服务端

```typescript
type ClientMessage =
  | { type: 'connect', payload: HostConfig }
  | { type: 'input', payload: string }
  | { type: 'resize', payload: { cols: number, rows: number } }
  | { type: 'ping' }
  | { type: 'close' }
```

### 服务端 → 客户端

```typescript
type ServerMessage =
  | { type: 'connected', payload: { sessionId: string } }
  | { type: 'data', payload: string }
  | { type: 'error', payload: { message: string } }
  | { type: 'title', payload: string }
  | { type: 'closed', payload: { reason: string } }
  | { type: 'pong' }
```

---

## 六、状态机定义

```
idle → connecting → connected → closed
            ↓           ↓
          error      reconnecting → connected
```

```typescript
interface Host {
  id: string;
  name: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  authType: 'password' | 'key';
  password?: string;
  privateKey?: string;
  tags: string[];
  pinned: boolean;
  lastConnected?: number;
  autoCommand?: string;
}

interface Session {
  id: string;
  hostId: string;
  connectionName: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  title: string;
  ws: WebSocket | null;
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'closed';
  hasUnread: boolean;
  customName?: string;  // 用户重命名的名称
}
```

---

## 七、文件夹结构

```
android/
├── docs/                       # spec / architecture / workflow
├── evidence/                   # 截图 / 日志 / APK / 真机证据
├── task.md                     # 当前任务板
├── CACHE.md                    # 短期上下文
├── MEMORY.md                   # 长期经验
├── android/                    # npx cap add android 生成
├── src/
│   ├── components/
│   │   ├── TerminalTabs.tsx    # 顶部 Tab 栏
│   │   ├── TerminalView.tsx    # 单个终端视图
│   │   ├── HostList.tsx        # 主机列表页
│   │   ├── HostForm.tsx        # 添加/编辑主机表单
│   │   ├── QuickActions.tsx    # 快捷键工具栏
│   │   └── ConnectionBar.tsx   # 连接状态栏
│   ├── hooks/
│   │   ├── useSession...       # session / bridge 状态管理
│   │   ├── useHostStorage.ts   # 主机配置存储
│   │   ├── useKeepAlive.ts     # 后台保活
│   │   └── useQuickActions.ts  # 快捷键管理
│   ├── contexts/
│   │   └── SessionContext.tsx  # 多会话状态管理
│   ├── lib/
│   │   ├── types.ts            # Host, Session 类型
│   │   ├── websocket.ts        # WebSocket 协议
│   │   ├── storage.ts          # localStorage 封装
│   │   └── webdav.ts           # WebDAV 同步
│   ├── server/
│   │   └── server.ts           # WebSocket → tmux 桥接
│   ├── App.tsx
│   └── main.tsx
├── capacitor.config.ts
├── package.json
└── note.md                      # 历史记录（非主真源）
```

---

## 八、复用代码来源

| 需求 | 来源 | 复用方式 |
|------|------|---------|
| WebSocket tmux 桥接 | `android/src/server/server.ts` | 当前真源 |
| PTY 本地连接 | `examples/local/server.ts` | 参考 resize 协议 |
| 终端渲染 | `@jsonstudio/wtermmod-react` | npm install |
| WebSocket Transport | `@jsonstudio/wtermmod-core` | npm install |

---

## 九、常见问题（按需更新）

### 问题: WebSocket 连接超时
- **触发信号**: 网络不稳定或 Tailscale 未连接
- **解决方案**: 检查 Tailscale 状态，重连逻辑自动触发
- **边界条件**: 最多重试 3 次（可配置）

### 问题: Android APK 能打开但连不上本地 tmux bridge
- **触发信号**: terminal 一直停在 idle / connecting，bridge 是 `ws://`，Capacitor WebView 运行在 `https`
- **真源**: `androidScheme=https` 会把移动端带到 secure context，`ws://` bridge 会被 mixed-content / cleartext 规则卡住
- **解决方案**: `capacitor.config.ts` 使用 `androidScheme=http`，AndroidManifest 打开 `usesCleartextTraffic=true`
- **验证**: HTTP 入口或 APK 中连接成功后，header 进入 `Connected`，bridge 日志出现 session create/close

### 问题: Android 输入法弹出后又消失 / 键盘按钮无效
- **触发信号**: 点快捷栏键盘按钮无反应，或 logcat 出现 `ImeTracker ... onCancelled`
- **真源**: WebView 内 DOM textarea 与原生 `EditText` anchor 在抢 input focus；只调用 `showSoftInput()` 不够
- **解决方案**: Android 上 terminal 不再主动 focus DOM textarea；键盘按钮只走原生 `ImeAnchor`；必要时先 clear WebView focus，再由原生 `EditText` 请求焦点并 `showSoftInput`
- **验证**: logcat 中 `ImeAnchor show()/showSoftInput()` 命中，点击键盘按钮后系统 IME 实际弹出且中文输入可提交到 tmux

### 问题: Android 悬浮快捷输入里语音转文字失效 / ImeAnchor 抢走输入
- **触发信号**: terminal 中文输入恢复了，但打开悬浮 quick input / editor 后，语音转文字不再落到 textarea，反而把 terminal 或 header 焦点搞乱
- **真源**: 把 Android 全部输入都切到 `ImeAnchor` 以后，没有给 quick input/editor 这类 DOM textarea 留独立输入通道；terminal IME 与 quick input DOM focus 没有分层
- **解决方案**: terminal live input 继续走 `ImeAnchor`；quick input / editor / 浮层 textarea 获得 DOM focus 时，立即 suspend terminal IME、停止把 anchor 输入路由回 session；浮层展开时同时隐藏底部 shell quick rows，避免双入口叠加
- **验证**: quick input textarea 可正常语音转文字；此时 terminal 不再收到 anchor 输入；关闭/失焦后 terminal 再恢复自己的输入链

### 问题: Android terminal 语音输入按钮弹得出但不上 shell
- **触发信号**: 键盘已弹出、麦克风能开始录，但结果不提交到 shell，尤其是拼音/语音这种 composition 完成链
- **真源**: `ImeAnchor` 不能把输入字段伪装成 password/no-suggestions 真空场；否则语音/组合输入完成链可能只走 composing/finish，不走普通 `commitText`
- **解决方案**: `ImeAnchor` 输入类型保持普通 text multiline，不再用 password/no-suggestions 组合硬压；同时在 `InputConnection` 补 `finishComposingText` 收口，确保最终文本会 emit 到 terminal
- **验证**: 中文拼音提交、语音转文字提交都能直接落到 shell，不依赖 DOM terminal textarea

### 模式: Android 前后台恢复不要只信 WebView lifecycle
- **适用场景**: 回到前台后 UI 还显示 connected，但实际上 websocket 已假活、不再刷新
- **动作**: 前端同时监听 `visibilitychange/resume/focus` 与 Capacitor `App.appStateChange`；进入前台时强制 sweep `reconnectAllSessions()`，不要只等 heartbeat 自己超时

### 问题: 手机上下滑导致整页 reload / 回弹
- **触发信号**: 竖向滑动 shell 时，整个页面像被重新加载或出现 WebView 级下拉回弹
- **真源**: body/root 仍可滚动，或 Capacitor WebView 自身 overscroll 未关
- **解决方案**: `html/body/#root` 固定为 `overflow:hidden + overscroll-behavior:none`，只让 terminal buffer 容器滚动；`MainActivity` 再把 WebView 设为 `OVER_SCROLL_NEVER`
- **验证**: 竖向滑动只滚 terminal buffer，不触发整页回弹/重载

### 问题: 快捷输入面板点外面关不掉 / 键盘弹出后面板被抬太高
- **触发信号**: 悬浮球打开的 quick input 面板无法靠点击空白区关闭，或输入法弹出后面板主体被抬到屏幕外
- **真源**: quick bar 根节点会拦 pointer；同时 quick overlay 若挂在已 `transform` 抬起的 quick bar 容器下，再按 `keyboardInset` 计算 `bottom/padding` 会发生双重位移
- **解决方案**: outside-close 走 document capture 级监听；quick input / editor / floating panel 这类 fixed overlay 不再二次叠加 `keyboardInset`
- **验证**: 点击面板外空白区应立即关闭；弹出输入法后面板主输入区和按钮区仍保持可见

### 问题: Android bottom sheet 在输入法弹出后“看起来滑了但完全滚不动”
- **触发信号**: 快捷输入设置 / 快捷键设置页触摸事件能收到，但 `scrollTop` 始终不变，尤其是真机 WebView + DOM input 聚焦后
- **真源**: sheet 还在按 `100dvh` 定高，键盘把 `visualViewport` 压小后容器仍认为自己没有 overflow，最终出现 `scrollHeight == clientHeight`
- **解决方案**: 先用 WebView devtools probe 证明不是 `preventDefault`；随后用 `visualViewport.height + offsetTop` 计算可见底，用 `layoutHeight - visibleBottom` 作为 bottom inset 抬升 sheet，不能只改 scroll 容器
- **验证**: 键盘弹出后 editor sheet 高度应小于 layout viewport，且 `scrollHeight > clientHeight`，真机 swipe 后 `scrollTop` 能增长

### 问题: 快捷键列表切到“添加快捷键”后内容从中段开始 / 看起来越界
- **触发信号**: 列表页先滚过，再点 `+ 添加组合键` 或编辑项进入 form，首屏不是从顶部开始，顶部内容像被吞掉；同时悬浮球可能压在表单右侧
- **真源**: list / form 复用同一个 `shortcut-editor-scroll`，mode 切换时继承了旧 `scrollTop`；此外 full-screen editor 打开时 floating bubble 没隐藏
- **解决方案**: `shortcutEditorMode / shortcutEditorOpen / editingShortcutId` 变化时，通过 ref + rAF 把滚动容器重置到 `scrollTop=0`；editor 打开期间隐藏 floating bubble
- **验证**: 人工先把列表滚出非零位置，再进 form；form 首屏应从顶部字段开始，`scrollTop=0`，且不再看到悬浮球覆盖

---

## 十、最佳实践（按需更新）

### 模式: 最小切片开发
- **适用场景**: 所有功能开发
- **示例**: 先 types.ts → 再 useHostStorage.ts → 再 HostList.tsx

### 模式: cat -v 输入真相验证
- **适用场景**: 终端快捷键、特殊字符、自定义组合键验证
- **动作**: autoCommand 进入 `cat -v`，然后点击方向键 / Esc / 自定义快捷键
- **验收**: 终端必须直接显示 `^[[A`、`^[`、`^A` 或自定义文本，证明字节序列真实进入 tmux

### 模式: Tab 跟手切换分层
- **适用场景**: 多 tab 终端左右滑动切换
- **动作**: `TerminalView` 只做 axis lock 与横向手势 delta 上报；`TerminalCanvas` 统一负责相邻 tab 预览、跟手位移、半屏阈值、回弹/完成动画与最终切 tab
- **反模式**: 在单个 terminal view 内直接切 tab，会把手势判定、scroll 锚点和切换时序耦死，容易回归“瞬切/错位/滚动锚点跳变”

### 模式: viewport refresh 调度只依赖动作，不依赖 followMode
- **适用场景**: 收敛 `TerminalView` 的 layout refresh / session refresh / follow audit
- **动作**: 先把 `syncViewport + 可选 follow 对齐` 收成单一 `runViewportRefresh()` 动作；scheduler/effect 只调这个动作，是否 follow 在执行时通过当前 latch/ref 判断
- **反模式**: 让 `scheduleViewportRefresh()` 直接依赖 `followMode`，会导致 reading/follow 切换时把无关 refresh effect 全部重新建一遍

### 模式: ResizeObserver 不走第二套 refresh 口径
- **适用场景**: terminal 容器真实尺寸变化、横竖屏/分屏/键盘相关布局变化
- **动作**: `ResizeObserver` 回调直接复用统一的 `runViewportRefresh()`，不要单独调用 `syncViewport()`
- **反模式**: layout/session/audit 走统一 refresh 动作，但真实 resize 另走 `syncViewport()`；这样 follow 对齐逻辑会再次分叉

### 模式: refresh effect 能并时并成 trigger effect
- **适用场景**: `TerminalView` 里多个 effect 最终都只是在“判定某个 trigger 是否值得 schedule refresh”
- **动作**: 保留显式 trigger 判定（如 `becameActive / sessionChanged / layoutChanged`），把 refresh 调度并到单一 effect；timeout 差异继续按 trigger 决定
- **反模式**: 为了少一个 effect 直接抹平触发来源，或把 layout/session 时序差异删掉

### 模式: 状态 effect 先动作名字化，不硬并
- **适用场景**: `TerminalView` 剩下的 effect 已经承载 reading 锚定、viewport signal 这类真实状态语义
- **动作**: 先把 effect 内动作抽成具名 helper（如 `reconcileViewportAfterBufferShift()`、`emitViewportSignalsForCurrentFrame()`），再让 effect 只做 trigger/state bridge
- **反模式**: 只为了压 effect 数量，把 prepend 锚定、viewport signal 这种状态语义强行并进别的 refresh effect

### 模式: renderer/page/context 共享接口类型下沉到 lib/types
- **适用场景**: `TerminalView`、`TerminalPage`、`SessionContext`、相关测试都在重复声明 viewport/resize callback 的 shape
- **动作**: 把共享 schema 与 handler 签名下沉到 `android/src/lib/types.ts`，其余层只 import 使用
- **反模式**: 到处内联 `{ mode, viewportEndIndex, viewportRows }` 或 `(sessionId, cols, rows)`，后续改字段时四处漂移

### 模式: renderer prop 面按“真实输入”裁剪
- **适用场景**: 审计 `TerminalView` 之类 renderer component 的 props
- **动作**: 区分哪些 prop 真正参与渲染/输入/状态机，哪些只是历史 dependency 残留；后者直接移除
- **反模式**: prop 只剩 effect dependency 占位，却继续从 page/context/test 一路透传

### 模式: renderer trigger 用语义名，不泄漏 worker 内部命名
- **适用场景**: `SessionContext` / worker 内部状态名带实现细节，但 renderer 只关心触发语义
- **动作**: 在 renderer API 层改成语义名（如 `followResetToken`），由 page/context 做一次最小映射
- **反模式**: 把 `viewportResetNonce` 这种 worker 侧命名直接透传到 renderer prop，污染 consumer 心智

### 模式: 小传播面的旧命名直接全链统一
- **适用场景**: 旧字段名在 worker/store/page/renderer 之间只有少量闭合传播点
- **动作**: 如果已确认是单条主链，就不要长期保留映射层；直接全链统一成语义名
- **反模式**: 明知传播面很小，还让 page 层长期做“旧名 -> 新名”翻译

### 模式: request payload builder 只留一个真源
- **适用场景**: `SessionContext` 里普通 request 与 bootstrap request 只有少量字段差异
- **动作**: 把共同部分收成单一 builder，用显式 options 覆盖差异（如 `forceBootstrap`、`modeOverride`）
- **反模式**: 长期维护两份几乎一样的 payload builder，后续改字段容易一边改了另一边漏掉

### 模式: viewport demand 入口只保留“写状态 + 触发”
- **适用场景**: `updateSessionViewport()` 一类 worker 入口逐渐长出 normalize / 判等 / request scheduling 多重职责
- **动作**: 拆成 normalize helper、equal helper、active-demand helper；入口函数只负责更新 view state 并触发 demand
- **反模式**: 让入口函数长期同时处理数据归一化、去重、请求时序，后续 reading/follow 分叉会继续长回去

### 模式: active 输入后不做本地回显，但必须立刻挂 tail refresh demand
- **适用场景**: shell 输入后用户抱怨“没刷新”，但协议仍要求 server canonical buffer 是唯一真源
- **动作**: `sendInput()` 只发送 input，不本地改 buffer；同时给 active session 标记 `input-tail-refresh` demand，由 client 本地 30fps head cadence 在 `minTailRefreshGapMs` 门限下主动发 follow `buffer-sync-request + ping`
- **反模式**: 1) 为了“更快”做本地假回显 2) 完全被动等下一次 server head 才刷新 3) 每个输入字符都直接打一条 range request，退化成请求风暴

### 模式: head 检查频率固定，真正拉取频率按网络分级
- **适用场景**: 用户要求“本地 30fps 刷新 head”，同时又要控制带宽/请求频率
- **动作**: active session 本地固定 `33ms` tick 只做 head freshness / demand 判定；真正的 tail range 拉取由 `resolveTerminalRefreshCadence()` 根据 `navigator.connection` / `saveData` 决定 `minTailRefreshGapMs` 与 reading delay
- **反模式**: 把“30fps 检查”误做成“30fps 必拉 range”，会直接把带宽和抖动重新打爆

### 模式: 移动端发热先看 CPU/IO 真源
- **触发信号**: 手机明显发热，但网络流量不大
- **动作**: 先抓 `adb shell dumpsys cpuinfo`、`top -H -p <pid>`、`dumpsys gfxinfo`；重点看 `Chrome_IOThread` / `RenderThread` / `Slow issue draw commands`
- **高频真源**: 1) server 端空刷 viewport（例如把 `cursor.visible` 当变化条件导致每 96ms 发包） 2) client 端每帧 `localStorage.setItem(JSON.stringify(buffer/snapshot))` 3) 全量 scrollback DOM + 常驻 blur

### 模式: Electron 桌面壳验证分层
- **适用场景**: future Mac / Win 壳移植 Android app-layer 流程
- **动作**: `.app` 只验证 build/package/window/stage 可执行；表单交互与回显优先走浏览器 dev server（同一 renderer 代码）做细粒度验证，再回到桌面壳做 smoke

### 模式: tmux discovery 不等于 live connect
- **触发信号**: UI 能列出 tmux sessions，但用户仍反馈“无法连接”
- **动作**: 检查客户端是否真的走了 Android 同构协议：`ws open -> send connect(payload) -> send stream-mode(active)`；仅有 `list-sessions` 只能证明 bridge 可达，不能证明 session 已 attach

### 模式: 悬浮球拖动与点击分离
- **适用场景**: terminal 悬浮球 / 浮动入口既要支持点按开关，又要支持拖动 reposition
- **动作**: 用 `pointer/touch move threshold` 区分 click 和 drag；超过阈值后进入拖动态并 suppress click，位置持久化到 localStorage
- **反模式**: 只靠长按进入拖动，或拖动完成后未 suppress click，都会导致“拖不动”或“拖完又误开菜单”

---

Inspired by coding-principals skill.

---

### 问题: pnpm install 速度极慢或卡住
- **触发信号**: 下载进度长期停滞（如 next@33MB 只下载 1MB），resolved 卡在 55 左右
- **真源**: npm registry 官方源在中国网络下速度极慢（~5KB/s）
- **解决方案**: 
  1. 切换到 npmmirror: `pnpm config set registry https://registry.npmmirror.com`
  2. 重新执行: `pkill -9 -f pnpm; pnpm install --no-frozen-lockfile`
- **验证**: 切换后 resolved 应快速达到 1400+，packages 应显示 +1293
- **恢复**: 安装完成后可恢复官方源: `pnpm config set registry https://registry.npmjs.org`

---

## 原型页面经验（2026-04-18）

### 交互设计要点
- 顶部说明文字不是按钮，只显示当前状态
- 快捷栏按钮实现真实交互（点击切换状态）
- 快捷键编辑界面使用全屏覆盖（z-index: 200）
- 终端高度自适应：根据键盘状态动态计算
  - 快捷键盘展开：180px
  - 系统键盘显示：280px
  - 无键盘：320px

### 最佳实践
- 使用 CSS transition 实现平滑高度变化
- Session 切换面板使用 position: absolute + z-index: 100
- 编辑界面使用 position: fixed 全屏覆盖
