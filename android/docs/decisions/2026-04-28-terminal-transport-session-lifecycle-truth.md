# 2026-04-28 terminal transport / session lifecycle truth

> 本文档冻结 terminal `client session / transport` 的唯一真源，并明确：**daemon 不持有客户端逻辑**。  
> 若旧实现、旧测试、旧口头理解与本文冲突，以本文为准。

> 2026-05-03 补充冻结：server/daemon 不关心也不能关心任何客户端逻辑/状态机。  
> 包括但不限于：`logical client session`、`clientSessionId` 作为 daemon owner、`readyTransportId`、`session transport token`、`attach/resume state machine`、`active tab`、`foreground/background`、`viewport/pane/width mode`。  
> 若协议兼容期仍接收相关字段，只允许作为一次性 attach 参数或透传字段，不得进入 daemon 长期状态真相。

> 2026-05-03 第二刀补充冻结：  
> `clientSessionId` 继续保留为 **client-owned stable identity**；  
> `sessionTransportToken / session-ticket` 继续保留为 **attach-only wire material**。  
> 它们可存在于兼容协议与客户端握手流程，但：
> 1. daemon 不得把它们提升为长期业务真相  
> 2. client 不得把 `sessionTransportToken` 塞进长期 transport runtime store  
> 3. `sessionTransportToken` 只允许存在于 attach/open 的临时握手上下文中
>
> 2026-05-04 第三刀补充冻结：  
> daemon 不得再用 `clientSessionId` 做 token owner / ticket owner。  
> `sessionTransportToken` 在 daemon 内只能表现为 **one-shot opaque attach proof**；  
> `clientSessionId` 仅允许原样回显给 client 做本地匹配，不得成为 daemon token store 的 ownership key。
>
> 2026-05-04 第四刀补充冻结：  
> attach/open 两阶段握手里的 wire correlation 已从 `clientSessionId` 收口为 `openRequestId`。  
> `openRequestId` 只表示 **client-local open intent correlation**，仅用于把：
> - `session-open` 对回 `session-ticket`
> - `connect` / `session-open-failed` 对回本地 open intent
>
> 它不是稳定 session identity；daemon 不得持有 `openRequestId` 的长期 owner 语义。
>
> 2026-05-04 第五刀补充冻结（兼容止血）：  
> 由于已有安装态客户端仍可能按旧 wire 读取 `clientSessionId`，因此在协议兼容窗口内：
> 1. `session-ticket`
> 2. `session-open-failed`
>
> 允许 **同时携带**：
> - 新字段：`openRequestId`
> - 旧兼容字段：`clientSessionId`
>
> 但这条兼容只允许存在于 **wire echo / client 本地匹配**：
> - daemon 不得重新把 `clientSessionId` 提升为 token owner / attach owner
> - client 新逻辑必须优先按 `openRequestId` 匹配
> - `clientSessionId` 仅允许作为旧安装态恢复连接的兼容回显，不得重新成为新协议主语义

> 2026-05-06 第六刀补充冻结：  
> `daemonHostId` 是 **daemon stable identity**，必须长期稳定存在：  
> 1. relay 模式：使用 relay `hostId`  
> 2. 非 relay 直连模式：daemon 必须提供本地持久化 stable id  
> 3. client 的 tab/session 语义复用必须优先使用 `daemonHostId + sessionName`，不得再回退成 transport path 心智

> 2026-05-06 第七刀补充冻结：  
> client 持久化里，`ACTIVE_PAGE` 只允许表达 **当前页面 kind**；  
> tab/session 焦点唯一真源只能是 `ACTIVE_SESSION`。  
> `ACTIVE_PAGE.focusSessionId` 这类字段属于重复真源，已冻结为禁止新增/禁止恢复。

## 背景

当前现场问题集中在：

- 同 host 多 session 切 tab 后容易挂住
- foreground / active re-entry 后经常直接 reconnect
- 杀掉 App 再进入时又能秒恢复
- 旧 ws / handshake 卡住时，会拖住对应 session 的后续 refresh / input

代码审计结论：

- client 现在仍是 **每个 session 一个 ws**，没有 target 级稳定 control transport，也没有 `control transport + session transport` 分层
- reconnect 仍然大量依赖 `cleanup old socket -> new ws -> fresh connect`
- transport open 后仍然重新发整套 `connect`
- daemon 虽然已有 `logical session != transport` 雏形，但仍保留 transport close 后的 grace close 语义

这些都和当前冻结设计冲突。

---

## 冻结模型

```text
daemon mirror truth
  <- independent from all client transport lifecycle

client target runtime
  = one low-frequency control transport per bridge target
  + many stable per-session transports
  + many stable client sessions

bridge target
  = bridgeHost + bridgePort + authToken

control transport
  = long-lived low-frequency auth / create / attach / resume / close channel

session transport
  = long-lived per-session data channel for head / range / input / session events

client session
  = stable business object identified by clientSessionId

daemon attach fact
  = transport/mirror attach fact created during attach/open
  != standalone client-style business session

active/inactive
  = only polling cadence / data pull behavior
```

## 协议冻结补充（2026-05-02）

terminal wire protocol 现已冻结到两份唯一真源：

1. `packages/shared/src/connection/protocol.ts`：message kind / payload shape 真源
2. `packages/shared/src/connection/types.ts`：buffer / cursor / wire line 真源

Android / daemon 后续规则：

- **允许新增 message kind / payload 字段**，但必须先更新 shared protocol/types，再更新 consumer
- **不允许改写既有 message 的语义** 来“偷偷提速”或补 fallback
- `android/src/lib/types.ts` 只允许做 shared re-export / app local model，**不得再次本地重定义 wire protocol**
- client 巨型文件拆分（如 `SessionContext.tsx`）只允许做 helper ownership 下沉，不得顺手改变协议语义
- 对已发布安装态仍在使用的协议字段，**迁移时必须保留显式兼容窗口**；不得在没有双向兼容的情况下直接切换 handshake owner 字段

---

## 1. 角色边界

### 1.1 daemon

daemon 只负责：

1. 维护 tmux mirror truth
2. 维护 transport attach / detach fact
3. 维护 transport attach / detach
4. 回答 head / range / input / file / schedule 等协议

daemon **不负责**：

- client tab 生命周期
- active / inactive UI 状态
- renderer 行为
- 代替 client 决定何时销毁 session
- client 风格状态机标签
- viewport / width-mode / adaptive-cols / pane 语义

### 1.1.1 daemon 最小状态要求

daemon terminal core 只允许保留这些最小事实：

- `transportId`
- `sessionName`
- `mirrorKey`
- transport attach / detach
- mirror lifecycle:
  - `booting`
  - `ready`
  - `failed`
  - `destroyed`

不允许再保留：

- `session.state = idle/connecting/connected/error/closed`
- `mirror.state = idle/connecting/connected/error/closed`
- `session.title`
- `session.terminalWidthMode`
- `session.requestedAdaptiveCols`
- 任何 active/inactive / tab / pane / renderer 语义
- transport heartbeat liveness / request origin / connected-handshake sent 这类观测值若存在，也只能挂在 **transport connection fact** 上，不能漂移成 session owned truth

### 1.1.2 代码组织约束

在实现层，`server.ts` 只允许承担：

1. websocket / rtc transport 接入
2. http/debug routes
3. 协议 message dispatch glue

不允许继续把 daemon terminal core 业务编排长期内联在 `server.ts`。  
以下逻辑必须收敛到独立 terminal core 模块：

- transport attach / detach orchestration
- mirror lifecycle
- mirror live sync
- tmux attach / start / input orchestration
- `buffer-head` reply 组装入口

允许 `server.ts` 保留最底层 tmux / os / fs helper，但不允许再成为第二份 terminal core 真相。

### 1.1.3 file / screenshot / binary-transfer 边界

daemon 的文件能力也必须保持同样的去客户端化原则：

1. `server.ts` 只负责协议分发与 transport/session required 校验
2. file list / mkdir / download / upload / remote screenshot / attach-file binary / paste-image binary
   必须收敛到独立 runtime
3. file runtime 只关心：
   - 远端 tmux cwd 真相
   - 文件系统读写
   - 传输分块协议
   - screenshot helper 调用
   - mirror 输入注入后的显式 `scheduleMirrorLiveSync`

file runtime **不允许**承担：

- client sheet / preview / toast / active tab 语义
- fallback 到“没 pending binary 就当普通 input 发给 tmux”
- transport lifecycle / reconnect / session active 状态机
- renderer / UI shell 任何策略

换句话说：

```text
client ui/sheet
  -> protocol message
  -> server.ts glue
  -> file-transfer runtime
  -> fs / screenshot-helper / tmux input
```

其中唯一远端目录真相必须继续来自 daemon 读取 `tmux #{pane_current_path}`；
client 不得自带远端 cwd 语义。

### 1.2 client transport split

每个 bridge target 只允许有 **一个 control transport**：

```text
bridge target = bridgeHost + bridgePort + authToken
```

control transport 职责：

1. 长连接到 daemon
2. 完成鉴权
3. 承载该 target 下 session create / attach / resume / close 等低频控制语义
4. 在 control 链失活时做 reconnect

control transport 的生命周期：

- App 启动后建立
- 切 tab / foreground / background / renderer 不活跃时都不应主动销毁
- 只有：
  - 用户显式断开对应 target
  - daemon 不可达且重试策略终止
  - App 退出/销毁
  才允许关闭

每个 `clientSessionId` 还必须有 **自己独立的 session transport**：

session transport 职责：

1. 长连接到 daemon
2. 承载该 session 的高频 `buffer-head-request / buffer-sync-request / input / session event`
3. session transport 出错时只影响本 session，不连坐同 target 其他 session

session transport 的生命周期：

- session 首次 attach 后建立
- tab 切换 / foreground / background / inactive 时都不应主动销毁
- 这些场景只允许暂停或恢复取数，不允许 fresh recreate transport
- 只有：
  - 用户显式 close 该 session
  - daemon 不可达且该 session retry 终止
  - App 退出/销毁
  才允许关闭

### 1.3 client session

client session 是稳定业务对象，唯一标识是 `clientSessionId`。

它代表：

- 当前连接到哪个 bridge target
- 绑定哪个 tmux sessionName
- 本地 buffer truth
- renderer demand truth
- UI state truth

client session **不是** transport。

### 1.4 daemon attach fact

daemon 不拥有 client-style logical session。

daemon 只允许持有：

- transport 物理连接事实
- tmux / mirror 事实
- 某条 transport 当前 attach 到哪个 tmux target / mirror 的事实

若兼容协议 attach/open 期间传入 `clientSessionId`：

- 只能把它当作 client-owned identity 的一次性关联参数
- 不得把它提升为 daemon 长期 owner
- 不得据此在 daemon 内创建“稳定 logical client session 对象”

硬规则：

- transport 断开时，只允许清理该 transport 自身 attach fact
- reconnect 时，只允许重新 attach 新 transport
- 不允许因为 ws close / tab inactive / foreground 切换而推导“client session 已死亡”

---

## 2. client transport topology 真源

### 2.1 target 级 control transport

client 必须先按 bridge target 建立或复用一个长期存活的 control transport。

规则：

- 同一个 `bridgeHost + bridgePort + authToken`
  - 复用同一个 control transport
- 不同 target
  - 各自独立 control transport
- target runtime 生命周期独立于 session attach：
  - 最后一个 session 暂时离开时，若 control transport 还活着，target runtime 仍保留
  - 只有 `sessionIds.length === 0 && controlTransport === null` 才允许删除 target runtime

### 2.2 session attach

session 创建或恢复时：

1. 先找目标 target 的 control transport
2. 通过 control transport attach / resume 指定 `clientSessionId`
3. 若兼容协议仍需要 ticket/token，只允许返回**本次 attach/open 的临时 wire material**
4. 为该 `clientSessionId` 建立或复用自己独立的 session transport
   - session transport 只能用当前有效 ticket attach
   - 同一 session 再次 open/resume/retarget 后，旧 ticket 必须立即失效
5. 后续高频 head / range / input 只走该 session transport，不回灌到 control transport

### 2.3 reconnect 顺序

只能按下面顺序：

```text
same session transport still alive?
  -> reuse same session transport
session transport dead but control transport alive?
  -> rebuild same session transport
control transport dead?
  -> reconnect control transport
  -> re-attach same clientSessionId
  -> rebuild same session transport
```

禁止：

```text
cleanup old socket
-> fresh ws
-> fresh connect
-> pretend it is the same session
```

---

## 3. active / inactive 真源

### 3.1 active

active tab 只表示：

- 持续 head-first tick
- follow 时持续 tail diff
- reading 时额外做 reading gap repair

### 3.2 inactive

inactive tab 只表示：

- 停止主动高频拉 head/range
- 允许降到低频甚至 0 取数
- session transport / control transport 继续长期复用

但 inactive **绝不表示**：

- 关闭 client session
- 关闭 control transport
- 关闭 session transport
- 重建 buffer truth
- 丢失 auth / handshake 状态

---

## 4. handshake / auth 真源

### 4.1 auth

auth 只属于 control transport。

规则：

- control transport 建立时完成一次 auth
- 只要 control transport 没断，就不应重复 auth

### 4.2 session connect / resume

session attach/resume 只需要：

- 指明 `clientSessionId`
- 指明目标 `sessionName`
- 通过既有 control transport 完成 attach / resume
- 然后复用或重建该 session 自己的 session transport

### 4.3 daemon restart

只有 daemon restart / control transport 彻底丢失时，才允许：

1. control transport 重连
2. 再次 auth
3. 各 session 用原 `clientSessionId` 重新 attach / resume
4. 各 session 重建自己的 session transport

---

## 5. daemon 生命周期真源

### 5.1 ws/rtc close

daemon transport close 时：

- 若该 transport 已 attach 到某个 tmux target / mirror
  - 只做 `detach transport`
  - 不得顺手推导“client session 已关闭”

### 5.2 daemon 不得持有 client session 回收语义

本轮冻结里，daemon 根本不应存在“client session 对象回收”这类状态机。

允许清理的只有：

1. transport 自身关闭后的 transport 记录
2. attach/open 临时 ticket / token / pending intent
3. daemon shutdown 时的 daemon 本地 runtime

在此之前，不允许：

- ws close grace timeout 回收 client-style logical session
- inactive timeout 回收 client-style logical session
- foreground/background 切换回收 client-style logical session

### 5.5 client request socket owner 语义冻结

client 侧凡是要向 session transport 发请求的入口，例如：

- `buffer-head-request`
- `buffer-sync-request`
- 后续任何 session-scoped request

都必须满足：

1. 默认从 `readSessionTransportSocket(sessionId)` 读取当前 active socket
2. 如果上层因回调链路显式传入 `ws`，该 `ws` 只能作为**一致性校验后的同一对象引用**
3. 一旦发现 `passedWs !== activeWs`，必须直接拒绝本次请求，不得继续发送

原因：

- superseded / stale socket 的晚到回调可能还会触发 `head`、`range`、`probe`
- 即使消息处理回调本身已经做了 stale gate，只要写侧请求还允许旧 ws 继续发包，transport 真相仍会被旧链路污染

一句话：

```text
旧 ws 不仅不能读，也不能写
```

### 5.3 mirror 生命周期

mirror truth 与 transport / client session 也必须解耦：

- transport detach 不得重置 mirror
- transport close 不得重置 mirror
- tmux session killed / mirror unavailable 时，也**不得顺手推导 client session 被删除**
- 这类事件只能更新 daemon 自己的 tmux/mirror 可用性语义，并进入显式 `error/unavailable` 语义
- tab 是否关闭永远属于 client 显式动作，不属于 daemon mirror 生命周期
- reconnect 后若看到 `revision -> 1` / `latestEndIndex` 回退，多半是 daemon 自己把 mirror 生命周期做错了

### 5.4 server message 语义冻结

- `closed`
  - 只允许表示 daemon 侧目标被显式关闭，不得暗含 client session 状态机
  - 仅允许来源于：
    1. client 显式 close
    2. daemon shutdown / 全局退出
- `error`
  - 用于 session 仍保留、但当前业务目标不可用
  - 例如：
    - `tmux_session_killed`
    - `tmux_session_unavailable`
    - `logical_session_missing`
    - `session_transport_ticket_invalid`
  - 因此：
  - tmux session killed **不得**再发 `closed`
  - mirror destroy **不得**再隐式推导 subscriber client session 被删除
  - client 收到这类 `error` 后，应保留 tab/session 真相，而不是自动移除

---

## 6. 当前实现明确偏差

以下都是当前需要删除/重做的错误实现：

1. client 只有 `sessionId -> ws` 一层真相，没有 `control transport + session transport` 分层
2. reconnect 直接 `cleanupSocket(..., true)` 杀旧 transport
3. transport open 后重新发整套 fresh connect
4. transport 活性仅靠 `readyState === OPEN`
5. daemon transport close 后 grace timeout 自动回收 client-style logical session / attach state
6. active / inactive 语义漂移为 session / transport 生命周期

---

## 7. 测试冻结

在实现前，必须先补红测覆盖：

1. same target 下多个 session 并存，不共享“关闭/卡住”命运
2. inactive tab 停 polling 但不 close session / transport
3. foreground resume 优先复用原 session transport；control transport 不承载高频流量
4. active re-entry 只重启 head-first loop，不 fresh recreate session
5. daemon transport close 后，same `clientSessionId` 能重新 attach 到原 tmux target / mirror truth
6. daemon shutdown 才统一回收 daemon 本地 transport / mirror 相关资源

---

## 一句话真相

```text
transport 是物理链路
session 是稳定业务对象
daemon 只保留自己的 transport attach fact 与 mirror truth
active/inactive 只影响取数，不影响它们的身份
foreground/background/tab switch 只影响取数，不得 fresh recreate transport
```
