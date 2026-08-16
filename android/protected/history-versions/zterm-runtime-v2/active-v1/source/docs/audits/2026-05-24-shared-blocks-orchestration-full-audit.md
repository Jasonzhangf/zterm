# TerminalPage 架构审计报告：共享函数库 + Blocks + 纯编排

- 日期：2026-05-24
- 审计范围：`android/src/pages/TerminalPage.tsx` 及所有已迁出模块
- 审计方法：逐文件源码审查 + 定向测试回归 + tsc 门禁
- 前置状态：1371 行主文件、62 tests passed、tsc 0 错误
# TerminalPage 架构完整审计报告：共享函数库 + Blocks + 纯编排

日期：2026-05-24
审计范围：`android/src/pages/TerminalPage.tsx` 及相关模块

## 一、目标架构

```
TerminalPage orchestration shell
   ↓
page-local blocks / coordinators / runtimes
   ↓
pure helper / shared leaf modules
```

验收标准：
- `TerminalPage.tsx` 只剩 props 编排、hooks 装配、JSX 组合
- 每种 runtime/state/coordinator 有唯一 owner 文件
- shared 层只接收纯逻辑（无 DOM/Capacitor/React 依赖）
- 不存在双真源、fallback、重复 planner
- tsc 0 错误，targeted tests 全绿

---

## 二、当前架构现状

### 2.1 文件规模快照

| 文件 | 行数 | 职责分类 |
|------|------|---------|
| `TerminalPage.tsx` | 1371 | orchestration shell（主目标） |
| `useTerminalPageInteractionRuntime.ts` | 237 | page-local block |
| `useTerminalPageCopyRuntime.ts` | 197 | page-local block |
| `useTerminalPageOverlays.ts` | 233 | page-local block |
| `useTerminalPageShellActionsRuntime.ts` | 90 | page-local block |
| `useTerminalPageSavedTabRuntime.ts` | 170 | page-local block |
| `TerminalPageStageShell.tsx` | 358 | page-local JSX subcomponent |
| `TerminalPageDebugOverlay.tsx` | 320 | page-local JSX subcomponent |
| `terminal-page-shell-ui.tsx` | 129 | page-local JSX subcomponent |
| `terminal-page-render-keys.ts` | 94 | helper / leaf |
| `terminal-page-persisted-tabs.ts` | 113 | helper / leaf |
| `terminal-copy-selection.ts` | 107 | helper / leaf |
| `terminal-keyboard-lift.ts` | 58 | helper / leaf |
| `terminal-page-debug-helpers.ts` | 46 | helper / leaf |
| `terminal-page-session-input.ts` | 13 | helper / leaf |
| `useTerminalPageQuickBarActions.ts` | 63 | helper / leaf |
| **合计** | 3599 | — |

### 2.2 三层归类

#### Layer 0 — pure helpers / shared leaf
已独立，语义纯，零 React/DOM/Capacitor 依赖：
- `terminal-page-render-keys.ts`（session/page identity key 生成）
- `terminal-copy-selection.ts`（copy 文本投影、行覆盖判定）
- `terminal-keyboard-lift.ts`（keyboard lift px / viewport height / header inset 纯计算）
- `terminal-page-debug-helpers.ts`（debug rate/Hz/status 格式化）
- `terminal-page-session-input.ts`（DOM input query）
- `terminal-page-persisted-tabs.ts`（persisted tab normalize/serialize 纯逻辑）
- `useTerminalPageQuickBarActions.ts`（quickbar height/draft/sequence 编排，依赖 uiSessionId prop）

#### Layer 1 — page-local blocks / coordinators
已独立，持有 page 级别 state/ref/effect，但无跨页共享需求：
- `useTerminalPageInteractionRuntime.ts`（interactive session / pane / swipe / chrome switch）
- `useTerminalPageCopyRuntime.ts`（copy selection 状态机：start/end/menu/long-press）
- `useTerminalPageOverlays.ts`（schedule / file-transfer / screenshot / debug overlay 开关协调）
- `useTerminalPageShellActionsRuntime.ts`（quick tab picker / tab manager / viewport change 编排）
- `useTerminalPageSavedTabRuntime.ts`（saved tab list 持久化运行时）

#### Layer 2 — orchestration shell
`TerminalPage.tsx`（1371 行）仍混合以下 owner：

**Layer 2 中仍混合的 owner（按引用复杂度排序）**

| # | Owner | state/ref 数量 | 引用链 | 闭环复杂度 |
|---|-------|---------------|--------|----------|
| 1 | **keyboard/IME 主闭环** | 3 state + 7 ref + 5 callback + 4 effects | `terminalKeyboardRequested ↔ keyboardInset ↔ quickBarEditorFocused ↔ ImeAnchor listeners` | 极高（互相触发，不可小切片） |
| 2 | **viewport metrics 外围** | 2 state + 1 ref + 2 callback + 1 effect | `viewportWidth ↔ headerTopInsetPx ↔ visualViewport resize` | 中（可切但页面仍需这两个 state） |
| 3 | **focusNonce + focus retry** | 1 state + 2 ref + 3 callback + 2 effects | `focusNonce ↔ terminalFocusRetryTimeouts ↔ ImeAnchor input` | 中（与 keyboard 闭环交叉但可切） |
| 4 | **`terminalPagePropsEqual` 比较器** | 纯函数 | `sessions/session key / active status / handlers` | 低（纯函数，可外抽但不改变分层本质） |
| 5 | **shell height 派生** | 纯计算 | `rawShellHeight ↔ keyboardViewportFreezeActive ↔ shellHeight` | 低（纯计算，已在 helpers 中有对应 lift 函数） |
| 6 | **layout profile 派生** | useMemo | `layoutProfile ↔ splitVisible ↔ headerTopInsetPx ↔ landscape` | 低（useMemo，可留 page 但需审查是否可入 helpers） |
| 7 | **`handleToggleKeyboard`** | useCallback | `IME toggle ↔ ImeAnchor.hide/show ↔ keyboardState` | 与 keyboard 闭环交叉 |
| 8 | **`handleQuickBarEditorDomFocusChange`** | useCallback | `quickBarEditorFocused ↔ ImeAnchor ↔ requestAndroidImeFocus` | 与 keyboard 闭环交叉 |
| 9 | **`handleActiveTerminalActivateInput`** | useCallback | 薄包装：`restoreAndroidTerminalImeRoute` | 极薄包装 |
| 10 | **copy menu JSX 内联块** | JSX 内联 | `copy menu floating div` | 低（可入独立文件但收益小） |
| 11 | **`React.memo` 包装** | 纯包装 | `TerminalPage = ReactMemo(Component, terminalPagePropsEqual)` | 纯包装，无执行语义 |

---

## 三、分层合规性审计

### 3.1 已达成项

| 要求 | 状态 | 证据 |
|------|------|------|
| TerminalPage 不持有 copy 状态机 | ✅ | `useTerminalPageCopyRuntime.ts` 持有 |
| TerminalPage 不持有 overlay sheet 协调态 | ✅ | `useTerminalPageOverlays.ts` 持有 |
| TerminalPage 不持有 interaction/pane/swipe 态 | ✅ | `useTerminalPageInteractionRuntime.ts` 持有 |
| TerminalPage 不持有 tab manager/schedule/shell actions 态 | ✅ | `useTerminalPageShellActionsRuntime.ts` + `useTerminalPageSavedTabRuntime.ts` |
| TerminalPage 不内嵌 DebugOverlay JSX | ✅ | `TerminalPageDebugOverlay.tsx` 独立 |
| TerminalPage 不内嵌 StageShell JSX | ✅ | `TerminalPageStageShell.tsx` 独立 |
| TerminalPage 不内嵌 shell UI helpers | ✅ | `terminal-page-shell-ui.tsx` 独立 |
| 纯 helper 已物理迁出 | ✅ | 7 个 helper 文件，总计 494 行 |
| shared 层无 React/DOM/Capacitor 依赖 | ✅ | helpers 零 platform 依赖 |
| 无 fallback / 双真源 | ✅ | 迁移路径已清除旧 owner |
| targeted tests 全绿 | ✅ | 7 test files, 62 tests passed |
| tsc 0 错误 | ✅ | `tsc --noEmit` clean |

### 3.2 未达成项

| 要求 | 状态 | 证据 |
|------|------|------|
| TerminalPage 只剩编排/hooks/JSX | ❌ | 仍持有 keyboard/IME 主闭环（最高引用密度） |
| 每种 runtime 有唯一 owner | ⚠️ | keyboard/IME 闭环仍散落在 page 内，未入独立 hook |
| 不持有可独立命名的 runtime/coordinator 真相 | ❌ | `terminalKeyboardRequested` / `keyboardInset` / `quickBarEditorFocused` / `focusNonce` / 7 refs / ImeAnchor listeners effects 仍是 page 真相 |

---

## 四、keyboard/IME 主闭环专项分析

### 4.1 依赖图

```
┌─────────────────────────────────────────────────────────────┐
│  terminalKeyboardRequested (state)          引用数: 16   │
│         ↓ 共同条件判断                               │
│  keyboardInset (state)                    引用数: 19   │
│         ↓ 共同条件判断                               │
│  quickBarEditorFocused (state)            引用数: 20   │
└─────────────────────────────────────────────────────────────┘
                   ↓ 三者共同派生
 keyboardViewportFreezeActive = isAndroid && (terminalKeyboardRequested || keyboardInset > 0)
 shellHeight = keyboardViewportFreezeActive ? frozen : raw

┌─────────────────────────────────────────────────────────────┐
│  updateTerminalKeyboardRequested (callback)     引用数: 12 │
│  updateKeyboardInset (callback)                 引用数: 6  │
│  requestAndroidImeFocus (callback)              引用数: 9  │
│  restoreAndroidTerminalImeRoute (callback)     引用数: 5  │
│  keepTerminalInputFocused (callback)            引用数: 3  │
│  setAndroidEditorActive (callback)             引用数: 5  │
└─────────────────────────────────────────────────────────────┘
                   ↓ 持有 addListener 生命周期
┌─────────────────────────────────────────────────────────────┐
│  ImeAnchor listeners (input/backspace/keyboardState)        │
│  Keyboard listeners (keyboardDidShow/keyboardDidHide)       │
│  持有: activeSessionIdRef / terminalInputHandlerRef        │
└─────────────────────────────────────────────────────────────┘
                   ↓ viewport freeze 语义
 stableLayoutViewportHeightRef                引用数: 5
 pendingAndroidImeFocusTimerRef               引用数: 6
 androidImeFocusRouteKeyRef                   引用数: 5
 terminalFocusRetryTimeoutsRef                引用数: 5
 viewportMetricsFrameRef                       引用数: 2
```

### 4.2 不可切原因

1. **`terminalKeyboardRequested ↔ keyboardInset ↔ quickBarEditorFocused` 三态互相触发**
  - 三者同时出现在 `keyboardViewportFreezeActive` 条件中
  - `restoreAndroidTerminalImeRoute` 的触发条件：`!(terminalKeyboardRequested || keyboardInset > 0)`
  - `handleToggleKeyboard` 分支条件：`terminalKeyboardRequested || keyboardInset > 0`
  - `requestAndroidImeFocus` 早期返回：`quickBarEditorFocusedRef.current`
  - 任意一个被迁走，其余两者仍在同一条件中出现，形成新的跨文件依赖

2. **`quickBarEditorFocused` state 和 ref 不可分割**
  - ref 的唯一目的是避免在 async/nested context 中读 stale state
  - ref 的值由 state 同步更新，两者必须同 owner

3. **ImeAnchor listener 内持有 `activeSessionIdRef` 和 `terminalInputHandlerRef`**
  - listener 闭包必须同步读取这两个 ref
  - 任何 ref 被迁走，listener 闭包必须同步更新
  - listener 本身不可外抽（因为持有 `emitToActiveSession` 跨模块调用）

4. **viewport metrics 与 keyboard 共享同一 freeze 语义**
  - `stableLayoutViewportHeightRef` 被 keyboard freeze 和 viewport resize 共用
  - `scheduleViewportMetricsSync` 编排节流同一 viewportMetricsFrameRef

### 4.3 可切但低收益项

| 可切目标 | 切出条件 | 预估行数 | 收益评估 |
|---------|---------|---------|---------|
| `updateViewportMetrics` + `scheduleViewportMetricsSync` | 依赖 `viewportWidth`/`headerTopInsetPx`，可迁出但页面仍需这两个 state | ~15 行 | 极低（只是改名转发） |
| `updateTerminalKeyboardRequested` | 只写 state，可迁出但 state 仍需留在闭环内 | ~3 行 | 极低 |
| `updateKeyboardInset` | 同上 | ~4 行 | 极低 |
| `focusNonce` | 可移入独立 hook，但只被 `focusTerminalInput` 写入、`TerminalStageShell` 读取 | ~1 行 state | 低（主文件减少一行） |
| `terminalPagePropsEqual` | 纯函数，可外抽但不改变分层本质 | ~50 行 | 极低（不改架构实质） |
| copy menu JSX 内联块 | 可迁到独立文件，但只有 25 行且语义简单 | ~25 行 | 低 |
| `handleActiveTerminalActivateInput` | 极薄包装，可直接内联到 JSX | ~2 行 | 极低 |
| layout profile useMemo | 可检查是否可入 helper，但依赖 `splitVisible/headerTopInsetPx/landscape` state | ~10 行 | 低 |

### 4.4 唯一正确 closeout 路线

**路线 A（推荐）：暂缓，等自然切片**
- 接受当前主闭环，继续从其他方向压缩主文件
- 主文件已从 ~2500 行压到 1371 行，剩余大部分是 keyboard 闭环
- 架构已达标，剩余是 keyboard 这个不可分块的真实 owner 热点

**路线 B：一次性大重构**
- 把整个 keyboard/IME 区块一次性封装进 `useTerminalPageKeyboardRuntime.ts`
- 需要迁入：5 state + 7 refs + 5+ callbacks + 4 effects + ImeAnchor/Keyboard lifecycle
- 验证门槛：新 hook 独立单测 + Android IME 回归全绿 + page 只剩 props 透传
- 收益：主文件可再压 ~300 行
- 风险：整体切换，验证失败需整体回滚

**路线 C：混合路线**
- 先把低收益但独立的 slice 迁出（viewport metrics、copy menu JSX、layout profile）
- 同时对 keyboard/IME 做整体重构设计（出一份 closeout 方案文档）
- 再决定是否执行路线 B

---

## 五、改进空间评估

### 5.1 高优先级（架构实质性收益）

| 改进项 | 当前状态 | 目标状态 | 预估行数收益 | 风险 |
|-------|---------|---------|------------|------|
| keyboard/IME 主闭环整体重构 | 散落在 page 内 | `useTerminalPageKeyboardRuntime.ts` | ~300 行压出 | 高（整体切换） |
| viewport metrics 编排外抽 | 散落在 page 内 effect/callback | `useTerminalPageViewportMetrics.ts` | ~20 行压出 | 低（可独立验证） |
| layout profile 派生入 helper | page 内 useMemo | `terminal-layout-profile-helpers.ts` | ~10 行压出 | 极低 |

### 5.2 中优先级（代码整洁但不改变架构实质）

| 改进项 | 当前状态 | 目标状态 | 预估行数收益 | 风险 |
|-------|---------|---------|------------|------|
| copy menu JSX 内联块 | page 内 inline div | `TerminalPageCopyMenu.tsx` | ~25 行压出 | 低（独立 JSX） |
| `focusNonce` state 外抽 | page 内 state | `useTerminalPageFocusNonce.ts` | ~1 行 state | 极低 |
| `terminalPagePropsEqual` 外抽 | page 内纯函数 | `terminal-page-props-equal.ts` | ~50 行纯函数 | 极低（纯函数） |
| `handleActiveTerminalActivateInput` 内联 | page 内薄包装 | 直接内联到 JSX | ~3 行 | 无 |

### 5.3 低优先级（不推荐投入）

| 改进项 | 原因 |
|-------|------|
| 继续小切片 keyboard/IME | 已 closeout 审计确认无安全小切片 |
| 把 `terminalPagePropsEqual` 抽出到 shared | 纯 page-local helper，shared 层不应引入 page-level 类型依赖 |
| 把 `React.memo` 包装外抽 | 纯包装，无执行语义，外抽无意义 |

### 5.4 shared 层扩展机会

| 候选下沉目标 | 下沉条件 | 状态 |
|-------------|---------|------|
| `terminal-copy-selection.ts` 中的纯文本投影逻辑 | `terminalCellToPlainText` / `terminalBufferRowsToPlainText` / `terminalBufferCoversRows` 可完全无依赖独立 | 可评估但当前足够 page-local |
| `terminal-keyboard-lift.ts` 中的计算逻辑 | `resolveKeyboardLiftPx` / `resolveLayoutViewportHeight` 无 platform 依赖 | 当前足够 page-local，暂无跨端复用需求 |
| pane/split 布局计算 | `resolveMaxSplitCount` 已在 `packages/shared` | ✅ 已完成 |

---

## 六、架构一致性审计

### 6.1 三层架构遵守情况

| 层级 | 定义 | 当前遵守 | 说明 |
|------|------|---------|------|
| Layer 0 pure helpers | 无 React/DOM/Capacitor 依赖 | ✅ | 7 个 helper 文件均无 platform 依赖 |
| Layer 1 page-local blocks | 持有 page state/ref/effect，无跨页需求 | ✅ | 5 个 runtime/coordinator 均无跨页泄露 |
| Layer 2 orchestration shell | 只做 props 编排、hooks 装配、JSX 组合 | ⚠️ | 1371 行中 ~450 行仍是 keyboard/viewport/focus 真相，建议走路线 A/B 收口 |

### 6.2 唯一 owner 审计

| Owner | 唯一文件 | 状态 |
|------|---------|------|
| copy selection 状态机 | `useTerminalPageCopyRuntime.ts` | ✅ |
| overlays/sheets 协调 | `useTerminalPageOverlays.ts` | ✅ |
| interaction/pane/swipe | `useTerminalPageInteractionRuntime.ts` | ✅ |
| shell actions 协调 | `useTerminalPageShellActionsRuntime.ts` | ✅ |
| saved tab 运行时 | `useTerminalPageSavedTabRuntime.ts` | ✅ |
| keyboard/IME 运行时 | `TerminalPage.tsx`（未独立） | ⚠️ |
| viewport metrics 编排 | `TerminalPage.tsx`（未独立） | ⚠️ |
| focus nonce/retry | `TerminalPage.tsx`（未独立） | ⚠️ |

### 6.3 双真源审计

- 已迁移 owner：物理删除旧实现，无双 owner 残留 ✅
- keyboard/IME：新 hook 尚未创建，不存在双真源 ⚠️（page 内唯一）
- viewport metrics：新 hook 尚未创建，不存在双真源 ⚠️（page 内唯一）

### 6.4 shared 层边界审计

| 文件 | shared 候选 | 当前层级 | 说明 |
|------|------------|---------|------|
| `terminal-page-render-keys.ts` | ❌ | Layer 0 page-local | 依赖 page-level `Session` 类型，不可 shared |
| `terminal-copy-selection.ts` | ⚠️ | Layer 0 page-local | 逻辑纯，但无跨端复用需求，暂不下沉 |
| `terminal-keyboard-lift.ts` | ⚠️ | Layer 0 page-local | 逻辑纯，但无跨端复用需求，暂不下沉 |
| `packages/shared/src/terminal/pane-split.ts` | ✅ | shared | 已存在 |

---

## 七、测试覆盖审计

| 模块 | 测试文件 | 覆盖状态 |
|------|---------|---------|
| `useTerminalPageCopyRuntime.ts` | `useTerminalPageCopyRuntime.test.tsx` | ✅ 2 tests |
| `useTerminalPageOverlays.ts` | `useTerminalPageOverlays.test.tsx` | ✅ 2 tests |
| `terminal-page-render-keys.ts` | `terminal-page-render-keys.test.ts` | ✅ pure |
| `terminal-keyboard-lift.ts` | `terminal-keyboard-lift.test.ts` | ✅ pure |
| `terminal-copy-selection.ts` | `terminal-copy-selection.test.ts` | ✅ pure |
| `TerminalPage`（Android IME） | `TerminalPage.android-ime.test.tsx` | ✅ 32 tests |
| `TerminalPage`（render scope） | `TerminalPage.render-scope.test.tsx` | ✅ 13 tests |
| `useTerminalPageKeyboardRuntime.ts` | 未创建 | ❌ 无测试 |
| `useTerminalPageViewportMetrics.ts` | 未创建 | ❌ 无测试 |

---

## 八、工程基线

```bash
# type-check
pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false
# 结果：✅ 0 errors

# targeted tests
pnpm --dir android exec vitest run \
 src/pages/useTerminalPageCopyRuntime.test.tsx \
 src/pages/useTerminalPageOverlays.test.tsx \
 src/pages/terminal-page-render-keys.test.ts \
 src/pages/terminal-keyboard-lift.test.ts \
 src/pages/terminal-copy-selection.test.ts \
 src/pages/TerminalPage.android-ime.test.tsx \
 src/pages/TerminalPage.render-scope.test.tsx \
 --reporter dot
# 结果：✅ 7 files passed, 62 tests passed

# file sizes
TerminalPage.tsx: 1371 lines
page-local + helper 总计: 2228 lines
已迁出总行数: ~1100+ lines（从 ~2500 到 1371）
```

---

## 九、结论

### 9.1 总体判断

**架构路线已验证正确。** shared helpers + page-local blocks + orchestration shell 三层分层目标在核心路径上已达成：

- 已迁出 2200+ 行 page-local / helper / subcomponent owner
- `TerminalPage.tsx` 从 ~2500 行压到 1371 行（压缩率 ~45%）
- 无双真源、无 fallback、无假重构
- 所有 targeted tests 全绿，tsc 0 错误
- Layer 0 / Layer 1 已有清晰的 owner 边界

**剩余主阻塞是 keyboard/IME 主闭环（约 450 行），该区块不存在可独立验证、安全拆出的微切片。**

### 9.2 分层达标情况

| 层级 | 达标 | 说明 |
|------|------|------|
| Layer 0 pure helpers | ✅ 完全达标 | 7 个 helper 文件，均无 platform 依赖 |
| Layer 1 page-local blocks | ✅ 完全达标 | 5 个 runtime/coordinator，边界清晰 |
| Layer 2 orchestration shell | ⚠️ 接近达标 | page 只剩 keyboard/viewport/focus 真相 (~450 行) |
| shared 层扩展 | ⚠️ 条件成熟 | 当前无跨端复用需求，shared 层暂无新增必要 |

### 9.3 改进空间优先级排序

| 优先级 | 改进项 | 推荐行动 |
|-------|-------|---------|
| **P0 — 必须收口** | keyboard/IME 主闭环 | 出一份 closeout 方案文档（`useTerminalPageKeyboardRuntime.ts` 设计 + 迁移顺序 + 验证矩阵） |
| **P1 — 可选推进** | viewport metrics 编排外抽 | `useTerminalPageViewportMetrics.ts`（~20 行，风险低） |
| **P2 — 低优先级** | copy menu JSX 内联块外抽 | `TerminalPageCopyMenu.tsx`（~25 行） |
| **P2 — 低优先级** | layout profile 派生入 helper | 审查 `resolveTerminalLayoutProfile` 是否可下沉 |
| **P3 — 不推荐** | 继续小切片 keyboard/IME | 已审计确认无安全微切片，不应投入 |
| **P3 — 不推荐** | `terminalPagePropsEqual` 外抽 | 纯 page-local 函数，不改架构实质 |

### 9.4 唯一性说明

**为什么 keyboard/IME 整体重构是唯一正确下一步？**

当前 `TerminalPage.tsx` 剩余 owner 中，keyboard/IME 闭环是唯一未解决的真正 owner 热点（约 450 行，涵盖 3 state + 7 refs + 5 callbacks + 4 effects + ImeAnchor/Keyboard lifecycle）。

不存在安全微切片的证据已在本审计报告 4.2 节完整呈现：三态互相触发、state/ref 不可分割、ImeAnchor listener 内持有跨模块 ref。继续用小切片方式碎片化推进这块，收益极低且风险极高（每迁一小块都会触发至少两个其他 owner 的 deps 连锁更新）。

唯一正确的路线是接受这一现实，做一轮整体重构设计，然后在充分设计的基础上一次性封装进 `useTerminalPageKeyboardRuntime.ts`，而不是继续在 page 内用碎片方式维护这组不可分割的真相。

**为什么 viewport metrics 外抽是可选 P1 而非必须？**

viewport metrics（`viewportWidth`/`headerTopInsetPx`）和 keyboard 闭环共享 `stableLayoutViewportHeightRef`，但这个共享是表面的：两个 owner 各自从不同方向写入同一个 ref，读取的时机和条件不同。如果把 viewport metrics 单独封装，它只依赖 `visualViewport` resize 事件，不依赖 keyboard state 变化，因此可以在不触发 keyboard 闭环 deps 连锁的情况下独立完成迁移。

---

## 十、附录：历史迁移记录

| 日期 | Slice | 操作 | 主文件行数变化 |
|------|-------|------|--------------|
| 2026-05-24 | 第一批 | overlay/sheet/debug/remote-screenshot → `useTerminalPageOverlays.ts` | ~2500 → ~2200 |
| 2026-05-24 | 第二批 | copy selection 状态机 → `useTerminalPageCopyRuntime.ts` | ~2200 → ~2085 |
| 2026-05-24 | Slice A | interaction runtime 接管 `livePaneSessionIdsKey` | — |
| 2026-05-24 | Slice B | interaction runtime 接管 `interactiveSession/uiSession/uiSessionId/renderedPaneSessions` | — |
| 2026-05-24 | Slice C/C.1 | interaction runtime 接管 `handleSwipeTab/splitVisibleRef` | — |
| 2026-05-24 | Slice D | shell-actions → `useTerminalPageShellActionsRuntime.ts` | ~2516 → ~2296 |
| 2026-05-24 | Slice E | saved-tab → `useTerminalPageSavedTabRuntime.ts` + `terminal-page-persisted-tabs.ts` | ~2296 → ~2206 |
| 2026-05-24 | Slice F.1/F.2/F.3 | workspace → `useTerminalWorkspace.ts` | ~2206 → ~2040 |
| 2026-05-24 | Slice G.1 | debug helpers → `terminal-page-debug-helpers.ts` | ~2040 → ~2000 |
| 2026-05-24 | Slice H.1 | shell-ui → `terminal-page-shell-ui.tsx` | ~2000 → ~1722 |
| 2026-05-24 | Slice I.1/I.2 | utility → session-input / quickbar-actions / 移除零值包装 | ~1722 → ~1371 |
| 2026-05-24 | Slice J.1 | DebugOverlay → `TerminalPageDebugOverlay.tsx` | ~1722 → ~1371 |
| 2026-05-24 | Slice J.2 | StageShell → `TerminalPageStageShell.tsx` | ~1371 |
| 2026-05-24 | keyboard/IME closeout 审计 | 确认无安全小切片，结论：暂缓或整体大重构 | — |
# TerminalPage 架构审计报告：共享函数库 + Blocks + 纯编排

- 日期：2026-05-24
- 审计范围：`android/src/pages/TerminalPage.tsx` 及所有已迁出 page-local 模块
- 审计目标：评估当前是否达到 shared/helper leaf + page-local blocks + orchestration shell 稳定分层
- 验证基线：tsc 0 错误，targeted tests 62 passed，TerminalPage.tsx 当前 1371 行
## 1. 整体分层判定

### 1.1 三层架构对应关系

| 层级 | 目标 | 当前实际 | 达标状态 |
|------|------|----------|----------|
| shared / helper leaf | 纯逻辑、无 React/DOM/Capacitor 依赖、可跨端复用 | `packages/shared/src/terminal/` 纯函数；`android/src/pages/` 下的 page-local helper（render-keys/keyboard-lift/copy-selection/persisted-tabs/debug-helpers/session-input/shell-ui） | 部分达标 |
| page-local blocks / runtimes | 持有页面级状态真相、编排子域协调、DOM/Capacitor 依赖 | 6 个 runtime hook（copy/overlays/interaction/shell-actions/saved-tab/quickbar）+ 2 个独立组件（DebugOverlay/StageShell） | 达标 |
| orchestration shell | TerminalPage.tsx 只做 props 编排、hooks 装配、JSX 组合，不持有业务真相 | 1371 行，持有 keyboard/IME 主闭环（≈300行）、viewport/lift 派生计算、copy menu JSX | 未完全达标 |

### 1.2 结论

**当前处于"架构收口阶段"，路线正确但未完成。**

- shared/helper 层：主体成立，命名可小幅优化
- blocks 层：6 个 runtime hook + 2 个独立组件全部就位
- orchestration shell 层：keyboard/IME 主闭环是唯一未收口的重大 owner

## 2. 当前文件清单与 owner 归属

### 2.1 TerminalPage.tsx 入口（1371 行）

**当前持有的 owner 判定**：

| 逻辑块 | 行数估算 | 当前状态 | 判定 |
|--------|----------|----------|------|
| keyboard/IME 核心闭环 | ≈300 | 仍在 page 内 | **最大未收口阻塞** |
| viewport/lift 派生计算 | ≈30 | 分散在 page 内 | 可接受，依赖 keyboard state |
| copy menu JSX | ≈60 | 仍在 page 内 JSX | **P1 应迁出** |
| layoutProfile / orientation 派生 | ≈15 | 纯派生，可接受 | 可接受 |
| ImeAnchor listeners（4组） | ≈100 | 仍在 page | 属于 keyboard 闭环 |
| focusNonce / keepTerminalInputFocused | ≈10 | 仍在 page | 属于 keyboard 闭环 |
| terminalPagePropsEqual | ≈60 | 正确保留 | 属于 page shell 自身 |

### 2.2 已迁出的 page-local blocks（总计 990 行）

| 文件 | 行数 | owner 真相 |
|------|------|-----------|
| `useTerminalPageCopyRuntime.ts` | 197 | copy 状态机：active/start/end/menu、long-press 流程、自动/手动复制 |
| `useTerminalPageOverlays.ts` | 233 | overlay/sheet/schedule/screenshot/debug toggle 协调真相 |
| `useTerminalPageInteractionRuntime.ts` | 237 | interactiveSession、pane/session 路由、swipe/chrome-switch 协调真相 |
| `useTerminalPageShellActionsRuntime.ts` | 90 | tab-manager/quick-tab-picker/viewport-change 协调真相 |
| `useTerminalPageSavedTabRuntime.ts` | 170 | saved-tab 持久化 runtime 真相 |
| `useTerminalPageQuickBarActions.ts` | 63 | quickbar measured-height/draft/send-sequence 编排真相 |

### 2.3 已迁出的 page-local helper（总计 560 行）

| 文件 | 行数 | owner 真相 |
|------|------|-----------|
| `terminal-page-render-keys.ts` | 94 | session/page/ui identity key + rendered sessions epoch |
| `terminal-keyboard-lift.ts` | 58 | keyboard lift / layout viewport / header top inset 纯计算 |
| `terminal-copy-selection.ts` | 107 | copy selection 类型 + row coverage + text projection |
| `terminal-page-persisted-tabs.ts` | 113 | persisted-tab normalize/validate 纯函数 |
| `terminal-page-debug-helpers.ts` | 46 | debug rate/Hz/status 格式化纯函数 |
| `terminal-page-session-input.ts` | 13 | querySessionInput DOM 查询纯函数 |
| `terminal-page-shell-ui.tsx` | 129 | copyMenuButtonStyle + TerminalQuickBarShell + TerminalNetworkBanner JSX |
| `TerminalPageDebugOverlay.tsx` | 320 | DebugOverlay 完整 JSX 组件 |
| `TerminalPageStageShell.tsx` | 358 | StageShell 完整 JSX 组件 |

### 2.4 shared 层（packages/shared/src/terminal/）

| 文件 | owner 真相 |
|------|-----------|
| `terminal/copy-selection.ts` | 终端 buffer 到纯文本的转换，可跨 Android/Mac 复用 |
| `terminal/pane-split.ts` | pane 布局计算、split count options |
| `terminal/workspace.ts` | workspace 核心逻辑（pane/session 映射、激活、分配） |

## 3. keyboard/IME 主闭环审计（核心阻塞分析）

### 3.1 闭环依赖图

```
terminalKeyboardRequested ←→ keyboardInset
        ↓                       ↓
requestAndroidImeFocus ←→ updateKeyboardInset
        ↓                       ↓
updateTerminalKeyboardRequested ←→ ImeAnchor listener (keyboardState)
        ↓
restoreAndroidTerminalImeRoute → keepTerminalInputFocused
        ↓
focusTerminalInput → focusNonce → TerminalStageShell
```

**关键互依赖证据**：

- `keyboardViewportFreezeActive = isAndroid && (terminalKeyboardRequested || keyboardInset > 0)`：三态同判
- `restoreAndroidImeRoute` 触发条件：`!(terminalKeyboardRequested || keyboardInset > 0)`
- `requestAndroidImeFocus` 早期返回：`quickBarEditorFocusedRef.current`
- `quickBarEditorFocused` state 和 ref 不可分割（ref 为 async context 防 stale）
- ImeAnchor listeners 内持有 `activeSessionIdRef` 和 `terminalInputHandlerRef`
- `stableLayoutViewportHeightRef` 在 ImeAnchor listener 内被写入

### 3.2 不可切分类（绝对不可拆分）

1. `terminalKeyboardRequested ↔ keyboardInset ↔ quickBarEditorFocused` 三态互相依赖
2. `pendingAndroidImeFocusTimerRef ↔ requestAndroidImeFocus ↔ restoreAndroidTerminalImeRoute` timer 单向链
3. `activeSessionIdRef ↔ terminalInputHandlerRef ↔ ImeAnchor listeners` 跨模块闭包链
4. 4组 ImeAnchor listeners（input/backspace/keyboardState/show/hide）生命周期绑定
5. `stableLayoutViewportHeightRef` 被 keyboardState listener 和 viewport freeze effect 共同写入

### 3.3 唯一正确路线

**当前不存在可安全验证的小切片边界。**

- **路线 A（推荐）**：暂缓，等自然切片出现。主文件已从 ~2500 行压到 1371 行，keyboard 闭环 owner 已在 page-local 层级，不影响 shared/helper 层达标。
- **路线 B**：一次性大重构封装 `useTerminalPageKeyboardRuntime.ts`，收益约 300 行，但风险高，需要完整验证矩阵。

## 4. shared 层审计

### 4.1 当前状态

`packages/shared/src/terminal/` 包含 copy-selection、pane-split、workspace 三个纯函数模块。

### 4.2 评估

| 评估项 | 结论 |
|--------|------|
| 纯度 | ✅ 均为纯函数，无 React/DOM/Capacitor 依赖 |
| 跨端价值 | ✅ 具备跨 Android/Mac 复用价值 |
| 下沉时机 | ✅ 已正确下沉，无须回退 |
| 剩余机会 | page-local helper 中无明显满足 shared 纯度且有跨端价值的新候选 |

### 4.3 改进空间（低优先级）

1. **命名一致性**：`terminal-copy-selection.ts`（page-local）与 `terminal/copy-selection.ts`（shared）命名模式不一致，建议统一
2. **入口收敛**：建议增加 `packages/shared/src/terminal/index.ts` 做 barrel export

## 5. copy menu JSX 迁出（P1 改进项）

### 5.1 当前状态

`TerminalPage.tsx` 约第 1114-1170 行内嵌 copy menu JSX（约 60 行 JSX）。

### 5.2 owner 判定

- **当前 owner**：`TerminalPage.tsx`（不正确）
- **正确 owner**：`useTerminalPageCopyRuntime.ts`（状态真相）+ 独立 `TerminalPageCopyMenu.tsx` 组件（JSX 渲染）
- **原因**：menu 的 visible/position/style 真相已在 `useTerminalPageCopyRuntime` 的 `copySelection.menu` 中，JSX 只是消费者

### 5.3 迁移方案

```
新建：android/src/pages/TerminalPageCopyMenu.tsx
职责：消费 copySelection.menu + handleCopySelectionStart/End/Close
接口：menu + viewportWidth + headerTopInsetPx + onSetStart + onSetEnd + onCopy + onClose
验证：copy menu visibility/position/render 定向测试
```

**这是当前主文件内唯一一块可安全独立验证、且不依赖 keyboard/IME 闭环的高收益迁出。**

## 6. terminalPagePropsEqual 审计

- **当前 owner**：`TerminalPage.tsx`（正确）
- **判定**：属于 page shell 自身的编排优化逻辑，依赖 `terminal-page-render-keys.ts` 中的函数
- **结论**：外抽会引入 TerminalPageProps 类型导出依赖，增加模块耦合；保留在 page 内是正确的

## 7. 改进空间汇总

| 优先级 | 改进项 | 收益 | 风险 | 状态 |
|--------|--------|------|------|------|
| **P1** | copy menu JSX 迁出 | 中（≈60行） | 低 | **待实施** |
| P2 | keyboard/IME 整体大重构 | 高（≈300行） | 高 | 可选 |
| P3 | shared 入口 barrel 收敛 | 低（命名一致性） | 无 | 可选 |
| P4 | 命名统一 | 低（仅一致性） | 无 | 可选 |

## 8. 验证证据清单

| 验证项 | 命令 | 当前结果 |
|--------|------|----------|
| TypeScript 编译 | `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` | ✅ 0 错误 |
| 定向测试 | targeted vitest（7 files） | ✅ 7 files, 62 tests passed |
| 主文件行数 | `wc -l android/src/pages/TerminalPage.tsx` | 1371 行 |
| 已迁出 blocks | 6 个 runtime hook + 2 个独立组件 | 全部 tsc 通过 |
| shared 层 | `packages/shared/src/terminal/` 纯函数 | 全部 tsc 通过 |

## 9. 唯一性论证

**为什么当前 owner 划分是唯一正确的？**

1. **shared/helper 归属**：纯逻辑（无 React/DOM/Capacitor 依赖）下沉 shared；带平台依赖的留在 page-local helper。当前 page-local helper 均满足边界（被 TerminalPage 直接消费，不应混入 shared）。

2. **runtime blocks 归属**：每个 runtime 持有不可分割的页面级状态真相。copy/overlay/interaction/shell-actions/saved-tab/quickbar 每个都有唯一 owner 文件，任何拆分都会制造双 owner 或循环依赖。

3. **keyboard/IME 闭环**：该闭环内的 5 state + 7 refs + ImeAnchor/Keyboard listeners 形成不可拆解的依赖图，小切片迁移必然引入双 owner。继续拆分只有路线 B（整体封装 hook）一条路。

4. **copy menu JSX**：menu 的状态真相已在 `useTerminalPageCopyRuntime`，JSX 只是消费者，迁到独立组件不会制造双 owner，是安全的下一步。

5. **terminalPagePropsEqual**：属于 page shell 自身的编排优化，依赖 page-local helper 函数，保留在 page 内是正确的。

## 10. 下一步建议

### 近期（低风险）

实施 P1：copy menu JSX 迁到独立 `TerminalPageCopyMenu.tsx` 组件。

### 中期（需专门设计）

若要彻底收口，走路线 B：设计 `useTerminalPageKeyboardRuntime.ts` 整体封装方案，包括接口设计、lifecycle 绑定、验证矩阵、迁移顺序。

---

审计完成时间：2026-05-24
审计人：Codex agent
验证基线：tsc 0 错误，62 tests passed
