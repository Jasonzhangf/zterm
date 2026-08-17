# TerminalPage 架构审计报告 v2
> 日期：2026-05-24（补充）
> 基于：v1 审计 + 当时代码现状 + tsc 测试验证

## 一、验证基线（当前可信状态）

```bash
# targeted tests — 全绿
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

# type-check — 有 2 个错误（见 2.1 节）
pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false
```

```bash
# 当前行数
TerminalPage.tsx                  879 行
useTerminalPageKeyboardRuntime.ts 573 行
```

## 二、当前代码状态（审计快照）

### 2.1 阻断级问题：tsc 2 个错误

**文件**：`useTerminalPageKeyboardRuntime.ts`

| 行 | 错误 | 原因 | 修复方向 |
|----|------|------|---------|
| 102 | `landscape` declared but never read | 变量计算了但未使用 | 删掉或加入 return |
| 551 | `landscape` missing in return object | 类型签名要求 return，但实际未 return | 加入 return |

**根因**：上一轮 agent 把 `landscape` 往 keyboard hook 里收了一半（加了类型 + 计算），但**没完成 wiring 和接线验证**，停在半完成状态。

**影响**：tsc 阻断，但测试仍全绿（测试没覆盖这一块）。

**唯一正确修复**：确认 `landscape` 是否值得留在 keyboard hook：
- 若留：补 return 并确认 TerminalPage 侧删除自己的 `landscape` 计算
- 若不留：删掉 hook 里的 `landscape` 相关代码，回退到稳定态

### 2.2 已验证的三层架构状态

#### Layer 0 — pure helpers（✅ 完全达标）
| 文件 | 行数 | 验证 |
|------|------|------|
| `terminal-page-render-keys.ts` | 94 | 零 platform 依赖 |
| `terminal-keyboard-lift.ts` | 58 | 零 platform 依赖 |
| `terminal-copy-selection.ts` | 107 | 零 platform 依赖 |
| `terminal-page-persisted-tabs.ts` | 113 | 零 platform 依赖 |
| `terminal-page-debug-helpers.ts` | 46 | 零 platform 依赖 |
| `terminal-page-session-input.ts` | 13 | 零 platform 依赖 |
| `terminal-page-quickbar-adapters.ts` | ~20 | 零 platform 依赖 |
| `terminal-page-shell-ui.tsx` | 129 | JSX helper，无 React state |
| **合计** | ~580 | ✅ |

#### Layer 1 — page-local blocks（✅ 完全达标）
| 文件 | 行数 | owner 真相 |
|------|------|-----------|
| `useTerminalPageCopyRuntime.ts` | 197 | copy 状态机 |
| `useTerminalPageOverlays.ts` | 233 | overlay/sheet 协调 |
| `useTerminalPageInteractionRuntime.ts` | 237 | pane/session/swipe 路由 |
| `useTerminalPageShellActionsRuntime.ts` | 90 | tab picker/viewport change |
| `useTerminalPageSavedTabRuntime.ts` | 170 | saved-tab 持久化 |
| `useTerminalPageQuickBarActions.ts` | 63 | quickbar height/draft/send |
| `TerminalPageDebugOverlay.tsx` | 320 | DebugOverlay JSX |
| `TerminalPageStageShell.tsx` | 358 | StageShell JSX |
| **合计** | ~1668 | ✅ 无跨页泄露 |

#### Layer 2 — orchestration shell

**`TerminalPage.tsx` 当前持有的 owner**：

| owner | 行数估算 | 判定 | 说明 |
-------|---------|------|------|
| keyboard/IME 主闭环 | ~280 | ⚠️ 已在 keyboard hook 里，但 tsc 阻断 | 需先修 tsc |
| viewport metrics 编排 | ~40 | ⚠️ 在 page 内，且 keyboard hook 里也有 | **重复定义**，需统一 |
| page-shell 派生计算 | ~15 | ✅ 可接受 | `layoutProfile` / `terminalChromeBottomPx` |
| copy menu JSX | 已迁出 | ✅ | `TerminalPageCopyMenu.tsx` |
| `terminalPagePropsEqual` | ~60 | ✅ 正确保留 | page shell 自身逻辑 |
| `React.memo` 包装 | 2 行 | ✅ | 无需动 |
| `landscape` 计算 | ~3 行 | ⚠️ 和 keyboard hook 重复 | 见 2.3 节 |

## 三、改进空间详细评估

### 3.1 P0 — 必须修复（阻断）

#### P0.1：`landscape` 半完成状态（tsc 阻断）

**现状**：
- keyboard hook 里有 `landscape` 计算 + return 类型定义
- 但 return 语句里没有 return `landscape`
- TerminalPage 里仍有自己的 `landscape` 计算
- tsc 报错，阻断构建

**两个互斥选项**：

**选项 A：landscape 留在 keyboard hook**
- 补 `return { landscape, ... }`
- TerminalPage 删除自己的 `landscape` 计算（已迁入 keyboard hook 的 `useMemo` 就近计算更合理）
- 验证 tsc 通过

**选项 B：landscape 保留在 page-shell**
- 删掉 keyboard hook 里的 `landscape` 相关代码（类型 + 计算）
- 恢复 green baseline（tsc 0 error）

**唯一性论证**：`landscape` 是纯派生值，不持有任何状态。它最适合放在**被使用处就近的 useMemo**。Keyboard hook 里已经有了完整的 `window` guard 和 `resolveTerminalOrientation` import。Page-shell 的 `landscape` 只在 `layoutProfile` useMemo 里用了一次。两种方案都是合理的，但**不能两边都算**，必须选一个作为唯一真源。当前选项 A 更合理（keyboard hook 已有完整 platform 判断逻辑），但上一轮没有完成接线就停了。本轮应先确认选项 A 是否能完成，如果不能则选 B 回退。

#### P0.2：viewport metrics 重复定义

**现状**：
- `viewportWidth` / `headerTopInsetPx` / `updateViewportMetrics` / `scheduleViewportMetricsSync` / `viewportMetricsFrameRef` **同时存在于 keyboard hook 和 TerminalPage**
- keyboard hook 有自己的 `viewportWidth` state + `updateViewportMetrics` + `scheduleViewportMetricsSync`
- TerminalPage 有自己的 `viewportWidth` state + `updateViewportMetrics` + `scheduleViewportMetricsSync` + `viewportMetricsFrameRef`
- TerminalPage 的 `scheduleViewportMetricsSync` 还额外调用了 `keyboardScheduleViewportMetricsSync()`

**分析**：
这个重复是有意为之的分阶段迁移（keyboard hook 先承接 keyboard 真相，page 暂留 viewport metrics），但现在两个 owner 各自持有一份 state，造成：
- 状态可能不同步
- 两份 lifecycle（effect / animation frame）各自跑
- `viewportMetricsFrameRef` 在两处各有一份

**唯一正确路线**：viewport metrics 应该统一到一个 owner。有两个选项：

**选项 A：viewport metrics 整体迁入 keyboard hook**
- keyboard hook 已经持有完整的 `viewportWidth` / `headerTopInsetPx` state 和 `updateViewportMetrics` / `scheduleViewportMetricsSync`
- TerminalPage 里的 viewport metrics 代码全部删除
- TerminalPage 从 keyboard hook 读取这两个 state
- 验证：tsc + targeted tests + Android IME smoke

**选项 B：viewport metrics 留在 page-shell，删掉 keyboard hook 里的副本**
- keyboard hook 里的 `viewportWidth` / `headerTopInsetPx` state 删除
- keyboard hook 只保留 `viewportMetricsFrameRef`（供其他派生使用）
- TerminalPage 继续持有 viewport metrics state
- 验证：tsc + targeted tests

**推荐选项 A**：理由同 `landscape`，viewport metrics 在 keyboard hook 里已经有完整的计算和同步逻辑；统一到一个 owner 避免重复 lifecycle。

### 3.2 P1 — 架构实质性收益

#### P1.1：keyboard/IME 主闭环真正收口

当 P0.1 + P0.2 修完后，keyboard hook 的 wiring 就完整了。此时 `TerminalPage.tsx` 里应该只剩：
- hooks 装配（各 runtime 的 props 编排）
- JSX 组合
- page-shell 派生（`layoutProfile` / `terminalChromeBottomPx`）
- `terminalPagePropsEqual` + `React.memo`

**预期行数**：879 行 → ~650 行（压缩 ~26%）

#### P1.2：`layoutProfile` useMemo 是否可入 helper

当前 `layoutProfile` 依赖 `splitVisible` / `headerTopInsetPx` / `landscape`。
如果 landscape 和 viewport metrics 统一到 keyboard hook 后，`layoutProfile` 只依赖两个 hook 返回值，可以考虑把 `resolveTerminalLayoutProfile` 的调用本身变成一个极薄的 `useLayoutProfile` hook（纯派生，无 state）。

但收益极低（~10 行），不建议作为独立任务投入。

### 3.3 P2 — 低优先级

| 改进项 | 状态 | 说明 |
|-------|------|------|
| `handleActiveTerminalActivateInput` 内联 | 当前是 3 行薄包装 | 可直接内联到 JSX，收益极低 |
| `keyboardViewportFreezeActive` 在 keyboard hook return 但 page 未使用 | keyboard hook 有但 TerminalPage 没 destructure | 应确认是否需要 |

## 四、已证伪路线（不要再走）

| 路线 | 结论 | 证据 |
|------|------|------|
| keyboard/IME 小切片 | ❌ 已证伪 | 三态互相触发，state/ref 不可分割 |
| `terminalPagePropsEqual` 外抽 | ❌ 已证伪 | 低收益高复杂度，不改架构实质 |
| quickbar assembly 回灌 page | ❌ 已证伪 | 已稳定落地 |
| `sessionViewportModeStoreRef` 并入 keyboard hook | ❌ 已证伪 | 属于 shell-actions/debug overlay 消费链 |
| viewportWidth/headerTopInsetPx 并入 keyboard hook | ❌ 上轮证伪 | 会形成依赖环 |

## 五、架构一致性综合判定

| 层级 | 达标 | 说明 |
|------|------|------|
| Layer 0 pure helpers | ✅ 完全达标 | 580 行，零 platform 依赖 |
| Layer 1 page-local blocks | ✅ 完全达标 | 1668 行，边界清晰，无跨页泄露 |
| Layer 2 orchestration shell | ⚠️ 接近达标 | 需先修 P0（tsc 阻断 + viewport metrics 重复） |
| shared 层扩展 | ⚠️ 条件成熟 | 当前无跨端复用需求，暂无新增必要 |

## 六、改进空间优先级

| 优先级 | 改进项 | 当前状态 | 目标状态 | 推荐行动 |
|-------|-------|---------|---------|---------|
| **P0 — 修阻断** | `landscape` tsc 错误 | tsc 报错，landscape 半完成 | tsc 0 error | 确认 A（留 hook）或 B（回退 page），补完整 wiring |
| **P0 — 修阻断** | viewport metrics 重复定义 | 两处各持 state + lifecycle | 统一到一个 owner | 推荐选项 A（迁入 keyboard hook） |
| **P1** | keyboard/IME 主闭环真正收口 | hook wiring 完成后只剩 hooks 装配 | TerminalPage ~650 行 | P0 修完后自然达成 |
| **P2** | `keyboardViewportFreezeActive` page 侧未使用 | keyboard hook return 了但 page 没 destructure | 确认是否需要后清理 | 小优化 |

## 七、唯一性说明

**为什么 P0 两个改进必须一起做？**

`landscape` 和 `viewport metrics` 都在 keyboard hook 里已经有了完整实现，但 TerminalPage 侧还保留着各自的副本。如果只修 `landscape` 不修 viewport metrics，page 里仍有 `viewportWidth` state + `updateViewportMetrics` + `scheduleViewportMetricsSync`，形成两个 owner 各自跑 lifecycle。必须统一到一个 owner 才能彻底消除重复。

**为什么 keyboard hook 选项 A 是唯一正确路线（而非回退到 page）？**

keyboard hook 已经有完整的 `window` guard、`resolveWindowWidth`/`resolveTerminalHeaderTopInsetPx` import、`visualViewport` 相关的节流逻辑。viewport metrics 的核心语义（窗口尺寸变化触发重算）与 keyboard/IME 强相关（keyboard show/hide 同时触发 viewport resize），放在同一 hook 内是最自然的 owner 边界。回退到 page 只会保留两份重复定义，不解决任何架构问题。

## 八、附录：历史迁移轨迹（更新至 v2）

| 日期 | Slice | 操作 | 行数变化 |
|------|-------|------|---------|
| 2026-05-24 | v1 | 批量迁出 overlay/copy/interaction/shell-actions/saved-tab | ~2500 → ~1371 |
| 2026-05-24 | v1 后 | keyboard hook 尝试迁移 landscape | keyboard hook: 0 → 573 |
| 2026-05-24 | v2 | 确认当前状态：tsc 阻断 + viewport metrics 重复 | page: 879 |

## 九、/goal 提示词

见 `android/docs/goals/terminal-page-orchestration-refactor-v2-plan.md`
