# zterm Android 架构审计报告 v4：共享函数库 + blocks + 纯编排现状审计

- 日期：2026-05-24
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计范围：`android/src/pages/TerminalPage.tsx` 及其直接相关 page/runtime/workspace 依赖
- 审计目的：判断当前代码是否已经按“共享函数库 + blocks + 纯编排”的方式设计，并给出继续收口的唯一正确方向
- 审计依据：
  - `android/docs/architecture.md`
  - `android/docs/ui-slices.md`
  - `android/docs/dev-workflow.md`
  - `android/docs/audits/2026-05-24-shared-blocks-orchestration-audit.md`
  - `android/docs/audits/2026-05-24-shared-blocks-orchestration-audit-v2.md`
  - `android/docs/audits/2026-05-24-shared-blocks-orchestration-audit-v3.md`
  - 当前工作树真实代码

---

## 1. 执行摘要

### 1.1 审计结论

**结论：当前代码已经明显朝“共享函数库 + blocks + 纯编排”收口，并且 shared/helper 层与多数组件化 blocks 层已经成型；但 `TerminalPage.tsx` 仍未达到“纯编排壳”标准，因此不能宣称整体架构改造完成。**

换句话说：

- **shared helper / pure leaf**：基本达标
- **page-local blocks**：已形成真实 owner，不再是空壳抽文件
- **page orchestration shell**：**尚未达标**，仍保留多组 page-local coordinator / runtime owner

### 1.2 本轮新增事实

本轮不是只写报告，已先修复一处中断中的半成品改动：

- 修复 `android/src/hooks/useTerminalWorkspace.ts`
- 正确把 `onActivatePaneSession` 接入 `useTerminalWorkspace(...)` 参数解构
- 恢复 `activatePaneAndSession` 这条迁移动线的编译可用性

### 1.3 本轮验证证据

已实际通过：

```bash
pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false
```

```bash
pnpm --dir android exec vitest run \
  src/pages/useTerminalPageCopyRuntime.test.tsx \
  src/pages/useTerminalPageOverlays.test.tsx \
  src/pages/terminal-page-render-keys.test.ts \
  src/pages/terminal-keyboard-lift.test.ts \
  src/pages/terminal-copy-selection.test.ts \
  src/pages/TerminalPage.android-ime.test.tsx \
  src/pages/TerminalPage.render-scope.test.tsx \
  --reporter dot
```

结果：
- `7 files passed`
- `62 tests passed`
- `tsc` 无错误

### 1.4 当前体量证据

```text
android/src/pages/TerminalPage.tsx                     2541 行
android/src/pages/useTerminalPageInteractionRuntime.ts  237 行
android/src/pages/useTerminalPageCopyRuntime.ts         197 行
android/src/pages/useTerminalPageOverlays.ts            233 行
android/src/pages/terminal-page-render-keys.ts           94 行
android/src/pages/terminal-keyboard-lift.ts              58 行
android/src/pages/terminal-copy-selection.ts            107 行
```

**关键判断**：`TerminalPage.tsx` 仍是 2541 行，远大于纯编排壳应有体量，因此本次只能判定为“重构进行中，不是完成态”。

---

## 2. 审计方法与判定口径

本报告按三层判定：

1. **共享函数库 / helper leaf 层**
   - 是否纯函数
   - 是否无 React 生命周期耦合
   - 是否可被多处消费或至少作为稳定 leaf owner
   - 是否已有测试覆盖

2. **blocks 层**
   - 是否真正持有单一职责 owner
   - 是否只是“把代码搬出去”而没有完成 owner 收敛
   - 是否与其他 block/page 形成反向依赖或双真源

3. **纯编排 shell 层**
   - page 是否只负责装配 hooks、透传 handler、组织 JSX
   - page 内是否仍残留状态机 / coordinator / runtime 真相
   - page 是否仍然同时承担 UI、状态、时序、跨模块协调

判定标准不是“有没有抽文件”，而是：

> **某个能力是否已经有唯一 owner，且 page 不再重复持有同一语义。**

---

## 3. 现状判定：是否已按“共享函数库 + blocks + 纯编排”设计

## 3.1 共享函数库 / helper leaf：基本达标

### 已成型文件

- `android/src/pages/terminal-page-render-keys.ts`
- `android/src/pages/terminal-keyboard-lift.ts`
- `android/src/pages/terminal-copy-selection.ts`

### 判定

这三类文件已经基本符合 shared/helper leaf 设计：

1. **输入输出清晰**
2. **无 UI 结构依赖**
3. **无 page state owner 混入**
4. **有定向测试**

### 证据

测试已覆盖：
- `terminal-page-render-keys.test.ts`
- `terminal-keyboard-lift.test.ts`
- `terminal-copy-selection.test.ts`

### 评价

这一层当前是最健康的层，说明“先抽纯计算 / 纯 helper / 无生命周期依赖的真源”这条路线是对的。

---

## 3.2 blocks：已显著成型，但边界还可继续压实

### 已成型 blocks

- `useTerminalPageCopyRuntime.ts`
- `useTerminalPageOverlays.ts`
- `useTerminalPageInteractionRuntime.ts`
- `useTerminalWorkspace.ts`（虽不在 pages 下，但实际上也是关键运行时 block）

### 当前真实评价

#### A. `useTerminalPageCopyRuntime.ts`

**判定：达标。**

持有的是真正的 copy-selection state machine owner，而不是 page 的镜像。其职责边界清晰，且 page 只做薄协调，例如 tab 切换前 reset copy selection。

这符合：
- copy runtime 自己持有 copy 真相
- page 只在跨 runtime 协调时做外层 orchestration

#### B. `useTerminalPageOverlays.ts`

**判定：基本达标。**

overlay/sheet/debug/screenshot/schedule 编排已经下沉为 block，page 不再直接散落大量 overlay 状态 owner。

剩余风险不在“是否抽出”，而在后续是否还会继续往这个 block 回灌无关能力。当前没有看到明显回灌证据。

#### C. `useTerminalPageInteractionRuntime.ts`

**判定：已成为真实 owner，但尚未收满。**

目前它已经真实持有：
- `interactiveSession`
- `uiSession`
- `uiSessionId`
- `renderedPaneSessions`
- `livePaneSessionIds`
- `livePaneSessionIdsKey`
- `splitVisibleRef`
- `handleSwipeTabRaw`
- `handleSwitchSessionFromChromeRaw`
- pane attach intent consume
- live session ids report

这说明 interaction runtime 已不是“为了拆文件而拆文件”，而是已经承担了真实的交互编排 owner。

但还未收满的证据也非常明确：
- `handleOpenQuickTabPickerForPane`
- `handleOpenTabManager`
- `handleTerminalViewportChange`

仍留在 page 中。

#### D. `useTerminalWorkspace.ts`

**判定：作为 workspace runtime owner 是正确方向。**

本轮新增的 `activatePaneAndSession` 继续把 pane 激活语义向 workspace owner 收口，这条线是正确的，因为：
- pane activation 本质上就是 workspace 真相的变更
- 如果 page 自己长期持有该逻辑，会形成 page 与 workspace 的双 owner

当前已完成到：
- `UseTerminalWorkspaceOptions` 增加 `onActivatePaneSession`
- `UseTerminalWorkspaceResult` 暴露 `activatePaneAndSession`
- page 侧已物理删除旧的 page-local `activatePaneAndSession`

并经本轮修复后恢复编译与测试。

---

## 3.3 `TerminalPage.tsx`：仍不是纯编排壳

### 当前结论

**不达标。**

虽然 `TerminalPage.tsx` 已经明显比初始状态更干净，但它还不能叫 pure orchestration shell。

### 仍留在 page 的 owner / coordinator

根据当前 grep 与代码阅读，page 内仍保留至少以下几组职责：

1. `handleOpenQuickTabPickerForPane`
2. `handleOpenTabManager`
3. `handleTerminalViewportChange`
4. 一部分 keyboard / IME / viewport bridge 编排
5. 一部分 quickbar / shell action forwarding
6. 若干 page 级 `useLayoutEffect` / `useEffect` 协调逻辑

其中最关键的是前 3 项：

- 它们不是纯 JSX
- 也不是简单 props 映射
- 它们仍然承担运行时时序协调

这意味着 page 仍在做 block 的事，而不只是 orchestration shell 的事。

### 为什么当前还不能叫“纯编排”

纯编排壳至少应满足：
- page 不持有独立 state machine
- page 不持有复杂 coordinator
- page 不持有跨 runtime 的运行态真相
- page 主要工作是：消费 block 输出 → 拼装 JSX → 做极薄的跨 block 调度

但当前 `TerminalPage.tsx` 仍然：
- 处理 pane/tab manager 打开前的激活时序
- 处理 viewport mode 更新转发
- 处理 keyboard/IME 一整条高风险链路

所以准确说法只能是：

> **已经从巨型混合页，收敛到“以编排为主、但仍带残余 coordinator 的大壳页”。**

不是纯编排壳。

---

## 4. 改进空间

## 4.1 立即可做：继续清 page-local coordinator

### 改进点 1：把 quick-tab / tab-manager 打开动作收成同一组 shell-action block

当前代码：
- `handleOpenQuickTabPickerForPane`
- `handleOpenTabManager`

这两者共同特征：
- 都会在特定 pane 上先 `activatePaneAndSession(...)`
- 都属于 UI shell opening action
- 都不是 workspace 真相本体
- 都是典型 page-local coordinator

**建议**：收成一个新的 page-local block，例如：
- `useTerminalPageShellActionsRuntime.ts`
- 或并入 `useTerminalPageInteractionRuntime.ts`

更推荐前者，如果其后续还会吸纳 quickbar/sheet open actions，可以形成统一 shell actions owner。

### 改进点 2：把 `handleTerminalViewportChange` 从 page 移走

当前它做：
- `sessionViewportModeStoreRef.current.setMode(...)`
- 转发 `onTerminalViewportChange?.(...)`

这已经不是 JSX 编排，而是 viewport-mode coordinator。

可选正确归属：
1. interaction runtime
2. 独立 viewport runtime
3. session viewport mode store 外围 coordinator

不建议长期留在 page。

### 改进点 3：继续压缩 page 中的 handler 包装数量

现在 page 里有一些“正确的薄包装”，例如：
- 先 reset copy，再调用 interaction raw action

这类包装是允许存在的，但要持续检查：
- 是否只是 1~2 行跨 runtime 调度
- 是否逐渐演化成新的 mini state machine

若后者发生，就要继续抽 block。

---

## 4.2 中期可做：把 shell action / viewport / quickbar forwarding 分层

### 方向 A：shell actions block

可以把下面这些动作统一收口：
- quick tab picker open
- tab manager open
- 可能还包括部分 quickbar open / close / compose actions

前提是：
- 它们都属于 UI shell action
- 不持有 renderer / buffer / daemon 真相
- 只处理 page 范围内的打开、scope 切换、薄时序协调

### 方向 B：viewport coordinator block

可把：
- viewport mode 写入
- viewport change 外发
- 跟随 rendered sessions 的 default follow 同步

统一为一组 runtime。这样 page 的 `useLayoutEffect` 可以进一步减薄。

---

## 4.3 当前不建议推进：keyboard runtime 大切片

### 原因

当前 keyboard/IME 链路牵涉：
- native `ImeAnchor`
- viewport height 推导
- quickbar lift
- terminal focus retry
- Android keyboard listeners
- session switch / editor focus reroute

这是高耦合整链路。现阶段没有一个已经被验证的小切口能安全切进去。

### 审计建议

**不要为了追求“page 行数下降”而粗暴抽 keyboard runtime。**

这不是保守，而是唯一正确的风险控制，因为：
- 当前链路已经有 Android IME 定向测试门禁
- 一旦大切片拆坏，恢复成本高于收益
- 现在还有低风险 page-local coordinator 可先收

因此正确优先级是：
1. 继续收 low-risk coordinator
2. 把 page 壳继续压薄
3. 再回头审 keyboard runtime 是否出现可独立验证的小切口

---

## 5. 架构问题清单

## 5.1 已解决的问题

1. **page 内 copy state machine 混杂** → 已迁到 `useTerminalPageCopyRuntime.ts`
2. **overlay owner 分散** → 已迁到 `useTerminalPageOverlays.ts`
3. **interaction 派生态和 swipe/chrome 切换散落在 page** → 大部分已迁到 `useTerminalPageInteractionRuntime.ts`
4. **pane activate 仍在 page 自己管** → 已开始迁到 `useTerminalWorkspace.ts`，且本轮修复后重新可用

## 5.2 尚未解决的问题

1. `TerminalPage.tsx` 仍然过大：2541 行
2. page 仍存在 shell-action coordinator
3. page 仍存在 viewport-mode coordinator
4. keyboard/IME 链路尚无最终边界方案
5. 纯编排门禁尚未制度化（例如行数门禁 / owner 重复门禁）

---

## 6. 建议新增门禁

### 6.1 结构门禁

1. `TerminalPage.tsx > 800` 视为未完成收口
2. page 不允许同时持有某组语义 owner 与对应 runtime owner
3. 新增 runtime 后，旧 page owner 必须物理删除，不能空转并存

### 6.2 测试门禁

继续保留当前 targeted suite 作为最小回归门禁：

```bash
pnpm --dir android exec vitest run \
  src/pages/useTerminalPageCopyRuntime.test.tsx \
  src/pages/useTerminalPageOverlays.test.tsx \
  src/pages/terminal-page-render-keys.test.ts \
  src/pages/terminal-keyboard-lift.test.ts \
  src/pages/terminal-copy-selection.test.ts \
  src/pages/TerminalPage.android-ime.test.tsx \
  src/pages/TerminalPage.render-scope.test.tsx \
  --reporter dot
```

### 6.3 文档门禁

每次继续收 block 时，至少同步：
- `android/note.md` 记录本轮 owner 迁移点
- 审计文档只追加事实，不写口头完成态

---

## 7. `/goal` 提示词设计

根据 `goal-prompt` skill，`/goal` 应只保留主目标、文档路径、缩略执行规范、验证门禁、完成标准；详细实施细节放进 goal plan 文档。

### 7.1 推荐 `/goal` 文本

```text
/goal
目标：继续把 `android/src/pages/TerminalPage.tsx` 收成真正纯编排壳；在已完成 shared helper / copy / overlays / interaction 收口的基础上，继续清除 page 内残余 coordinator，并把文件压到 `<800` 行。

实现文档：
- `android/docs/goals/terminal-page-orchestration-refactor-plan.md`
- `android/docs/audits/2026-05-24-shared-blocks-orchestration-audit-v4.md`

执行规范：
- 先验证后结论；无 `tsc` 与 targeted tests 绿，不宣称完成
- 不做 fallback，不保留双真源，不允许“只搬文件不删旧 owner”的假重构
- page 只允许保留极薄跨 block 协调；state machine / coordinator / runtime 真相必须继续下沉
- 优先收 low-risk coordinator：quick-tab/tab-manager shell actions、viewport-mode coordinator；暂不硬拆 keyboard runtime 大切片

验证：
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm --dir android exec vitest run src/pages/useTerminalPageCopyRuntime.test.tsx src/pages/useTerminalPageOverlays.test.tsx src/pages/terminal-page-render-keys.test.ts src/pages/terminal-keyboard-lift.test.ts src/pages/terminal-copy-selection.test.ts src/pages/TerminalPage.android-ime.test.tsx src/pages/TerminalPage.render-scope.test.tsx --reporter dot`
- 跟踪 `TerminalPage.tsx` 行数，当前 `2541`，目标 `<800`

完成标准：
- `TerminalPage.tsx` 只剩 hooks 装配、极薄 handler 包装、JSX 编排
- shared/helper、workspace、copy、overlays、interaction、shell-actions（如新增）各有唯一 owner
- page 内不再残留可独立命名的 coordinator/runtime owner
- `tsc` 0 错误，targeted tests 全绿
- summary 必须说明为什么当前 owner 划分是唯一正确的
```

### 7.2 设计理由

这份 `/goal` 的设计是当前唯一正确的简写方式，因为：

1. **主目标足��单一**：就是继续把 `TerminalPage.tsx` 压成纯编排壳
2. **详细计划已下沉文档**：避免 goal prompt 继续膨胀
3. **执行规范只保留硬约束**：真源、无 fallback、无假重构、先低风险再高风险
4. **验证门禁可直接执行**：不是抽象口号
5. **完成标准可审计**：不是“感觉更干净了”这种口头标准

---

## 8. 最终结论

### 8.1 是否已按目标方式设计

**部分是，但整体未完成。**

更准确地说：

- **shared helper 层：是**
- **blocks 层：大体是，而且已形成真实 owner**
- **纯编排 page shell：还不是**

### 8.2 继续改进的唯一正确方向

**唯一正确方向不是再做广泛重写，而是继续按 owner 收口 residual coordinator：**

1. 先继续清 `handleOpenQuickTabPickerForPane` / `handleOpenTabManager`
2. 再清 `handleTerminalViewportChange`
3. 再评估 page 中剩余 shell-action forwarding
4. 最后才碰 keyboard runtime 是否可切

### 8.3 唯一性论证

这条路径是唯一正确的，因为：

- 当前 shared/helper、copy、overlays、interaction 已经是稳定真源，回退它们只会重新制造双真源
- `TerminalPage.tsx` 现在最大的剩余问题不是 leaf/helper，而是 residual coordinator
- keyboard runtime 目前缺少可独立验证切片，硬拆只会把已绿链路再次打坏
- 因此，**继续清低风险 coordinator，而不是改大链路，是当前唯一能持续前进且不破坏真源的收口方式**

---

## 9. 本轮事实记录

### 已做
- 修复 `android/src/hooks/useTerminalWorkspace.ts` 中 `onActivatePaneSession` 参数解构遗漏
- 恢复 `activatePaneAndSession` 迁移后的可编译状态
- 跑通 `tsc`
- 跑通 targeted vitest：`62 tests`
- 生成本审计报告 v4
- 生成 `/goal` 设计稿文档

### 未宣称完成的原因
- `TerminalPage.tsx` 仍有 2541 行
- page 中仍残留多组 coordinator
- keyboard/IME runtime 边界尚未收口

