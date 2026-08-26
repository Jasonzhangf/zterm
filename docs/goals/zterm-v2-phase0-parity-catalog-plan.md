# Phase 0 Worker Plan: v1 parity catalog

## 目标与验收标准

建立 Android/macOS/Windows 当前生产功能与验证入口的 v1 parity catalog，作为 v2 每个阶段的唯一行为对照表。

验收：功能、入口、平台、业务 payload、生命周期、错误、验证 gate 均有稳定 ID；未知/重复 ID 有负测；没有把未验证目标态当生产事实。

## 范围与边界

In scope：读取各平台 spec/architecture/dev-workflow/task、package scripts、现有测试和 evidence，登记已验证/未验证状态。

Out of scope：不改 runtime、不改产品行为、不安装 Cordis、不修改 v1 代码、不删除 evidence。

## 设计原则

生产源码/在线 evidence 优先；文档仅作定位；状态分为 `verified`、`pending`、`blocked`；每项绑定 required gates 和 canonical owner。

## 技术方案与文件清单

- 目标文档：`docs/goals/zterm-cordis-v2-rebuild-plan.md`
- 设计文档：`docs/design/2026-08-26-zterm-cordis-v2-cross-platform.md`
- 现有真源：`android/docs/spec.md`、`mac/docs/spec.md`、`win/docs/spec.md`、各平台 `docs/dev-workflow.md`
- 输出：建议新增 `docs/architecture/zterm-v2-parity-catalog.json` 与人读说明

## 风险与规避

不把测试存在等同于运行时完成；不把 Android-only v2 状态扩展成跨平台事实；缺少 live/package evidence 就标记 pending。

## 测试计划

JSON/schema parse；ID 唯一性；owner/path/gate 引用完整性；抽样核对现有测试和 evidence 路径。

## 实施步骤

1. 读取真源文档和 package scripts。
2. 生成 feature/platform/behavior/gate catalog。
3. 补正反状态和未完成项。
4. 运行 schema/reference gate。
5. 写 evidence 与 handoff。

## 完成定义

catalog 可机器解析、可追踪到真实 owner/gate/evidence；无 runtime 修改；clean worktree；handoff 可供 Phase 1 使用。
