---
name: terminal-buffer-truth
description: "terminal buffer / render / daemon mirror 真源与门禁"
---

# terminal-buffer-truth

## 适用场景
- terminal buffer / render / scroll / input 延迟问题
- 出现“初次连接慢、输入不刷新、reading 拉不动、回到底部不 follow、带宽异常”
- 任何想在 server / buffer manager / renderer 之间加补丁、fallback、第二语义的时候

## 开发前置门禁：先架构，后代码

任何 terminal / session / daemon / buffer / renderer 相关开发、修复、重构，必须先完成架构映射，再读代码和修改代码。

固定顺序：
1. 先读 `android/docs/architecture.md`
2. 再读 `android/docs/audits/2026-07-02-architecture-boundary-remediation.md`
3. 再读本 skill 与相关 decision / feature registry / function map
4. 再读代码定位 owner 与实现点
5. 写出本次方法如何对应架构后，才允许修改代码

修改前必须明确：
- 本次问题属于哪个功能块：session lifecycle / daemon truth / client buffer-render / UI projection / persistence truth
- 唯一 owner 文件或模块是谁
- 当前越界处理方式是 **物理移除 / 分离下沉 / 显式兼容保留** 哪一种
- 哪些路径允许修改，哪些路径禁止修改
- 正向测试和反向测试分别锁住什么风险
- 若涉及 daemon / tmux / mirror / transport 主链，且本机可启动真实 daemon 与 tmux，必须跑真实闭环验证；只跑单测、typecheck、静态 gate 不得宣称完成。默认命令：`pnpm --dir android run daemon:mirror:close-loop`。
- 若仓库内 Mac client 可用，还必须跑 Mac 客户端核心连接 gate，证明本地 client transport/runtime 能连；daemon-only probe 不能替代。默认最小命令：`pnpm --dir mac test -- --reporter dot` 与 `pnpm --dir mac run type-check`，其中必须覆盖 `bridge-transport`、`local-tmux-transport`、`terminal-runtime`、workbench active target。

禁止事项：
- 禁止先 grep 到命中点就直接 patch
- 禁止在非 owner 层补偿 owner 层问题
- 禁止用 fallback / 默认值 / catch 后继续成功 来掩盖真源缺失
- 禁止 UI / App / daemon 任一层替其它层维护第二份状态机

## 冻结角色边界

```text
tmux truth
  -> daemon server
  -> client buffer manager
  -> renderer
  -> UI shell
```

四层只允许单向依赖，禁止越层漂移。

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

### L4 app shell / UI 行为 gate
- 证明：页面入口、tab/split/drawer/IME/layout 等 UI shell 行为在测试环境中按语义工作。
- 不证明：安装包、真实 WebView、真实 Electron packaged app 一定一致。
- 要求：若问题发生在容器、IME、drawer、pane、renderer 可见窗口，不允许只跑 daemon 或 transport gate。

### L5 packaged / device / real app smoke
- 证明：真实 app 入口、打包产物、设备/桌面运行态按用户路径工作。
- Android：APK 构建/安装态/真实 daemon debug 或真机 evidence。
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
- mirror 写侧也不得再拆第二语义：
  - 不允许 `history capture + visible capture + concat`
  - 只允许 **single-capture -> canonicalize -> mirror store**
  - 若 tmux 正在中间刷新，writer 必须执行 **连续一致才发布**：只有连续两次 canonical snapshot 一致，或已与当前 mirror 一致，才允许写 mirror；不稳定必须显式报错
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
- daemon live 性能调度只允许消费 daemon 自己的物理事实：
  - mirror capture/canonicalize duration
  - transport kind / readyState / buffered bytes / send error
  - subscriber transport count
  - daemon failure/backoff fact
  - 禁止消费 `active tab / foreground / follow / reading / visible range / viewport / pane layout`
- daemon 不得长期保存 client width policy：`widthMode`、`adaptiveCols`、`terminalWidthMode`、`requestedAdaptiveCols` 只能作为兼容 wire 入参被读取，不能写入 `TerminalSession` / `SessionMirror`，也不能反向触发 tmux `resize-window` / `window-size latest` ownership。
- 好网 fast lane 与弱网 slow lane 必须由红测锁定；性能 trace 只记录 timestamp/duration/bytes/line count/id/kind 这类 metadata，禁止记录真实 terminal payload 内容。
- `buffer-head` 只允许更新 head metadata / cursor metadata / planner 输入
- **只有 `buffer-sync apply` 可以触发正文 body repaint**
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

### 2.1 本地 buffer 真相
- 本地维护一个 sliding buffer，客户端默认/最大保留 **1000 行**
- 按绝对行号存储
- 可以是 sparse，不要求永远连续
- 历史超出窗口后滑走，但**不是单次 payload 来了就把本地历史裁掉**
- **已有 absolute-index 内容不能因为窗口判断错误而被逻辑清空**
- **同 revision 的迟到旧 payload 不得把本地窗口重新锚回更老的位置**
  - 它只允许 patch 当前 1000 行窗口内的 absolute-index truth
  - 不允许因为晚到的 prepend / reading repair 响应，把 follow 中已经稳定的 tail window 拖回去

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
3. 若本地为空、失真，或离 head **超过 3 屏**：
   - 直接请求 **head 往回 3 屏**
   - 移动本地 sliding window 到最新尾部
   - **中间缺口不补**
4. 若离 head 不远：
   - 只补 diff

补充冻结：
- **三屏请求窗口** 和 **1000 行本地缓存上限** 是两个独立真相，禁止再用同一个 `cacheLines` 语义混写两者

### 2.3 reading 路径
- reading 不改变 buffer manager 的 head-first 主循环
- buffer manager 不持有 `follow / reading / renderBottomIndex`
- 它只接收 renderer 声明的 **当前 visible range**
- 若当前 visible range 三屏内不连续，buffer manager 才请求 gap
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
- sparse `buffer-sync` 只能建立在连续 revision 基线上：
  - 若 client local revision 跳过 daemon 中间 revision，且 incoming payload 没覆盖完整 `[startIndex,endIndex)` 窗口，client 不得把该 sparse diff 合并成本地 body truth
  - 正确动作是拒绝这次 sparse body apply，清 tail-refresh debounce，并请求当前 authoritative tail window
  - 否则旧行会作为“未覆盖但保留”的本地 truth 永久存在，表现为大面积刷新时旧内容跟着 buffer 上移
- `buffer-sync` 的 in-flight / pull bookkeeping 只是 **transport bookkeeping**，不是 buffer truth；active tab 重新进入、resume、reconnect 时不得让旧 bookkeeping 永久挡住新的 head-first 请求链
- session transport 的**活性真相**不能只看 `session.state === connected` 或 `WebSocket.readyState === OPEN`；active tab 恢复 / 重新进入时，若没有新的 head / range / pong 进展，就必须判定旧 transport 已失活并重建
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
- 申请的是“reading head 往回 3 屏”的渲染窗口
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
- foreground false->true 不能只等 active tick；`SessionContext lifecycle` 必须拥有唯一 `active-resume` 入口，并立刻对 active session 做 `ensureActiveSessionFresh(active-resume)`，否则会重演“前台 UI 活了，但 transport 没恢复”的假连通。
- 若日志出现 `sessionState=reconnecting + ws=null + no pending open intent`，优先判定为 **stale reconnect bookkeeping**，不是“真的还在连”。foreground/explicit refresh 必须允许重新 reconnect；不能让粗粒度 `reconnectInFlight=true` 永久挡住恢复。
- open-tab restore / runtime sync 允许为 persisted tabs **恢复 local runtime shell**：可 `createSession(connect:false)` 做 cold restore / sessionId remap，但**不得**自动打开 daemon session。真正的 daemon open 只能来自显式用户 open/import/resume 动作。
- active re-entry / active tick / foreground resume 若遇到 `closed/error/unavailable` session，生命周期链只能 skip 或 probe 当前 live transport；**不得**自动 reconnect。只有显式 open / explicit resume 才允许重新打开 daemon session。
- `adaptive-phone` 的 upstream geometry 真相只能是 **client-owned latest cols**；attach/reconnect 可带 cols，但**不得**带 runtime rows。daemon 只消费 cols，rows 继续取 tmux/mirror baseline。
- `adaptive-phone` 的 upstream width owner 只能是 **daemon**：
- `adaptive-phone` 做过 `resize-window -x` 之后，tmux 会把目标 window 置为 `window-size=manual`；当最后一个 adaptive subscriber 断开时，daemon 必须显式释放回 `window-size=latest` 并刷新 mirror baseline，否则 session 会永久卡在历史的 `80x24/56x24` 一类旧高度。
  - 更关键：**只改 `-x` 并不等于“只改宽”**。真实 tmux 语义下，`resize-window -x` 一旦把 window-size 切到 `manual`，后续更高的 client attach 也不会再自动抬高 rows；高度会一起冻结在进入 manual 那一刻的值。
  - 所以凡是用户现场看到“我们明明没写 rows，但 session 高度一直很矮”，优先判定为 **当前 adaptive width 实现通过 tmux manual 模式间接冻高**，不是单纯遗留脏数据。
  - client 只能上报自己最新实测 `cols`
  - daemon 只允许在所有活着的 `adaptive-phone` 连接里取 **最小 cols**
  - 连接断开 / attach 迁移 / close 后必须立刻重算
  - daemon upstream resize **永远禁止写 rows**；tmux 高度不属于这条链路
- 若 App 首帧就已经持有现存 `sessions[]`，也必须立刻持久化 `OPEN_TABS / ACTIVE_SESSION`；不能因为“这次不是 restore 分支”就跳过首次回写，否则下次冷启动恢复会拿到陈旧 tab 真相。
- 若现场是**输入区文本对了、但样式和 tmux 不同**，先不要怀疑 local echo。先用回环证明：terminal 可见内容是否只在 `buffer-sync` 后变化；若是，再直接比 **daemon payload 的 prompt/input row `char/fg/bg/flags`**。
- “输入区 / 光标”专项必须至少有一条**红灯门禁**：daemon cursor paint 不得给普通 prompt cell 注入 synthetic reverse style；若这里错，后续任何 IME/renderer 修修补补都会继续假修。
- 若现场出现 **`buffer-sync` 明明持续收到，但 `localRevision/localEndIndex` 长时间不前进、client 反复请求同一 3 屏窗口**，优先查 **client 侧 incoming `buffer-sync` apply 阶段**；收到即更新本地 buffer truth，不要再叠微任务批处理/延迟 flush 第二语义。
- 若现场是“有内容但要等补齐才整屏一起跳出来”，优先判 **renderer / buffer manager 边界错**；正确语义是 gap 先空白，补齐后局部重刷
- `reading-repair` / visible-gap repair 的 client 判重与 in-flight cover **必须纳入当前 `missingRanges` / gap 拓扑语义**；同一 `knownRevision/localWindow/requestWindow` 下，只要可见区 gap 变了，就必须允许再次发 repair。否则现场会出现：页面局部空白，手动上下划一下（viewport 改变）后才补刷。
- Android / Mac renderer 的 visible-gap repair demand 必须共用 shared `buildTerminalViewportDemandWithRepair`；平台 view 只传入 local buffer window + gap ranges，不得复制 missingRanges 计算。demand key 必须纳入非空 `missingRanges`，无 gap 时不发送空数组以保持旧 payload 形状。
- Android terminal header 的顶部 inset 必须由 **UI shell 提供单一像素真相**；Header 自己不得再额外叠 `env(safe-area-inset-top)` 做第二份 safe-area 计算。
- terminal 冷启动 / 恢复 tab 时，**最后 active tab 真相只能来自 `ACTIVE_SESSION`**；`ACTIVE_PAGE.focusSessionId` 只描述页面焦点，不得反向覆盖已恢复的 active session。
- foreground resume / tab re-entry 时，若 active session 的 `ws.readyState === OPEN`，**不得仅因后台静默一段时间就直接重连**；必须先 probe 并复用现有 transport，只有 probe 超时/close/error 后才允许 reconnect。
- foreground resume / tab re-entry 时，若 active session 仍卡在同一 `CONNECTING` socket 或 pending open intent，不能沿用通用 5s+ handshake 等待。active resume / active reentry / explicit resume 只能短等（当前 1200ms），超过预算由 SessionContext transport owner force-replace；普通首连和 active tick 不得用这条短预算抢占，避免重复开 socket。UI 状态必须来自 SessionContext 的真实 `state/lastError`，不能在页面层伪造等待提示。
- 任何 `buffer-head-request` / `buffer-sync-request` 若允许调用方显式传 `ws`，都必须先校验：**该 ws 仍是当前 session 的 active transport socket**；旧 superseded socket 只能被物理关闭或忽略，绝不能继续拿来发 head/range 请求污染当前 transport 真相。
- transport 生命周期门禁不只覆盖 `onopen/onmessage/onerror/onclose`；凡是“旧 ws 回调里继续触发 request/head/probe”的路径，也必须有同样的 active-socket gate，否则 stale transport 仍会在写侧继续推进错误状态。
- 若 tmux capture / mirror canonicalize 链路可能收到 extended-color ANSI（`38:2::r:g:b` / `48:2::r:g:b` / `38:5:n` / `48:5:n`）的 colon 语法，进入 parser 前必须先规范化到当前唯一支持的 semicolon 语法；否则颜色会退回 default sentinel，现场表现就是红/绿背景丢失或发灰。
- transport/session 生命周期若要改，先问自己有没有违反这四条：
  1. 是否又把 per-session ws 当成 transport 真相
  2. 是否又让 reconnect 走 `cleanup old socket -> fresh connect`
  3. 是否又让 inactive tab 关闭 session / transport
  4. 是否又让 daemon 因 ws close / grace timeout 回收 logical session
- 若真机出现**大块灰条/花屏/光标样式乱飞**，优先查 **compact wire 的 default color sentinel** 是否和 `TerminalCell` 真相一致；当前 app/runtime 里的默认前景/背景是 `256/256`，不能在 compact encode/decode 里偷偷改成 ANSI `15/0`。
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
- 若现场表现为“**偶发先出现错误帧内容，下一帧又恢复正常**”，优先审 **render truth 边界是否持有 live buffer 的可变引用**：
  1. `SessionBufferState -> SessionRenderBufferSnapshot` 必须产出 **immutable render snapshot**
  2. `lines / gapRanges / cursor` 不得把 live buffer 引用直接交给 renderer/store
  3. render store 读取到的只能是独立 render truth；否则后续 patch/merge 复用 row/object 时，会把已准备绘制的上一帧污染成“短暂错帧”
- 若现场表现为“**底部固定灰条/固定行在内容更新时持续上移，旧内容没有被当前位置正确替换**”，必须先补 renderer 红测再修：构造同一 absolute row index / 同一 viewport bottom 下行内容发生变化的 case，先证明当前 DOM 复用了旧行或错位上移；红测变绿后把该测试纳入 `TerminalView.dynamic-refresh` / renderer 回归。禁止先凭截图改代码、再补测试。
- 若现场表现为“**临时错误/短暂不可用导致 tab 自动关闭**”，必须先补 session lifecycle 红测再修：`tmux_session_unavailable` / 网络短断 / handshake 临时失败只能进入 retryable error/reconnect，禁止发 `SESSION_STATUS_EVENT(type='closed')`，也禁止触发 open-tab prune；只有明确 terminal close 语义才允许进入 tab close 链。
- 若现场要排 Android IME 抬高 / 安装升级 timeout，debug 观测链也必须服从唯一真源：只允许 `client snapshot source -> collectClientDebugSnapshot -> active session WS debug-snapshot -> daemon store` 这一条链；禁止再开第二条 relay/debug transport 或散落页面内临时上报。
- explicit terminal input 不能只依赖 lifecycle/heartbeat 去发现远端回显；input payload 必须同步发出，首个未完成 `pendingInputTailRefresh` 的 `buffer-head` 请求必须放到 coalesced microtask，后续 burst input 在 pending 清除前合并，禁止每键强制刷 head 或把 head 请求绑回 key event stack。
- Android 物理键盘不能依赖 DOM textarea focus 路径；native `ImeAnchor key` 必须直接走 shared terminal keyboard resolver 并写入 active session。plain letter 留给 editable/IME 文本路径，Ctrl/Alt 组合键和方向/Esc 等特殊键走硬件 key path；红测必须让 `allowDomFocus=false` 时 `Ctrl+C` 仍到达 terminal input。
- Android IME 改变 shell geometry 时，IME 只能影响外层容器 / quickbar 位置，不能进入 TerminalView 内容 viewport 计算链；页面层必须冻结 terminal content geometry，禁止用 IME 高度生成 renderer layout refresh / viewport demand，也禁止触发 upstream `onResize` 改 tmux rows。
- 大面积刷新若遇到 revision-gap sparse payload，client 必须拒绝合并错误 sparse body 并请求 authoritative tail；同时应 schedule 当前稳定 local buffer 的 render commit，把已确认 truth 重推给 renderer。禁止把 sparse payload 当 fallback 成功，也禁止等待 tail 期间让 renderer 没有任何稳定帧信号。
- 大面积刷新若是 contiguous sparse tail jump，post-apply visible-gap repair 必须先判断是否已有本地窗口且旧 visible range 是否贴旧 tail：已有窗口且贴旧 tail 代表 follow，应改用新 tail 默认 visible range 查 gap；初始 sparse 首帧或不贴旧 tail 代表 reading/未定，必须保留旧 visible range，禁止吞掉 renderer 后续 reading-gap 请求或把用户历史阅读位置重解释成新 tail。

## 2026-06-29 buffer publish short-circuit

- 当“大面积刷新后空白、滚一下又恢复”时，优先查 `commitBuffer()` 是否把 live buffer 引用直接塞进 store 并被引用短路。
- 真源规则：store 必须存不可变快照，commit 只能按内容判等，不能靠对象引用判等；否则上游原地 mutate 会让正文刷新静默失效。

## 2026-06-29 Windows WezTerm backend boundary

- WezTerm mux 可作为 Windows buffer source，但 `wezterm cli` 输出不是 daemon truth；ZTerm adapter 必须把 `get-text --escapes` 转成自己拥有的 absolute mirror snapshot 后才允许进入 buffer-sync 链。
- WezTerm cursor 不在 `get-text --escapes` 正文里；Windows backend 必须从 `wezterm cli list --format json` 读取 `cursor_x/cursor_y/cursor_visibility`，并作为独立 metadata 进入 mirror snapshot / `buffer-head.cursor`。
- `wezterm cli --prefer-mux send-text --pane-id <id> --no-paste` 只允许通过 stdin 写真实 terminal input，禁止把用户输入塞进 shell args；已验证 Enter / Backspace / arrow escape / raw TUI / Codex TUI text entry。
- WezTerm backend 是显式 backend selection，不是 tmux fallback；Windows 默认 `wezterm`，非 Windows 默认 `tmux`，未知 backend 必须显式报错。
- 已知限制：ETX/Ctrl+C 可送到 raw-mode/TUI，但不能当作 Windows console control event 中断 `cmd.exe` 子进程；不要宣称完整键盘等价。

## 9. Android copy-mode gate
- WebView copy-mode 长按有两层 native gate：`setOnLongClickListener(v -> true)` 只管系统 ActionMode / 工具栏，`setLongClickable(false)` 才会停掉原生 haptic / selection 拦截，让 JS `onTouchStart` 的长按计时器真正启动。
- copy 菜单不出时，先查 native long-clickability，再查 DOM touch 事件链，最后才看 React 菜单状态。
- DOM 层仍负责 `preventDefault` / `stopPropagation`，但不能指望它单独压住 Android 原生长按行为。

## 2026-06-01 多 pane closeout 精华
- 多 pane UI 对齐必须查“生产入口真源”：Mac 当前真实入口是 `ShellWorkspace`，不要只测未接入入口组件；packaged smoke 必须用进程路径证明启动的是 `mac/out/.../ZTerm.app`。
- Android 接 shared PaneTabs/PaneStage 时，不得丢旧交互合约：header padding、close aria/touch、relay badge button、横向 touch-scroll 抑制、inactive pane first-frame viewport demand 都要进红测。

## 2026-06-01 iTerm2-style split correction
- 多 pane / split 需求不得再按 flat horizontal panes 验收；正确真源是 split tree（leaf pane + row/column split node + ratio）。Mac packaged smoke 也必须验证横/竖嵌套 split 可见和分隔线可拖拽，而不是仅看到多个列。
