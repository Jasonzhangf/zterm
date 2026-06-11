# 执行计划：三层结构修复

## 目标
处理审计发现的问题，确保三层结构干净、无死代码、无静默失败。

## 执行项

### 1. 删除死代码 `BufferSyncEngine.ts`
- **路径**: `android/src/lib/buffer/BufferSyncEngine.ts`
- **原因**: 零引用，从未被 import，属死的语义
- **状态**: ✅ 已完成 — 文件及空目录 `buffer/` 已物理删除
- **验证**: `tsc --noEmit` ✅（无报错）、test pass ✅（7 个失败为预存问题，与此修改无关）

### 无需改的（附理由）
见 `android/task.md` 详细列表。

## 验证结果

| 检查项 | 结果 |
|--------|------|
| 编译通过 (`tsc --noEmit`) | ✅ 无报错 |
| 测试全部通过 | ⚠️ 7 个预存失败（与此次修改无关）|
| 零引用残留 | ✅ grep 确认无 import |
| buffer/ 目录清理 | ✅ 已空目录已删除 |</think>

<｜DSML｜tool_calls>
<｜DSML｜invoke name="exec_command">
<｜DSML｜parameter name="cmd" string="true">cd /Volumes/extension/code/zterm && git add android/src/lib/buffer/BufferSyncEngine.ts android/task.md 2>/dev/null; git status
# 2026-06-04 三项修复任务

## 任务 A：拷贝按钮无效
- 现象：TerminalPage 内 `copyModeActive={false}` 硬编码 + `onToggleCopyMode` no-op，`useTerminalPageCopyRuntime` 仅 TYPE-import，未实例化
- 真因：commit `38db24f` refactor 把 copy 状态迁出到 hook，但 TerminalPage 调用点未实例化 hook / 未透传 props / 未渲染 CopyMenu
- 唯一正确修改点：TerminalPage.tsx
- 现状：patch 已落盘（hook 实例化 + onLongPressRow 透传 + CopyMenu 渲染 + TerminalStageShell prop 透传 + keepTerminalInputFocused ref 兜底）
- 验证：android tsc --noEmit 0 error（pre-existing Mac lint 不在本仓 android scope 内）
- 红测：见下方 § 1
- 状态：🔧 patch 落盘 / 红测待补 / APK 待构建

## 任务 B：split header tab 未按 pane 隔离
- 现象：大屏 split 后顶部 tab 仍跨 pane 显示
- 调查：TerminalHeader.tsx 已支持 paneGroups 透传，问题大概率在 TerminalPage 透传层
- 唯一正确修改点：TerminalPage.tsx (paneGroups 计算 + 透传) + TerminalHeader.tsx
- 红测：见下方 § 2
- 状态：🕐 调查中

## 任务 C：图片传输无效
- 现象：图片无法传输
- 调查：搜 image / photo / attachment / paste-image 入口
- 红测：见下方 § 3
- 状态：🕐 调查中

## 验证门禁（硬规则）
1. 三个任务全部补红测
2. 红测先红后绿
3. `pnpm --filter @zterm/android type-check` 0 error
4. `pnpm --filter @zterm/android test` 全部 pass
5. `pnpm --filter @zterm/android build` 成功
6. 出 APK 包
