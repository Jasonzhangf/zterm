# 2026-04-18 Foundation Freeze

## 决策

在继续修 UI / 主机新增 / session 链路之前，先冻结 mobile 项目的流程真源与 workspace 结构。

## 原因

- 当前问题不只是功能 bug，而是缺少统一的执行真源
- 文档、任务、证据、skill 混在一起，导致闭环不稳定
- 需要先把“怎么做、怎么验、怎么沉淀”变成项目真源

## 结果

- 新增 `docs/spec.md`
- 新增 `docs/architecture.md`
- 新增 `docs/dev-workflow.md`
- 新增 `task.md`
- 新增 `CACHE.md`
- 新增 `MEMORY.md`
- 新增 `evidence/README.md`
- 将 `.agents/skills/wterm-mobile-dev/SKILL.md` 切到新文档结构

## 后续影响

- 后续实现先对齐 `task.md`
- runtime 改动必须在 `evidence/` 留证据
- `note.md` 只保留历史，不再继续扩展为主真源

