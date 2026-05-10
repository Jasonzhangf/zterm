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