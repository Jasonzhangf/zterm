/goal
目标：继续把 `android/src/pages/TerminalPage.tsx` 收成真正纯编排壳；在已完成 helper/copy/overlay/interaction Slice A~C.1 的基础上，继续清掉 page 内剩余 page-local coordinator，并把文件压到 `<800` 行。

实现文档：
- `android/docs/goals/terminal-page-orchestration-refactor-plan.md`
- `android/docs/audits/2026-05-24-shared-blocks-orchestration-audit.md`
- `android/docs/audits/2026-05-24-shared-blocks-orchestration-audit-v2.md`
- `android/docs/audits/2026-05-24-shared-blocks-orchestration-audit-v3.md`

执行规范：
- 先验证后结论：无 `tsc` 通过与 targeted tests 绿，不宣称完成
- 不做 fallback、不保留双真源、不做“只搬文件不拆 owner”的假重构
- 保留已完成的 helper/copy/overlay/interaction Slice A~C.1 收口成果，不回灌旧实现
- 当前优先收 page-local coordinator：`handleSwitchSessionFromChrome`、quick-tab/tab-manager open actions、viewport-mode coordinator；keyboard runtime 只有在出现可独立验证的小切片时才推进
- interaction hook 只持有 interaction 真相；copy reset 仍保持 page 薄包装协调，避免 interaction 反向依赖 copy runtime

验证：
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm --dir android exec vitest run src/pages/useTerminalPageCopyRuntime.test.tsx src/pages/useTerminalPageOverlays.test.tsx src/pages/terminal-page-render-keys.test.ts src/pages/terminal-keyboard-lift.test.ts src/pages/terminal-copy-selection.test.ts src/pages/TerminalPage.android-ime.test.tsx src/pages/TerminalPage.render-scope.test.tsx --reporter dot`
- 跟踪 `TerminalPage.tsx` 行数，当前 `2586`，最终目标 `<800`

完成标准：
- `TerminalPage.tsx` 只保留 page shell + hooks 装配 + JSX 编排
- helper/copy/keyboard/overlay/interaction 各自有唯一 owner 文件，无 page duplicate owner
- 低风险 page-local coordinator 全部迁出或压成极薄壳
- 无缺失引用与无意义 unused 残留
- targeted tests 全绿，`tsc` 0 错误
- 最终 summary 必须说明为什么当前 owner 划分是唯一正确的
