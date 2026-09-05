# 2026-04-23 Terminal head / buffer manager / renderer truth

> 本文档是 terminal 链路唯一真源。若旧文档、旧实现、旧测试与本文冲突，以本文为准。

> 补充：transport 生命周期已单独冻结在  
> `docs/decisions/2026-04-28-terminal-transport-session-lifecycle-truth.md`。  
> 本文档只负责 `daemon mirror / buffer manager / sparse buffer / renderer window / DOM renderer / terminal shell / UI shell` 内容真相。

## 决策

terminal 链路固定为四层独立模型：

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

### 冻结原则

1. **server 独立**：只 mirror tmux truth，只回答 head 和 range
2. **buffer manager 独立**：只管和 daemon 同步 + 本地 sparse buffer / gap repair，不管渲染状态
3. **renderer window 独立**：只管 render window / visible range / immutable snapshot，不管 buffer 拉取
4. **DOM renderer 独立**：只把 immutable render snapshot 投影成 DOM，不拥有 follow/reading/renderBottomIndex
5. **terminal shell 独立**：只管 stage shell / status / quickbar / copy / keyboard lift，不拥有内容真相
6. **UI shell 独立**：只管容器位置与裁切，不管内容真相
5. **不允许 fallback / snapshot / planner / 第二语义**

---

## 1. daemon server

server 只做四件事：

1. mirror tmux buffer truth
2. 处理 `buffer-head-request`
3. 处理 `buffer-sync-request`
4. 处理 transport 级 `input / file / schedule / tmux manage`


### 1.0 正常刷新主链冻结（2026-05-06）

terminal 正常 live/follow 刷新主链固定为：

```text
tmux
-> daemon mirror capture
-> daemon mirror truth commit
-> daemon broadcast buffer-sync
-> client local sparse buffer merge
-> renderer render
```

reading / gap repair 主链固定为：

```text
renderer visible range gap
-> client buffer manager request buffer-sync-request
-> daemon replies current mirror range
-> client patch local sparse buffer
-> renderer local range repaint
```

硬规则：

- `buffer-head-request` 不再承担正常正文 live 刷新主链
- `buffer-head-request` 只允许用于 `resume / reconnect / stale probe / health check`
- daemon broadcast `buffer-sync` 时只允许基于 **mirror 当前真相** 广播，不得查看客户端 `active / follow / reading / visible range`
- daemon 正文发布的 per-subscriber pending/backpressure/head cache/frame split 状态由 `daemon.buffer_publisher` 唯一 owner 管理；`terminal-mirror-runtime.ts` 只调用 publisher 接口，不得在 mirror 层重放订阅队列语义
- `buffer-sync-request` 的 range response 也必须经过 `daemon.buffer_publisher`；使用独立 per-subscriber FIFO response lane，保留请求范围和 `requestSentAt`，不得并入 live `pending-latest` 或被其覆盖。publisher 只消费已构造的 authoritative payload，不触发 mirror capture。
- 共享 physical transport 的正文发送预算由 physical send boundary 统一执行；publisher 每轮最多发送有限分片并按 subscriber 轮转，单 channel 的大 frame 不得连续占满 shared socket。logical channel 仍保留各自 pending/backpressure 状态，预算不下沉为 session-local 猜测。
- `buffer-sync-request` 继续只服务 reading repair / explicit gap pull
- 正常 push 与 reading pull 必须互不干扰；reading 不得反向驱动 daemon live capture 策略

### 1.0.1 消息语义冻结：正文 repaint 唯一触发源

```text
buffer-head
  -> head metadata update only
  -> cursor metadata update only
  -> planner input update only
  -> must NOT trigger body repaint

buffer-sync apply
  -> local sparse buffer truth update
  -> may trigger body repaint
```

硬规则：

- `buffer-head` 只允许更新：
  - `daemonHeadRevision`
  - `daemonHeadEndIndex`
  - cursor metadata
  - planner 所需 head truth
- `buffer-head` 不得直接触发正文 body repaint
- cursor metadata 不得直接触发正文 body repaint
- renderer 若要读取 head/cursor metadata，必须把它们视为 metadata truth；正文 repaint 仍只允许跟随 `buffer-sync apply`
- daemon live push 还必须再细分：
  - **mirror body unchanged** -> push `buffer-head/info`
  - **mirror body changed** -> push `buffer-sync diff`
- 这个 diff 只能基于 **daemon mirror 前一版 vs 当前版** 计算
- daemon **不得**基于任何客户端 local buffer / visible range / active 状态生成 live diff

### 1.0.2 daemon live 性能调度冻结

正常 live push 可以基于 daemon 自己持有的物理事实调节 cadence：

- mirror capture cost
- canonicalize cost
- transport send buffered bytes
- send error / non-open fact
- subscriber transport count
- daemon 自己的 failure/backoff fact

daemon live scheduler 禁止读取或持有客户端 UI / renderer 语义：

- active tab
- foreground / background
- follow / reading
- visible range / viewport
- pane layout

好链路与弱链路的调度目标固定为：

```text
good transport + low capture cost + no backpressure
  -> fast lane

normal transport / normal capture cost
  -> normal lane

high RTT / high buffered bytes / send backlog / over-budget capture
  -> slow lane or overloaded lane
```

性能 trace 只允许记录 metadata：

- timestamp
- duration
- byte count
- line count
- session / mirror id
- transport kind

禁止把真实 terminal payload 内容写入 trace 来换取观测便利。

### 1.1 server 响应规则

- `buffer-head-request`：返回当前 head
- `buffer-sync-request`：返回请求区间 buffer
- **任何回复都带当前 head**

最小响应语义：

```ts
type BufferHead = {
  sessionId: string
  revision: number
  latestEndIndex: number
}

type BufferSyncResponse = {
  sessionId: string
  revision: number
  latestEndIndex: number
  startIndex: number
  endIndex: number
  lines: Array<{ index: number; cells: TerminalCell[] }>
}
```

### 1.2 server 明确不做

- 不做 follow / reading 判断
- 不做 request planner
- 不做 snapshot / fallback
- 不做 gap 判断
- 不做 renderer 决策
- 不做 visible range 决策
- 不做“客户端应该拉哪段”的策略
- 不因 client 断开 / 切 tab / subscriber 归零就销毁 mirror truth；mirror 的 `revision / latestEndIndex / absolute line window` 不能随着 client 生命周期重置

server 不关心客户端行为；它只是 tmux mirror。

### 1.2.1 daemon mirror 写侧补充冻结

- daemon 从 tmux 写入 mirror 时，只允许：

```text
single capture
-> canonicalize
-> mirror store
```

- 不允许把 tmux 内容拆成：
  - `history`
  - `viewport / visible rows`
  - 再本地拼接
- 这类 split 会制造第二语义，也容易在短历史场景下把尾部内容重复拼进 mirror
- daemon 可以读取 tmux 的 pane rows / cols / alternate-screen 这些**源事实**，但不能基于它们派生“显示策略”
- daemon mirror absolute window 只能来自 tmux authoritative window（例如 `history_size + pane_height` / capture 行数归一后的结果）
- 禁止根据 capture 内容本身的 overlap / repeated text 去推断新的 `startIndex`
- 否则重复文本会把旧 prefix 错绑到新的 absolute index，表现为局部重复/先错后正
- 若 tmux/TUI 正在半刷新，mirror writer 不得立刻发布“第一帧就算数”的中间态：
  - 必须在 writer 内部做 **连续一致才发布** 的稳定化判定
  - 允许 `capture -> canonicalize` 连续执行少量重采样
  - 只有连续两次 canonical snapshot 一致，或与当前 mirror 已一致，才允许写入 mirror store
  - 若在上限次数内始终不稳定，必须显式报错，禁止把半帧直接发布给 client

### 1.3 daemon transport / mirror 生命周期

daemon 侧还要额外冻结一条真源：

1. **transport(ws / rtc)** 是 daemon 可持有的物理连接事实
2. **mirror** 仍然只代表 tmux truth
3. daemon 不持有客户端逻辑 session 状态机

关系固定为：

```text
tmux truth
  -> mirror
daemon transport connection
  -> optionally bound session transport
```

硬规则：

- 新 transport 连接上来时，daemon 只处理 transport attach / detach
- 若协议兼容期仍携带 `clientSessionId / sessionTransportToken`，它们只能作为 attach 参数
- transport 断开时，只允许 **detach transport**，不得顺手推导客户端逻辑状态
- daemon 不允许维护 client 风格状态机：
  - 不允许 `session.state = connecting/connected/error/closed`
  - 不允许 `mirror.state = connecting/connected/error/closed`
  - 只允许维护 daemon 自己需要的最小事实：
    - 当前 transport 是否存在/绑定
    - mirror 是否 `booting/ready/failed/destroyed`
- daemon 不允许因为 active/inactive/tab/foreground/background 推导 transport 生命周期

### 1.4 daemon 不允许持有客户端 UI/viewport 语义

daemon 不允许维护：

- `title` 作为 session 本地缓存真相
- `terminalWidthMode`
- `requestedAdaptiveCols`
- active / inactive
- tab / pane / renderer / follow / reading

补充冻结：

- `resize`
- `terminal-width-mode`

这两类消息若还存在于旧协议里，daemon 只能忽略；不得再变成 daemon 内部状态机入口。
- 在本轮真源里，**没有**“ws 一断就删 client session”这条语义
- daemon 可临时持有 transport 级观测字段（如 heartbeat liveness、request origin、connected handshake sent），
  但它们只属于 **physical transport fact**，不得写进 logical session / mirror 真相，更不得反推客户端 active/tab/foreground 语义

---

## 2. client buffer manager

buffer manager 是客户端唯一 buffer worker。

### 2.1 唯一职责

- 自己起 timer
- 定时先问 head
- 比较本地 local buffer 与 daemon head
- 接收 renderer 声明的 visible range
- 决定这次该请求哪段 buffer
- merge 到本地 sliding buffer
- 在 head 变化或 gap repair 完成后产出 line/range patch 并通知 renderer

补充冻结：

- `buffer-head` 到达时，buffer manager 可以：
  - 更新本地 head metadata
  - 更新 cursor metadata
  - 更新 pull planner 输入
- 但 buffer manager 不得因为 `buffer-head` / cursor-only 变化直接触发正文 render commit
- 正文 render commit 唯一来源仍是：`buffer-sync apply` 让本地 body truth 发生变化

### 2.2 本地 buffer 结构

- 客户端默认/最大维护 **1000 行** sliding buffer
- 绝对行号存储
- 允许 sparse
- 历史超出窗口后再滑走
- 单次 payload 不是“重建本地 buffer”的命令
- **已有绝对行号内容一旦进入本地 buffer truth，就不能因为窗口判断而被逻辑清空**

### 2.2.1 本地 buffer 不变量

下面几条是硬规则：

1. **窗口错不等于 buffer 作废**
2. **anchor 错不等于 buffer 作废**
3. **head 对不上不等于 buffer 作废**
4. buffer manager **没有权利**因为“当前工作窗口理解错了”，就把已有本地 buffer truth 清空、重置成空窗、假装丢失

### 2.2.2 分块 authoritative frame 原子提交

- `frameChunkCount > 1` 的 `buffer-sync` 只是一帧正文真相的 wire 分片，不是多个可见 patch。
- `resource.client_buffer_frame_assembly` 是独立于 `resource.client_sparse_buffer` 的唯一 frame assembly owner：按 `revision + frameStartIndex + frameEndIndex + generatedAt + frameChunkCount` 隔离暂存；`generatedAt` 只参与 frame identity，不参与新旧排序。
- 只有全部 chunk 到齐，且 chunk index 唯一、chunk window 无重叠无洞、所有 absolute row 精确连续覆盖 `[frameStartIndex, frameEndIndex)`，才允许合成一个 continuous payload。
- frame assembly 的资源边界由 shared protocol 唯一声明：最多 `4096` 行 span、`512` chunks、`64 MiB` retained serialized bytes、`15s` incomplete lifetime。client ingress 在写入 retained map 前拒绝越界；buffer-head cadence 到期后必须释放 incomplete chunks、写入 `frame-assembly-expired` error truth，并只通过既有 exact-range repair owner 请求一次。禁止依赖 session close 或下一次 chunk 才释放过期 frame。
- 完整 frame 只允许一次 `applyBufferSyncToSessionBuffer`、一次 local buffer commit、一次 renderer commit。
- 未完成、重复冲突、跨 frame 混入、低 revision 迟到的 chunk 不得改变 local revision，不得污染已发布 body，不得触发 renderer；错误必须显式进入 per-session frame resource 的 `BufferSyncError01InvalidFrame` truth，debug 只做观察而不是错误真源。
- same revision、不同 frame identity 混入时，本次 interleave 必须显式拒绝，同时清除旧 incomplete assembly；repairable error 必须保存原 pending frame 的 exact range，并通过既有 head/range 主线请求 authoritative repair。wire revision 非法时禁止伪造 `revision=0`：若有 pending frame，使用其 revision；否则保持 repair pending，直到 authoritative live head 提供 revision。请求未实际写入 wire 时保持 `pending`，下一次合法 head 再尝试；只有实际 dispatch 后才改为 `dispatched`。独立且有界的 per-session `repairDispatchedRevisions` ledger 必须跨后续 revision 成功 apply 保留，防止迟到 malformed payload 对旧 revision 二次发送 repair；只有显式 session cleanup 才整体退休。更高 revision frame 替换 incomplete 旧 frame 时，必须原子清除旧 pending repair error，同时保留 dispatch ledger。低 revision stale frame 只记录错误并保留当前较新 assembly，不触发 repair。
- per-session frame assembly ref 是 client buffer manager 的必需资源，所有生产 ingress/reset/cleanup caller 必须显式持有；socket generation cleanup、reconnect、inactive drop 与 tab switch 只清 incomplete `pending` chunks，必须保留 revision-reset expectation 以及同一 daemon revision epoch 的 frame error truth 与 bounded repair ledger。首次 authoritative lower head 进入 revision-reset epoch 时必须先由 assembly owner 清空旧 epoch pending/error/ledger，再允许任何 repair；同一 epoch 的重复 lower head 不得再次清 ledger。explicit local session destruction 删除 revision-reset 与 frame resource。禁止 optional 注入或在 UI/renderer 层复制 assembly state。
- `normalizeIncomingBufferPayload` 是 socket body 的唯一 wire normalization owner，必须保留 `frameStartIndex/frameEndIndex/frameChunkIndex/frameChunkCount/generatedAt`；已出现但非法的 frame 字段必须保持显式 invalid 并由 assembly 拒绝，禁止丢字段后降成 unchunked passthrough。
- 禁止逐 chunk apply 后依赖 RAF 碰巧合并。每个 WebSocket message 是独立事件任务，RAF 可以在 chunk 之间运行；逐 chunk 发布会把新 frame 的部分行与旧 frame 的其余行同时投影，表现为中间洞、旧新 buffer 交替和闪屏。

### 2.2.3 Rust migration register

- `migration_id`: `terminal.buffer_render.frame_assembly.rust`
- `status`: `planned`
- `current_owner`: `android/src/lib/buffer-frame-assembly/session-buffer-frame-assembly.ts#assembleBufferSyncFrameChunk`
- `planned_target`: `crates/zterm-terminal-core/src/buffer_frame_assembly.rs`
- `planned_rust_semantics`: frame identity validation, bounded chunk assembly, exact absolute-row coverage, stale/interleave rejection, and one complete-frame output
- `post_migration_ts_boundary`: WebSocket payload IO, per-session resource wiring, sparse-buffer commit, and renderer scheduling only
- `activation`: create the Rust crate and target path, pass TS/Rust parity plus source-to-DOM atomicity gates, wire the bridge, change this entry to active, then physically remove the TS policy owner
- `gate`: `android/src/lib/function-wiki-truth.test.ts` and `android/src/lib/buffer-frame-assembly/session-buffer-frame-assembly.test.ts`

This is a target-state plan, not current runtime truth. Until every activation condition passes, the TypeScript symbol above remains the only frame-assembly owner.

正确语义只能是：

```text
已有 absolute-index buffer truth 继续保留
-> 重新理解当前工作窗口 / 缺口
-> 请求缺的 range
-> 按绝对行号 merge
-> 通知 renderer
```

绝不允许：

```text
窗口判断异常
-> 先把已有本地 buffer truth 清空
-> 再从空窗重拉
```

### 2.3 follow 主路径

每轮都先问 head，然后比较本地尾窗和 daemon head：

#### 情况 A：本地为空 / 失真 / 距离 head 超过当前 visible window

直接：
- 请求当前 visible window
- 把本地 sliding window 移到最新尾部
- **中间缺口不补**

#### 情况 B：本地仍在 head 附近

只补 diff。

### 2.4 reading 主路径

reading 不改变 head-first 主循环。

buffer manager 不理解 “follow / reading” 模式本身。  
它只接收 renderer 声明的 **当前 visible range**，然后判断：

- 当前 visible range 内哪些 absolute rows 已存在
- 哪些 rows 是 gap
- gap 是否需要请求 repair

只有当前 visible range 不连续时，buffer manager 才请求 gap。

### 2.5 buffer manager 明确不做

- 不关心 renderer 的 DOM / scroll / IME
- 不关心容器位置
- 不直接修改 renderer 的 mode
- 不持有 `follow / reading / renderBottomIndex`
- 不在 follow 下因为历史 gap 去回补整段旧历史
- 不允许 snapshot / patch-middle / fallback
- 不允许因为 `local window invalid` / `anchor mismatch` / `head mismatch` 把已有本地 buffer truth 重置成空窗
- 不允许把“请求规划错误”实现成“先销毁已有本地内容再重拉”

### 2.6 active / inactive 与 transport 生命周期

buffer manager 自己还必须守住这条边界：

1. **active / inactive 只影响取数频率**
2. **不影响 session 身份**
3. **不影响 transport 身份**

固定语义：

- active tab：
  - 持续 head-first tick
  - follow 时做 tail diff / visible-window 重锚
  - reading 时额外做 gap repair
- inactive tab：
  - 只是不再主动高频拉 `head/range`
  - **不是**关闭 session
  - **不是**关闭 transport
  - **不是**重建 buffer truth

reconnect 语义也固定：

- 若 transport 死了，buffer manager / session runtime 只能做 **same session identity** 的 transport retry
- 不允许把 reconnect 实现成“先删 session 语义，再创建一个新 session 假装恢复”
- reconnect bookkeeping 也必须按 **session** 隔离：
  - 不允许再做 `same host -> reconnect bucket -> activeSessionId` 的跨 session 串行门
  - 一个 session 的旧 ws / handshake 卡住，**不得**挡住同 host 其他 session 的 retry / resume / active re-entry

---

## 3. renderer window / DOM renderer / terminal shell

renderer window 只消费本地内容池，不驱动 transport。

### 3.1 renderer 真相

renderer 只维护：
- `mode`: `follow | reading`
- `renderBottomIndex`
- `visible range`

renderer repaint 规则冻结：

- body repaint：只响应 `buffer-sync apply` 后的 body truth 变化
- head metadata / cursor metadata：可以被读取并参与尾部状态、光标显示、follow 计算
- 但 head/cursor metadata 不得单独触发新的正文 body repaint

派生：

```text
renderTopIndex = renderBottomIndex - viewportRows
renderWindow = [renderTopIndex, renderBottomIndex)
```

并且 renderer 必须把这个 visible range 声明给 buffer manager；
buffer manager 不得自行反推 renderer 当前窗口。

### 3.1.1 DOM renderer projection

- `client.dom_renderer` 只把 `resource.renderer_window` 的 immutable snapshot 投影成 `TerminalView` / `VisibleRow` / `TerminalPreviewRow` / mirror-fixed zoom-pan / cell render / theme DOM。
- 它不持有 `follow / reading / renderBottomIndex / visible range / request policy`，不得修改 sparse truth 或请求 transport。
- `client.renderer_window` 的 window controller/hook 持有 follow/reading transitions、renderBottomIndex 和 reset；`TerminalView` 只执行 DOM 测量、事件采集、scroll effect 和 immutable render projection。

### 3.1.2 terminal shell projection

- `client.terminal_shell` 拥有 stage shell、shell skin、status、quickbar assembly、copy menu、keyboard lift。
- 它消费 renderer/DOM projection 并发出用户 intent；不拥有 sparse/render truth，不直接访问 daemon/backend。

### 3.2 follow

- follow 时，收到 head / buffer 更新后
- 将 `renderBottomIndex` 对齐到最新底部
- 重新从本地 buffer 取当前窗口渲染
- 若当前窗口有 gap，先直接画空白占位，不等待补齐

### 3.3 reading

- 用户上滚进入 reading
- reading 时只改自己的 `renderBottomIndex`
- 取的是当前 visible range 的渲染窗口
- buffer 更新不会自动改变滚动语义
- 若当前窗口有 gap，仍先按已有行渲染，缺的行画空白占位

### 3.4 reading 退出条件

只允许：
1. 重新进入
2. 下滚到底
3. 用户输入

### 3.5 renderer 明确不做

- 不直接 request daemon
- 不决定 buffer pull
- 不修改 buffer 内容
- 不因为 buffer 变化自动滚动
- 不修改 cursor 真相；cursor 颜色 / 样式 / 位置语义都不能由 Android client 自己二次生成
- 不允许把“窗口不连续”解释成“已有内容不存在”
- 当前窗口缺行时，应继续消费已有 absolute-index 内容，并把缺口显式视为 gap / blank marker，而不是把整屏当空
- buffer manager 补齐后，renderer 只重刷对应 absolute rows / changed range，不整屏重算

### 3.6 宽度模式真源

terminal 宽度语义固定为两种模式：

1. `adaptive-phone`
   - 当前手机适配模式
2. `mirror-fixed`
   - **上游宽度真相固定在 daemon mirror / tmux**
   - client viewport / safe-area / IME / renderer 容器宽度变化，**不得改写上游 mirror buffer 宽度**
   - renderer 只能消费已有绝对列 truth，并维护自己的横向渲染窗口

`mirror-fixed` 的显示规则：

- 行宽大于 viewport 时，默认只显示左侧裁切窗口
- 用户若要看右侧，只能移动 renderer 的横向窗口
- 可以通过字体缩放让同一 viewport 容纳更多列
- renderer 的**列宽真相**必须来自客户端实测的像素宽度；不能再把浏览器 `1ch / 2ch` 当终端列宽真相
- 双宽 cell 只能按 `2 * measuredCellWidthPx` 渲染；如果浏览器 fallback 字体导致 CJK glyph 宽度偏移，也必须由 renderer 的像素度量吸收，不能回写 daemon / buffer truth
- **不允许**因为手机变窄而重排旧行、重新 wrap mirror、或回写 daemon/tmux 宽度

### 3.6.1 renderer 列宽度量规则

- renderer 必须显式测量当前字体栈的：
  - 单宽 cell 像素宽度
  - 双宽 glyph 的像素占用
- 用于布局和 viewport cols 计算的统一真相为 `measuredCellWidthPx`
- 若双宽 glyph 的浏览器像素宽度大于 `2 * latinProbeWidth`，renderer 必须提升 `measuredCellWidthPx`，而不是继续信任 `ch`
- 该规则只影响 renderer 布局，不影响 daemon mirror / client buffer 的绝对列 truth

### 3.7 横向平移与 tab 手势边界

`mirror-fixed` 下当前规则：

1. 若客户端没有独立 horizontal pan 手势链在生效，则左右滑切 tab 仍保持可用
2. 一旦接入独立 horizontal pan，单指横滑只能命中 renderer horizontal pan，tab swipe 必须同步退出
3. 一次手势只能命中一条 shell 语义

这条属于 UI shell / renderer 的边界，不属于 buffer manager，更不属于 daemon

补充冻结：

- `adaptive-phone` 下若保留左右滑切 tab，**owner 也必须是 UI shell interaction surface**，不是 renderer body
- renderer 只允许：
  - 维护 follow / reading / renderBottomIndex
  - 声明 visible range / viewport demand
  - 处理自身滚动窗口与 DOM input
- renderer **不得**再持有 tab swipe 手势状态机、tab navigation 命中判定、pane activate 语义
- 原因：tab 切换属于 shell navigation；若把它塞进 renderer，会把 scroll / horizontal pan / click hit-test / tab navigation 混成第二份交互真相

---

## 4. UI shell

UI shell 只负责：
- terminal 容器位置
- 可见区域裁切
- keyboard / IME 抬升

### 4.1 IME 规则

- IME 只移动容器，不改变内容
- IME 不影响 buffer manager 决策
- IME 不影响 renderer 内容真相
- keyboard inset 只能消费一次：**terminal stage** 负责用 `quickBarHeight + keyboardLift` 做底部裁切，**QuickBar 容器** 负责用 `bottom = keyboardLift` 整体抬到键盘上方；禁止再通过 QuickBar 内部 `padding/margin` 对同一份 inset 二次抬升
- 若 QuickBar 自己的 textarea / sheet / composer 拿到 DOM focus，只允许暂停 terminal ImeAnchor 路由；**不得**把 QuickBar overlay / floating composer 使用的 `keyboardInsetPx` 清零。也就是 terminal body 可以让出 IME，但 UI shell 仍必须继续吃同一份键盘高度真相，避免被输入法盖住
- Android terminal header 的顶部 inset 必须是 **UI shell 提供的稳定单一像素真相**；IME 弹起导致的 `visualViewport.offsetTop` 不得被二次叠加成 header top inset
- Android connect / reconnect 不得把 UI 容器当前测得的 `cols/rows` 回写给 daemon 作为 tmux geometry 真相；shell 高度变化只允许影响容器裁切，**不得**改写 tmux 宽高
- “看不到的区域不渲染”属于 renderer 的窗口绘制职责；正确做法是 renderer 根据容器可见高度只画当前窗口，而不是 UI shell / daemon 去把 tmux 变矮
- 若 Android terminal 输入走 `ImeAnchor`，则 native `EditText` 的 **editable / composing span / selection** 必须由 framework `InputConnection` 维护为单一真相；`commitText / finishComposingText` 不得跳过 `super` 直接短路，否则会出现输入法预编辑栏 caret 错位，但这仍属于 **IME truth bug**，不是 renderer truth

### 4.2 宽度模式配置入口

- 当前宽度模式配置真源在 **Settings**
- 它是 app 级全局唯一真相；不再允许 Host / Connection Properties 再保留第二份同语义配置
- 每个 active session attach / reconnect / mode toggle 都必须显式知道自己当前是：
  - `adaptive-phone`
  - `mirror-fixed`
- renderer / UI shell 只消费这个配置
- buffer manager 不关心这个配置
- daemon 也不关心 renderer 如何裁切；它只需要尊重“是否允许 client width 改写 mirror width”的协议边界

### 4.2.1 tmux geometry 写入边界

- **rows 不是 Android UI shell 的真相**
- Android runtime 后续运行期间：
  - keyboard / IME
  - safe-area
  - visualViewport
  - foreground / background
  - renderer 容器高度变化
  都**不得**继续改写 tmux rows
- 当前冻结做法：
  - tmux rows 要么只允许在首次初始化时确定一次
  - 要么直接保持上游 tmux / mirror 既有 rows
  - 之后一律不允许因为手机容器高度变化再写 rows
- `adaptive-phone` 若需要适配手机，只允许改 **width / cols**
- `mirror-fixed` 下连 **width / cols** 也不得改写上游 tmux / mirror
- server 侧 geometry 写点也必须唯一：
  - `attach` 不得接受 client rows 改写 tmux rows
  - `resize` 不得再写 rows
  - `width-mode reconcile` 只允许在 `adaptive-phone` 下改 cols，且 **daemon 是唯一 owner**
  - daemon 只允许在自己持有的 `adaptive-phone` 活连接集合上计算 **最小 cols**
  - 连接断开 / attach 迁移 / 显式 close 后，daemon 必须立刻按剩余活连接重新计算最小 cols
  - daemon upstream resize 只允许写 `-x cols`；**永远禁止写 `-y rows`**
  - `mirror-fixed` 下 upstream geometry write 必须是 0
- `adaptive-phone` 的 attach / reconnect 几何真相也必须干净：
  - client 可以携带**最近一次已测得的 adaptive cols**
  - client **不得**携带 runtime rows
  - daemon 只允许消费 `cols`，`rows` 继续取 mirror / tmux baseline
  - 若当前没有已测得的 adaptive cols，则 attach 不得凭 UI 容器高度/抖动构造脏 geometry

### 4.3 app lifecycle 规则

前后台、切 tab、恢复可见性，这些都属于 UI shell / app lifecycle。

它们只允许影响：

- 哪个 tab 当前 active
- 哪些 buffer tick 当前开启 / 关闭
- 哪个 terminal 容器当前可见

不允许影响：

- daemon mirror truth
- client local buffer truth
- logical client session 是否被销毁
- reconnect 是否变成“新建第二个 session”

---

## 5. 明确废止的旧实现

以下全部废止：

1. server 侧 planner / follow / reading 策略
2. stream-mode
3. snapshot / bootstrap 快照语义
4. renderer 直接触发 buffer request
5. buffer manager 直接改 renderer 状态
6. follow 下修本地历史 gap
7. 靠 fallback / 第二语义兜底
8. client width 变化直接把 daemon mirror / tmux 改成手机宽度
9. `mirror-fixed` 下左右滑切 tab 继续开启，和横向平移共享同一手势链

---

## 6. 触摸仲裁边界

`mirror-fixed` 非 copy 模式的终端 surface 使用 `touch-action: none`。
单指垂直滚动由 client DOM renderer owner 按增量提交；双指序列由双指
状态机独占，避免 Android WebView 的原生 `pan-y` 在第二指加入前抢占
触摸序列。scroll 与 pinch 仍在首次有效采样后互斥锁定。

## 7. 真回环验收

必须同时看：

```text
tmux truth
-> daemon response
-> renderer declare visible range
-> client buffer manager merge / patch
-> renderer commit / rerender patched rows
-> Android APK 真实画面
```

最小场景：
1. 初次连接
2. 后台恢复
3. 输入英文 / 数字 / 空格 / 回车
4. reading 连续上滚
5. 输入退出 reading
6. daemon 重启恢复
