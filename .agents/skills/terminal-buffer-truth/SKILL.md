---
name: terminal-buffer-truth
description: "terminal buffer / render / daemon mirror 真源与门禁"
---

# terminal-buffer-truth

## Performance repair boundary

- `resource.renderer_window` may hand an explicitly immutable projected snapshot to `resource.client_sparse_buffer`'s render-store projection edge only after renderer-side equality/reuse checks complete. This removes duplicate full-window comparison/copy work; it does not change wire payload, buffer truth, visible-range ownership, or daemon behavior.
- Performance trace storage is a bounded debug side channel. Eviction must remain metadata-only and O(1) per record; trace optimization must never trim terminal business payload or alter runtime truth.

## 适用场景
- terminal buffer / render / scroll / input 延迟问题
- 出现“初次连接慢、输入不刷新、reading 拉不动、回到底部不 follow、带宽异常”
- 任何想在 server / buffer manager / renderer 之间加补丁、fallback、第二语义的时候

## 开发前置门禁：先架构，后代码

任何 terminal / session / daemon / buffer / renderer 相关开发、修复、重构，必须先完成架构映射，再读代码和修改代码。

固定顺序：
1. 先读 `android/docs/architecture.md`
2. 再读 `android/docs/audits/2026-07-02-architecture-boundary-remediation.md`
3. 再读 `android/docs/resource-registry.json` 与 `android/docs/resource-map.md`，确认 source/target resource、直接/间接关系、`via_resources`、禁止直连关系
4. 再读本 skill 与相关 decision / feature registry / function map / mainline call map
5. 再读代码定位 owner 与实现点
6. 写出本次方法如何对应架构后，才允许修改代码

修改前必须明确：
- 本次问题属于哪个功能块：session lifecycle / daemon truth / client buffer-render / UI projection / persistence truth
- 本次问题涉及哪些 resource id，关系是 direct / via / observer / binding pending 哪一类
- 唯一 owner 文件或模块是谁
- 当前越界处理方式是 **物理移除 / 分离下沉 / 显式兼容保留** 哪一种
- 哪些路径允许修改，哪些路径禁止修改
- 正向测试和反向测试分别锁住什么风险
- 若涉及 daemon / tmux / mirror / transport 主链，且本机可启动真实 daemon 与 tmux，必须跑真实闭环验证；只跑单测、typecheck、静态 gate 不得宣称完成。默认命令：`pnpm --dir android run daemon:mirror:close-loop`。
- 若仓库内 Mac client 可用，还必须跑 Mac 客户端核心连接 gate，证明本地 client transport/runtime 能连；daemon-only probe 不能替代。默认最小命令：`pnpm --dir mac test -- --reporter dot` 与 `pnpm --dir mac run type-check`，其中必须覆盖 `bridge-transport`、`local-tmux-transport`、`terminal-runtime`、workbench active target。

禁止事项：
- 禁止先 grep 到命中点就直接 patch
- 禁止在未声明的 resource relation 上实现 shortcut；缺资源关系先补 registry/map/gate
- 禁止在非 owner 层补偿 owner 层问题
- 禁止用 fallback / 默认值 / catch 后继续成功 来掩盖真源缺失
- 禁止 UI / App / daemon 任一层替其它层维护第二份状态机

## Mux 控制线与业务线

- 物理 transport 完成 `mux-hello` 后，wire 上只允许 `TerminalMuxServerFrame` / `TerminalMuxClientFrame`。
- target 控制事实（例如 `sessions`、`session-activity`、target error/pong）只走 `mux-target-message`；session terminal 业务只走 `mux-channel-message` / `mux-channel-binary`。
- 已协商 mux 的物理 transport 禁止裸发 `BridgeServerMessage`。唯一物理 sender contract 必须使用 shared protocol 的 wire-frame union，禁止 `as unknown as` 绕过类型锁。
- mux channel open 必须原子。控制事实 publish 失败时，`terminal-mux-channel-runtime.ts` 必须删除 channel registry、关闭 subscriber、投影显式 `mux-channel-closed` error，并停止 attach。
- 正向 gate：legacy/pre-mux 允许 raw control；mux transport 必须 target envelope；list/open/heartbeat 均通过 `isTerminalMuxServerFrame`。
- 反向 gate：mux transport 不得出现 raw `session-activity` 或错误的 `mux-channel-message`；publish throw 后不得留下 channel、subscriber transport 或继续 attach。

## 冻结角色边界

```text
tmux truth
  -> daemon server
  -> client buffer manager
  -> client sparse buffer
  -> renderer window
  -> DOM renderer
  -> terminal shell
  -> UI shell
```

四层只允许单向依赖，禁止越层漂移。

### 物理 owner 分层

- `client.renderer_window` 只拥有 follow / reading / renderBottomIndex / visible range / immutable render snapshot / next-RAF commit。
- `client.dom_renderer` 拥有 `TerminalView` / `VisibleRow` / `TerminalPreviewRow` / mirror-fixed zoom-pan / shared cell render / terminal theme 的 DOM 投影，禁止请求 transport、修改 sparse truth 或自己决定 follow/reading/renderBottomIndex。
- `client.terminal_shell` 拥有 stage shell、shell skin、status、quickbar assembly、copy menu、keyboard lift，只能消费 renderer/DOM projection 并发出 shell intent。
- 禁止 `client.renderer_window` 直接承担 DOM 投影，也禁止 `client.terminal_shell` 持有 sparse/render 真源。

## 测试闭环阶梯：证明范围必须逐层匹配

terminal / daemon / client / renderer 相关任务完成前，先写清本轮影响到哪一层，再跑到对应层级。低层验证不能冒充高层完成。

### L0 静态与架构 gate
- 证明：类型、文档 map、owner/gate、禁止路径扫描没有明显破坏。
- 不证明：真实 daemon、真实 tmux、真实 client、真实 UI 能连。
- 常用 gate：`pnpm --dir android run test:feature-registry -- --reporter dot`、`pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`、平台对应 type-check。

### L1 owner 单元/红测
- 证明：修改点 owner 的正向/反向语义被锁住。
- 不证明：跨层真实连接成立。
- 要求：状态机、stream 收口、timeout、retry、错误投影、资源清理必须同时有正向与反向测试。

### L2 daemon/tmux 真回环
- 证明：当前 daemon 代码能真实启动，tmux oracle 与 daemon mirror/client replay 一致，server 读写链路可通。
- 不证明：App/Mac/Web/Android client 入口一定连得上。
- 默认命令：`pnpm --dir android run daemon:mirror:close-loop`。
- 证据最少包含：case summary、tmux oracle、daemon websocket events、replay/strict audit 结果。

### L3 本地客户端 transport/runtime gate
- 证明：仓库内本地 client 的 transport/runtime 能发起连接、完成握手、处理 head/body/input。
- 不证明：packaged app、真机 UI、IME、窗口生命周期一定正确。
- Mac 默认命令：`pnpm --dir mac test -- --reporter dot` 与 `pnpm --dir mac run type-check`。
- Mac 必须覆盖：`bridge-transport`、`local-tmux-transport`、`terminal-runtime`、workbench active target。
- Android/Web 默认至少覆盖：open-tab restore/resume、SessionContext transport、buffer apply、TerminalPage/TerminalView 渲染入口的目标测试。
- Session 切换、foreground resume、drawer/preview active 投影、或用户报告“session 名字和内容对不上”时，必须加入 session identity 黑盒门禁：同一测试里给两个 session 写不同 body marker，通过真实 `sessionBufferStore -> TerminalPageStageShell -> TerminalView` 渲染，断言 header/active id/name 与 DOM body marker 同源；同时模拟旧 session 迟到 publish、pause/resume、layout/IME resize，证明旧 body 不会出现在新 active 名字下。

### L4 app shell / UI 行为 gate
- 证明：页面入口、tab/split/drawer/IME/layout 等 UI shell 行为在测试环境中按语义工作。
- 不证明：安装包、真实 WebView、真实 Electron packaged app 一定一致。
- 要求：若问题发生在容器、IME、drawer、pane、renderer 可见窗口，不允许只跑 daemon 或 transport gate。

### L5 packaged / device / real app smoke
- 证明：真实 app 入口、打包产物、设备/桌面运行态按用户路径工作。
- Android：每次影响 Android 真机行为且需要 Jason 复测的修复，都必须构建可升级 APK 包并发布到 update channel；默认命令 `pnpm --dir android run build:android`。汇报必须给出 `versionName`、`versionCode`、APK 路径、sha256；有 online ADB 设备时继续安装/启动/真机 smoke，没有设备时明确 L5 缺口。
- Mac：packaged `.app` 或唯一 dev Electron 实例，截图/DOM/进程证据，必要时资源采样。
- 不证明：未覆盖的其它平台或远端网络路径。

### 汇报规则
- 汇报时必须按层级列出已跑 gate，并说明每个 gate 证明什么。
- 若只跑到 L2，只能说 daemon/tmux 闭环通过，不能说本地客户端连接正常。
- 若只跑到 L3，只能说 client 核心连接逻辑通过，不能说 packaged app / 真机 UI 已闭环。
- 若任务本身影响 L4/L5，但无法在线或真实运行验证，必须明确剩余风险和缺口。

## 0. transport / session 语义冻结

- terminal input wire 在没有 daemon/client 协议协商与版本门禁前必须保持 **string-only**：
  - 禁止把 `{ data, sentAt }` 这类 object envelope 直接放进现有 `input.payload`，旧 daemon 会把 object 写成 `[object Object]` 进入 tmux
  - 若需要迟到输入防护，优先在 client transport backpressure 处拒绝入队；新增 wire envelope 必须先有协议版本协商、旧 daemon 红测和升级迁移计划
  - daemon 收到非 string input payload 必须显式 `input_invalid`，不得解包执行、不得隐式 stringification
- client 侧必须把下面两类动作彻底拆开，禁止再混成一个 `switchRuntime` 布尔语义：
  1. `restore-sync`
     - 只恢复本地 runtime shell / active tab
     - **不得**自动打开或恢复 daemon transport
  2. `explicit-resume`
     - 只在用户显式切 tab / 显式恢复当前 session 时触发
     - 才允许桥接到 `resumeActiveSessionTransport` / `ensureActiveSessionFresh`
- 新冻结：**persisted terminal page** 的冷启动不属于“纯 restore-sync”；它必须把 restored active tab 直接映射成一次 `explicit-resume`，否则现场会出现“当前 tab 黑屏不刷，切到别的 tab 再切回来才首连首刷”。
- App 层若只是把 tab/runtime 切成 active，**不等于 transport 已连通**
- `session.state === connected`、terminal page 显示 connected、activeSessionId 命中，都**不是** transport freshness 真源
- transport freshness 唯一 owner 只能留在 `SessionContext -> ensureActiveSessionFresh / buildActiveSessionRefreshPlan`
- transport `closed/error/tmux_session_unavailable` 只属于 **transport / attach fact**，**不得**被 App 直接映射成 open-tab 物理关闭
- `tmux_session_unavailable` 也不得从非 active、非 live session 投影成当前 UI 的错误/重连 banner。抽屉打开、session picker refresh、foreground audit 发现 stale persisted tab 时，只能记录缺失事实并停止该 session 的自动 retry；不能 emit `SESSION_STATUS_EVENT(type='error')`，不能让缺失的旧 tab 污染当前 active session。
- open-tab 物理关闭只能由用户显式 close 触发；远端 tmux session-name audit 只能记录缺失/更新历史 session group，不得删除 open tab、切走 active tab、写 closed tombstone、调用 runtime `closeSession`
- terminal tab chrome 必须以 `OPEN_TABS` 为唯一真源 materialize；runtime sessions 只补 transport/state。若 persisted open tab 的 runtime shell 缺失，UI 必须保留 closed placeholder；只有用户显式 resume/open 才允许按 persisted tab 重建 runtime shell 和 transport，禁止用 `open tabs ∩ runtime sessions` 过滤导致“看起来自动关闭 tab”。
- `OPEN_TABS` 的物理身份只能是 `sessionId`；`sessionName + daemon/bridge owner` 语义 key 不得用于 normalize/upsert/runtime-merge/close 时合并、替换、删除已打开 tab。semantic key 只允许用于 saved-list import 去重与用户显式 close 后的 tombstone。
- `open-tab-intent` 这类 core truth 模块不得出现 `fallbackActiveSessionId` / `fallbackSessionIds` 式命名；需要保留 active 或选择关闭后的下一个 active 时，必须写成显式 policy（如 `preserveActiveSessionId` / `nextActiveCandidateSessionIds`）并由架构 gate 锁住。
- `open-tab-persistence` 读写失败不得变成空 truth：存储损坏、读取异常、写入异常必须返回显式 `failed/invalid` 或 `{ ok:false, error }`，调用方至少记录结构化 runtime debug。
- force relay / use auto / reconnect-with-mode 这类同一 open tab 的 transport-mode rebuild 只能放在 `useSessionOpenActions` 这类 session-open owner；`App.tsx`、`TerminalPage`、header、drawer 只能传 intent，不能自己构造 Host 或执行 `closeSession -> createSession -> switchSession` 生命周期序列。
- 现场若出现：
  - app 说 connected
  - 但 daemon 看不到 subscriber / session-open / head-sync 进展
  - 优先回查这条语义分裂，不要先怀疑 daemon / token / tmux 宽高逻辑
- 回归最少要同时覆盖：
  - cold restore 不自动开 transport
  - explicit tab switch / explicit resume 会触发 transport reopen
  - App 层不得再长出第二套 foreground refresh / reconnect 语义

### 0.1 Windows daemon / WezTerm runner 经验

- Windows daemon 只能把 WezTerm 当外部 terminal/mux source；runner 必须显式设置 `ZTERM_TERMINAL_BACKEND=wezterm`，禁止在 Windows 上误走 tmux。
- 从 SSH 里 `Start-Process node server.cjs` 只能当 direct smoke，不能当持久服务结论；OpenSSH job 生命周期可能带走子进程。持久运行真源必须是 Windows Scheduled Task `ZTermDaemon` 或后续明确的服务 owner。
- PowerShell 5.1 兼容边界要测试真实机器：`$PID/$pid` 是只读自动变量，`Start-Process` 的 stdout/stderr 不能指向同一文件，`New-ScheduledTaskSettingsSet` 参数集不能按 PowerShell 7 猜。
- PowerShell 5.1 写 JSON 配置时默认容易带 BOM，daemon 读取会直接炸 `Unexpected token '﻿'`；Windows runner 必须用 no-BOM UTF-8 写配置，不能依赖 `Set-Content -Encoding UTF8` 这种默认行为。
- Windows Scheduled Task 运行环境不继承交互式 shell 的 PATH；runner 不能假设 `wezterm.exe` 可直接找到，必须显式探测/固化 `ZTERM_WEZTERM_EXE` 或安装目录。
- Windows direct route 验证必须同时看：本机 `127.0.0.1:<port>`、本机 Tailscale IP `<100.x>:<port>`、远端设备到 `<100.x>:<port>`；前两者成功不等于 Android/Mac 经 Tailscale 可达。
- Windows WezTerm closeout 必须同时跑 direct remote/input smoke 和 live daemon protocol smoke。live gate 必须自动比较输入 source marker 与解码后的真实 `buffer-sync` target，并通过 daemon control 精确关闭本轮 session；只验 CLI、create/connect/input，或通过 SSH 绕过 daemon 清理，都不算闭环。
- 后端 session 关闭必须经 selected backend 唯一 owner：WezTerm 调 `WezTermBackendRuntime#closeSession`，tmux 才允许 `tmux kill-session`。禁止让兼容 wire 名 `tmux-kill-session` 把实现锁死到 tmux。

## 1. daemon server

server / daemon 是独立层，只做：

1. mirror tmux truth
2. 回 `buffer-head-request`
3. 回 `buffer-sync-request`
4. 处理 transport 级 input / file / schedule / tmux 基础控制

### 1.0 daemon 唯一心智

```text
tmux -> daemon mirror writer -> daemon mirror store -> read api -> client
```

- daemon **不关心也不能关心任何客户端逻辑/状态**
- daemon 只维护自己的 tmux mirror truth
- daemon 内部也必须 **读写解耦**
  - 写侧：`tmux -> mirror store`
  - 读侧：`mirror store -> head/range reply`
- mirror 写侧默认不得再拆第二语义：
  - tmux / WezTerm 禁止 `history capture + visible capture + concat`，只允许
    **single-capture -> canonicalize -> mirror store**
  - Herdr 是唯一显式例外：官方 `pane read --source recent --lines N` 是
    adapter 的 history tail truth，canonical frame 的可见 tail 是 live
    overlay。两者只能在 Herdr adapter 内合并成一个 mirror snapshot；mirror
    store 层不得再拆第二语义，不得把 1000 行 history 放进 33ms capture loop。
  - 若 tmux 正在中间刷新，writer 必须执行 **结构稳定才发布**：只有连续两次 canonical snapshot 的 absolute window / geometry 稳定，或已与当前 mirror 完整一致，才允许写 mirror；发布内容取第二次最新 snapshot。禁止要求动态 TUI 内容逐字完全一致，否则 `top/htop/vim` 持续变化会多次重采样并进入 failure backoff，表现为刷新很慢。
  - 不允许基于 **内容 overlap / repeated text** 推断新的 absolute anchor
  - mirror absolute window 只能来自 tmux authoritative available window；内容相似性最多用于 debug，不得进入写侧真相
- `buffer-head-request` / `buffer-sync-request` 只是**读当前 mirror**
- **请求不得触发 tmux capture / canonical rebuild / planner**
- 正常 live 主链只允许：
  - `tmux -> daemon mirror truth commit -> daemon push buffer-sync -> client buffer apply -> renderer body repaint`
- daemon live push 语义必须再冻结：
  - `mirror body unchanged -> push buffer-head/info`
  - `mirror body changed -> push buffer-sync diff`
  - diff 只允许基于 daemon mirror 前后版本计算
  - **不得**基于客户端状态算 diff
- daemon mirror capture 调度只允许消费 daemon 自己的物理事实：
  - mirror capture/canonicalize duration
  - ready body-subscribed subscriber transport count
  - daemon failure/backoff fact
  - 禁止消费 `active tab / foreground / follow / reading / visible range / viewport / pane layout`
  - transport buffered bytes / send error 只由 `daemon.buffer_publisher` 的 per-subscriber pending/flush 消费，不得拖低 mirror capture cadence
- 有健康 subscriber 的 ready mirror 必须保持 active capture cadence；不得因为最近 1.5s 没观察到 body change 就退到 idle cadence。idle 只属于无 subscriber、失败/backoff 或 capture cost 过高等 daemon 物理事实；transport backpressure 由 `daemon.buffer_publisher` per-subscriber 处理，不得降低 mirror capture cadence；否则 TUI/status bar 的下一次原地更新会被 polling 先天限速。
- daemon 不得长期保存 UI / renderer width policy；`adaptive-phone` 只能进入唯一 adaptive width lease owner：
  - `adaptive-phone` connect/resize 注册当前 physical transport subscriber 的 `{ cols, heartbeatAt }`。
  - 同一 tmux mirror 多个 adaptive lease 必须按 active holders 聚合最窄 `cols`，并只在 `applyAdaptiveTmuxWidth()` 内请求 `tmux resize-window -x <cols>` 让 tmux 自己重排。
  - 持有 lease 的 transport close/detach、切到 `mirror-fixed`、invalid cols 或 heartbeat 过期后必须清理该 subscriber metadata 并重算；最后一个 lease 消失必须在 `releaseAdaptiveTmuxWidth()` 恢复/释放 tmux 宽度控制权。
  - `widthMode`、`terminalWidthMode`、`requestedAdaptiveCols` 不得写入 daemon 业务真相；`resize-window` / `window-size` 只允许出现在 adaptive lease owner 的 apply/release 函数里。
  - daemon 请求 tmux resize 后不得自写 `mirror.rows/cols`；mirror 内容和尺寸仍只能来自 tmux capture/readback。
- 好网 fast lane 与弱网 slow lane 必须由红测锁定；性能 trace 只记录 timestamp/duration/bytes/line count/id/kind 这类 metadata，禁止记录真实 terminal payload 内容。
- 生产性能 trace 必须按 `traceId + mirrorRevision + subscriberId` 关联独立样本；同 session 的不同 revision 不得被拼成一个伪 latency。完整阶段是 `capture -> canonicalize -> mirror commit -> send -> client rx -> buffer apply -> RAF -> render commit`，只允许有界 metadata ring 和 p50/p95/p99 summary。
- physical subscriber 与 live body subscription 必须分离：
  - attach transport 不等于永久订阅正文；
  - daemon 只保存 `bodySubscribed` 这一物理事实，不保存 active/inactive/visible/foreground 原因；
  - unsubscribe 只停止 unsolicited `buffer-sync`，不得 close transport、detach mirror、禁用 input/file/schedule 或 explicit head/range read；
  - recurring capture 只由 ready 且 `bodySubscribed` 的 physical subscriber demand 驱动；unsubscribe 必须经同一个 scheduler owner 立即停旧 timer，恢复 demand 后恢复 scheduler，不得由 head/range 请求直接 capture。
  - RTC/Relay datachannel close 可能不会可靠到达 daemon；daemon 必须按 transport inbound heartbeat sweep stale bound subscriber，并只走 `detachSubscriberTransportOnly`。禁止杀 tmux、销毁 mirror、或在 Android UI/renderer/buffer 层做退出补偿。
- subscriber backpressure 禁止直接永久 skip 当前 revision：
  - 每个 subscriber 最多保留一个 bounded pending latest revision 和合并后的 absolute ranges；
  - pending flush 时必须从当前 mirror store 读取最新权威行，禁止保存历史 serialized payload/cells；
  - changed span 序列化后超过单消息预算时，必须按 absolute row 连续切成同 revision 多个 `buffer-sync`，覆盖原 span 的每一行；禁止裁成 live tail，否则超过一屏的大刷新会静默丢掉 source rows；
  - high/low water 必须迟滞；send error/non-open/旧 generation 不得清 pending 或推进 sent revision；
  - 一个 slow subscriber 不得降低 healthy subscriber cadence；输出停止并 drain 后必须到达 daemon latest revision。
  - 以上 subscriber 发布状态唯一 owner 是 `daemon.buffer_publisher`（`src/server/daemon-buffer-publisher-runtime.ts`）；`terminal-mirror-runtime.ts` 只调用 publisher 的 broadcast/flush 接口，不得重放 pending/backpressure/head cache/frame split 语义。
- mirror capture 允许的性能优化只有同一 writer 内的 authoritative hot-range patch：
  - range 至少覆盖完整 mutable pane，absolute anchor 只来自 tmux `pane identity/history_size/rows/cols/alternate/captured count`；
  - 已确认旧 history 只能作为同一 mirror store 内的 retained prefix；
  - cols/reflow、rows 变化导致未知 prefix、pane/alternate 变化、history shrink/clear、absolute discontinuity、结构不稳定或周期 reconciliation 到期时，必须由同一 owner 做 full reconciliation；
  - hot patch/full reconciliation 是同一个 validator/committer 的两种 commit mode，不是 fallback 或第二真源。
- structured send 与 pre-serialized `sendText` 必须进入同一 accounting owner，记录 bytes/total/error/buffered-before-after/duration/backpressure transition；禁止为统计重新 stringify terminal payload。
- 网络 RTT/jitter/stall 只调节 producer 的 head/pull/probe cadence；body 到达后 renderer 只允许 next-RAF commit，禁止再加 network debounce。
- 弱网性能闭环必须使用主链外透明 TCP byte proxy：只允许延迟、限速、暂停读取、周期 stall、显式断连；禁止解析、重写、压缩或裁剪 WebSocket/terminal payload。代理测试必须证明双向字节完全等价，并用真实 control/session WebSocket 统计 inactive body bytes、slow/healthy cadence 和 final revision。
- `buffer-head` 只允许更新 head metadata / cursor metadata / planner 输入
- **只有 `buffer-sync apply` 可以触发正文 body repaint**
- `buffer-head.latestEndIndex` 只表示 daemon mirror 的 authoritative tail absolute index（`bufferStartIndex + bufferLines.length`），不是 row-level body freshness。诊断 input/tail 行旧内容时，禁止用 `latestEndIndex` 或全局 `localRevision == daemonHeadRevision` 直接证明可见非 gap 行已新鲜；必须比较 source row / payload row / client sparse row / DOM row。
- 稀疏 `buffer-sync` 只覆盖 payload 中的 row/range。若一个可见非 gap 行曾漏刷，后续单行 status/footer sparse patch 可能推进全局 buffer revision 并掩盖该旧行。此类问题必须加“source row cleared once -> client missed non-gap row -> later tiny sparse patch -> DOM still stale”的黑盒 gate，再改 sparse apply / visible-window repaint authority；禁止用 QuickBar、reconnect、header repaint、DOM 清空补偿。
- 全屏 TUI 刷新必须比较完整 cell truth，而不是只比较文本和 absolute index：同一行文字不变但背景色、flags、style、cursor 相关 cell metadata 变化时也必须 repaint。回归 gate 要包含 fullscreen/status-row 场景，证明同 `bufferStartIndex` / 同文本 / 新 revision / 新 cell style 会更新 DOM。
- terminal body 问题禁止用页面 chrome 补偿：网络 banner、状态栏、debug overlay、quickbar 只能是 UI projection owner。若出现“两个状态栏、一个旧状态”或状态栏挤压导致布局变化，修 `terminal-page-shell-ui` / `TerminalPageDebugOverlay` 的单一投影与 fixed overlay，不得改 daemon/buffer/renderer truth 来迎合 chrome。
- daemon **不得改写 buffer cells 本身**
  - 包括但不限于：cursor paint、reverse 注入、样式补丁、局部重写
  - 若需要传 cursor truth，必须走**独立元数据**，不能写回 `lines[].cells[].flags`
- 文件传输这类 session 元数据也一样：远端默认目录必须来自 daemon 读取 tmux 当前 `pane_current_path`；client 不得拿 `process.env.HOME` / 本地 env 冒充远端 cwd

硬规则：
- server 不做 follow / reading 策略
- server 不做 renderer 策略
- server 不做 planner / prefetch / snapshot / fallback
- server 不替客户端判断 gap，不替客户端决定该拉哪段
- server 不关心 client 本地 buffer 是否为空、是否 gap、是否 follow/reading、是否首屏
- server 不允许在 `head/range` 请求路径里“先同步 tmux 再回复”
- **每次回复都带当前 head**，避免客户端额外猜
- mirror 生命周期也必须独立：
  - client 断开 / 切 tab / 暂时没有 subscriber，不得销毁 mirror truth 再重建
  - 否则 reconnect 后出现 `revision -> 1` / `latestEndIndex` 回退，不是 tmux 变了，而是 daemon 自己把 absolute truth 丢了
- daemon 只允许持有自己的服务端真相：
  - ws/rtc transport 是 daemon 可持有的物理连接真相
  - mirror 是 daemon 可持有的 terminal 真相
  - tmux session / file transfer / schedule 是 daemon 可持有的业务真相
- daemon attach/connect **不得**隐式 `new-session`；远端 tmux session 不存在时只能显式报 `tmux_session_unavailable`，显式创建唯一走 `tmux-create-session`。
  - `invalid pane metrics / pane is dead` **不是** `tmux_session_unavailable`；它只表示 mirror capture/pane target 故障，不得 release subscriber / close client runtime
  - transport 断开只影响该 transport 自身，不允许推导客户端 active/inactive/foreground/background 语义
  - 多客户端只表示“多个 transport/订阅者读同一 mirror”，不是 daemon 维护一份客户端状态机
- daemon 不允许保留 client 风格状态机：
  - 不允许 `session.state`
  - 不允许 `mirror.state`
  - 不允许 `terminalWidthMode / requestedAdaptiveCols`
  - 不允许把 `resize / terminal-width-mode` 做成 daemon 内部状态推进入口
  - 不允许 `logical client session`
  - 不允许 `clientSessionId` 成为 daemon 内部长期状态 owner
  - 不允许 `readyTransportId`
  - 不允许 `session transport token / attach-resume state machine`
  - 不允许 `active tab / foreground / background / pane / viewport / visible range / width mode`
- 若协议兼容期仍接收这些字段：
  - 只能作为一次性 attach 参数或调试透传
  - 不得写入 daemon 长期状态
  - 不得反向驱动 mirror / tmux / transport 生命周期
- `clientSessionId / sessionTransportToken / session-ticket` 的额外冻结：
  - `clientSessionId` 是 **client-owned session identity**
  - `sessionTransportToken / session-ticket` 是 **attach-only wire material**
  - 它们可以留在协议兼容层
  - 但不得成为 daemon 业务真相
  - client 侧也不得把 `sessionTransportToken` 放进长期 transport runtime store；它只能是 handshake 期间的临时 attach 材料
- 若兼容层仍需要握手关联字段，优先使用：
  - `openRequestId` = **client-local open intent correlation**
  - `sessionTransportToken` = **daemon one-shot attach proof**
  - 禁止再把 `clientSessionId` 放回 daemon token owner / primary wire correlation 语义
- daemon terminal core 的**代码组织**也必须收口：
  - `server.ts` 只保留 transport/http glue
  - mirror lifecycle / live sync / attach / input orchestration 必须下沉到独立 terminal core 模块
  - file list / mkdir / download / upload / remote screenshot / attach-file binary / paste-image binary 也必须下沉到独立 runtime
  - 禁止一边说“daemon 不关心客户端”，一边把 terminal core 业务散落回 `server.ts`

## 2. client buffer manager

buffer manager 是独立 worker，不归 daemon、不归 renderer。

它的唯一职责：
1. 自己起 timer
2. 定时先问 head
3. 自己比较 local buffer 和 daemon head
4. 接收 renderer 声明的 visible range
5. 自己决定请求哪段 buffer
6. head 变了或 gap 补齐了，就通知 renderer 对应 line/range patch

补充冻结：
- `buffer-head` 到达时，buffer manager 只更新 metadata / planner 输入
- `cursor` 变化也只更新 metadata
- **buffer manager 不得因为 head/cursor-only 更新直接触发正文 repaint**
- `buffer-head` 携带 cursor / cursorKeys metadata 时，可以更新本地 metadata truth，但不得调用 `scheduleSessionRenderCommit()` 或发布 render body；否则旧 body 会在真正 `buffer-sync apply` 前被重新投影，表现为“先闪旧 buffer，再被新 buffer 覆盖”。

### 2.1 本地 buffer 真相
- 本地维护一个 sliding buffer，客户端默认/最大保留 **1000 行**
- 按绝对行号存储
- 可以是 sparse，不要求永远连续
- 历史超出窗口后滑走，但**不是单次 payload 来了就把本地历史裁掉**
- **已有 absolute-index 内容不能因为窗口判断错误而被逻辑清空**
- **同 revision 的迟到旧 payload 不得把本地窗口重新锚回更老的位置**
  - 它只允许 patch 当前 1000 行窗口内的 absolute-index truth
  - 不允许因为晚到的 prepend / reading repair 响应，把 follow 中已经稳定的 tail window 拖回去
- 迟到旧 payload 不得覆盖当前本地 truth：`incomingRevision < localRevision` 必须显式 drop、记录 debug、请求当前 tail；同 revision payload 若会改写当前本地已有 **non-gap absolute-index 行**，也必须显式 drop。只有同 revision 且命中本地 gap 的 payload 才能作为 gap repair 合并。禁止用“先清空 buffer/DOM 再刷新”掩盖旧 payload 污染。

### 2.1.1 本地 buffer 不变量

- `local window invalid` 只说明“当前工作窗口理解错了”，**不说明已有 buffer truth 作废**
- `anchor mismatch` / `head mismatch` 也一样；它们只影响下一次 request plan，不影响已有 absolute-index 内容的存在性
- buffer manager **没有权利**把已有本地 buffer 先 reset 成空窗再重拉
- revision reset / reconnect / reanchor 期间若已有本地画面，低 revision 且 `startIndex/endIndex` 为空、`lines=[]` 的 payload 只能表示“新 buffer 尚未 ready”；client 必须保留上一帧等待非空或明确范围的 `buffer-sync`，禁止先发布空 buffer 导致黑屏再刷新
- 遇到上述 revision-reset 空 payload 且本地已有画面时，client 必须清掉该 session 的 tail-refresh debounce 并立即用 authoritative head 重发 tail sync；禁止只早退等待旧 debounce/下一轮 tick，否则普通连接/恢复会表现为“保留旧画面但刷新很慢”
- 正确动作只能是：保留已有内容 -> 计算缺口/新窗口 -> 请求 range -> merge -> 通知 renderer

### 2.2 follow 路径
每次 tick：
1. 先问 head
2. 比较本地尾部与 daemon head
3. 若本地为空、失真，或离 head 超过当前 visible window：
   - 直接请求 **当前 visible window**
   - 移动本地 sliding window 到最新尾部
   - **中间缺口不补**
4. 若离 head 不远：
   - 只补 diff

补充冻结：
- **visible-window body pull** 和 **1000 行本地缓存上限** 是两个独立真相，禁止再用同一个 `cacheLines` 语义混写两者；1000 行只表示本地保留上限，不是拉取目标

### 2.3 reading 路径
- reading 不改变 buffer manager 的 head-first 主循环
- buffer manager 不持有 `follow / reading / renderBottomIndex`
- 它只接收 renderer 声明的 **当前 visible range**
- 若当前 visible range 内不连续，buffer manager 才请求 gap；隐藏区域不因已有 WebSocket 连接而主动拉取
- **gap repair 属于 visible range repair，不属于 renderer state ownership**

### 2.4 禁止事项
- renderer 不能直接触发 transport pull
- buffer manager 不能替 renderer 改 mode
- buffer manager 不能持有 renderer mode / renderBottomIndex / viewport scroll
- 不能因为本地历史有 gap，就在 follow 下回补整段历史
- 不能把 snapshot / patch-middle / fallback 再塞回来
- 不能把 `local window invalid` / `anchor mismatch` / `head mismatch` 实现成“先清空已有本地 buffer 再重拉”
- buffer manager 也必须 **读写解耦**：
  - 写侧：同步 daemon -> 更新本地 sparse buffer
  - 读侧：renderer 只消费当前本地 buffer
- buffer manager 不关心 renderer 如何滚动、如何绘制、如何布局
- buffer/head request cadence 必须是 session-aware：以目标 session 的 transport/socket buffered amount 与 runtime metrics 解析快慢通道；禁止在 assembly/request 路径直接调用全局 cadence，避免好网 session 被非目标或默认 33ms 节流拖慢
- same-revision merge 也必须遵守“tail 优先稳定”：
  - 若当前本地窗口已经贴着 authoritative tail，且迟到 payload 只覆盖更老的历史、不推进 tail
  - 那么它只能补当前窗口内已有 absolute-index 行，**不得**回拖 `startIndex/endIndex`
- 大 payload 裁剪也必须遵守“authoritative tail 优先”：
  - 若 incoming `buffer-sync` span 覆盖当前 authoritative tail，且 span 长度超过本地 retention（默认 1000 行）
  - 本地窗口必须裁成 tail window（如 `[tail-1000, tail)`），不得因为 incoming `startIndex` 更老而裁成 head window
  - 现场信号是 `incoming.endIndex == nextTailEndIndex` 但 `nextEndIndex << nextTailEndIndex`；这会先发布旧历史窗口，再被下一帧尾部 patch 拉回，表现为旧 buffer 闪屏
  - 红测必须直接复现“大 span 覆盖 tail + lineCount > cacheLines”的日志形状，禁止只测 missingRanges 连续性
- 近尾大 payload 也必须遵守“当前 tail window 不回拖”：
  - 若当前本地窗口已经贴着 authoritative tail，incoming `buffer-sync` 是较新 revision、覆盖了当前窗口一部分、但 `endIndex < authoritativeTailEndIndex`
  - 本地窗口必须保持当前 tail anchor，只 patch overlap 行；不得因 `incoming.startIndex < current.startIndex` 把窗口重新锚到更老位置
  - 现场信号是 `previousEndIndex == tail`，随后 `nextEndIndex < tail`，再被同 revision 追加尾部 patch 拉回；这会在底部持续更新时闪旧 buffer
  - 红测必须复现近尾 span 如当前 `[10606,11606)` + incoming `[10592,11601)` + tail `11606`，并证明非 tail reading/prepend 窗口仍可移动
- sparse `buffer-sync` 只能建立在连续 revision 基线上：
  - 若 client local revision 跳过 daemon 中间 revision，且 incoming payload 没覆盖完整 `[startIndex,endIndex)` 窗口，client 不得把该 sparse diff 合并成本地 body truth
  - 正确动作是拒绝这次 sparse body apply，清 tail-refresh debounce，并请求当前 authoritative tail window
  - 否则旧行会作为“未覆盖但保留”的本地 truth 永久存在，表现为大面积刷新时旧内容跟着 buffer 上移
- `buffer-sync` 的 in-flight / pull bookkeeping 只是 **transport bookkeeping**，不是 buffer truth；active tab 重新进入、resume、reconnect 时不得让旧 bookkeeping 永久挡住新的 head-first 请求链
- session transport 的重建真相不能来自“安静时间”：`lastServerActivityAt` 过旧、缺 pong、缺 head、pong-only traffic 都不得让仍为 `WebSocket.OPEN` 的长连接过期。active tab 恢复 / 重新进入 / tick 只能在原 transport 上 request-head / ping 观测；只有物理 `close/error`、send 抛错、daemon 不可达、用户显式关闭、或 tmux/session target 事实变更，才允许重建。
- session transport target identity 必须包含 route 语义。`bridgeHost:bridgePort:authToken` 不足以判定 same target；同 daemon 的 Tailscale/WS、`rtc-direct`、TURN `rtc-relay`、Relay endpoint candidates、`transportMode`、daemon/relay identity 必须影响 target key，Relay `lastSeenAt` 这类 freshness metadata 不得影响 key。否则会复用错误 OPEN socket，出现有上下行速率但可见 body 不更新。
- transport topology 也必须冻结：
  - daemon 只认 **transport connection truth**
  - daemon 不认 `clientSessionId`、不认 control/session 两级客户端状态机
  - daemon 不负责客户端 auth 复用策略、session 恢复策略、active transport 选择策略
  - 客户端如果需要长期复用长链接，这是**客户端 transport owner** 的职责，不得下沉到 daemon 变成客户端状态机
- active / inactive 只影响“是否继续取数”，不影响 logical session / transport 身份：
  - inactive tab 不主动高频拉 head/range
  - 但**不是**关闭 session
  - 也**不是**关闭 transport
- server 普通 `closed` / websocket detach 只表示 transport failure，必须进入 retryable reconnect owner；terminal 终态关闭只认显式业务真相，例如 `tmux_session_killed`。禁止把普通 `closed` 映射成本地 tab/session closed，否则 WebSocket 断开会卡死不重试。
- drawer 中 remote-only session 是 daemon catalog truth，不是本地 open-tab truth；关闭必须走 tmux control owner（`killTmuxSession` 后刷新 catalog），禁止把 `remote:*` id 交给 local open-tab close。
- reconnect / resume / foreground/background / tab active 都是**客户端逻辑**
  - daemon 不能持有这些状态机
  - daemon 只暴露稳定 mirror read/write 接口和基础 transport 接入能力

## 3. renderer

renderer 只看三件事：
1. `local render buffer tail`：buffer manager 已提交给 renderer 的本地内容底部
2. `renderBottomIndex`：当前要显示窗口的底部
3. `visible range`：当前要画的 absolute rows

额外门禁：
- renderer body repaint 只允许来自 `buffer-sync apply`
- daemon head metadata 只属于 buffer manager / planner 输入；renderer 不订阅 daemon head store，不用 daemon head 推进 follow demand
- cursor metadata 可以被 renderer 读取
- 但 head/cursor metadata 不得作为正文 repaint 触发源
- render store 发布也必须单调：
  - 同一 session 已发布 `revision=N` 的 render body 后，任何 `revision<N` 的 render snapshot 都必须拒绝发布并记录 `session.render-store.revision-regression-drop`
  - render revision reset 只能来自显式 session truth reset（如 `deleteSession()` / 重建 session），不得由迟到旧 snapshot 隐式覆盖
  - 该门禁只保护 renderer 发布边界；若高 revision payload 自身携带旧内容，仍必须回 daemon mirror / buffer-sync 源头追真源，禁止用清 DOM / 清 buffer 掩盖

### 3.1 block/shade glyph 真相
- `U+2580..U+259F`（block / shade / quadrant）不能按普通文本 glyph 渲染；这类字符在 TUI/tmux 里经常承担“背景块/色块”语义。
- renderer 必须按 `fg/bg` 生成 fill/gradient/pattern；若直接渲成普通字形，现场会表现成“红绿背景变灰”。
- Android/WebView 不应依赖 `color-mix(...)` 渲染 `░▒▓`；应在 JS 侧直接算出最终 RGB，否则现场可能退成灰/透明。

它不关心：
- transport
- daemon 策略
- buffer 拉取策略
- 输入法

### 3.0 宽度模式真源

renderer 还必须显式区分两种宽度模式：

1. `adaptive-phone`
   - 当前配置真源在 **Settings**
   - 允许手机适配宽度，但最多只允许改 `cols`
   - Android runtime 后续不允许因为 keyboard / IME / safe-area / 容器高度变化继续改 tmux rows
2. `mirror-fixed`
   - daemon mirror / tmux 宽度保持上游真相
   - client viewport、IME、safe-area、容器宽度、字体缩放，**不得**改写 mirror 宽度
   - renderer 只能：
     - 读取原始列 truth
     - 对当前 viewport 做横向裁切
     - 维护自己的 horizontal render window
   - **cell 宽度真相必须来自客户端实测的像素宽度**，不能再把 `1ch / 2ch` 当终端列宽真相
   - 双宽 cell 只能按 `2 * measuredCellWidthPx` 渲染；浏览器 fallback 字体的 `ch` 不是 tmux 列宽真相
   - 若 buffer 行宽大于 viewport：
     - 默认显示左侧窗口
     - 用户横向平移 renderer window 看右侧
     - **不允许**本地重排、换行、回写上游宽度
  - **cursor 也是上游 truth**
    - Android client / renderer **不得自行改 cursor 样式、颜色、位置语义**
    - 但 cursor truth 也**不得通过改写 buffer cell** 来传递
    - 正确做法只能是：daemon 单独回 cursor metadata；renderer 按 metadata 做 overlay / highlight
    - buffer lines 只承载 tmux 原始 cell truth

### 3.1 follow
- follow 只是在收到 head / buffer 更新后
- 把 `renderBottomIndex` 对齐到最新底部
- 然后从本地内容池取当前窗口来画
- 若窗口里有 gap，先直接画空白占位

### 3.2 reading
- 用户上滚立即进入 reading
- reading 时只改自己的 `renderBottomIndex`
- 申请的是当前 visible range 的渲染窗口
- buffer 更新只会让 renderer 重绘当前窗口，**不会自动滚动**
- 即使当前窗口不连续，renderer 也只能把缺口画成 gap / blank marker；不能把已有 absolute-index 内容当成不存在
- gap 行的显示规则也冻结为：
  - **先显示空背景占位，不等待补齐**
  - 补齐后只替换对应 absolute-index 行
  - 相邻 absolute line number 若不连续，当前行号必须显式高亮（debug 下优先红标）
- follow 态若只是因为 live tail refresh / pending follow realign / programmatic scroll 导致 DOM 暂时没贴底，**不得自动进入 reading**；进入 reading 只能由用户滚动手势触发
- follow 态若只是因为 **IME 弹起 / viewport 高度变化 / UI shell relayout** 触发 DOM scroll，**也不得自动进入 reading**
  - viewport relayout 只允许触发 follow realign
  - 不允许把“布局导致的 scrollTop 变化”误判成“用户回滚”

### 3.3 reading 退出条件
只允许三种：
1. 重新进入
2. 下滚到底部
3. 用户输入

除此之外，live update / 补 gap / 尾部推进，都不能把用户拉回 follow。

### 3.4 visible range 声明与局部重刷

- renderer 是 **visible range 唯一真相**
- buffer manager 不得自行猜 renderer 当前窗口
- renderer 必须把当前 visible range 声明给 buffer manager
- buffer manager 补齐 gap 后，renderer 只重刷对应 absolute rows / changed range
- **禁止**“等整窗补齐后再统一出图”

## 4. UI shell

UI 只负责容器位置与裁切：
- terminal 容器放在哪里
- keyboard / IME 弹起后容器怎么上抬
- 终端可见区域是多少

硬规则：
- IME 只移动容器，不改变内容
- renderer 只在容器里画，不关心输入法
- keyboard / IME 不得回灌成 buffer / render 真相
- `状态浮窗` 与 `绝对行号` 都属于 UI shell observability，但必须 **解耦**
  - `状态浮窗` 只负责连接/刷新/模式观测
  - `绝对行号` 必须由独立显式开关控制，不能再隐式绑定到状态浮窗
- Android 顶部 header inset 只允许来自 **UI shell 的单一稳定像素真相**；IME 弹起导致的 `visualViewport.offsetTop` 不得再被当成第二份 top inset 叠到 header 上
- Android connect / reconnect **不得**把 UI 容器测得的 `cols/rows` 当成 tmux viewport 真相带给 daemon；容器变窄/变矮、IME 弹起、safe-area、前后台恢复，都只能影响 shell 裁切与 renderer 可见窗口
- tmux rows 也必须单独冻结：
  - Android runtime 后续运行期间，keyboard / IME / safe-area / 容器高度变化 **不得**继续改 rows
  - 最多只允许初始化阶段确定一次 rows；更稳妥的实现是直接保持上游 tmux rows，不再由 Android 改写
  - `adaptive-phone` 若需要适配手机，最多只改 `cols`
  - server 的 `attach / resize / width-mode reconcile` 也不得再写第二份 rows；rows 真相只能来自上游 tmux / mirror baseline
- “看不到的地方不画”属于 **renderer 绘制窗口** 真相，不属于 UI shell / buffer manager / daemon；UI shell 只能改容器位置与可见高度，不能借机改 tmux geometry
- QuickBar / 快捷菜单属于 UI shell；**整块 shell 区域** 都必须吃掉非交互点击，不能让空白点击穿透到底层 terminal/ImeAnchor 把 IME 弹出来
- QuickBar 壳布局必须是 **三栏**：前两栏保持老样式（左侧固定六键区两行 + 右侧两行滚动快捷区），第三栏恢复工具栏
- QuickBar 固定布局还要守住：
  - 左侧固定六键区必须是：`状态 / ↑ / 键盘` 与 `← / ↓ / →`
  - `状态` 只替换老附件位；`↑` 与 `键盘` 保持老位置
  - 文件/图片/同步/截图 这四个工具入口要作为 **第三栏工具栏** 显式可见
  - 工具栏只能有这一份；悬浮菜单里不得再重复渲染 文件/图片/同步/截图
  - 固定六键区宽度必须能完整容纳 `状态 / 键盘` 文案，不能裁切、顶出或超界
- 只有 QuickBar 内显式 editor / input / button 等交互控件允许接管焦点；普通 shell 容器点击必须被阻断在 UI shell 层
- 若 `keyboardInsetPx > 0`，QuickBar 必须作为**整体容器**抬升到键盘上方；同一份 keyboard inset 只能消费一次：`terminal stage.bottom = quickBarHeight + keyboardLift`，`quickbar shell.bottom = keyboardLift`，禁止再用 QuickBar 内部 `padding/margin` 对同一份 inset 二次抬升
- QuickBar 的 `onMeasuredHeightChange` 必须上报自身真实 chrome 高度，不得再扣 `keyboardInsetPx`；IME lift 已由外层 shell bottom 消费。若测量阶段扣 inset，`quickBarHeight` 会在键盘弹出时归零，导致 stage 丢失快捷栏预留。
- remote screenshot 也属于 UI shell / session control 闭环：
  - UI 必须能区分 `capturing -> transferring -> preview-ready`
  - `capturing` / `transferring` 都必须有**显式失败边界**；不允许无限 spinner
  - 客户端**不得**在收到远程截图后直接自动落盘并宣称成功
  - 正确动作是：先预览，再由用户显式 `save` / `discard`
  - QuickBar 工具语义也必须固定：
    - `文件` = 本地文件选择并上传到当前 session
    - `图片` = 本地图片选择并上传到当前 session
    - `同步` = 打开远程文件同步页 / FileTransferSheet
    - `截图` = 远端截图预览流
- session schedule 也必须保持 daemon 单真源：
  - `maxRuns=0` 表示无限次，默认 `3`
  - `firedCount / endAt / stop condition` 只能由 daemon 维护；client 只编辑和展示
- 若为了审计 buffer/render 真相新增 debug UI：
  - 只能做 **观测**：如绝对行号、当前 `follow / reading` 模式、拉取/刷新状态
  - debug UI 不得反向驱动 buffer manager / renderer / daemon 行为
- active tab 持久化也属于 app-shell truth：
  - `ACTIVE_SESSION` 是最后激活 tab 的唯一持久化真相
  - **每次 tab 激活都必须立即写回 `ACTIVE_SESSION`**
  - 冷启动 / 恢复只允许按 `ACTIVE_SESSION` 恢复 active tab，`ACTIVE_PAGE` 只决定页面种类，不得反向覆盖
- 若 QuickBar 自己的 textarea / sheet 抢到 DOM focus，只允许暂停 terminal ImeAnchor 路由；**不得**把 QuickBar overlay / floating composer 使用的 `keyboardInsetPx` 清零，否则会被输入法盖住
- Android terminal 原生输入若走 `ImeAnchor`，则 **ImeAnchor editable / composing / selection 必须是单一真相**；组合输入期间不得一边让 IME 持有 composing state，一边又由插件自行清空/改写 editable 造成第二语义
- `ImeAnchor` 的 `InputConnection` 也必须服从这条真相：`commitText / finishComposingText` 不能跳过 `super` 直接短路返回；否则 framework editable/selection 不更新，真机会出现 **输入法底部预编辑光标错位 / caret 乱飞**
- `mirror-fixed` 下，UI shell 若启用横向查看：
  - 自动关闭左右滑切 tab
  - 单指横滑只服务于 renderer horizontal pan
  - 不允许一次手势里同时尝试切 tab 与横向平移
  - horizontal offset 尚未到 0 时，能真实改变 offset 的横滑必须由 renderer 独占并截断父级 `touchmove/touchend`
  - 只有 offset 在手势开始前已经为 0，左缘右滑才可进入 drawer owner；只缩热区不能解决子级 pan 与父级 drawer 同时解析同一 touch 序列的问题
- `mirror-fixed` 下若当前客户端并没有独立 horizontal pan 手势链在生效：
  - 禁止把左右滑切 tab 直接禁用成“无交互出口”
  - 此时单指横滑仍归 UI shell swipe surface 所有，继续用于切 tab
- `adaptive-phone` 下若保留左右滑切 tab，该手势也必须属于 **UI shell interaction surface**：
  - renderer 不得自己持有 swipe gesture state machine
  - renderer 不得自己决定 tab navigation 命中
  - renderer 只允许上报 viewport / scroll / input 真相
  - tab swipe 的 owner 只能是 shell 包裹层或独立 interaction block

## 5. 反模式清单

以下一律视为错误实现：
- snapshot
- stream-mode
- planner
- viewport prefetch 第二链路
- `ws close -> daemon 推导客户端状态并修改 mirror/tmux 生命周期`
- `inactive tab -> close session / close transport`
- `reconnect -> new client session semantics`
- daemon 在 `buffer-head-request / buffer-sync-request` 路径里触发 tmux capture
- daemon 根据 client 状态决定“要不要先刷新一下 mirror 再回复”
- daemon 因 subscriber 归零就销毁 mirror，导致 reconnect 后 revision / absolute head 重置
- daemon 把 cursor / selection / transient visual state 直接写进 buffer cells
- client viewport 变窄就改写 daemon mirror / tmux 宽度
- `mirror-fixed` 下把长行本地重排成手机宽度
- `mirror-fixed` 下在没有 horizontal pan 手势链的情况下把 tab swipe 禁用，造成无横向交互出口
- renderer 直接 request buffer
- buffer manager 直接改 renderer follow/reading
- follow 下因为历史 gap 去回补整段旧历史
- `local window invalid -> empty local buffer -> full reanchor`
- `anchor mismatch -> clear local truth`
- `head mismatch -> treat local content as lost`
- 初次连接或恢复连接时，两三 K 两三 K 慢慢追历史
- 任何 fallback / 降级 / 第二语义

## 6. 必须遵守的开发顺序

```text
先落 docs / AGENTS / skill
-> 再补测试
-> 再改代码
-> 再跑真实回环
```

顺序错了，视为没按真源做。

其中测试与检查清单真源固定为：

- `android/docs/daemon-mirror-test-plan.md`
- `android/docs/terminal-test-loop-checklist.md`

## 7. 必跑真回环

```text
tmux truth
-> daemon log
-> renderer declare visible range
-> client buffer manager log
-> renderer commit log
-> Android APK 真实画面
```

最少覆盖：
1. 初次连接
2. 冷启动进入单个 active tab，等待首屏刷新
3. 进入一个 tab 后切换到另一个 active tab，等待首屏刷新
4. 后台恢复
5. 输入英文 / 数字 / 空格 / 回车
6. reading 连续上滚
7. 输入退出 reading
8. daemon 重启恢复
9. prompt / input row style parity
   - 输入发出后、`buffer-sync` 前，terminal 可见内容不得本地直接变化
   - `buffer-sync` 到达后，renderer 只回显 payload，不得自己再造 prompt/cursor 第二语义
10. same-session transport retry
11. inactive tab stops polling but does not close session/transport
12. same target multi-session stays isolated without shared reconnect fate
13. foreground resume reuses the original session transport before any fresh reconnect
   - prompt / input row 必须可比对 `char / fg / bg / flags`
   - daemon 若回 cursor，必须是**独立 cursor metadata**；`lines` 不得因 cursor 改变

## 7.1 必须沉淀成自动回归

上述 case 不能只靠人工重试。

必须把问题收敛成：

```text
可复现的本地 case
-> 可失败的自动测试
-> 修复后稳定转绿
-> 纳入每次编译前回归
```

只要某个 terminal 线上问题还不能被本地自动 case 复现，就不允许说“根因已收敛”。

最低自动回归覆盖：
- server contract：head / range reply 语义
- buffer manager：head-first / far jump / reading gap / in-flight closeout
- renderer：follow commit / reading hold / input reset follow
- daemon mirror close loop：`top` / `vim` / input echo
- Android 首屏：cold start single tab / switch to another tab 的 first paint

新增门禁精华：
- cold-start / foreground resume 的 transport gate 必须优先 active tab；若 hidden tabs 跟着一起 eager reconnect，active tab 的首屏会被排队拖慢。除非已有被验证的 hidden low-frequency 设计，否则 hidden tab 默认只保留 runtime shell，等显式激活再 reconnect。
- 若现场 `buffer-sync` 下行长期几百 KB/s 甚至 MB/s，先直接抓 daemon 回包；若仍返回 legacy `lines[].cells[]` 而不是 compact `i/t/w/s`，优先查 **daemon service staged runtime 没更新**，尤其是 `start/restart` 只重启 launchd 但没重建 `~/.wterm/daemon-runtime/server.cjs`。
- daemon service 管理也必须遵守唯一真源：`start/restart` 必须重建当前 staged runtime；服务异常必须显式失败，**不能 fallback 回 tmux session** 掩盖旧 runtime/旧语义。
- 本地 `daemon mirror close-loop` 必须使用**隔离测试端口**；禁止复用用户常驻 service 端口（如 3333），否则脚本会误连现场 daemon，出现“自动回归假绿 / 假红”。
- `daemon mirror close-loop` 的 client replay harness 也必须服从 **revision reset 真相**：daemon 重启后若 revision 回到更小值，回放时必须先 reset local buffer 再 apply；否则会把回环假红误报成 daemon/client 主链故障。
- hidden / non-visible tab 不得继续挂载 renderer 实例；renderer scope 必须严格等于当前 visible pane。否则 header truth 已切换但 body 仍残留旧 session DOM，Android WebView 容易出现“页头/内容对不上、像花屏”的 stale compositing。
- renderer scope 回归测试不能只断言 “inactive renderer 还在但 data-active=false”；必须直接断言 **hidden renderer 不在 DOM**，否则会把 DOM 覆盖类问题测成假绿。
- foreground resume 对 active tab 不能只补一发 `buffer-head-request`；若 daemon 仅 `revision` 前进而 `latestEndIndex` 不变，buffer manager 仍必须带一次性 same-end tail refresh demand，确保 `head -> sync -> body repaint` 闭环成立。
- App foreground resume 的真相只能是：**先 probe/resume 当前 active transport，再决定是否 reconnect**；App 不得再按 UI `session.state` 先分叉，否则会把“label stale but transport alive”误杀成重连。
- foreground/background 的 hidden gate 也必须只有一份真源；若 App 已统一消费 `visibilitychange / resume / appStateChange`，`SessionContext` active tick 不得再自行读取 `document.visibilityState` 做第二份停刷判定。
- foreground false->true 不能只等 active tick；`SessionContext lifecycle` 必须把 active session 送入唯一 `explicit-resume` 入口，和冷启动恢复共用同一 transport owner，否则会重演“杀进程秒连、后台回来卡死”的双路径分裂。
- 若日志出现 `sessionState=reconnecting + ws=null + no pending open intent`，优先判定为 **stale reconnect bookkeeping**，不是“真的还在连”。foreground/explicit refresh 必须允许重新 reconnect；不能让粗粒度 `reconnectInFlight=true` 永久挡住恢复。
- open-tab restore / runtime sync 允许为 persisted tabs **恢复 local runtime shell**：可 `createSession(connect:false)` 做 cold restore / sessionId remap，但**不得**自动打开 daemon session。真正的 daemon open 只能来自显式用户 open/import/resume 动作。
- active re-entry / active tick 若遇到 `closed/error/unavailable` session，生命周期链只能 skip 或读取当前 live transport；**不得**自动 reconnect。foreground resume 不再是独立语义，必须映射成 `explicit-resume`，由唯一 reconnect/open owner 判定是否重新打开 daemon session。
- `adaptive-phone` 是 daemon adaptive width lease，不是 renderer 后处理：
  - client 只上报 measured cols 与 transport heartbeat。
  - daemon 唯一 lease owner 聚合 active adaptive subscribers 的最窄 cols，并请求 tmux `resize-window -x` 进行真实重排。
  - 客户端退出、transport detach、心跳过期后必须重算；最后 lease 过期/消失必须恢复/释放 tmux width ownership。
  - 红测必须覆盖最窄优先、holder 消失重排、最后 lease 过期释放、非 adaptive 不注册 lease，并反向证明只有 adaptive owner 能动 tmux。
- `adaptive-phone` attach/resize 的 invalid cols 必须在进入任何 throwing geometry normalizer 前被显式拒绝：缺失 / NaN / <=0 cols 返回 `adaptive_width_cols_invalid`，daemon 进程必须继续存活。测试 helper 禁止用 `cols || default` 掩盖真实 daemon 的 strict normalizer；invalid-input 红测必须使用 strict normalizer，并最好补真实 WebSocket probe。
- `mirror-fixed` 是 client render crop / pan policy：不得注册 adaptive width lease，不得改变 tmux width。
- `adaptive-phone` 的 tmux side effect 必须单点化：只允许 `terminal-mirror-runtime.ts` 的 adaptive lease owner 执行 `resize-window -x` 和 final release 的 `set-window-option -u window-size`；禁止 daemon-start、renderer、UI、foreground/background、普通 resize/attach 分支散落执行。
- daemon 可以向 tmux 发用户/协议请求（如 `send-keys`、create/kill/rename session），但 adaptive width 不是 tmux 请求。请求结果不能被 daemon 预测写入 mirror truth；`mirror.rows/cols/bufferStartIndex/bufferLines/cursor` 只能由 tmux 回读 / capture owner 写入。
- daemon 存在性检查 / mirror capture / debug probe 只能读取 tmux truth，不得为了客户端显示方便改用户 tmux option。特别禁止 `assertTmuxSessionExists`、control runtime、capture runtime 执行 `set-option ... alternate-screen off` 或其它 window/session option 变更；若历史 daemon 留下 `alternate-screen off`，只能作为一次性现场清理 `set-window-option -u -t <target> alternate-screen`，代码真源必须物理删除副作用并加 gate。
- 若 App 首帧就已经持有现存 `sessions[]`，也必须立刻持久化 `OPEN_TABS / ACTIVE_SESSION`；不能因为“这次不是 restore 分支”就跳过首次回写，否则下次冷启动恢复会拿到陈旧 tab 真相。
- 若现场是**输入区文本对了、但样式和 tmux 不同**，先不要怀疑 local echo。先用回环证明：terminal 可见内容是否只在 `buffer-sync` 后变化；若是，再直接比 **daemon payload 的 prompt/input row `char/fg/bg/flags`**。
- “输入区 / 光标”专项必须至少有一条**红灯门禁**：daemon cursor paint 不得给普通 prompt cell 注入 synthetic reverse style；若这里错，后续任何 IME/renderer 修修补补都会继续假修。
- 若现场出现 **`buffer-sync` 明明持续收到，但 `localRevision/localEndIndex` 长时间不前进、client 反复请求同一 3 屏窗口**，优先查 **client 侧 incoming `buffer-sync` apply 阶段**；收到即更新本地 buffer truth，不要再叠微任务批处理/延迟 flush 第二语义。
- 若现场是“有内容但要等补齐才整屏一起跳出来”，优先判 **renderer / buffer manager 边界错**；正确语义是 gap 先空白，补齐后局部重刷
- `reading-repair` / visible-gap repair 的 client 判重与 in-flight cover **必须纳入当前 `missingRanges` / gap 拓扑语义**；同一 `knownRevision/localWindow/requestWindow` 下，只要可见区 gap 变了，就必须允许再次发 repair。否则现场会出现：页面局部空白，手动上下划一下（viewport 改变）后才补刷。
- `reading-repair` / missingRanges 的 daemon 响应必须是 **连续 authoritative span**，禁止返回“外层 request window 很大，但 `lines` 只包含多个非连续 gap 行”的带洞 payload。若一次请求有多个 gap，响应只能返回从第一个 gap 到最后一个 gap 之间的完整行 span，或未来协议显式拆成多个独立连续 `buffer-sync`；当前 client apply/render 不接受中间带洞窗口，否则会保留旧行并在刷新时闪旧 buffer。
- Android / Mac renderer 的 visible-gap repair demand 必须共用 shared `buildTerminalViewportDemandWithRepair`；平台 view 只传入 local buffer window + gap ranges，不得复制 missingRanges 计算。demand key 必须纳入非空 `missingRanges`，无 gap 时不发送空数组以保持旧 payload 形状。
- Android terminal header 的顶部 inset 必须由 **UI shell 提供单一像素真相**；Header 自己不得再额外叠 `env(safe-area-inset-top)` 做第二份 safe-area 计算。
- terminal 冷启动 / 恢复 tab 时，**最后 active tab 真相只能来自 `ACTIVE_SESSION`**；`ACTIVE_PAGE.focusSessionId` 只描述页面焦点，不得反向覆盖已恢复的 active session。
- foreground resume / tab re-entry 时，若 active session 的 `ws.readyState === OPEN`，**不得仅因后台静默一段时间就直接重连**；必须先用同一条 ws 做 `buffer-head-request` / ping / 必要的 session 状态查询。只有 socket 物理 `close/error`、用户显式 reconnect、或当前 session 已无可用 ws 且属于 `explicit-resume/open`，才允许新建 ws。
- foreground resume / tab re-entry / network online 时，若 active session 仍卡在同一 `CONNECTING` socket 或 pending open intent，**不得因等待预算超时自动 force-replace**。继续等待同一条 pending ws，并把等待状态显式投影到 SessionContext；不能创建第二条 session ws。网络通断事件不是 reconnect 依据，只是触发现有 ws 的协议探测。
- `reconnectRuntime.connecting` / stale reconnect bookkeeping 只是 client 本地编排观测，不是 transport failure truth；foreground resume / tab re-entry / online 不得因为它返回 `reconnect` 或创建第二条 ws，只能显式显示等待或在 socket 物理 close/error 后进入真正 open/reconnect owner。
- `force-replace` API 不属于 lifecycle/probe/input/foreground/online 恢复路径；禁止把 stale activity、missed pong、pong-only、foreground resume、tab re-entry、online 事件映射成 `cleanup old socket -> fresh connect`。物理 close/error 进入唯一 reconnect/open owner，不能由 UI 或 buffer 层清理 live socket。
- 任何 `buffer-head-request` / `buffer-sync-request` 若允许调用方显式传 `ws`，都必须先校验：**该 ws 仍是当前 session 的 active transport socket**；旧 superseded socket 只能被物理关闭或忽略，绝不能继续拿来发 head/range 请求污染当前 transport 真相。
- transport 生命周期门禁不只覆盖 `onopen/onmessage/onerror/onclose`；凡是“旧 ws 回调里继续触发 request/head/probe”的路径，也必须有同样的 active-socket gate，否则 stale transport 仍会在写侧继续推进错误状态。
- 若 tmux capture / mirror canonicalize 链路可能收到 extended-color ANSI（`38:2::r:g:b` / `48:2::r:g:b` / `38:5:n` / `48:5:n`）的 colon 语法，进入 parser 前必须先规范化到当前唯一支持的 semicolon 语法；否则颜色会退回 default sentinel，现场表现就是红/绿背景丢失或发灰。
- transport/session 生命周期若要改，先问自己有没有违反这四条：
  1. 是否又把 per-session ws 当成 transport 真相
  2. 是否又让 reconnect 走 `cleanup old socket -> fresh connect`
  3. 是否又让 inactive tab 关闭 session / transport
  4. 是否又让 daemon 因 ws close / grace timeout 回收 logical session
- 若真机出现**大块灰条/花屏/光标样式乱飞**，优先查 **compact wire 的 default color sentinel** 是否和 `TerminalCell` 真相一致；当前 app/runtime 里的默认前景/背景是 `256/256`，不能在 compact encode/decode 里偷偷改成 ANSI `15/0`。
- 若真机出现**terminal 默认背景和真实终端背景不一致**，优先查 renderer default bg sentinel：`bg=256` 必须绘制为 `theme.background`，不能映射为 `transparent`。row / cell wrap / gap fill 也必须主动 paint terminal theme background，禁止让外层容器或页面背景替代 terminal 背景。
- 若 `bg=256 -> theme.background` 修复后真机仍“无变化”，下一步必须用 WebView DevTools 读取 live `localStorage['zterm:bridge-settings'].terminalThemeId`、`.wterm` computed background、最近可见 row/cell computed background。若 active preset 自身的 `theme.background` 是纯黑，继续改 renderer 是错路；应修 shared theme preset 真源，并用 live DOM 证明 computed background 变化。
- 若真机输入或刷新时**先闪一帧旧 buffer 再被新 buffer 覆盖**，优先查 render gate 是否在 buffer truth 之后又加了 per-session debounce。正确语义是 `buffer-sync apply -> schedule RAF -> RAF 时读取当前 live buffer 一次`；render gate 只做 frame coalescing，不能再消费 network/transport cadence，也不能保存会晚发布的旧 scheduled snapshot。
- 若真机出现**光标颜色不对 / 光标像普通反显文本 / 光标样式污染邻格**，先查 **Android client 是否越权改了 cursor 样式**；renderer 只能回显 payload，不能再造第二套 cursor 视觉语义。
- 若现场看起来像“正文解析错了”，先把 **terminal body** 与 **IME/editor overlay** 分开审；底部灰条/编辑条不属于 daemon buffer truth，不能直接当成 compact wire 正文错误。
- compact wire 的正文门禁必须覆盖 **ANSI + CJK + reverse + bg span + 中间空格**；只有 body parity 红灯以后，才允许改 contract/renderer，禁止凭截图先回退 codec。
- 若 iTerm2 与 ZTerm 出现局部错位/灰块，且混合 ASCII/CJK/色块区域异常，优先查 renderer `measureTerminalViewport()` 的 glyph probe 是否把单个字符测成接近整屏宽；cell 宽度必须拒绝异常整屏测量并回退到字体估算，禁止在页面层补第二份宽度逻辑。
- 网络变化后 App 卡死但杀进程恢复时，先查 lifecycle 是否在前台 `online` 事件恢复 active tab transport；恢复动作只能复用现有 active resume/audit/follow reset 主线，hidden online 不恢复，禁止扫所有 session。
- 若现场是“点击快捷栏空白区弹出输入法 / 键盘起来后快捷栏被盖住”，先判 **UI shell/QuickBar**，不要误把它当成 renderer 或 buffer 问题；必须先补 shell 区域阻断与 keyboard lift 的红灯测试。

## 8. 现场判断口径

看到这些现象，优先判对应层：
- 初次连接慢慢追历史：buffer manager 错
- 输入发出去几分钟不刷新：buffer manager / renderer 通知链错
- reading 一滚就被拉回：renderer mode 错
- 带宽异常大：仍有 snapshot / 整窗重拉 / payload 误裁
- keyboard 影响内容或行数：UI shell 越层
- 收到 head 以后长期不再拉新 buffer：优先查 buffer manager 的 in-flight pull 是否死锁
- `pullHz == 0 && renderHz == 0`：优先查 active tab 首次激活后是否根本没进入 head-first 主循环
- foreground / cold-start 后 active tab 长时间 `connecting` 且 hidden tabs 同时在连：优先查 active-only transport gate 是否被破坏
- Android 若 `ImeAnchor` 已经产生日志，但 client 侧出现 `session.input.queue` 且长期无刷新：先判定为 **active transport 已死**，不是 IME 问题；active tab 在 `resume / switch / input` 这三个动作上，只要发现没有 live ws，就必须立即 reconnect，不能只排队等下一次偶然恢复
- 用户现场若给的是 **ADB device 地址**，不要误判成 daemon 地址；先从 Android WebView localStorage 真源读取当前 `bridgeHost / bridgePort / authToken`，再去打 `/health`、`/debug/runtime`、WebSocket probe
- 若怀疑“是 daemon 慢”，必须补一个 **independent direct daemon probe**：临时 tmux session 上测 `connect -> head -> input -> head change`；如果 direct probe 是几十毫秒，而现场 session 仍是几十秒，就先把 generic daemon 基线排除，转查现场 session / IME / active transport 链路
- 若真机现场出现 `session.buffer.request` 已发出、daemon direct probe 也能直接拿到非空 range，但 APK 仍首屏空白/`R=0`，优先判定为 **client 侧 `buffer-sync -> local apply -> renderer commit` 断链**；先补本地结构化证据，不要再回头怪 daemon
- 若现场出现“本地窗口判断错后直接白屏/大包重拉”，优先判定为 **client 侧越权清空已有 absolute-index buffer truth**；这不是 daemon 问题，也不是 buffer 真丢了，而是 client 把“窗口规划错误”实现成了“truth reset”
- 若 Android 真机出现“未点键盘却前台自动弹 IME”或 IME 在九宫格/QWERTY 间异常切换，优先查 `ImeAnchor` 的 stale show/focus 状态是否跨前后台遗留；**只有显式 keyboard action 才允许 show IME**
- 若现场表现为“**语音/CJK commit 已经发生，但要再补一个字符才刷新**”，优先查两件事：
  1. **same-end 新 revision** 是否被旧的 in-flight tail-refresh 误判成“已覆盖”；同窗同 range 但 `targetHeadRevision` 变了，必须允许重发
  2. `buffer-head.cursor` 是否被 client 丢弃；head 已经带来的 cursor metadata 必须立刻进入本地 truth，不能等下一次 buffer-sync 才纠正高亮/光标
- 若现场表现为“**长输入/语音输入丢字，或语音换行直接执行命令**”，必须把文本语义与传输完整性分开锁：
  1. Android committed text 的 CR/LF 只在 `terminal.keyboard_ime` normalization owner 归一成文本分隔空格；显式 Enter 继续走 editor action / hardware key 独立路径，禁止 daemon、transport、renderer 再过滤语音换行
  2. input wire 在协议协商前保持 string-only；native bridge、client WebSocket frame、daemon frame cap、backend write 各自使用独立 UTF-8 byte budget，禁止把对象 envelope 或 renderer/local echo 当补偿
  3. tmux `send-keys -l` 的 argv 可接受不等于 PTY 长输入稳定；必须用 source SHA-256 与 tmux target file SHA-256 自动比较，并把 byte-exact source/target gate 与 mirror recovery gate 分开
  4. 长 payload 测试要先单独发送 `stty -echo` / sink prelude，并等待 ready marker 后再流式发送 body；禁止把关闭 echo 与大 payload 混在同一 burst 后把回显洪泛误判成 input byte loss
  5. 若 source/target digest 通过而 mirror recovery 失败，归类为 mirror/read-render 恢复故障，不得报告成输入丢字
- 若现场表现为“**偶发先出现错误帧内容，下一帧又恢复正常**”，优先审 **render truth 边界是否持有 live buffer 的可变引用**：
  1. `SessionBufferState -> SessionRenderBufferSnapshot` 必须产出 **immutable render snapshot**
  2. `lines / gapRanges / cursor` 不得把 live buffer 引用直接交给 renderer/store
  3. render store 读取到的只能是独立 render truth；否则后续 patch/merge 复用 row/object 时，会把已准备绘制的上一帧污染成“短暂错帧”
- 若 wire payload 带 `frameChunkCount > 1`，还必须先审 client buffer owner 是否逐 chunk publish：
  1. frame chunk 只允许进入 bounded assembly state，不得直接 commit local buffer 或 schedule renderer
  2. 全部 chunk 必须按 absolute row 验证无洞、无重叠、无冲突，完整覆盖 frame window 后一次 apply/commit/render
  3. 红测必须在每个 chunk 到达后读取 local/render truth，证明完成前始终保持上一完整帧，完成后直接切到新完整帧；禁止只断言最终结果正确
  4. `generatedAt` 只作为 frame identity，不得替代 revision/absolute index 做 freshness 排序
  5. same revision 不同 frame identity 混入时，必须拒绝本次 interleave、清除 poisoned incomplete assembly，并把错误与 exact frame repair range 写入独立 `resource.client_buffer_frame_assembly` truth；repair 未实际写入 wire 时保持 `pending`，只有 dispatch 成功才改为 `dispatched`，每个 revision 最多 dispatch 一次
  6. frame assembly ref 是独立于 sparse buffer 的 client 必需资源；生产 caller 漏注入必须在类型/构建期失败，禁止 optional ref 让 chunk 永久 pending，禁止用 same-resource edge 掩盖 assembly 到 sparse apply 的真实资源边
  7. 较新 frame 尚未完整时，迟到的较低 revision payload 无论是 chunked 还是 unchunked 都必须拒绝且保留较新 pending frame；禁止 passthrough 清掉 assembly 或发布旧 body
  8. frame repair 禁止把非法 revision 修成 `0`；same-revision interleave 只修原 pending frame range。无合法 revision 时等 authoritative live head；成功 repair 后用有界 per-session revision ledger 跨后续成功 revision 保留 dispatch 事实，迟到 malformed payload 不得对旧 revision 二次 dispatch；新 frame supersede 旧 pending frame 时清掉旧 repair error，但保留 ledger
  9. frame assembly 必须服从 shared protocol 的 span/chunk/retained-byte/lifetime 硬上限；body ingress 写 map 前拦截容量越界，buffer-head cadence 主动到期并释放 incomplete frame。禁止把“等下一 chunk/等 session close 清理”当生命周期边界
  10. 查真实 socket 路径中的 wire normalizer；它必须原样保留 authoritative frame identity。新增 frame 字段后只改 protocol/assembly 而漏改 normalizer，会让所有 chunk 被误判成 passthrough，是“单测绿、真机仍闪”的首查项
  11. tab switch、inactive drop、socket generation cleanup、reconnect 只清 incomplete pending chunks；revision-reset expectation、frame error truth 和 bounded repair ledger 在同一 daemon revision epoch 内跨这些生命周期保留。首次 authoritative lower head 是 epoch 边界，必须在任何 repair dispatch 前清 pending/error/ledger；同一 epoch 重复 lower head 不得再次清 ledger；explicit local session destruction 删除两类 resource
- 若现场表现为“**底部固定灰条/固定行在内容更新时持续上移，旧内容没有被当前位置正确替换**”，必须先补 renderer 红测再修：构造同一 absolute row index / 同一 viewport bottom 下行内容发生变化的 case，先证明当前 DOM 复用了旧行或错位上移；红测变绿后把该测试纳入 `TerminalView.dynamic-refresh` / renderer 回归。禁止先凭截图改代码、再补测试。
- 若 renderer/client gate 过了但真机仍出现 **TUI/input 旧行漏刷或上移**，下一步必须测 daemon capture 主入口而不是只测 helper：`captureMirrorAuthoritativeBufferFromTmux()` 必须实际调用稳定化主线，覆盖 transient half-frame 不发布；同一 mirror 的 `totalAvailableLines` 必须以当前 mirror end 为单调下界，避免 alternate-screen 短可见窗口把 absolute tail 拉回 pane height。
- 若现场表现为“**临时错误/短暂不可用导致 tab 自动关闭**”，必须先补 session lifecycle 红测再修：`tmux_session_unavailable` / 网络短断 / handshake 临时失败只能进入 retryable error/reconnect，禁止发 `SESSION_STATUS_EVENT(type='closed')`，也禁止触发 open-tab prune；只有明确 terminal close 语义才允许进入 tab close 链。
- 若现场要排 Android IME 抬高 / 安装升级 timeout，debug 观测链也必须服从唯一真源：只允许 `client snapshot source -> collectClientDebugSnapshot -> active session WS debug-snapshot -> daemon store` 这一条链；禁止再开第二条 relay/debug transport 或散落页面内临时上报。
- `DebugRegistry` duplicate registration 是 fail-fast；测试文件只要 import 真实 `client-debug-snapshot` 并 render 真实 `TerminalPage/App`，`resetClientDebugSnapshotForTests` 与 `cleanup` 就必须放 file scope。把 hooks 放在某个 describe 内会让后续 describe 残留 producer，报 `duplicate debug producer: terminal-page`，此时先修测试隔离，不能把生产 fail-fast 改成静默替换。
- explicit terminal input 不能只依赖 lifecycle/heartbeat 去发现远端回显；input payload 必须同步发出，首个未完成 `pendingInputTailRefresh` 的 `buffer-head` 请求必须放到 coalesced microtask，后续 burst input 在 pending 清除前合并，禁止每键强制刷 head 或把 head 请求绑回 key event stack。
- Android 物理键盘不能依赖 DOM textarea focus 路径；native `ImeAnchor key` 必须直接走 shared terminal keyboard resolver 并写入 active session。plain letter 留给 editable/IME 文本路径，Ctrl/Alt 组合键和方向/Esc 等特殊键走硬件 key path；红测必须让 `allowDomFocus=false` 时 `Ctrl+C` 仍到达 terminal input。
- Android IME 改变 shell geometry 时，IME 只能影响外层容器 / quickbar 位置，不能进入 TerminalView 内容 viewport 计算链；页面层必须冻结 terminal content geometry，禁止用 IME 高度生成 renderer layout refresh / viewport demand，也禁止触发 upstream `onResize` 改 tmux rows。
- 大面积刷新若遇到 revision-gap sparse payload，client 必须拒绝合并错误 sparse body 并请求 authoritative tail；同时应 schedule 当前稳定 local buffer 的 render commit，把已确认 truth 重推给 renderer。禁止把 sparse payload 当 fallback 成功，也禁止等待 tail 期间让 renderer 没有任何稳定帧信号。
- 大面积刷新若是 contiguous sparse tail jump，post-apply visible-gap repair 必须先判断是否已有本地窗口且旧 visible range 是否贴旧 tail：已有窗口且贴旧 tail 代表 follow，应改用新 tail 默认 visible range 查 gap；初始 sparse 首帧或不贴旧 tail 代表 reading/未定，必须保留旧 visible range，禁止吞掉 renderer 后续 reading-gap 请求或把用户历史阅读位置重解释成新 tail。
- 若现场表现为“**能输入但画面停在旧 buffer / session drawer 卡 connecting / 杀 APP 秒连但后台回来不刷**”，先判 client 读链恢复断裂：
  1. WebSocket 是客户端物理 transport，不是 daemon 持有的永久 per-session 真源；daemon 真源是 tmux mirror
  2. `ws.readyState === OPEN` 或 input 可写只证明写路径可用，不证明 `buffer-head -> buffer-sync -> local apply -> render commit` 已恢复
  3. explicit resume / foreground return / active session change 必须 `forceHead + markResumeTail`，即使本地已有旧 buffer
  4. stale pending transport-open bookkeeping 不是 waitable state；唯一 reconnect owner 清 pending intent/control socket 后 rebuild same target，fresh pending 才等待
  5. 禁止在 UI drawer、input runtime、renderer 增加补偿重试；测试锁 `session-context-activity-runtime`、`session-context-lifecycle`、`SessionContext.ws-refresh` 和 architecture boundary gate
- 若现场表现为“抽屉切 session 先显示连接失败、再点一次又能连上”，先审 `terminal.transport_lifecycle` 的 retryable reconnect projection：retryable handshake/control attach failure 和 `scheduleReconnectRuntime()` 的 retryable reconnect start 都只能保持 `reconnecting` 并继续 retry，禁止 `emitSessionStatus(..., 'error')` 投给 UI。只有 nonretryable/auth rejected、auto reconnect explicitly blocked、或显式 retry exhausted 才能投 terminal error；不要在 drawer/UI 加二次过滤。
- 前台恢复 / 自动重连的 `reconnectAttempt` 是标准流程内部计数，不是用户可见故障事实。只要状态仍是 `reconnecting`，顶部只能显示中性进度（如 `正在重连` / `正在同步控制通道`），不得因 attempt 次数、probe timeout、RTC data channel closed 等中间失败显示错误浮窗。只有 offline、typed terminal `error`、auth/nonretryable failure 才能进入错误 banner。
- drawer/tab switch 是显式用户 resume intent，必须一路传到 `SessionContext.switchSession(..., { refreshSource:'explicit-resume' })`。只在 open-tab 层标 `switchRuntime:'explicit-resume'` 不够；如果 provider facade 固定转成 `active-reentry`，同一次用户选择会被拆成两套资源语义。内部 lifecycle active change 才默认 `active-reentry`。
- terminal input 只允许消费当前 `SessionTransportResource.socket` 并同步写入；它不是 reconnect/open-intent owner。禁止在 input runtime 里调用 `reconnectSession`、`probeOrReconnectStaleSessionTransport`、`shouldReconnectQueuedActiveInput` 或 stale pending-open 补偿，也禁止 input owner 直接 `ws.close()` / 替换物理 transport。缺 transport / pending-open / backpressure 必须显式 drop/debug，transport close/replace/reconnect 恢复唯一 owner 是 `terminal.transport_lifecycle`。
- active `buffer-head` 若早于 renderer visible range 到达，buffer owner 必须按 daemon head bounds 直接 bootstrap 当前 tail 的 `buffer-sync` body；默认拉多屏 tail 并受 `availableStartIndex/latestEndIndex` 约束，避免最后一屏为空白时把健康 session 误渲成黑屏。非 active / 无 visible demand 不拉正文。禁止把 renderer layout 当首包前置条件，也禁止用 hidden cache window 冒充 visible fetch window。
- `buffer-head` 只能更新 head/cursor metadata；不得触发正文 render commit。正文 repaint 只来自 `buffer-sync apply`，否则会把旧 body 重新投影成短暂闪屏。
- `buffer-head` 也不得提前清理 pending body request 权威。若 `tail-refresh` / `reading-repair` 的 `buffer-sync-request` 已发出，head 先到、同 revision body 后到是合法顺序；`lastSyncRequestAtRef` 只能由 body apply/drop 路径消费。否则后到 fresh body 会被误判成 unsolicited same-revision stale overwrite，表现为输入框/可见旧行不刷新。
- Buffer timestamp 只许做观测元数据：client request `requestedAt`、daemon response `generatedAt/requestSentAt` 可以进 debug 和黑盒 freshness 证据，但不得替代 `revision + absolute row index` 排序，也不得作为 accept/drop body 的业务真相。
- 若 Android 升级/安装后仍看到旧 terminal/session 内容，先区分 **旧进程残留** 和 **新包冷启动真相**：
  1. `adb install -r` / 系统安装器更新包后，前台旧 WebView 进程可能继续显示旧 JS/runtime projection；这不是 `OPEN_TABS` / `TERMINAL_LAYOUT` 一定复活
  2. 先记录 `dumpsys package` 的 `versionCode/lastUpdateTime`、`pidof com.zterm.android`、`dumpsys window` focus、UI dump 文本；再 `am force-stop` 后冷启动对比
  3. 如果 force-stop 冷启动后旧内容消失，修复 owner 是 native App update process handoff：系统安装器拉起后旧 App 进程必须退出；禁止清 `app_webview` / Local Storage / `OPEN_TABS` 当 workaround
  4. `adb install` 冷启动只证明新 APK 可运行，不证明 App 内 `AppUpdatePlugin.downloadAndInstall()` handoff 已闭环；必须单独验证插件路径或明确 L5 缺口
- 若 Android 滚到历史区后点击键盘无法唤出 IME，先审 input intent -> renderer follow 边界：
  1. terminal click / quickbar keyboard show / blur-to-keyboard 必须先让 renderer 回到底部 follow，再调用 native IME show/focus
  2. IME 显隐决策必须读取 native `ImeAnchor.getState()/keyboardState` 的 `keyboardVisible`，不要用本地 requested flag 或 inset 猜
  3. IME 只移动 QuickBar/UI shell，不改变 TerminalView 内容 stage，不触发 upstream resize，不改 tmux rows/cols
  4. 真机脚本必须确认 app surface 可见；keyguard/SystemUI 拥有焦点时只能标 L5 阻塞
- `mirror-fixed` 横向滑动只能是 renderer projection：`.term-grid` 可按 session 记住水平 offset 并做 `translateX(-offset)`；禁止把横滑映射成 daemon resize、tmux width change、adaptive lease 或 buffer/mirror truth 修改。`adaptive-phone` 不响应横向 pan，它的宽度变化只走 daemon adaptive lease owner。
- `mirror-fixed` 横向手势归属：只有 offset 已为 0 且起点在左缘热区内的右滑可交给 drawer；positive offset 右滑、非左缘右滑、右侧/中间横滑都必须由 `TerminalView` 消费并 `stopPropagation()`，即使 offset 已经被 clamp 到 0、视觉上不能继续移动。禁止只 `preventDefault()` 后让父层 `touchend` 解析成 drawer `previous`。

## Session preview truth

- 多终端快捷预览只能是 UI projection：数据链必须保持 `tmux -> daemon mirror -> client sparse buffer -> immutable render store -> shared TerminalView -> preview DOM`。
- 禁止 preview 自建 ANSI/cell/cursor parser、截图/文本 cache、transport/reconnect、resize、viewport writeback、width-mode write、tmux geometry write 或 buffer reset。
- Preview tile 必须把 `TerminalView` 作为 read-only shared renderer 使用：`active=false`、`live=true`、无 input/resize/viewport callbacks、`allowDomFocus=false`、`mirror-fixed`。
- Secondary preview 的每行必须是同一 passive row 投影：复用共享 `terminalCellStyle()`/row view-model，按相同 style run 聚合成少量 span，保留 ANSI fg/bg/flags；禁止退回纯文本 `theme.foreground` 或另写第二套 color parser。
- Preview selection 持久化时必须存完整 open-session identity，并在恢复时至少匹配 `sessionId + bridgeHost + bridgePort + sessionName`，有 `daemonHostId` 时也必须匹配；stale target 是失效选择，不是隐式 open/reconnect intent。
- Preview 打开才允许把 selected ids 临时加入 body subscription live set；关闭/后台必须回到 baseline。黑盒 gate 必须自动比较 tmux source、daemon/client sparse truth、render store 和 preview DOM，并验证 subscriber lifecycle。
- App foreground truth 是唯一的 preview/body-demand 输入；后台态必须把 preview 选中集拉回 baseline，不能继续维持额外 body subscription、视频解码或轮询。任何 offscreen 重媒体流都必须由同一个 foreground gate 停掉，禁止再长出第二套后台 timer/observer 补偿。
- Android 原生后台服务只允许作为平台执行支持：Activity 停止且 retained sessions 存在时，可持有通知面与一个进程级 `PARTIAL_WAKE_LOCK`（保留 `WAKE_LOCK` 权限）供现有 control-plane / target-transport owner 做低频心跳；必须保持 bounded lifecycle，`sessionCount <= 0` / stop 即 release 并 `stopForeground(true)` / `stopSelf()`。它禁止拥有 socket、route、session truth，禁止请求忽略电池优化权限，禁止替 transport owner 开/建连接、做 body/video 订阅或后台保活。
- Preview tile activation 必须走唯一 page owner：先把目标 session 投进当前 focused session-group slot，再发 active-session switch。只切 active session 不改 viewport projection，会让输入/live 到新 session、真实 shell 仍显示旧 center session；preview 关闭后旧 center 不再 live，表现为“preview 刷新但进入 shell 不刷新”。
- Source-to-shell 黑盒 gate 必须覆盖 preview grid -> real `TerminalStageShell` 替换后继续刷新：选中 session 新 marker 出现在真实 shell DOM，旧 session marker 被排除，物理 socket 不重建，subscribers 恢复 baseline。
- Preview tile 长按替换只改 ordered selection：420ms 长按必须有移动阈值，触发或移动后都要抑制 synthetic click；菜单只列当前 open 且未选中的 session，替换保持原 slot 顺序。禁止借替换触发 active switch、socket open owner、buffer reset 或 renderer 写入。
- Preview 打开时由 mode owner 捕获 entry `{ activeSessionId, slotIds, focusSlot }`。关闭按钮、右滑退出、Android system Back 都走唯一 cancel owner 并恢复该快照；tile tap activation 必须先清除快照再执行显式 switch。Back listener 只在 preview open 生命周期注册。

## 2026-06-29 buffer publish short-circuit

- 当“大面积刷新后空白、滚一下又恢复”时，优先查 `commitBuffer()` 是否把 live buffer 引用直接塞进 store 并被引用短路。
- 真源规则：store 必须存不可变快照，commit 只能按内容判等，不能靠对象引用判等；否则上游原地 mutate 会让正文刷新静默失效。

## 2026-06-29 Windows WezTerm backend boundary

- WezTerm mux 可作为 Windows buffer source，但 `wezterm cli` 输出不是 daemon truth；ZTerm adapter 必须把 `get-text --escapes` 转成自己拥有的 absolute mirror snapshot 后才允许进入 buffer-sync 链。
- WezTerm cursor 不在 `get-text --escapes` 正文里；Windows backend 必须从 `wezterm cli list --format json` 读取 `cursor_x/cursor_y/cursor_visibility`，并作为独立 metadata 进入 mirror snapshot / `buffer-head.cursor`。
- `wezterm cli --prefer-mux send-text --pane-id <id> --no-paste` 只允许通过 stdin 写真实 terminal input，禁止把用户输入塞进 shell args；已验证 Enter / Backspace / arrow escape / raw TUI / Codex TUI text entry。
- WezTerm backend 是显式 backend selection，不是 tmux fallback；Windows 默认 `wezterm`，非 Windows 默认 `tmux`，未知 backend 必须显式报错。
- 已知限制：ETX/Ctrl+C 可送到 raw-mode/TUI，但不能当作 Windows console control event 中断 `cmd.exe` 子进程；不要宣称完整键盘等价。

## 2026-08-14 Terminal Source Adapter Boundary

- daemon mirror 只消费统一 `TerminalSourceAdapter.readSnapshot()` 产出的
  `TerminalSourceMirrorSnapshot`；mirror 主链禁止散点执行 tmux/Herdr/WezTerm
  source 命令，source 差异全部收口到 adapter。
- adapter snapshot 必须携带 daemon-owned absolute range / geometry / cursor
  metadata；absolute range 只能来自 adapter/source-side canonicalizer，禁止用
  内容 overlap / repeated text 推断 anchor。
- 未知/不支持 source 必须显式失败；禁止把 unknown source 默认落到 tmux。
- adapter 只承载 daemon source 侧事实，禁止把 client viewport/follow/reading/
  active tab/foreground 带进 daemon 或 adapter。
- adapter snapshot 的 `revision` 只是 source-side 信息字段；zterm
  `mirror.revision` 由 `daemon.mirror_store` 的 runtime scheduling owner 唯一
  推进，禁止让 source revision 直接变成 zterm revision broadcast，也禁止
  `daemon.mirror_writer` 推进 revision。
- validated source capture 与 authoritative mirror snapshot commit write 由
  `daemon.mirror_writer` 唯一执行；`resource.mirror_store` 仍是 canonical
  mirror truth / revision / runtime scheduling 的唯一 owner。adapter 只是把
  source readback 归一成 mirror snapshot，不新增第二真源或第二 writer。

## 2026-08-14 Herdr History + Live Latency Boundary

- Herdr history truth 是官方 `pane read <pane_id> --source recent --lines
  <min(terminalCacheLines,1000)> --format ansi --raw` 的 adapter-owned tail
  snapshot；canonical frame 仍只提供 live visible rows / cursor / geometry /
  cursorKeysApp / alternateScreen。
- `pane get.scroll` 的 `maxOffsetFromBottom + viewportRows` 只作为 source
  total-row hint 推进 daemon-owned tail window；禁止把它当成 absolute line
  identity，禁止用内容 overlap 推断 index。
- per-session `sourceEndIndex` 只单调增长，`bufferStartIndex` 必须等于
  `sourceEndIndex - bufferLines.length`，`availableStartIndex` 同
  `bufferStartIndex`；Herdr 0.8.0 只能提供最近 1000 行，禁止本地拼接或
  滚动遍历伪造更早历史。
- host 在底部且 frame geometry 与 history geometry 匹配时，才允许用 live
  visible rows 替换 merged buffer 尾部；host scrolled 时不得 overlay，cursor
  必须显式 null，并立即触发下一次 history 刷新。
- history 刷新必须低频（默认 1000ms；attach / host scroll / geometry change
  立即），`pane read` 1000 行禁止进入 33ms loop；live frame 到达通过
  `onLiveActivity` 唤醒 mirror live sync，无 body subscriber 时由现有
  `scheduleMirrorLiveSync` 停止，不产生空转。
- `pane read` 失败或返回空必须显式失败，禁止 frame-only 24 行兜底；官方
  1000 行上限写入显式 capability gap `herdr-history-limit-1000`。
- `pane get` scroll metrics 从每帧同步读取改为低频节流（默认 100ms），
  metrics 读取失败不得丢弃 frame。

## 2026-08-14 Visible Repair Ledger

- visible non-gap repair 必须按
  `sessionId + visibleRange + tailEndIndex + targetRevision` 维护 per-session
  ledger：`pending -> dispatched -> fulfilled`，`dispatched` 超时未收到完整
  visible-window authoritative response 可再次 dispatch，但不能无限放大。
- repair 未实际写入 wire 时保持 `pending`；send-fail/no-socket 不清 ledger。
- 只有覆盖完整 visible range 的 body apply、显式 session cleanup、或
  authoritative revision epoch reset 才允许清除/fulfill。
- 禁止用全局 `gapRanges` 或 `localRevision == daemonHeadRevision` 代替行级
  freshness；sparse 后续 revision 不得掩盖旧 non-gap visible 行。
- fulfilled / superseded 是历史账目，不得抑制新的 repair demand；只有 active
  `pending` / `dispatched` 且未超过 stale timeout 才在重发窗口内抑制，否则后续
  sparse demand 必须创建新 ledger entry 继续收敛。
- 完整 authoritative body apply 只精确 fulfill 仍 active 的 ledger entry：按
  entry 自身 `targetRevision` 标记 fulfilled，不创建以 response revision 为
  key 的合成 entry；`payloadRevision >= entry.targetRevision` 且 payload
  连续覆盖 entry 的 request range 才满足。
- 红测必须覆盖：repair 丢失后仍收敛、repair 响应不完整仍 pending、
  full response 只 clear 一次、unchanged visible rows 不 spam、fulfilled 后
  新 sparse demand 不被旧账目永久压住。

## 2026-08-14 Daemon Input Queue Boundary

- `daemon.input_queue` 唯一 owner 是
  `src/server/daemon-input-queue-runtime.ts`；receive validation、byte cap、
  stale/session-required retryable nack、seq dedupe、enqueue/dispose、
  backend write ordering 都在该文件加
  `src/server/terminal-reliable-input-ack.ts`。
- `terminal-message-runtime.ts` 只把 `input` 和 plain-text 帧转给 queue
  owner；`terminal-control-runtime.ts` 只向 queue 暴露
  `writeBackendInputGroup` / chunk budget，不再持有 queue internals。
- queue 是唯一 daemon 输入写后端路径；mirror runtime 的 live input 也走同一
  enqueue/dispose owner。禁止其他 handler 直接写 tmux/backend input。
- 必须保持：payload 仍 string-only；stale/session-required 保留 retryable
  nack；invalid/oversize 非 retryable；duplicate seq 不得重复写；coalescing/
  顺序/chunk sizing/append-enter 边界不变；detach/close/destroy 必须 dispose
  queued input。
- 红测：`daemon-input-queue-runtime.test.ts`、
  `terminal-message-runtime.test.ts`、
  `terminal-control-runtime.input-queue.test.ts`、mirror/backpressure/
  detached-session 回归。

## 9. Android copy-mode gate
- WebView copy-mode 长按有两层 native gate：`setOnLongClickListener(v -> true)` 只管系统 ActionMode / 工具栏，`setLongClickable(false)` 才会停掉原生 haptic / selection 拦截，让 JS `onTouchStart` 的长按计时器真正启动。
- copy 菜单不出时，先查 native long-clickability，再查 DOM touch 事件链，最后才看 React 菜单状态。
- DOM 层仍负责 `preventDefault` / `stopPropagation`，但不能指望它单独压住 Android 原生长按行为。

## 2026-06-01 多 pane closeout 精华
- 多 pane UI 对齐必须查“生产入口真源”：Mac 当前真实入口是 `ShellWorkspace`，不要只测未接入入口组件；packaged smoke 必须用进程路径证明启动的是 `mac/out/.../ZTerm.app`。
- Android 接 shared PaneTabs/PaneStage 时，不得丢旧交互合约：header padding、close aria/touch、relay badge button、横向 touch-scroll 抑制、inactive pane first-frame viewport demand 都要进红测。

## 2026-06-01 iTerm2-style split correction
- 多 pane / split 需求不得再按 flat horizontal panes 验收；正确真源是 split tree（leaf pane + row/column split node + ratio）。Mac packaged smoke 也必须验证横/竖嵌套 split 可见和分隔线可拖拽，而不是仅看到多个列。

## 2026-07-12 terminal layout ownership correction

- terminal 内容排版唯一真源是 tmux/mirror capture：`mirror.rows/cols/bufferStartIndex/bufferLines/cursor` 只能由 tmux capture/readback owner 写入。
- client 不做 terminal 内容排版：TerminalView / renderer / UI shell 只消费 mirror rows/cols/buffer truth，负责裁切、显示、输入、viewport demand；不得根据输入次数、IME、WebView 测量、container resize、`viewportCols` 或 active/focus 状态重排 terminal content。
- 进入 session 后如果看不到之前 buffer，先查 `attach/resume -> tmux geometry/head -> buffer-head -> buffer-sync -> local apply` 首包链路；不要在 renderer 层用 CSS wrap、row background、scrollbar、border、默认 theme、synthetic cols/rows 或 forced layout key 去“修排版”。
- `adaptive-phone` 也不是 client 本地排版：正确链路只能是 client 上报 measured cols -> daemon adaptive lease owner 请求 tmux reflow -> tmux capture/readback 更新 mirror truth -> client 固定行高渲染。
- 反模式：把 `viewportCols` / `widthMode` 放进 render geometry revision key、无 tmux truth 时补 80 cols、修改 shared renderer row/cell/theme 背景来掩盖旧 buffer 或空 buffer、用 UI border/scrollbar/IME 变化触发 terminal content geometry refresh。
- 红测要求：session enter / drawer switch / explicit resume 必须证明 first `buffer-head-request` 到达当前 active resource，head 后按 tmux `availableStartIndex/latestEndIndex/rows` 拉 `buffer-sync`；renderer 测试只证明消费 fixed mirror truth，不证明或制造排版。
