# 2026-05-14 multi-pane / single-pane single-truth separation（draft）

> 状态：**draft（代码 owner 收口 Phase 1/2 已完成，运行态闭环未完成）**
>
> 目标：把当前 multi-pane 问题从“补症状”收口为“删除错误耦合 + 恢复单一实现”。
>
> 本文档只定义 **Android client 当前阶段** 的职责拆分与移除顺序。若旧实现、旧测试、口头理解与本文冲突，以本文为准。

---

## 1. 核心判断

multi-pane 与 single-pane 理论上只应有两类差别：

1. **实例数差别**：`TerminalView` 从 1 个变成 N 个
2. **布局差别**：pane ratio / active pane / visible pane container 不同

除此之外，下列能力都必须继续是 **per-session 单一实现**，不能因为分屏长出第二套语义：

- transport lifecycle
- head / sync refresh
- local sparse buffer
- render snapshot
- input / resize / viewport contract
- daemon mirror interaction

换句话说：

```text
single-pane = 1 个 visible session + 1 个 TerminalView
multi-pane  = N 个 visible sessions + N 个 TerminalView
```

二者共享同一套 session truth、buffer truth、transport truth、refresh truth。

---

## 2. 历史架构违规与当前剩余风险（已确认）

### 2.1 App page state 越权驱动 transport restore 语义

历史错误是 `App.tsx` 把：

```text
pageState.kind === 'terminal'
```

直接映射成：

```text
restoreSwitchReason = explicit-resume | restore-sync
```

这是错误分层：

- `pageState` 属于 **UI shell truth**
- `restore / resume transport` 属于 **session transport orchestration truth**

UI page 不得直接成为 transport reopen 语义 owner。

**当前状态：已在代码中移除。**

- `App.tsx` 不再把 `pageState.kind` 映射成 transport restore reason
- transport resume owner 已回收到 open-tab/runtime orchestration
- page visible 现在只作为 resume effect 的可见门禁，不再直接决定 transport 语义

---

### 2.2 open-tab orchestration 同时持有“切 active session”和“开 transport”

历史错误是 open-tab runtime helper 在一次 switch 动作里同时做：

1. `switchSession(nextActiveSessionId)`
2. `resumeActiveSessionTransport(nextActiveSessionId)`

这把三层职责揉在一起：

- open-tab persistence truth
- active session truth
- transport reopen truth

结果曾经是：

- tab/pane/UI 语义下沉进 transport
- restore / explicit switch / foreground resume 更容易互相污染

**当前状态：已在代码中移除。**

现在改成两段：

1. `syncRuntimeActiveSessionTruth(sessionId)`
2. `queueExplicitTransportResume(sessionId)`，再由 effect 在
   - `terminalPageVisible === true`
   - `runtimeActiveSessionId === pendingTransportResumeSessionId`

   两个条件同时满足后才真正 `resumeActiveSessionTransport(sessionId)`

这说明 open-tab helper 已不再内联 reopen transport，而是把 transport resume 收成单独编排步骤。

---

### 2.3 `liveSessionIds` 被误用为 transport-active 真相

历史错误是 `SessionContext` 内把：

```text
isSessionTransportActive = activeSessionId || liveSessionIds
```

这是错误 ownership。

`liveSessionIds` 的真实含义只能是：

- 当前 pane/layout 下的 **visible session set**
- renderer / refresh scheduler 的可见集合输入

它不是：

- 物理 socket truth
- transport attach truth
- reconnect/open truth

一旦把 `liveSessionIds` 当成 transport-active gate，就会让 multi-pane 的 visible/invisible 状态反向污染 transport 行为。

**当前状态：已在代码中移除。**

- `isSessionTransportActiveRuntime(sessionId)` 已收回为 **active-only**
- `liveSessionIds` 仍保留在 `shouldAcceptSessionLiveBufferRuntime(...)`
- 这表示 visible non-active pane 仍可：
  - 接受 live buffer
  - 做 visible-range repair
  - 请求 head refresh

但 **不能** 因为“可见”就升级成 transport active / reconnect owner

---

### 2.4 refresh plan 把 transport decision 和 visible refresh decision 混算

当前剩余风险是 `ensureActiveSessionFresh / buildActiveSessionRefreshPlan` 仍在同一套编排里混算：

- active
- live
- explicit-resume
- active-resume
- active-reentry
- pending open
- reconnect
- stale transport

这导致：

- “visible pane 变多”会影响 transport 决策
- “foreground re-entry”与“pane 可见”共享同一套 source 语义
- 单屏 / 分屏更难证明在走同一条主链

**当前状态：部分收口，仍未彻底完成。**

目前代码已经增加：

- `allowTransportEscalation`
- visible non-active pane 的 `request-head only`
- visible pane 新显现时走 `source: 'active-tick'`

这已经把“可见 pane = transport/reconnect owner”的错误收掉，但 transport availability 与 refresh scheduling 仍然还在同一套大编排里，后续仍要继续拆。

---

### 2.5 cold-restore -> explicit-resume 仍是散落编排

当前剩余风险是 restore path 仍散在：

- `useOpenTabRestoreRuntimeSync`
- `useOpenTabRuntime`
- `SessionContext.ensureActiveSessionFresh`

restore sequence 现在是“多 helper 协作”，而不是“单一 orchestrator 明确推进”。

这类散落编排容易出现：

- session shell 已创建，但 transport reopen 还没拿到统一 truth
- 页面已进入 terminal，但 active session / transport 未真正恢复
- 首次进入不刷新，切 tab 再回来才刷新

**当前状态：部分收口，仍未彻底完成。**

目前 restore 已收成更清晰的四步：

```text
apply open-tab state
-> sync runtime active session truth
-> queue explicit transport resume
-> 等 visible + runtime active 对齐后 resume transport
```

但 owner 仍分散在：

- `useOpenTabRestoreRuntimeSync`
- `useOpenTabRuntime`
- `SessionContext.ensureActiveSessionFresh`

因此它还不算“单一 restore orchestrator 完成态”。

---

### 2.6 tab truth 与 runtime active truth 仍不是原子提交

Jason 新指出的问题是对的：**当前 tab 切换与 runtime active session 对齐仍不是单次原子推进**。

当前实现虽然已经删除了 open-tab helper 内联 reopen transport，但仍是：

```text
persist/apply open-tab truth
-> sync runtime active session truth
-> queue explicit transport resume
-> effect 等待 visible + runtimeActiveSessionId 对齐
```

这比旧实现正确，但仍有一个明确风险：

- `active tab truth`
- `runtime active session truth`
- `explicit resume intent`

三者不是同一次提交完成，而是被拆成了“先写 truth、后等 effect 对齐”的多步推进。

这类非原子推进容易导致：

- 同一 session 被重复 `switchSession`
- tab 已显示为激活，但 runtime active truth 仍停在旧 session
- restore / switch / foreground resume 交叉时连错 session
- 首次进入不刷，切 tab 再回来才刷

所以后续 closeout 不能只停在“去掉错误 reopen owner”，还必须继续收口到：

```text
tab switch intent
-> atomic active-target commit
-> single resume orchestrator
```

也就是说，**tab 激活目标、runtime active 目标、resume 目标必须属于同一个原子操作语义**，不能再由多个 helper/effect 分别补推进。

---

## 3. 本轮已完成的错误逻辑移除

以下三类错误 owner 已经在代码中完成物理移除，后续不允许回流：

### 3.1 已删除 `pageState.kind -> restoreSwitchReason`

不再允许：

```text
UI page kind 直接决定 transport restore 语义
```

改为：

- persisted active tab truth
- explicit user switch intent
- foreground lifecycle intent

三者显式进入单一 restore/resume orchestration。

---

### 3.2 已删除 open-tab helper 内联 reopen transport

不再允许：

```text
persist/switch open tabs -> 顺手 reopen transport
```

改为两步：

1. `switchActiveSessionTruth(sessionId)`
2. `resumeTransportIfNeeded(sessionId, reason)`

当前替代实现是：

1. `syncRuntimeActiveSessionTruth(sessionId)`
2. `queueExplicitTransportResume(sessionId)`
3. effect 等 `terminalPageVisible + runtimeActiveSessionId` 对齐后再 resume

---

### 3.3 已删除 `liveSessionIds` 参与 transport-active truth

不再允许：

```text
visible pane set => transport active
```

`liveSessionIds` 只保留给：

- visible refresh scheduling
- visible range repair scheduling
- renderer-side demand

不能再用于：

- socket active gate
- transport readiness truth
- reconnect/open blocking truth

补充冻结：

- visible non-active pane 允许 `request-head` 与 visible repair
- visible non-active pane 不允许 `probe stale transport`
- visible non-active pane 不允许 `reconnect/open transport`

---

## 4. 需要重新设计的逻辑

### 4.1 transport availability plan

单独一层，只回答：

- 当前 session 是否存在
- 当前 active socket 是否存在
- 当前 transport 是否 stale / closed
- 当前 open intent / reconnect intent 是否在途

它**不看 pane 可见性**。

---

### 4.2 refresh scheduling plan

另一层，只回答：

- 当前哪些 session 需要保鲜
- active session 是否需要立刻 head refresh
- visible non-active panes 是否需要低频 head/sync 保鲜
- foreground/background 是否暂停 tick

它可以看：

- active session
- visible pane sessions
- foreground state

但不能反向改写 transport truth。

---

### 4.3 restore orchestrator

restore path 要收成：

```text
persisted open tabs truth
-> create runtime session shells (connect:false only)
-> commit active session truth
-> single explicit resume orchestrator decides transport reopen
```

这里还要额外冻结一个原子性要求：

```text
open-tab active target
= runtime active target
= explicit resume target
```

三者必须由**同一个 orchestrator** 在同一个 operation 里推进；允许“transport 真正建立”晚于 commit，但不允许 target truth 自己分裂。

禁止：

- page layer 直接 reopen transport
- open-tab helper 直接 reopen transport
- restore helper 自己拼 transport reopen
- effect 在缺少统一 active target truth 的情况下再次独立推进 `switchSession`

---

## 5. multi-pane 唯一允许持有的职责

multi-pane 责任只能留在：

- `TerminalPage`
- `useTerminalWorkspace`

且只允许持有这些真相：

- pane count
- pane ratio
- active pane
- pane 内 tab 分布
- visible pane session set
- 每个 pane 对应哪个 `TerminalView`

multi-pane **不得**持有：

- transport reopen policy
- session reconnect policy
- buffer truth merge policy
- daemon subscriber semantics
- session connected truth

---

## 6. 目标架构（本轮草案）

```text
daemon mirror truth
  -> per-session transport truth
  -> per-session buffer truth
  -> per-session render snapshot truth
  -> pane layout / visible session set
  -> N TerminalView instances
```

其中：

- 上面四层是 session 维度单一实现
- 最后一层只是 UI 容器与实例数差别

---

## 7. 本轮验证门禁（设计层）

后续实现必须能证明：

1. single-pane / multi-pane 共用同一条 `head -> sync -> buffer apply -> render commit` 主链
2. pane 数变化不改变 transport reopen / reconnect 语义
3. visible pane 集合只影响 refresh scheduling，不影响 transport truth
4. active session / visible session / page state 三者边界清晰，无互相越权
5. tab switch / restore / foreground resume 不出现 active tab truth 与 runtime active truth 分裂
6. cold-restore 首次进入与切 pane 后再次进入，不再依赖“切回来才刷新”

补充当前证据状态：

- **已具备代码/测试证据**：前三条错误 owner 已删除，且相关 unit/integration tests 已转绿
- **尚缺运行态证据**：daemon close-loop、APK build、真机分屏/首刷/滚动/不卡顿证据仍未闭环

---

## 8. 实施顺序（当前 closeout 顺序）

### 已完成

1. 删除 `pageState.kind -> restoreSwitchReason`
2. 删除 open-tab helper 内联 reopen transport
3. 删除 `liveSessionIds` 参与 transport-active truth

### 仍待完成

4. 继续拆 `ensureActiveSessionFresh` 为 transport plan / refresh plan
5. 把 cold-restore / explicit-resume 收口成带原子 active-target 提交的单一 orchestrator
6. 补“tab truth / runtime active truth 原子提交”测试与运行态证据
7. 跑 daemon close-loop / APK / 真机证据，证明单屏与分屏确实共用同一主链

在这些 closeout 完成前，不继续往 multi-pane 叠加新的 session/refresh 特判。
