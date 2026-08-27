# Cordis v2 Android + Mac 第一阶段完成计划

## 目标

按 `docs/goals/zterm-cordis-v2-rebuild-plan.md` 先完成 Cordis v2 的
Android + Mac 第一阶段：补齐两平台真实 gate，接通两平台 required CI/build
gate，更新 manifest/evidence，完成主树验证、安装/重启/在线样本、AGY Review
准备与发布审计。Windows + iOS 属于第二阶段，不纳入本轮完成判定。

当前基线：`main` / `origin/main`（执行时必须重新读取实际 SHA）。

## 验收标准

1. Phase 0-6 保持 complete；Android + Mac 的 Phase 7 相关 gate 有当前基线可追溯证据。
2. Android 通过 type-check、回归、Gradle build、APK 安装、OTA manifest/hash、
   daemon endpoint 与真实 emulator/device 样本。
3. Mac 通过 type-check、packaged CDP/terminal blackbox、生命周期与清理样本。
4. Android/Mac 相关 verification-map active runtime gates 接入 CI 或 build chain，
   并由 CI/build 实际执行。
5. Phase manifest、parity catalog、handoff、audit 文档与真实 Android/Mac 证据一致；
   Windows + iOS 保持明确 deferred/incomplete。
6. 主树定向合并后通过两平台全局 gates、定向 tests、build、安装/重启/在线旧样本；
   只在这些证据齐全后运行 AGY Review。
7. AGY Review controller 返回 PASS；staged scope 只包含声明 change set；
   push 后本地 HEAD 与远端 HEAD 相同。

## 范围

包含：

- Mac split-tree arity blocker；
- Android runtime/package gate；
- Mac packaged/live gate；
- Android/Mac CI/build runtime-gate wiring；
- Android/Mac Phase 7/8 manifest、parity、audit、evidence reconciliation；
- Android/Mac 主树 closeout、AGY Review 准备、commit/push scope verification。

不包含：

- 未获授权的 Public Relay 发布；
- Windows + iOS 实现或 live gate；
- Cordis 之外的 Android 产品功能重写；
- 新通信实现、第二套 plugin/kernel、fallback/shadow route；
- 直接编辑 `.agent-collab` journal/state；
- 清除系统权限或批量 kill 进程。

## 架构边界

- Cordis 只做进程内 composition/lifecycle；terminal、file/media、input、
  mirror、WebRTC body 继续走专用 data streams。
- shared contracts 不导入 React、DOM、Capacitor、Electron、native API 或
  Cordis runtime。
- 每个功能保持唯一 owner；registry、function map、mainline call map、
  verification map 必须与真实源码和调用边一致。
- 失败必须显式暴露；不以静态/package 证据伪造 live/device 成功。
- 每个 worker 使用独立 clean worktree；主树只做精确 merge/review/close。

## 任务拆分

### T1 Mac split-tree arity

修复 `mac/src/app/workspace/workspace-store.ts` 的
`buildSplitTreeFromPanes` 调用/定义契约不一致。只改该功能 owner 及其必要测试，
通过 Mac type-check 与 focused tests。

### T2 Android runtime/package gate

执行 Android 当前 required gates：type-check、feature-registry、核心回归、
Gradle build、APK 安装、OTA bundle/hash、daemon endpoint 与 emulator/device
真实样本。Public Relay 发布只记录 blocker，不自行发布。

### T3 Mac packaged/live gate

在 T1 合并关闭后执行 Mac type-check、packaged CDP/terminal blackbox、sequence/
TUI/large-reading、生命周期与精确清理。缺少环境时记录精确 blocker。

### T4 Android/Mac CI runtime gates

对 Android/Mac 相关 verification-map active gates 做 import/command/CI 实际执行
核对；补齐缺失 CI/build wiring，加入正反 gate，验证 workflow 命令在 clean checkout
可运行。不得只改文档宣称已接线。Windows/iOS gate 不在本轮接线范围。

### T5 Evidence/manifest reconciliation

基于 T1-T4 的真实结果更新 phase manifest、parity catalog、handoff/audit 文档；
只写已验证 Android/Mac 状态，明确保留 Windows/iOS deferred/incomplete。该任务
必须在前四项交付后执行。

### T6 Final closeout

T5 完成后在主树运行 Android/Mac 全局 gates、安装/重启/在线旧样本，检查 staged
scope、push-head equality，再执行 AGY Review 准备/最终 review（仅在前置证据齐全时）。
任何代码或运行配置变化都使旧证据失效，必须重跑受影响闭环。

## 验证矩阵

| 层 | 必须证据 |
| --- | --- |
| 静态架构 | governance、map registries、feature registry、payload/import/DAG |
| shared/runtime | kernel、stream boundary、desktop gateway、session/persistence |
| Android | type-check、回归、构建、安装、OTA manifest/hash |
| Mac | type-check、packaged CDP/terminal blackbox、清理 |
| Windows | 第二阶段，不在本轮 |
| iOS | 第二阶段，不在本轮 |
| CI/build | 每个 active required gate 有实际 workflow/build 入口 |
| 发布收尾 | 主树验证、AGY PASS、定向 staged scope、push-head equality |

## 实施顺序

1. T1 与 T4 可并行；T2 从当前 `main` 创建独立 worktree并执行。
2. T3 必须在 T1 合并关闭后执行；T5 必须在 T1-T4 状态稳定后执行。
3. 主 master 审核交付，精确合并并 `collab task close`。
4. T5 合并后运行 T6；T6 通过才允许宣称 Android + Mac 第一阶段完成。

## 风险与处理

- Windows/iOS：本轮明确 deferred，不改变其 active/incomplete 状态。
- CI gate 命令依赖未安装：先修 clean checkout 的依赖/入口，不改 gate 语义。
- OTA/Public Relay 版本不一致：分离为发布授权问题，不在 Cordis closeout 中静默修复。
- 任何主树 dirty：保留他人改动，停止 staged/commit，先明确 change set。

## 完成定义（DoD）

只有同时满足以下条件才算完成：

- Android/Mac 相关 Phase 7 status 可由当前 live evidence 支撑并不再有本轮 required blocker；
- Android/Mac 第一阶段 closeout 具备完整主树证据；全局 Phase 8 仍可保持 blocked-on-phase-7，
  直到第二阶段 Windows/iOS 完成；
- 主树 clean，两平台 required tests/build/install/restart/online samples 通过；
- AGY Review controller PASS；
- commit/push 范围锁通过，远端 HEAD 与本地 HEAD 一致；
- remaining risks 仅为 Windows/iOS 第二阶段与明确不在本次 DoD 的 Public Relay 发布授权项。

## 第二阶段（延期）

- Windows packaged/ConPTY/transport/input live gate。
- iOS native simulator/device/lifecycle/IME/terminal gate。
- 四平台 parity 与全局 Phase 8 closeout。
