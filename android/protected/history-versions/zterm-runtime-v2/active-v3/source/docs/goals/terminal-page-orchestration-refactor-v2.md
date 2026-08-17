# TerminalPage Orchestration Refactor V2

## 目标

把 `android/src/pages/TerminalPage.tsx` 继续收成真正的纯编排壳，并在过程中先恢复 keyboard runtime 的唯一 owner 与绿态基线。

## 验收标准

1. `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` 全绿。
2. 当前 targeted tests 持续全绿。
3. `TerminalPage.tsx` 不再同时与 keyboard runtime 重复持有同类 owner。
4. keyboard/viewport/page-shell 的 owner 划分可在代码层清晰指出唯一真源。

## 范围

### In Scope
- 修复 `useTerminalPageKeyboardRuntime.ts` 当前 `landscape` 半迁移状态
- 明确 `landscape` 的唯一 owner
- 统一 viewport metrics owner
- 收口 `TerminalPage.tsx` 中剩余 shell-level 派生与薄包装
- 补充或更新相关审计/实现文档

### Out of Scope
- 继续拆 keyboard/IME 微切片
- 外抽 `terminalPagePropsEqual`
- 无真实复用证据的 shared 下沉
- 与当前 page-shell 收口无关的功能改动

## 设计原则

- 唯一真源：每类 runtime/shell owner 只能有一处权威实现
- 禁止 fallback：不通过双路径/兼容分支掩盖 owner 不清问题
- 纯编排：`TerminalPage.tsx` 只负责 hooks 装配、派生装配、JSX 组合
- blocks 化：复杂状态/生命周期逻辑进入独立 runtime hook
- helper 化：纯计算和纯投影进入 leaf helper
- 先恢复绿态，再做进一步纯化

## 技术方案

### 方案 1：先闭合 keyboard runtime 契约

检查并收口：
- `useTerminalPageKeyboardRuntime.ts`
- `TerminalPage.tsx`

二选一：
1. `landscape` 正式归 `useTerminalPageKeyboardRuntime.ts`
2. 或回退该半步，让 `landscape` 留在 page-shell

但必须做到：
- 类型声明
- 值计算
- return 暴露
- page 消费位置

四者完全一致，不能再保持半完成状态。

### 方案 2：统一 viewport metrics owner

候选：
- A. 留在 keyboard runtime
- B. 独立为 `useTerminalPageViewportMetrics.ts`

推荐优先评估 B。

原因：
- `viewportWidth` / `headerTopInsetPx` 更接近 shell geometry owner
- 不应让 keyboard runtime 同时承担 IME 控制与页面几何测量两种职责

### 方案 3：收掉剩余 page-shell 派生

清点并处理：
- `layoutProfile`
- `terminalChromeBottomPx`
- 少量壳层 callback forwarding

原则：
- 若只是 page 壳层拼装，可留 page
- 若形成可独立命名 owner，则迁出

## 目标文件清单

- `android/src/pages/TerminalPage.tsx`
- `android/src/pages/useTerminalPageKeyboardRuntime.ts`
- `android/src/pages/useTerminalPageViewportMetrics.ts`（若创建）
- `android/src/pages/terminal-keyboard-lift.ts`（若需补 helper）
- `android/docs/audits/2026-05-24-terminal-page-shared-blocks-orchestration-audit-final.md`

## 风险与规避

### 风险 1：keyboard/IME 行为回退
规避：
- 不做小碎片拆分
- 每次只完成一个 owner 收口
- targeted tests 必跑

### 风险 2：viewport metrics 与 keyboard 交叉依赖加深
规避：
- 先写 owner 归属判断
- 再决定放 keyboard runtime 还是独立 metrics hook
- 禁止 page 与 hook 双持有

### 风险 3：只降行数不改善架构
规避：
- 所有变更都必须回答“owner 是否更唯一、更纯”
- 不能只用“文件更短了”作为成功依据

## 测试计划

必须执行：

```bash
pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false
```

```bash
pnpm --dir android exec vitest run   src/pages/useTerminalPageCopyRuntime.test.tsx   src/pages/useTerminalPageOverlays.test.tsx   src/pages/terminal-page-render-keys.test.ts   src/pages/terminal-keyboard-lift.test.ts   src/pages/terminal-copy-selection.test.ts   src/pages/TerminalPage.android-ime.test.tsx   src/pages/TerminalPage.render-scope.test.tsx   --reporter dot
```

如涉及新增 hook/helper：
- 补对应单测或 render-scope 回归

## 实施步骤

1. 先修 keyboard runtime 当前 `landscape` 编译阻断
2. 明确 `landscape` 唯一 owner，并物理删除另一处重复 owner
3. 梳理 viewport metrics 的最终 owner
4. 若需要，创建独立 `useTerminalPageViewportMetrics.ts`
5. 收掉 `TerminalPage.tsx` 中剩余 shell-level 派生/薄包装
6. 跑 tsc
7. 跑 targeted tests
8. 更新审计结论与后续文档

## 完成定义（DoD）

只有同时满足以下条件，才算完成：
- `tsc` 全绿
- targeted tests 全绿
- `TerminalPage.tsx` 不再与 keyboard runtime 重复持有同类 owner
- 能清晰说明 keyboard、viewport metrics、page-shell 三者的唯一 owner 划分
- 总结里能给出“为什么这是唯一正确 owner 划分”的论证


## 2026-05-24 补充：keyboard/IME 整体重构设计结论（当前 879 行基线）

关联文档：
- `android/docs/audits/2026-05-24-keyboard-ime-refactor-design-v2.md`

补充结论：
1. 当前 keyboard runtime 的真实阻塞不是功能错误，而是 `landscape` 半迁移状态导致的 owner 未闭合与 `tsc` 阻断。
2. `landscape` 的唯一正确 owner 是 page-shell，而不是 keyboard runtime；因此应回退该半迁移，而不是继续把布局方向真相塞进 keyboard hook。
3. 当前真正的双 owner 残留是 viewport metrics：`viewportWidth` / `headerTopInsetPx` / `scheduleViewportMetricsSync` 在 page 与 keyboard runtime 中重复存在。
4. 由于 viewport freeze 语义依赖 `stableLayoutViewportHeightRef`，viewport metrics 最终应统一归 `useTerminalPageKeyboardRuntime.ts`，page 只消费 hook 返回值。
5. viewport resize listener effect 也必须和 `scheduleViewportMetricsSync` 同 owner，最终应迁入 keyboard runtime，不能继续留在 page。

实施顺序更新为：
- Phase 0：清理 keyboard runtime 中 `landscape` 半完成状态，恢复 `tsc` 绿态
- Phase 1：删掉 page 内重复的 viewport metrics owner，改为消费 keyboard runtime 返回值
- Phase 2：把 viewport resize listener effect 迁入 keyboard runtime，完成 page-shell 收口
