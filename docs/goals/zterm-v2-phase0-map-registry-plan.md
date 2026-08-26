# Phase 0 Worker Plan: architecture map registry

## 目标与验收标准

建立 shared/domain/kernel/platform-host/UI-plugin 的 resource、module、feature、function、mainline、verification registry，锁定唯一 owner、允许路径、禁止路径和阶段 gate。

验收：机器字段可解析；每个注册 source path 恰好一个 owner；每条跨模块 import/call 有登记；目标态明确标 `design/pending`，不冒充 active。

## 范围与边界

In scope：根级 v2 registry/manifest 骨架及与现有 Android/Mac/Windows registry 的映射关系。

Out of scope：不改 runtime imports、不迁移 UI、不引入 Cordis 依赖、不修改既有 Android active-v2 真源。

## 设计原则

resource map 先于 function map；function map 绑定真实 symbol；mainline map 只登记相邻边；machine 字段不混入散文；shared core 禁止 platform/UI/Cordis import。

## 技术方案与文件清单

- 设计：`docs/design/2026-08-26-zterm-cordis-v2-cross-platform.md`
- manifest：`docs/architecture/zterm-cordis-v2-phase-manifest.json`
- 参考：`android/docs/resource-registry.json`、`android/docs/module-registry.json`、`android/docs/edge-registry.json`
- 输出：根级 v2 architecture registry、owner/path/edge gate 及简短人读说明

## 风险与规避

禁止伪造尚未存在的 symbol；禁止把 Android 现状复制成跨平台 active truth；禁止通过 registry 放行未声明的 import/call edge。

## 测试计划

JSON parse/schema；path existence；owner uniqueness；edge adjacency；module DAG；design/pending 状态审计。

## 实施步骤

1. 读取现有 registries/maps 和真实源码入口。
2. 划分 shared/domain/kernel/host/plugin 目标模块。
3. 登记 resource、owner、allowed/forbidden paths、edges、gates。
4. 接入最小 architecture gate scaffold。
5. 写 evidence 与 handoff。

## 完成定义

registry 是可执行骨架，不是散文；目标态和现状分离；所有新增条目有 owner/gate；无 runtime 修改；clean worktree。
