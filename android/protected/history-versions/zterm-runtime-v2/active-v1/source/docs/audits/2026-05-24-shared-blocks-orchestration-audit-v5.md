# zterm Android 架构审计报告 v5：共享函数库 + blocks + 纯编排现状审计（工作树快照）

- 日期：2026-05-24
- 审计对象：`/Volumes/extension/code/zterm/android`
- 审计范围：`android/src/pages/TerminalPage.tsx` 及其已拆出的 page-local files
- 审计目的：基于当前工作树快照，判断距离“真正纯编排壳”还差什么

## 1. 当前快照结论

### 1.1 结论

当前架构已经明显沿着以下方向稳定推进：

- `shared/helper leaf`：已成型
- `page-local blocks`：已形成多个真实 owner
- `orchestration shell`：**仍未达标**

**最新真实状态：`TerminalPage.tsx` 已压到 `1371` 行，但还不是纯编排壳。**

### 1.2 当前验证证据

已通过：

```bash
pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false
```

```bash
pnpm --dir android exec vitest run   src/pages/useTerminalPageCopyRuntime.test.tsx   src/pages/useTerminalPageOverlays.test.tsx   src/pages/terminal-page-render-keys.test.ts   src/pages/terminal-keyboard-lift.test.ts   src/pages/terminal-copy-selection.test.ts   src/pages/TerminalPage.android-ime.test.tsx   src/pages/TerminalPage.render-scope.test.tsx   --reporter dot
```

结果：
- `7 files passed`
- `62 tests passed`
- `tsc` 无错误

## 2. 已抽出的真实 owner

### 2.1 runtime / block

| 文件 | 行数 | 当前 owner |
|------|------|------------|
| `useTerminalPageCopyRuntime.ts` | 197 | copy selection state machine |
| `useTerminalPageInteractionRuntime.ts` | 237 | interaction 派生态 / swipe / chrome-switch runtime |
| `useTerminalPageOverlays.ts` | 233 | overlays / sheet / debug / screenshot runtime |
| `useTerminalPageShellActionsRuntime.ts` | 90 | shell actions / viewport-mode coordinator |
| `useTerminalPageSavedTabRuntime.ts` | 170 | saved-tab persist/import/export runtime |
| `useTerminalPageQuickBarActions.ts` | 63 | quickbar forwarding actions |

### 2.2 helper / leaf

| 文件 | 行数 | 当前 owner |
|------|------|------------|
| `terminal-page-render-keys.ts` | 94 | render key / memo identity helper |
| `terminal-keyboard-lift.ts` | 58 | keyboard lift / viewport height helper |
| `terminal-copy-selection.ts` | 107 | copy helper / async cleanup logging |
| `terminal-page-persisted-tabs.ts` | 113 | persisted-tab normalize / convert helper |
| `terminal-page-debug-helpers.ts` | 46 | debug format / status helper |
| `terminal-page-session-input.ts` | 13 | DOM input query helper |

### 2.3 已迁出的独立 page-local 组件

| 文件 | 行数 | 当前 owner |
|------|------|------------|
| `terminal-page-shell-ui.tsx` | 129 | shell UI helpers / NetworkBanner / QuickBarShell |
| `TerminalPageDebugOverlay.tsx` | 320 | debug overlay component |
| `TerminalPageStageShell.tsx` | 358 | terminal stage rendering component |

### 2.4 extracted 总量

当前已从 `TerminalPage.tsx` 主文件拆出的 page-local / helper / subcomponent 总计约：

- **2228 行**

这说明当前路线不是“做了几个碎文件”，而是已经真实把大量 owner 迁出主 page。

## 3. 当前主文件真实状态

### 3.1 最新主文件行数

```text
android/src/pages/TerminalPage.tsx : 1371 行
```

### 3.2 主文件剩余 owner 分组

当前 `TerminalPage.tsx` 剩余内容大体分为 4 组：

1. **keyboard / IME 主闭环**
   - `terminalKeyboardRequested`
   - `keyboardInset`
   - `focusNonce`
   - `quickBarEditorFocused`
   - `pendingAndroidImeFocusTimerRef`
   - `androidImeFocusRouteKeyRef`
   - `terminalFocusRetryTimeoutsRef`
   - `stableLayoutViewportHeightRef`
   - `focusTerminalInput`
   - `requestAndroidImeFocus`
   - `restoreAndroidTerminalImeRoute`
   - `keepTerminalInputFocused`
   - keyboard / ImeAnchor listeners
   - toggle keyboard / editor focus 相关 effect

2. **viewport / shell-height 外围 utility**
   - `viewportWidth`
   - `headerTopInsetPx`
   - `viewportMetricsFrameRef`
   - `updateViewportMetrics`
   - `scheduleViewportMetricsSync`
   - `rawShellHeight` / `shellHeight`

3. **page-level orchestration shell**
   - 主 JSX 组合
   - hooks 装配
   - props 透传
   - sheets / overlay / stage / quickbar / debug overlay 组装

4. **少量残余 page wiring**
   - `handleSwitchSessionFromChrome` 这种正确的薄包装
   - copy menu JSX（依赖 `viewportWidth` / `headerTopInsetPx` / copySelection）

## 4. 当前最大阻塞

### 4.1 keyboard / IME 闭环仍是主阻塞

当前最难切的不是 JSX，而是 keyboard/IME 主闭环。

它同时耦合：
- keyboard visible state
- native `ImeAnchor`
- `Keyboard` listener
- viewport freeze
- quickbar editor focus
- focus retry
- DOM input query
- shell height 计算

这组逻辑现在仍是 **主 page 里最重、最危险、最难切的 owner**。

### 4.2 不能误判为“接近完成”

虽然 `TerminalPage.tsx` 已从更高体量压到 `1371` 行，但离目标文档要求的：

- “只剩编排、hooks 装配和 JSX 组合”

还不满足。

因为当前主文件仍然承载：
- keyboard/IME 运行态真相
- viewport metrics / shell height 主逻辑
- 多个 lifecycle effect owner

## 5. 当前最合理的下一步

### 5.1 不建议

当前**不建议**：
- 为了继续降行数去硬拆 keyboard/IME 主闭环
- 再去抠低收益的小按钮/单行 helper
- 回头动已经稳定的 copy/overlay/interaction owner

### 5.2 建议的唯一正确方向

下一步应该做的是：

1. **对剩余 keyboard/IME 闭环做“外围壳 vs 真闭环”二次审计**
2. 只切出那些：
   - 不持有 keyboard 真相
   - 不引入 page ↔ hook 循环依赖
   - 可独立验证的小片段
3. 如果审计后仍证明无安全切片，则接受：
   - 当前主阻塞就是 keyboard/IME 主闭环
   - 后续需要更大规模的专门 closeout，而不是碎片化继续抽

## 6. `/goal` 建议文本

```text
/goal
目标：继续把 `android/src/pages/TerminalPage.tsx` 收成真正纯编排壳；在已完成 helper / copy / overlays / interaction / saved-tab / shell-ui / debug component / stage component 收口的基础上，继续清掉主文件剩余 owner，最终逼近“只剩编排 + hooks 装配 + JSX 组合”。

实现文档：
- `android/docs/goals/terminal-page-orchestration-refactor-plan.md`
- `android/docs/audits/2026-05-24-shared-blocks-orchestration-audit-v5.md`

执行规范：
- 先验证后结论；无 `tsc` 与 targeted tests 绿，不宣称完成
- 不做 fallback，不保留双真源，不允许“只搬文件不删旧 owner”的假重构
- 优先继续切高收益独立 page-local owner；对 keyboard/IME 主闭环只做证据驱动切片，不硬拆

验证：
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm --dir android exec vitest run src/pages/useTerminalPageCopyRuntime.test.tsx src/pages/useTerminalPageOverlays.test.tsx src/pages/terminal-page-render-keys.test.ts src/pages/terminal-keyboard-lift.test.ts src/pages/terminal-copy-selection.test.ts src/pages/TerminalPage.android-ime.test.tsx src/pages/TerminalPage.render-scope.test.tsx --reporter dot`
- 跟踪 `TerminalPage.tsx` 行数，当前 `1371`

完成标准：
- `TerminalPage.tsx` 只剩 hooks 装配、极薄 handler 包装、JSX 编排
- keyboard/overlay/copy/interaction/saved-tab/shell-actions/stage/debug 各有唯一 owner
- page 不再持有可独立命名的 runtime/coordinator 真相
- `tsc` 0 错误，targeted tests 全绿
- summary 必须说明为什么当前 owner 划分是唯一正确的
```

## 7. 最终判断

**结论：当前已取得实质性收口，但仍未完成目标。**

当前最重要的事实不是“还没做完”，而是：
- 路线对了
- 已拆出 2200+ 行 page-local / helper / subcomponent owner
- `TerminalPage.tsx` 已压到 1371 行
- 下一阶段真正的主阻塞已经收敛到 keyboard/IME 主闭环

这就是当前工作树的真实快照。
