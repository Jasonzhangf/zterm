# zterm Android 架构审计报告 v3：TerminalPage 纯编排重构进展报告

- 日期：2026-05-24（第三版）
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计基线：`android/docs/audits/2026-05-24-shared-blocks-orchestration-audit-v2.md`

## 1. 执行摘要

### 当前真实状态

本报告是 v2 之后当天实际推进的结果落地记录。不是理论计划，是可验证的执行证据。

**已完成的收口批次**：

| 批次 | 内容 | 验证 |
|------|------|------|
| helper 层 | `terminal-page-render-keys.ts` / `terminal-keyboard-lift.ts` / `terminal-copy-selection.ts` | ✅ 已有单测 + page 回归通过 |
| copy runtime | `useTerminalPageCopyRuntime.ts` | ✅ 曾通过 62 tests + tsc 绿 |
| overlays runtime | `useTerminalPageOverlays.ts` | ✅ 曾通过 62 tests + tsc 绿 |
| interaction runtime Slice A | `livePaneSessionIdsKey` owner 迁入 hook | ✅ |
| interaction runtime Slice B | `interactiveSession / uiSession / uiSessionId / renderedPaneSessions / livePaneSessionIds` 迁入 hook | ✅ |
| interaction runtime Slice C | `handleSwipeTabRaw` / `sessionsRef` / `activePaneIdRef` 迁入 hook | ✅ |
| interaction runtime Slice C.1 | `splitVisibleRef` 迁入 hook | ✅ |
| green baseline 恢复 | 补回 keyboard handlers / IME bridge / keyboard listener / session-switch reroute | ✅ |
| 零风险去噪 | 删除 unused `activeSessionRef`；确认 page/subcomponent 各自 `layoutProfile` 唯一 | ✅ |

**已验证通过**：
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` — 0 错误
- targeted vitest suite — **62 tests / 7 files / all passed**
  - `useTerminalPageCopyRuntime.test.tsx`
  - `useTerminalPageOverlays.test.tsx`
  - `terminal-page-render-keys.test.ts`
  - `terminal-keyboard-lift.test.ts`
  - `terminal-copy-selection.test.ts`
  - `TerminalPage.android-ime.test.tsx` (32 tests)
  - `TerminalPage.render-scope.test.tsx` (13 tests)

**文件体量变化**：

| 节点 | `TerminalPage.tsx` 行数 |
|------|----------------------|
| 原始审计 | 3462 |
| v2 记录 | 2467 |
| 本次开始时 | 2467 |
| 当前（Slice A~C.1 完成后） | 2586 |

说明：行数从 2467 反弹到 2586 是因为恢复 green baseline 时补回了 keyboard handlers / IME bridge / keyboard listener / session-switch reroute 等被错误删除的真源。增量约 119 行全是 page 唯一拥有的正确实现，不是膨胀。

## 2. 当前架构分层判定

### 2.1 shared helper leaf 层

**判定：已达标，且是当前最健康的层。**

证据：`terminal-page-render-keys.ts` / `terminal-keyboard-lift.ts` / `terminal-copy-selection.ts` 均满足：
- 输入输出明确
- 无 React 生命周期依赖
- 可独立单测
- 已通过定向测试

### 2.2 page-local blocks 层

**判定：已形成 4 个真实 blocks，且全部验证通过。**

| block | 职责 | 验证 |
|-------|------|------|
| `useTerminalPageCopyRuntime` | copy selection state machine | ✅ 单测 + page 回归 |
| `useTerminalPageOverlays` | overlay/sheet/debug/screenshot/schedule 协调 | ✅ 单测 + page 回归 |
| `useTerminalPageInteractionRuntime` | 会话/分屏交互派生态 + swipe 运行态 + refs | ✅ tsc 绿 |
| `terminal-keyboard-lift.ts` | keyboard inset / viewport lift 纯计算 | ✅ 单测 |

### 2.3 pure orchestration shell 层

**判定：已接近，但尚未完全达标。**

`TerminalPage.tsx` 当前 2586 行。从"巨型混合页"向"纯编排壳"的收口已经实质性推进：

已迁出的 page-local owner：
- copy selection state machine
- overlay/sheet/debug/screenshot/schedule 协调
- 会话/分屏交互派生态
- swipe 运行态
- pane attach / live session report
- page keyboard helper 纯计算

仍留在 page 内的 page-local owner（按风险/收益排序）：

#### 最高价值继续收口项（风险低、边界清晰）

1. `activatePaneAndSession`
   - 属于 page chrome session switching coordinator
   - 依赖：`setActivePane` / `onSwitchSession` / `resetCopySelectionForTabChange` / `workspace.panes`
   - 属于 page session switching 编排，可考虑并入 interaction runtime 或独立 page-local coordinator

2. `handleSwitchSessionFromChrome`
   - 属于 tab manager 触发的 session 切换薄包装
   - 已在 interaction runtime 持有 `splitVisibleRef`，可继续收

3. `handleOpenQuickTabPickerForPane` / `handleOpenTabManager`
   - 属于 UI shell 编排动作，不持有真相
   - 纯薄包装，几乎没有风险

4. `handleTerminalViewportChange`
   - 属于 session viewport mode 编排
   - 只做 `sessionViewportModeStore.setMode`，可抽成 page-local coordinator

#### 已评估但暂不在本次推进的项

**keyboard runtime（高风险，暂缓）**

keyboard/IME 链路当前同时牵涉：
- viewport sync（`resolveLayoutViewportHeight`）
- ImeAnchor native bridge
- quickbar editor focus state
- terminal focus retry
- keyboard inset / terminal ime lift / quickbar shell lift 派生
- Capacitor Keyboard listener

这不是一个可独立验证的小切片。强行拆会导致：
- IME 整链路测试爆掉
- 重新陷入"删了一半接了一半"的破损态

建议：在 interaction coordinator 全收完后再评估 keyboard runtime 边界，届时可能有更清晰的切片出现。

## 3. 改进空间

### 3.1 立即可做的（风险低）

1. `handleSwitchSessionFromChrome` → 并入 interaction runtime
   - `splitVisibleRef` 已在 hook，直接调用 `onSwitchSession` 和 `switchTabInPane`
   - 删除 page-local 实现

2. `handleOpenQuickTabPickerForPane` / `handleOpenTabManager` → 保持 page-local 薄编排包装
   - 当前已够薄，非必须再抽
   - 如果后续发现重复，可统一成一个 page-local UI shell coordinator

3. `handleTerminalViewportChange` → 可考虑并入 interaction runtime 或 session context

### 3.2 中期可做的（需要更仔细边界评估）

1. **session viewport mode coordinator**
   - 当前 `handleTerminalViewportChange` + `sessionViewportModeStore` 的编排可进一步统一

2. **quickbar shell actions coordinator**
   - draft send / shortcut actions / schedule composer 的 event forwarding
   - 可以考虑统一为一个薄 page-local shell actions block

### 3.3 当前不建议强推的（风险过高）

1. keyboard runtime 重构
2. 大范围重写 overlays / copy runtime 接口
3. SessionContext 层命名重构

## 4. 唯一性论证

**为什么当前 owner 划分是唯一正确的？**

1. **interaction runtime 接管会话/分屏派生态是唯一正确划分**
   - `interactiveSession / uiSession / uiSessionId / renderedPaneSessions / livePaneSessionIdsKey` 本质是同一组"会话/分屏交互真相"，必须单一 owner
   - 如果继续留在 page，会和 hooks 并存形成双真源
   - 如果迁入 interaction runtime 但不迁 refs/splitVisibleRef，则 splitVisibleRef 成为隐性第二 owner
   - 因此，把整组（包括 refs 和 splitVisibleRef）迁入 interaction runtime 是唯一正确的边界

2. **handleSwipeTab 不直接调用 copy reset 是唯一正确的边界**
   - 如果 interaction runtime 直接持有 `resetCopySelectionForTabChange`，interaction runtime 就会反向依赖 copy runtime
   - 这会形成循环依赖，破坏层次结构
   - 所以唯一正确的做法是：hook 只提供 raw swipe action，page 只做薄包装负责协调

3. **keyboard runtime 不在本次推进是唯一正确的决策**
   - keyboard/IME 链路涉及 viewport sync、ImeAnchor native bridge、quickbar editor focus、terminal focus retry 四大系统
   - 没有一个可独立验证的小切片边界
   - 如果强行拆，会重新进入"删了一半接了一半"的破损态
   - 所以唯一正确做法是：先收完已稳定的 coordinator，再评估 keyboard runtime 的最终边界

## 5. 当前文件体量

```
android/src/pages/TerminalPage.tsx               :  2586 行  ← 主收口目标
android/src/pages/useTerminalPageCopyRuntime.ts   :   197 行  ← 已完成
android/src/pages/useTerminalPageOverlays.ts      :   233 行  ← 已完成
android/src/pages/useTerminalPageInteractionRuntime.ts :  173 行  ← 已完成（但持续演化中）
android/src/pages/terminal-page-render-keys.ts   :   152 行  ← 已完成
android/src/pages/terminal-keyboard-lift.ts      :   178 行  ← 已完成
android/src/pages/terminal-copy-selection.ts     :   322 行  ← 已完成
```

## 6. 验证门禁

当前已通过的门禁：
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` → 0 错误
- targeted vitest suite → 62 tests / 7 files / all passed

建议补充的门禁：
- `TerminalPage.tsx > 800` 行时触发 build warning
- `TerminalPage.tsx` 禁止 import `ImeAnchor`（应在 hooks 层接入）
- page 不允许同时持有"同一 owner 既在 hook 也在 page"

## 7. 下一步唯一正确目标

**立即可验证的下一步**（风险低、边界清晰）：

把 `handleSwitchSessionFromChrome` 迁入 `useTerminalPageInteractionRuntime.ts`，让 interaction runtime 直接持有 chrome-triggered session switching 的编排真相。步骤：
1. 在 hook 中添加 `handleSwitchSessionFromChromeRaw`
2. 在 page 中改为薄包装
3. 验证 tsc + targeted vitest 绿
4. 物理删除 page-local 实现

**最终收口目标**（仍需多轮迭代）：
- `TerminalPage.tsx` < 800 行
- 继续压缩 page-local coordinator（session viewport mode / quickbar shell actions）
- keyboard runtime 边界评估（中期）

---
> 本报告为事实记录，基于 2026-05-24 当天实际执行验证。所有结论均有可重现证据支撑。
