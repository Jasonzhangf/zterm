# TerminalPage 架构审计报告（终版）

- 日期：2026-05-24
- 范围：`android/src/pages/TerminalPage.tsx` 及已迁出 page-local 模块
- 目标：判断当前是否已达到“共享函数库 + blocks + 纯编排”

## 1. 结论

当前架构方向正确，已大体符合“共享函数库 + blocks + 纯编排”，但还没有完全闭环。

当前判断：
- shared/helper 层：基本达标
- page-local blocks 层：基本达标
- orchestration shell 层：接近达标，但 `TerminalPage.tsx` 仍残留少量 shell-level owner
- keyboard runtime：正在收口，但当前存在半完成改动，`tsc` 未绿

最准确的结论是：主干分层已成立，但最后一层纯编排壳尚未彻底完成。

## 2. 已验证证据

代码事实：
- `android/src/pages/TerminalPage.tsx`：879 行
- `android/src/pages/useTerminalPageKeyboardRuntime.ts`：573 行

`tsc` 结果：失败，2 个错误

```text
src/pages/useTerminalPageKeyboardRuntime.ts(102,9): error TS6133: 'landscape' is declared but its value is never read.
src/pages/useTerminalPageKeyboardRuntime.ts(551,3): error TS2741: Property 'landscape' is missing in type ...
```

targeted tests 结果：通过

```text
7 files passed
62 tests passed
```

说明：运行时主路径基本稳定，但 keyboard runtime 的 owner 迁移没有完全闭合。

## 3. 分层审计

### 3.1 shared/helper 层

已具备 shared/helper 特征的文件：
- `terminal-page-render-keys.ts`
- `terminal-keyboard-lift.ts`
- `terminal-copy-selection.ts`
- `terminal-page-persisted-tabs.ts`
- `terminal-page-debug-helpers.ts`
- `terminal-page-session-input.ts`

判断：
- 纯函数/纯投影逻辑已从 page 主文件物理迁出
- 这层已经基本符合目标
- 但它们多数仍是 page-local helper，不必为了“共享”而强行下沉到 `packages/shared`

结论：这一层达标。

### 3.2 blocks / page-local runtime 层

已建立明确 owner 的 blocks：
- `useTerminalPageCopyRuntime.ts`
- `useTerminalPageOverlays.ts`
- `useTerminalPageInteractionRuntime.ts`
- `useTerminalPageShellActionsRuntime.ts`
- `useTerminalPageSavedTabRuntime.ts`
- `useTerminalPageQuickBarActions.ts`
- `useTerminalPageKeyboardRuntime.ts`

判断：
- copy / overlay / interaction / shell-actions / saved-tab / quickbar 的唯一真源已经离开 page
- 这层已经形成稳定的 page-local blocks 模式

结论：这一层基本达标。

### 3.3 orchestration shell 层

`TerminalPage.tsx` 仍保留：
- viewport metrics 相关 owner
- `landscape` / `layoutProfile` / `terminalChromeBottomPx` 等壳层派生
- 少量薄包装 callback
- `terminalPagePropsEqual`

判断：
- page 已经不再承载大块 runtime 真相
- 但还不是完全纯编排壳
- 最大问题不是行数，而是 viewport metrics 与 keyboard runtime 之间存在 owner 未收口迹象

结论：接近达标，但未完全达标。

## 4. 当前最大阻塞

`useTerminalPageKeyboardRuntime.ts` 中，`landscape` 迁移处于半完成状态：
- hook 中已声明 `landscape`
- 结果类型已要求 `landscape`
- return 对象未返回 `landscape`
- `TerminalPage.tsx` 仍自行计算 `landscape`

这说明 keyboard runtime 的 owner 迁移没有闭合。

这也是当前唯一必须先处理的点，因为它已经形成明确门禁失败：
- `tsc` 不绿
- owner 不唯一

## 5. 改进空间

### P0：先恢复 keyboard runtime 契约闭合

必做：
- 修复 `useTerminalPageKeyboardRuntime.ts` 当前 2 个 tsc 错误
- 明确 `landscape` 的唯一 owner
- 恢复 `tsc --noEmit` 全绿
- 回归当前 7 个 targeted tests

这是唯一正确的起点。

### P1：统一 viewport metrics owner

当前 page 与 keyboard hook 都持有 viewport metrics 相关实现倾向。

正确方向应二选一：
- 统一归 keyboard runtime
- 或单独抽为 `useTerminalPageViewportMetrics.ts`

审计建议：优先评估独立 `useTerminalPageViewportMetrics.ts`，因为 viewport metrics 本质更像 shell geometry owner，而不是 IME owner。

### P2：把 page 收成更纯的壳

可继续收口：
- `layoutProfile`
- `terminalChromeBottomPx`
- 少量超薄包装 callback

但原则不是降行数，而是消除 page 中剩余的独立真相。

### P3：shared 层再下沉

不是当前主线。

只有在出现第二真实复用方时，再考虑把 page-local helper 下沉到 `packages/shared`。

## 6. 不建议的路线

- 不要继续切 keyboard/IME 小碎片
- 不要再坚持外抽 `terminalPagePropsEqual`
- 不要为了降行数把更多壳层逻辑硬塞进 keyboard runtime

原因：这些路线要么已被证伪，要么只会扩大职责面，不会改善真源边界。

## 7. 最终判断

是否已经按“共享函数库 + blocks + 纯编排”设计？

回答：
- 已经大体按这个方向设计
- shared/helper 与 blocks 两层已基本成型
- `TerminalPage.tsx` 还不是完全纯编排壳
- 当前还差 keyboard runtime 与 viewport metrics owner 的最后收口

所以准确结论是：已经基本达标，但尚未完全闭环。

## 8. 唯一性说明

当前必须优先处理 keyboard runtime 契约闭合，是唯一正确的修改起点。

原因：
- 它是当前唯一被 `tsc` 明确打红的点
- 它反映的是 owner 迁移未闭合，不是风格问题
- 不先修这个点，后续关于 page-shell 纯化的任何结论都不稳定
