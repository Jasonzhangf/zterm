# zterm Android 架构审计报告（共享函数库 + blocks + 纯编排）

- 日期：2026-05-24
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计主题：当前代码是否已按 **共享函数库 + blocks + 纯编排** 设计，以及后续改进空间

## 1. 审计结论

**结论：部分达标，未完全达标。**

当前代码库已经明显朝你要求的三层结构收口：

```text
编排层 orchestration
    ↓
blocks / 真源块
    ↓
shared pure functions / leaf modules
```

但现状不是“已经彻底达标”，而是：

1. **共享函数库层**：已经真实建立，而且是当前最健康的一层。
2. **blocks 层**：已经形成主体框架，尤其 session / open-tab / server runtime 一带拆分明显。
3. **纯编排层**：只有部分入口接近达标，**`TerminalPage.tsx` 明显未达标**，仍是当前最主要结构热点。

也就是说，这套代码**不是旧式单体页面/单体 context**，但也**还没有彻底成为纯编排架构**。

---

## 2. 审计依据与范围

### 2.1 文档依据

- `AGENTS.md`
- `android/docs/architecture.md`
- `android/docs/ui-slices.md`
- `android/CACHE.md`
- `android/MEMORY.md`

### 2.2 重点审查文件

- `android/src/App.tsx`
- `android/src/pages/TerminalPage.tsx`
- `android/src/pages/ConnectionsPage.tsx`
- `android/src/contexts/SessionContext.tsx`
- `android/src/contexts/session-context-*.ts`
- `android/src/hooks/useOpenTabRuntime.ts`
- `android/src/hooks/useSessionOpenActions.ts`
- `android/src/hooks/useTerminalShellActions.ts`
- `android/src/lib/*`
- `packages/shared/src/*`
- `android/src/server/server.ts`
- `android/src/server/terminal-core-support.ts`

### 2.3 判断标准

本次审计按以下标准判断是否达标：

1. **共享函数是否真正存在且被复用**
2. **block 是否有明确 owner**
3. **page/context/server entry 是否只是编排壳**
4. **是否存在跨层重复逻辑**
5. **是否存在“拆了文件但没拆语义”**

---

## 3. 当前总体判断

### 3.1 做对了什么

#### A. shared 纯函数层已经真实存在，不是口头模块化

重点证据：

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/buffer-sync-request-planner.ts`
- `packages/shared/src/terminal/visible-range.ts`

这些模块的共同特征：

- 输入输出明确
- 不依赖 React 生命周期
- 不依赖平台 UI
- 可直接单测
- 具备跨端复用价值

这说明共享叶子模块已经是代码真相的一部分，而不是“以后再说”的目标。

---

#### B. Android 本地也存在较成熟的 leaf/store blocks

重点证据：

- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/session-head-store.ts`
- `android/src/lib/session-viewport-mode-store.ts`
- `android/src/lib/open-tab-intent.ts`
- `android/src/lib/open-tab-persistence.ts`
- `android/src/lib/open-tab-restore.ts`

这些模块已经比较像“真源块”：

- owner 相对明确
- 边界清楚
- 不依赖页面结构
- 可被多入口消费

说明你要的“先抽纯规则 / store，再让 UI 消费”的方向已经落地了一部分。

---

#### C. `SessionContext.tsx` 本体已经明显薄化

关键数据：

- `android/src/contexts/SessionContext.tsx`：约 **298 行**

当前它主要负责：

- reducer / refs 初始化
- runtime / assemblies 装配
- stable facade 暴露

说明 client 核心上下文层已经开始从“大 God object”迁移成“薄 provider 壳 + 多 runtime blocks”。

这是正确方向。

---

#### D. server 端也在往薄入口 + support block 收口

重点证据：

- `android/src/server/server.ts`：约 **399 行**
- `android/src/server/terminal-core-support.ts`：约 **109 行**
- 对应 truth gate：`android/src/server/server.core-support-truth.test.ts`

当前 `server.ts` 不再自己塞满 terminal helper 实现，而是把一部分 helper 下沉到 `terminal-core-support.ts`。

虽然还没到“最优终态”，但方向正确。

---

### 3.2 主要未达标点

#### A. `TerminalPage.tsx` 明显不属于纯编排

关键数据：

- `android/src/pages/TerminalPage.tsx`：约 **3462 行**

这不是小问题，而是当前架构中**最核心的未收口点**。

它同时承载：

- 页面结构编排
- terminal chrome/header/quickbar/tab 管理
- keyboard/viewport/debug overlay/copy mode 等交互状态
- helper 函数
- 多个 sheet 协调
- pane attach / session 切换 / UI key 计算

这说明它不是：

```text
TerminalPage = 纯编排壳
```

而更接近：

```text
TerminalPage = page + interaction runtime + overlay coordinator + helper bag + sheet orchestrator
```

**这直接违背“纯编排”要求。**

---

#### B. `session-context-*` 虽然拆了很多块，但层次有些过碎、胶水层偏厚

典型文件：

- `session-context-buffer-runtime.ts`
- `session-context-session-runtime.ts`
- `session-context-transport-runtime.ts`
- `session-context-message-assemblies.ts`
- `session-context-provider-assemblies.ts`
- `session-context-transport-orchestration-runtime.ts`

这套结构已经明显比“一个 SessionContext.tsx 干所有事”更好，
但现在的新问题是：

1. **装配层过厚**
2. **命名体系过多**（runtime / orchestration / lifecycle / assemblies / facade / provider）
3. **容易让人分不清唯一 owner 在哪**

也就是说，当前问题不再是“没拆”，而是：

> **拆成很多块了，但有些块还是以“重构过程”命名，而不是以“领域唯一责任”命名。**

---

#### C. 几个大 hook 仍然是 block 与 orchestration 的混合体

关键文件与体量：

- `android/src/hooks/useOpenTabRuntime.ts`：约 **478 行**
- `android/src/hooks/useSessionOpenActions.ts`：约 **485 行**
- `android/src/hooks/useTerminalWorkspace.ts`：约 **601 行**

这些 hook 说明结构已在收口，但尚未完成“职责极化”：

- 既做领域真相
- 又做 React 生命周期接入
- 又做部分 UI/页面编排

这类文件继续长下去，会重新成为新的“软性单体”。

---

#### D. shared 与 android/lib 的边界还未完全冻结

当前 terminal planner 相关逻辑已经有一部分进入：

- `packages/shared/src/terminal/*`

但 Android 侧仍有不小一层 planner/helper 包装，例如：

- `android/src/contexts/session-buffer-planner-helpers.ts`
- `android/src/contexts/session-visible-range-helpers.ts`
- `android/src/contexts/session-pull-state-helpers.ts`

这不一定错，但它说明当前结构还处于：

> **shared 真源已建立，但 shared 真源面还未完全冻结。**

如果不继续收口，未来容易长成：

- shared 一套 planner
- android 再包一层 planner helpers
- helpers 再混入 app-specific 规则

最终又回到跨层重复逻辑。

---

## 4. 分层审计

### 4.1 Shared 函数库层

#### 判断

**整体良好，是当前最健康的一层。**

#### 优点

1. terminal leaf modules 已形成体系
2. 命名和职责多数接近纯规则/纯计算
3. 测试友好
4. 符合“公共逻辑下沉 shared”的方向

#### 不足

1. 还没有吃下所有 terminal planner / normalization / identity 逻辑
2. `shared` 与 `android/lib` 的职责边界还未完全制度化
3. 目前更多是“实践收口”，还不是“强门禁收口”

#### 审计结论

**shared 层方向正确，应该继续加码，不该回撤。**

---

### 4.2 blocks 层

#### 判断

**已形成主体结构，但存在“块很多、胶水也很多”的问题。**

#### 做得对的 blocks

##### 1) store / truth block 类

- `session-buffer-store.ts`
- `session-render-gate.ts`
- `session-head-store.ts`
- `session-viewport-mode-store.ts`

这些是当前 blocks 设计里最稳的部分。

##### 2) open-tab truth slice

- `open-tab-intent.ts`
- `open-tab-persistence.ts`
- `open-tab-restore.ts`

这组模块已经接近“真源切片”应有形态。

##### 3) server runtime/support blocks

- `terminal-core-support.ts`
- `terminal-mirror-runtime.ts`
- `terminal-transport-runtime.ts`
- `terminal-control-runtime.ts`
- `terminal-schedule-runtime.ts`

server 端比 page 端更像“按能力块拆”。

#### 问题

##### 问题 1：有些所谓 blocks 其实还是编排胶水

比如：

- `session-context-message-assemblies.ts`
- `session-context-provider-assemblies.ts`
- `session-context-transport-orchestration-runtime.ts`

这些文件不是没有价值，但更像：

- wiring 层
- 装配层
- orchestrator 中间层

它们不应与真正的 truth block 混为同一语义层。

##### 问题 2：命名体系不稳定

当前出现了：

- `*-runtime.ts`
- `*-orchestration-runtime.ts`
- `*-lifecycle-runtime.ts`
- `*-provider-assemblies.ts`
- `*-public-facade-runtime.ts`

这会让维护者不容易快速判断：

- 谁是状态 owner
- 谁是纯规则
- 谁是执行块
- 谁只是编排

##### 问题 3：部分 block 仍按“拆分过程”命名，而不是按领域真相命名

这会带来一个长期问题：

> 看得出代码被拆过，但不容易一眼看出“哪个文件对哪个真相负责”。

#### 审计结论

**blocks 层已经成型，但后续要从“拆文件”升级到“冻结唯一领域 owner”。**

---

### 4.3 编排层

#### 判断

**当前最弱的一层。**

---

#### `App.tsx`

##### 评价

**基本合格，但仍偏胖。**

##### 做得对的地方

- 已经不像过去那种单页大控制器
- page 组件已分离
- 多数能力来自 hooks/runtime/lib

##### 问题

`AppContent` 仍装配了过多横切能力：

- app update
- relay debug
- host storage
- tab runtime
- shell actions
- session open actions
- picker sheet
- available manifest modal

它已经是“总编排器”，这本身不完全错误，但后续若继续膨胀，会重新形成新热点。

##### 判断

**接近纯编排，但需要继续减重。**

---

#### `SessionContext.tsx`

##### 评价

**当前 client 端最接近纯编排壳的模块之一。**

##### 做得对的地方

- 自身文件已经明显变薄
- 主要职责是 wiring/facade/provider
- runtime 真相已往下沉

##### 剩余问题

- 下游层级命名复杂
- 装配链仍偏厚

##### 判断

**基本达标，但下游结构仍需收口。**

---

#### `TerminalPage.tsx`

##### 评价

**明确不达标。**

##### 原因

- 不是纯编排
- 文件过大
- 同时承载 UI helper、状态机、overlay 协调、交互逻辑、sheet 协调

##### 判断

**这是当前唯一最主要的编排层热点。**

---

## 5. 关键证据

### 5.1 文件体量证据

- `android/src/pages/TerminalPage.tsx`：**3462 行**
- `android/src/pages/ConnectionsPage.tsx`：**565 行**
- `android/src/contexts/SessionContext.tsx`：**298 行**
- `android/src/hooks/useOpenTabRuntime.ts`：**478 行**
- `android/src/hooks/useSessionOpenActions.ts`：**485 行**
- `android/src/contexts/session-context-buffer-runtime.ts`：**778 行**
- `android/src/contexts/session-context-session-runtime.ts`：**524 行**
- `android/src/contexts/session-context-transport-runtime.ts`：**494 行**
- `android/src/server/server.ts`：**399 行**

这些数字说明：

- `SessionContext.tsx` 本体已经瘦身成功
- server 入口也相对受控
- **TerminalPage 仍是巨大单点**

---

### 5.2 shared 终端 planner 已真实下沉

重点模块：

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/buffer-sync-request-planner.ts`

说明“共享函数库”不是口头目标，而是现有结构中的真实层级。

---

### 5.3 server 已通过 truth test 约束 helper 下沉

重点证据：

- `android/src/server/server.core-support-truth.test.ts`

它明确约束：

- `server.ts` 只使用 `createTerminalCoreSupport()` 暴露的 helper
- `server.ts` 不应再内联这些 terminal helper 实现

这说明你们已经在用**结构门禁**保护“support block + thin glue”方向。

---

## 6. 具体改进空间

以下按优先级排序。

---

### P0：先把 `TerminalPage.tsx` 收成真正纯编排壳

#### 为什么这是第一优先级

因为当前 shared 层已经存在，SessionContext 壳也已薄化，server 入口也在收口。

**最明显违背三层结构的，就是 `TerminalPage.tsx`。**

这不是“可以顺手优化”的问题，而是当前最主要结构真源偏差点。

#### 建议拆分方向

不是按 JSX 小组件随便拆，而是按**职责真相**拆：

1. `terminal-page-render-keys.ts`
  - 各类 session/page/ui identity key helper

2. `terminal-copy-selection.ts`
  - copy selection state / row coverage / clipboard text projection

3. `terminal-keyboard-lift.ts`
  - keyboard inset / viewport / header top inset / layout viewport 计算

4. `useTerminalPageOverlays.ts`
  - debug overlay / copy menu / tab manager / schedule / screenshot / transfer sheet 协调

5. `useTerminalPageInteractionRuntime.ts`
  - interactive session / switch / pane attach / quickbar interaction / UI runtime

6. `TerminalPage.tsx`
  - 只保留 props 拼装、hooks 调用、页面 stage 组合、最终 JSX 壳

#### 目标

不是单纯把行数砍短，而是要达到：

> **一眼看上去，它就是编排壳，不是混合逻辑包。**

---

### P1：稳定 `session-context-*` 的层次命名

当前问题不是“没拆”，而是拆出来的层次太多，维护成本开始上升。

#### 建议只保留这几类命名

1. `*-store.ts`
  - 状态真源块

2. `*-rules.ts` / `*-planner.ts`
  - 纯规则/纯决策块

3. `*-runtime.ts`
  - 单领域执行块，有状态，无 UI

4. `*-orchestrator.ts`
  - 组合多个 runtime/store/rules

5. `*-facade.ts`
  - 对 React/page/context 暴露薄接口

#### 当前不建议继续扩张的命名风格

- `provider-assemblies`
- `infra-facade-runtime`
- `public-facade-runtime`
- `transport-control-orchestration-runtime`

这些名字不是绝对错误���但层级过多，长期会影响可读性和 owner 辨识。

---

### P2：把 Android 侧 planner/helper 再往 shared 下沉一层

尤其是 terminal planner 相关。

#### 适合下沉的判断标准

如果一个模块满足以下条件，应优先考虑放到 `packages/shared`：

1. 不依赖 React
2. 不依赖浏览器 API
3. 不依赖 Android/Capacitor
4. 只处理纯数据
5. server/mac/android 未来可能复用

#### 目的

让 blocks 只做编排，不再在 Android 层继续长第二套规则包装。

---

### P3：把大 hook 继续拆成“domain runtime”与“React facade”

重点对象：

- `useOpenTabRuntime.ts`
- `useSessionOpenActions.ts`
- `useTerminalWorkspace.ts`

#### 方向

React hook 只负责：

- 接 React 生命周期
- 管 effect 边界
- 把 domain runtime 暴露给组件

真正的领域逻辑应进一步下沉为：

- runtime/store/planner/orchestrator

避免 hook 自己重新长成“隐形 God object”。

---

### P4：把结构约束制度化，而不是只靠记忆

当前已有部分 truth gate，这是对的。建议继续扩张为以下门禁：

#### 1. 文件大小门禁

建议至少对以下入口设置警戒：

- `TerminalPage.tsx > 800` 报警
- `App.tsx > 500` 报警
- `SessionContext.tsx > 400` 报警

#### 2. forbidden import 门禁

例如：

- `server` 禁止 import `@zterm/shared` root，只能 import leaf modules
- page 层禁止直连 transport deep runtime
- shared 禁止 import React / Capacitor / browser UI API

#### 3. truth owner 门禁

为关键真相建立 owner 约束：

- open-tab truth
- session transport truth
- terminal buffer truth
- visible-range / follow / reading truth

避免未来又在别处长出第二套实现。

---

## 7. 模块级审计意见

### 7.1 `App.tsx`

#### 结论

**基本合格，偏胖。**

#### 问题

- 横切能力装配过多
- picker / modal / update / relay / tab runtime 全在一层

#### 建议

- 可拆 `useAppShellRuntime`
- 可拆 `AppGlobalOverlays`
- 可拆 `AppPickerCoordinator`

---

### 7.2 `SessionContext.tsx`

#### 结论

**基本达标，是当前较健康的编排壳。**

#### 问题

- 下游层级命名仍需稳定
- assembly/wiring 层偏厚

#### 建议

- 继续压缩中间装配层
- 稳定 runtime / facade / orchestrator / planner 边界

---

### 7.3 `TerminalPage.tsx`

#### 结论

**当前最需要重构的文件。**

#### 问题

- 非纯编排
- 文件极大
- UI helper / 状态机 / overlay 协调 / sheet 协调耦合

#### 建议

- 先抽纯 helper
- 再抽 overlay/runtime hooks
- 最后把 page 收成 orchestration shell

---

### 7.4 `useOpenTabRuntime.ts`

#### 结论

**方向正确，但仍偏厚。**

#### 问题

- restore/runtime sync/page coordination 混在一起

#### 建议

- 拆 runtime store / restore orchestrator / foreground refresh runtime / facade

---

### 7.5 `useSessionOpenActions.ts`

#### 结论

**已接近“用例编排层”，但还没完全纯化。**

#### 问题

- picker state
- group actions
- page navigation
- saved tabs import/export
- session open use-case

混在同一 hook。

#### 建议

- picker UI state 与 domain action 分离
- 形成稳定的 use-case orchestrator

---

### 7.6 `packages/shared`

#### 结论

**这是当前最值得继续加强的一层。**

#### 建议

- 继续吸 terminal planner / identity / normalization / viewport pure logic
- 明确 leaf import 规范
- 禁止 shared 反向长平台依赖

---

### 7.7 server 侧

#### 结论

**整体比 client page 端更接近“薄入口 + blocks”。**

#### 建议

- 保持 `server.ts` 只做装配
- 类似 `terminal-core-support.ts` 的 support 下沉方式继续沿用
- 配套 truth tests 继续保留并扩展

---

## 8. 最终判定

### 是否已经按“共享函数库 + blocks + 纯编排”设计？

**答案：没有完全达标，但已经形成正确骨架。**

更细化地说：

#### 已达标部分

- 共享函数库层：**明显成立**
- blocks 基本骨架：**明显成立**

#### 未达标部分

- 纯编排层：**只部分成立**
- block 命名/owner 稳定性：**还未冻结**
- shared 与 android/lib 的终局边界：**还可继续收口**

---

## 9. 唯一主改进点判断

如果只问“下一步最该改哪里”，不是泛泛地说“继续优化 blocks”，而是：

> **唯一主目标：把 `android/src/pages/TerminalPage.tsx` 收成真正的纯编排壳。**

这是当前最主要、最确定、最唯一的结构改进点，原因如下：

1. shared 层已经存在，不是当前主矛盾
2. SessionContext 本体已薄化，不是当前主矛盾
3. server 入口已有 support 收口，不是当前主矛盾
4. **只有 TerminalPage 仍同时持有编排、交互状态机、overlay 协调、UI helper、sheet 协调，直接违背纯编排原则**

所以它不是“其中一个可以改的点”，而是当前阶段最明确的唯一主热点。

---

## 10. 建议执行顺序

### 第一阶段

1. 重构 `TerminalPage.tsx`
2. 建立 page 级纯编排门禁
3. 把 keyboard/copy/overlay/debug 等 runtime/helper 下沉

### 第二阶段

4. 统一 `session-context-*` 层级命名
5. 压缩 assemblies / facade / runtime 的中间胶水层
6. 把大 hook 继续拆为 domain runtime + React facade

### 第三阶段

7. 继续把 terminal 纯 planner 下沉到 `packages/shared`
8. 增加 file-size / forbidden-import / truth-owner 门禁
9. 收紧 shared 与 android/lib 的边界

---

## 11. 审计结语

当前代码库最大的好消息是：

**它已经不是“假模块化”了，shared 和 blocks 都已经真实存在。**

当前代码库最大的坏消息是：

**纯编排层还没有彻底赢，尤其 TerminalPage 仍然是最明显的结构回流点。**

因此，本次审计的最终结论不是“推倒重来”，而是：

> **保留现有 shared + blocks 骨架，集中清理编排层，优先拿下 `TerminalPage.tsx`。**
# zterm Android 架构审计报告（共享函数库 + blocks + 纯编排）

- 日期：2026-05-24
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计主题：当前代码是否已经按“共享函数库 + blocks + 纯编排”设计，以及后续改进空间

## 1. 执行摘要

结论：**部分达标，未完全达标。**

当前代码库已经明显朝目标架构收口：

1. **共享函数库**已真实建立，不是口头概念；`packages/shared/src/*` 与 `android/src/lib/*` 中已有大量纯函数、planner、store。
2. **blocks 层**已形成，尤其是 terminal buffer / render gate / open-tab truth / session transport runtime / server runtime 这些区域，已经有独立 owner。
3. **纯编排层**只有部分达标；`SessionContext.tsx`、`server.ts` 相对较薄，但 `TerminalPage.tsx` 仍然明显是巨型混合体，不符合纯编排要求。

因此，这不是“从零开始重构”的状态，而是：

> **方向是对的，shared 与 blocks 已成形；真正没收口的是 page/orchestration 层，尤其 `TerminalPage.tsx`。**

---

## 2. 审计依据与范围

### 2.1 文档依据

- `AGENTS.md`
- `android/docs/architecture.md`
- `android/docs/ui-slices.md`
- `android/CACHE.md`
- `android/MEMORY.md`

### 2.2 代码抽样范围

重点审查：

- App 壳：
  - `android/src/App.tsx`
- Page 层：
  - `android/src/pages/ConnectionsPage.tsx`
  - `android/src/pages/ConnectionPropertiesPage.tsx`
  - `android/src/pages/SettingsPage.tsx`
  - `android/src/pages/TerminalPage.tsx`
- Context / runtime blocks：
  - `android/src/contexts/SessionContext.tsx`
  - `android/src/contexts/session-context-*.ts`
- Hook / app orchestration：
  - `android/src/hooks/useOpenTabRuntime.ts`
  - `android/src/hooks/useSessionOpenActions.ts`
  - `android/src/hooks/useTerminalShellActions.ts`
  - `android/src/hooks/useTerminalWorkspace.ts`
- Android 纯逻辑 / store：
  - `android/src/lib/*`
- Shared 纯逻辑：
  - `packages/shared/src/*`
- Daemon / server：
  - `android/src/server/server.ts`
  - `android/src/server/terminal-core-support.ts`
  - `android/src/server/*runtime*.ts`

### 2.3 本次判断标准

按以下三层结构判断：

```text
orchestration（纯编排）
    ↓
blocks（唯一真源块）
    ↓
shared functions / planners / stores（纯函数与共享叶子模块）
```

核心检查问题：

1. 是否存在稳定的共享函数真源。
2. 是否存在清晰的 block owner。
3. page/context/server entry 是否主要做编排，而不是自己承载业务实现。
4. 是否有跨层重复逻辑或“拆文件但没拆语义”。

---

## 3. 总体审计结论

### 3.1 已经做对的部分

#### A. shared 纯函数层已经成立

关键证据：

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/buffer-sync-request-planner.ts`
- `packages/shared/src/terminal/visible-range.ts`
- `packages/shared/src/connection/*`
- `packages/shared/src/layout/*`

这些模块具备以下特征：

- 输入输出是纯数据
- 不依赖 React 生命周期
- 不依赖 Android/Capacitor
- 可直接单测
- 能作为 client/server/shared 统一真源

说明：**共享函数库已成为真实结构基础，而不是临时抽 helper。**

#### B. Android 本地纯逻辑 / store 层也已经比较健康

关键证据：

- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/session-head-store.ts`
- `android/src/lib/open-tab-intent.ts`
- `android/src/lib/open-tab-persistence.ts`
- `android/src/lib/open-tab-restore.ts`
- `android/src/lib/connections-server-groups.ts`
- `android/src/lib/terminal-width-mode-manager.ts`

这些模块已经体现出“真相从组件 state 下沉到独立 block/store”的架构方向。

#### C. SessionContext 壳层已经明显瘦身

关键证据：

- `android/src/contexts/SessionContext.tsx` 约 298 行
- 真正能力被下沉到：
  - `session-context-provider-runtime.ts`
  - `session-context-provider-assemblies.ts`
  - `session-context-public-facade-runtime.ts`
  - `session-context-buffer-runtime.ts`
  - `session-context-session-runtime.ts`
  - `session-context-transport-runtime.ts`
  - `session-context-socket-message-runtime.ts`

这说明 `SessionContext.tsx` 已经更像：

> provider 壳 + facade 导出 + ref/runtime 组装

而不是单文件大状态机。

#### D. server 入口已有“support + runtime”收口趋势

关键证据：

- `android/src/server/server.ts` 约 399 行
- `android/src/server/terminal-core-support.ts` 约 109 行
- `android/src/server/server.core-support-truth.test.ts`

`server.ts` 已开始把 helper 从入口剥离到 dedicated support module，这符合“入口薄、能力块厚”的正确方向。

---

### 3.2 主要未达标点

#### A. `TerminalPage.tsx` 明显不符合“纯编排”

关键证据：

- `android/src/pages/TerminalPage.tsx`：**3462 行**

从抽样内容可见，该文件同时承载：

- 页面级编排
- keyboard / viewport / overlay 状态
- copy selection 状态机与 helper
- debug overlay 状态与 UI
- quick bar / tab manager / sheet 协调
- pane attach / active session / UI key 计算
- 大量本地 helper 函数

这意味着它不是“纯编排壳”，而是：

> **page + runtime + overlay coordinator + UI helper 集合 + 本地状态机** 的混合体。

这是当前代码库里最明显违背目标架构的点。

#### B. `session-context-*` 已拆很多块，但部分块边界仍不稳定

典型问题：

- 有些文件是 runtime
- 有些文件是 orchestration
- 有些文件是 facade
- 有些文件是 assemblies / infra glue

目前命名层次较多，例如：

- `*-runtime.ts`
- `*-orchestration-runtime.ts`
- `*-lifecycle-runtime.ts`
- `*-provider-assemblies.ts`
- `*-public-facade-runtime.ts`
- `*-infra-facade-runtime.ts`

这说明：

1. **拆分动作是真实发生的**；
2. 但还没有完全形成稳定的块层级体系；
3. 中间胶水层偏厚，维护者不容易一眼定位“唯一 owner 在哪”。

#### C. 部分“大 hook”仍混合了真源、用例与页面协调

重点文件：

- `android/src/hooks/useOpenTabRuntime.ts`（约 478 行）
- `android/src/hooks/useSessionOpenActions.ts`（约 485 行）
- `android/src/hooks/useTerminalWorkspace.ts`（约 601 行）

这些文件的共性是：

- 不只是 React hook
- 也不只是纯业务块
- 同时做了 truth runtime、page use-case、UI coordination

这类文件方向不算错，但仍不满足“React hook 只是壳、领域逻辑在 block”这一更理想的形态。

#### D. `packages/shared` 与 `android/src/lib` 的边界还可再收口

当前 terminal 相关纯逻辑已经部分进入 `packages/shared/src/terminal/*`，这是正确的。

但仍存在：

- Android 侧 planner helper 继续包装 shared planner
- 一些 request window / visible repair / range 判定还停留在 app 侧封装

这代表当前结构处于：

> **shared 已成立，但 shared 真源面尚未完全冻结。**

---

## 4. 分层审计

### 4.1 Shared 函数库层

#### 结论

**这一层是当前最健康的一层，应继续扩大。**

#### 优点

1. terminal planner / gap repair / head state / visible range 等关键规则，已经有共享叶子模块。
2. 代码风格更接近纯函数和 deterministic rule，而不是页面级 helper。
3. 很适合作为 Android / Mac / server 共同真源。

#### 问题

1. 还未覆盖所有终端 planner 相关逻辑。
2. 有些 Android 侧 helper 只是 shared 的半封装，说明迁移未彻底。
3. shared 的结构边界更多体现在实践上，门禁还不够强。

#### 评价

共享函数库已经是对的，而且是架构的主要正资产；不应回退，只应继续下沉可复用纯逻辑。

---

### 4.2 blocks 层

#### 结论

**blocks 已成形，但存在“过碎 + 胶水层较厚 + 命名层次不稳定”的问题。**

#### 做得比较好的 blocks

##### 1. store 类 block

- `session-buffer-store.ts`
- `session-render-gate.ts`
- `session-head-store.ts`
- `session-viewport-mode-store.ts`

这些模块 owner 明确、职责单一、边界稳定，是当前 blocks 层的正面样板。

##### 2. open-tab truth block

- `open-tab-intent.ts`
- `open-tab-persistence.ts`
- `open-tab-restore.ts`

这组模块已经很接近“block + leaf rules + persistence truth”的正确形态。

##### 3. server runtime blocks

- `terminal-mirror-runtime.ts`
- `terminal-transport-runtime.ts`
- `terminal-control-runtime.ts`
- `terminal-schedule-runtime.ts`
- `terminal-core-support.ts`

server 侧按能力拆块的趋势比 client page 层更明确。

#### 当前问题

##### 问题 1：中间 glue/assembly 模块偏厚

例如：

- `session-context-message-assemblies.ts`
- `session-context-provider-assemblies.ts`
- `session-context-transport-orchestration-runtime.ts`

这些文件有价值，但它们更像“组合层 / wiring 层”，不是真正的 leaf block。

当这类层过厚时，会出现：

- 不像纯 block
- 也不像最终 facade
- 变成“架构中间层堆积”

##### 问题 2：命名体系不统一

目前同一域里并存：

- `runtime`
- `orchestration-runtime`
- `lifecycle-runtime`
- `assemblies`
- `facade-runtime`
- `infra-runtime`

从长期维护看，这会弱化“唯一真源块”的可定位性。

##### 问题 3：有些文件是按重构历史命名，而不是按领域真相命名

这会导致理解者更容易看到“怎么拆出来的”，而不是“这个模块唯一负责什么”。

---

### 4.3 编排层

#### 结论

**编排层是当前最弱的一层，主要问题集中在 `TerminalPage.tsx`。**

#### `App.tsx`

评价：**基本合格，但偏胖。**

优点：

- 已经是 App shell 风格
- 页面切换逻辑存在
- 大量能力来自 hook/runtime/lib，而非内联实现

问题：

- 仍同时装配 app update、relay debug、host storage、open-tab runtime、terminal shell actions、picker sheet、update modal
- 作为入口壳可以接受，但后续继续膨胀会再次变胖

#### `SessionContext.tsx`

评价：**基本达标。**

它已经接近真正的：

> 纯 Provider 壳 + stable facade 暴露层

这部分结构方向明确，后续重点不是大改，而是压缩其下游层级复杂度。

#### `TerminalPage.tsx`

评价：**明确不达标。**

它目前不是纯 orchestration shell，而是当前最大的“多职责聚合点”。

---

## 5. 关键证据

### 5.1 说明“纯编排未达标”的证据

- `android/src/pages/TerminalPage.tsx`：3462 行

这单点已经足够说明 terminal page 没有收口成纯编排层。

### 5.2 说明“Context 壳层已经瘦身”的证据

- `android/src/contexts/SessionContext.tsx`：约 298 行

这表明 client runtime 主逻辑已经下沉，不再堆在单一 context 壳中。

### 5.3 说明“blocks 已形成但仍较复杂”的证据

- `android/src/contexts/session-context-buffer-runtime.ts`：约 778 行
- `android/src/contexts/session-context-session-runtime.ts`：约 524 行
- `android/src/contexts/session-context-transport-runtime.ts`：约 494 行
- `android/src/contexts/session-context-provider-core-assemblies.ts`：约 417 行
- `android/src/contexts/session-context-transport-orchestration-runtime.ts`：约 461 行

说明：

- 确实拆块了
- 但部分块仍偏厚，且中间层次仍复杂

### 5.4 说明“shared 纯规则真源已存在”的证据

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/buffer-sync-request-planner.ts`

### 5.5 说明“server 入口也在收口”的证据

- `android/src/server/server.ts`：约 399 行
- `android/src/server/terminal-core-support.ts`：约 109 行
- `android/src/server/server.core-support-truth.test.ts`

---

## 6. 主要改进空间

### P0：优先把 `TerminalPage.tsx` 拆成真正的纯编排壳

这是当前唯一最明显、最需要立即处理的架构热点。

#### 建议拆分方向

不是按视觉组件机械拆 JSX，而是按责任拆：

1. `terminal-page-render-keys.ts`
  - 收口 session/header/ui key helper
2. `terminal-copy-selection.ts`
  - 收口 copy selection 状态、buffer text 提取、clipboard helper
3. `terminal-keyboard-lift.ts`
  - 收口 keyboard inset / visual viewport / layout viewport 计算
4. `useTerminalPageOverlays.ts`
  - 管理 debug overlay / copy menu / tab manager / schedule / screenshot / transfer sheet 开关与协同
5. `useTerminalPageInteractionRuntime.ts`
  - 管理 interactive session / pane attach / quick bar / current focus interaction
6. `TerminalPage.tsx`
  - 最终只保留 orchestration：读 props、调用 hooks、拼 stage/chrome/overlay、返回 JSX

#### 目标状态

`TerminalPage.tsx` 应从“巨型多职责文件”变成：

> **纯 page shell：只负责编排，不负责实现。**

---

### P1：稳定 `session-context-*` 的层级与命名

建议固定为以下 5 类：

1. `*-store.ts`
  - 状态真源块
2. `*-rules.ts` / `*-planner.ts`
  - 纯规则块
3. `*-runtime.ts`
  - 单领域执行块
4. `*-orchestrator.ts`
  - 组合多个 block 的编排块
5. `*-facade.ts`
  - 对外暴露的薄接口层

不建议继续扩张类似：

- `provider-assemblies`
- `public-facade-runtime`
- `infra-facade-runtime`
- `transport-control-orchestration-runtime`

这些名字虽然表达信息多，但长期会降低可读性和 owner 可定位性。

---

### P2：继续把 Android 侧 planner/helper 下沉到 `packages/shared`

下沉判定标准：

- 不依赖 React
- 不依赖浏览器/Capacitor
- 输入输出是纯数据
- server/mac/android 都可能复用

重点候选：

- `session-buffer-planner-helpers.ts` 中仍属纯规划的逻辑
- 可复用的 visible range / request window / repair 判定
- session identity / target normalize 中的跨端纯规则

目标：

> block 只做 orchestration，不再内嵌业务规则。

---

### P3：把大 hook 进一步拆成“runtime block + React facade”

重点文件：

- `useOpenTabRuntime.ts`
- `useSessionOpenActions.ts`
- `useTerminalWorkspace.ts`

建议思路：

- 把领域真相��纯运行逻辑抽到 `lib/` 或独立 runtime 文件
- hook 只负责 React 生命周期接入、依赖注入、向 page 暴露薄接口

这样更符合：

> React hook 是壳；领域逻辑是真源块。

---

### P4：补结构门禁，而不是只靠人工守纪律

建议新增：

#### 1. 文件大小门禁

例如：

- `TerminalPage.tsx > 800` 报警
- `App.tsx > 500` 报警
- `SessionContext.tsx > 400` 报警

#### 2. forbidden import 门禁

例如：

- server 端禁止 import `@zterm/shared` 根入口
- shared 层禁止 import React / Capacitor / DOM API
- page 层禁止直接 import 深层 transport/runtime 真相实现

#### 3. truth owner 门禁

对 terminal buffer、open tabs、session transport 等核心域维护 owner 清单与禁止重复实现清单。

---

## 7. 模块逐项判断

### 7.1 `App.tsx`

#### 结论

**基本合格，仍可继续瘦身。**

#### 原因

- 已是 page shell / app shell 风格
- 大量实际能力来自 hooks/runtime/lib
- 但仍汇总过多横切能力

#### 改进建议

- 拆 `useAppShellRuntime`
- 拆 `AppModalLayers`
- 拆 `AppPickerCoordinator`

---

### 7.2 `SessionContext.tsx`

#### 结论

**当前已接近纯编排壳，是正确方向。**

#### 原因

- Provider 壳较薄
- 能力主要来自 runtime/assemblies/facade
- 对外只暴露 context facade

#### 改进建议

- 不是再把它做大
- 而是整理其下游层次命名与 glue 层厚度

---

### 7.3 `TerminalPage.tsx`

#### 结论

**明确不达标，是当前第一重构目标。**

#### 原因

- 单文件超大
- 同时持有 page 编排、overlay 协调、UI helper、交互状态机、viewport/keyboard 逻辑
- 不符合“纯编排只组装 block”的要求

#### 改进建议

- 先抽纯 helper
- 再抽 interaction runtime / overlay runtime
- 最后保留 page shell

---

### 7.4 `useOpenTabRuntime.ts`

#### 结论

**方向正确，但还偏厚。**

#### 原因

- open-tab truth 已相对收口
- 但 restore/runtime sync/foreground/page coordination 仍混在一个 hook 里

#### 改进建议

- 拆 runtime store / restore orchestrator / facade hook

---

### 7.5 `useSessionOpenActions.ts`

#### 结论

**像用例编排层，但职责面仍偏宽。**

#### 原因

- 同时管理 picker mode、group editing、saved tabs、page navigation、session open actions

#### 改进建议

- 分离 picker UI state 与 session open domain action
- 让它更像明确的 use-case orchestrator

---

### 7.6 `packages/shared`

#### 结论

**这是当前最值得继续加强的正确方向。**

#### 改进建议

- 继续吸纳跨端纯 planner / normalize / identity / viewport rule
- 明确 root import 禁止与 leaf import 优先门禁
- 禁止 shared 反向长出平台依赖

---

### 7.7 server 侧

#### 结论

**比 client page 层更接近“薄入口 + blocks”。**

#### 原因

- `server.ts` 已不算大
- support/runtime 拆分正在形成
- 已有 truth gate test

#### 改进建议

- 保持 `server.ts` 只做装配
- 持续把纯 support/helper 收到 shared 或 dedicated support module

---

## 8. 最终判定

### 8.1 是否已经按“共享函数库 + blocks + 纯编排”设计？

**答案：没有完全达标，但已经明显走在正确轨道上。**

更细分地说：

#### 已达标部分

- 共享函数库：**基本成立**
- block owner：**主体已形成**
- Context/server 壳层：**部分已接近纯编排**

#### 未达标部分

- page 纯编排：**尤其 `TerminalPage.tsx` 未达标**
- block 层命名/层次稳定性：**仍需收口**
- shared 与 android/lib 真源边界：**仍可继续统一**

---

## 9. 下一步建议顺序

### 第一阶段（最优先）

1. 重构 `android/src/pages/TerminalPage.tsx`
2. 为 TerminalPage 建立纯编排门禁
3. 抽出 copy/keyboard/overlay/debug 等职责块

### 第二阶段（结构收口）

4. 稳定 `session-context-*` 命名体系
5. 压缩 assembly/glue 层厚度
6. 让大 hook 更多退化为 facade

### 第三阶段（真源统一）

7. 继续把跨端纯 planner 下沉到 `packages/shared`
8. 增加 import / file-size / truth-owner 门禁
9. 减少 Android 侧二次包装 planner

---

## 10. 唯一性判断（本次审计最关键结论）

按当前代码事实，**本次最关键、最唯一的结构性主问题是 `android/src/pages/TerminalPage.tsx`。**

理由：

1. shared 层已经存在，不是当前主矛盾。
2. SessionContext 壳层已瘦身，不是当前主矛盾。
3. server 入口已有 support 抽离，不是当前主矛盾。
4. **只有 `TerminalPage.tsx` 仍明显同时承载编排、状态机、交互逻辑、UI helper、overlay 协调，直接违反“纯编排”要求。**

因此，若要继续推进这套架构，唯一正确的下一主目标不是泛泛“继续拆 blocks”，而是：

> **先把 `TerminalPage.tsx` 收成真正的纯编排壳。**

这是当前最直接、最排他的结构改进点；其他改进都应围绕这一主矛盾展开，而不是分散火力。
# zterm Android 架构审计报告（共享函数库 + blocks + 纯编排）

- 日期：2026-05-24
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计主题：当前代码是否已按 **共享函数库 + blocks + 纯编排** 方式设计，并识别主要改进空间
- 审计方式：基于代码结构、文件职责、模块依赖、体量分布、项目文档真源的静态结构审计

---

## 1. 执行摘要

### 1.1 总结论

**当前代码库已经明显朝“共享函数库 + blocks + 纯编排”方向演进，并且共享函数库与部分 blocks 已经真实成立；但“纯编排层”尚未全面达标，尤其 `TerminalPage.tsx` 仍然是当前最突出的结构性违例点。**

更细一点说：

1. **共享函数库**：已经成立，且不是口头抽象，`packages/shared/src/*` 与 `android/src/lib/*` 内已有多处真实纯函数/纯规则/纯 store 真源。
2. **blocks 层**：已经形成，特别是 `SessionContext` 周边、open-tab、buffer/render store、server runtime/support 已有明确分层雏形。
3. **纯编排层**：只在部分入口达标；`SessionContext.tsx`、`App.tsx` 已接近或部分达到目标，但 `TerminalPage.tsx` 明显未达标。
4. **主要风险**：当前不是“没拆”，而是“已经拆出很多块，但部分地方仍是大页/大 hook/大 assembly 继续承载混合语义”。

### 1.2 最关键结论

如果只指出一个当前最需要整改的唯一主热点，那么是：

- `android/src/pages/TerminalPage.tsx`

它目前同时持有：

- 页面编排
- 终端交互状态机
- overlay/sheet 协调
- copy/debug/keyboard/helper 逻辑
- pane/tab/quickbar 交互 glue

这直接违背了“page 只做编排、blocks 持有真相、shared 持有纯规则”的三层铁律。

---

## 2. 审计范围与依据

### 2.1 读取的规则与真源文档

本次审计以以下文档为判断基线：

- `AGENTS.md`
- `android/docs/architecture.md`
- `android/docs/ui-slices.md`
- `android/CACHE.md`
- `android/MEMORY.md`

其中尤其采用以下真源约束：

- UI/App 只做页面与壳层消费，不补业务真相
- terminal 链路必须保持 `server / buffer manager / renderer / UI shell` 独立
- 真源必须唯一，禁止越层漂移
- 公共规则优先下沉到 shared 纯模块

### 2.2 抽样与重点文件

本次重点审查了以下文件/文件群：

- 入口与页面
  - `android/src/App.tsx`
  - `android/src/pages/TerminalPage.tsx`
  - `android/src/pages/ConnectionsPage.tsx`
- SessionContext 体系
  - `android/src/contexts/SessionContext.tsx`
  - `android/src/contexts/session-context-*.ts`
- hooks
  - `android/src/hooks/useOpenTabRuntime.ts`
  - `android/src/hooks/useSessionOpenActions.ts`
  - `android/src/hooks/useTerminalShellActions.ts`
  - `android/src/hooks/useTerminalWorkspace.ts`
- lib/shared
  - `android/src/lib/*`
  - `packages/shared/src/*`
- server
  - `android/src/server/server.ts`
  - `android/src/server/terminal-core-support.ts`

### 2.3 采用的判断标准

本报告按以下三层模型审计：

```text
orchestration / 编排层
    ↓
blocks / 领域真源块
    ↓
shared pure functions / stores / leaf modules
```

重点检查：

1. 是否存在可验证的共享函数真源
2. 是否存在清晰 block owner
3. 顶层 page/context/server 是否只做编排
4. 是否存在跨层重复逻辑
5. 是否存在“文件拆了但语义没拆”的伪模块化

---

## 3. 代码结构现状概览

### 3.1 明显已经出现的正确结构信号

��前结构中，已经可以明确看到以下正确趋势：

1. `packages/shared/src/terminal/*` 已承担 terminal 纯规则/纯 planner 能力
2. `android/src/lib/*` 中已经出现多个 store / intent / persistence / manager 类单一职责模块
3. `SessionContext.tsx` 已从“大 Context God Object”变成薄 provider 壳
4. server 入口 `server.ts` 已开始把 helper/support 逻辑抽到独立模块

这说明当前仓库并不是“全靠页面和 hook 堆逻辑”，而是已经有真实架构收口动作。

### 3.2 体量分布暴露的问题点

抽样得到的关键文件体量如下：

- `android/src/pages/TerminalPage.tsx`：**3462 行**
- `android/src/contexts/SessionContext.tsx`：298 行
- `android/src/hooks/useOpenTabRuntime.ts`：478 行
- `android/src/hooks/useSessionOpenActions.ts`：485 行
- `android/src/hooks/useTerminalWorkspace.ts`：601 行
- `android/src/contexts/session-context-buffer-runtime.ts`：778 行
- `android/src/contexts/session-context-session-runtime.ts`：524 行
- `android/src/contexts/session-context-transport-runtime.ts`：494 行
- `android/src/server/server.ts`：399 行
- `android/src/server/terminal-core-support.ts`：109 行

这个分布说明：

- Context/provider 壳层已经薄化
- server entry 相对可控
- **TerminalPage 仍异常膨胀**
- 一批 hooks/runtime/assembly 模块仍然承担较大复合职责

---

## 4. Shared 函数库层审计

### 4.1 结论

**Shared 函数库层整体健康，是当前架构里最接近目标的一层。**

### 4.2 证据

在 `packages/shared/src/terminal/*` 已存在以下纯规则模块：

- `buffer-sync-planner.ts`
- `gap-repair-planner.ts`
- `buffer-head-state.ts`
- `visible-range.ts`
- `buffer-sync-request-planner.ts`
- `pull-state-planner.ts`
- `renderer/*`

这些模块的共同特征：

- 输入输出都是纯数据
- 不依赖 React
- 不依赖平台 API
- 可单测
- 语义符合 terminal 纯规则/纯 planner 定位

在 Android 本地 `lib` 侧，也已有不少符合 leaf/shared-block 特征的模块：

- `session-buffer-store.ts`
- `session-render-gate.ts`
- `open-tab-intent.ts`
- `open-tab-persistence.ts`
- `open-tab-restore.ts`
- `connections-server-groups.ts`
- `terminal-width-mode-manager.ts`

### 4.3 已做对的地方

1. **terminal 纯 planner 已经开始下沉 shared**，不是把所有决策继续留在 page/context。
2. **store 型块已从 React 状态中抽离**，例如 buffer/render/head 相关 store。
3. **shared 叶子导入意识已经存在**，文档和记忆里也强调 server 侧只能 import leaf module，不准直接拿根入口。

### 4.4 问题与改进空间

Shared 层当前主要不是“错误”，而是“覆盖面还不够彻底”：

1. Android 侧还保留一部分 planner/helper 包装层，例如 `session-buffer-planner-helpers.ts`。
2. `packages/shared` 与 `android/src/lib` 的边界还没完全冻结，仍有进一步统一空间。
3. 还缺少更强的结构门禁，防止未来把平台逻辑反向长回 shared。

### 4.5 判定

**Shared 层达标度较高，建议继续扩张 shared 纯规则覆盖面，而不是回撤。**

---

## 5. Blocks 层审计

### 5.1 结论

**Blocks 层已经成立，但当前存在“块很多、层次有些过碎、装配胶水偏厚”的问题。**

### 5.2 当前已经比较像真正 block 的模块

#### 5.2.1 Store/真相块

这些模块最接近“单一真源块”：

- `session-buffer-store.ts`
- `session-render-gate.ts`
- `session-head-store.ts`
- `session-viewport-mode-store.ts`

优点：

- owner 清楚
- 状态边界清楚
- UI 不直接持有其内部真相
- 能被多个上层消费

#### 5.2.2 Open-tab 真相块

这组也比较完整：

- `open-tab-intent.ts`
- `open-tab-persistence.ts`
- `open-tab-restore.ts`

它们已经形成：

- intent truth
- persistence truth
- restore plan truth

这符合“block 有唯一职责 owner”的方向。

#### 5.2.3 Server runtime/support 块

例如：

- `terminal-core-support.ts`
- `terminal-mirror-runtime.ts`
- `terminal-transport-runtime.ts`
- `terminal-control-runtime.ts`
- `terminal-schedule-runtime.ts`

server 侧整体比 client 侧更接近“按能力块拆”的状态。

### 5.3 当前 blocks 层的主要问题

#### 5.3.1 一部分所谓 block 其实是装配层，不是真正 truth owner

例如：

- `session-context-message-assemblies.ts`
- `session-context-provider-assemblies.ts`
- `session-context-provider-core-assemblies.ts`
- `session-context-transport-orchestration-runtime.ts`

这些文件并不是错，但它们更像：

- wiring 层
- assembly 层
- orchestration 中间层

它们不应和真正的 truth block 混成同一种概念。

#### 5.3.2 命名层次不稳定

当前并存的命名有：

- `*-runtime.ts`
- `*-orchestration-runtime.ts`
- `*-lifecycle-runtime.ts`
- `*-provider-assemblies.ts`
- `*-public-facade-runtime.ts`
- `*-infra-facade-runtime.ts`

这说明当前拆分更像“演进过程中的拆分痕迹”，而不是已经冻结的稳定层级体系。

直接后果是：

- 新人难以快速判断 owner
- 同类职责容易在不同层重复出现
- 难以通过文件名直接看出“这是规则块 / 状态块 / 执行块 / 编排块”

#### 5.3.3 某些块仍然过厚

例如：

- `session-context-buffer-runtime.ts`：778 行
- `session-context-session-runtime.ts`：524 行
- `session-context-transport-runtime.ts`：494 行

这些文件不是必须立即拆碎，但说明这些 runtime block 内部仍可能混有：

- 规则
- 状态推进
- side effect 调度
- 消息处理 glue

如果继续增长，会再次变成“大块内部再长第二真源”。

### 5.4 判定

**Blocks 层方向正确，但还需要从“已拆文件”继续走到“已稳定责任边界”。**

---

## 6. 纯编排层审计

### 6.1 总结论

**纯编排层是当前最弱的一层。**

不是完全没有，而是只有一部分入口已收口；另一些关键页面和大 hook 仍混有大量本应属于 block/shared 的语义。

---

### 6.2 `SessionContext.tsx` 审计

#### 结论

**`SessionContext.tsx` 已经基本达到“薄壳 + facade + 编排”的目标。**

#### 证据

`SessionContext.tsx` 现在主要做：

- reducer 初始化
- refs 初始化
- runtime/provider/assemblies 装配
- stable facade 暴露
- context provider 输出

它自身没有再内联一大堆 transport/buffer/session 业务细节。

#### 评价

这是 client 侧最接近纯编排壳的模块之一。

#### 剩余问题

`SessionContext.tsx` 本体虽然已经薄了，但它依赖的下游层次命名仍较复杂，因此“壳是薄的，背后的楼层图还不够稳定”。

---

### 6.3 `App.tsx` 审计

#### 结论

**`App.tsx` 基本合格，但仍偏胖。**

#### 做对的地方

- `App.tsx` 已经像 app shell，而不再直接承载终端细节实现
- 主要通过 hooks/runtime 组合能力
- 页面切换逻辑与具体页面组件已经分层

#### 当前问题

`AppContent` 仍然汇总了很多横切能力：

- app update
- relay device/debug
- host storage
- open-tab runtime
- terminal shell actions
- session open actions
- picker sheet
- 全局更新弹窗

这让它已经接近“应用总���排器”。短期可接受，但长期还应该继续分拆。

#### 判定

`App.tsx` 当前不是主矛盾，但确实存在继续膨胀风险。

---

### 6.4 `TerminalPage.tsx` 审计

#### 结论

**`TerminalPage.tsx` 明确不符合纯编排设计，是本次审计最关键的问题点。**

#### 证据

- 文件长度：**3462 行**
- 从抽样内容可见，它同时持有：
  - TerminalHeader / QuickBar / TabManager / ScheduleSheet / FileTransferSheet / RemoteScreenshotSheet 的协调
  - keyboard inset / visual viewport / layout helper
  - copy selection 状态与 buffer -> plain text 转换
  - debug overlay UI 与拖拽状态
  - pane attach / active session / chrome session 派生逻辑
  - 一系列 render key / input epoch / header key helper

#### 为什么这不是“小问题”

这不是简单的“文件太长”，而是说明：

- page 本应只做编排
- 但现在 page 同时是：
  - orchestration layer
  - overlay controller
  - interaction runtime
  - helper bucket
  - state machine carrier

这已经越过 page 的职责边界。

#### 直接风险

1. 任何 terminal UI 变更都更容易误伤其他交互状态机
2. 很难定位某个行为的唯一真源 owner
3. 容易把新逻辑继续“顺手加进 page”
4. page 未来会再次成为大总控文件

#### 判定

**这是当前最明确、最优先的纯编排违例点。**

---

## 7. 大 hook / 大 runtime 结构审计

### 7.1 `useOpenTabRuntime.ts`

#### 评价

**方向正确，但仍偏厚。**

#### 已做对的地方

- open-tab 真相已显式化
- persistence / intent / restore 等规则不再散落在 UI
- foreground refresh 与 restore/runtime sync 已有专门切片思路

#### 问题

这个 hook 仍混合了：

- open-tab 真相维护
- restore/runtime sync
- foreground refresh runtime
- page visible/orchestration
- remote audit 触发

它尚未完全区分：

- 真正的 open-tab block
- 恢复编排层
- React 生命周期接入层

#### 判定

它比过去状态更好，但离“hook 只是 facade”还有距离。

---

### 7.2 `useSessionOpenActions.ts`

#### 评价

**本质是“用例层”，但还没有彻底声明和收口成用例编排层。**

#### 问题

同时处理了：

- picker mode / target / initial sessions
- open tmux session / multiple sessions / group session
- save/edit/delete server group
- saved tab list load
- 新建连接进入属性页
- setPageState / ensureTerminalPageVisible

这说明它本质已经不是简单 hook，而是“session open use-case coordinator”。

#### 判定

设计方向可保留，但应进一步显式化为用例编排块，而不是继续以普通 hook 名义无限变厚。

---

### 7.3 `useTerminalWorkspace.ts`

#### 评价

**601 行已经说明它不是轻量 hook，而更像一个终端 workspace 领域块与壳层混合体。**

#### 风险

如果不主动分清：

- workspace 真相
- layout/pane 规则
- React 接入 façade

后续很容易演变成下一个“大块隐性总控”。

---

## 8. Server 侧审计

### 8.1 结论

**Server 侧比 client 侧更接近“薄入口 + support/runtime blocks”结构。**

### 8.2 证据

- `android/src/server/server.ts`：399 行
- `android/src/server/terminal-core-support.ts`：109 行
- 存在 truth gate：`server.core-support-truth.test.ts`

说明：

- `server.ts` 已经不是无限内联 helper 的单文件
- terminal helper 已抽入独立 support 模块
- 并有测试门禁防止 helper 再长回入口

### 8.3 做对的地方

1. 把 `resolveMirrorCacheLines`、`sanitizeSessionName`、`normalizeBufferSyncRequestPayload` 等 helper 抽出为 support。
2. `server.ts` 主要承担组装 runtime 的角色。
3. 真源测试开始围绕“入口只做 glue，不内联 helper”建立门禁。

### 8.4 剩余问题

1. 当前 `server.ts` 虽然控制在 399 行，但仍是一个总装配入口，后续增长仍需警惕再次变胖。
2. 和 client 一样，server 侧有些 runtime/support 边界还可以继续按更稳定的 owner 语义收口。

### 8.5 判定

**Server 侧总体优于 TerminalPage 与部分大 hook，已经较接近你要的薄编排结构。**

---

## 9. 主要结构性问题清单

下面按问题级别汇总。

### 9.1 P0：`TerminalPage.tsx` 不是纯编排层

这是当前最核心问题。表现为：

- 页面承载过多状态机与 helper
- overlay/sheet/debug/copy/keyboard 等横切逻辑全部集中
- 很难明确哪些属于 block、哪些属于 page 壳

### 9.2 P1：SessionContext 周边 blocks 命名体系还不稳定

当前层次中：

- `runtime`
- `orchestration-runtime`
- `lifecycle-runtime`
- `provider-assemblies`
- `public-facade-runtime`

等多种概念并存，说明拆分完成度高，但层级约定还未冻结。

### 9.3 P1：assembly / glue 层偏厚

某些 `assemblies` 文件已经不是简单装配，而是承载了不少实质流程拼装语义；如果继续增长，会成为“第二编排层”。

### 9.4 P2：大 hook 仍混有 block 真相与 orchestration

典型文件：

- `useOpenTabRuntime.ts`
- `useSessionOpenActions.ts`
- `useTerminalWorkspace.ts`

这类模块都存在“名义是 hook，实质已经是领域块 + 编排混合体”的现象。

### 9.5 P2：shared 与 android/lib 的边界仍可继续收口

当前已经有正确基础，但 terminal planner / visible-range / request-window / repair 相关纯规则仍有进一步下沉 shared 的空间。

---

## 10. 改进建议（按优先级排序）

## 10.1 第一优先级：重构 `TerminalPage.tsx`

### 目标

把 `TerminalPage.tsx` 从“页面巨兽”改造成真正的终端页面编排壳。

### 建议拆分方向

不是机械地按 JSX 组件拆，而是按职责拆：

1. `terminal-page-render-keys.ts`
  - 收口 session/header/render key helper
2. `terminal-copy-selection.ts`
  - 收口 selection state / row extraction / plain text conversion / clipboard helper
3. `terminal-keyboard-lift.ts`
  - 收口 keyboard inset / viewport / header inset / layout viewport helper
4. `useTerminalPageOverlays.ts`
  - 管理 tab manager / schedule / file transfer / screenshot / debug overlay 的开关与协调
5. `useTerminalPageInteractionRuntime.ts`
  - 管理 interactive session、pane attach、switch/session chrome actions 等交互编排
6. `TerminalPage.tsx`
  - 最终只保留 props 消费、stage 组装、hook 调用与 JSX 编排

### 为什么这是唯一主目标

因为当前 shared 层与 SessionContext 壳层都已经向正确方向收口；**TerminalPage 才是最明显破坏三层模型的单点。**

---

## 10.2 第二优先级：稳定 SessionContext 体系命名层次

建议冻结成更少、更稳定的概念层：

1. `*-store.ts`：状态真源块
2. `*-rules.ts` / `*-planner.ts`：纯规则块
3. `*-runtime.ts`：单领域执行块
4. `*-orchestrator.ts`：多块组合编排
5. `*-facade.ts`：对外薄接口

不建议继续扩张：

- `provider-assemblies`
- `infra-facade-runtime`
- `public-facade-runtime`
- `transport-control-orchestration-runtime`

这些名字不是错，但长期可读性和 owner 可辨识度较差。

---

## 10.3 第三优先级：把 Android 侧剩余纯 planner 继续下沉 shared

判断��准：

如果一个模块满足：

- 不依赖 React
- 不依赖浏览器 API
- 不依赖 Capacitor/Android
- 只处理 terminal 纯数据规则

那么它应优先进入 `packages/shared/src/terminal/*`。

这样可以进一步保证：

- block 只做 orchestration
- 纯业务规则只有一个实现点

---

## 10.4 第四优先级：把大 hook 进一步分清 block 与 facade

建议把：

- `useOpenTabRuntime.ts`
- `useSessionOpenActions.ts`
- `useTerminalWorkspace.ts`

继续拆成：

- runtime/store/rules
- facade hook
- orchestration use-case

目标不是“拆得更多”，而是让每层名字与责任更稳定。

---

## 10.5 第五优先级：建立结构门禁

建议增加以下自动化门禁：

1. **文件大小门禁**
  - `TerminalPage.tsx > 800` 报警
  - `App.tsx > 500` 报警
  - `SessionContext.tsx > 400` 报警
2. **forbidden import 门禁**
  - shared 禁止 import React / Capacitor / DOM 平台对象
  - page 层禁止越级 import 深层 transport runtime
  - server 禁止 import `@zterm/shared` 根入口
3. **truth owner 门禁**
  - open-tab / session-buffer / terminal-width-mode 等能力建立 owner 列表与重复实现拦截测试

---

## 11. 模块级审计结论汇总

### `App.tsx`

- 结论：**基本合格，偏胖**
- 原因：主要做 app shell 编排，但横切能力汇总过多

### `SessionContext.tsx`

- 结论：**基本达标**
- 原因：已是薄 provider 壳，真实逻辑已下沉

### `TerminalPage.tsx`

- 结论：**明确不达标**
- 原因：页面承担了编排、状态机、overlay、helper、交互 glue 等混合职责

### `useOpenTabRuntime.ts`

- 结论：**方向正确，仍偏厚**
- 原因：真相维护与 lifecycle/orchestration 尚未彻底分层

### `useSessionOpenActions.ts`

- 结论：**已是用例层雏形，但仍偏混合**
- 原因：picker UI state、domain action、page navigation 混在一起

### `useTerminalWorkspace.ts`

- 结论：**潜在下一热点**
- 原因：体量已大，未来若不继续分层，易演化成隐性总控模块

### `packages/shared`

- 结论：**当前最健康的一层，应继续强化**
- 原因：已承担真实纯规则真源

### `server.ts` / server runtime

- 结论：**较接近薄编排结构**
- 原因：入口已抽出 support/helper，且有 truth gate 保护

---

## 12. 最终判定

### 12.1 是否已经按照“共享函数库 + blocks + 纯编排”设计？

**判定：部分达标，尚未完全达标。**

更准确地说：

- **共享函数库**：已达成主体结构
- **blocks**：已形成主体框架
- **纯编排**：仅在部分入口达成，未全局达成

### 12.2 哪一层最好？

- 最好：**shared 纯函数/纯规则层**

### 12.3 哪一层最弱？

- 最弱：**terminal 页面编排层**

### 12.4 当前最需要整改的唯一主点

- **`android/src/pages/TerminalPage.tsx` 的纯编排化重构**

这不是因为它最大，而是因为它是当前最明确违背三层模型、同时又位于高频核心路径的唯一主热点。

---

## 13. 唯一性论证

按项目规则，需要说明为什么本次审计给出的主结论具有唯一性。

本次审计认为，**当前最需要优先整改的唯一正确修改方向，是把 `TerminalPage.tsx` 收口成真正的纯编排壳**。理由如下：

1. Shared 层已经真实存在，不是主矛盾；继续完善 shared 是增量优化，不是当前唯一堵点。
2. `SessionContext.tsx` 已经薄化，不是主矛盾；其问题主要是命名层次与 assembly 厚度，而不是入口本身违例。
3. Server 入口 `server.ts` 已明显朝 support/runtime glue 结构靠拢，也不是当前主矛盾。
4. **只有 `TerminalPage.tsx` 仍同时持有编排、状态机、helper、overlay 协调与交互控制，直接破坏了“纯编排”这条核心架构原则。**

因此，如果当前要做结构整改，**先动 `TerminalPage.tsx` 是唯一正确的第一顺位**；先去做其他局部优化，只会改善边缘质量，但不会移除当前最核心的结构违例点。

---

## 14. 建议的下一步

如果继续推进，建议下一份工作产物不是直接改代码，而是先出：

- `android/docs/audits/terminal-page-refactor-blueprint.md`

内容包括：

1. `TerminalPage.tsx` 拆分蓝图
2. 每个目标文件的 owner 定义
3. 哪些模块应进 shared
4. 哪些模块是 block
5. 哪些模块只是 orchestration shell
6. 对应测试门禁如何补齐

这样才能保证后续重构不是“把大文件拆成更多小文件”，而是真正按 **shared + blocks + orchestration** 收口。

# zterm Android 架构审计报告（共享函数库 + blocks + 纯编排）

- 日期：2026-05-24
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计主题：当前代码是否已经按 **共享函数库 + blocks + 纯编排** 的方式设计，以及后续改进空间

---

## 1. 执行摘要

**结论：部分达标，但未完全达标。**

当前代码库已经明显往 `shared function library -> blocks -> orchestration shell` 的方向收口，尤其在 `packages/shared`、`android/src/lib`、`android/src/contexts/session-context-*`、`android/src/server/*` 上已经形成真实的分层基础；但**编排层仍未彻底纯化**，其中最突出的结构性问题是 `android/src/pages/TerminalPage.tsx` 仍然承担了过多状态机、UI 细节、overlay 协调与交互逻辑，不符合“页面只做编排”的目标。

因此，本次审计的最终判断是：

1. **共享函数库层**：已建立，方向正确，质量整体较好。
2. **blocks 层**：已形成，但存在“拆得很多、胶水层偏厚、命名层次不稳定”的问题。
3. **纯编排层**：`SessionContext.tsx`、`server.ts` 基本在收口，但 `TerminalPage.tsx` 明显未达标，是当前唯一主热点。

---

## 2. 审计范围与依据

### 2.1 文档依据

- `AGENTS.md`
- `android/docs/architecture.md`
- `android/docs/ui-slices.md`

### 2.2 代码抽样范围

重点检查了以下模块：

- App / 页面壳
  - `android/src/App.tsx`
  - `android/src/pages/ConnectionsPage.tsx`
  - `android/src/pages/ConnectionPropertiesPage.tsx`
  - `android/src/pages/SettingsPage.tsx`
  - `android/src/pages/TerminalPage.tsx`

- Session / runtime / transport / buffer 相关
  - `android/src/contexts/SessionContext.tsx`
  - `android/src/contexts/session-context-*.ts`
  - `android/src/hooks/useOpenTabRuntime.ts`
  - `android/src/hooks/useSessionOpenActions.ts`
  - `android/src/hooks/useTerminalShellActions.ts`

- shared / lib / store / planner 相关
  - `android/src/lib/*`
  - `packages/shared/src/*`

- server 相关
  - `android/src/server/server.ts`
  - `android/src/server/terminal-core-support.ts`
  - 其他 `android/src/server/*` runtime 模块

### 2.3 审计标准

本次按你冻结过的三层铁律判断：

```text
orchestration（纯编排）
    ↓
blocks（唯一真源块）
    ↓
shared functions / pure modules（共享纯函数层）
```

重点看 5 件事：

1. 纯规则是否已下沉为共享函数库
2. block 是否具备明确 owner
3. 页面 / context / server 入口是否只做编排
4. 是否存在跨层重复逻辑
5. 是否存在“文件拆开了，但语义没拆开”的伪分层

---

## 3. 代码结构现状总览

本次抽样看到的总体结构特征是：

### 3.1 优势结构已经出现

- `packages/shared/src/terminal/*` 已承载一批 terminal 纯规则
- `android/src/lib/*` 已有较多 store / planner / normalization / persistence 模块
- `SessionContext.tsx` 已从大一坨 context 壳收口到 298 行左右的装配层
- server 侧 `server.ts` 已开始把 helper 下沉到 `terminal-core-support.ts` 等 support/runtime 模块

### 3.2 结构债务仍然明显

- `android/src/pages/TerminalPage.tsx` 约 **3462 行**，显著超出“纯编排页面”的合理体量
- `session-context-*` 家族虽然拆得很细，但存在 runtime / orchestration / assembly / facade 多层胶水叠加的问题
- 部分大 hook 仍同时承担 block 真相与 orchestration 协调职责

---

## 4. 审计结论：是否已按“共享函数库 + blocks + 纯编排”设计

### 4.1 共享函数库：**是，已明显建立**

这一层是当前最健康的一层。

证据包括但不限于：

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/visible-range.ts`
- `packages/shared/src/terminal/buffer-sync-request-planner.ts`
- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/open-tab-intent.ts`
- `android/src/lib/connections-server-groups.ts`
- `android/src/lib/terminal-width-mode-manager.ts`

这些模块普遍具备以下特征：

- 输入输出明确
- 不依赖 React 生命周期
- 大多不依赖浏览器 / Capacitor
- 易单测
- 可被多处复用

因此，**“共享函数库”并不是停留在口头设计上，而是已经落成了真实代码层。**

### 4.2 blocks：**是，已形成主体骨架，但还不够干净**

已形成的 block 类型主要有两类：

#### A. 状态型 store block

- `session-buffer-store.ts`
- `session-render-gate.ts`
- `session-head-store.ts`
- `session-viewport-mode-store.ts`

这类模块已经比较符合“唯一真源块”的标准：

- owner 明确
- 输入输出边界稳定
- 不依赖页面壳
- 可以被 renderer / runtime / page 消费

#### B. 领域规则 / persistence block

- `open-tab-intent.ts`
- `open-tab-persistence.ts`
- `open-tab-restore.ts`
- `session-buffer-planner-helpers.ts`（部分）
- server 侧各 runtime/support 模块

这些 block 大体已形成“按领域切片”的趋势。

但问题是：

- 存在较多 **assembly / orchestration / facade** 胶水文件
- 某些文件虽然拆开了，但职责边界仍偏厚
- 命名层级还不稳定，读代码时不容易快速识别“谁是真正 owner”

所以这里的判断不是“blocks 没有做”，而是：

> **blocks 已形成，但还有明显的结构收口空间。**

### 4.3 纯编排：**部分成立，但关键主路径未达标**

这一层是当前最弱的。

- `SessionContext.tsx`：基本成立，已经像 provider 壳 + facade 装配层
- `server.ts`：大体成立，已经偏向 thin glue
- `App.tsx`：基本成立，但偏胖
- `TerminalPage.tsx`：**不成立**

因此，不能说“现在已经完全按纯编排实现了”。

**准确结论：当前架构是“shared 与 blocks 已明显成型，编排层正在收口，但仍有一个主热点没有拆干净”。**

---

## 5. 分层详细审计

## 5.1 Shared 纯函数 / 共享库层

### 评价

**整体良好，是当前最健康的一层。**

### 优点

1. terminal planner / repair / visible-range 等纯决策逻辑已经下沉到 `packages/shared`
2. Android 侧 `lib` 里也有不少稳定的纯模块与 store
3. 这层大多数模块都具备可测试、可复用、可迁移的特征

### 证据

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/foreground-resume.ts`
- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/session-transport-runtime.ts`

### 问题

1. shared 覆盖面还不够彻底，仍有一部分 planner/helper 留在 Android 侧
2. `packages/shared` 与 `android/src/lib` 的边界是“实践中大体正确”，但还没被规则化到非常稳定

### 审计判断

**这一层方向完全正确，应继续加强，不应回退。**

---

## 5.2 blocks 层

### 评价

**已形成主体，但存在过碎、胶水偏厚、命名不稳定的问题。**

### 做得对的地方

#### A. Store 真源块已经比较成熟

`session-buffer-store.ts`、`session-render-gate.ts` 这类模块已经很接近你要求的“唯一真源 blocks”。

#### B. open-tab 真源块比较清晰

`open-tab-intent.ts` / `open-tab-persistence.ts` / `open-tab-restore.ts` 这一组已经有清楚的语义分工。

#### C. server 侧 runtime/support 分块整体比 client 更接近目标

如：

- `terminal-mirror-runtime.ts`
- `terminal-transport-runtime.ts`
- `terminal-control-runtime.ts`
- `terminal-schedule-runtime.ts`
- `terminal-core-support.ts`

### 主要问题

#### 问题 1：部分 block 实际上是“胶水块”

比如：

- `session-context-message-assemblies.ts`
- `session-context-provider-assemblies.ts`
- `session-context-transport-orchestration-runtime.ts`

这些文件不是坏设计，但它们更偏向：

- wiring
- orchestration 中间层
- facade 聚合层

不是最底层的唯一业务真源块。

这就导致阅读者难以快速回答：

> 某条 transport / buffer / sync 规则，到底唯一 owner 在哪？

#### 问题 2：命名层级不稳定

当前命名并行存在：

- `*-runtime.ts`
- `*-orchestration-runtime.ts`
- `*-lifecycle-runtime.ts`
- `*-provider-assemblies.ts`
- `*-public-facade-runtime.ts`
- `*-infra-facade-runtime.ts`

这说明结构仍处在演进中，尚未冻结成稳定语义层次。

#### 问题 3：有些 block 更像“按重构过程拆”，而不是“按领域真相拆”

`session-context-*` 某些文件名能看出它们是为了解体大 context 而拆出来的，但不一定一眼看出“它是哪个领域真相的唯一 owner”。

### 审计判断

**blocks 不是没有，而是“已经做起来了，但还没做到读起来一眼稳定”。**

---

## 5.3 编排层

### 评价

**当前最弱的一层。**

### `SessionContext.tsx`

当前约 298 行，整体评价是：

- 已显著变薄
- 主要在做 refs / runtime / facade 组装
- 已相当接近“纯编排 provider 壳”

这是当前 client 侧最接近目标的部分之一。

### `App.tsx`

优点：

- 整体已经像 app shell
- 连接页面、属性页、终端页已通过 page state 分层
- 大部分能力来自 hook / lib / runtime

问题：

- 仍然汇总了较多横切能力：
  - app update
  - relay debug
  - host storage
  - tab runtime
  - session open actions
  - terminal shell actions
  - picker sheet
  - update modal

所以 `App.tsx` 是“基本合格，但偏胖”。

### `TerminalPage.tsx`

这是本次审计中最明确的不合格项。

证据：

- `android/src/pages/TerminalPage.tsx` 约 **3462 行**

该文件同时承载：

- 页面编排
- keyboard / viewport / layout 逻辑
- copy selection / clipboard 逻辑
- debug overlay 逻辑
- quickbar / tab manager / sheet 协调
- pane attach / interactive session / tab chrome 等状态机
- 大量 UI key / identity helper

这说明它并不是：

```text
TerminalPage = orchestration shell
```

而更像：

```text
TerminalPage = orchestration + local runtime + overlay coordinator + UI helper bucket
```

**这与“页面只做编排”的目标冲突。**

### 审计判断

**编排层尚未彻底达标，TerminalPage 是唯一主热点。**

---

## 6. 关键证据

### 6.1 页面/入口文件体量证据

- `android/src/pages/TerminalPage.tsx`：**3462 行**
- `android/src/pages/ConnectionsPage.tsx`：565 行
- `android/src/contexts/SessionContext.tsx`：298 行
- `android/src/server/server.ts`：399 行

解读：

- `SessionContext.tsx` 与 `server.ts` 已经比较像薄入口
- `TerminalPage.tsx` 明显没有收成薄编排

### 6.2 Context runtime 体系证据

- `session-context-buffer-runtime.ts`：778 行
- `session-context-session-runtime.ts`：524 行
- `session-context-transport-runtime.ts`：494 行
- `session-context-provider-core-assemblies.ts`：417 行
- `session-context-transport-orchestration-runtime.ts`：461 行

解读：

- 已拆，不是没拆
- 但拆分后仍存在厚块与中间胶水层

### 6.3 shared terminal truth 证据

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/foreground-resume.ts`

解读：

- terminal 纯规则已经有共享真源

### 6.4 server support 真源证据

- `android/src/server/terminal-core-support.ts`
- `android/src/server/server.core-support-truth.test.ts`

解读：

- server 入口已不再把所有 helper 内联在 `server.ts`
- 已经开始有明确 support block + truth gate

---

## 7. 存在的主要问题

## 7.1 最大问题：`TerminalPage.tsx` 仍非纯编排

这是本次审计认定的**唯一主热点**。

原因不是单纯“它最大”，而是它同时违反了三件事：

1. 页面壳不纯
2. 本地交互状态机过多
3. helper / overlay / runtime / page orchestration 混在一个文件里

如果不先拆这里，其他“shared / blocks”的收益会被顶层巨型 page 抵消掉一大部分。

---

## 7.2 `session-context-*` 结构虽进步明显，但语义层次还不稳定

问题不在于“拆错了”，而在于“拆后层级仍有噪音”：

- runtime / orchestration / lifecycle / facade / assembly 多层混用
- owner 不够一眼可见
- 部分胶水文件很厚

这会提高未来维护成本。

---

## 7.3 大 hook 仍承担 block 与 orchestration 的双重职责

重点包括：

- `useOpenTabRuntime.ts`（478 行）
- `useSessionOpenActions.ts`（485 行）
- `useTerminalWorkspace.ts`（601 行）

它们方向是对的，但还没有彻底做到：

- block 真相下沉
- hook 只做 React 生命周期桥接
- orchestration 只做用例编排

---

## 7.4 shared 与 Android lib 的边界还可进一步冻结

当前边界总体健康，但还处于“实践正确 > 制度冻结”的状态。

未来如果不继续清理，容易形成：

- `packages/shared` 一套 planner
- `android/src/lib` 再包一层 planner helper
- `contexts`/`hooks` 再各自内嵌少量判断

这样会慢慢长回跨层重复逻辑。

---

## 8. 改进建议（按优先级）

## 8.1 P0：优先重构 `TerminalPage.tsx`

这是当前最应该动的唯一主目标。

### 为什么必须优先做

- 它是当前最明确违背“纯编排”的地方
- 共享函数库和 block 已有基础，但被顶层巨型 page 抵消了收益
- 不先拆它，后续所有 terminal UI 继续长都容易回到单文件膨胀

### 建议拆分方向

不是简单按 JSX 组件拆，而是按责任拆：

1. `terminal-page-render-keys.ts`
  - 抽 UI identity/key helper

2. `terminal-copy-selection.ts`
  - 抽 copy selection state / buffer text extraction / clipboard rules

3. `terminal-keyboard-lift.ts`
  - 抽 keyboard inset / visual viewport / header top inset 规则

4. `useTerminalPageOverlayRuntime.ts`
  - 管理 debug overlay / copy menu / sheet open-close

5. `useTerminalPageInteractionRuntime.ts`
  - 管理 interactive session / pane attach / tab chrome interaction

6. `TerminalPage.tsx`
  - 最终只保留 orchestration shell + JSX stage 组合

目标不是机械减行数，而是让它变成：

> **一眼看上去就是纯编排入口。**

---

## 8.2 P1：给 `session-context-*` 建立稳定命名层次

建议后续统一为 5 类：

1. `*-store.ts`
  - 状态真源块

2. `*-rules.ts` / `*-planner.ts`
  - 纯规则块

3. `*-runtime.ts`
  - 单领域执行块

4. `*-orchestrator.ts`
  - 组合多个 runtime/store/rules 的编排块

5. `*-facade.ts`
  - 对 React/page/context 暴露薄接口

不建议继续扩张下面这种长命名体系：

- `provider-assemblies`
- `infra-facade-runtime`
- `public-facade-runtime`
- `transport-control-orchestration-runtime`

这些名字不是错，但长期不利于稳定阅读心智。

---

## 8.3 P2：把 Android 侧更多 planner/helper 下沉到 `packages/shared`

原则：凡是同时满足以下条件的模块，都应优先考虑下沉：

1. 不依赖 React
2. 不依赖浏览器 API / Capacitor
3. 输入输出是纯数据
4. server / android / mac 将来有复用价值

当前潜在继续下沉对象包括：

- `session-buffer-planner-helpers.ts` 中纯 planner 部分
- 部分 visible-range / request-window / repair 规则封装

目标是：

> **block 只做编排与 runtime，不再自己实现核心业务规则。**

---

## 8.4 P3：把大 hook 继续拆成 block + facade + orchestration

### 重点文件

- `useOpenTabRuntime.ts`
- `useSessionOpenActions.ts`
- `useTerminalWorkspace.ts`

### 目标形态

- runtime 真相进入独立模块
- hook 只接 React 生命周期
- orchestration 单独负责页面/用例协调

这样才能避免 hook 重新长成“第二层 God object”。

---

## 8.5 P4：补结构门禁，而不是只靠人工自觉

建议增加：

### A. 文件体积门禁

例如：

- `TerminalPage.tsx > 800 行` 报警
- `App.tsx > 500 行` 报警
- `SessionContext.tsx > 400 行` 报警

### B. import 方向门禁

例如：

- `server` 禁止 import `@zterm/shared` 根入口
- `shared` 禁止引入 React / Capacitor / DOM API
- page 层禁止直接下钻 transport/runtime 深层内部模块

### C. owner truth gate

为 open-tab / transport / buffer / renderer 这几块建立“唯一 owner 清单 + forbidden duplicate implementation”门禁。

---

## 9. 模块级判断

## 9.1 `android/src/App.tsx`

### 判断

**基本合格，偏胖。**

### 原因

- 已经具备 app shell 特征
- 页面切换、hook 组装、跨页 wiring 是主责
- 但仍汇总过多横切能力

### 建议

- 后续可拆 `useAppShellRuntime`
- modal / picker / update overlay 可独立协调

---

## 9.2 `android/src/contexts/SessionContext.tsx`

### 判断

**基本符合纯编排 / 薄 facade 目标。**

### 原因

- 入口已变薄
- 真正逻辑下沉到 runtime / facade / assembly
- context 对外暴露稳定 API

### 建议

- 后续重点不是再拆这个文件本身
- 而是清理其下游命名与中间胶水层

---

## 9.3 `android/src/pages/TerminalPage.tsx`

### 判断

**当前最需要重构，且未达到纯编排要求。**

### 原因

- 文件体量极大
- 混合了 page orchestration / UI helper / 状态机 / overlays / copy / keyboard / debug 等多类职责

### 建议

- 先抽纯 helper
- 再抽 overlay runtime / interaction runtime
- 最后保留 page shell

---

## 9.4 `android/src/hooks/useOpenTabRuntime.ts`

### 判断

**方向正确，但还偏厚。**

### 原因

- 已有 open-tab truth 设计
- persistence / intent / restore 已下沉到 lib
- 但 foreground/runtime sync/page orchestration 仍和 runtime 混在一起

### 建议

- 拆 runtime store / restore orchestrator / hook facade

---

## 9.5 `android/src/hooks/useSessionOpenActions.ts`

### 判断

**像用例层，但尚未彻底结构化。**

### 原因

- picker state、open actions、group selection、saved tab list、page navigation 混在一个 hook

### 建议

- 区分 picker UI state 与 domain open action
- 形成更明确的用例 orchestration block

---

## 9.6 `packages/shared`

### 判断

**当前最值得继续扩张的正确方向。**

### 建议

- 继续吸 terminal planner / normalization / visible-range 纯规则
- 保持 leaf import discipline
- 禁止长回平台依赖

---

## 9.7 `android/src/server/server.ts` 与 server runtime

### 判断

**比 client 更接近 thin glue + blocks。**

### 原因

- `server.ts` 体量仍可控（约 399 行）
- 已有 `terminal-core-support.ts` 等 support/runtime 模块
- 已有 truth tests 约束

### 建议

- 保持入口文件不再回长
- 相似 helper 继续往独立 support/shared 下沉

---

## 10. 最终判定

### 10.1 总结结论

当前代码库：

- **已经具备共享函数库基础**
- **已经形成 blocks 骨架**
- **但尚未完全实现纯编排**

因此，不能把现状评价为“已经完全按共享函数库 + blocks + 纯编排设计完成”。

**更准确的判断是：**

> **shared 与 blocks 已显著成型，编排层正在收口，但 terminal 主页面仍是当前唯一主热点，尚未完成纯编排化。**

---

## 10.2 唯一性判断

按本仓库规则，必须说明“为什么下一步目标是唯一的”。

本次审计里，下一步的唯一主目标是：

> **优先重构 `android/src/pages/TerminalPage.tsx`，把它收成真正的纯编排壳。**

这是唯一主目标，而不是泛泛“继续优化架构”，原因如下：

1. shared 层已经存在，不是当前主矛盾
2. SessionContext 入口已薄化，不是当前主矛盾
3. server 入口已开始 support 化，不是当前主矛盾
4. **只有 `TerminalPage.tsx` 同时持有过多 orchestration 之外的职责，直接违背三层设计目标**

所以，如果要按“唯一真源修改点”的思维来定下一步，不是平均用力，而是应先切这个主热点。

---

## 11. 建议的下一步执行顺序

1. 为 `TerminalPage.tsx` 输出拆分蓝图
2. 先抽纯 helper：render keys / keyboard lift / copy selection
3. 再抽 overlay runtime / interaction runtime
4. 最后把 `TerminalPage.tsx` 收成壳
5. 完成后再收 `useOpenTabRuntime.ts` / `useSessionOpenActions.ts` 的 block 与 facade 分离

---

## 12. 审计结论（一句话版）

**现在不是“没按这个方向做”，而是“已经做到了 shared + blocks，但 pure orchestration 还差最后一个最大热点：`TerminalPage.tsx`。”**
# zterm Android 架构审计报告（共享函数库 + blocks + 纯编排）

- 日期：2026-05-24
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计主题：当前代码是否已经按“共享函数库 + blocks + 纯编排（orchestration）”设计，以及下一步改进空间

## 1. 审计结论

当前代码库**已经明显朝“共享函数库 + blocks + 纯编排”方向收口，但尚未完全达标**。

结论分层如下：

1. **共享函数库层：基本达标，且是当前最健康的一层**
   - `packages/shared/src/*` 已承载一批真正的跨端纯函数、planner、normalizer、renderer leaf modules。
   - `android/src/lib/*` 也已承载大量 app 内纯函数/纯 store/leaf runtime。

2. **blocks 层：主体框架已形成，但还存在“拆了文件、未完全拆语义”的问题**
   - `SessionContext` 周边已拆成多块 runtime/facade/orchestration/store。
   - 但部分块仍是厚胶水层，唯一 owner 边界还不够稳定。

3. **纯编排层：局部达标，但没有全局达标**
   - `SessionContext.tsx` 已接近纯编排壳。
   - `App.tsx` 基本像应用壳，但仍偏胖。
   - **`TerminalPage.tsx` 明显未达标，是当前最核心的架构收口点。**

因此，整体判断不是“完全没做到”，也不是“已经完全做好”，而是：

> **共享函数库已经建立，blocks 已形成主体，但纯编排层仍有关键热点未收口，尤其是 TerminalPage。**

---

## 2. 审计依据与方法

### 2.1 规则依据

本次审计基于以下真源与规则：

- `AGENTS.md`
- `android/docs/architecture.md`
- `android/docs/ui-slices.md`
- 用户长期偏好中明确强调的三层铁律：

```text
orchestration（纯编排）
    ↓
blocks（唯一真源块）
    ↓
基础功能 / shared pure functions（共享纯函数）
```

### 2.2 实际审计范围

本次重点检查了以下代码：

#### App / Page / UI 编排层
- `android/src/App.tsx`
- `android/src/pages/ConnectionsPage.tsx`
- `android/src/pages/TerminalPage.tsx`
- `android/src/pages/SettingsPage.tsx`

#### Session / Context / Runtime blocks
- `android/src/contexts/SessionContext.tsx`
- `android/src/contexts/session-context-*.ts`
- `android/src/hooks/useOpenTabRuntime.ts`
- `android/src/hooks/useSessionOpenActions.ts`
- `android/src/hooks/useTerminalShellActions.ts`
- `android/src/hooks/useTerminalWorkspace.ts`

#### Android app leaf modules / stores
- `android/src/lib/open-tab-intent.ts`
- `android/src/lib/open-tab-persistence.ts`
- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/session-transport-runtime.ts`
- `android/src/lib/terminal-width-mode-manager.ts`
- 以及 `android/src/lib/*` 下相关 terminal/session/store/planner 模块

#### Shared 函数库
- `packages/shared/src/terminal/*`
- `packages/shared/src/connection/*`
- `packages/shared/src/layout/*`
- `packages/shared/src/workspace/*`

#### Server 编排与 support blocks
- `android/src/server/server.ts`
- `android/src/server/terminal-core-support.ts`
- `android/src/server/terminal-*-runtime.ts`

### 2.3 审计判断标准

主要按以下 5 个维度判断：

1. **共享函数是否形成唯一真源**
2. **block 是否有稳定 owner，不跨层重复**
3. **page/context/server entry 是否真的只是编排，不承载业务实现**
4. **命名和分层是否能让维护者快速定位真源**
5. **是否存在“拆了文件但没有拆责任”的伪模块化**

---

## 3. 总体评价

### 3.1 已经做对的地方

#### 3.1.1 Shared 纯函数层已经真实存在，不是口头模块化

当前 `packages/shared` 已经不是“预留目录”，而是实际承载了 terminal 规则真源。

典型模块：

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/visible-range.ts`
- `packages/shared/src/terminal/buffer-sync-request-planner.ts`
- `packages/shared/src/terminal/renderer/*`

这些模块具备明显 shared leaf 特征：

- 输入输出纯数据
- 无 React 依赖
- 无 Android/Capacitor/browser 生命周期耦合
- 易测
- 具备 client/server/mac/android 复用价值

这部分已经符合“共享函数库”的设计要求。

#### 3.1.2 Android app 内已有一批成熟的 pure/store blocks

典型例子：

- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/session-head-store.ts`
- `android/src/lib/session-viewport-mode-store.ts`
- `android/src/lib/open-tab-intent.ts`
- `android/src/lib/open-tab-persistence.ts`
- `android/src/lib/connections-server-groups.ts`
- `android/src/lib/terminal-width-mode-manager.ts`

这些模块已经呈现出清晰特征：

- store 是状态 owner
- planner / helper 是纯规则 owner
- UI 和 Context 不再直接内联这些规则

说明当前项目已不是“所有逻辑都堆在页面和 context 里”。

#### 3.1.3 `SessionContext.tsx` 本体已经明显瘦身，接近纯编排壳

实际检查中：

- `android/src/contexts/SessionContext.tsx` 约 298 行

它当前主要职责是：

- 初始化 reducer / refs
- 组装 provider runtime / assemblies / facade
- 暴露稳定 context value

这比传统的“2000 行 God Context”已经前进很多，方向正确。

#### 3.1.4 server 入口开始具备“薄 glue + support block”形态

典型例子：

- `android/src/server/server.ts` 约 399 行
- `android/src/server/terminal-core-support.ts` 约 109 行

并且存在相应 truth gate：

- `android/src/server/server.core-support-truth.test.ts`

这说明 server 侧已开始把 helper 从入口文件剥离到专门 support block，而不是所有逻辑继续堆在 `server.ts`。

---

### 3.2 当前还没达标的地方

#### 3.2.1 `TerminalPage.tsx` 明显不符合“纯编排”

实际统计：

- `android/src/pages/TerminalPage.tsx`：**3462 行**

从内容抽查可见，它同时承载：

- 页面编排
- header / quickbar / tab manager / schedule / transfer / screenshot 多层 UI 协调
- keyboard / visual viewport / overlay / debug / copy selection 等状态机
- 大量 helper 函数
- 交互逻辑、视图辅助逻辑、sheet 开合逻辑

这说明它不是纯编排壳，而是：

```text
TerminalPage = Page UI + Orchestration + Local runtime state machines + UI helpers + overlay controllers
```

这与目标架构不一致。

#### 3.2.2 blocks 已拆很多，但部分是“文件级拆分”，不是“责任级拆分”

尤其 `session-context-*` 家族：

- `session-context-buffer-runtime.ts`
- `session-context-session-runtime.ts`
- `session-context-transport-runtime.ts`
- `session-context-provider-core-assemblies.ts`
- `session-context-transport-orchestration-runtime.ts`
- `session-context-message-assemblies.ts`

优点：

- 已按 transport / buffer / session / message 等主题拆分

问题：

- 仍存在较厚的 wiring/assembly/glue 模块
- 很多文件名反映的是“重构过程”而不是“稳定领域 owner”
- 维护者不一定能第一眼判断：某条规则的唯一 owner 到底在哪里

#### 3.2.3 大 hook 仍然是 truth + orchestration 的混合体

重点文件：

- `android/src/hooks/useOpenTabRuntime.ts`（478 行）
- `android/src/hooks/useSessionOpenActions.ts`（485 行）
- `android/src/hooks/useTerminalWorkspace.ts`（601 行）

这些文件并不是简单 UI hook，而更像：

- 一部分领域真相
- 一部分 runtime
- 一部分页面/用户动作编排
- 一部分 React 生命周期接入

这意味着它们尚未彻底变成“薄 hook + 外部 block”。

#### 3.2.4 shared 与 `android/src/lib` 的边界还未完全冻结

目前是双层纯逻辑：

- 一部分在 `packages/shared`
- 一部分在 `android/src/lib`

方向没错，但 terminal planner 相关仍有一部分包装留在 Android 侧，例如：

- `android/src/contexts/session-buffer-planner-helpers.ts`

这意味着 shared 真源已经建立，但还没有彻底吸纳所有可跨端复用的纯规则。

---

## 4. 分层审计

### 4.1 共享函数库层审计

#### 结论

**这一层基本达标，是当前最健康的一层。**

#### 优点

1. terminal 规划/判断逻辑已经明显进入 shared
2. 叶子模块职责清楚，易测
3. 与项目“共享函数库优先”的偏好一致
4. server/client 都已经开始消费 shared leaf，而不是复制逻辑

#### 不足

1. 覆盖面还未完全彻底，Android 侧还有一些 planner wrapper
2. 仍需强化“shared 只能放纯规则，不放 app glue”的门禁
3. 需要进一步明确 root import / leaf import 边界，避免再次把 UI/React/CSS 依赖带回 Node/server

#### 判断

> shared 层不是问题源，应该继续扩张，而不是回收。

---

### 4.2 blocks 层审计

#### 结论

**blocks 层已形成主体框架，但仍有“胶水层偏厚、命名层级不稳定”的问题。**

#### 较成熟的 block 类型

##### A. Store 真源块

- `session-buffer-store.ts`
- `session-render-gate.ts`
- `session-head-store.ts`
- `session-viewport-mode-store.ts`

这类模块已经具备稳定 owner 特征：

- 有明确状态责任
- 不依赖页面
- UI 通过订阅使用，而非自己持有真源

##### B. Open tab 真源块

- `open-tab-intent.ts`
- `open-tab-persistence.ts`
- `open-tab-restore.ts`

这组已经很接近“完整 truth slice”。

##### C. Server runtime/support blocks

- `terminal-core-support.ts`
- `terminal-mirror-runtime.ts`
- `terminal-control-runtime.ts`
- `terminal-transport-runtime.ts`
- `terminal-schedule-runtime.ts`

server 侧反而比 terminal page 侧更接近“按能力块拆”。

#### blocks 层问题

##### 问题 1：部分 block 实际上仍是中间装配层

例如：

- `session-context-message-assemblies.ts`
- `session-context-provider-assemblies.ts`
- `session-context-transport-orchestration-runtime.ts`

这些文件有价值，但它们更像：

- 组合器
- wiring glue
- orchestrator 中间层

它们并不是明确的领域真源块。如果不加命名区分，维护者会误以为它们本身是 owner。

##### 问题 2：命名体系过于演进式，稳定层级不够清楚

当前混合存在：

- `*-runtime.ts`
- `*-orchestration-runtime.ts`
- `*-lifecycle-runtime.ts`
- `*-provider-assemblies.ts`
- `*-public-facade-runtime.ts`
- `*-infra-facade-runtime.ts`

这说明当前拆分是“重构进行中”，但还没完全冻结为长期可维护的结构体系。

##### 问题 3：部分大块仍偏厚

典型：

- `session-context-buffer-runtime.ts`（778 行）
- `session-context-session-runtime.ts`（524 行）
- `session-context-transport-runtime.ts`（494 行）

这些文件已经比原先��中式 context 好，但仍然偏厚，说明某些规则/owner 还能继续外提。

---

### 4.3 纯编排层审计

#### 结论

**纯编排层只局部达标，没有整体达标。**

#### `SessionContext.tsx`

评价：**基本达标**

原因：

- 本体变薄
- 主要做 provider 装配
- 暴露 facade
- 真正实现已下沉到 runtime/store/assembly 层

这是当前 client 侧最接近“纯编排壳”的模块之一。

#### `App.tsx`

评价：**大体合格，但偏胖**

优点：

- 已经像 app shell
- 页面切换、global storage、session runtime、picker、update modal 都集中在应用层协调

不足：

- `AppContent` 横切能力过多
- 未来若继续增长，容易再次变成应用级 God component

#### `TerminalPage.tsx`

评价：**明确不合格**

原因：

- 文件极大
- 同时承载页面编排、局部状态机、helper、overlay controllers、复制逻辑、keyboard/viewport logic
- 不符合“page 只做 stage/orchestration”原则

这是当前最需要改的地方。

---

## 5. 关键证据

### 5.1 文件体量证据

已检查的关键文件行数：

- `android/src/pages/TerminalPage.tsx`：**3462**
- `android/src/pages/ConnectionsPage.tsx`：565
- `android/src/contexts/SessionContext.tsx`：298
- `android/src/hooks/useOpenTabRuntime.ts`：478
- `android/src/hooks/useSessionOpenActions.ts`：485
- `android/src/contexts/session-context-session-runtime.ts`：524
- `android/src/contexts/session-context-transport-runtime.ts`：494
- `android/src/contexts/session-context-buffer-runtime.ts`：778
- `android/src/server/server.ts`：399
- `android/src/server/terminal-core-support.ts`：109

这个分布本身就说明：

- `SessionContext.tsx` 已经瘦身成功
- `server.ts` 入口尚可控
- **`TerminalPage.tsx` 是最突出的大热点**

### 5.2 shared 真源证据

已确认存在并被消费的 shared terminal rules：

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/visible-range.ts`
- `packages/shared/src/terminal/buffer-sync-request-planner.ts`

说明共享函数库已真实存在。

### 5.3 server glue/support 分层证据

`server.ts` 中已存在：

- `createTerminalCoreSupport`
- support destructuring 后交给 runtime 使用

并有 truth gate 要求 helper 不得回流到 `server.ts`。

这说明“入口做 glue、support 做 helper”的模式已开始建立。

---

## 6. 主要改进空间

以下按优先级排序。

### P0：把 `TerminalPage.tsx` 收成真正的纯编排壳

这是当前最重要、最唯一的结构热点。

#### 为什么是 P0

因为：

- shared 层已经存在，不是主矛盾
- SessionContext 壳层已薄化，不是主矛盾
- server 入口也已开始 support 抽离，不是主矛盾
- **`TerminalPage.tsx` 仍同时持有编排 + 状态机 + UI helper + overlay 协调，直接破坏三层结构**

#### 建议拆法

不是只按 UI 组件拆，而是按职责块拆：

1. `terminal-page-render-keys.ts`
   - `terminalPageRenderedSessionUiKey`
   - `terminalPageHeaderSessionUiKey`
   - input epoch / header key / render key 等 identity helper

2. `terminal-copy-selection.ts`
   - `CopySelectionState`
   - buffer rows -> text
   - selection buffer coverage / resolve logic
   - clipboard 相关纯 helper

3. `terminal-keyboard-lift.ts`
   - `resolveKeyboardLiftPx`
   - `resolveLayoutViewportHeight`
   - `resolveTerminalHeaderTopInsetPx`
   - 其他 viewport/window helper

4. `useTerminalPageOverlays.ts`
   - debug overlay
   - copy menu
   - tab manager
   - schedule / screenshot / transfer sheet open-close state

5. `useTerminalPageInteractionRuntime.ts`
   - 当前 interactive session
   - pane attach intent apply
   - chrome switch
   - quickbar interaction
   - selection mode 等局部 runtime

6. `TerminalPage.tsx`
   - 最终只保留：组合 hooks + 组合 stage + 渲染 JSX

目标不是机械地把 3462 行拆成多个文件，而是让 `TerminalPage.tsx` **在语义上成为纯 orchestration shell**。

---

### P1：稳定 `session-context-*` 的结构命名体系

当前问题不是“不能运行”，而是长期维护成本高。

#### 建议固定 5 类命名

1. `*-store.ts`
  - 状态真源块

2. `*-rules.ts` / `*-planner.ts`
  - 纯规则块

3. `*-runtime.ts`
  - 单领域执行块，有状态、无 UI

4. `*-orchestrator.ts`
  - 组合多个 store/runtime/rules

5. `*-facade.ts`
  - 对 React/context/page 暴露薄接口

#### 不建议继续扩张的命名模式

- `provider-assemblies`
- `public-facade-runtime`
- `infra-facade-runtime`
- `transport-control-orchestration-runtime`

这些名字不是错，但层次信息太多，容易让结构变得“只有作者自己懂”。

---

### P2：继续把 Android 侧 planner / pure rules 下沉到 `packages/shared`

原则：凡是同时满足以下条件的逻辑，都应优先下沉：

1. 不依赖 React
2. 不依赖 DOM / browser API
3. 不依赖 Android/Capacitor
4. 输入输出纯数据
5. client/server/mac/android 未来都可能复用

重点关注：

- `session-buffer-planner-helpers.ts` 中仍可纯化的部分
- 一些 viewport/window/repair/request 计算 wrapper
- terminal/session identity / normalization 规则

这样才能真正做到：

> block 只做编排，规则统一沉到 shared leaf。

---

### P3：把大 hook 再拆成“React 接入层”与“领域 block 层”

重点：

- `useOpenTabRuntime.ts`
- `useSessionOpenActions.ts`
- `useTerminalWorkspace.ts`

当前这些 hook 已经不是简单 hook，而更像“领域模块 + lifecycle bridge”的混合体。

建议把它们拆成：

- runtime/store/planner/block
- 再由薄 hook 去接 React 生命周期

这样 hook 才不会再次变成新一代 God module。

---

### P4：建立结构门禁，而不是只靠人工记忆

建议新增：

#### 1. 文件体量门禁

例如对 page/context/entry 层设置阈值：

- `TerminalPage.tsx > 800` 报警
- `App.tsx > 500` 报警
- `SessionContext.tsx > 400` 报警

#### 2. import 门禁

例如：

- server 禁止 import `@zterm/shared` root
- shared 禁止 import React / Capacitor / browser-only APIs
- page 层禁止直连 transport deep runtime

#### 3. truth owner 门禁

为 open-tab / transport / buffer / renderer 等热点建立 owner 文件清单和 duplicate-logic 检查。

---

## 7. 分模块审计意见

### 7.1 `App.tsx`

#### 评价

**基本合格，但偏胖。**

#### 优点

- 已经比较像 app shell
- 页面、settings、picker、open-tab runtime 等都在应用层协调

#### 问题

- 横切能力太多
- update modal / relay debug / picker / open-tab / terminal actions 全堆在 `AppContent`

#### 建议

- 拆 `useAppShellRuntime`
- 拆 `AppGlobalSheets`
- 拆 `AppGlobalOverlays`

---

### 7.2 `SessionContext.tsx`

#### 评价

**当前最接近纯编排壳的客户端模块之一。**

#### 优点

- provider 薄
- facade 清楚
- 真正逻辑已下沉

#### 问题

- 依赖的命名层级过复杂
- 下游 assembly/glue 层仍偏厚

#### 建议

- 继续稳定 runtime/store/orchestrator/facade 分层
- 减少“assembly only”中间胶水层数量

---

### 7.3 `TerminalPage.tsx`

#### 评价

**明确不合格，是当前第一架构热点。**

#### 问题

- 巨型文件
- 不纯编排
- 混合大量局部状态机和 helper

#### 建议

- 先抽纯 helper
- 再抽 overlay/runtime hooks
- 最后让 page 只保留 stage orchestration

---

### 7.4 `useOpenTabRuntime.ts`

#### 评价

**方向正确，但仍然偏厚。**

#### 优点

- open-tab truth 已明显集中
- persistence / intent / restore 已有对应 pure modules

#### 问题

- restore / runtime sync / foreground effect / page orchestration 仍混在一起

#### 建议

- 拆 runtime store
- 拆 restore orchestrator
- hook 只做 lifecycle/facade bridge

---

### 7.5 `useSessionOpenActions.ts`

#### 评价

**更像“用例编排层”，但还没有彻底声明自己只是编排层。**

#### 问题

- picker UI state
- open/switch/rename/close
- group selection
- saved tab list
- page navigation

都揉在一个 hook 里。

#### 建议

- 将 picker state owner 与 open-session domain action owner 分离
- 把“页面动作编排”与“领域规则”分开

---

### 7.6 `packages/shared`

#### 评价

**是当前最值得继续扩大的正确方向。**

#### 建议

- 继续吸 terminal planner / normalization / viewport / identity pure rules
- 强化 leaf-only import discipline
- 避免 shared 再带回平台/UI依赖

---

### 7.7 server 侧

#### 评价

**比 client terminal page 侧更接近薄 glue + blocks。**

#### 优点

- `server.ts` 仍可控
- 已有 support/runtime 分离
- truth tests 存在

#### 不足

- 如果后续增长，仍需继续保住 entry 薄壳
- support/runtime 之间也需要持续守住唯一 owner

---

## 8. 最终判定

### 8.1 是否已经按“共享函数库 + blocks + 纯编排”设计？

**答案：部分达标，尚未完全达标。**

更细分地说：

#### 已达标部分

- **共享函数库**：已建立，且已真实承载 terminal/connection/layout 等纯规则
- **blocks**：已形成主体框架，尤其在 session/store/open-tab/server runtime 这些方向

#### 未达标部分

- **纯编排层**：未整体达标，尤其 `TerminalPage.tsx` 明显未收口
- **block 边界稳定性**：命名层级和 owner 表达还可进一步收敛
- **shared / android-lib 真源边界**：还可继续冻结

---

## 9. 下一步建议顺序

### 第一阶段：优先收口 terminal page

1. 重构 `TerminalPage.tsx`
2. 按职责拆 helper / overlay / interaction runtime / orchestration shell
3. 为 terminal page 加文件大小与结构门禁

### 第二阶段：稳定 session-context 体系

4. 统一 runtime/store/orchestrator/facade 命名
5. 压缩 assembly/glue 中间层
6. 把大 hook 继续外提为 block + thin hook

### 第三阶段：统一 shared 真源

7. 继续把 Android 侧可纯化 planner 下沉到 `packages/shared`
8. 建立 import / owner / file-size 自动门禁
9. 防止 shared、android-lib、page 三层再次长出重复规则

---

## 10. 唯一性判断

按本项目要求，本次审计必须说明“为什么下一步主改点具有唯一性”。

### 唯一主改点

**`android/src/pages/TerminalPage.tsx` 是当前最唯一、最关键的架构整改点。**

### 为什么它是唯一主改点

因为：

1. shared 层已经真实存在，不是当前最大问题
2. SessionContext 壳层已明显瘦身，不是当前最大问题
3. server.ts 已开始 helper/support 下沉，也不是当前最大问题
4. **只有 `TerminalPage.tsx` 仍然同时承载编排、状态机、UI helper、overlay 协调、局部 runtime，直接破坏“纯编排”目标**

所以从“哪里最偏离目标架构”这个角度看，**它是当前唯一最突出的真源修改入口**。

不是说其他地方没有改进空间，而是：

> 如果现在只允许选一个主目标来推进三层设计收口，那么唯一正确的第一落点就是 `TerminalPage.tsx`。

---

## 11. 审计摘要（给后续执行者）

- **当前状态**：shared 已成型，blocks 已建立主体，但纯编排未全局达标
- **最大问题**：`TerminalPage.tsx` 不是纯编排壳
- **验证依据**：文件体量、模块职责、shared leaf 使用情况、SessionContext/server 壳层现状
- **下一步唯一主目标**：把 `TerminalPage.tsx` 收成真正的 orchestration shell
- **后续收口方向**：稳定 session-context 命名层次，继续把 pure rules 下沉到 `packages/shared`
# zterm Android 架构审计报告（共享函数库 + blocks + 纯编排）

- 日期：2026-05-24
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计主题：当前代码是否按“共享函数库 + blocks + 纯编排”设计
- 结论等级：**部分达标，未完全达标**

---

## 1. 执行摘要

当前代码库已经**明显朝“共享函数库 + blocks + 纯编排”方向演进**，并且其中两层已经有真实成果：

1. **共享函数库层**已经成立：
   - `packages/shared/src/terminal/*`
   - `packages/shared/src/connection/*`
   - `android/src/lib/*` 中的纯函数 / store / manager
2. **blocks 层**已经大量形成：
   - `session-context-*`
   - `open-tab-*`
   - `session-buffer-store` / `session-render-gate` / `session-head-store`
   - server 侧 `terminal-*-runtime` / `terminal-core-support`

但第三层 **“纯编排”还没有完全收口**。

当前最大的结构偏差点不是 shared，也不是 server，而是：

- `android/src/pages/TerminalPage.tsx`
- 以及部分 `use*Runtime` / `session-context-*` 装配层

它们虽然已经拆分，但仍存在：

- 编排层夹带实现
- block 层夹带 glue / assembly
- 命名层次过多导致真源 owner 不够稳定

**最终结论**：

- **共享函数库：达标趋势明确，质量较好**
- **blocks：已成型，但边界仍需收敛**
- **纯编排：尚未达标，尤其 `TerminalPage.tsx` 是当前唯一主热点**

---

## 2. 审计依据

### 2.1 文档依据

1. `AGENTS.md`
2. `android/docs/architecture.md`
3. `android/docs/ui-slices.md`
4. `android/CACHE.md`
5. `android/MEMORY.md`

### 2.2 重点审计文件

#### App / Page / Hook

- `android/src/App.tsx`
- `android/src/pages/ConnectionsPage.tsx`
- `android/src/pages/ConnectionPropertiesPage.tsx`
- `android/src/pages/TerminalPage.tsx`
- `android/src/hooks/useOpenTabRuntime.ts`
- `android/src/hooks/useSessionOpenActions.ts`
- `android/src/hooks/useTerminalShellActions.ts`
- `android/src/hooks/useTerminalWorkspace.ts`

#### Context / Session Runtime

- `android/src/contexts/SessionContext.tsx`
- `android/src/contexts/session-context-buffer-runtime.ts`
- `android/src/contexts/session-context-session-runtime.ts`
- `android/src/contexts/session-context-transport-runtime.ts`
- `android/src/contexts/session-context-message-assemblies.ts`
- `android/src/contexts/session-context-provider-assemblies.ts`
- `android/src/contexts/session-context-provider-core-assemblies.ts`
- `android/src/contexts/session-context-transport-orchestration-runtime.ts`

#### Shared / Lib / Store

- `packages/shared/src/terminal/*`
- `android/src/lib/open-tab-intent.ts`
- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/terminal-width-mode-manager.ts`
- `android/src/lib/connections-server-groups.ts`

#### Server

- `android/src/server/server.ts`
- `android/src/server/terminal-core-support.ts`
- `android/src/server/terminal-runtime.ts`
- `android/src/server/terminal-mirror-runtime.ts`

---

## 3. 审计标准

本次严格按以下三层标准判定：

```text
orchestration（纯编排）
    ↓
blocks（唯一职责块 / 真源块）
    ↓
shared pure functions / stores（共享纯函数与基础真相）
```

关键判定问题：

1. 业务规则是否下沉为共享纯函数或纯规则块
2. 每个能力是否有明确 block owner
3. 顶层 page / app / context / server entry 是否只是编排
4. 是否存在跨层重复实现
5. 是否��在“文件拆了但语义没拆”的假模块化

---

## 4. 总体审计结论

### 4.1 总结结论

当前设计可以概括为：

> **shared 已成型，blocks 已成体系，orchestration 还没彻底纯化。**

这不是“没做成”，而是“前两层已经有真实成果，最后一层还没收口”。

### 4.2 是否符合目标架构

| 维度 | 结论 | 说明 |
|---|---|---|
| 共享函数库 | 基本达标 | 已存在大量真实 leaf module |
| blocks | 部分达标 | 已拆很多，但部分 block 混入 orchestration / assembly |
| 纯编排 | 未完全达标 | 尤其 `TerminalPage.tsx` 严重偏离 |

---

## 5. 做得对的部分

### 5.1 Shared 纯函数层已经真实存在

这是当前架构里最健康的一层之一。

#### 证据

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/visible-range.ts`
- `packages/shared/src/terminal/buffer-sync-request-planner.ts`
- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/open-tab-intent.ts`
- `android/src/lib/connections-server-groups.ts`

#### 评价

这些文件具备以下特征：

- 输入输出清晰
- 不依赖 React 生命周期
- 可单测
- 多处可复用
- 作为底层真相没有问题

这说明当前仓库并不是口头说“共享函数库”，而是真的有一批已经可复用、可验证、可独立维护的 shared leaf modules。

---

### 5.2 SessionContext 壳层已经明显薄化

#### 证据

- `android/src/contexts/SessionContext.tsx` 约 298 行

它的主要职责是：

- 初始化 reducer / refs
- 装配 provider runtime
- 构建 stable facade
- 暴露 context value

真实行为已下沉到：

- `session-context-provider-runtime.ts`
- `session-context-provider-assemblies.ts`
- `session-context-public-facade-runtime.ts`
- `session-context-buffer-runtime.ts`
- `session-context-session-runtime.ts`
- `session-context-transport-runtime.ts`

#### 评价

这说明 Context 入口已经接近“薄壳 + facade + runtime block”的目标，而不是继续把所有业务堆在一个 God object 里。

---

### 5.3 server.ts 已开始变成薄入口

#### 证据

- `android/src/server/server.ts` 约 399 行
- `android/src/server/terminal-core-support.ts` 约 109 行
- 存在 truth gate：`android/src/server/server.core-support-truth.test.ts`

#### 评价

server 侧已经开始把 helper 从 `server.ts` 抽到 support/runtime 模块，这是正确方向。

当前 `server.ts` 还没有变成巨型入口，这一点比 client page 层要更健康。

---

### 5.4 状态真相已经开始从 React state 下沉为 store

#### 证据

- `session-buffer-store.ts`
- `session-render-gate.ts`
- `session-head-store.ts`
- `session-viewport-mode-store.ts`

#### 评价

这是 blocks 化最关键的一步之一。

因为一旦真相从组件内部状态迁到独立 store：

- owner 更清晰
- 测试更稳定
- UI 与业务更容易解耦
- 后续跨页 / 跨平台复用更现实

这一点说明当前项目并不是只做表面上的文件拆分，而是在移动真相归属。

---

## 6. 当前不达标的主问题

### 6.1 `TerminalPage.tsx` 明显不是纯编排

#### 证据

- `android/src/pages/TerminalPage.tsx`：**3462 行**

#### 现状

从审计内容看，它同时承担：

- 页面编排
- tab chrome 编排
- copy selection 逻辑
- debug overlay 逻辑
- keyboard / viewport / layout helper
- quickbar / sheet / pane attach 协调
- terminal shell 局部状态机
- 大量 UI helper

#### 结论

这说明它不是：

```text
TerminalPage = 纯编排页壳
```

而是：

```text
TerminalPage = 页壳 + 多个交互块 + overlay 协调器 + helper 集合 + 局部状态机
```

这直接违反“编排层不承载实现”的目标。

**这是本次审计中最明确、最重要的问题。**

---

### 6.2 `session-context-*` 已经拆了很多，但层次有些过碎

#### 证据

代表文件：

- `session-context-buffer-runtime.ts`：778 行
- `session-context-session-runtime.ts`：524 行
- `session-context-transport-runtime.ts`：494 行
- `session-context-provider-core-assemblies.ts`：417 行
- `session-context-transport-orchestration-runtime.ts`：461 行

#### 现状问题

这些文件不是没拆，而是：

- 拆出了许多 runtime / assembly / facade / orchestration
- 但有些层的职责仍有重叠
- 读代码时仍不容易一眼看出“哪个文件才是某条规则的唯一 owner”

#### 主要风险

1. **胶水层过厚**
  - `session-context-message-assemblies.ts`
  - `session-context-provider-assemblies.ts`
  - `session-context-transport-orchestration-runtime.ts`

  这些文件更像组合器，而不是唯一真源块。

2. **命名层次不稳定**
  - `*-runtime.ts`
  - `*-orchestration-runtime.ts`
  - `*-provider-assemblies.ts`
  - `*-public-facade-runtime.ts`

  说明当前拆分仍偏“演化型命名”，而不是已经稳定成固定架构语言。

#### 结论

SessionContext 这套结构方向是对的，但还没有完全达到“block owner 清晰、编排与实现完全分离”的状态。

---

### 6.3 部分大 hook 仍然同时承担 runtime truth 与 orchestration

#### 证据

- `useOpenTabRuntime.ts`：478 行
- `useSessionOpenActions.ts`：485 行
- `useTerminalWorkspace.ts`：601 行

#### 现状问题

这些 hook 不是简单的 React glue，而更像：

- 领域运行态 + effect 协调 + page 行为控制 + 存储同步

也就是说，hook 虽然拆出了功能，但角色没有完全单一。

#### 风险

以后容易变成：

- 真相在 hook 里
- 协调也在 hook 里
- facade 也在 hook 里

这样会让 hook 文件再次膨胀成另一种“页面级 God module”。

---

### 6.4 shared 与 android/lib 的边界还未完全冻结

#### 现状

当前 terminal 相关纯规则分布在两处：

- `packages/shared/src/terminal/*`
- `android/src/contexts/session-buffer-planner-helpers.ts`
- 一些 `android/src/lib/*` terminal helper

#### 问题

这说明 shared 已经建立，但其边界还没完全封住。

如果不继续下沉，后续很容易出现：

- shared 一套 planner
- android 再包一层 planner helper
- helper 里再夹一点业务判断

最终又变成第二真源。

---

## 7. 分层审计

### 7.1 Shared 函数库层

#### 结论

**这一层整体健康，方向正确，应继续扩展。**

#### 优点

1. terminal planner / repair / visible-range / head-state 已有 leaf truth
2. connection / layout / workspace 也已有共享模块
3. 可单测性好，复用性真实存在

#### 不足

1. shared 覆盖面还不彻底
2. Android 侧仍留有一些 planner wrapper
3. 需要更硬的 import / ownership 门禁

#### 评价

当前 shared 是整个项目最接近“长期稳定真源层”的部分。

---

### 7.2 blocks 层

#### 结论

**已成型，但边界还需收敛。**

#### 已较成熟的 block

1. **store 类 block**
  - `session-buffer-store.ts`
  - `session-render-gate.ts`
  - `session-head-store.ts`
  - `session-viewport-mode-store.ts`

2. **open-tab 真源块**
  - `open-tab-intent.ts`
  - `open-tab-persistence.ts`
  - `open-tab-restore.ts`

3. **server runtime block**
  - `terminal-mirror-runtime.ts`
  - `terminal-transport-runtime.ts`
  - `terminal-control-runtime.ts`
  - `terminal-schedule-runtime.ts`

#### 主要问题

1. 部分 block 其实是 orchestration glue
2. 命名不够统一
3. “runtime / assembly / facade / orchestration” 层次太多，读者不易快速定位唯一 owner

#### 评价

blocks 已经有了，但还需要一次“语义收口”，避免继续在中间层膨胀。

---

### 7.3 orchestration 层

#### 结论

**这是当前最弱的一层。**

#### `App.tsx`

- 评价：**基本合格，偏胖**
- 原因：虽然主要做 page switch 和 hook 装配，但横切能力仍较多

#### `SessionContext.tsx`

- 评价：**基本合格**
- 原因：已接近 provider 壳 + facade 结构

#### `TerminalPage.tsx`

- 评价：**不合格**
- 原因：超大、混合实现、非纯编排

---

## 8. 关键证据清单

### 8.1 直接支持“共享函数库已成立”的证据

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/layout/profile.ts`
- `packages/shared/src/workspace/workspace-model.ts`

### 8.2 直接支持“SessionContext 壳层已收薄”的证据

- `android/src/contexts/SessionContext.tsx` 约 298 行

### 8.3 直接支持“TerminalPage 仍未纯编排”的证据

- `android/src/pages/TerminalPage.tsx` 约 3462 行

### 8.4 直接支持“blocks 已有但装配层偏厚”的证据

- `android/src/contexts/session-context-buffer-runtime.ts` 778 行
- `android/src/contexts/session-context-session-runtime.ts` 524 行
- `android/src/contexts/session-context-transport-runtime.ts` 494 行
- `android/src/contexts/session-context-provider-core-assemblies.ts` 417 行

### 8.5 直接支持“server 已接近薄入口”的证据

- `android/src/server/server.ts` 399 行
- `android/src/server/terminal-core-support.ts` 109 行
- `android/src/server/server.core-support-truth.test.ts`

---

## 9. 改进空间与建议

### 9.1 P0：优先把 `TerminalPage.tsx` 收成真正纯编排壳

这是当前最优先改进项。

#### 原因

因为当前 shared 层已经存在，SessionContext 也已经薄化，server 入口也不算坏。

**唯一最明显破坏三层设计的主热点，就是 `TerminalPage.tsx`。**

#### 建议拆分方向

1. `terminal-page-render-keys.ts`
  - 只放 UI key / identity helper

2. `terminal-copy-selection.ts`
  - 只放 copy selection 纯逻辑与 buffer text 提取

3. `terminal-keyboard-lift.ts`
  - 只放 keyboard lift / viewport helper

4. `useTerminalPageOverlays.ts`
  - 管理各类 overlay / sheet open/close

5. `useTerminalPageInteractionRuntime.ts`
  - 管理 pane attach、interactive session、chrome interaction

6. `TerminalPage.tsx`
  - 最终只保留页级编排、hook 调用、组件组合

#### 目标

不是简单减少行数，而是让文件语义变成：

> `TerminalPage.tsx` 只负责组合，而不负责实现。

---

### 9.2 P1：稳定 `session-context-*` 的层次命名

#### 建议固定为 5 类

1. `*-store.ts`
2. `*-rules.ts` / `*-planner.ts`
3. `*-runtime.ts`
4. `*-orchestrator.ts`
5. `*-facade.ts`

#### 原因

现在的命名：

- `provider-assemblies`
- `infra-facade-runtime`
- `public-facade-runtime`
- `transport-control-orchestration-runtime`

虽然不是错，但长期可读性差，维护者不容易快速建立稳定心智。

---

### 9.3 P2：把 Android 侧纯 planner 继续下沉到 `packages/shared`

#### 适用标准

满足以下条件的，应优先进入 shared：

1. 不依赖 React
2. 不依赖 DOM / browser / Capacitor
3. 只处理纯数据
4. 未来 Android / Mac / server 都可能复用

#### 重点关注

- `session-buffer-planner-helpers.ts`
- visible-range / repair / request-window 包装逻辑

---

### 9.4 P3：把“大 hook”从真源与编排混合体继续拆开

#### 重点文件

- `useOpenTabRuntime.ts`
- `useSessionOpenActions.ts`
- `useTerminalWorkspace.ts`

#### 建议

将其中的：

- runtime truth
- restore/sync rules
- app/page orchestration
- React binding

再向下分层。

hook 本身最好只做：

- 生命周期桥接
- facade 暴露
- 最少量 UI glue

---

### 9.5 P4：补结构门禁，而不是只靠人工记忆

#### 建议门禁

1. **文件大小门禁**
  - `TerminalPage.tsx > 800` 报警
  - `App.tsx > 500` 报警
  - `SessionContext.tsx > 400` 报警

2. **forbidden import 门禁**
  - server 禁止 import `@zterm/shared` root
  - shared 禁止 import React / Capacitor / DOM API
  - page 层禁止直连深层 transport runtime

3. **truth owner 门禁**
  - open-tab / terminal buffer / session transport / renderer visible-range 各自维护唯一 owner 清单

---

## 10. 按模块评价

### 10.1 `App.tsx`

#### 评价

**基本合格，偏胖。**

#### 优点

- 已接近 app shell
- 页面切换与页面内容分离
- 多数实现已委托给 hooks / runtime / lib

#### 问题

- 横切能力过多
- picker / update / relay debug / open-tab / terminal shell actions 都聚在一处

#### 建议

后续可拆：

- `useAppShellRuntime`
- `AppModalLayers`
- `AppPickerCoordinator`

---

### 10.2 `SessionContext.tsx`

#### 评价

**当前最接近“纯编排 + facade 壳”的 client 模块之一。**

#### 优点

- 入口薄
- runtime 已下沉
- stable facade 明确

#### 问题

- 下游命名体系仍复杂
- 部分 assembly 层仍偏厚

---

### 10.3 `TerminalPage.tsx`

#### 评价

**当前最不符合目标架构的文件。**

#### 问题

- 超大
- 混合 UI 实现与 orchestration
- overlay / selection / keyboard / debug / pane attach 全堆在一处

#### 结论

必须优先收口。

---

### 10.4 `useOpenTabRuntime.ts`

#### 评价

**方向正确，但仍偏厚。**

#### 问题

runtime truth、restore/sync、foreground refresh、page effects 混在一起。

#### 建议

再拆成：

- open-tab store / truth
- restore orchestrator
- foreground runtime
- React facade

---

### 10.5 `useSessionOpenActions.ts`

#### 评价

**像用例层，但角色尚未完全纯化。**

#### 问题

picker state、session open、group edit、saved-tab、page navigation 混合。

#### 建议

将 UI picker 状态与 domain open action 明确分层。

---

### 10.6 `packages/shared`

#### 评价

**当前最值得继续扩张的正确方向。**

#### 建议

- 继续吸收 terminal planner / identity / normalization / viewport 纯逻辑
- 固化 shared leaf import 规范
- 严禁平台依赖反向渗入 shared

---

### 10.7 server 侧

#### 评价

**比 client page 层更接近“薄入口 + blocks”。**

#### 优点

- `server.ts` 仍可控
- runtime/support 已拆出
- 有 truth gate

#### 建议

- 保持 `server.ts` 只做装配
- 继续把 leaf helper 下沉到 support 或 shared

---

## 11. 最终判定

### 11.1 是否已经按照“共享函数库 + blocks + 纯编排”设计？

**结论：部分是，整体还不是。**

更精确地说：

- **共享函数库：是**
- **blocks：大体是，但还不够稳定**
- **纯编排：不是，至少 `TerminalPage.tsx` 还明显不是**

---

### 11.2 唯一主问题判断

本次审计认为，当前最需要优先整改的唯一主问题是：

> `android/src/pages/TerminalPage.tsx` 仍不是纯编排壳。

#### 为什么它是唯一主问题

因为：

1. shared 层已经成立，不是主矛盾
2. SessionContext 壳层已经薄化，不是主矛盾
3. server.ts 已经开始做薄入口，也不是主矛盾
4. **只有 `TerminalPage.tsx` 仍在同时承载大量实现和编排，直接破坏三层设计**

所以这次审计的唯一性结论是：

- 若现在只允许优先解决一个结构问题
- **唯一正确的第一刀就是重构 `TerminalPage.tsx`**

其他改进都重要，但都不如它直接、核心、收益最大。

---

## 12. 建议的下一步

### 最短路径

1. 先给 `TerminalPage.tsx` 做拆分蓝图
2. 定义 Terminal 页的 block / orchestrator / helper / overlay owner
3. 再动代码拆分

### 建议产物

下一步建议新增一份实施文档，例如：

- `android/docs/audits/terminal-page-refactor-blueprint.md`

内容包括：

- 拆分文件列表
- 每个文件 owner
- 哪些必须进 shared
- 哪些属于 block
- 哪些只允许做 orchestration shell

---

## 13. 审计结论（一句话版）

> 当前仓库已经做出了真实的 shared 和 blocks，但纯编排层还没彻底成立；`TerminalPage.tsx` 是当前唯一主热点，应作为下一步唯一优先结构改造目标。
# zterm Android 架构审计报告（共享函数库 + blocks + 纯编排）

- 日期：2026-05-24
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计主题：当前代码是否符合 **共享函数库 + blocks + 纯编排（orchestration）** 的设计要求
- 审计依据：
  - `AGENTS.md`
  - `android/docs/architecture.md`
  - `android/docs/ui-slices.md`
  - `android/src/App.tsx`
  - `android/src/pages/TerminalPage.tsx`
  - `android/src/contexts/SessionContext.tsx`
  - `android/src/contexts/session-context-*.ts`
  - `android/src/hooks/useOpenTabRuntime.ts`
  - `android/src/hooks/useSessionOpenActions.ts`
  - `android/src/hooks/useTerminalShellActions.ts`
  - `android/src/lib/*`
  - `packages/shared/src/*`
  - `android/src/server/server.ts`
  - `android/src/server/terminal-core-support.ts`

---

## 1. 审计结论（Executive Summary）

**结论：当前代码库已经明显朝“共享函数库 + blocks + 纯编排”方向演进，但尚未完全达标。**

分项判断如下：

1. **共享函数库（Shared Function Library）**：**基本成立**
   - 已有真实的 shared 纯函数层，尤其是 `packages/shared/src/terminal/*`、`packages/shared/src/connection/*`、`android/src/lib/*` 中的纯函数/纯 store。
   - 这些模块多数具备单测、可复用、无 React 生命周期依赖的特征，方向正确。

2. **blocks（唯一真源块）**：**主体已形成，但边界仍不够稳定**
   - Session / transport / buffer / open-tab / server runtime 已拆成多个 block。
   - 但部分 block 与 assembly / orchestration / facade 层交织，存在“文件拆了，但语义 owner 还不够干净”的问题。

3. **纯编排（Pure Orchestration）**：**局部成立，整体未完全成立**
   - `SessionContext.tsx` 已接近“薄壳 + façade + runtime 装配”的目标。
   - `App.tsx` 基本是壳，但仍偏胖。
   - **`android/src/pages/TerminalPage.tsx` 明显未达标，是当前最主要的架构热点。**

**总判定：当前架构不是错误方向，而是已经走在正确路上，但还停在“半收口状态”。最关键的下一步不是继续泛化重构，而是集中把 `TerminalPage.tsx` 收成真正的纯编排壳。**

---

## 2. 审计标准

本次审计采用以下三层结构标准：

```text
Orchestration / 编排层
    ↓
Blocks / 唯一真源块
    ↓
Shared Pure Functions / 共享纯函数与叶子模块
```

审计判断点：

1. 是否存在**共享纯函数真源**，而不是把规则散落在 page / context / hook 中。
2. 是否存在**稳定的 block owner**，每个能力有且只有一个核心实现面。
3. 顶层 page / app / server entry 是否只做**编排**，而不再承载业务实现。
4. 是否存在**跨层重复逻辑**、重复 planner、重复状态 owner。
5. 是否存在**按文件拆分但未按职责拆分**的情况。

---

## 3. 正向结果：已经做对的部分

### 3.1 Shared 纯函数层已经真实存在

当前代码不是“口头上提 shared”，而是已经有一批真正的共享叶子模块。

#### 证据

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/visible-range.ts`
- `packages/shared/src/terminal/buffer-sync-request-planner.ts`
- `packages/shared/src/connection/*`
- `packages/shared/src/layout/*`

#### 判断

这些模块具备 shared 真源应有特征：

- 输入输出清晰
- 不依赖 React
- 不依赖浏览器组件生命周期
- 可做单测
- 可跨 client / server / future desktop 复用

这说明：

> 当前仓库已经有“共享函数库”这个层次，而且是真实存在的，不是抽象口号。

---

### 3.2 Android `lib` 内也有一批健康的 block 级叶子模块

#### 证据

- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/session-head-store.ts`
- `android/src/lib/session-viewport-mode-store.ts`
- `android/src/lib/open-tab-intent.ts`
- `android/src/lib/open-tab-persistence.ts`
- `android/src/lib/open-tab-restore.ts`
- `android/src/lib/connections-server-groups.ts`
- `android/src/lib/terminal-width-mode-manager.ts`

#### 判断

这些模块大体符合“block 下的叶子真源”：

- store 自身是真相 owner，而不是 UI 附属状态
- planner / intent / persistence 已从 page 和 hook 中抽离
- 可以单独测试
- 比较容易被其他编排层复用

这部分是当前代码库中最健康的一层之一。

---

### 3.3 `SessionContext.tsx` 已从“大一坨 God Object”明显变薄

#### 证据

- `android/src/contexts/SessionContext.tsx`：约 **298 行**
- 真实能力已被下沉到：
  - `session-context-provider-runtime.ts`
  - `session-context-provider-assemblies.ts`
  - `session-context-public-facade-runtime.ts`
  - `session-context-session-runtime.ts`
  - `session-context-transport-runtime.ts`
  - `session-context-buffer-runtime.ts`
  - `session-context-socket-message-runtime.ts`
  - `session-context-transport-orchestration-runtime.ts`

#### 判断

`SessionContext.tsx` 本身现在主要负责：

- reducer / refs 初始化
- runtime 装配
- stable facade 输出
- context provider 壳

也就是说，它已经**接近纯编排壳**，这是对的。

这不是小优化，而是架构上的明显进步。

---

### 3.4 Server 侧开始形成“入口薄壳 + support/runtime blocks”

#### 证据

- `android/src/server/server.ts`：约 **399 行**
- `android/src/server/terminal-core-support.ts`：约 **109 行**
- 对应 truth test：`android/src/server/server.core-support-truth.test.ts`

#### 判断

`server.ts` 已不再自己内联 terminal helper 实现，而是通过 `createTerminalCoreSupport(...)` 组合 support block。

这说明 server 侧已经开始满足：

> 入口文件只做装配，helper / runtime 下沉到独立模块。

虽然还不算完全收口，但方向明显正确。

---

## 4. 主要问题：尚未达标的部分

### 4.1 最大问题：`TerminalPage.tsx` 仍然不是纯编排

#### 证据

- `android/src/pages/TerminalPage.tsx`：约 **3462 行**

这是当前全仓最醒目的结构偏差点。

#### 现状判断

从文件内容看，`TerminalPage.tsx` 同时承担了：

- 页面壳编排
- header / quickbar / tab manager / schedule / screenshot / file transfer 协调
- keyboard / viewport / overlay / copy mode / debug overlay 等本地状态机
- clipboard / selection / key 生成 / layout helper 等多类辅助逻辑
- pane attach / interactive session / render key / UI key 等运行期编排

这意味着它当前不是：

```text
TerminalPage = 纯编排
```

而更像：

```text
TerminalPage = 页面壳 + 多个 UI 状态机 + 多个运行态 helper + overlay 协调器 + 交互逻辑集合
```

#### 结论

**这与“纯编排”目标直接冲突。**

当前架构如果只允许指出一个最重要的问题，那么唯一主热点就是这里。

---

### 4.2 `session-context-*` 已拆很多块，但 block 边界仍然偏碎、偏厚

#### 证据

重点文件规模：

- `session-context-buffer-runtime.ts`：约 **778 行**
- `session-context-session-runtime.ts`：约 **524 行**
- `session-context-transport-runtime.ts`：约 **494 行**
- `session-context-provider-core-assemblies.ts`：约 **417 行**
- `session-context-transport-orchestration-runtime.ts`：约 **461 行**

#### 问题一：assembly / orchestration / runtime 语义交织

例如：

- `session-context-message-assemblies.ts`
- `session-context-provider-assemblies.ts`
- `session-context-transport-orchestration-runtime.ts`

这些文件的价值并非没有，但它们更像“中间胶水层”，而不是单一 block owner。

风险在于：

- 读代码时难以快速确认唯一 owner
- 某条 buffer sync 规则到底属于 planner、runtime 还是 assembly，不够直观
- 长期容易形成“为了拆文件而拆文件”，而不是按语义建块

#### 问题二：命名层次不稳定

当前存在大量命名类型：

- `*-runtime.ts`
- `*-orchestration-runtime.ts`
- `*-lifecycle-runtime.ts`
- `*-provider-assemblies.ts`
- `*-public-facade-runtime.ts`
- `*-infra-facade-runtime.ts`

这种命名能够说明它们是重构过程中的中间态，但不能长期作为稳定架构名词。

#### 结论

**SessionContext 方向是对的，但目前更像“拆分已开始，语义秩序未完全定型”。**

---

### 4.3 大 Hook 仍然混合了 block 逻辑与 orchestration

#### 重点对象

- `android/src/hooks/useOpenTabRuntime.ts`：约 **478 行**
- `android/src/hooks/useSessionOpenActions.ts`：约 **485 行**
- `android/src/hooks/useTerminalWorkspace.ts`：约 **601 行**

#### 判断

这些 hook 比过去“所有逻辑塞进 page”已经好很多，但仍有混合问题：

1. **`useOpenTabRuntime.ts`**
   - 既包含 open-tab truth sync
   - 又包含 foreground refresh/runtime effect
   - 还带 page state 和 remote audit 协调

   它不是纯 block，也不是纯 orchestration，而是两者混合。

2. **`useSessionOpenActions.ts`**
   - 既管 picker mode / picker target / initial sessions
   - 又管 group selection / saved tab list / new connection 草稿 / page navigation
   - 更像“用例层 + UI状态机 + action service”三合一

3. **`useTerminalWorkspace.ts`**
   - 规模已超过 600 行，说明该 hook 也在承担不止一个职责面

#### 结论

当前不少 hook 仍然是：

> 领域逻辑已经从 page 移出来了，但还没有彻底沉到 block / runtime；仍挂在 React hook 壳里。

这属于“半收口”。

---

### 4.4 shared 与 `android/src/lib` 的边界还不够彻底冻结

#### 现状

当前 terminal 相关纯逻辑分布在两处：

- `packages/shared/src/terminal/*`
- `android/src/lib/*` 与 `android/src/contexts/*helpers.ts`

这本身不一定错，但从架构演进看，边界还未完全稳定。

#### 例子

- shared 中已有 planner：
  - `buffer-sync-planner.ts`
  - `gap-repair-planner.ts`
  - `buffer-head-state.ts`
- Android 侧仍有：
  - `session-buffer-planner-helpers.ts`
  - 各类 visible-range / request-window / local snapshot 包装逻辑

#### 风险

如果不继续收口，未来容易形成：

- shared 一套 planner
- Android 再包一层 helper planner
- 再在 hook/runtime 里追加少量特判

最后又回到重复真源。

#### 结论

**shared 层已经建立，但 shared 真源覆盖面还不够彻底，需要继续吸收可跨端复用的纯规则。**

---

## 5. 分层审计结论

### 5.1 Shared 函数库层

#### 判定

**整体健康，是当前最成熟的一层。**

#### 优点

- 已有真实 terminal leaf modules
- 可测试
- 无 UI 生命周期依赖
- 具备跨 client/server 的共享价值

#### 问题

- 还未完全覆盖所有 terminal 纯规则
- shared 进入标准尚未形成强门禁，只是实践上在做

#### 结论

**应继续扩 shared，而不是回退。**

---

### 5.2 Blocks 层

#### 判定

**主体已形成，但存在过碎与中间胶水层偏厚的问题。**

#### 做得比较好的 block 类型

1. **store 型 block**
   - `session-buffer-store.ts`
   - `session-head-store.ts`
   - `session-render-gate.ts`
   - `session-viewport-mode-store.ts`

2. **open-tab 真源块**
   - `open-tab-intent.ts`
   - `open-tab-persistence.ts`
   - `open-tab-restore.ts`

3. **server runtime/support 块**
   - `terminal-core-support.ts`
   - `terminal-mirror-runtime.ts`
   - `terminal-transport-runtime.ts`
   - `terminal-control-runtime.ts`
   - `terminal-schedule-runtime.ts`

#### 主要问题

- 部分“block”实际上是 orchestration glue
- owner 边界对维护者不够一眼明确
- 命名不统一，长期成本偏高

#### 结论

**blocks 已经存在，但需要继续稳定语义边界。**

---

### 5.3 编排层

#### 判定

**这是当前最弱的一层。**

#### 模块判断

1. **`App.tsx`**：基本合格，但仍偏胖
2. **`SessionContext.tsx`**：已接近纯编排薄壳
3. **`TerminalPage.tsx`**：明确不合格，是当前最大的反例

#### 结论

**当前并不能说“整个 app 层已经是纯编排”；只能说“部分入口接近纯编排，TerminalPage 仍严重偏离”。**

---

## 6. 模块级详细审计

### 6.1 `android/src/App.tsx`

#### 评价

**基本合格，但仍偏胖。**

#### 做得对的地方

- 已经像 app shell，而不是单页大杂烩
- page state 与 page component 有明显分离
- 大部分能力通过 hooks / runtime / lib 注入

#### 问题

当前 `AppContent` 仍同时装配：

- app update
- relay debug 流
- host storage
- open tab runtime
- terminal shell actions
- session open actions
- picker sheet
- update modal

它仍是一个偏厚的应用总编排器。

#### 结论

`App.tsx` 不是当前主矛盾，但后续若继续增长，会再次膨胀。

---

### 6.2 `android/src/contexts/SessionContext.tsx`

#### 评价

**这是目前 client 端最接近“纯编排 + façade”的模块之一。**

#### 做得对的地方

- Provider 壳很薄
- 对外暴露的是 stable facade
- 真实行为已转移到 runtime / assemblies / infra 层

#### 问题

- 依赖的下游模块层次过多
- 命名体系未完全稳定
- 中间装配层还偏厚

#### 结论

方向正确，不是当前最先该动刀的点。

---

### 6.3 `android/src/pages/TerminalPage.tsx`

#### 评价

**当前全仓最需要重构的文件。**

#### 主要问题

- 文件体量极大（3462 行）
- 编排、UI 状态机、overlay 协调、helper、clipboard/copy、debug 等职责全部堆在一起
- 并非纯 orchestration shell

#### 结论

当前如果只做一个架构整改动作，这里就是唯一优先点。

---

### 6.4 `android/src/hooks/useOpenTabRuntime.ts`

#### 评价

**方向正确，但仍然厚。**

#### 优点

- open-tab truth 已有明确收口意图
- persistence / intent / restore 已抽到 lib

#### 问题

- foreground refresh、runtime sync、page coordination 仍混在一起
- 还不是一个“纯 runtime block + 薄 hook facade”的结构

#### 结论

需要继续拆，但不是当前最高优先级。

---

### 6.5 `android/src/hooks/useSessionOpenActions.ts`

#### 评价

**更像一个“用例服务���”，但职责仍然混合。**

#### 问题

- picker UI state
- open / close / rename / load saved tabs
- group selection
- page navigation
- draft host flow

都在一个 hook 中。

#### 结论

应进一步区分：

- session open domain actions
- picker UI orchestration
- page navigation side effects

---

### 6.6 `packages/shared`

#### 评价

**当前最值得继续扩展的正确方向。**

#### 结论

继续把 terminal planner / normalization / viewport / identity 相关纯逻辑下沉到 shared，会比继续在 page/hook/runtime 内局部打补丁更正确。

---

### 6.7 Server 侧

#### 评价

**比 client 更接近“薄入口 + runtime blocks”结构。**

#### 做得对的地方

- `server.ts` 规模可控
- support/runtime 分层已开始出现
- 有 truth gates 保护 helper 不回流到入口文件

#### 问题

- 若未来继续增长，server.ts 仍可能再次膨胀
- support 层目前还只是第一步，尚未形成系统化命名与门禁

#### 结论

当前不是 server 侧主矛盾。

---

## 7. 关键证据摘要

1. `android/src/pages/TerminalPage.tsx`：**3462 行**
  - 直接证明“纯编排”未达标。

2. `android/src/contexts/SessionContext.tsx`：**298 行**
  - 直接证明 Context 壳层已变薄，方向正确。

3. `android/src/contexts/session-context-buffer-runtime.ts`：**778 行**
  - 说明 buffer truth 已被单独抽块，但块本身仍偏厚。

4. `android/src/hooks/useOpenTabRuntime.ts`：**478 行**
  - 说明 open-tab 逻辑已从 UI 移出，但还未完全纯化。

5. `android/src/hooks/useSessionOpenActions.ts`：**485 行**
  - 说明 session 打开流程已形成服务层，但还混有 UI/picker 编排。

6. `android/src/server/server.ts`：**399 行**
  - 说明 server 入口层比 client page 层更接近薄壳。

7. `android/src/server/terminal-core-support.ts`：**109 行**
  - 说明 server helper 已开始单独成块。

8. `packages/shared/src/terminal/*`
  - 说明 shared terminal 纯函数层已真实存在。

---

## 8. 改进建议（按优先级排序）

### P0：优先重构 `TerminalPage.tsx`

这是当前**唯一主目标**。

#### 原因

因为当前最明显违反“纯编排”原则的，不是 shared、不��� SessionContext，也不是 server，而是 `TerminalPage.tsx`。

#### 建议拆分方向

先按职责切，不按 JSX 切：

1. `terminal-page-render-keys.ts`
  - 放 render key / ui key / epoch key 相关纯 helper

2. `terminal-copy-selection.ts`
  - 放 copy selection state / buffer slice / plaintext extraction / clipboard rules

3. `terminal-keyboard-lift.ts`
  - 放 keyboard inset / viewport / header top inset 等纯 helper

4. `useTerminalPageOverlays.ts`
  - 管理 debug overlay / copy menu / schedule sheet / screenshot sheet / transfer sheet / tab manager

5. `useTerminalPageInteractionRuntime.ts`
  - 管 interactive session / pane attach / terminal chrome action coordination

6. `TerminalPage.tsx`
  - 最终只保留：组装 hooks、拼 stage、拼 overlays、返回 JSX

#### 验收标准

- `TerminalPage.tsx` 不再含大量纯 helper
- `TerminalPage.tsx` 不再自己维护多套 overlay 状态机
- 新文件职责可一眼看出 owner
- `TerminalPage.tsx` 文件规模明显下降，并能被读成 orchestration shell

---

### P1：稳定 `session-context-*` 命名与层次

建议未来只保留清晰的 5 类名词：

1. `*-store.ts`
2. `*-rules.ts` / `*-planner.ts`
3. `*-runtime.ts`
4. `*-orchestrator.ts`
5. `*-facade.ts`

当前不建议继续扩张的命名：

- `*-provider-assemblies.ts`
- `*-public-facade-runtime.ts`
- `*-infra-facade-runtime.ts`
- `*-transport-control-orchestration-runtime.ts`

这些名词能表达历史过程，但不利于长期稳定维护。

---

### P2：继续把可跨端 planner / normalization 下沉到 `packages/shared`

下沉标准：

- 不依赖 React
- 不依赖浏览器 DOM
- 不依赖 Capacitor / Android
- 输入输出都是纯数据
- 未来 Mac / daemon / Android 可能共用

重点候选：

- visible-range 规划
- local snapshot request window 规划
- 部分 session buffer planner helper
- terminal identity / key generation 中的纯逻辑部分

---

### P3：把大 Hook 再向“runtime block + hook facade”收口

重点：

- `useOpenTabRuntime.ts`
- `useSessionOpenActions.ts`
- `useTerminalWorkspace.ts`

建议：

- hook 只接 React 生命周期
- 领域 runtime 下沉到无 React 依赖块
- orchestration 与 truth owner 分离

---

### P4：补结构门禁，不只靠人工记忆

建议新增：

1. **文件大小门禁**
  - `TerminalPage.tsx` 超阈值即报警
  - `App.tsx`、`SessionContext.tsx`、`server.ts` 设各自警戒线

2. **forbidden import 门禁**
  - page 层禁止直接 import 深层 transport/runtime 内部实现
  - shared 层禁止引入 React / Capacitor / browser APIs
  - server 禁止 import `@zterm/shared` root，只允许 leaf import

3. **truth owner 门禁**
  - open-tab / session transport / terminal buffer 明确 owner 文件与 forbidden duplicate list

---

## 9. 最终判定

### 是否“已经按照共享函数库 + blocks + 纯编排方式设计”？

**最终判定：部分达标，未完全达标。**

更精确地说：

#### 已达标部分

- **共享函数库**：已明显建立
- **blocks**：主体已出现，尤其 store、open-tab、server runtime、terminal planner 方向

#### 未达标部分

- **纯编排**：只在部分入口成立，TerminalPage 明显未成立
- **block 边界稳定性**：SessionContext 周边仍在演进态
- **shared / android-lib 真源边界**：尚未完全冻结

---

## 10. 唯一性论证：下一步最该改哪里，为什么是唯一主目标

按项目规则，本审计必须给出唯一性判断。

**本次审计结论中的唯一主目标是：重构 `android/src/pages/TerminalPage.tsx`，把它收成纯编排壳。**

#### 为什么这是唯一主目标

因为在当前架构中：

- shared 层已经存在，不是主矛盾
- SessionContext 壳已经变薄，不是主矛盾
- server.ts 已开始 helper 下沉，不是主矛盾
- hook / runtime 命名混乱虽有问题，但还属于“次级整洁性问题”

**只有 `TerminalPage.tsx` 同时满足以下三个条件：**

1. 体量最大，结构最不透明
2. 直接违反“纯编排”目标
3. 会持续反向污染 page / hooks / overlay / terminal interaction 边界

所以：

> 如果不先改 `TerminalPage.tsx`，继续讨论“shared 更纯一点”“block 命名再统一一点”，都不是当前主矛盾的唯一解。

#### 为什么其他点不是唯一主解

- 先改 SessionContext 命名：会更整齐，但不会消除 page 层混合真相
- 先继续下沉 shared：会更纯，但 `TerminalPage.tsx` 仍然是巨型状态与编排混合体
- 先改 server：与当前 app 主架构矛盾不在同一层级

因此，**本次审计的唯一正确整改起点就是 `TerminalPage.tsx`。**

---

## 11. 建议的后续动作

建议按以下顺序执行：

1. 为 `TerminalPage.tsx` 输出拆分蓝图（文件清单 + owner + 层次归属）
2. 先抽纯 helper（render keys / keyboard lift / copy selection）
3. 再抽 overlay/runtime hooks
4. 最后把 `TerminalPage.tsx` 收成壳
5. 完成后再回头统一 `session-context-*` 命名体系
6. 再做 shared 继续下沉与结构门禁

---

## 12. 审计总述（简版）

用一句话概括当前状态：

> 这套代码已经有了共享函数库，也已经有了 blocks，但“纯编排”还只完成了一半；真正还没收口的核心矛盾，不在 shared，不在 server，而在 `TerminalPage.tsx` 仍是巨型混合体。
# zterm Android 架构审计报告（共享函数库 + blocks + 纯编排）

- 日期：2026-05-24
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计主题：当前代码是否已经按照 **共享函数库 + blocks + 纯编排** 方式设计；若未完全达标，给出具体改进空间与优先级

---

## 1. 执行摘要

### 1.1 总结结论

当前代码库 **已经明显朝“共享函数库 + blocks + 纯编排”方向收口，但尚未完全达标**。

结论拆开看：

1. **共享函数库（shared library）**：已真实建立，而且有一部分做得比较好，特别是 `packages/shared/src/terminal/*` 与 `android/src/lib/*` 中一批纯函数、纯规则模块、纯 store。
2. **blocks 层**：已形成主体骨架，尤其是 `SessionContext` 周边已经从一个大 context 拆成一组 runtime / facade / assembly / transport / buffer / session 模块；open-tab、buffer store、render gate 也具备 block 雏形。
3. **纯编排（pure orchestration）**：仅部分达标。`App.tsx`、`SessionContext.tsx` 已明显朝薄壳编排收口；但 **`TerminalPage.tsx` 仍然严重偏离“纯编排”目标**，是本轮审计里最大的结构热点。

### 1.2 一句话判断

如果用你的三层铁律来判断：

```text
orchestration → blocks(唯一真源) → shared pure functions
```

当前状态是：

- **第三层（shared pure functions）**：最好
- **第二层（blocks）**：已成型，但有“过碎 + 胶水层偏厚”问题
- **第一层（orchestration）**：局部合格，但 terminal page 明显未收口

---

## 2. 审计范围与依据

### 2.1 审计依据文档

本次审计以以下真源文档与规则为依据：

- `AGENTS.md`
- `android/docs/architecture.md`
- `android/docs/ui-slices.md`
- `android/CACHE.md`
- `android/MEMORY.md`

其中与本次审计最相关的约束包括：

- 三层铁律：**编排 → blocks → 基础功能纯函数**
- 每个能力必须有且只有一个真源 owner
- 公共逻辑应下沉 shared / lib
- 页面壳、context 壳、server 入口应尽量只做编排，不做业务实现
- 单文件过大必须拆分，尤其 page / context / orchestration shell

### 2.2 本次实际检查的代码范围

重点查看了以下文件/模块：

#### App / Page / Context

- `android/src/App.tsx`
- `android/src/pages/TerminalPage.tsx`
- `android/src/pages/ConnectionsPage.tsx`
- `android/src/contexts/SessionContext.tsx`
- `android/src/contexts/session-context-*.ts`

#### Hook / Runtime / Open-tab

- `android/src/hooks/useOpenTabRuntime.ts`
- `android/src/hooks/useSessionOpenActions.ts`
- `android/src/hooks/useTerminalShellActions.ts`
- `android/src/hooks/useTerminalWorkspace.ts`

#### Shared / lib / store

- `android/src/lib/open-tab-intent.ts`
- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/terminal-width-mode-manager.ts`
- `packages/shared/src/terminal/*`
- `packages/shared/src/connection/*`

#### Server 侧

- `android/src/server/server.ts`
- `android/src/server/terminal-core-support.ts`
- `android/src/server/terminal-runtime.ts`
- `android/src/server/terminal-mirror-runtime.ts`

### 2.3 评估维度

本次不是做功能正确性审计，而是做 **结构与架构归属审计**，重点看：

1. 是否存在真实的共享函数真源
2. 是否存在明确的 block owner
3. 顶层文件是否已经只做编排
4. 是否存在跨层重复逻辑
5. 是否存在“文件拆了但语义没拆”的伪模块化

---

## 3. 当前���体架构判断

### 3.1 当前不是“没按三层设计做”，而是“做到一半以上，但未完全收口”

这点需要说清楚。

当前代码并不是传统那种：

- 所有逻辑塞进 `App.tsx`
- 所有 transport/buffer/session 混成一个 God object
- shared 只是空目录

相反，代码已经具备明显的结构收口迹象：

- `SessionContext.tsx` 已大幅变薄
- terminal planner 相关纯逻辑开始下沉到 `packages/shared`
- buffer/head/render gate 出现独立 store / runtime block
- server 入口开始把 helper 逻辑抽到 `terminal-core-support.ts`

所以这次审计的结论不是“推倒重来”，而是：

> 主体方向正确，但目前还停在“半收口状态”；最明显没收完的是 terminal page，以及一部分 session-context 周边 block 体系的层次稳定性。

---

## 4. 共享函数库（shared library）审计

### 4.1 结论

**这一层是当前最健康的一层。**

共享函数库已经不是口头目标，而是代码里真实存在的结构。

### 4.2 已经成立的共享函数真源

比较明显的例子：

#### terminal 纯规则/纯 planner

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/visible-range.ts`
- `packages/shared/src/terminal/buffer-sync-request-planner.ts`

这些模块基本符合共享函数库应有特征：

- 输入输出明确
- 不依赖 React 生命周期
- 不依赖 Android / Capacitor
- 不依赖 DOM 或 component state
- 可做精确单测
- 未来具备 client/server/mac 复用基础

#### Android 侧已形成的纯模块 / pure store

- `android/src/lib/open-tab-intent.ts`
- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/connections-server-groups.ts`
- `android/src/lib/terminal-width-mode-manager.ts`

这些文件不再是“页面里随手写的 util”，而是有清晰职责边界的模块。

### 4.3 共享函数库层做对了什么

1. **终端规则开始共享化**：terminal pull / gap repair / buffer head 推导不再全部散落在 app/page/context 中。
2. **纯状态容器被抽出**：`session-buffer-store.ts`、`session-render-gate.ts` 已经像真正的 block substrate。
3. **shared leaf import 意识存在**：项目内已经明确避免 server 直接 import `@zterm/shared` 根入口，而是 leaf module import。

这说明架构已经在朝“shared 只承载纯真相”方向演进。

### 4.4 共享函数库层仍然存在的问题

#### 问题 1：shared 覆盖面还不够彻底

虽然 `packages/shared/src/terminal/*` 已有不少 planner，但 Android 侧仍保留了一层较厚的 planner helper：

- `android/src/contexts/session-buffer-planner-helpers.ts`
- 部分 visible-range / request-window / repair 组合规则仍在 app 侧

这意味着 shared 虽然已经存在，但 **还没有成为所有纯规则的唯一沉淀点**。

#### 问题 2：shared 与 `android/src/lib` 的边界仍在演化中

当前模式是：

- 一部分纯逻辑进 `packages/shared`
- 一部分纯逻辑还在 `android/src/lib`

这本身不错误，但需要更明确的判断准则，否则未来容易出现：

- shared 一套 planner
- android lib 再包装一套 helper
- page/hook 再补一点临时规则

最终又形成“层层包裹的重复设计”。

### 4.5 shared 层结论

这一层 **必须继续增强**，而不是维持现状。因为它是当前最接近你目标、也最能稳定长期架构的一层。

---

## 5. blocks 层审计

### 5.1 结论

**blocks 主体已经形成，但仍存在“��很多、胶水也很多”的问题。**

换句话说，现在不是没有 block，而是：

- 有些 block 很真实
- 有些 block 更像 wiring 层
- 有些拆分更像“把大文件切开”，而不是“把真相 owner 切清楚”

### 5.2 已经较成熟的 block 类型

#### A. 状态 owner / store block

这类最成熟：

- `session-buffer-store.ts`
- `session-render-gate.ts`
- `session-head-store.ts`
- `session-viewport-mode-store.ts`

这些模块具备 block 的典型特征：

- 真相 owner 明确
- API 稳定
- 不依赖页面 JSX
- 不依赖具体 UI 生命周期
- 可被多个编排层消费

这是当前 blocks 层里最接近“唯一真源块”的部分。

#### B. open-tab 领域 block

这组也比较健康：

- `open-tab-intent.ts`
- `open-tab-persistence.ts`
- `open-tab-restore.ts`

原因：

- 已有 intent / persistence / restore 分层
- 当前 tabs 的持久化边界相对明确
- 没有继续让 `SessionContext` 或 page 去偷偷持久化 current tabs

#### C. server runtime block

server 侧也有比较明确的按能力块划分：

- `terminal-transport-runtime.ts`
- `terminal-control-runtime.ts`
- `terminal-schedule-runtime.ts`
- `terminal-mirror-runtime.ts`
- `terminal-core-support.ts`

这说明 server 侧已经有“按能力 owner 拆 block”的意识。

### 5.3 blocks 层存在的关键问题

#### 问题 1：`session-context-*` 体系有“过碎 + 中间胶水层偏厚”问题

当前文件群包括：

- `session-context-buffer-runtime.ts`
- `session-context-session-runtime.ts`
- `session-context-transport-runtime.ts`
- `session-context-transport-orchestration-runtime.ts`
- `session-context-transport-lifecycle-runtime.ts`
- `session-context-provider-assemblies.ts`
- `session-context-provider-core-assemblies.ts`
- `session-context-public-facade-runtime.ts`
- `session-context-message-assemblies.ts`
- 以及多组 infra/public/provider/facade/runtime

这说明模块确实拆了，但也出现了一个新问题：

> 真正的领域 block 和中间 wiring/assembly 层混在同一个命名宇宙里。

这样会导致维护者难以快速回答：

- 哪个文件是唯一 owner？
- 哪个文件只是把几个 owner 接起来？
- 哪个文件只是为了 React/provider 暴露 API？

#### 问题 2：block 名称更多反映“重构过程”，而不是“领域归属”

比如：

- `provider-runtime`
- `provider-assemblies`
- `infra-facade-runtime`
- `public-facade-runtime`
- `transport-control-orchestration-runtime`

它们不是错，但名字偏“演进轨迹”，不够像稳定的最终层次。

从长期维护看，这会让代码读者知道：

- 这个文件是后来拆出来的

却不一定知道：

- 这个文件在架构里 **唯一负责什么真相**

#### 问题 3：有些 block 本质其实是 orchestrator / assembly，不该和 owner block 等价看待

例如：

- `session-context-message-assemblies.ts`
- `session-context-provider-assemblies.ts`
- `session-context-transport-orchestration-runtime.ts`

这些文件的价值是“组合”，不是“持有某一领域真相”。

如果未来不把这类文件与真正 owner block 区分开，系统会继续扩张出更多“文件很多，但职责依旧难定位”的伪分层。

### 5.4 blocks 层结论

当前 blocks 层 **已成型，但需要第二轮“语义收口”**：

- 第一轮已经完成的是“把大文件拆开”
- 第二轮必须完成的是“把 block / facade / orchestrator / assembly 的角色彻底拉开”

---

## 6. orchestration（纯编排）层审计

### 6.1 结论

**这是当前最不稳定的一层。**

有的地方已经接近 pure orchestration；有的地方仍然明显超载。

---

### 6.2 `SessionContext.tsx`：基本合格

文件规模：

- `android/src/contexts/SessionContext.tsx` ≈ 298 行

该文件当前主要职责：

- 创建 reducer / refs
- 初始化 provider runtime
- 调用 assemblies / facade 构造上下文值
- 暴露稳定的 context API

它已经不再是一个几千行的 God context，而更像一个：

> Provider shell + orchestration facade

这基本符合“纯编排壳”的方向。

#### 结论

`SessionContext.tsx` 是当前客户端最接近“纯编排”的模块之一。

---

### 6.3 `App.tsx`：方向正确，但仍偏胖

`App.tsx` 目前已经不像传统意义上的大入口文件，优点包括：

- 页面切换由 page state 驱动
- host / bridge settings / open-tab / terminal shell / session open action 都通过 hook/runtime 注入
- `SessionProvider` 包裹清晰

但是问题也明显：

`AppContent` 仍然汇集了太多横切能力：

- app update runtime
- relay device stream / debug snapshot
- host storage / draft / shortcut / history storage
- open-tab runtime
- session open actions
- terminal shell actions
- picker sheet
- update modal

它虽然不像业务巨石，但已经很像一个 **应用总协调器**。

这在短期内可以接受，但从纯编排标准看，它仍有继续收口空间。

#### 结论

`App.tsx`：**基本合格，但建议继续拆成 AppShell runtime / App overlays / picker coordinator。**

---

### 6.4 `TerminalPage.tsx`：明确不合格，是当前最大结构热点

文件规模：

- `android/src/pages/TerminalPage.tsx` ≈ **3462 行**

这是本轮审计最明确的异常点。

当前 `TerminalPage.tsx` 同时承载：

- page render shell
- terminal header / tab chrome / quickbar / swipe surface / sheets 协调
- keyboard inset / viewport / top inset / layout profile 规则
- copy selection 状态机与 clipboard helper
- debug overlay runtime
- pane attach / multi-pane interaction
- saved tab list / session ui key / render key / input epoch key 等 identity helper
- 大量本地 runtime 状态与 effect

也就是说，它并不是：

```text
TerminalPage = orchestration shell
```

而更接近：

```text
TerminalPage = 页面壳 + 多个状态机 + 多个 helper 集合 + overlay 协调中心 + 交互逻辑中心
```

这直接违背了“page 只做纯编排”的目标。

#### 为什么这是唯一主热点

本轮看下来：

- shared 层已经有实质内容，不是主矛盾
- SessionContext 壳层已薄，不是主矛盾
- server.ts 已开始 support 抽离，不是主矛盾
- **TerminalPage 仍明显把本应下沉的块、状态机和 helper 扛在页面壳里**

所以它是当前“纯编排未达标”的唯一主热点。

---

## 7. 关键模块逐项审计

### 7.1 `useOpenTabRuntime.ts`

#### 评价

方向正确，但仍偏厚。

#### 优点

- open-tab truth 已经被明确为独立领域
- persistence / intent / restore 纯逻辑已下沉到 lib
- runtime 和 page state 的连接正在形成

#### 问题

当前这个 hook 同时承担：

- open tab runtime state
- foreground refresh/runtime effect
- restore/runtime sync
- active session 同步
- remote audit 触发
- page 可见性联动

这使它既像 block，又像 orchestrator，还像 hook 生命周期桥。

#### 建议

后续应进一步分成：

- open-tab runtime owner
- open-tab restore orchestrator
- foreground refresh runtime
- React facade hook

---

### 7.2 `useSessionOpenActions.ts`

#### 评价

像“用例层”雏形，但职责仍然偏混。

#### 当前混合内容

- picker mode / picker target / picker initial sessions
- open single / multiple tmux session
- open group session
- edit/save/delete server group
- clean session draft
- load saved tab list
- page state 跳转
- pane attach intent

这已经不是单纯 hook，而是一个 session-open 用例编排器。

#### 问题

目前它还没有彻底声明自己是“用例编排层”，因此内部同时混入了：

- UI state
- open action domain logic
- navigation coordination

#### 建议

拆成：

- picker ui state coordinator
- session open use case orchestrator
- saved-tab/group 操作 use case

---

### 7.3 `useTerminalShellActions.ts`

#### 评价

相对健康，接近 orchestration facade。

它主要是把：

- sendInput
- updateViewport
- sendResize
- draft/send quick action
- shortcut frequency

做成 terminal shell 可消费的动作集合。

#### 问题

不算主问题，但后续如果 terminal shell 行为继续膨胀，应警惕这个 hook 重新变成行为巨石。

#### 建议

保持它只做 shell action facade，不要继续吸收更多 terminal runtime 规则。

---

### 7.4 `session-buffer-store.ts`

#### 评价

这是当前很标准的 block substrate。

#### 做得对的地方

- snapshot / subscribe / set / commit / delete 边界清晰
- 不依赖 React state 作为主真相
- 可独立测试
- 与 `useSyncExternalStore` 对接合理

#### 结论

这类模块就是“blocks 基础设施”的正确示范，应继续推广这种模式。

---

### 7.5 `session-render-gate.ts`

#### 评价

也是比较健康的 block。

它承担的是真正的 render projection gate：

- live buffer → projected render buffer
- row reuse / gap reuse / cursor reuse
- 定时 flush / dirty reflush

#### 价值

它把 “buffer 真相” 与 “renderer 可消费投影” 拉开了。

这正符合你强调的：

- source truth 与 consumer truth 解耦
- UI 不得直接改 source

#### 结论

这是当前结构里比较成熟的一块，可视为 block 设计的正例。

---

### 7.6 `server.ts` 与 `terminal-core-support.ts`

#### 评价

server 侧比 terminal page 更接近“薄入口 + support blocks”。

#### 证据

- `server.ts` ≈ 399 行
- `terminal-core-support.ts` ≈ 109 行
- 并有专门 truth gate：`server.core-support-truth.test.ts`

#### 做对了什么

- `server.ts` 不再自己内联 terminal helper 实现
- normalization / session-name sanitize / mirror key / buffer-sync request normalize 被抽到 support 模块

#### 还不够的地方

- 这个思路还可以继续：如果 server.ts 后续继续增长，应持续把 helper/support 侧分离
- `terminal-core-support.ts` 是对的，但它仍只是第一步；未来还可以继续按 domain helper 细分

#### 结论

server 侧方向正确，目前不是最优先痛点。

---

## 8. 结构问题归类

### 8.1 已完成的结构收口

这部分值得明确肯定：

1. `SessionContext` 已薄化
2. terminal 纯规则开始 shared 化
3. open-tab 领域已有独立真源模块
4. buffer/head/render gate/store 已 block 化
5. server 入口已开始 support 抽离

### 8.2 尚未完成的结构收口

当前还未收好的部分主要有三类：

#### A. 页面壳仍背业务与状态机

典型：`TerminalPage.tsx`

#### B. block 与 assembly/orchestration/facade 命名体系不稳定

典型：`session-context-*`

#### C. shared 与 app-lib 的真源边界还未彻底冻结

典型：terminal planner 仍有部分 Android 侧 helper 包装层

---

## 9. 改进空间与优先级

下面给出完整整改优先级。

---

### P0：立即处理 `TerminalPage.tsx`，把它收成真正纯编排壳

#### 为什么是最高优先级

因为它是当前整个代码库里最明确违反“纯编排”原则的主热点。

不是因为它大，而是因为它承担了不该由 page 承担的东西：

- 状态机
- helper
- overlay runtime
- selection/copy 规则
- keyboard/layout 规则
- identity key 规则

#### 建议拆分方向

不是按 JSX 视觉组件拆，而是按职责真相拆：

1. `terminal-copy-selection.ts`
   - 复制选择状态与 buffer->plainText 规则
   - clipboard 写入 helper

2. `terminal-keyboard-lift.ts`
   - keyboard lift / viewport / top inset / layout viewport 纯规则

3. `terminal-page-render-keys.ts`
   - renderedSessionUiKey / headerUiKey / inputEpochKey 等 identity helper

4. `useTerminalPageOverlayState.ts`
   - schedule / file transfer / screenshot / tab manager / debug overlay 开关状态

5. `useTerminalPageInteractionRuntime.ts`
   - interactive session / pane attach / tab switch / current chrome interaction

6. `TerminalPage.tsx`
   - 最终只做：组合 hooks + stage + header + quickbar + overlays render

#### 目标

目标不是简单减行数，而是把它变成：

> “只看文件结构就能确定这是 orchestration shell，而不是业务实现中心。”

---

### P1：稳定 `session-context-*` 分层命名，压缩胶水层

#### 问题本质

现在的问题不是没拆，而是拆得太像“工程过程产物”。

#### 建议固定 5 类命名角色

1. `*-store.ts`
  - 真相状态 owner

2. `*-rules.ts` / `*-planner.ts`
  - 纯决策函数

3. `*-runtime.ts`
  - 单领域执行块，有状态，无 UI

4. `*-orchestrator.ts`
  - 组合多个 runtime/store/rules

5. `*-facade.ts`
  - 给 React/context/page 暴露薄 API

#### 目标

让读代码的人可以快速回答：

- 这是 owner 块
- 这是纯规则
- 这是编排器
- 这是对外 facade

而不是继续靠 `provider/public/infra/assembly/runtime/facade` 的组合词去猜。

---

### P2：继续把 terminal planner / normalization 纯逻辑下沉到 `packages/shared`

#### 下沉判断准则

凡是满足以下条件者，优先下沉：

- 不依赖 React
- 不依赖 DOM / browser / Capacitor
- 不依赖 Android runtime
- 输入输出是纯数据
- future mac/server/client 可能复用

#### 候选方向

- visible-range request planning 的组合规则
- buffer sync request 参数归一化规则
- repair 窗口与 missing ranges 规则
- session identity / request identity 中的纯推导规则

#### 目标

让 block 真正只做编排，而不是继续在 Android 侧残留一层“planner helper 业务包装”。

---

### P3：把大 hook 从“领域真相 + 编排混合体”继续拆分

重点对象：

- `useOpenTabRuntime.ts`
- `useSessionOpenActions.ts`
- `useTerminalWorkspace.ts`

#### 问题本质

这些 hook 现在太像：

> React 生命周期容器 + 领域 runtime + use-case orchestration 的混合层

#### 建议目标

- runtime 真相下沉到独立 block
- hook 只负责接 React 生命周期
- use-case orchestration 独立命名

---

### P4：补结构门禁，而不是只靠人工记忆

当前已有 truth tests，这是对的，但还不够。

建议新增结构门禁：

#### 1. 文件大小门禁

对 page/context/server shell 设置软硬阈值，例如：

- `TerminalPage.tsx > 800` 报警
- `App.tsx > 500` 报警
- `SessionContext.tsx > 400` 报警

#### 2. forbidden import 门禁

例如：

- server 禁止 import `@zterm/shared` root
- shared 禁止 import React / Capacitor / browser APIs
- page 层禁止越级 import 深层 transport runtime

#### 3. truth owner 门禁

对 open-tab / terminal buffer / transport / session history 等领域建立 owner 清单与 forbidden duplicate implementation 检查。

---

## 10. 最终审计结论

### 10.1 是否已经按照“共享函数库 + blocks + 纯编排”设计？

**结论：部分达标，未完全达标。**

更精确地说：

#### 已达标部分

- 共享函数库已经真实存在
- blocks 主体骨架已形成
- SessionContext 壳层明显薄化
- server 入口已开始 support 抽离

#### 未达标部分

- TerminalPage 仍明显不是纯编排
- session-context 周边 block / facade / assembly / orchestrator 角色还没彻底稳定
- shared 与 android lib 的纯规则真源边界还需要继续冻结

---

### 10.2 本轮唯一主热点

如果按“下一步唯一主目标”来定，不是泛泛的“继续优化架构”，而是：

> **唯一主目标：把 `android/src/pages/TerminalPage.tsx` 收成真正的纯编排壳。**

原因：

- shared 已经有实质内容，不是主矛盾
- SessionContext 壳层已较薄，不是主矛盾
- server.ts 已有 support 抽离，不是主矛盾
- **只有 TerminalPage 仍明显同时持有编排、状态机、helper 与交互控制，直接破坏三层铁律**

这就是为什么它是当前最该动刀的唯一核心点。

---

## 11. 审计后建议执行顺序

### 第一阶段

1. 拆 `TerminalPage.tsx`
2. 把 terminal page 内的 helper / overlay / selection / keyboard 规则下沉
3. 建 page-shell 文件大小门禁

### 第二阶段

4. 统一 `session-context-*` 命名层次
5. 区分 owner block / facade / orchestrator / assembly
6. 压缩中间胶水层

### 第三阶段

7. 继续把 terminal planner 纯逻辑下沉 shared
8. 为 shared/app-lib/page/server 建 import gate
9. 为 truth owner 建结构门禁

---

## 12. 报告落点

这份报告的最终判断不是“当前架构不行”，而是：

> 架构主方向是对的，shared 与 block 基座已经出现；现在差的不是推翻重做，而是**把最后几个明显未收口的大壳收干净，并把 block 层的角色命名彻底稳定下来**。

在所有改进项里，`TerminalPage.tsx` 是最优先、也最唯一的主修点。
# zterm Android 架构审计报告（共享函数库 + blocks + 纯编排）

- 日期：2026-05-24
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计主题：当前代码是否按照“共享函数库 + blocks + 纯编排”的方式设计，以及后续改进空间
- 审计方式：静态代码审查（read-only），结合项目架构文档与关键源码抽样

## 1. 审计结论

**结论：当前仓库已经明显朝“共享函数库 + blocks + 纯编排”方向收口，但尚未完全达标。**

分项判断：

1. **共享函数库（shared pure functions / leaf modules）**：**已建立，且部分质量较高**。
2. **blocks（唯一真源块 / store / runtime / planner）**：**已形成主体框架**，尤其 Session / terminal / open-tab / server runtime 方向已出现清晰 owner。
3. **纯编排（page / app / provider 只做 orchestration）**：**仅部分成立，未彻底成立**。

当前最大偏差点不是 shared 层，也不是 server 入口，而是：

- `android/src/pages/TerminalPage.tsx` 仍然是一个超大复合页，混合了页面编排、UI 状态机、overlay 控制、clipboard/copy 逻辑、keyboard/viewport 逻辑、sheet 协调、debug overlay 等多类职责；
- `session-context-*` 虽然已经拆成很多块，但命名层级与块边界仍有“文件拆了，语义还没完全稳定”的现象；
- 一部分本应继续下沉到 shared 的 terminal planner / normalization / identity 纯逻辑，仍停留在 Android app 侧 helper 层。

因此，当前更准确的评价不是“未做架构化”，而是：

> **架构迁移方向正确，shared 与 block 基座已经建立，但纯编排层尚未完全收口，局部仍存在重 orchestrator / 厚 page / 胶水层过多的问题。**

---

## 2. 审计依据

本次审计主要基于以下真源与代码：

### 2.1 文档真源

- `AGENTS.md`
- `android/docs/architecture.md`
- `android/docs/ui-slices.md`
- `android/CACHE.md`
- `android/MEMORY.md`

### 2.2 抽样代码范围

重点审查了以下模块：

- app / page 层
  - `android/src/App.tsx`
  - `android/src/pages/ConnectionsPage.tsx`
  - `android/src/pages/ConnectionPropertiesPage.tsx`
  - `android/src/pages/TerminalPage.tsx`
  - `android/src/pages/SettingsPage.tsx`

- session / context / orchestration 层
  - `android/src/contexts/SessionContext.tsx`
  - `android/src/contexts/session-context-*.ts`
  - `android/src/hooks/useOpenTabRuntime.ts`
  - `android/src/hooks/useSessionOpenActions.ts`
  - `android/src/hooks/useTerminalShellActions.ts`

- local shared / leaf / store 层
  - `android/src/lib/session-buffer-store.ts`
  - `android/src/lib/session-render-gate.ts`
  - `android/src/lib/open-tab-intent.ts`
  - `android/src/lib/connections-server-groups.ts`
  - `android/src/lib/terminal-width-mode-manager.ts`
  - 以及 `android/src/lib/*` 其他叶子模块

- monorepo shared 层
  - `packages/shared/src/terminal/*`
  - `packages/shared/src/connection/*`
  - `packages/shared/src/layout/*`

- daemon / server 层
  - `android/src/server/server.ts`
  - `android/src/server/terminal-core-support.ts`
  - `android/src/server/terminal-runtime.ts`
  - `android/src/server/terminal-mirror-runtime.ts`

---

## 3. 审计标准

本次按以下结构目标审计：

```text
编排层（App / Page / Provider / Shell）
    ↓ 只做 orchestration，不承载领域实现
blocks 层（runtime / store / planner / owner modules）
    ↓ 每块有明确唯一责任
共享函数库层（shared pure functions / leaf modules）
    ↓ 纯函数、纯数据转换、纯规则、跨端可复用
```

核心判断问题：

1. 是否已经形成**共享函数库真源**。
2. 是否已经形成**block owner 与真源边界**。
3. 顶层 page/context/server 是否已经**纯编排化**。
4. 是否存在**跨层重复逻辑**、**二次包装**、**命名层级漂移**。
5. 是否存在“拆了文件但没有拆语义”的假模块化。

---

## 4. 总体评价

### 4.1 已经做对的部分

#### 4.1.1 shared 纯函数层已经真实存在

这是当前架构里最健康的一层之一。

关键证据：

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/buffer-sync-request-planner.ts`
- `packages/shared/src/terminal/visible-range.ts`
- `packages/shared/src/layout/profile.ts`
- `packages/shared/src/connection/*`

这些模块具备典型 shared leaf 特征：

- 输入输出明确；
- 无 React 生命周期依赖；
- 无 UI 语义；
- 无 Android / Capacitor 运行时依赖；
- 可单测；
- 有跨 client / server / future platform 复用潜力。

这说明仓库已经不再是“所有规则都堆在 app 里”，而是真正在建设共享函数库。

#### 4.1.2 SessionContext 外壳已明显薄化

关键证据：

- `android/src/contexts/SessionContext.tsx` 当前仅约 298 行；
- 真正能力被下沉到：
  - `session-context-provider-runtime.ts`
  - `session-context-provider-assemblies.ts`
  - `session-context-public-facade-runtime.ts`
  - `session-context-session-runtime.ts`
  - `session-context-transport-runtime.ts`
  - `session-context-buffer-runtime.ts`
  - `session-context-socket-message-runtime.ts`
  - `session-context-transport-orchestration-runtime.ts`

这代表当前 Context 外层已经比较接近“Provider 壳 + 运行时装配 + facade 暴露”的结构，而不是一个数千行的 God object。

#### 4.1.3 部分状态真相已从 React state 迁移到独立 store / runtime

关键证据：

- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/session-head-store.ts`
- `android/src/lib/session-viewport-mode-store.ts`

这些模块说明：

- buffer truth、render commit、head truth、viewport mode truth 已经不完全依赖组件本地 state；
- 真相正从页面 effect 中剥离到可复用、可订阅、可独立验证的 block/store。

这是一种真正有价值的 blocks 化，不是仅仅把代码拆文件。

#### 4.1.4 open-tab 方向已经有较清晰的 truth slice

关键证据：

- `android/src/lib/open-tab-intent.ts`
- `android/src/lib/open-tab-persistence.ts`
- `android/src/lib/open-tab-restore.ts`
- `android/src/hooks/useOpenTabRuntime.ts`

open-tab 这一块已经明显形成：

- 纯规则模块；
- 持久化 owner；
- restore/runtime sync 逻辑；
- page/shell 的使用入口。

这是比较符合“一个能力一组唯一真源块”的。

#### 4.1.5 server 入口已经开始做 thin glue 化

关键证据：

- `android/src/server/server.ts` 约 399 行；
- `android/src/server/terminal-core-support.ts` 已把 terminal helper 从 `server.ts` 抽离；
- 配套存在 `server.core-support-truth.test.ts` 作为结构门禁。

说明 server 侧也在朝：

- entry 只做装配；
- helper / support 独立成块；
- 防止逻辑重新回灌入口文件。

这条方向是正确的。

---

### 4.2 当前主要问题

#### 4.2.1 `TerminalPage.tsx` 明显不符合“纯编排”

这是当前最突出的架构问题。

关键证据：

- `android/src/pages/TerminalPage.tsx`：**3462 行**

���代码内容看，它同时承担了：

- 页面结构编排；
- session chrome / tab chrome / pane chrome；
- keyboard inset / viewport / layout 计算；
- copy mode / selection / clipboard 逻辑；
- debug overlay；
- quick bar shell；
- tab manager sheet / schedule sheet / screenshot sheet / file transfer sheet；
- pane attach intent 处理；
- 多个 render key / reset key / session key helper；
- 一批 UI helper、buffer selection helper、clipboard helper。

因此它不是一个纯 orchestrator，而是一个：

> **页面 + 状态机 + overlay coordinator + helper 集合 + 多 sheet manager 的混合体**。

这与“page 只做编排”目标不一致。

#### 4.2.2 `session-context-*` 已拆很多块，但层级有过碎和命名漂移问题

当前 SessionContext 相关模块包括：

- `*-runtime.ts`
- `*-orchestration-runtime.ts`
- `*-lifecycle-runtime.ts`
- `*-provider-assemblies.ts`
- `*-public-facade-runtime.ts`
- `*-infra-facade-runtime.ts`

这说明系统已经在拆，但也暴露出两个问题：

1. **中间胶水层过多**：assembly / facade / orchestration / runtime 之间存在多层转发；
2. **命名层级不稳定**：文件名更多反映“重构过程中的拆分轨迹”，而不是最终稳定的领域结构。

风险是：

- 维护者难以快速判断某条规则的唯一 owner 在哪里；
- 随着需求增长，可能继续长出“再包一层”的结构；
- 形成“看起来很模块化，实际上责任面仍重叠”的伪清晰。

#### 4.2.3 大 hook 仍然混合了真源逻辑与编排行为

典型文件：

- `android/src/hooks/useOpenTabRuntime.ts`（约 478 行）
- `android/src/hooks/useSessionOpenActions.ts`（约 485 行）
- `android/src/hooks/useTerminalWorkspace.ts`（约 601 行）

这些文件不是简单的 React adapter，而仍混合：

- runtime truth 管理；
- UI / page effect；
- storage / restore；
- navigation / shell coordination；
- session actions；
- foreground refresh 行为。

这类 hook 现在更像“领域 runtime + hook 外壳”混合体，尚未完全变成薄编排层。

#### 4.2.4 shared 与 Android `src/lib` 的边界尚未彻底冻结

现状是：

- 一部分 terminal planner 已进入 `packages/shared/src/terminal/*`；
- 但 Android 侧仍保留 `session-buffer-planner-helpers.ts` 等 planner helper 包装层；
- 部分 visible-range / request-window / repair 逻辑仍停留在 app 侧。

这本身不一定错误，但说明 shared 真源还未完全收拢完毕。

长期风险：

- shared 里一套 planner；
- Android helper 里再包一层 planner；
- 上层 runtime 再补一点“只在 app 才有”的判断；
- 最后又形成跨层重复逻辑。

---

## 5. 分层审计结果

### 5.1 Shared 函数库层

#### 结论

**整体良好，是当前最健康的层之一。**

#### 优点

1. 已经存在明确的 terminal 纯规则模块；
2. 具有跨端复用价值；
3. 大多是纯输入/纯输出，不依赖 React；
4. 已有配套测试；
5. 与项目“共享函数化/模块化”的偏好一致。

#### 问题

1. 覆盖面还不够彻底，terminal planner 仍有 Android 侧 helper 包装残留；
2. shared 作为“只放 pure leaf truth”的边界，还需要更明确的结构门禁和 import 规则；
3. 一些 identity / normalization / viewport 纯逻辑还没有完全归并到 shared。

#### 评价

这层不应回退，应该继续扩大 shared 的 terminal / session 纯规则覆盖面。

---

### 5.2 blocks 层

#### 结论

**已形成主体框架，但块边界仍需收口。**

#### 做得较好的 block 类型

##### a. store / truth holder 类

- `session-buffer-store.ts`
- `session-render-gate.ts`
- `session-head-store.ts`
- `session-viewport-mode-store.ts`

这类模块具备比较明确的 owner 与责任边界。

##### b. open-tab truth slice

- `open-tab-intent.ts`
- `open-tab-persistence.ts`
- `open-tab-restore.ts`

这是当前比较像“完整能力真源块”的一组实现。

##### c. server runtime / support block

- `terminal-core-support.ts`
- `terminal-mirror-runtime.ts`
- `terminal-transport-runtime.ts`
- `terminal-control-runtime.ts`
- `terminal-schedule-runtime.ts`

server 侧拆块的语义整体比 client 更接近稳定结构。

#### block 层主要问题

##### 问题 1：存在很多“编排块”，但命名上与真源块混在一起

例如：

- `session-context-message-assemblies.ts`
- `session-context-provider-assemblies.ts`
- `session-context-transport-orchestration-runtime.ts`

这些文件的本质更偏：

- wiring；
- orchestration；
- 组合器；
- facade builder。

它们不应与真正的 store / planner / runtime truth owner 混成一个认知层级，否则结构会显得“块很多”，但难以回答“唯一 owner 究竟是谁”。

##### 问题 2：块命名不稳定

当前并存：

- runtime
- orchestration-runtime
- lifecycle-runtime
- provider-assemblies
- public-facade-runtime
- infra-facade-runtime

这会抬高维护认知成本。

##### 问题 3：部分 block 更像按重构历史拆，而非按领域真相拆

也就是说，当前的结构能体现“曾经从大文件中拆出来”，但未必已经达到“未来长期稳定的唯一职责结构”。

---

### 5.3 编排层

#### 结论

**这是当前最弱的一层。**

#### `App.tsx`

评价：**基本合格，但偏胖。**

它已经像一个 app shell，但仍聚合了过多横切职责：

- app update；
- relay debug；
- host storage；
- session runtime；
- open tab runtime；
- terminal shell actions；
- picker sheet；
- update modal。

目前还能接受，但如果继续增长，容易重新膨胀。

#### `SessionContext.tsx`

评价：**基本符合纯编排 / 薄 facade 目标。**

这是客户端当前最接近 pure orchestration shell 的模块之一。

#### `TerminalPage.tsx`

评价：**明确不合格。**

它当前是整个 Android 前端里最明显违背“纯编排”目标的热点。

---

## 6. 关键证据

### 6.1 纯编排未达标的最大证据

- `android/src/pages/TerminalPage.tsx`：**3462 行**

这已经超出“正常 page shell”范畴，直接说明 terminal page 尚未完成结构收口。

### 6.2 SessionContext 外壳已薄化

- `android/src/contexts/SessionContext.tsx`：约 **298 行**

这证明 context 壳层收口方向是正确的。

### 6.3 Session runtime 体系已形成，但块仍较厚

关键体量：

- `session-context-buffer-runtime.ts`：约 **778 行**
- `session-context-session-runtime.ts`：约 **524 行**
- `session-context-transport-runtime.ts`：约 **494 行**
- `session-context-provider-core-assemblies.ts`：约 **417 行**
- `session-context-transport-orchestration-runtime.ts`：约 **461 行**

说明问题不是“没拆”，而是“拆了，但仍有厚块与胶水块”。

### 6.4 shared terminal planner 已真实存在

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`

说明“共享函数库”已不是口头目标，而是已有落地事实。

### 6.5 server.ts 已开始 support 抽离

- `android/src/server/server.ts`：约 **399 行**
- `android/src/server/terminal-core-support.ts`：约 **109 行**
- `android/src/server/server.core-support-truth.test.ts`

说明 server 入口正在向 thin glue 模式收口。

---

## 7. 模块级审计意见

### 7.1 `android/src/App.tsx`

#### 评价

**基本合格，偏胖。**

#### 已符合点

- 页面切换壳已存在；
- 主要功能来自 hooks / runtime / lib；
- 没有直接把所有业务实现重新塞回一个大文件。

#### 问题

- 横切能力装配较多；
- global modal / picker / app update / relay debug 等都集中在此；
- 长期有再次膨胀风险。

#### 改进建议

- 拆出 `useAppShellRuntime`；
- 拆 `AppGlobalOverlays` / `AppGlobalSheets`；
- 让 `App.tsx` 更接近“路由壳 + 全局依赖注入”。

---

### 7.2 `android/src/contexts/SessionContext.tsx`

#### 评价

**当前结构整体正确，是一个相对成功的薄壳收口点。**

#### 已符合点

- provider 仅做 reducer / refs / runtime / facade 装配；
- context value 暴露接口稳定；
- 实际行为已下沉到具体 runtime 模块。

#### 问题

- 下游层级命名过多；
- assembly / runtime / facade 还可再进一步稳定边界。

#### 改进建议

- 收紧命名体系；
- 压缩中间胶水层数量；
- 将“真正领域 owner”与“组合器”在命名上分离。

---

### 7.3 `android/src/pages/TerminalPage.tsx`

#### 评价

**当前最需要动刀的文件。**

#### 主要问题

- 同时承担 UI 编排、交互状态机、overlay 管理、copy/debug/keyboard helper；
- 严重违反“纯编排”；
- 文件体积远超项目结构上限预期；
- 后续任何 terminal 功能增量都容易继续加重耦合。

#### 结论

若要继续推进“共享函数库 + blocks + 纯编排”，**第一优先级必须是 TerminalPage 收口**。

---

### 7.4 `android/src/hooks/useOpenTabRuntime.ts`

#### 评价

**方向正确，但仍偏厚。**

#### 已符合点

- open-tab truth 已形成相对清晰 slice；
- restore / persistence / intent 已有叶子模块；
- 不是所有规则都塞在 page 中。

#### 问题

- foreground refresh、runtime sync、page coordination 仍混在一个 hook 文件里；
- hook 还不是单纯 React adapter。

#### 改进建议

- 拆出 open-tab runtime store / restore orchestrator / foreground runtime；
- hook 只保留 React 生命周期接入和 facade 暴露。

---

### 7.5 `android/src/hooks/useSessionOpenActions.ts`

#### 评价

**像一个用例编排层，但边界仍然偏厚。**

#### 问题

- picker UI state、group edit、saved-tab 导入、session open action、page navigation 混合；
- 文件体现的是“功能方便集中”，而不是“领域 owner 稳定”。

#### 改进建议

- 把 picker UI state 与 domain action 分离；
- 明确其定位为“session open use-case orchestrator”，而不是继续吸收真源逻辑。

---

### 7.6 `packages/shared`

#### 评价

**这是当前最值得继续扩大的正确方向。**

#### 建议

- 继续吸收 terminal planner / normalization / identity / viewport 纯逻辑；
- 明确 shared 根入口与 leaf import 规范；
- 补 import 门禁，禁止 shared 反向长出平台依赖。

---

### 7.7 daemon / server 侧

#### 评价

**比 client 更接近“薄入口 + blocks”结构。**

#### 已符合点

- `server.ts` 规模可控；
- support / runtime 已开始抽出；
- 有 truth test 防止逻辑回流入口。

#### 问题

- 若继续增长，`server.ts` 仍有再次变厚风险；
- support/helper 仍可继续按能力拆 leaf truth。

#### 建议

- 坚持 `server.ts` 只做装配；
- 类似 `terminal-core-support.ts` 的 support block 可以继续推广到其他 helper 热点。

---

## 8. 改进空间与整改优先级

### P0：优先级最高 —— 收口 `TerminalPage.tsx`

这是当前最明确的主问题。

#### 为什么必须先做

因为：

- shared 层已经存在，不是主矛盾；
- SessionContext 外壳已薄化，不是主矛盾；
- server 入口已开始 support 抽离，不是主矛盾；
- **唯独 TerminalPage 仍直接承载大量非编排职责，是当前最明显的结构反例。**

#### 建议拆法

第一轮不要先按 JSX 组件拆，而应按职责块拆：

1. `terminal-page-render-keys.ts`
  - session/ui key helper
  - reset key / header key / identity helper

2. `terminal-copy-selection.ts`
  - copy selection state
  - buffer range -> plain text
  - selection buffer resolve
  - clipboard helper

3. `terminal-keyboard-lift.ts`
  - keyboard inset / viewport / top inset / layout height helper

4. `useTerminalPageOverlayRuntime.ts`
  - schedule / screenshot / transfer / tab-manager 等 overlay open-close state

5. `useTerminalPageInteractionRuntime.ts`
  - interactive session / pane attach / selection mode / quickbar interaction

6. `TerminalPage.tsx`
  - 最终只保留 orchestration：
    - 读 props
    - 组合 hook
    - 渲染 stage / chrome / overlays

#### 目标

不是简单把 3462 行拆成几个文件，而是让 `TerminalPage.tsx` **语义上真正变成纯编排壳**。

---

### P1：稳定 `session-context-*` 命名与分层

建议收敛到 5 类固定命名：

1. `*-store.ts`
  - 状态真源块

2. `*-rules.ts` / `*-planner.ts`
  - 纯规则块

3. `*-runtime.ts`
  - 单领域执行块（可有状态，无 UI）

4. `*-orchestrator.ts`
  - 组合多个 runtime/store/rules

5. `*-facade.ts`
  - 对 React/context/page 暴露的薄接口

不建议继续扩张这类混合命名：

- `provider-assemblies`
- `infra-facade-runtime`
- `public-facade-runtime`
- `transport-control-orchestration-runtime`

它们不是不能存在，但长期会抬高结构理解门槛。

---

### P2：继续把 Android 侧 planner helper 下沉到 `packages/shared`

判定标准：只要逻辑同时满足以下条件，就应优先下沉：

1. 不依赖 React；
2. 不依赖浏览器 API；
3. 不依赖 Capacitor / Android；
4. 输入输出是纯数据；
5. Mac / daemon / future client 有复用潜力。

重点关注：

- `session-buffer-planner-helpers.ts`
- visible-range / request-window / repair decision helper
- session identity / normalization helper

---

### P3：把大 hook 进一步拆成 runtime block + React facade

重点对象：

- `useOpenTabRuntime.ts`
- `useSessionOpenActions.ts`
- `useTerminalWorkspace.ts`

目标结构：

- 领域 runtime / store / planner 在 hook 外；
- hook 只做：
  - React 生命周期接入；
  - ref 管理；
  - facade 暴露；
  - page shell 事件桥接。

这样才是真正的“hook 是 adapter，不是大杂烩 owner”。

---

### P4：补结构门禁，不再只靠人工自觉

建议增加：

#### 1. 文件体积门禁

对 page / context / server entry 设上限告警，例如：

- `TerminalPage.tsx > 800` 报警
- `App.tsx > 500` 报警
- `SessionContext.tsx > 400` 报警

#### 2. import 门禁

例如：

- server 侧禁止 import `@zterm/shared` root；
- page 层禁止直连 transport deep runtime；
- `packages/shared` 禁止 import React / Capacitor / browser APIs。

#### 3. owner truth 门禁

为 open-tab / session transport / terminal buffer 等能力维护 owner 列表与 forbidden duplicate implementation 检查。

---

## 9. 最终判定

### 9.1 是否“已经按照共享函数库 + blocks + 纯编排”的方式设计？

**判定：部分达标，未完全达标。**

更准确地说：

#### 已达标的部分

- 共享函数库：已明确建立；
- blocks：已形成主体框架；
- SessionContext / server 入口已明显朝薄壳收口。

#### 未达标的部分

- `TerminalPage.tsx` 尚未纯编排化；
- session-context 周边块边界仍需稳定；
- shared 与 Android helper 的规则分层仍未完全冻结。

---

## 10. 唯一主问题与唯一下一步

按当前证据链，本轮审计的**唯一主问题**是：

> **`android/src/pages/TerminalPage.tsx` 仍不是纯编排壳，而是当前架构中最明显的职责混合点。**

这是唯一主问题的原因：

- shared 层已经有真材实料，不是主矛盾；
- SessionContext 壳层已薄化，不是主矛盾；
- server 入口已开始 thin glue 化，不是主矛盾；
- 只有 `TerminalPage.tsx` 还在同时持有编排、状态机、helper、overlay、sheet 协调等多类职责，直接违背目标结构。

因此，若只选一个下一步目标，应该是：

> **先把 `TerminalPage.tsx` 收成真正的纯编排壳，再继续统一 blocks / shared 边界。**

---

## 11. 建议的执行顺序

1. 先重构 `TerminalPage.tsx`
2. 再稳定 `session-context-*` 分层命名
3. 再把 Android terminal planner helper 继续下沉到 `packages/shared`
4. 最后补结构门禁（文件体积 / import / truth owner）

---

## 12. 审计总结（简版）

- **改了什么**：本次未改业务代码，只完成结构审计，并形成书面报告。
- **如何验证**：依据项目文档真源 + 关键模块源码抽样 + 文件规模与模块职责分析。
- **当前风险**：TerminalPage 仍是主要结构债；session-context 命名层次仍有胶水层过厚问题。
- **下一步**：以 `TerminalPage.tsx` 为第一优先级做纯编排收口。
# zterm Android 架构审计报告（共享函数库 + blocks + 纯编排）

- 日期：2026-05-24
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计目标：判断当前代码是否已经按 **共享函数库 + blocks + 纯编排** 的方式设计，并给出可执行的改进空间
- 审计依据：
  - `AGENTS.md`
  - `android/docs/architecture.md`
  - `android/docs/ui-slices.md`
  - `android/src/App.tsx`
  - `android/src/pages/TerminalPage.tsx`
  - `android/src/contexts/SessionContext.tsx`
  - `android/src/contexts/session-context-*.ts`
  - `android/src/hooks/useOpenTabRuntime.ts`
  - `android/src/hooks/useSessionOpenActions.ts`
  - `android/src/hooks/useTerminalShellActions.ts`
  - `android/src/lib/*`
  - `packages/shared/src/*`
  - `android/src/server/server.ts`
  - `android/src/server/terminal-core-support.ts`

## 一、执行摘要

**结论：当前代码库已经明显朝“共享函数库 + blocks + 纯编排”方向收口，但还没有完全达标。**

分项判断：

1. **共享函数库：已成立，且方向正确。**
   - `packages/shared/src/terminal/*`、`packages/shared/src/connection/*`、`android/src/lib/*` 中已经存在一批真实的纯函数/纯 store/纯 planner 真源。
2. **blocks：已形成主体框架。**
   - 尤其是 `SessionContext` 周边、open-tab 体系、server runtime/support 体系，已经从大文件收口到多模块协作。
3. **纯编排：局部成立，但未完全成立。**
   - `SessionContext.tsx` 基本已接近纯编排壳。
   - `App.tsx` 大体是 app-shell 编排，但仍偏胖。
   - `TerminalPage.tsx` 明显仍不是纯编排，仍是当前最大的结构性热点。

**唯一主结论**：

> 当前最关键、最唯一、最该优先处理的架构问题，不是 shared 层，也不是 server 侧，而是 `android/src/pages/TerminalPage.tsx` 仍未收口成纯编排壳。

---

## 二、审计标准

本次按以下三层铁律审计：

```text
orchestration / 纯编排层
    ↓
blocks / 唯一真源块
    ↓
shared pure functions / stores / leaf modules
```

核心判断问题：

1. 公共逻辑是否已经下沉到共享函数库
2. 每个关键能力是否已有相对明确的 block owner
3. 顶层 page / context / server entry 是否主要只做编排
4. 是否仍存在跨层重复逻辑
5. 是否出现“文件拆了但语义没拆”的伪模块化

---

## 三、总体判断

### 3.1 已做对的方向

#### 3.1.1 shared 纯函数层已经真实存在

这不是口头上的“以后可以抽”，而是已经有实物：

- `packages/shared/src/terminal/buffer-sync-planner.ts`
- `packages/shared/src/terminal/gap-repair-planner.ts`
- `packages/shared/src/terminal/buffer-head-state.ts`
- `packages/shared/src/terminal/visible-range.ts`
- `packages/shared/src/terminal/buffer-sync-request-planner.ts`
- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/open-tab-intent.ts`
- `android/src/lib/connections-server-groups.ts`
- `android/src/lib/terminal-width-mode-manager.ts`

这些模块大多具备以下特征：

- 输入输出明确
- 不依赖 React 生命周期
- 可以独立测试
- 可在 app/server/未来平台间复用
- 已经承担一部分真实业务判断，而不是仅做工具函数杂项

**审计结论**：shared 层不是空壳，已经是当前代码库里最健康的一层。

#### 3.1.2 SessionContext 已经明显从 God object 收口

`android/src/contexts/SessionContext.tsx` 现在约 `298` 行，主要职责是：

- 初始化 reducer / refs
- 装配 runtime 和 assemblies
- 对外导出 stable facade

真实逻辑已下沉到：

- `session-context-provider-runtime.ts`
- `session-context-provider-assemblies.ts`
- `session-context-public-facade-runtime.ts`
- `session-context-session-runtime.ts`
- `session-context-transport-runtime.ts`
- `session-context-buffer-runtime.ts`
- `session-context-socket-message-runtime.ts`
- `session-context-transport-orchestration-runtime.ts`

**审计结论**：Context 壳层薄化方向是正确的，且已取得实质性结果。

#### 3.1.3 server 入口已经开始 support 化

`android/src/server/server.ts` 当前约 `399` 行，并已将一部分 terminal helper 下沉到：

- `android/src/server/terminal-core-support.ts`

同时配有 truth gate：

- `android/src/server/server.core-support-truth.test.ts`

**审计结论**：server 侧已经从“大一坨入口”向“support block + glue entry”演进，方向正确。

#### 3.1.4 多个状态真源已从 React state 转为 store/block

典型例子：

- `session-buffer-store.ts`
- `session-render-gate.ts`
- `session-head-store.ts`
- `session-viewport-mode-store.ts`

这说明不少核心真相已经不再绑死在 page/component 的 `useState/useEffect` 中，而是进入独立可订阅 store。

**审计结论**：这符合“blocks 为真源、UI 只消费 projection”的设计方向。

---

### 3.2 当前未完全达标的核心问题

#### 3.2.1 `TerminalPage.tsx` 明显不符合“纯编排”

证据：

- `android/src/pages/TerminalPage.tsx` 当前约 `3462` 行

从代码内容看，它同时承载了：

- 页面编排
- quick bar / header / swipe / tab manager 等 UI 结构协调
- keyboard / viewport / copy mode / overlay / debug overlay 等本地状态机
- clipboard / selection / key helper / layout helper / render key helper
- screenshot / schedule / file transfer 等 sheet 协调

也就是说它不是：

```text
TerminalPage = orchestration shell
```

而更接近：

```text
TerminalPage = page + UI状态机 + overlay协调器 + helper集合 + runtime局部控制器
```

**审计结论**：这是当前最明显的未收口点，也是本次审计确认的唯一主热点。

#### 3.2.2 session-context 已拆块，但存在“胶水层偏厚、命名层次不稳”问题

当前相关文件层次包含：

- `*-runtime.ts`
- `*-orchestration-runtime.ts`
- `*-lifecycle-runtime.ts`
- `*-provider-assemblies.ts`
- `*-public-facade-runtime.ts`
- `*-infra-facade-runtime.ts`

这说明：

- 代码确实拆了
- 但拆分仍带有较强“演进过程痕迹”
- 目前不是一个完全稳定、可长期维护的命名体系

其中一些文件更像 wiring/glue 层，而不是真正的领域 block owner，例如：

- `session-context-message-assemblies.ts`
- `session-context-provider-assemblies.ts`
- `session-context-transport-orchestration-runtime.ts`

**审计结论**：当前问题不是“没模块化”，而是“模块很多，但层级语义还不够稳定”。

#### 3.2.3 一些大 hook 仍是 block 与 orchestration 混合体

重点文件：

- `useOpenTabRuntime.ts`（约 `478` 行）
- `useSessionOpenActions.ts`（约 `485` 行）
- `useTerminalWorkspace.ts`（约 `601` 行）

这些文件的共性问题：

- 既处理 runtime 真相
- 又处理 UI/use-case 编排
- 还处理 page 层副作用或导航/切换

**审计结论**：这些 hook 比直接写在 page 里好很多，但还没有彻底达到“hook 只是 React 壳、真源在 block”的理想态。

#### 3.2.4 shared 与 android/lib 的边界还未完全冻结

当前结构大致是：

- 更纯、更跨端的规则在 `packages/shared`
- 更 app 贴近的逻辑在 `android/src/lib`

这个方向本身没错，但 terminal 相关仍有一些 helper/planner 包装层留在 Android 侧，例如：

- `session-buffer-planner-helpers.ts`
- 一部分 visible-range / request-window / repair 逻辑封装

**审计结论**：shared 已经成立，但 shared 的覆盖面和边界门禁仍需继续收紧。

---

## 四、分层审计

### 4.1 shared 函数库层

#### 现状评价

**整体良好，且是当前架构中最健康的一层。**

#### 优点

1. 已有明确 terminal leaf modules
2. planner / normalize / decision 类逻辑开始稳定下沉
3. 模块多数具备纯函数特性，测试友好
4. 已出现“shared 叶子模块供 app/server 使用”的正确模式

#### 问题

1. 下沉还不够彻底，Android 侧仍保留部分 planner 包装层
2. 还缺少更严格的结构门禁，例如：
  - shared 禁止 import React
  - shared 禁止 import Capacitor / DOM API
  - server/client 禁止 import `@zterm/shared` root，而应只 import leaf module

#### 结论

**这一层方向正确，建议继续加码，不建议回退。**

---

### 4.2 blocks 层

#### 现状评价

**已形成主体框架，但存在“过碎 + 中间胶水层偏厚”的问题。**

#### 做得较好的 blocks

1. store 型 block
  - `session-buffer-store.ts`
  - `session-render-gate.ts`
  - `session-head-store.ts`
  - `session-viewport-mode-store.ts`

2. open-tab 规则块
  - `open-tab-intent.ts`
  - `open-tab-persistence.ts`
  - `open-tab-restore.ts`

3. server runtime/support block
  - `terminal-core-support.ts`
  - `terminal-mirror-runtime.ts`
  - `terminal-transport-runtime.ts`
  - `terminal-control-runtime.ts`
  - `terminal-schedule-runtime.ts`

#### 主要问题

1. 一些所谓 block 其实是 orchestration glue
  - 这类文件应该被明确标记为 orchestration/facade，而不是与真源块混在一起

2. block 命名体系不统一
  - 当前的 `runtime / assemblies / facade / lifecycle / orchestration` 并存，阅读成本高

3. 有些 block 更像“按重构过程拆出来的模块”，而不是“按领域真相命名的 owner”

#### 结论

**blocks 已存在，但要从“数量型拆分”升级为“领域 owner 型拆分”。**

---

### 4.3 orchestration / 纯编排层

#### `App.tsx`

**评价：基本合格，但偏胖。**

优点：

- 已经像 app shell
- 主要依靠 hooks/runtime/lib 组合页面
- 不再自己承载底层 terminal/session 细节

问题：

- app update、relay debug、tab runtime、picker sheet、terminal shell actions 等横切能力仍然全部汇总在 `AppContent`

结论：

- 短期可接受
- 中期建议继续拆成 `useAppShellRuntime` / `AppGlobalSheets` / `AppOverlays`

#### `SessionContext.tsx`

**评价：基本符合纯编排壳。**

它现在更多是在做：

- provider 组装
- facade 暴露
- runtime 装配

这已经比较符合“编排层不承载业务细节”的要求。

#### `TerminalPage.tsx`

**评价：当前明确不合格。**

原因不是因为“文件大”本身，而是因为它仍同时持有：

- 页面壳编排
- UI 状态机
- runtime 交互控制
- overlay/sheet 协调
- 各种 helper 规则

**结论**：当前最该先做的不是继续抽 `SessionContext`，而是让 `TerminalPage.tsx` 真正退回编排层。

---

## 五、关键证据

### 5.1 行数证据

- `android/src/pages/TerminalPage.tsx`：`3462` 行
- `android/src/pages/ConnectionsPage.tsx`：`565` 行
- `android/src/contexts/SessionContext.tsx`：`298` 行
- `android/src/hooks/useOpenTabRuntime.ts`：`478` 行
- `android/src/hooks/useSessionOpenActions.ts`：`485` 行
- `android/src/contexts/session-context-session-runtime.ts`：`524` 行
- `android/src/contexts/session-context-transport-runtime.ts`：`494` 行
- `android/src/contexts/session-context-buffer-runtime.ts`：`778` 行
- `android/src/server/server.ts`：`399` 行
- `android/src/server/terminal-core-support.ts`：`109` 行

### 5.2 结构证据

已存在的 blocks / leaf 模块：

- `packages/shared/src/terminal/*`
- `android/src/lib/session-buffer-store.ts`
- `android/src/lib/session-render-gate.ts`
- `android/src/lib/open-tab-intent.ts`
- `android/src/lib/connections-server-groups.ts`
- `android/src/server/terminal-core-support.ts`

已薄化的编排壳：

- `android/src/contexts/SessionContext.tsx`

仍未薄化的热点：

- `android/src/pages/TerminalPage.tsx`

---

## 六、完整问题清单

### P0：`TerminalPage.tsx` 仍是页面巨兽

**影响**：

- 违反纯编排原则
- 提高任何 terminal UI 变更的耦合度
- 容易让后续功能继续堆到同一文件
- 最容易再次长出重复逻辑与隐式真源

**判断**：本次审计确认，这是当前唯一主热点。

### P1：session-context 层次过多，命名不稳定

**影响**：

- 新维护者很难快速定位唯一 owner
- `runtime / orchestration / facade / assemblies` 边界不稳定
- 后续继续拆时容易重复造中间层

### P2：大 hook 仍混合真相与编排

**影响**：

- React hook 容易继续膨胀
- block 与 UI 生命周期耦合偏深
- 复用性和测试稳定性受限

### P3：shared 下沉还不彻底

**影响**：

- planner 规则容易再次分叉
- Android 层可能成为“shared 的二次真源”

### P4：结构门禁不足

**影响**：

- 现在靠人工记忆维持结构纪律
- 后续很容易回长、回胖、回重复

---

## 七、改进建议

### 7.1 第一优先级：把 `TerminalPage.tsx` 收回纯编排壳

建议不是简单按 JSX 切组件，而是按职责块拆：

1. `terminal-page-render-keys.ts`
  - 各类 session/render/header key 计算 helper

2. `terminal-copy-selection.ts`
  - copy selection state model
  - buffer row -> text 规则
  - selection buffer resolve 规则

3. `terminal-keyboard-lift.ts`
  - keyboard inset / visual viewport / header inset 相关纯 helper

4. `useTerminalPageOverlays.ts`
  - schedule / screenshot / transfer / tab manager / debug overlay 打开关闭

5. `useTerminalPageInteractionRuntime.ts`
  - interactive session / pane attach / tab switch / copy mode 等运行态协调

6. `TerminalPage.tsx`
  - 最终只保留 page shell、stage 组合、hook 调用、JSX 编排

**目标不是机械减行数，而是让文件语义真正回到 orchestration shell。**

### 7.2 第二优先级：稳定 session-context 命名体系

建议后续逐步统一为五类：

1. `*-store.ts`：状态真源块
2. `*-rules.ts` / `*-planner.ts`：纯规则块
3. `*-runtime.ts`：单领域执行块
4. `*-orchestrator.ts`：组合多个 block 的编排块
5. `*-facade.ts`：对外暴露薄接口

不建议继续扩张这类名字：

- `provider-assemblies`
- `public-facade-runtime`
- `infra-facade-runtime`
- `transport-control-orchestration-runtime`

原因不是它们错，而是它们把层级概念叠得过深，不利于长期维护。

### 7.3 第三优先级：继续把纯 planner 下沉到 `packages/shared`

下沉标准：

满足以下条件就优先下沉：

- 不依赖 React
- 不依赖 DOM / Capacitor / WebView
- 不依赖 Android shell
- 输入输出是纯数据
- server/mac/android 未来都可能共享

重点候选：

- `session-buffer-planner-helpers.ts` 中仍属纯规则的部分
- visible range / request window / repair 相关纯决策逻辑
- terminal page 中的纯 layout/viewport 规则辅助函数

### 7.4 第四优先级：大 hook 去真相化

重点对象：

- `useOpenTabRuntime.ts`
- `useSessionOpenActions.ts`
- `useTerminalWorkspace.ts`

建议方向：

- hook 只接 React 生命周期
- 领域真相放到 runtime/store/planner 中
- hook 对外只做 facade

### 7.5 第五优先级：补结构门禁

建议增加：

1. 文件大小门禁
  - `TerminalPage.tsx > 800` 报警
  - `App.tsx > 500` 报警
  - `SessionContext.tsx > 400` 报警

2. forbidden import 门禁
  - shared 禁止 import React/Capacitor
  - server/client 禁止 import `@zterm/shared` root
  - page 层禁止直连深层 transport runtime

3. truth owner 门禁
  - open-tab / transport / buffer / renderer 各自维护唯一 owner 列表

---

## 八、模块级判定

### `android/src/App.tsx`

- 判定：**基本合格，偏胖**
- 原因：已主要作为 app-shell 编排，但横切能力过多
- 建议：继续拆 app-shell runtime 与全局 overlay/sheet 协调

### `android/src/contexts/SessionContext.tsx`

- 判定：**合格，接近纯编排壳**
- 原因：provider 装配职责清楚，底层逻辑已外置
- 建议：保持薄壳，不要再回灌业务细节

### `android/src/pages/TerminalPage.tsx`

- 判定：**不合格，是当前主热点**
- 原因：职责过多，混合了编排、状态机、helper、overlay 协调
- 建议：立即作为下一阶段的主重构目标

### `android/src/hooks/useOpenTabRuntime.ts`

- 判定：**方向正确，但仍偏厚**
- 原因：restore/runtime sync/page effect 仍与真源 runtime 混合
- 建议：拆 runtime store / restore orchestrator / facade

### `android/src/hooks/useSessionOpenActions.ts`

- 判定：**像用例层，但还不够纯**
- 原因：picker UI state 与 domain action 混合
- 建议：拆 picker state 与 session open use-case orchestration

### `packages/shared`

- 判定：**最值得继续扩大的正确方向**
- 原因：已是真实纯逻辑真源层
- 建议：继续吸收纯规则与 normalize/planner 能力

### `android/src/server/server.ts`

- 判定：**基本合格，已接近薄入口**
- 原因：已有 support 抽离与 truth tests
- 建议：继续保持入口只做装配，防止回胖

---

## 九、最终判定

### 9.1 是否已经按“共享函数库 + blocks + 纯编排”设计？

**判定：部分达标，未完全达标。**

更细分：

- **共享函数库**：已达标并在持续完善
- **blocks**：主体已达标，但层级语义仍需稳定
- **纯编排**：仅部分入口达标，`TerminalPage.tsx` 明显未达标

### 9.2 当前最重要的唯一主目标

**唯一主目标：把 `android/src/pages/TerminalPage.tsx` 收成真正的纯编排壳。**

唯一性论证：

1. shared 层已经存在，不是当前主矛盾
2. SessionContext 壳层已薄化，不是当前主矛盾
3. server.ts 已有 support 化，不是当前主矛盾
4. **只有 `TerminalPage.tsx` 仍同时持有编排、状态机、helper、overlay 协调与局部交互真相，直接违背三层设计**

因此，若要判断“下一步最该先改哪里”，答案不是泛泛的“继续优化 blocks”，而是明确且唯一的：

> **先重构 `TerminalPage.tsx`。**

---

## 十、建议执行顺序

1. 先出 `TerminalPage.tsx` 拆分蓝图（文件路径 + owner + 依赖边界）
2. 先抽纯 helper，再抽 overlay/runtime hook，最后收 page shell
3. 再稳定 session-context 命名体系
4. 再继续把纯 planner 下沉到 `packages/shared`
5. 最后补 file-size / import / truth-owner 门禁

---

## 十一、审计结论摘要（给决策用）

- 当前架构不是“没按 shared + blocks + orchestration 做”，而是**已经做了一半以上，而且方向大体正确**。
- 真正的问题不是 shared 层缺失，而是**terminal page 仍未退回纯编排壳**。
- 下一步不应泛泛做“继续模块化”，而应围绕 **`TerminalPage.tsx` 唯一主热点** 做结构性收口。
- 只有先解决这个主热点，后续 shared/block/orchestration 三层才会真正稳定，而不是继续边拆边堆。
