# multi-pane / single-pane 单一实现收口实施文档

> 状态：draft（代码 owner 收口 Phase 1/2 已完成，运行态 closeout 未完成）  
> 依赖设计草案：`android/docs/decisions/2026-05-14-multi-pane-single-truth-separation-draft.md`

---

## 1. 目标收口

本轮目标不是“继续修分屏症状”，而是把 Android terminal 收回到下面这条唯一实现：

```text
daemon mirror truth
  -> per-session transport truth
  -> per-session buffer truth
  -> per-session render snapshot truth
  -> pane layout / visible session set
  -> N TerminalView instances
```

### 交付标准

1. single-pane / multi-pane 共用同一套：
   - transport
   - head/sync
   - local sparse buffer
   - render snapshot
2. multi-pane 只保留：
   - pane count
   - pane ratio
   - active pane
   - visible pane session set
   - 多个 `TerminalView` 实例
3. 删除三类错误耦合并保持不回流：
   - `pageState` 驱动 transport
   - open-tab helper 内联 reopen transport
   - `liveSessionIds` 充当 transport-active truth

---

## 2. 当前完成度审计

### 已完成

1. **设计草案已落地**
   - `android/docs/decisions/2026-05-14-multi-pane-single-truth-separation-draft.md`
2. **架构索引已更新**
   - `android/docs/architecture.md`
3. **三类错误 owner 已在代码中删除**
   - `App.tsx` 不再持有 `pageState -> transport reason`
   - `useOpenTabRuntime` 改为 `sync active truth -> queue explicit resume -> visible/aligned effect resume`
   - `isSessionTransportActiveRuntime` 改为 active-only，`liveSessionIds` 只保留给 visible buffer acceptance
4. **相关自动测试已补齐并转绿**
   - open-tab transport boundary
   - App dynamic refresh / restore first-paint
   - session-context infra / activity / lifecycle / session / public / sync helpers
5. **已确认的分屏症状级修复**
   - split ratio stale ratio 复用
   - pane 激活从 `pointerdown` 改 `click`
   - render store 深比较热点移除

### 尚未完成

1. 还没有把 transport availability / refresh scheduling 拆成更清晰的单独 owner
2. 还没有把 cold-restore / explicit-resume 收为单一 orchestrator
3. 还没有新的 daemon close-loop 证据
4. 还没有新的 APK 构建与安装态证据
5. 还没有真机证据证明“分屏和单屏共享同一主链且不卡顿/可滚动/首屏正常”

结论：**当前已完成 code owner 收口与自动测试门禁，但还没完成运行态 closeout。**

---

## 3. 已完成的物理删除（不得回流）

以下三类错误实现已完成物理删除，后续不允许以 fallback/兼容名义回流。

### 3.1 UI page state -> transport restore switch

#### 当前位置

- `android/src/App.tsx`

#### 历史错误点

```ts
restoreSwitchReason: pageState.kind === 'terminal' ? 'explicit-resume' : 'restore-sync'
```

#### 为什么必须删

- `pageState` 是 UI shell truth
- `restore / resume transport` 是 session transport orchestration truth
- UI page 不得直接决定 transport reopen 语义

#### 当前替代 owner

- open-tab/runtime orchestration（page visible 仅做 effect gate，不做 transport owner）

---

### 3.2 open-tab helper 内联 reopen transport

#### 当前位置

- `android/src/hooks/useOpenTabRuntime.ts`

#### 历史错误点

一次 switch 动作里同时做：

1. `switchSession(...)`
2. `resumeActiveSessionTransport(...)`

#### 为什么必须删

这里把：

- open-tab persistence
- active session truth
- transport reopen

三层揉成一层了。

#### 当前替代 owner

- `syncRuntimeActiveSessionTruth(sessionId)`
- `queueExplicitTransportResume(sessionId)`
- effect 等 `terminalPageVisible + runtimeActiveSessionId` 对齐后再 `resumeActiveSessionTransport(sessionId)`

---

### 3.3 `liveSessionIds` 参与 transport-active truth

#### 当前位置

- `android/src/contexts/session-context-infra-runtime.ts`

#### 历史错误点

```ts
isSessionTransportActive =
  activeSessionId === sessionId
  || liveSessionIds.includes(sessionId)
```

#### 为什么必须删

`liveSessionIds` 只应是可见 pane session set，不是 transport 物理真相。

#### 当前替代 owner

- physical socket truth
- pending open / reconnect truth
- daemon attach truth

补充说明：

- `liveSessionIds` 仍允许参与 visible refresh / live buffer acceptance
- 但不再允许升级成 transport active / reconnect owner

---

## 4. 要重新设计的逻辑

### 4.1 transport availability plan

#### 目标

单独回答：

- session 是否存在
- 当前 active socket 是否存在
- transport 是否 stale / closed
- pending open / reconnect 是否在途

#### 不允许再看

- page state
- pane 可见性
- split / single

---

### 4.2 refresh scheduling plan

#### 目标

单独回答：

- 当前哪些 session 需要保鲜
- active session 是否立刻 request-head
- visible non-active panes 是否低频保鲜
- foreground/background 是否暂停 tick

#### 允许看

- active session
- visible pane session set
- foreground lifecycle

#### 不允许做

- 反推 transport truth
- 决定 reconnect / reopen

#### 当前已冻结的中间边界

- visible non-active pane 可以 `request-head`
- visible non-active pane 可以做 visible repair
- visible non-active pane 不可以 escalate stale transport
- newly visible non-active pane 必须走 `source: 'active-tick'`，不得伪装成 `active-reentry`

---

### 4.3 restore orchestrator

#### 目标顺序

```text
persisted open tabs truth
-> create runtime session shells (connect:false)
-> commit active session truth
-> single explicit resume orchestrator
```

#### 不允许

- App page layer 顺手 reopen transport
- open-tab helper 顺手 reopen transport
- restore helper 自己拼 transport reopen

---

## 5. ownership 重画

### 5.1 `TerminalPage / useTerminalWorkspace`

只允许拥有：

- pane count
- pane ratio
- active pane
- pane 内 tab 分布
- visible pane session set
- 渲染实例数

不允许拥有：

- transport reopen policy
- reconnect policy
- session connected truth
- head/sync 主循环

---

### 5.2 `SessionContext`

只允许拥有：

- per-session transport truth
- per-session buffer truth
- per-session render truth
- transport availability plan
- refresh scheduling plan

不允许从 UI 下沉进来的真相：

- page kind
- active pane
- split count
- pane ratio

---

### 5.3 `useOpenTabRuntime / useOpenTabRestoreRuntimeSync`

只允许拥有：

- open-tab persistence truth
- restore 的 runtime session shell 创建
- active session truth 对齐
- active target 原子提交编排

不允许拥有：

- transport reopen 真相
- foreground reconnect 真相
- visible pane refresh 真相
- 各自独立推进同一个 tab switch 的第二次 `switchSession`

---

## 6. 实施顺序

### Phase 1：红灯测试（已完成）

已完成；相关测试已落地并转绿。

#### 6.1 pageState 驱动 transport 红灯

目标：证明当前 page kind 会越权影响 transport restore。

建议测试文件：

- `android/src/App.first-paint.test.tsx`
- `android/src/App.dynamic-refresh.test.tsx`

#### 6.2 open-tab 内联 reopen 红灯

目标：证明 open-tab apply/switch helper 正在内联 transport reopen。

建议测试文件：

- `android/src/hooks/useOpenTabRestoreRuntimeSync.test.tsx`
- `android/src/hooks/useOpenTabSessionActions.test.tsx`
- 新增 `android/src/hooks/useOpenTabRuntime.transport-boundary.test.tsx`

#### 6.3 liveSessionIds 充当 transport-active 红灯

目标：证明 pane 可见集合正在参与 transport-active truth。

建议测试文件：

- `android/src/contexts/session-context-activity-runtime.test.ts`
- `android/src/contexts/session-context-lifecycle.test.tsx`
- `android/src/contexts/SessionContext.ws-refresh.test.tsx`

---

### Phase 2：删除错误实现（已完成）

1. 删除 `App.tsx` 的 `pageState.kind -> restoreSwitchReason`
2. 删除 `useOpenTabRuntime` 里的“切 active session 顺手 reopen transport”
3. 删除 `isSessionTransportActive` 对 `liveSessionIds` 的依赖

---

### Phase 3：拆分编排（剩余工作）

1. `ensureActiveSessionFresh` 拆成：
   - transport availability
   - refresh scheduling
2. `lifecycle` 中 visible pane 引起的刷新改成 refresh enqueue，不再伪装成 `active-reentry`
3. `cold-restore / explicit-resume` 收为单一 restore orchestrator
4. `open-tab active target / runtime active target / explicit resume target` 收为单次原子提交
5. 移除 effect/helper 对同一 target 的重复 `switchSession` 推进

---

### Phase 4：闭环验证（剩余工作）

1. 定向 vitest
2. `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
3. daemon close-loop
4. APK build
5. 真机验证：
   - split ratio
   - vertical scroll
   - multi-pane refresh
   - lag

---

## 7. 测试矩阵

### 7.1 架构边界测试

必须覆盖：

1. page state 不驱动 transport reopen
2. open-tab persistence 不内联 transport reopen
3. pane visible set 不成为 transport-active truth
4. active tab truth 与 runtime active truth 原子对齐

### 7.2 主链一致性测试

必须覆盖：

1. single-pane head -> sync -> render
2. multi-pane head -> sync -> render
3. pane 数变化不改变 transport 行为

### 7.3 行为测试

必须覆盖：

1. cold restore first paint
2. foreground resume
3. tab switch first paint
4. split visible pane refresh
5. split vertical scroll
6. tab switch 不重复推进同一 `switchSession`
7. active tab 不得连错 session

---

## 8. prompt-to-artifact checklist

| 要求 | 证据 |
|---|---|
| 删除 pageState 驱动 transport | `App.tsx` 代码删除 + App 相关测试转绿（已完成） |
| 删除 open-tab 内联 reopen | `useOpenTabRuntime.ts` 改为 queued explicit resume + transport-boundary 测试转绿（已完成） |
| 删除 `liveSessionIds` 充当 transport-active truth | `session-context-infra-runtime.ts` active-only + lifecycle/activity/ws-refresh 相关测试转绿（已完成） |
| tab / runtime active 原子提交 | open-tab/runtime 定向测试证明不重复 `switchSession`、不出现 active target 分裂 |
| single/multi 共享同一主链 | 单测/集成测试证明 + daemon close-loop 证据 |
| multi-pane 比例正确 | `useTerminalWorkspace` / `TerminalPage` 测试 + 真机截图 |
| multi-pane 可正常上下滚动 | `TerminalPage.tab-isolation.test.tsx` + 真机验证 |
| multi-pane 正常刷新 | multi-pane refresh 相关测试 + 真机验证 |
| 分屏不卡顿 | render store / render gate 证据 + 真机验证 |

---

## 9. 当前不在范围

以下内容本轮不新增设计：

- 新的 multi-pane 特判
- 新的 fallback transport 语义
- 新的 daemon 客户端状态机
- 为分屏单独长第二套 buffer/render 主链

本轮只做：

```text
删错的
-> 收口 ownership
-> 恢复单一实现
-> 再验证单屏/分屏共享同一主链
```
