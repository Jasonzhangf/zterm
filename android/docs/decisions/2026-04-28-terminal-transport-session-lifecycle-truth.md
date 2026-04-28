# 2026-04-28 terminal transport / session lifecycle truth

> 本文档冻结 terminal `client session / transport / daemon logical session` 的唯一真源。  
> 若旧实现、旧测试、旧口头理解与本文冲突，以本文为准。

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

daemon logical client session
  = stable server-side session object bound by clientSessionId

active/inactive
  = only polling cadence / data pull behavior
```

---

## 1. 角色边界

### 1.1 daemon

daemon 只负责：

1. 维护 tmux mirror truth
2. 维护 daemon logical client session
3. 维护 transport attach / detach
4. 回答 head / range / input / file / schedule 等协议

daemon **不负责**：

- client tab 生命周期
- active / inactive UI 状态
- renderer 行为
- 代替 client 决定何时销毁 session

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

### 1.4 daemon logical client session

daemon 侧每个 `clientSessionId` 对应一个稳定 logical session。

它与 transport 的关系固定为：

```text
logical session
  -> attached transport (0..1)
```

硬规则：

- transport 断开时，只允许 `detach transport`
- reconnect 时，只允许重新 `attach transport`
- 不允许因为 ws close / tab inactive / foreground 切换而把 logical session 当场销毁

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
3. 为该 `clientSessionId` 生成**当前唯一有效**的 `session transport token`
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

但 inactive **绝不表示**：

- 关闭 client session
- 关闭 daemon logical session
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

- 若 session 已 logical-bound
  - 只做 `detach transport`
  - 不得立即销毁 logical session

### 5.2 logical session 回收

本轮冻结里，logical session 只允许由以下事件销毁：

1. client 显式 close session
2. daemon shutdown
3. 后续若新增明确的资源回收策略，必须先写入真源文档并补回归

在此之前，不允许：

- ws close grace timeout 自动销毁
- inactive timeout 自动销毁
- foreground/background 切换自动销毁

### 5.3 mirror 生命周期

mirror truth 与 transport / logical session 也必须解耦：

- logical session detach 不得重置 mirror
- transport close 不得重置 mirror
- reconnect 后若看到 `revision -> 1` / `latestEndIndex` 回退，多半是 daemon 自己把 mirror 生命周期做错了

---

## 6. 当前实现明确偏差

以下都是当前需要删除/重做的错误实现：

1. client 只有 `sessionId -> ws` 一层真相，没有 `control transport + session transport` 分层
2. reconnect 直接 `cleanupSocket(..., true)` 杀旧 transport
3. transport open 后重新发整套 fresh connect
4. transport 活性仅靠 `readyState === OPEN`
5. daemon transport close 后 grace timeout 自动回收 logical session
6. active / inactive 语义漂移为 session / transport 生命周期

---

## 7. 测试冻结

在实现前，必须先补红测覆盖：

1. same target 下多个 session 并存，不共享“关闭/卡住”命运
2. inactive tab 停 polling 但不 close session / transport
3. foreground resume 优先复用原 session transport；control transport 不承载高频流量
4. active re-entry 只重启 head-first loop，不 fresh recreate session
5. daemon transport close 后，same `clientSessionId` 能 attach 回原 logical session
6. daemon shutdown 才统一回收 logical session / mirror 相关资源

---

## 一句话真相

```text
transport 是物理链路
session 是稳定业务对象
daemon logical session 是稳定服务端对象
active/inactive 只影响取数，不影响它们的身份
```
