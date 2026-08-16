# AppSDK 0.1.3 active-v4 收尾实现计划

Plan ID: `GOAL-20260816-APPSDK013-ACTIVE-V4`

## 1. 目标与验收标准

目标：完成 AppSDK 0.1.3 migration 的 active-v4 收尾，使 `main` 唯一使用
`0.1.3 + active-v4`，并关闭已授权的 L5/OTA/cleanup 尾项。

验收标准：

1. active-v4 生命周期记录完整且绑定真实 clean HEAD：
   - commit/tree hash
   - artifact hash
   - public API hash
   - scope hash
   - regression report
   - promotion record
   - freeze record
   - final review record
2. `appsdk verify android` 返回 `ok:true`，且验证所用 binary 是 0.1.3 且与
   `.appsdk/sdk.lock` 匹配。
3. 聚焦回归 8 files / 297 tests / 0 skipped 全绿。
4. feature registry 92/92 全绿。
5. `pnpm run prebuild`、`pnpm run build`、`tsc --noEmit`、module/edge/DAG gates
   全绿。
6. 在干净 detached worktree 上重跑 `appsdk verify android` 仍为 PASS。
7. DSH final review 对 exact frozen/published HEAD 返回明确 PASS。
8. main 唯一使用 0.1.3 + active-v4，无 stale active-v2/0.1.2 双真源。
9. OTA/playground cleanup 等不可逆动作仅在 Jason 明确授权后执行；否则保持
   `pending_authorization` 且写入完成报告。

## 2. 当前基线

- 主仓库：`/Volumes/extension/code/zterm`
- main HEAD：`d626524`，当前仍为 AppSDK 0.1.2 + active-v2。
- migration 分支：`migration/appsdk-0.1.3-active-v4`
- migration HEAD：`150fe46`
- migration `android/.appsdk/project.json`：sdk 0.1.3，module
  `zterm-runtime-v2` stage `controlled_verified`，version_base
  `active-v4` -> `previous active-v3`。
- `android/active/lib/zterm-runtime-v2/current.json` 仍指向 active-v3：
  `sha256:a26c67f3...`。
- active-v3 记录齐全但 freeze 后 prebuild 曾失败，修复被拆到 active-v4。
- DSH source review `zarchv2-activev4-source-r2` 已 PASS；active-v4 记录被有意
  清除，尚未 freeze/publish。
- 全局 binary：`/Users/fanzhang/.local/bin/appsdk`
  - SHA：`e3c36ae25c94d0c01c81cfe084fac7de8dc577f5ba3b8f91ae18b9d0587631a5`
  - version：0.1.3
  - 与 migration branch `.appsdk/sdk.lock` 匹配：
    bundle digest `sha256:dfccab3a...`，compiler digest
    `sha256:e3c36ae2...`。
- `.agent-collab` claim 已存在：
  - run_id：`20260816T135755Z-Macstudio.local-63423-9d5e57bc0333`
  - claim：`appsdk.active_v4_promotion`
  - worktree：`playground/appsdk-active-v4-20260816T135755Z-Macstudio.local-63423-9d5e57bc0333`
  - branch：`work/appsdk-active-v4-20260816T135755Z`
  - base：`150fe46`
- 授权门禁：`.agent-collab/handoff/zterm-v2-authorization-gates.json` 当前
  `status: awaiting_jason`；freeze/publish/merge/OTA/cleanup 均不可在未授权时执行。

## 3. 范围与边界

In Scope：

- active-v4 lifecycle records：worktree、evidence、fix candidate（如产生）、
  regression、review、promotion、freeze、merge 记录。
- migration branch 与 main 的 governance、gate、CI、record 对齐。
- prebuild/build 环境依赖补齐，例如 missing evidence、release-dist、generated
  artifacts 的生成或 gate 依赖修正。
- 如确认需要，对测试 timeout 做最小、可审计调整。
- 已授权时执行 L5 real-device、OTA republish、playground cleanup。

Out of Scope：

- 不改 terminal/daemon/render/transport/session 业务语义。
- 不修改业务 payload 的 request/response/error 链。
- 不引入 fallback、silent strip、双 SDK、双真源。
- 不手工编辑 `active/lib/**`、`protected/**`、`generated/**`、
  `.appsdk/sdk.lock`。
- 不做与 AppSDK migration 无关的重构。

## 4. 设计原则

1. 只使用 SHA 与 `.appsdk/sdk.lock` 匹配的 AppSDK 0.1.3 binary；禁止执行
   `.appsdk/sdk.bin`，禁止旁路。
2. 所有 lifecycle record 必须绑定 exact source commit/tree/artifact/scope；
   禁止伪造 hash、禁止用 source PASS 代替 final PASS、禁止覆盖 DSH FAIL。
3. 代码修改前先刷新 `.agent-collab`，只在自己声明的干净 worktree 工作；禁止
   复用带未提交改动的 `.worktree-appsdk-013-v4`。
4. 所有文件修改逐文件核实后使用 `apply_patch`；禁止脚本批量替换。
5. 控制面与业务 payload 物理隔离；错误显式暴露，禁止 fallback。
6. 先红后绿；非平凡逻辑留可运行的最小检查。
7. review 后再修改任何代码/测试/构建配置，旧 PASS 立即失效，必须重跑受影响
   验证和 final review。

## 5. 技术方案与文件清单

主流程：

1. 在干净 worktree 完成全部 candidate 验证与记录绑定。
2. 使用 AppSDK 0.1.3 CLI 生成/校验 governance records，不手工改 protected
   面。
3. active-v4 达到全部 gate 后，通过 `appsdk promote-module` 官方流程晋升到
   `architecture_stable` 或项目声明的稳定 stage，再 freeze/publish。
4. DSH final review 通过后，按 Jason 授权顺序执行 merge/OTA/cleanup。

关键文件：

- `android/docs/goals/appsdk-0.1.3-active-v4-plan.md`
- `android/docs/goals/zterm-runtime-architecture-v2-plan.md`
- `android/docs/debug/2026-08-16-appsdk013-final-gate-fix-design.md`
- `android/.appsdk/rules/appsdk-project-governance.md`
- `android/.appsdk/project.json`
- `android/.appsdk/sdk.lock`
- `android/active/lib/zterm-runtime-v2/current.json`
- `.agent-collab/handoff/zterm-v2-authorization-gates.json`
- `.agent-collab/claims/appsdk.active_v4_promotion/owner.json`
- `.agent-collab/runs/<run_id>/evidence.jsonl`

允许修改路径（仅治理/gate/记录）：

- `android/docs/**`
- `android/.appsdk/**`（只允许官方 CLI 修改的生成面除外）
- `android/scripts/**` 中与 prebuild/gate 相关的修复
- `android/vitest.config.ts`（仅确认必须的 timeout/gate 配置）
- `android/src/vitest.setup.ts`（Node 26 + jsdom 下补齐 in-memory
  localStorage，避免测试环境失效）
- `android/src/components/terminal/FileTransferSheet.test.tsx`（setItem mock
  改为直接作用到测试环境的 localStorage 实例，断言不放松）
- `android/src/lib/session-render-buffer-store.test.ts`（仅 perf guard 冷启动
  warmup 稳定化，阈值 16ms 不放松）
- `.agent-collab/**`

禁止修改路径：

- `android/active/lib/**`
- `android/protected/**`
- `android/generated/**`
- `android/.appsdk/sdk.lock`
- terminal/daemon/render/transport 业务源码与测试语义

## 6. 风险与规避

| 风险 | 规避 |
| --- | --- |
| full prebuild 在 clean worktree 缺 evidence/release-dist/generated | 先对比 main 与 worktree 的生成物和 gate 依赖，补齐生成步骤，不改业务代码 |
| 5s test timeout 在完整 CI 下 flake | 先单独复跑定位；如必须，只对超大 UI/集成测试用最小 timeout 调整并记录理由 |
| session-render-buffer perf guard 在 loaded machine 冷启动超 16ms | 测量前增加 warmup iterations；仍保留 16ms 阈值，不放松业务性能断言 |
| active-v4 records 被误删/伪造 | 只由官方 CLI 绑定真实 hash；记录写入前后校验 tree 不变 |
| DSH source PASS 被误当 final PASS | final review 必须针对 frozen/published exact HEAD 重跑 |
| freeze/publish/merge/OTA/cleanup 越权 | 每次不可逆动作前读 authorization gates；仍 `awaiting_jason` 时只记 pending |
| 复用了 dirty worktree | 拒绝 `.worktree-appsdk-013-v4`，只允许 claim 中声明的干净 worktree |
| 测试/构建配置改动使旧 review 失效 | 任何 candidate 后 diff 都重新跑完整 gate 与 final review |

## 7. 测试计划

阶段 1：clean worktree baseline

- `appsdk verify android`
- 聚焦 module regression：8 files / 297 tests / 0 skipped
- feature registry：92/92

阶段 2：完整 gate

- `pnpm run prebuild`
- `pnpm run build`
- `pnpm exec tsc --noEmit`
- module registry / edge registry / DAG / ownership gates

阶段 3：生命周期与发布

- promotion record / freeze record / regression report 全部绑定 exact hash
- DSH final review：provider `opencode-go/deepseek-v4-flash`
- DSH 明确 `unavailable` 时才允许 codex-review，顺序 `oauth -> cc -> tcm`
- 已授权时：L5 real-device、OTA republish、playground cleanup evidence

阶段 4：main 合并后复验

- main 的 `sdk.lock`、CI、release workflow、records 唯一使用 0.1.3
- 合并后 detached worktree `appsdk verify android` PASS
- 无 stale active-v2/0.1.2 双真源

## 8. 实施步骤

1. 刷新 `.agent-collab`：读 active runs、claims、events、authorization gates；
   确认 kill switch 未触发。
2. 确认 claim worktree 与 `git worktree list`、HEAD、base commit 一致。
3. 确认全局 binary SHA 与 migration `.appsdk/sdk.lock` compiler digest 一致。
4. 重跑并记录完整 prebuild 失败明细：
   - `terminal-buffer-replay.evidence.test.ts`
   - `server.daemon-runtime-truth.test.ts`
   - `TerminalView.dynamic-refresh.test.tsx`
   - `tmux-window-size-semantics.test.ts`
   - `session-render-buffer-store.test.ts`
5. 对比 main worktree 的 `android/evidence/daemon-mirror`、
   `android/release-dist`、`android/evidence/real-device`，补齐生成物或修正
   gate 依赖。
6. 单独重跑失败测试，区分环境 flake、缺失生成物、真实回归。
7. 若需要，只对测试配置做最小修复并提交；禁止放宽业务断言。
8. 在 clean worktree 重跑完整 gate；失败即修复到全绿。
9. 绑定 active-v4 records，使用真实 commit/tree/artifact/public API/scope
   hash。
10. 运行 `appsdk promote-module ... --to <stable-stage>`，记录 promotion。
11. 运行 regression report、freeze record，并让 `current.json` 指向 active-v4
    artifact。
12. 对 exact frozen/published HEAD 跑 DSH final review；必须得到明确 PASS。
13. DSH PASS 后，向 Jason 汇报授权门禁；仅执行已授权的 freeze/publish/merge/
    OTA/cleanup。
14. 合并 migration 到 main，更新 main 的 CI/release/records/sdk.lock，确保唯一
    0.1.3 + active-v4。
15. 关闭或记录所有尾项，写完成报告与 MEMORY.md 提炼。

## 9. 完成定义（DoD）

- active-v4 frozen/published，`current.json` 指向 active-v4。
- active-v4 的 artifact、public API、scope、review、regression、promotion、
  freeze 记录完全一致。
- DSH final PASS 基于 exact HEAD。
- main 唯一使用 0.1.3 + active-v4。
- 无 stale active-v2/0.1.2 双真源，无未结案 DSH FAIL。
- OTA/playground 等尾项已关闭，或明确记录为 Jason `pending_authorization`。

## 10. 当前开放项

- 完整 prebuild 尚有失败，须先定位是否环境/生成物依赖或真实回归。
- `android/vitest.config.ts` 是否纳入 active-v4 candidate 尚未定案；若纳入，
  source diff 不再是纯 governance/gate 记录，必须重新走 final review。
- `freeze/publish/merge/OTA/playground cleanup` 均等待 Jason 授权。

## 11. 2026-08-16 DSH final round 2 基线

- main HEAD：`15df591f6cbc4adb02ab420b1a9d3d7ee88cc3c8`，仍是 0.1.2 +
  active-v2。
- claim worktree：
  `playground/appsdk-active-v4-20260816T135755Z-Macstudio.local-63423-9d5e57bc0333`，
  HEAD `9f653d85aa582f0e6fa5c64b80366034c863ef45`，仅追加 lifecycle records。
- DSH final `zarchv2-activev4-final-9f653d8-20260816T173500Z`：
  `VERDICT: FAIL`，P0/P1 见
  `docs/debug/2026-08-16-appsdk013-final-gate-fix-design.md` round 2。
- 本计划后续 candidate 必须先修复上述 findings，再重跑完整 gate 与 DSH final；
  发布/合并类动作仍等 Jason 授权。
