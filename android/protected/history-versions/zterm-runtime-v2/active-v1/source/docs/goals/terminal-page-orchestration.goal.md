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
